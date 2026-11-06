// Export-correctness gate.
//
//   npx tsx scripts/verify-export.ts --job <jobId> [--server http://localhost:5318] [--web http://localhost:5317] [--out <dir>]
//
// Checks a finished render job against its project snapshot:
//   a. container/streams via ffprobe + a full decode
//   b. frame agreement: MP4 frame vs the preview (capture.html) at checkpoints, SSIM >= 0.95
//   c. audio sync: onset of every audio clip — scene-anchored sound effects and
//      project-level clips (the music bed) alike — within ±2 frames, where the
//      clip's own start is loud enough over what already plays to show as an
//      onset (otherwise reported as skipped, with the levels)
//   d. content: project revision + text of every text element
// Writes <out>/verify-report.json, PNGs under <out>/frames, prints a summary,
// exits non-zero when any check fails.

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { existsSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { delimiter, join, resolve } from 'node:path';
import { chromium } from 'playwright-core';
import { deliveryDimensions, deliverySettings } from '../src/core/delivery';
import type { RenderJob } from '../src/core/api-contract';
import { DEFAULT_SERVER_PORT } from '../src/core/api-contract';
import { clipVolumeAt } from '../src/composition/AudioTrack';
import { audioClipStartFrame, projectDurationInFrames, sceneStartFrames } from '../src/core/timing';
import type { AudioClip, Project } from '../src/core/types';
import { videoProps } from '../src/core/video';
import { mediaTool, type MediaTool } from '../server/media-tools';

const SSIM_THRESHOLD = 0.95;
const MAX_CHECKPOINTS = 16;
const AUDIO_WINDOW = 15;
const AUDIO_TOLERANCE = 2;
const ONSET_RISE_DB = 10;

// MGE_FFMPEG / MGE_FFPROBE, else PATH (server/media-tools.ts). SSIM needs a full ffmpeg build.
const FFMPEG = mediaTool('ffmpeg');
const FFPROBE = mediaTool('ffprobe');

interface Args {
  job: string;
  server: string;
  web: string;
  out?: string;
  /** Debug: inspect this MP4 instead of the job output (the project snapshot still comes from the job). */
  file?: string;
}

function parseArgs(argv: string[]): Args {
  const a: Partial<Args> = {
    server: `http://localhost:${process.env.MGE_SERVER_PORT ?? DEFAULT_SERVER_PORT}`,
    web: `http://localhost:${process.env.MGE_WEB_PORT ?? 5317}`,
  };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--job') a.job = argv[++i];
    else if (k === '--server') a.server = argv[++i];
    else if (k === '--web') a.web = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--file') a.file = argv[++i];
    else {
      console.error(`Unknown argument ${k}`);
      process.exit(2);
    }
  }
  if (!a.job) {
    console.error('Usage: npx tsx scripts/verify-export.ts --job <jobId> [--server url] [--web url] [--out dir]');
    process.exit(2);
  }
  return { ...a, server: a.server!.replace(/\/$/, ''), web: a.web!.replace(/\/$/, '') } as Args;
}

function run(tool: MediaTool, args: string[]): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((res, rej) => {
    const p = spawn(tool.cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: tool.cwd, env: tool.env });
    const out: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => out.push(d));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', rej);
    p.on('close', (code) => res({ code: code ?? 1, stdout: Buffer.concat(out), stderr: err }));
  });
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url} → ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

interface Check {
  name: string;
  pass: boolean;
  expected?: unknown;
  actual?: unknown;
  note?: string;
}

// ---------------------------------------------------------------------------
// a. streams
// ---------------------------------------------------------------------------

interface ProbeStream {
  codec_type: string;
  codec_name: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  nb_read_frames?: string;
  duration?: string;
  sample_rate?: string;
  pix_fmt?: string;
}

