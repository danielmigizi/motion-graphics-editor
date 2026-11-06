// Local ffmpeg/ffprobe analysis of a reference video (the bar-video workflow).
// Deterministic and cached. Analysis only — never copies the source into a project.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, delimiter, extname, join, resolve } from 'node:path';
import { analyzeBeats } from '../src/core/beats';
import {
  contactSheetPages,
  fastWindows,
  holdWindows,
  motionEnergy,
  paletteFromRgb,
  REFERENCE_NOTICE,
  shotsFromCuts,
  type ReferenceArtifact,
  type ReferenceReport,
  type Shot,
} from '../src/core/reference-video';
import { decodeMono } from './beats';
import { mediaTool } from './media-tools';
import { downloadBytes, ImportUrlError, type ImportOptions } from './url-import';
import { probeVideo } from './video';
import { openAgentFile, PrivateFileError } from './local-file';

export const REFERENCE_MAX_BYTES = 200 * 1024 * 1024;
export const REFERENCE_MAX_SECONDS = 180;
export const REFERENCE_CONTACT_FPS = 1;
export const REFERENCE_MOTION_FPS = 8;
export const SCENE_THRESHOLD = 0.3;

export class ReferenceAnalyzeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface ReferenceAnalyzeOptions extends ImportOptions {
  refresh?: boolean;
  rootDir?: string;
  /** Override yt-dlp (tests). */
  ytdlp?: { available: boolean; download?: (url: string, dest: string) => Promise<void> };
}

const PAGE_HOST = /(?:^|\.)((youtube|youtu)\.be|youtube\.com|vimeo\.com|x\.com|twitter\.com|tiktok\.com)$/i;
const MEDIA_EXT = /\.(mp4|webm|mov|m4v)(\?|$)/i;

