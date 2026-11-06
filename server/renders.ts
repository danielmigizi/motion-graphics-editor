// Serial render queue with durable snapshots, identities and terminal states.
import { constants } from 'node:fs';
import { copyFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { DeliveryPreset, RenderJob, RenderManifest } from '../src/core/api-contract';
import type { Project } from '../src/core/types';
import { deliverySettings } from '../src/core/delivery';
import { formatCreditsFile, projectAudioCredits } from '../src/core/credits';
import { projectDurationInFrames } from '../src/core/timing';
import { buildManifest, verifyManifest } from './manifest';
import { writeFileAtomic } from './projects';

export interface RenderProgressUpdate {
  stage: 'bundling' | 'rendering' | 'encoding';
  progress: number;
  renderedFrames?: number;
  encodedFrames?: number;
}
export interface RendererArgs {
  jobId: string;
  preset?: DeliveryPreset;
  project: Project;
  outputPath: string;
  onProgress: (update: RenderProgressUpdate) => void;
  signal: AbortSignal;
  /** Identity captured when the renderer's bundle was built. */
  onCompositionHash?: (hash: string) => Promise<void> | void;
  /** sha256 of each asset's file (from the manifest), so renderers can cache by content. */
  assetHashes?: Record<string, string | null>;
}
export type Renderer = (args: RendererArgs) => Promise<void>;
export interface RenderManagerOptions {
  rendersDir: string;
  renderer: Renderer;
  rootDir?: string;
  publicDir?: string;
  describeError?: (err: unknown) => string;
}
export interface StartOptions {
  preset?: DeliveryPreset;
  simulateFailureAtProgress?: number;
  retryOf?: string;
}
export class RenderConflictError extends Error {}
const terminal = (job: RenderJob) => ['done', 'failed', 'cancelled', 'interrupted'].includes(job.status);
const clamp01 = (n: number) => Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
export function defaultDescribeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const first = raw.split('\n').map((line) => line.trim()).find(Boolean) ?? 'Unknown error';
  return first.length > 300 ? `${first.slice(0, 297)}...` : first;
}

export class RenderManager {
  private jobs = new Map<string, RenderJob>();
  private snapshots = new Map<string, Project>();
  private queue: { id: string; simulateAt?: number }[] = [];
  private running: string | null = null;
  private controllers = new Map<string, AbortController>();
  private completions = new Map<string, Promise<void>>();
  private writes = new Map<string, Promise<void>>();
  private lastWrite = new Map<string, number>();
  private idleWaiters: (() => void)[] = [];
  private rootDir: string;
  private publicDir: string;

  constructor(private opts: RenderManagerOptions) {
    this.rootDir = opts.rootDir ?? process.cwd();
    this.publicDir = opts.publicDir ?? join(this.rootDir, 'public');
  }

  /** Load only records; a restart never resumes or completes an unfinished export. */
  async load(): Promise<void> {
    await mkdir(this.opts.rendersDir, { recursive: true });
    const records: RenderJob[] = [];
    for (const name of await readdir(this.opts.rendersDir)) {
      if (!/^[A-Za-z0-9_-]+\.job\.json$/.test(name)) continue;
      try {
        const job = JSON.parse(await readFile(join(this.opts.rendersDir, name), 'utf8')) as RenderJob;
        if (`${job.id}.job.json` !== name || !job.createdAt || !job.status) continue;
        records.push(job);
      } catch { /* Ignore a malformed record without discarding other jobs. */ }
    }
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    // Prune records only; snapshots, manifests and video files remain available.
    for (const job of records.slice(50)) await unlink(join(this.opts.rendersDir, `${job.id}.job.json`));
    for (const job of records.slice(0, 50)) {
      this.jobs.set(job.id, job);
      if (!terminal(job)) {
        await this.update(job.id, { status: 'interrupted', error: 'The server stopped before this render finished.', finishedAt: new Date().toISOString() });
      } else if (job.status === 'done') {
        const exists = await stat(join(this.opts.rendersDir, `${job.id}.${deliverySettings(job.preset, 1080).extension}`)).then((s) => s.isFile(), () => false);
        if (!exists) await this.update(job.id, { status: 'failed', error: 'Output file is missing', outputPath: undefined, outputUrl: undefined, finishedAt: new Date().toISOString() });
      }
    }
  }