async function checkStreams(file: string, project: Project, job: RenderJob): Promise<Check[]> {
  const settings = deliverySettings(job.preset, project.height);
  const fps = project.fps / settings.everyNthFrame;
  const frames = Math.ceil(projectDurationInFrames(project) / settings.everyNthFrame);
  const { width, height } = deliveryDimensions(job.preset, project.width, project.height);
  const expectedDuration = frames / fps;
  const probe = await run(FFPROBE, ['-v', 'error', '-count_frames', '-print_format', 'json', '-show_streams', '-show_format', file]);
  if (probe.code !== 0) return [{ name: 'ffprobe', pass: false, note: probe.stderr.trim() }];
  const json = JSON.parse(probe.stdout.toString()) as { streams: ProbeStream[]; format: { duration?: string } };
  const v = json.streams.find((s) => s.codec_type === 'video');
  const a = json.streams.find((s) => s.codec_type === 'audio');
  const checks: Check[] = [];
  if (!v) return [{ name: 'video stream present', pass: false }];
  const [num, den] = (v.r_frame_rate ?? '0/1').split('/').map(Number);
  const rate = num / (den || 1);
  const vDur = Number(v.duration ?? json.format.duration);
  checks.push({ name: 'video codec', pass: v.codec_name === settings.codec, expected: settings.codec, actual: v.codec_name });
  checks.push({ name: 'resolution', pass: v.width === width && v.height === height, expected: `${width}x${height}`, actual: `${v.width}x${v.height}` });
  checks.push({ name: 'frame rate', pass: Math.abs(rate - fps) <= (settings.codec === 'gif' ? 1 : 1e-6), expected: fps, actual: v.r_frame_rate });
  checks.push({ name: 'frame count', pass: Number(v.nb_read_frames) === frames, expected: frames, actual: Number(v.nb_read_frames) });
  checks.push({
    name: 'video duration',
    pass: Math.abs(vDur - expectedDuration) <= 1 / fps + 1e-6,
    expected: `${expectedDuration.toFixed(3)}s ±1 frame`,
    actual: `${vDur.toFixed(3)}s`,
  });
  if (settings.codec !== 'gif') checks.push({ name: 'pixel format', pass: settings.codec === 'prores' ? /^yuva?444p/.test(v.pix_fmt ?? '') : v.pix_fmt === 'yuv420p', expected: settings.codec === 'prores' ? 'YUV(A) 444' : 'yuv420p', actual: v.pix_fmt });
  if (settings.codec === 'gif') {
    checks.push({ name: 'silent GIF', pass: !a, actual: a ? a.codec_name : 'no audio (expected)' });
  } else if (!a) {
    checks.push({ name: 'audio stream present', pass: false, expected: 'aac 48000 Hz', actual: 'none' });
  } else {
    const aDur = Number(a.duration ?? json.format.duration);
    const audioCodec = settings.codec === 'vp9' ? 'opus' : settings.codec === 'prores' ? 'pcm_s16le' : 'aac';
    checks.push({ name: 'audio stream 48 kHz', pass: a.codec_name === audioCodec && a.sample_rate === '48000', expected: `${audioCodec} 48000`, actual: `${a.codec_name} ${a.sample_rate}` });
    checks.push({
      name: 'audio duration ≈ video duration',
      pass: Math.abs(aDur - vDur) <= 0.05,
      expected: `${vDur.toFixed(3)}s ±50ms`,
      actual: `${aDur.toFixed(3)}s (Δ ${((aDur - vDur) * 1000).toFixed(1)} ms)`,
    });
  }
  const decode = await run(FFMPEG, ['-v', 'error', '-i', file, '-f', 'null', '-']);
  checks.push({ name: 'full decode without errors', pass: decode.code === 0 && decode.stderr.trim() === '', actual: decode.stderr.trim().split('\n').slice(0, 3).join(' | ') || 'clean' });
  return checks;
}

// ---------------------------------------------------------------------------
// b. frame agreement
// ---------------------------------------------------------------------------

interface Checkpoint {
  frame: number;
  reason: string;
}

