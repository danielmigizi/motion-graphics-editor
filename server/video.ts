// Video files: streamed uploads (up to 500 MB, never buffered in memory),
// probing with ffprobe, background preview proxies (720p H.264, a keyframe
// every second, the source's own frame timestamps, AAC) made with ffmpeg (both
// resolved by server/media-tools.ts), and the export preflight that refuses
// missing or undecodable videos with a message naming the element.

import { execFile, spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, realpath, rename, stat, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { mediaTool } from './media-tools';
import type { AssetProxyResponse, UploadAssetResponse } from '../src/core/api-contract';
import type { Element, Project } from '../src/core/types';

export const VIDEO_UPLOAD_LIMIT = 500 * 1024 * 1024;
/** Proxies are made for files bigger than this (and for > 1080p, long-GOP or VFR sources). */
export const PROXY_SIZE_THRESHOLD = 50 * 1024 * 1024;
/** Mean keyframe spacing above this counts as long-GOP (slow to seek). */
const LONG_GOP_SECONDS = 2;

export class VideoUploadError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Binaries (server/media-tools.ts: MGE_FFMPEG / MGE_FFPROBE, else PATH)
// ---------------------------------------------------------------------------

export { mediaTool } from './media-tools';

function runTool(bin: 'ffmpeg' | 'ffprobe', args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const tool = mediaTool(bin);
  return new Promise((resolve) => {
    execFile(tool.cmd, args, { cwd: tool.cwd, env: tool.env, maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export interface VideoProbe {
  decodable: boolean;
  /** Why it cannot be used, in words. */
  error?: string;
  durationSeconds?: number;
  width?: number;
  height?: number;
  /** Average frame rate. */
  fps?: number;
  /** Nominal (maximum) frame rate, used for the proxy. */
  nominalFps?: number;
  codec?: string;
  hasAudio: boolean;
  audioCodec?: string;
  /** Variable frame rate (screen recorders). */
  vfr: boolean;
  /** Mean keyframe spacing in seconds over the first ~20 s. */
  keyframeSeconds?: number;
}

/** Codecs Chrome's WebCodecs (preview and export) decode everywhere. */
const BROWSER_VIDEO_CODECS = new Set(['h264', 'vp8', 'vp9', 'av1']);
const BROWSER_AUDIO_CODECS = new Set(['aac', 'opus', 'mp3', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le']);
const CODEC_NAMES: Record<string, string> = { hevc: 'H.265/HEVC', prores: 'Apple ProRes', mpeg4: 'MPEG-4 Part 2', mjpeg: 'Motion JPEG', dnxhd: 'DNxHD' };

const rate = (r: string | undefined) => {
  const [n, d] = (r ?? '').split('/').map(Number);
  return n > 0 && d > 0 ? n / d : undefined;
};

interface ProbeStream { codec_type?: string; codec_name?: string; profile?: string; pix_fmt?: string; width?: number; height?: number; r_frame_rate?: string; avg_frame_rate?: string; duration?: string; disposition?: { attached_pic?: number } }

/** Interpret ffprobe's JSON (pure; exported for tests). */
export function interpretProbe(json: { streams?: ProbeStream[]; format?: { duration?: string } }, packets: { pts: number; key: boolean }[] = []): VideoProbe {
  const v = json.streams?.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const a = json.streams?.find((s) => s.codec_type === 'audio');
  const audioOk = !!a?.codec_name && BROWSER_AUDIO_CODECS.has(a.codec_name);
  const base: VideoProbe = { decodable: false, hasAudio: audioOk, vfr: false, ...(a?.codec_name ? { audioCodec: a.codec_name } : {}) };
  if (!v) return { ...base, error: 'The file has no video stream' };
  const codec = v.codec_name ?? 'unknown';
  const duration = Number(v.duration ?? json.format?.duration);
  const avg = rate(v.avg_frame_rate);
  const nominal = rate(v.r_frame_rate);
  const info: VideoProbe = {
    ...base,
    codec,
    width: v.width,
    height: v.height,
    ...(Number.isFinite(duration) && duration > 0 ? { durationSeconds: duration } : {}),
    ...(avg ? { fps: Math.round(avg * 1000) / 1000 } : nominal ? { fps: nominal } : {}),
    ...(nominal ? { nominalFps: nominal } : {}),
  };
  // VFR: the average rate disagrees with the nominal one, or frame spacing varies.
  const pts = packets.map((p) => p.pts).sort((x, y) => x - y);
  const deltas = pts.slice(1).map((t, i) => t - pts[i]).filter((d) => d > 0);
  const spread = deltas.length > 2 ? Math.max(...deltas) / Math.min(...deltas) : 1;
  info.vfr = (avg !== undefined && nominal !== undefined && Math.abs(avg - nominal) / nominal > 0.02) || spread > 1.5;
  const keys = packets.filter((p) => p.key).length;
  // A single keyframe in the sample: the whole sampled span is one GOP.
  if (pts.length > 1) info.keyframeSeconds = (pts[pts.length - 1] - pts[0]) / Math.max(1, keys - 1);
  if (!BROWSER_VIDEO_CODECS.has(codec)) return { ...info, error: `${CODEC_NAMES[codec] ?? codec} video can't be played in the editor; export it again as H.264 MP4 (or VP9 WebM)` };
  if (codec === 'h264' && /High 10|4:2:2|4:4:4/i.test(v.profile ?? '')) return { ...info, error: `H.264 ${v.profile} can't be played in the editor; export it again as 8-bit H.264 (High profile)` };
  if (!(v.width && v.height)) return { ...info, error: 'The video stream has no picture size' };
  if (!info.durationSeconds) return { ...info, error: 'The video has no readable duration' };
  return { ...info, decodable: true };
}

export async function probeVideo(path: string): Promise<VideoProbe> {
  const meta = await runTool('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], 60_000);
  if (meta.code !== 0) return { decodable: false, hasAudio: false, vfr: false, error: `ffprobe could not read the file: ${meta.stderr.trim().split('\n')[0] || 'unknown error'}` };
  let json: { streams?: ProbeStream[]; format?: { duration?: string } };
  try {
    json = JSON.parse(meta.stdout);
  } catch {
    return { decodable: false, hasAudio: false, vfr: false, error: 'ffprobe returned unreadable output' };
  }
  // Packet timestamps + keyframe flags of the first ~20 s (no decoding).
  const pk = await runTool('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-read_intervals', '%+20', '-show_entries', 'packet=pts_time,flags', '-of', 'csv=p=0', path], 60_000);
  const packets = pk.stdout
    .split('\n')
    .map((line) => line.split(','))
    .filter((p) => p.length >= 2 && p[0] !== 'N/A' && p[0] !== '')
    .map(([t, flags]) => ({ pts: Number(t), key: flags.includes('K') }))
    .filter((p) => Number.isFinite(p.pts));
  return interpretProbe(json, packets);
}

/** Should the preview use a proxy? (> 1080p, long-GOP, VFR or > 50 MB) */
export function proxyReasons(probe: VideoProbe, bytes: number): string[] {
  const reasons: string[] = [];
  if ((probe.width ?? 0) > 1920 || (probe.height ?? 0) > 1080) reasons.push('larger than 1080p');
  if (probe.vfr) reasons.push('variable frame rate');
  if ((probe.keyframeSeconds ?? 0) > LONG_GOP_SECONDS) reasons.push('few keyframes');
  if (bytes > PROXY_SIZE_THRESHOLD) reasons.push('larger than 50 MB');
  return reasons;
}

// ---------------------------------------------------------------------------
// Proxies
// ---------------------------------------------------------------------------

/** `assets/uploads/u_x.mp4` → `assets/uploads/u_x.proxy.mp4` */
export const proxySrcFor = (src: string) => src.replace(/\.[A-Za-z0-9]+$/, '') + '.proxy.mp4';

/**
 * ffmpeg arguments for a proxy: ≤ 720p, keyframe every second, AAC — and every
 * frame at the source's own presentation timestamp (no frame-rate conversion),
 * so for any requested time the proxy shows the same source frame as the
 * original that exports read. (Converting to a rounded rate — a 30000/1001
 * source to 30 fps — would shift frames: at 10.001 s the original shows frame
 * 299 but a 30 fps proxy already frame 300. Variable-rate sources keep their
 * timing for the same reason; the keyframe every second is what makes them
 * quick to seek.)
 */
export function proxyArgs(input: string, output: string, probe: VideoProbe): string[] {
  const h = Math.min(720, probe.height ?? 720);
  const even = h - (h % 2);
  return [
    '-y', '-v', 'error', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', `scale=-2:${even}`,
    '-fps_mode', 'passthrough', '-force_key_frames', 'expr:gte(t,n_forced*1)',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
    '-movflags', '+faststart',
    output,
  ];
}

interface ProxyJob { status: 'pending' | 'ready' | 'failed'; error?: string; reasons: string[] }

/** A preview proxy (or its partial file): never itself proxied. */
const isProxyFile = (src: string) => /\.proxy\.mp4(\.part\.mp4)?$/i.test(src);

/**
 * Background proxy maker: one ffmpeg at a time, status per source file.
 * `status` only reads (GET /api/assets/proxy, open to any page); only
 * `request` probes and starts ffmpeg (POST, which the server accepts from the
 * editor's origin only). Jobs are keyed by the file's canonical path, so
 * spellings like `assets/./uploads/x.mp4` share one job.
 */
export class ProxyQueue {
  private jobs = new Map<string, ProxyJob>();
  private queue: { src: string; abs: string; probe: VideoProbe }[] = [];
  private running = false;

  constructor(private readonly publicDir: string, private readonly log: (m: string) => void = (m) => console.log(`[proxy] ${m}`)) {}

  /**
   * The one spelling of an asset path: `.`/`..`, repeated or leading slashes and
   * symlinks resolved, relative to public/ with `/` separators. Null for paths
   * outside public/ and files that do not exist.
   */
  async canonical(src: string): Promise<{ src: string; abs: string } | null> {
    if (typeof src !== 'string' || !src || src.includes('\0') || /^(data:|blob:|https?:)/i.test(src)) return null;
    try {
      const root = await realpath(resolve(this.publicDir));
      const abs = await realpath(resolve(root, src.replace(/^\/+/, '')));
      const rel = relative(root, abs);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
      if (!(await stat(abs)).isFile()) return null;
      return { src: rel.split(sep).join('/'), abs };
    } catch {
      return null;
    }
  }

  enqueue(src: string, abs: string, probe: VideoProbe, reasons: string[]): void {
    const current = this.jobs.get(src);
    if (current?.status === 'pending' || current?.status === 'ready') return;
    this.jobs.set(src, { status: 'pending', reasons });
    this.queue.push({ src, abs, probe });
    void this.pump();
  }

  private known(src: string): AssetProxyResponse | null {
    const proxySrc = proxySrcFor(src);
    const job = this.jobs.get(src);
    if (job?.status === 'pending') return { status: 'pending', reasons: job.reasons };
    if (job?.status === 'failed') return { status: 'failed', error: job.error, reasons: job.reasons };
    if (existsSync(join(this.publicDir, proxySrc))) return { status: 'ready', proxySrc, reasons: job?.reasons ?? [] };
    return null;
  }

  /** Status for an asset src. Read-only: never probes, transcodes or writes. */
  async status(src: string): Promise<AssetProxyResponse> {
    const c = await this.canonical(src);
    if (!c || isProxyFile(c.src)) return { status: 'none', reasons: [] };
    return this.known(c.src) ?? { status: 'none', reasons: [] };
  }

  /** Make a proxy for an asset src if it needs one and has none (also re-queues one lost to a server restart or a failure). */
  async request(src: string): Promise<AssetProxyResponse> {
    const c = await this.canonical(src);
    if (!c || isProxyFile(c.src)) return { status: 'none', reasons: [] };
    const known = this.known(c.src);
    if (known && known.status !== 'failed') return known;
    const probe = await probeVideo(c.abs);
    const reasons = probe.decodable ? proxyReasons(probe, (await stat(c.abs)).size) : [];
    if (!reasons.length) return { status: 'none', reasons };
    this.enqueue(c.src, c.abs, probe, reasons);
    return this.known(c.src) ?? { status: 'pending', reasons };
  }

  /** Resolves when the queue is empty (tests). */
  async idle(): Promise<void> {
    while (this.running || this.queue.length) await new Promise((r) => setTimeout(r, 50));
  }

  private async pump(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        const { src, abs, probe } = next;
        const out = join(this.publicDir, proxySrcFor(src));
        const tmp = `${out}.part.mp4`;
        const started = Date.now();
        const r = await new Promise<{ code: number; stderr: string }>((resolve) => {
          const tool = mediaTool('ffmpeg');
          const child = spawn(tool.cmd, proxyArgs(abs, tmp, probe), { cwd: tool.cwd, env: tool.env, stdio: ['ignore', 'ignore', 'pipe'] });
          let stderr = '';
          child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-4000)));
          child.on('error', (err) => resolve({ code: 1, stderr: err.message }));
          child.on('close', (code) => resolve({ code: code ?? 1, stderr }));
        });
        if (r.code === 0) {
          await rename(tmp, out);
          this.jobs.set(src, { status: 'ready', reasons: this.jobs.get(src)?.reasons ?? [] });
          this.log(`${basename(src)} → ${basename(out)} in ${((Date.now() - started) / 1000).toFixed(1)} s`);
        } else {
          await unlink(tmp).catch(() => undefined);
          const error = r.stderr.trim().split('\n').slice(-1)[0] || 'ffmpeg failed';
          this.jobs.set(src, { status: 'failed', error, reasons: this.jobs.get(src)?.reasons ?? [] });
          this.log(`${basename(src)} failed: ${error}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

// ---------------------------------------------------------------------------
// Streamed upload
// ---------------------------------------------------------------------------

/**
 * Stream a video upload to public/assets/uploads/ (never buffered whole),
 * refusing more than `limit` bytes, then probe it. Undecodable files are
 * removed and refused with the reason.
 */
export async function storeVideoUpload(
  publicDir: string,
  body: Readable,
  info: { ext: string; mimeType: string },
  filename: string | undefined,
  opts: { contentLength?: number; limit?: number; proxies?: ProxyQueue } = {},
): Promise<UploadAssetResponse> {
  const limit = opts.limit ?? VIDEO_UPLOAD_LIMIT;
  const mb = Math.round(limit / 1024 / 1024);
  if (opts.contentLength !== undefined && opts.contentLength > limit) {
    body.resume();
    throw new VideoUploadError(`Video too large (${(opts.contentLength / 1024 / 1024).toFixed(0)} MB; limit ${mb} MB).`, 413);
  }
  const dir = join(publicDir, 'assets', 'uploads');
  await mkdir(dir, { recursive: true });
  const name = `u_${randomBytes(6).toString('hex')}.${info.ext}`;
  const abs = join(dir, name);
  const part = `${abs}.part`;
  let bytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > limit) cb(new VideoUploadError(`Video too large (limit ${mb} MB).`, 413));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(body, counter, createWriteStream(part));
  } catch (err) {
    await unlink(part).catch(() => undefined);
    if (err instanceof VideoUploadError) {
      body.resume();
      throw err;
    }
    throw new VideoUploadError(`Upload interrupted: ${(err as Error).message}`);
  }
  if (bytes === 0) {
    await unlink(part).catch(() => undefined);
    throw new VideoUploadError('The uploaded file is empty.');
  }
  const probe = await probeVideo(part);
  if (!probe.decodable) {
    await unlink(part).catch(() => undefined);
    throw new VideoUploadError(`“${basename(filename ?? name)}”: ${probe.error ?? 'the video cannot be decoded'}.`);
  }
  await rename(part, abs);
  const src = `assets/uploads/${name}`;
  const reasons = proxyReasons(probe, bytes);
  if (reasons.length && opts.proxies) opts.proxies.enqueue(src, abs, probe, reasons);
  return {
    src,
    name: basename(filename ?? name),
    mimeType: info.mimeType,
    kind: 'video',
    width: probe.width,
    height: probe.height,
    durationSeconds: probe.durationSeconds,
    fps: probe.fps,
    hasAudio: probe.hasAudio,
    codec: probe.codec,
    bytes,
    proxy: reasons.length && opts.proxies ? 'pending' : 'none',
    ...(reasons.length ? { proxyReasons: reasons } : {}),
  };
}

// ---------------------------------------------------------------------------
// Export preflight
// ---------------------------------------------------------------------------

/** Every video element of the project (scenes and reusable compositions) with a human location. */
export function videoElements(project: Project): { element: Element; where: string }[] {
  const out: { element: Element; where: string }[] = [];
  for (const scene of project.scenes) for (const el of scene.elements) if (el.type === 'video') out.push({ element: el, where: `scene "${scene.name}"` });
  for (const comp of Object.values(project.compositions)) for (const el of comp.elements) if (el.type === 'video') out.push({ element: el, where: `component "${comp.name}"` });
  return out;
}

const probeCache = new Map<string, { key: string; probe: VideoProbe }>();

/**
 * Null when every video element's file exists and can be decoded; otherwise
 * a message naming the first affected element. Exports refuse such projects
 * rather than render blank frames.
 */
export async function videoExportProblem(project: Project, resolvePath: (src: string) => string | null): Promise<string | null> {
  for (const { element, where } of videoElements(project)) {
    const asset = project.assets[String(element.props.assetId ?? '')];
    const label = `Video element "${element.name}" in ${where}`;
    if (!asset) return `${label} has no video file. Pick one or remove the element before exporting.`;
    const abs = resolvePath(asset.src);
    let st;
    try {
      st = abs ? await stat(abs) : null;
    } catch {
      st = null;
    }
    if (!abs || !st?.isFile()) return `${label} uses “${asset.name}”, which is missing (public/${asset.src}). Relink or replace it in Assets before exporting.`;
    const key = `${st.size}:${st.mtimeMs}`;
    let cached = probeCache.get(abs);
    if (cached?.key !== key) {
      cached = { key, probe: await probeVideo(abs) };
      probeCache.set(abs, cached);
    }
    if (!cached.probe.decodable) return `${label} uses “${asset.name}”, which can't be decoded: ${cached.probe.error ?? 'unknown error'}. Replace it in Assets before exporting.`;
  }
  return null;
}
