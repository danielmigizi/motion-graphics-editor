// The exporter: our render page in headless Chrome, frames piped into
// ffmpeg. Videos (render, renderPreview, renderComposition), stills and
// contact sheets.
//
// A video is cut into chunks: each scene, in runs of CHUNK_FRAMES from the
// scene's start. A chunk's file is cached under a hash of everything that can
// change its pixels (the render page's code, the encode settings, the scene,
// the project's size/rate/background, its components and its assets' file
// contents), so re-exporting after a one-scene edit re-renders that scene
// only. Several Chrome pages render chunks in parallel, each into its own
// ffmpeg; the chunks are then joined by stream copy and the audio (mixed from
// the declared sounds and the videos' soundtracks) is muxed in.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import type { Browser, BrowserContext, CDPSession, Page } from 'playwright-core';
import { contactSheetLayout } from '../../src/composition/contact-sheet-layout';
import type { ContactSheetProps } from '../../src/composition/ContactSheet';
import type { MainCompositionProps } from '../../src/composition/types';
import type { DeliveryPreset } from '../../src/core/api-contract';
import { deliverySettings } from '../../src/core/delivery';
import { projectDurationInFrames, resolveAssetUrl, sceneStartFrames } from '../../src/core/timing';
import type { Asset, Element, Project } from '../../src/core/types';
import type { FrameMedia, PlannedAudio, RenderInput, VideoFrameIndex } from '../../src/render/protocol';
import { canonicalJson } from '../manifest';
import type { Renderer, RenderProgressUpdate } from '../renders';
import { mixAudio, videoSegments } from './audio';
import { buildRenderBundle, renderBundleHash, startStaticServer, type StaticServer } from './bundle';
import { launchBrowser } from './browser';
import { assemble, chunkEncoder, chunkExtension, frameFormat, type EncodeSpec, type EngineCodec } from './encode';
import { decodeVideoFrames } from './video-frames';

/** Frames per cached chunk, counted from each scene's start (stable across edits elsewhere). */
export const CHUNK_FRAMES = 60;
const JPEG_QUALITY = 90;
/** Chunk cache budget; the least recently used chunks go first. */
const CACHE_BYTES = 4 * 1024 ** 3;

export interface NativeRendererOptions {
  rootDir: string;
  serverPort: number;
  publicDir?: string;
  /** Parallel Chrome pages (default: 60 % of the cores, 2–8). MGE_ENGINE_WORKERS overrides. */
  workers?: number;
  cacheDir?: string;
  /** Re-use cached chunks (default true; MGE_ENGINE_CACHE=0 turns it off). */
  cache?: boolean;
  log?: (msg: string) => void;
}

export interface NativeRenderStats {
  chunks: number;
  cachedChunks: number;
  frames: number;
  renderedFrames: number;
  seconds: number;
}

export interface NativeRenderer {
  /** Bundle origin once started; empty before startup or after close. */
  origins(): string[];
  render: Renderer;
  renderStill(args: { project: Project; frame: number; scale: number; outputPath: string; signal?: AbortSignal; imageFormat?: 'png' | 'jpeg'; jpegQuality?: number; onCompositionHash?: (hash: string) => Promise<void> | void }): Promise<void>;
  renderContactSheet(args: { project: Project; frames: number[]; columns: number; scale?: number; labels?: boolean; outputPath: string; signal?: AbortSignal; onCompositionHash?: (hash: string) => Promise<void> | void }): Promise<void>;
  renderPreview(args: { project: Project; scale: number; outputPath: string; crf?: number }): Promise<void>;
  /** A standalone composition of the render page (not a project). */
  renderComposition(args: { input: RenderInput; preset?: DeliveryPreset; crf?: number; outputPath: string; signal?: AbortSignal; onProgress?: (u: RenderProgressUpdate) => void }): Promise<void>;
  invalidateBundle(): void;
  /** Numbers from the last render (for benchmarks). */
  lastStats(): NativeRenderStats | null;
  close(): Promise<void>;
}

interface Chunk {
  key: string;
  /** Global frames, ascending. */
  frames: number[];
  file: string;
  meta: string;
}

interface PageHandle {
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  errors: string[];
  width: number;
  height: number;
  scale: number;
}

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');