export function computeCheckpoints(project: Project): Checkpoint[] {
  const total = projectDurationInFrames(project);
  const starts = sceneStartFrames(project);
  // Priority: scene starts, video elements (in-point, mid-way, near the end — trimmed and sped-up sections), transitions, midpoints, element starts.
  const groups: Checkpoint[][] = [[], [], [], [], []];
  const VIDEO = 4;
  project.scenes.forEach((scene, i) => {
    const s = starts[i];
    const last = s + scene.durationInFrames - 1;
    groups[0].push({ frame: s, reason: `${scene.name}: first frame` });
    for (const el of scene.elements) {
      if (el.type !== 'video' || el.parentId) continue;
      const v = videoProps(el);
      const tag = `${scene.name} › ${el.name} (video, in ${v.trimStartFrames} f, ${v.playbackRate}×)`;
      const a = s + el.startFrame;
      groups[VIDEO].push({ frame: a + 1, reason: `${tag}: in-point` });
      groups[VIDEO].push({ frame: a + Math.floor(el.durationInFrames / 2), reason: `${tag}: midway` });
      groups[VIDEO].push({ frame: Math.min(last, a + el.durationInFrames - 2), reason: `${tag}: near the end` });
    }
    if (scene.transitionIn.type !== 'none' && scene.transitionIn.durationInFrames > 0) {
      groups[1].push({ frame: Math.min(last, s + scene.transitionIn.durationInFrames), reason: `${scene.name}: end of ${scene.transitionIn.type} transition` });
    }
    groups[2].push({ frame: s + Math.floor(scene.durationInFrames / 2), reason: `${scene.name}: midpoint` });
    for (const el of scene.elements) {
      const f = s + el.startFrame + 10;
      if (f <= last) groups[3].push({ frame: f, reason: `${scene.name} › ${el.name}: start + 10` });
    }
  });
  const picked = new Map<number, Checkpoint>();
  // Fill by priority until the cap.
  for (const g of [groups[0], groups[VIDEO], groups[1], groups[2], groups[3]]) {
    for (const c of g) {
      if (c.frame < 0 || c.frame >= total) continue;
      const existing = picked.get(c.frame);
      if (existing) existing.reason += `; ${c.reason}`;
      else if (picked.size < MAX_CHECKPOINTS) picked.set(c.frame, { ...c });
    }
  }
  return [...picked.values()].sort((a, b) => a.frame - b.frame);
}

async function extractMp4Frames(file: string, frames: number[], dir: string): Promise<Map<number, string>> {
  const tmp = join(dir, '_extract');
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  const select = frames.map((f) => `eq(n\\,${f})`).join('+');
  const r = await run(FFMPEG, ['-v', 'error', '-i', file, '-vf', `select=${select}`, '-fps_mode', 'passthrough', '-frames:v', String(frames.length), join(tmp, '%03d.png')]);
  if (r.code !== 0) throw new Error(`ffmpeg frame extraction failed: ${r.stderr.trim()}`);
  const map = new Map<number, string>();
  for (let i = 0; i < frames.length; i++) {
    const src = join(tmp, `${String(i + 1).padStart(3, '0')}.png`);
    if (!existsSync(src)) continue;
    const dest = join(dir, `f${String(frames[i]).padStart(5, '0')}-export.png`);
    await rename(src, dest);
    map.set(frames[i], dest);
  }
  await rm(tmp, { recursive: true, force: true });
  return map;
}

async function ssim(a: string, b: string): Promise<number> {
  const r = await run(FFMPEG, ['-v', 'info', '-i', a, '-i', b, '-lavfi', '[0:v]format=rgb24[x];[1:v]format=rgb24[y];[x][y]ssim', '-f', 'null', '-']);
  const m = /All:([0-9.]+)/.exec(r.stderr);
  if (!m) throw new Error(`could not compute SSIM: ${r.stderr.trim().split('\n').slice(-2).join(' ')}`);
  return Number(m[1]);
}