function run(bin: 'ffmpeg' | 'ffprobe', args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const tool = mediaTool(bin);
  return new Promise((resolvePromise) => {
    execFile(tool.cmd, args, { cwd: tool.cwd, env: tool.env, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolvePromise({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

export function findYtDlp(pathEnv = process.env.PATH ?? ''): string | null {
  if (process.env.MGE_YTDLP) return process.env.MGE_YTDLP;
  const exe = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  for (const dir of [...pathEnv.split(delimiter).filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin']) {
    const p = join(dir, exe);
    if (existsSync(p)) return p;
  }
  return null;
}

async function ytdlpDownload(url: string, dest: string): Promise<void> {
  const bin = findYtDlp();
  if (!bin) throw new ReferenceAnalyzeError('yt-dlp is not installed. Pass a direct https://…mp4 URL, or install yt-dlp for YouTube/X/Vimeo pages.');
  const r = await new Promise<{ code: number; stderr: string }>((resolvePromise) => {
    execFile(bin, ['--no-playlist', '--no-warnings', '-f', 'best[ext=mp4]/best', '--max-filesize', '200M', '-o', dest, url], { timeout: 180_000, maxBuffer: 8 * 1024 * 1024 }, (err, _stdout, stderr) => {
      resolvePromise({ code: err ? 1 : 0, stderr: String(stderr) });
    });
  });
  if (r.code !== 0 || !existsSync(dest)) throw new ReferenceAnalyzeError(`yt-dlp could not download the video: ${r.stderr.trim().split('\n').slice(-1)[0] || 'failed'}`);
}

function cacheKey(kind: string, input: string, size: number, mtime: number): string {
  return createHash('sha256').update(`${kind}|${input}|${size}|${mtime}`).digest('hex').slice(0, 16);
}

async function readReport(dir: string): Promise<ReferenceReport | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'report.json'), 'utf8')) as ReferenceReport;
    return raw?.specs ? { ...raw, cached: true } : null;
  } catch {
    return null;
  }
}

function parseSceneCuts(stderr: string, fps: number): { timeSeconds: number; frame: number }[] {
  const times: number[] = [];
  for (const m of stderr.matchAll(/pts_time:([0-9.]+)/g)) {
    const t = Number(m[1]);
    if (Number.isFinite(t) && t > 0) times.push(t);
  }
  const unique = [...new Set(times.map((t) => Math.round(t * 1000) / 1000))];
  return unique.map((timeSeconds) => ({ timeSeconds, frame: Math.round(timeSeconds * fps) }));
}

function parseLoudness(stderr: string): ReferenceReport['loudness'] {
  const integrated = stderr.match(/I:\s+(-?[\d.]+)\s+LUFS/);
  const lra = stderr.match(/LRA:\s+(-?[\d.]+)\s+LU/);
  const peak = stderr.match(/Peak:\s+(-?[\d.]+)\s+dBFS/) ?? stderr.match(/True peak:\s+(-?[\d.]+)\s+dBTP/i);
  if (!integrated && !lra) {
    return { integratedLufs: null, lra: null, note: 'ebur128 is not available in this ffmpeg build; loudness was skipped.' };
  }
  return {
    integratedLufs: integrated ? Number(integrated[1]) : null,
    lra: lra ? Number(lra[1]) : null,
    truePeakDbtp: peak ? Number(peak[1]) : null,
  };
}

async function rawGray(path: string, fps: number, srcW: number, srcH: number, width = 160): Promise<Uint8Array[]> {
  const tool = mediaTool('ffmpeg');
  return new Promise((resolvePromise, reject) => {
    const p = spawn(tool.cmd, ['-v', 'error', '-i', path, '-an', '-vf', `fps=${fps},scale=${width}:-2,format=gray`, '-f', 'rawvideo', '-'], { cwd: tool.cwd, env: tool.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.stderr.on('data', (d: Buffer) => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(err.trim() || `ffmpeg gray exit ${code}`));
      const buf = Buffer.concat(chunks);
      const height = Math.max(2, Math.round((width * srcH) / srcW / 2) * 2);
      const frameSize = width * height;
      if (!frameSize) return resolvePromise([]);
      // If the aspect isn't 16:9 the last incomplete frame is dropped.
      const n = Math.floor(buf.length / frameSize);
      const frames: Uint8Array[] = [];
      for (let i = 0; i < n; i++) frames.push(Uint8Array.from(buf.subarray(i * frameSize, (i + 1) * frameSize)));
      resolvePromise(frames);
    });
  });
}

async function sampleRgb(path: string, timeSeconds: number): Promise<Uint8Array> {
  const tool = mediaTool('ffmpeg');
  return new Promise((resolvePromise, reject) => {
    const p = spawn(tool.cmd, ['-v', 'error', '-ss', String(timeSeconds), '-i', path, '-frames:v', '1', '-vf', 'scale=80:45,format=rgb24', '-f', 'rawvideo', '-'], { cwd: tool.cwd, env: tool.env, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.on('error', reject);
    p.on('close', () => resolvePromise(Uint8Array.from(Buffer.concat(chunks))));
  });
}

async function resolveSource(
  publicDir: string,
  args: { url?: string; path?: string },
  opts: ReferenceAnalyzeOptions,
): Promise<{ kind: 'file' | 'url'; input: string; resolvedPath: string; key: string }> {
  if ((args.path === undefined) === (args.url === undefined)) {
    throw new ReferenceAnalyzeError('Give either path (a local video file) or url (https), not both.');
  }
  if (args.path) {
    const { file, resolved, info } = await openAgentFile(args.path, opts.rootDir ?? resolve(publicDir, '..')).catch(error => {
      if (error instanceof PrivateFileError) throw error;
      if (['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new ReferenceAnalyzeError(`File ${args.path} does not exist.`);
      throw error;
    });
    // ffmpeg reads the checked real path (no symlinks left in it), not the caller's
    // spelling. Copying the file would publish a private video under public/.
    await file.close();
    if (!info.isFile()) throw new ReferenceAnalyzeError(`${args.path} is not a file.`);
    return { kind: 'file', input: args.path, resolvedPath: resolved, key: cacheKey('file', resolved, info.size, info.mtimeMs) };
  }
  const url = args.url!;
  const dir = join(publicDir, 'analysis', 'reference', '_downloads');
  await mkdir(dir, { recursive: true });
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    throw new ReferenceAnalyzeError('url is not a valid URL.');
  }
  const page = PAGE_HOST.test(host);
  const dest = join(dir, `${createHash('sha256').update(url).digest('hex').slice(0, 16)}.mp4`);
  if (existsSync(dest) && !opts.refresh) {
    const info = await stat(dest);
    return { kind: 'url', input: url, resolvedPath: dest, key: cacheKey('url', url, info.size, info.mtimeMs) };
  }
  const tryYtdlp = opts.ytdlp?.available ?? !!findYtDlp();
  const download = opts.ytdlp?.download ?? ytdlpDownload;
  if (page) {
    if (!tryYtdlp) throw new ReferenceAnalyzeError('This looks like a video page. Install yt-dlp to analyse it, or pass a direct mp4 URL.');
    await download(url, dest);
  } else {
    try {
      const file = await downloadBytes(url, { ...opts, maxBytes: REFERENCE_MAX_BYTES, timeoutMs: opts.timeoutMs ?? 120_000 });
      if (!MEDIA_EXT.test(url) && !/video\//.test(file.contentType) && tryYtdlp) {
        await download(url, dest);
      } else {
        await writeFile(dest, file.body);
      }
    } catch (e) {
      if (tryYtdlp && !(e instanceof ReferenceAnalyzeError)) {
        await download(url, dest);
      } else {
        throw new ReferenceAnalyzeError(e instanceof ImportUrlError || e instanceof Error ? e.message : String(e));
      }
    }
  }
  const info = await stat(dest);
  return { kind: 'url', input: url, resolvedPath: dest, key: cacheKey('url', url, info.size, info.mtimeMs) };
}

/** Probe + ffmpeg artefacts for a local file or https URL. Cached under public/analysis/reference/<key>/. */
export async function analyzeReference(
  publicDir: string,
  args: { url?: string; path?: string },
  opts: ReferenceAnalyzeOptions = {},
): Promise<ReferenceReport> {
  const source = await resolveSource(publicDir, args, opts);
  const outDir = join(publicDir, 'analysis', 'reference', source.key);
  if (!opts.refresh) {
    const hit = await readReport(outDir);
    if (hit) return { ...hit, source: { ...hit.source, resolvedPath: source.resolvedPath }, cached: true };
  }
  const probe = await probeVideo(source.resolvedPath);
  if (!probe.decodable || !probe.width || !probe.height || !probe.durationSeconds || !probe.fps) {
    throw new ReferenceAnalyzeError(probe.error ?? 'ffprobe could not read a decodable video.');
  }
  const durationSeconds = Math.min(probe.durationSeconds, REFERENCE_MAX_SECONDS);
  const fps = probe.fps;
  const frames = Math.round(durationSeconds * fps);
  await mkdir(outDir, { recursive: true });

  const scene = await run('ffmpeg', [
    '-v', 'info', '-i', source.resolvedPath, '-an',
    '-vf', `select='gt(scene,${SCENE_THRESHOLD})',showinfo`,
    '-f', 'null', '-',
  ], 180_000);
  const sceneCuts = parseSceneCuts(scene.stderr, fps);

  const ebur = await run('ffmpeg', ['-i', source.resolvedPath, '-filter_complex', 'ebur128=framelog=quiet', '-f', 'null', '-'], 180_000);
  const loudness = parseLoudness(ebur.stderr);

  let beats: ReferenceReport['beats'] = { bpm: null, confidence: 0, beats: [], downbeats: [], onsets: [], strongHits: [] };
  if (probe.hasAudio) {
    try {
      const samples = await decodeMono(source.resolvedPath);
      const analysis = analyzeBeats([samples], 22050, fps);
      beats = { bpm: analysis.bpm, confidence: analysis.confidence, beats: analysis.beats, downbeats: analysis.downbeats, onsets: analysis.onsets, strongHits: analysis.strong };
    } catch {
      beats = { ...beats };
    }
  }

  let energy: number[] = [];
  try {
    const gray = await rawGray(source.resolvedPath, REFERENCE_MOTION_FPS, probe.width, probe.height);
    energy = motionEnergy(gray);
  } catch {
    energy = [];
  }
  const motion = {
    energy,
    fps: REFERENCE_MOTION_FPS,
    holds: holdWindows(energy, REFERENCE_MOTION_FPS),
    fast: fastWindows(energy, REFERENCE_MOTION_FPS),
  };

  const { pages, tilesPerPage } = contactSheetPages(durationSeconds);
  const artifacts: ReferenceArtifact[] = [];
  for (let page = 0; page < pages; page++) {
    const start = page * tilesPerPage;
    const name = `contact_${String(page + 1).padStart(2, '0')}.png`;
    const dest = join(outDir, name);
    await run('ffmpeg', [
      '-y', '-i', source.resolvedPath, '-an',
      '-vf', `fps=${REFERENCE_CONTACT_FPS},scale=320:-2,trim=start_frame=${start}:end_frame=${start + tilesPerPage},tile=6x4`,
      dest,
    ], 180_000);
    artifacts.push({
      kind: 'contact-sheet',
      path: join('analysis', 'reference', source.key, name),
      startSeconds: start,
      endSeconds: Math.min(durationSeconds, start + tilesPerPage),
      columns: 6,
      rows: 4,
    });
  }

  let strip = 0;
  for (const win of motion.fast.slice(0, 8)) {
    strip += 1;
    const name = `strip_${String(strip).padStart(2, '0')}.png`;
    const dest = join(outDir, name);
    await run('ffmpeg', [
      '-y', '-ss', String(win.startSeconds), '-i', source.resolvedPath, '-an',
      '-t', String(Math.max(0.2, win.endSeconds - win.startSeconds)),
      '-vf', 'select=not(mod(n\\,2)),scale=160:-2,tile=8x1',
      '-frames:v', '1',
      dest,
    ], 60_000);
    artifacts.push({
      kind: 'strip',
      path: join('analysis', 'reference', source.key, name),
      startSeconds: win.startSeconds,
      endSeconds: win.endSeconds,
      stepFrames: 2,
    });
  }

  const bases = shotsFromCuts(sceneCuts.map((c) => c.timeSeconds), durationSeconds, fps);
  const shots: Shot[] = [];
  for (const shot of bases) {
    const mid = (shot.startSeconds + shot.endSeconds) / 2;
    const samples = [shot.startSeconds + 0.05, mid, Math.max(shot.startSeconds, shot.endSeconds - 0.05)];
    const pixels: number[] = [];
    for (const t of samples) {
      try {
        pixels.push(...await sampleRgb(source.resolvedPath, t));
      } catch {
        // skip
      }
    }
    shots.push({ ...shot, palette: paletteFromRgb(Uint8Array.from(pixels)) });
  }

  const report: ReferenceReport = {
    source: { kind: source.kind, input: source.input, resolvedPath: source.resolvedPath },
    specs: {
      width: probe.width,
      height: probe.height,
      fps,
      durationSeconds,
      frames,
      videoCodec: probe.codec,
      audioCodec: probe.audioCodec,
      hasAudio: probe.hasAudio,
    },
    sceneCuts,
    shots,
    loudness,
    beats,
    motion,
    artifacts,
    cached: false,
    notice: REFERENCE_NOTICE,
  };
  await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}

export const referenceFileName = (p: string) => basename(p, extname(p));