  list(): RenderJob[] {
    return [...this.jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map((job) => ({ ...job }));
  }
  get(id: string): RenderJob | undefined {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }
  async getSnapshot(id: string): Promise<Project | undefined> {
    if (!this.jobs.has(id)) return undefined;
    const mem = this.snapshots.get(id);
    if (mem) return structuredClone(mem);
    try {
      return JSON.parse(await readFile(join(this.opts.rendersDir, `${id}.json`), 'utf8')) as Project;
    } catch { return undefined; }
  }
  async getManifest(id: string, verify = false): Promise<RenderManifest | { manifest: RenderManifest; changedAssets: string[] } | undefined> {
    if (!this.jobs.has(id)) return undefined;
    let manifest: RenderManifest;
    try {
      manifest = JSON.parse(await readFile(join(this.opts.rendersDir, `${id}.manifest.json`), 'utf8'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw err;
    }
    return verify ? { manifest, changedAssets: await verifyManifest(manifest, this.publicDir) } : manifest;
  }

  async start(project: Project, options: StartOptions = {}): Promise<RenderJob> {
    deliverySettings(options.preset, project.height);
    const id = `r_${randomBytes(5).toString('hex')}`;
    const snapshot = structuredClone(project);
    await mkdir(this.opts.rendersDir, { recursive: true });
    await writeFileAtomic(join(this.opts.rendersDir, `${id}.json`), JSON.stringify(snapshot, null, 2));
    const job: RenderJob = {
      id, preset: options.preset ?? 'mp4-1080', projectId: snapshot.id, projectRevision: snapshot.revision, status: 'queued', progress: 0,
      renderedFrames: 0, encodedFrames: 0, totalFrames: Math.ceil(projectDurationInFrames(snapshot) / deliverySettings(options.preset, snapshot.height).everyNthFrame), createdAt: new Date().toISOString(),
      ...(options.retryOf ? { retryOf: options.retryOf } : {}),
      engine: 'native',
    };
    this.jobs.set(id, job);
    this.snapshots.set(id, snapshot);
    await this.update(id, {}, true);
    const simulateAt = typeof options.simulateFailureAtProgress === 'number' ? clamp01(options.simulateFailureAtProgress) : undefined;
    if (!terminal(this.jobs.get(id)!)) {
      this.queue.push({ id, simulateAt });
      queueMicrotask(() => this.pump());
    }
    return this.get(id)!;
  }

  async retry(id: string): Promise<RenderJob | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (!['failed', 'cancelled', 'interrupted'].includes(job.status)) throw new RenderConflictError(`Render job "${id}" is ${job.status}; only failed, cancelled or interrupted jobs can be retried.`);
    const snapshot = await this.getSnapshot(id);
    if (!snapshot) throw new RenderConflictError(`The recorded snapshot for render job "${id}" is missing.`);
    return this.start(snapshot, { retryOf: id, preset: job.preset });
  }

  async cancel(id: string): Promise<RenderJob | undefined> {
    const job = this.jobs.get(id);
    if (!job) return undefined;
    if (terminal(job)) throw new RenderConflictError(`Render job "${id}" is already ${job.status} and cannot be cancelled.`);
    this.queue = this.queue.filter((item) => item.id !== id);
    const saved = this.update(id, { status: 'cancelled', finishedAt: new Date().toISOString() });
    this.controllers.get(id)?.abort(new Error('Render cancelled'));
    await saved;
    // Wait for the renderer to release its output before removing the partial file.
    await this.completions.get(id);
    await unlink(join(this.opts.rendersDir, `${id}.${deliverySettings(this.jobs.get(id)!.preset, 1080).extension}`)).catch((err) => { if (err.code !== 'ENOENT') throw err; });
    this.pump();
    return this.get(id);
  }

  whenIdle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private update(id: string, patch: Partial<RenderJob>, force = false): Promise<void> {
    const previous = this.jobs.get(id)!;
    const job = { ...previous, ...patch };
    this.jobs.set(id, job);
    if (!force && previous.status === job.status && Date.now() - (this.lastWrite.get(id) ?? 0) < 1000) return this.writes.get(id) ?? Promise.resolve();
    this.lastWrite.set(id, Date.now());
    const json = JSON.stringify(job, null, 2);
    // Serialize writes so an earlier progress write cannot overwrite a terminal state.
    const write = (this.writes.get(id) ?? Promise.resolve()).catch(() => undefined).then(() => writeFileAtomic(join(this.opts.rendersDir, `${id}.job.json`), json));
    this.writes.set(id, write);
    return write;
  }

  private pump(): void {
    if (this.running) return;
    let next = this.queue.shift();
    while (next && terminal(this.jobs.get(next.id)!)) next = this.queue.shift();
    if (!next) {
      this.idleWaiters.splice(0).forEach((resolve) => resolve());
      return;
    }
    this.running = next.id;
    const completion = this.run(next.id, next.simulateAt).finally(() => {
      this.controllers.delete(next.id);
      this.completions.delete(next.id);
      this.running = null;
      this.pump();
    });
    this.completions.set(next.id, completion);
    completion.catch((err) => console.error('Could not persist render job:', err));
  }

  private async run(id: string, simulateAt: number | undefined): Promise<void> {
    const snapshot = this.snapshots.get(id)!;
    const outputPath = join(this.opts.rendersDir, `${id}.${deliverySettings(this.jobs.get(id)!.preset, 1080).extension}`);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    let simulatedError: string | null = null;
    let persistenceError: unknown;
    const onProgress = (update: RenderProgressUpdate) => {
      if (controller.signal.aborted || terminal(this.jobs.get(id)!)) return;
      const progress = clamp01(update.progress);
      const { stage, ...counts } = update;
      void this.update(id, { ...counts, status: stage, progress }).catch((err) => {
        persistenceError = err;
        controller.abort(err);
      });
      if (simulateAt !== undefined && progress > simulateAt) {
        simulatedError = `Simulated render failure at ${Math.round(progress * 100)}%`;
        controller.abort(new Error(simulatedError));
      }
    };
    try {
      await this.update(id, { status: 'bundling', progress: 0 });
      const preset = this.jobs.get(id)!.preset ?? 'mp4-1080';
      const captured = new Map<string, Buffer>();
      // Render a private copy referencing immutable files, while the recorded snapshot stays original.
      const renderProject = structuredClone(snapshot);
      const assetDir = join(this.opts.rendersDir, `${id}.assets`);
      await mkdir(assetDir, { recursive: true });
      const frozenName = new Map(Object.values(renderProject.assets).map((asset, index) => [asset.id, `${index}${extname(asset.src).replace(/[^.a-zA-Z0-9]/g, '')}`]));
      // Large files (videos) are copied, then hashed from the copy by streaming; small ones are captured in memory.
      const manifest = await buildManifest(snapshot, {
        publicDir: this.publicDir, rootDir: this.rootDir, captureAsset: (assetId, bytes) => captured.set(assetId, bytes),
        freezeLargeAsset: async (assetId, path) => {
          const target = join(assetDir, frozenName.get(assetId)!);
          await copyFile(path, target, constants.COPYFILE_FICLONE);
          return target;
        },
      });
      manifest.preset = preset;
      await writeFileAtomic(join(this.opts.rendersDir, `${id}.manifest.json`), JSON.stringify(manifest, null, 2));
      for (const asset of Object.values(renderProject.assets)) {
        const name = frozenName.get(asset.id)!;
        const bytes = captured.get(asset.id);
        if (bytes) await writeFile(join(assetDir, name), bytes);
        asset.src = `renders/${id}.assets/${name}`;
        // Exports always read the original file, never a preview proxy.
        delete asset.proxySrc;
      }
      await this.update(id, { manifestUrl: `/renders/${id}.manifest.json`, projectHash: manifest.projectHash, rendererVersion: manifest.renderer.version }, true);
      controller.signal.throwIfAborted();
      const assetHashes = Object.fromEntries(manifest.assets.map((a) => [a.id, a.sha256]));
      await this.opts.renderer({ jobId: id, preset, project: renderProject, outputPath, onProgress, signal: controller.signal, assetHashes,
        onCompositionHash: async hash => {
          manifest.code.compositionHash = hash;
          await writeFileAtomic(join(this.opts.rendersDir, `${id}.manifest.json`), JSON.stringify(manifest, null, 2));
        },
      });
      controller.signal.throwIfAborted();
      if (persistenceError) throw persistenceError;
      const job = this.jobs.get(id)!;
      const credits = projectAudioCredits(snapshot);
      if (credits.lines.length || credits.madeWithOpenverse) {
        await writeFile(join(this.opts.rendersDir, `${id}.credits.txt`), formatCreditsFile(credits));
      }
      await this.update(id, { status: 'done', progress: 1, renderedFrames: job.totalFrames, encodedFrames: job.totalFrames, outputUrl: `/renders/${id}.${deliverySettings(preset, snapshot.height).extension}`, outputPath, finishedAt: new Date().toISOString() });
    } catch (err) {
      await unlink(outputPath).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      if (this.jobs.get(id)!.status !== 'cancelled') {
        await this.update(id, { status: 'failed', error: simulatedError ?? (this.opts.describeError ?? defaultDescribeError)(err), finishedAt: new Date().toISOString() });
      }
    } finally {
      await this.writes.get(id);
    }
  }
}