async function sideBySide(a: string, b: string, out: string): Promise<void> {
  await run(FFMPEG, ['-v', 'error', '-y', '-i', a, '-i', b, '-filter_complex', '[0:v][1:v]hstack=inputs=2,scale=1920:-2', out]);
}

interface FrameResult {
  frame: number;
  reason: string;
  ssim: number | null;
  pass: boolean;
  exportPng?: string;
  previewPng?: string;
  sideBySide?: string;
  error?: string;
}

async function checkFrames(file: string, project: Project, args: Args, framesDir: string, job: RenderJob): Promise<FrameResult[]> {
  const checkpoints = computeCheckpoints(project);
  await mkdir(framesDir, { recursive: true });
  const exported = await extractMp4Frames(file, checkpoints.map((c) => c.frame), framesDir);

  const browser = await chromium.launch({ channel: 'chrome' });
  const results: FrameResult[] = [];
  try {
    const context = await browser.newContext({ viewport: { width: project.width, height: project.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    for (const c of checkpoints) {
      const tag = `f${String(c.frame).padStart(5, '0')}`;
      const r: FrameResult = { frame: c.frame, reason: c.reason, ssim: null, pass: false, exportPng: exported.get(c.frame) };
      try {
        if (!r.exportPng) throw new Error('frame missing from MP4 extraction');
        const url = `${args.web}/capture.html?job=${encodeURIComponent(args.job)}&frame=${c.frame}`;
        await page.goto(url, { waitUntil: 'load' });
        await page.waitForSelector('body[data-ready]', { state: 'attached', timeout: 45_000 });
        const state = await page.evaluate(() => ({ ready: document.body.dataset.ready, error: document.body.dataset.error }));
        if (state.ready !== '1') throw new Error(`capture page error: ${state.error}`);
        r.previewPng = join(framesDir, `${tag}-preview.png`);
        await page.screenshot({ path: r.previewPng, clip: { x: 0, y: 0, width: project.width, height: project.height } });
        const settings = deliverySettings(job.preset, project.height);
        if (settings.scale !== 1) {
          const dims = deliveryDimensions(job.preset, project.width, project.height);
          const scaled = join(framesDir, `${tag}-preview-scaled.png`);
          const resize = await run(FFMPEG, ['-v', 'error', '-y', '-i', r.previewPng, '-vf', `scale=${dims.width}:${dims.height}`, scaled]);
          if (resize.code !== 0) throw new Error(`Preview resize failed: ${resize.stderr}`);
          r.previewPng = scaled;
        }
        r.ssim = await ssim(r.exportPng, r.previewPng);
        r.pass = r.ssim >= SSIM_THRESHOLD;
        r.sideBySide = join(framesDir, `${tag}-side-by-side.png`);
        await sideBySide(r.exportPng, r.previewPng, r.sideBySide);
      } catch (err) {
        r.error = (err as Error).message.split('\n')[0];
      }
      results.push(r);
      console.log(`  frame ${String(c.frame).padStart(4)}  ssim ${r.ssim === null ? '  n/a ' : r.ssim.toFixed(4)}  ${r.pass ? 'PASS' : 'FAIL'}  ${r.error ?? c.reason}`);
    }
  } finally {
    await browser.close();
  }
  return results;
}

// ---------------------------------------------------------------------------
// c. audio sync
// ---------------------------------------------------------------------------

interface AudioResult {
  clipId: string;
  name: string;
  /** Scene-anchored sound effect or project-level clip. */
  scope: 'scene' | 'project';
  /** No onset to measure: the clip starts too softly over what already plays. Not a failure. */
  skipped?: boolean;
  expectedFrame: number;
  measuredFrame: number | null;
  deltaFrames: number | null;
  maxRiseDb: number;
  pass: boolean;
  note?: string;
}

async function decodeAudio(file: string, sampleRate: number): Promise<Float32Array | null> {
  const r = await run(FFMPEG, ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-']);
  if (r.code !== 0 || r.stdout.length === 0) return null;
  const buf = r.stdout;
  const copy = new ArrayBuffer(buf.length - (buf.length % 4));
  new Uint8Array(copy).set(buf.subarray(0, copy.byteLength));
  return new Float32Array(copy);
}

/** RMS level (dB) of frame `f` of a mono signal; silence before the start and past the end. */
function frameDb(samples: Float32Array | null, spf: number, f: number, gain = 1): number {
  if (!samples || f < 0) return -200;
  const a = Math.round(f * spf);
  const b = Math.min(samples.length, Math.round((f + 1) * spf));
  if (b <= a) return -200;
  let sum = 0;
  for (let i = a; i < b; i++) sum += samples[i] * samples[i];
  return 20 * Math.log10(Math.sqrt(sum / (b - a)) * gain + 1e-10);
}

/**
 * How loud the clip itself is over its first three frames (its source after
 * the trim, at the clip's gain), against the other expected sources just before it
 * starts: whether its start can show up as an onset at all.
 */
function onsetDetectable(clip: AudioClip, source: Float32Array | null, spf: number, beforeDb: number): { detectable: boolean; ownDb: number } {
  let ownDb = -200;
  for (let k = 0; k < 3 && k < clip.durationInFrames; k++) ownDb = Math.max(ownDb, frameDb(source, spf, clip.trimStartFrames + k, clipVolumeAt(clip, k)));
  return { detectable: ownDb > -60 && ownDb - beforeDb > ONSET_RISE_DB + 3, ownDb };
}

export async function checkAudio(file: string, project: Project, publicCheck: (src: string) => Promise<boolean>, assetUrl: (src: string) => string): Promise<AudioResult[]> {
  // Every audio clip, plus the attached soundtrack of every unmuted top-level video (it starts with the element).
  const clips = [...project.audio];
  for (const scene of project.scenes) {
    for (const el of scene.elements) {
      if (el.type !== 'video' || el.parentId) continue;
      const v = videoProps(el);
      const asset = project.assets[v.assetId];
      if (v.muted || !asset || asset.hasAudio === false || v.volume <= 0) continue;
      clips.push({ id: `video:${el.id}`, assetId: asset.id, name: `${el.name} (video sound)`, sceneId: scene.id, startFrame: el.startFrame, trimStartFrames: v.trimStartFrames, durationInFrames: el.durationInFrames, volume: v.volume, fadeInFrames: 0, fadeOutFrames: 0 });
    }
  }
  if (clips.length === 0) return [];
  const sr = 48000;
  const samples = await decodeAudio(file, sr);
  const spf = sr / project.fps;
  const rmsDb = (f: number): number => frameDb(samples, spf, f);
  const sources = new Map<string, Float32Array | null>();
  const present = new Map<string, boolean>();
  for (const clip of clips) {
    const asset = project.assets[clip.assetId];
    if (!asset || present.has(asset.src)) continue;
    const exists = await publicCheck(asset.src);
    present.set(asset.src, exists);
    if (exists) sources.set(asset.src, await decodeAudio(assetUrl(asset.src), sr));
  }
  const results: AudioResult[] = [];
  for (const clip of clips) {
    const expected = audioClipStartFrame(project, clip);
    const asset = project.assets[clip.assetId];
    const assetPresent = asset ? present.get(asset.src) === true : false;
    const scope = clip.sceneId ? 'scene' : 'project';
    // Estimate masking from the expected OTHER sources. Sampling the export
    // here would let an early copy of this clip mask its own timing error.
    let backgroundGain = 0;
    let backgroundKnown = true;
    for (const other of clips) {
      if (other === clip) continue;
      const local = expected - 1 - audioClipStartFrame(project, other);
      if (local < 0 || local >= other.durationInFrames) continue;
      const otherAsset = project.assets[other.assetId];
      const otherSource = otherAsset ? sources.get(otherAsset.src) : null;
      if (!otherSource) { backgroundKnown = false; continue; }
      backgroundGain += 10 ** (frameDb(otherSource, spf, other.trimStartFrames + local, clipVolumeAt(other, local)) / 20);
    }
    const beforeDb = 20 * Math.log10(backgroundGain + 1e-10);
    const source = asset ? sources.get(asset.src) : null;
    const own = onsetDetectable(clip, source ?? null, spf, beforeDb);
    if (asset && assetPresent && source && samples && backgroundKnown && !own.detectable) {
      results.push({
        clipId: clip.id, name: clip.name, scope, skipped: true, expectedFrame: expected, measuredFrame: null, deltaFrames: null, maxRiseDb: 0, pass: true,
        note: `no detectable onset: the clip starts at ${own.ownDb.toFixed(1)} dB over ${beforeDb.toFixed(1)} dB from other expected sources`,
      });
      continue;
    }
    let measured: number | null = null;
    let maxRise = -Infinity;
    for (let f = Math.max(0, expected - AUDIO_WINDOW); f <= expected + AUDIO_WINDOW; f++) {
      const rise = rmsDb(f) - rmsDb(f - 1);
      maxRise = Math.max(maxRise, rise);
      if (measured === null && rise > ONSET_RISE_DB) measured = f;
    }
    const delta = measured === null ? null : measured - expected;
    const pass = delta !== null && Math.abs(delta) <= AUDIO_TOLERANCE;
    const notes: string[] = [];
    if (!samples) notes.push('no decodable audio in the MP4');
    if (!asset) notes.push(`asset ${clip.assetId} not in project`);
    else if (!assetPresent) notes.push(`source file public/${asset.src} is missing, so the clip cannot be audible`);
    if (measured === null) notes.push(`no frame rose more than ${ONSET_RISE_DB} dB within ±${AUDIO_WINDOW} frames`);
    results.push({ clipId: clip.id, name: clip.name, scope, expectedFrame: expected, measuredFrame: measured, deltaFrames: delta, maxRiseDb: Number(maxRise.toFixed(1)), pass, note: notes.join('; ') || undefined });
  }
  return results;
}

// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const job = await getJson<RenderJob>(`${args.server}/api/renders/${encodeURIComponent(args.job)}`);
  if (job.status !== 'done') throw new Error(`Job ${job.id} is ${job.status}${job.error ? `: ${job.error}` : ''} — nothing to verify.`);
  const project = await getJson<Project>(`${args.server}/api/renders/${encodeURIComponent(args.job)}/project`);
  const outDir = resolve(args.out ?? join('renders', `verify-${job.id}`));
  const framesDir = join(outDir, 'frames');
  await mkdir(outDir, { recursive: true });

  let file = args.file ? resolve(args.file) : job.outputPath && existsSync(job.outputPath) ? job.outputPath : '';
  if (!file) {
    file = join(outDir, `${job.id}.${deliverySettings(job.preset, project.height).extension}`);
    const res = await fetch(`${args.server}${job.outputUrl}`);
    if (!res.ok) throw new Error(`Cannot download ${job.outputUrl}: ${res.status}`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }

  console.log(`verify-export: job ${job.id} (project ${job.projectId} rev ${job.projectRevision}) → ${file}`);
  console.log('a. streams');
  const streams = await checkStreams(file, project, job);
  for (const c of streams) console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${c.name}: ${c.actual ?? ''}${c.pass ? '' : ` (expected ${c.expected ?? '-'})`}${c.note ? ` — ${c.note}` : ''}`);

  console.log(`b. frame agreement (SSIM ≥ ${SSIM_THRESHOLD}, preview from ${args.web}/capture.html)`);
  let frames: FrameResult[] = [];
  let framesError: string | undefined;
  const skipFrames = job.preset === 'gif-480' || job.preset === 'webm-1080';
  const framesNote = skipFrames ? `SSIM skipped for ${job.preset}; stream and full decode checks still ran.` : undefined;
  try {
    if (skipFrames) console.log(`  SKIP  ${framesNote}`);
    else frames = await checkFrames(file, project, args, framesDir, job);
  } catch (err) {
    framesError = (err as Error).message.split('\n')[0];
    console.log(`  FAIL  ${framesError}`);
  }

  console.log(`c. audio sync (onset within ±${AUDIO_TOLERANCE} frames)`);
  const publicCheck = async (src: string) => {
    try {
      return (await getJson<{ exists: boolean }>(`${args.server}/api/assets/check?src=${encodeURIComponent(src)}`)).exists;
    } catch {
      return false;
    }
  };
  const audio = job.preset === 'gif-480' ? [] : await checkAudio(file, project, publicCheck, (src) => `${args.server.replace('//localhost:', '//127.0.0.1:')}/${src.replace(/^\/+/, '')}`);
  if (job.preset === 'gif-480') console.log('  SKIP  GIF has no audio.');
  if (audio.length === 0) console.log('  (no audio clips)');
  for (const a of audio) {
    if (a.skipped) {
      console.log(`  SKIP  ${a.clipId} (${a.scope}): expected frame ${a.expectedFrame} — ${a.note}`);
      continue;
    }
    console.log(`  ${a.pass ? 'PASS' : 'FAIL'}  ${a.clipId} (${a.scope}): expected frame ${a.expectedFrame}, measured ${a.measuredFrame ?? 'none'}${a.deltaFrames !== null ? ` (Δ ${a.deltaFrames})` : ''}, max rise ${a.maxRiseDb} dB${a.note ? ` — ${a.note}` : ''}`);
  }

  const texts = project.scenes.flatMap((s) =>
    s.elements.filter((e) => typeof e.props.text === 'string').map((e) => ({ sceneId: s.id, elementId: e.id, type: e.type, text: e.props.text as string })),
  );
  console.log(`d. content: project revision ${project.revision}`);
  for (const t of texts) console.log(`  ${t.sceneId} › ${t.elementId} (${t.type}): ${JSON.stringify(t.text)}`);

  const streamsPass = streams.every((c) => c.pass);
  const framesPass = skipFrames || (!framesError && frames.length > 0 && frames.every((f) => f.pass));
  const audioPass = audio.every((a) => a.pass);
  const pass = streamsPass && framesPass && audioPass;
  const minSsim = frames.reduce((m, f) => (f.ssim === null ? m : Math.min(m, f.ssim)), Infinity);

  const report = {
    pass,
    job: { id: job.id, projectId: job.projectId, projectRevision: job.projectRevision, outputPath: file, preset: job.preset, retryOf: job.retryOf },
    summary: {
      streams: streamsPass,
      frames: framesPass,
      audio: audioPass,
      checkpoints: frames.length,
      minSsim: Number.isFinite(minSsim) ? minSsim : null,
    },
    streams,
    frames: { threshold: SSIM_THRESHOLD, skipped: skipFrames, note: framesNote, error: framesError, results: frames },
    audio: { toleranceFrames: AUDIO_TOLERANCE, onsetRiseDb: ONSET_RISE_DB, results: audio },
    content: { revision: project.revision, texts },
    generatedAt: new Date().toISOString(),
  };
  const reportPath = join(outDir, 'verify-report.json');
  await writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log('');
  console.log(`SUMMARY  streams ${streamsPass ? 'PASS' : 'FAIL'} | frames ${skipFrames ? 'SKIP' : framesPass ? 'PASS' : 'FAIL'} (${frames.filter((f) => f.pass).length}/${frames.length}, min SSIM ${report.summary.minSsim?.toFixed(4) ?? 'n/a'}) | audio ${audioPass ? 'PASS' : 'FAIL'} (${audio.filter((a) => a.pass && !a.skipped).length}/${audio.filter((a) => !a.skipped).length} measured, ${audio.filter((a) => a.skipped).length} without a detectable onset) | overall ${pass ? 'PASS' : 'FAIL'}`);
  console.log(`report: ${reportPath}`);
  process.exit(pass ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    console.error(`verify-export: ${(err as Error).message}`);
    process.exit(2);
  });
}