export function createNativeRenderer(opts: NativeRendererOptions): NativeRenderer {
  const log = opts.log ?? ((m: string) => console.log(`[engine] ${m}`));
  const rootDir = resolvePath(opts.rootDir);
  const publicDir = opts.publicDir ?? join(rootDir, 'public');
  const cacheDir = opts.cacheDir ?? join(rootDir, '.engine-cache');
  const assetBaseUrl = `http://localhost:${opts.serverPort}/`;
  const workers = Math.max(1, Number(process.env.MGE_ENGINE_WORKERS) || opts.workers || Math.max(2, Math.min(8, Math.floor(availableParallelism() * 0.6))));
  const useCache = opts.cache ?? process.env.MGE_ENGINE_CACHE !== '0';
  let bundle: Promise<{ dir: string; hash: string }> | null = null;
  /** invalidateBundle(): rebuild the page on the next job even if a build of these sources exists. */
  let forceRebuild = false;
  let server: Promise<StaticServer> | null = null;
  let bundleOrigin: string | null = null;
  /** One browser per device scale factor (a browser-wide flag). */
  const browsers = new Map<number, Promise<Browser>>();
  let idleTimer: NodeJS.Timeout | null = null;
  let active = 0;
  let stats: NativeRenderStats | null = null;
  const warm: PageHandle[] = [];
  const fileHashes = new Map<string, { size: number; mtime: number; hash: string }>();

  const getServer = () => {
    server ??= startStaticServer().then((s) => {
      bundleOrigin = s.url;
      s.mount('frames', join(cacheDir, 'frames'));
      return s;
    });
    return server;
  };
  const getBundle = async () => {
    // Re-hash the sources every job (cheap): an edit to the composition rebuilds the page.
    const current = bundle ? await bundle : null;
    if (!current || forceRebuild || current.hash !== (await renderBundleHash(rootDir))) {
      bundle = buildRenderBundle(rootDir, log, forceRebuild);
      forceRebuild = false;
      bundle.catch(() => (bundle = null));
    }
    const b = await bundle!;
    (await getServer()).mount(`b-${b.hash}`, b.dir);
    return b;
  };
  const getBrowser = (scale: number) => {
    let browser = browsers.get(scale);
    if (!browser) {
      const launching = launchBrowser(rootDir, scale);
      browser = launching;
      browsers.set(scale, launching);
      const forget = () => browsers.get(scale) === launching && browsers.delete(scale);
      launching.then((b) => b.on('disconnected', forget), forget);
    }
    return browser;
  };

  /** Hold the browser while working; close it after a quiet minute. */
  const hold = () => {
    active++;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    return () => {
      active--;
      if (active > 0) return;
      idleTimer = setTimeout(() => void shutdown(), 60_000);
      idleTimer.unref();
    };
  };
  const shutdown = async () => {
    const all = [...browsers.values()];
    browsers.clear();
    warm.splice(0);
    await Promise.all(all.map(async (b) => (await b.catch(() => null))?.close().catch(() => undefined)));
  };

  const openPage = async (width: number, height: number, scale: number, transparent: boolean): Promise<PageHandle> => {
    const [b, { hash }, s] = await Promise.all([getBrowser(scale), getBundle(), getServer()]);
    const context = await b.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
    });
    const cdp = await context.newCDPSession(page);
    // Render at the output size (crisp, not resampled): Playwright ignores a fractional deviceScaleFactor.
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    if (transparent) await cdp.send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await page.goto(`${s.url}/b-${hash}/render.html`);
    await page.waitForFunction(() => window.__mgeReady === true, undefined, { timeout: 30_000 });
    return { context, page, cdp, errors, width, height, scale };
  };

  const pageError = (h: PageHandle, err: unknown) => {
    const message = err instanceof Error ? err.message.replace(/^page\.evaluate: /, '').split('\n')[0] : String(err);
    return new Error(h.errors.length ? `${message} (${h.errors.slice(-2).join(' | ')})` : message);
  };

  const load = async (h: PageHandle, input: RenderInput) => {
    try {
      return await h.page.evaluate((i) => window.__mge!.load(i), input);
    } catch (err) {
      throw pageError(h, err);
    }
  };
  const seek = async (h: PageHandle, frame: number): Promise<FrameMedia> => {
    try {
      return await h.page.evaluate((f) => window.__mge!.seek(f), frame);
    } catch (err) {
      throw pageError(h, err);
    }
  };
  const capture = async (h: PageHandle, format: 'png' | 'jpeg', quality = JPEG_QUALITY): Promise<Buffer> => {
    const { data } = await h.cdp.send('Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality } : {}),
      clip: { x: 0, y: 0, width: h.width, height: h.height, scale: 1 },
      optimizeForSpeed: true,
      fromSurface: true,
      captureBeyondViewport: false,
    });
    return Buffer.from(data, 'base64');
  };

  // --- assets -------------------------------------------------------------

  /** Local file behind an asset src, when it is one of ours. */
  const localPath = (src: string): string | null => {
    if (/^[a-z]+:/i.test(src)) return null;
    const rel = src.replace(/^\/+/, '');
    const path = rel.startsWith('renders/') ? join(rootDir, rel) : join(publicDir, rel);
    return path.startsWith(rootDir) ? path : null;
  };
  const fileHash = async (path: string): Promise<string | null> => {
    const s = await stat(path).catch(() => null);
    if (!s?.isFile()) return null;
    const memo = fileHashes.get(path);
    if (memo && memo.size === s.size && memo.mtime === s.mtimeMs) return memo.hash;
    const hash = await new Promise<string>((res, rej) => {
      const h = createHash('sha256');
      createReadStream(path).on('data', (d) => h.update(d)).on('error', rej).on('end', () => res(h.digest('hex')));
    });
    fileHashes.set(path, { size: s.size, mtime: s.mtimeMs, hash });
    return hash;
  };
  /** Asset identity for cache keys: what the file holds, not where this job froze it. */
  const assetIdentity = async (project: Project, known?: Record<string, string | null>) => {
    const out: Record<string, unknown> = {};
    for (const asset of Object.values(project.assets)) {
      const { src, proxySrc, ...rest } = asset;
      void proxySrc;
      const path = localPath(src);
      out[asset.id] = { ...rest, content: known?.[asset.id] ?? (path ? await fileHash(path) : null) ?? src };
    }
    return out;
  };

  /** Decode every video file the project's video elements use; returns the page's frame index. */
  const prepareVideos = async (project: Project, signal?: AbortSignal): Promise<Record<string, VideoFrameIndex>> => {
    const used = new Set<string>();
    const visit = (els: Element[]) => els.forEach((el) => el.type === 'video' && typeof el.props.assetId === 'string' && used.add(el.props.assetId));
    project.scenes.forEach((s) => visit(s.elements));
    Object.values(project.compositions).forEach((c) => visit(c.elements));
    const assets = [...used].map((id) => project.assets[id]).filter((a): a is Asset => !!a && a.kind === 'video');
    if (!assets.length) return {};
    const s = await getServer();
    const index: Record<string, VideoFrameIndex> = {};
    await Promise.all(
      assets.map(async (asset) => {
        const path = localPath(asset.src);
        const input = path ?? resolveAssetUrl(assetBaseUrl, asset.src);
        const key = sha(`${(path && (await fileHash(path))) || asset.src}`).slice(0, 24);
        const started = Date.now();
        const decoded = await decodeVideoFrames(input, join(cacheDir, 'frames'), key, signal);
        if (Date.now() - started > 1000) log(`decoded ${decoded.pts.length} frames of ${asset.name} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
        index[resolveAssetUrl(assetBaseUrl, asset.src)] = { urlPrefix: `${s.url}/frames/${key}/`, ext: decoded.ext, pts: decoded.pts };
      }),
    );
    return index;
  };

  // --- video --------------------------------------------------------------

  /**
   * What a video renders: the page input, its cacheable spans (a project's
   * scenes; one span for a standalone composition) and what else can change
   * its pixels.
   */
  interface VideoTarget {
    input: RenderInput;
    spans: { key: string; start: number; length: number }[];
    identity: unknown;
  }

  const projectTarget = async (project: Project, assetHashes: Record<string, string | null> | undefined, signal?: AbortSignal): Promise<VideoTarget> => {
    const total = Math.max(1, projectDurationInFrames(project));
    const [videoFrames, assets] = await Promise.all([prepareVideos(project, signal), assetIdentity(project, assetHashes)]);
    const starts = sceneStartFrames(project);
    return {
      input: { composition: 'main', props: { project, assetBaseUrl } satisfies MainCompositionProps, width: project.width, height: project.height, fps: project.fps, durationInFrames: total, videoFrames },
      spans: project.scenes.flatMap((scene, i) => (scene.durationInFrames > 0 ? [{ key: sha(canonicalJson(scene)), start: starts[i], length: scene.durationInFrames }] : [])),
      identity: { bg: project.backgroundColor, assets, compositions: project.compositions },
    };
  };

  interface VideoJob {
    target: VideoTarget;
    codec: EngineCodec;
    crf?: number;
    scale: number;
    everyNthFrame: number;
    muted: boolean;
    outputPath: string;
    signal?: AbortSignal;
    onProgress?: (u: RenderProgressUpdate) => void;
    onCompositionHash?: (hash: string) => Promise<void> | void;
  }

  const renderVideo = async (job: VideoJob): Promise<void> => {
    const { target, codec, scale, everyNthFrame: n, signal } = job;
    const { input } = target;
    const release = hold();
    const started = Date.now();
    const pages: PageHandle[] = [];
    const work = join(tmpdir(), `mge-engine-${process.pid}-${Date.now().toString(36)}`);
    try {
      job.onProgress?.({ stage: 'bundling', progress: 0 });
      const b = await getBundle();
      await job.onCompositionHash?.(b.hash);
      signal?.throwIfAborted();
      // H.264 needs even dimensions: shave the composition.
      let width = input.width;
      let height = input.height;
      if (codec === 'h264') {
        while (Math.round(width * scale) % 2 !== 0) width--;
        while (Math.round(height * scale) % 2 !== 0) height--;
      }
      const spec: EncodeSpec = { codec, fps: input.fps / n, crf: job.crf };
      const format = frameFormat(codec);
      const total = input.durationInFrames;

      // Plan chunks.
      const shared = sha(canonicalJson({ v: 5, code: b.hash, gpu: process.env.MGE_ENGINE_GPU === '1', spec, format, quality: JPEG_QUALITY, width, height, scale, n, composition: input.composition, fps: input.fps, w: input.width, h: input.height, identity: target.identity }));
      const chunkDir = join(cacheDir, 'chunks');
      await mkdir(chunkDir, { recursive: true });
      const chunks: Chunk[] = [];
      for (const span of target.spans) {
        for (let a = 0; a < span.length; a += CHUNK_FRAMES) {
          const b2 = Math.min(span.length, a + CHUNK_FRAMES);
          const frames: number[] = [];
          for (let f = span.start + a; f < span.start + b2 && f < total; f++) if (f % n === 0) frames.push(f);
          if (!frames.length) continue;
          const key = sha(`${shared}:${span.key}:${a}-${b2}:${(span.start + a) % n}`).slice(0, 32);
          chunks.push({ key, frames, file: join(chunkDir, `${key}.${chunkExtension(codec)}`), meta: join(chunkDir, `${key}.json`) });
        }
      }
      const outputFrames = chunks.reduce((s, c) => s + c.frames.length, 0);

      // Cached chunks (and their media reports).
      const media = new Map<number, FrameMedia>();
      const todo: Chunk[] = [];
      for (const c of chunks) {
        const meta = useCache ? await readFile(c.meta, 'utf8').then((t) => JSON.parse(t) as Record<string, FrameMedia>, () => null) : null;
        const ok = meta && (await stat(c.file).then((s) => s.size > 0, () => false));
        if (!ok) {
          todo.push(c);
          continue;
        }
        for (const [f, m] of Object.entries(meta)) media.set(Number(f), m);
        const now = new Date();
        await utimes(c.file, now, now).catch(() => undefined);
      }
      let rendered = outputFrames - todo.reduce((s, c) => s + c.frames.length, 0);
      const progress = (stage: RenderProgressUpdate['stage'], share: number) =>
        job.onProgress?.({ stage, progress: Math.min(0.97, 0.05 + 0.9 * share), renderedFrames: rendered, encodedFrames: rendered });
      progress('rendering', rendered / outputFrames);

      let planned: PlannedAudio[] | null = null;
      const queue = [...todo];
      // Every job with sound needs the declared sounds, even when all of its chunks were cached.
      const pageCount = todo.length ? Math.min(workers, todo.length) : job.muted ? 0 : 1;
      await mkdir(work, { recursive: true });
      // MGE_ENGINE_PROFILE=1 logs where the time goes.
      const profile = process.env.MGE_ENGINE_PROFILE === '1' ? { seek: 0, capture: 0, write: 0, n: 0 } : null;
      const mark = (label: string) => profile && log(`${label} at ${((Date.now() - started) / 1000).toFixed(2)}s`);
      const worker = async () => {
        const h = await openPage(width, height, scale, codec === 'prores');
        pages.push(h);
        const loaded = await load(h, input);
        planned ??= loaded.audio;
        mark('page ready');
        for (let c = queue.shift(); c; c = queue.shift()) {
          signal?.throwIfAborted();
          const tmp = join(work, `${c.key}.${chunkExtension(codec)}`);
          const enc = chunkEncoder(spec, tmp, signal);
          const reports: Record<string, FrameMedia> = {};
          try {
            for (const f of c.frames) {
              signal?.throwIfAborted();
              const t0 = performance.now();
              const m = await seek(h, f);
              const t1 = performance.now();
              if (m.videos.length) reports[f] = m;
              const img = await capture(h, format);
              const t2 = performance.now();
              await enc.write(img);
              if (profile) {
                profile.seek += t1 - t0;
                profile.capture += t2 - t1;
                profile.write += performance.now() - t2;
                profile.n++;
              }
              rendered++;
              progress('rendering', rendered / outputFrames);
            }
            await enc.finish();
          } catch (err) {
            enc.kill();
            throw err;
          }
          await rename(tmp, c.file).catch(async () => {
            await writeFile(c.file, await readFile(tmp));
          });
          await writeFile(c.meta, JSON.stringify(reports));
          for (const [f, m] of Object.entries(reports)) media.set(Number(f), m);
        }
      };
      mark('pages start');
      await Promise.all(Array.from({ length: pageCount }, worker));
      if (profile?.n) log(`per frame: seek ${(profile.seek / profile.n).toFixed(1)}ms capture ${(profile.capture / profile.n).toFixed(1)}ms write ${(profile.write / profile.n).toFixed(1)}ms`);
      signal?.throwIfAborted();

      mark('frames done');
      progress('encoding', 1);
      let audio: string | null = null;
      if (!job.muted && codec !== 'gif') {
        audio = join(work, 'audio.wav');
        const videos = videoSegments(media, input.fps);
        await mixAudio({ planned: planned ?? [], videos, fps: input.fps, totalFrames: total, out: audio, signal, resolve: (src) => toLocal(src) });
      }
      mark('audio mixed');
      await assemble({ codec, chunks: chunks.map((c) => c.file), listPath: join(work, 'chunks.txt'), audio, out: job.outputPath, signal });
      stats = { chunks: chunks.length, cachedChunks: chunks.length - todo.length, frames: outputFrames, renderedFrames: todo.reduce((s, c) => s + c.frames.length, 0), seconds: (Date.now() - started) / 1000 };
      log(`${job.outputPath}: ${stats.frames} frames, ${stats.cachedChunks}/${stats.chunks} chunks cached, ${pageCount} page(s), ${stats.seconds.toFixed(1)}s`);
      job.onProgress?.({ stage: 'encoding', progress: 1, renderedFrames: outputFrames, encodedFrames: outputFrames });
    } finally {
      await Promise.all(pages.map((p) => p.context.close().catch(() => undefined)));
      await rm(work, { recursive: true, force: true });
      release();
      void pruneCache(join(cacheDir, 'chunks'));
    }
  };

  /** A page URL back to the file it serves, so ffmpeg reads the disk instead of HTTP. */
  const toLocal = (src: string): string => {
    if (!src.startsWith(assetBaseUrl)) return src;
    const path = localPath(decodeURIComponent(src.slice(assetBaseUrl.length)));
    return path ?? src;
  };

  const render: Renderer = async ({ project, outputPath, onProgress, signal, onCompositionHash, preset = 'mp4-1080', assetHashes }) => {
    const settings = deliverySettings(preset as DeliveryPreset, project.height);
    const target = await projectTarget(project, assetHashes, signal);
    await renderVideo({ target, codec: settings.codec, scale: settings.scale, everyNthFrame: settings.everyNthFrame, muted: settings.codec === 'gif', outputPath, signal, onProgress, onCompositionHash });
  };

  // --- stills ---------------------------------------------------------------

  /** A page for one-off images: reuse an idle one of the same size. */
  const stillPage = async (width: number, height: number, scale: number) => {
    const i = warm.findIndex((h) => h.width === width && h.height === height && h.scale === scale && !h.page.isClosed());
    if (i >= 0) return warm.splice(i, 1)[0];
    return openPage(width, height, scale, false);
  };
  const putBack = (h: PageHandle) => {
    warm.push(h);
    while (warm.length > 3) void warm.shift()!.context.close().catch(() => undefined);
  };

  const image = async (args: { input: RenderInput; frame: number; scale: number; format: 'png' | 'jpeg'; quality?: number; outputPath: string; signal?: AbortSignal; onCompositionHash?: (hash: string) => Promise<void> | void }) => {
    const release = hold();
    let h: PageHandle | null = null;
    let ok = false;
    try {
      args.signal?.throwIfAborted();
      const b = await getBundle();
      await args.onCompositionHash?.(b.hash);
      h = await stillPage(args.input.width, args.input.height, args.scale);
      h.errors.length = 0;
      await load(h, args.input);
      await seek(h, args.frame);
      args.signal?.throwIfAborted();
      await writeFile(args.outputPath, await capture(h, args.format, args.quality ?? 80));
      ok = true;
    } finally {
      if (h) {
        if (ok) putBack(h);
        else void h.context.close().catch(() => undefined);
      }
      release();
    }
  };

  return {
    render,
    async renderStill({ project, frame, scale, outputPath, signal, imageFormat = 'png', jpegQuality, onCompositionHash }) {
      const videoFrames = await prepareVideos(project, signal);
      const input: RenderInput = { composition: 'main', props: { project, assetBaseUrl }, width: project.width, height: project.height, fps: project.fps, durationInFrames: Math.max(1, projectDurationInFrames(project)), videoFrames };
      await image({ input, frame, scale, format: imageFormat, quality: jpegQuality, outputPath, signal, onCompositionHash });
    },
    async renderContactSheet({ project, frames, columns, scale, labels = true, outputPath, signal, onCompositionHash }) {
      const props: ContactSheetProps = { project, assetBaseUrl, frames, columns, labels, scale };
      const { width, height } = contactSheetLayout(props);
      const videoFrames = await prepareVideos(project, signal);
      const input: RenderInput = { composition: 'contact-sheet', props, width, height, fps: project.fps, durationInFrames: 1, videoFrames };
      await image({ input, frame: 0, scale: 1, format: 'png', outputPath, signal, onCompositionHash });
    },
    async renderPreview({ project, scale, outputPath, crf = 30 }) {
      await renderVideo({ target: await projectTarget(project, undefined), codec: 'h264', crf, scale, everyNthFrame: 1, muted: true, outputPath });
    },
    async renderComposition({ input, preset = 'mp4-1080', crf, outputPath, signal, onProgress }) {
      const settings = deliverySettings(preset, input.height);
      const target: VideoTarget = { input, spans: [{ key: sha(canonicalJson(input.props)), start: 0, length: input.durationInFrames }], identity: null };
      await renderVideo({ target, codec: settings.codec, crf, scale: settings.scale, everyNthFrame: settings.everyNthFrame, muted: settings.codec === 'gif', outputPath, signal, onProgress });
    },
    invalidateBundle() {
      bundle = null;
      forceRebuild = true;
    },
    origins: () => bundleOrigin ? [bundleOrigin] : [],
    lastStats: () => stats,
    async close() {
      if (idleTimer) clearTimeout(idleTimer);
      await shutdown();
      const s = await server?.catch(() => null);
      server = null;
      bundleOrigin = null;
      await s?.close();
    },
  };
}

/** Keep the chunk cache under CACHE_BYTES, dropping the least recently used chunks. */
async function pruneCache(dir: string): Promise<void> {
  try {
    const files = await Promise.all(
      (await readdir(dir)).filter((f) => !f.endsWith('.json')).map(async (f) => ({ f, s: await stat(join(dir, f)) })),
    );
    let total = files.reduce((n, x) => n + x.s.size, 0);
    for (const { f, s } of files.sort((a, b) => a.s.mtimeMs - b.s.mtimeMs)) {
      if (total <= CACHE_BYTES) break;
      total -= s.size;
      await rm(join(dir, f), { force: true });
      await rm(join(dir, f.replace(/\.[^.]+$/, '.json')), { force: true });
    }
  } catch {
    /* nothing cached yet */
  }
}
