// Local generation admission, permissions, fal queue requests and imported takes.

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { GenerationAsk, GenerationEntryKind } from '../../src/core/generation';
import { bodyEstimates, bodySceneIds, estimate, extractOutputs, falInputs, JOBS, MODELS, modelsResponse, normalizeSettings, ROUTE_VERSION, requiredMedia, route, validateRequest, videoDuration, type RouteContext } from '../../src/core/generationRoutes';
import { formatUsd, type FrameSource, type FalKeyStatus, type GenerateRequest, type GenerationJob, type GenerationModelsResponse, type GenerationQuote, type GenerationSettings, type GenerationScoreboard, type GenerationStatus, type OutcomeReport } from '../../src/core/generationStudio';
import { scoreboard } from '../../src/core/generationScores';
import { cutAlignment } from '../../src/core/scorePlan';
import { beatsFor } from '../beats';
import { parseWords } from './timestamps';
import { newId } from '../../src/core/ids';
import { takeUsage } from '../../src/core/takeUsage';
import { projectDurationInFrames } from '../../src/core/timing';
import type { Asset, CommandError, Project } from '../../src/core/types';
import type { AppDeps } from '../app';
import { resolvePublicPath } from '../assets';
import { localDay, type GenerationLog } from '../generation-log';
import { importFromUrl, type ImportOptions } from '../url-import';
import { checkKeyShape, SettingsError, writePrivate, type GenerationSettingsStore, type KeyStore } from './config';
import { createFalClient, FalError, type FalClient, type FalQueueHandle } from './fal';
import { type GenerationRecord, type GenerationRecords, type RequestCost } from './records';

/** HTTP-safe admission refusal with a structured editor error. */
export class GenerationRefusal extends Error {
  constructor(readonly status: number, readonly error: CommandError) {
    super(error.message);
    this.name = 'GenerationRefusal';
  }
}

/** Local generation API, including recent and resumable jobs from prior runs. */
export interface GenerationService {
  init(): Promise<void>;
  status(): Promise<GenerationStatus>;
  models(): Promise<GenerationModelsResponse>;
  scoreboard(): Promise<GenerationScoreboard>;
  dismissSuggestion(job: unknown, model: unknown): Promise<GenerationScoreboard>;
  setRouteOverride(job: unknown, model: unknown): Promise<GenerationScoreboard>;
  quote(req: GenerateRequest): Promise<GenerationQuote>;
  create(raw: unknown, who: { origin: 'user' | 'agent'; agent?: string; confirmed?: boolean }, signal?: AbortSignal): Promise<GenerationJob>;
  list(projectId?: string): GenerationJob[];
  get(id: string): GenerationJob | undefined;
  cancel(id: string): Promise<GenerationJob | undefined>;
  delivered(id: string): Promise<GenerationJob | undefined>;
  outcome(r: OutcomeReport): Promise<boolean>;
  thumbs(jobIds: string[]): Promise<Record<string, 1 | -1>>;
  markKept(project: Project): Promise<void>;
  updateSettings(patch: unknown): Promise<GenerationSettings>;
  setKey(raw: unknown): Promise<FalKeyStatus>;
  testKey(): Promise<FalKeyStatus>;
  removeKey(): Promise<FalKeyStatus>;
  checkEndpoints(): Promise<void>;
}

const cachedStores = new WeakMap<KeyStore, KeyStore>();

/** Share one private credential lookup; saving/removing invalidates the cache. */
export function cachedGenerationKeys(store: KeyStore): KeyStore {
  const prior = cachedStores.get(store);
  if (prior) return prior;
  let cached: ReturnType<KeyStore['get']> | undefined;
  const get: KeyStore['get'] = () => cached ??= store.get().catch((err) => { cached = undefined; throw err; });
  const wrapper: KeyStore = {
    get,
    async status() {
      const key = await get();
      return key ? { configured: true, source: key.source, last4: key.key.slice(-4) } : { configured: false };
    },
    async set(key) { try { return await store.set(key); } finally { cached = undefined; } },
    async remove() { try { await store.remove(); } finally { cached = undefined; } },
  };
  cachedStores.set(store, wrapper);
  cachedStores.set(wrapper, wrapper);
  return wrapper;
}

type Checks = GenerationRecord['checks'];
interface Runtime {
  job: GenerationJob;
  req: GenerateRequest;
  ctx: RouteContext;
  project: Project | null;
  /** Only scene timing, persisted for scored-bed recovery; no project content. */
  scoreProject?: Project;
  controller: AbortController;
  handles: Set<FalQueueHandle>;
  remaining: number;
  requests: (RequestCost & { handle?: FalQueueHandle; lastStatus?: string; completed?: boolean; importedCount?: number })[];
  firstSubmittedAt?: number;
  errors: NonNullable<GenerationJob['error']>[];
  references?: Promise<{ referenceUrls: string[]; maskUrl?: string; referenceVideoUrls: string[]; startUrl?: string; endUrl?: string; keyframeUrls: string[] }>;
  resolvedReferences?: Awaited<NonNullable<Runtime['references']>>;
  checks: Checks;
  timer?: ReturnType<typeof setTimeout>;
  stopping?: Promise<void>;
  delivery?: Promise<GenerationJob>;
}

const active = (job: GenerationJob) => ['awaiting-permission', 'queued', 'running', 'importing'].includes(job.status);
const shortLabels: Record<GenerateRequest['job'], string> = {
  'music.scored': 'Scored music bed', 'music.bed': 'Music bed', 'voice.line': 'Voice-over', 'voice.narration': 'Narration',
  'sfx.hit': 'Sound effect', 'sfx.ambience': 'Ambience', 'image.generate': 'Image',
  'image.cutout': 'Cutout', 'image.typography': 'Text image', 'image.plate': 'Background',
  'image.edit': 'Image edit', 'image.composite': 'Composite',
  'video.generate': 'Video', 'video.animate': 'Animated still', 'video.between': 'Between frames',
  'video.keyframes': 'Keyframe video', 'video.reference': 'Reference video', 'video.long': 'Long video',
};
const copy = <T>(value: T): T => structuredClone(value);
const timingProject = (project: Project): Project => ({
  schemaVersion: project.schemaVersion, id: project.id, name: '', revision: project.revision,
  fps: project.fps, width: project.width, height: project.height, backgroundColor: '',
  assets: {}, audio: [], compositions: {}, markers: [],
  scenes: project.scenes.map(({ id, durationInFrames }) => ({ id, durationInFrames, name: '', backgroundColor: '',
    locked: false, transitionIn: { type: 'none', durationInFrames: 0 }, elements: [] })),
});
const refuse = (status: number, message: string, path?: string, code: CommandError['code'] = 'INVALID'): never => {
  throw new GenerationRefusal(status, { code, message, ...(path ? { path } : {}) });
};

/** Construct an injectable local scheduler; no provider traffic until requested. */
export function createGenerationService(deps: {
  fal: FalClient; keys: KeyStore; settings: GenerationSettingsStore; records: GenerationRecords; log?: GenerationLog;
  publicDir: string;
  configDir?: string;
  beats?: typeof beatsFor;
  renderStill?: AppDeps['renderStill'];
  requestProxy?: (src: string) => Promise<unknown>;
  emit: (job: GenerationJob) => void;
  project: () => Project | null;
  askPermission: (ask: { agent: string; action: string; generation: GenerationAsk }, signal?: AbortSignal) => Promise<'allowed' | 'denied' | 'timeout' | 'unavailable'>;
  importOptions?: Pick<ImportOptions, 'lookup' | 'connect' | 'probe'>;
  falFactory?: typeof createFalClient;
  now?: () => number; concurrency?: number; pollMs?: number; jobTimeoutMs?: number; queueTimeoutMs?: number; retryMs?: number;
}): GenerationService {
  const now = deps.now ?? Date.now;
  const keys = cachedGenerationKeys(deps.keys);
  const jobs = new Map<string, Runtime>();
  // Process-local evidence, distinct from the crash-safe attempted marker.
  const submittedRequests = new WeakSet<RequestCost>();
  const storageDir = deps.configDir ?? deps.records.dir;
  const jobsPath = join(storageDir, 'generation-jobs.json');
  let journalWrites: Promise<unknown> = Promise.resolve();
  type SavedRuntime = {
    job: GenerationJob; req: GenerateRequest; inputReq?: GenerateRequest; ctx: RouteContext; firstSubmittedAt?: number;
    scoreProject?: Project;
    resolvedReferences?: Runtime['resolvedReferences'];
    requests: Runtime['requests']; checks: Checks; errors: Runtime['errors'];
  };
  // Snapshot before queueing the write, so a later status cannot be overwritten by an older one.
  const saveJobs = (): Promise<void> => {
    const terminal = [...jobs.values()].filter((rt) => !active(rt.job) && (rt.job.finishedAt ?? rt.job.createdAt) >= now() - 86_400_000)
      .sort((a, b) => b.job.createdAt - a.job.createdAt).slice(0, 200);
    const keep = new Set(terminal);
    const rows: SavedRuntime[] = [...jobs.values()].filter((rt) => active(rt.job) || keep.has(rt)).map((rt) => ({
      job: rt.job, req: { ...rt.req, settings: rt.job.settings }, inputReq: rt.req, ctx: rt.ctx, firstSubmittedAt: rt.firstSubmittedAt,
      scoreProject: active(rt.job) ? rt.scoreProject : undefined,
      requests: rt.requests.map((request, takeIndex) => ({ ...request, takeIndex })), resolvedReferences: active(rt.job) ? rt.resolvedReferences : undefined, checks: rt.checks, errors: rt.errors,
    }));
    // No credentials, project content or provider result bodies belong in this journal.
    // Resolved media is retained while active so locally queued takes can resume without the editor.
    const serialized = JSON.stringify(rows, (_key, value: unknown) => {
      if (typeof value !== 'string') return value;
      for (const key of seenKeys) value = (value as string).split(key).join('[redacted]');
      return value;
    });
    const write = journalWrites.then(async () => {
      await mkdir(storageDir, { recursive: true, mode: 0o700 });
      const temp = `${jobsPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, `${serialized}\n`, { mode: 0o600, flag: 'wx' });
        await rename(temp, jobsPath);
      } finally { await rm(temp, { force: true }); }
    });
    journalWrites = write.catch(() => undefined);
    return write;
  };
  let admission: Promise<unknown> = Promise.resolve();
  let credentialChanges: Promise<unknown> = Promise.resolve();
  let keyTest: Partial<FalKeyStatus> = {};
  let secret = '';
  const seenKeys = new Set<string>();
  let keyRevision = 0;
  let availability: Record<string, boolean> = {};
  let prices: RouteContext['livePrices'] = {};
  const warned = new Set<string>();
  const tasks: { rt: Runtime; index: number }[] = [];
  let running = 0;
  let initialized: Promise<void> | undefined;
  let accountingDay = localDay(now());
  let committed = 0;
  const commitments = new Map<string, { day: string; usd: number }>();
  const billingResolved = new Set<string>();
  const billingTimers = new Map<string, { revision: number; timers: ReturnType<typeof setTimeout>[] }>();
  const rollover = () => {
    if (accountingDay === localDay(now())) return;
    accountingDay = localDay(now());
    committed = [...commitments.values()].reduce((sum, entry) => sum + (entry.day === accountingDay ? entry.usd : 0), 0);
  };
  const commit = (id: string, day: string, usd: number) => {
    rollover();
    const prior = commitments.get(id);
    if (prior?.day === accountingDay) committed -= prior.usd;
    commitments.set(id, { day, usd });
    if (day === accountingDay) committed += usd;
  };
  const liability = (requests: RequestCost[]) => requests.reduce((sum, request) => sum + (request.costUsd ?? request.estimateUsd), 0);
  const account = (rt: Runtime) => {
    const amount = liability(rt.requests);
    rt.job.billed = rt.job.billed === true ? true : rt.requests.every((request) => request.costUsd === 0) ? false : undefined;
    commit(rt.job.id, localDay(rt.job.createdAt), amount);
    return amount;
  };
  const concurrency = Math.max(1, Math.floor(deps.concurrency ?? 2));
  const redact = (s: string, candidate = secret) => (candidate ? s.split(candidate).join('[redacted]') : s).replace(/\bKey\s+[^\s"'<>]+/gi, '[redacted]').slice(0, 300);
  const readKey = async () => {
    const stored = await keys.get();
    secret = stored?.key ?? '';
    if (secret) seenKeys.add(secret);
    return stored;
  };
  let scoreCache: { value: GenerationScoreboard; version: number; at: number; overrides: string } | undefined;
  let scoreWrites: Promise<unknown> = Promise.resolve();
  const scores = (settings: GenerationSettings): Promise<GenerationScoreboard> => {
    const read = scoreWrites.then(async () => {
      const overrides = JSON.stringify([settings.routeOverrides, settings.dismissedSuggestions]);
      // Record changes coalesce for one minute; explicit settings changes apply immediately.
      if (scoreCache && scoreCache.overrides === overrides
        && (scoreCache.version === deps.records.version || now() - scoreCache.at < 60_000)) return copy(scoreCache.value);
      const version = deps.records.version;
      const rows = await deps.records.all();
      const value = scoreboard(rows, {
        overrides: settings.routeOverrides,
        dismissedSuggestions: settings.dismissedSuggestions,
        labelFor: (id) => MODELS[id]?.label ?? id,
        defaultFor: (job) => settings.routeOverrides[job] ?? JOBS[job].candidates[0],
      });
      try { await writePrivate(join(storageDir, 'generation-stats.json'), `${JSON.stringify(value, null, 2)}\n`); }
      catch {
        if (!warned.has('stats')) { warned.add('stats'); console.warn('Could not write generation-stats.json; generation will continue using in-memory scores.'); }
      }
      scoreCache = { value, version, at: now(), overrides };
      return copy(value);
    });
    scoreWrites = read.catch(() => undefined);
    return read;
  };
  const context = async (settings: GenerationSettings): Promise<RouteContext> => {
    const measured = await scores(settings);
    const project = deps.project();
    // Reference limits differ for images and clips, so the router needs each project asset's kind.
    let referenceAssetKinds: Record<string, 'image' | 'video'> | undefined;
    const referenceAssetSeconds: Record<string, number> = {};
    const referenceAssetFps: Record<string, number> = {};
    if (project) {
      referenceAssetKinds = {};
      for (const a of Object.values(project.assets)) {
        if (a.kind === 'video' || a.kind === 'image' || a.kind === 'svg') referenceAssetKinds[a.id] = a.kind === 'video' ? 'video' : 'image';
        if (a.kind === 'video') {
          referenceAssetSeconds[a.id] = (a.durationInFrames ?? NaN) / (a.fps ?? project.fps);
          if (a.fps !== undefined) referenceAssetFps[a.id] = a.fps;
        }
      }
    }
    return { routeOverrides: settings.routeOverrides, suggestions: measured.suggestions, now: now(), referenceAssetSeconds, referenceAssetFps, available: availability, livePrices: prices, gptImageReserveUsd: settings.gptImageReserveUsd,
      ...(project ? { project: { width: project.width, height: project.height, fps: project.fps, durationSeconds: projectDurationInFrames(project) / project.fps }, referenceAssetKinds } : {}) };
  };
  const reserved = () => [...jobs.values()].reduce((sum, rt) => sum + (active(rt.job) ? rt.job.estimate.usd : 0), 0);
  const log = async (kind: GenerationEntryKind, job: GenerationJob, title: string, reason?: string) => {
    try {
      await deps.log?.record({ kind, agent: job.requestedBy.agent ?? (job.requestedBy.origin === 'user' ? 'You' : 'Agent'), provider: 'fal', tool: 'editor_generate', title, ...(reason ? { reason } : {}) });
    } catch {
      if (!warned.has('log')) { warned.add('log'); console.warn('Could not write the generation log.'); }
    }
  };
  const emit = (job: GenerationJob) => deps.emit(copy(job));
  const persist = async (rt: Runtime) => {
    const job = copy(rt.job);
    const checks = copy(rt.checks);
    const requests = rt.requests.map(({ requestId, estimateUsd, attempted, costUsd }) => ({ requestId, estimateUsd, attempted, costUsd }));
    await saveJobs();
    await deps.records.update(job.id, (r) => {
      r.status = job.status;
      r.delivered = job.delivered;
      r.billed = job.billed;
      r.failure = job.error?.type;
      r.outputs = job.outputs.map((a) => a.id);
      r.checks = checks;
      r.actualUsd = job.actualUsd;
      r.costSource = job.billed === true ? 'billing' : 'estimate';
      r.requests = requests;
      r.liabilityUsd = active(job) ? undefined : liability(requests);
      if (job.startedAt !== undefined) r.queueMs = Math.max(0, job.startedAt - job.createdAt);
      if (job.finishedAt !== undefined) {
        r.queueMs ??= Math.max(0, job.finishedAt - job.createdAt);
        r.runMs = job.startedAt === undefined ? 0 : Math.max(0, job.finishedAt - job.startedAt);
      }
    });
  };
  const changed = (rt: Runtime) => { emit(rt.job); };

  const clearBilling = (id: string) => {
    for (const timer of billingTimers.get(id)?.timers ?? []) clearTimeout(timer);
    billingTimers.delete(id);
  };
  const reconcile = async (id: string, revision: number) => {
    if (revision !== keyRevision || keyTest.billing !== true) return;
    try {
      const record = await deps.records.get(id);
      if (!record?.requests?.some((r) => r.requestId)) return;
      const events = await deps.fal.billingEvents({ endpoints: [record.endpoint], start: new Date(record.at - 60_000), end: new Date(now()) });
      if (revision !== keyRevision) return;
      const costs = new Map<string, number>();
      for (const event of events) if (event.endpointId === record.endpoint) costs.set(event.requestId, (costs.get(event.requestId) ?? 0) + event.costUsd);
      let matched = false;
      // Use current runtime accounting if cancellation completed during the billing read.
      const rt = jobs.get(id);
      const requests = rt?.requests ?? record.requests;
      for (const request of requests) if (request.requestId && costs.has(request.requestId)) {
        request.costUsd = costs.get(request.requestId)!;
        matched = true;
      }
      if (matched) {
        const amount = liability(requests);
        commit(id, record.day, amount);
        if (rt) {
          rt.job.actualUsd = amount; rt.job.billed = true;
          await persist(rt); changed(rt);
        } else await deps.records.update(id, (r) => {
          r.requests = requests; r.actualUsd = amount; r.liabilityUsd = amount; r.billed = true; r.costSource = 'billing';
        });
      }
      if (requests.every((request) => request.costUsd !== undefined)) {
        billingResolved.add(id);
        clearBilling(id);
      }
    } catch (err) {
      if (err instanceof FalError && err.status === 403 && revision === keyRevision) keyTest.billing = false;
    }
  };
  const billing = (id: string) => {
    if (keyTest.billing !== true || billingResolved.has(id) || billingTimers.get(id)?.revision === keyRevision) return;
    clearBilling(id);
    const revision = keyRevision;
    const timers = [60_000, 300_000, 1_200_000].map((ms) => {
      const timer = setTimeout(() => { void reconcile(id, revision); }, ms);
      timer.unref();
      return timer;
    });
    billingTimers.set(id, { revision, timers });
  };
  const scheduleBilling = () => { for (const id of commitments.keys()) billing(id); };
  const discoverBilling = () => {
    void withCredentialChange(async () => {
      if (!await readKey()) return;
      const tested = await deps.fal.testKey();
      keyTest = { valid: tested.valid, billing: tested.billing, checkedAt: now() };
      scheduleBilling();
    }).catch(() => console.warn('Could not check fal billing access.'));
  };
  const finish = async (rt: Runtime, status: GenerationJob['status']) => {
    if (!active(rt.job)) return;
    // Reservation -> committed liability is one synchronous transition, before persistence.
    for (const request of rt.requests) if (!request.attempted || !submittedRequests.has(request)) request.costUsd = 0;
    rt.job.status = status;
    if ((status === 'done' || status === 'failed') && !rt.job.error && rt.errors.length) rt.job.error = copy(rt.errors[0]);
    account(rt);
    rt.job.finishedAt = now();
    delete rt.job.queuePosition;
    clearTimeout(rt.timer);
    if (rt.requests.some((r) => r.requestId)) billing(rt.job.id);
    await persist(rt).catch(() => console.warn('Could not save generation job status.'));
    if (status === 'done') await log('imported', rt.job, `Generated ${rt.job.outputs.length} takes: ${rt.job.outputs.map((a) => a.name).join(', ')}`);
    changed(rt);
  };
  const cancelRequest = async (rt: Runtime, request: Runtime['requests'][number]) => {
    if (!request.handle) return;
    const queued = request.lastStatus === 'IN_QUEUE';
    const accepted = await deps.fal.cancel(request.handle).catch(() => false);
    if (queued && accepted && request.costUsd === undefined) request.costUsd = 0;
    if (!active(rt.job)) {
      account(rt);
      await persist(rt);
      changed(rt);
    }
  };
  const stop = (rt: Runtime, timeout = false): Promise<void> => {
    if (rt.stopping) return rt.stopping;
    if (!active(rt.job)) return Promise.resolve();
    rt.controller.abort();
    if (timeout) rt.job.error = { type: 'timeout', message: 'Generation timed out. Try again.' };
    else if (rt.job.outputs.length) {
      rt.job.error = undefined;
      rt.job.note = `Cancelled after ${rt.job.outputs.length} of ${rt.job.takes} takes`;
    }
    // Mark terminal before awaiting fal, so late replies cannot restart the job.
    const done = finish(rt, rt.job.outputs.length ? 'done' : timeout ? 'failed' : 'cancelled');
    return rt.stopping = Promise.allSettled([done, ...rt.requests.filter((r) => r.handle && rt.handles.has(r.handle)).map((r) => cancelRequest(rt, r))]).then(() => undefined);
  };
  const retry = async <T>(rt: Runtime, fn: () => Promise<T>): Promise<T> => {
    let backoff = deps.retryMs ?? 2000;
    for (;;) {
      try { return await fn(); }
      catch (err) {
        const transient = !(err instanceof FalError) || (!err.verdict && (err.kind === 'network' || err.kind === 'timeout' || err.status === 429 || (err.status !== undefined && err.status >= 500)));
        if (!active(rt.job) || !transient) throw err;
        await delay(backoff, undefined, { signal: rt.controller.signal });
        backoff = Math.min(backoff * 2, 30_000);
      }
    }
  };
  const references = async (rt: Runtime) => {
    const media = requiredMedia({ ...rt.req, model: rt.job.model });
    const imageIds: string[] = [];
    const videoIds = [...media.referenceVideoIds];
    for (const id of media.referenceImageIds) {
      if (rt.req.job === 'video.reference' && rt.project?.assets[id]?.kind === 'video') videoIds.push(id);
      else imageIds.push(id);
    }
    // Use the same reference durations as admission and pricing.
    let totalSeconds = 0;
    for (const id of videoIds) {
      const asset = rt.project?.assets[id];
      const seconds = (asset?.durationInFrames ?? NaN) / (asset?.fps ?? rt.project?.fps ?? 30);
      if (!Number.isFinite(seconds) || seconds <= 0) throw new FalError('The reference video has no known duration.', { kind: 'rejected_input' });
      totalSeconds += seconds;
      if (seconds > 15 || totalSeconds > 15) throw new FalError('Reference videos must be at most 15 seconds in total.', { kind: 'rejected_input' });
    }
    const load = async (id: string, video = false) => {
      const asset = rt.project?.assets[id];
      const path = asset && resolvePublicPath(deps.publicDir, asset.src);
      const bad = () => new FalError(`Reference ${redact(id)} is not in the project`, { kind: 'rejected_input' });
      if (!asset || !path) throw bad();
      if (video ? asset.kind !== 'video' : !['image', 'svg'].includes(asset.kind)) {
        throw new FalError(video ? 'Choose a video reference.' : 'Choose an image for this frame or reference.', { kind: 'rejected_input' });
      }
      let bytes: Buffer;
      try {
        const [root, target] = await Promise.all([realpath(deps.publicDir), realpath(path)]);
        const rel = relative(root, target);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw bad();
        if (video && (await stat(target)).size > 200 * 1024 * 1024) throw new FalError('Use a shorter or lighter clip (under 200 MB)', { kind: 'rejected_input' });
        bytes = await readFile(target);
      } catch (err) { if (err instanceof FalError) throw err; throw bad(); }
      return !rt.job.job.startsWith('video.') && !video && bytes.length <= 2 * 1024 * 1024 ? `data:${asset.mimeType};base64,${bytes.toString('base64')}`
        : deps.fal.upload(bytes, basename(asset.name), asset.mimeType);
    };
    const frames = new Map<number, Promise<string>>();
    const frame = (source: FrameSource): Promise<string> => {
      if ('assetId' in source) return load(source.assetId);
      const n = source.projectFrame;
      if (!frames.has(n)) frames.set(n, (async () => {
        const project = rt.project;
        if (!project || project.id !== rt.req.projectId || n < 0 || n >= projectDurationInFrames(project)) {
          throw new FalError('Choose a frame within the open project.', { kind: 'rejected_input' });
        }
        if (!deps.renderStill) throw new FalError("Rendering frames isn't available on this server.", { kind: 'rejected_input' });
        const temp = await mkdtemp(join(tmpdir(), 'mge-generation-frame-'));
        const outputPath = join(temp, 'frame.jpg');
        try {
          await deps.renderStill({ project, frame: n, scale: Math.min(1, 1920 / Math.max(project.width, project.height)),
            outputPath, imageFormat: 'jpeg', jpegQuality: 90, signal: rt.controller.signal });
          const bytes = await readFile(outputPath);
          return await deps.fal.upload(bytes, 'frame.jpg', 'image/jpeg');
        } finally { await rm(temp, { recursive: true, force: true }); }
      })());
      return frames.get(n)!;
    };
    const [referenceUrls, referenceVideoUrls, startUrl, endUrl, keyframeUrls, maskUrl] = await Promise.all([
      Promise.all(imageIds.map((id) => load(id))), Promise.all(videoIds.map((id) => load(id, true))),
      media.start ? frame(media.start) : undefined, media.end ? frame(media.end) : undefined,
      Promise.all(media.keyframes.map(frame)), rt.job.settings.maskAssetId ? load(rt.job.settings.maskAssetId) : undefined,
    ]);
    return { referenceUrls, referenceVideoUrls, startUrl, endUrl, keyframeUrls, maskUrl };
  };
  const checkOutput = async (rt: Runtime, asset: Asset, duration?: number): Promise<void> => {
    const notes: string[] = [];
    if ((rt.job.job.startsWith('image.') || rt.job.job.startsWith('video.')) && rt.job.settings.aspectRatio) {
      const [w, h] = rt.job.settings.aspectRatio.split(':').map(Number);
      if (!asset.width || !asset.height || Math.abs(asset.width / asset.height / (w / h) - 1) > 0.02) notes.push('Aspect ratio differs from the request by more than 2%.');
    }
    if ((rt.job.job === 'music.bed' || rt.job.job.startsWith('sfx.')) && rt.job.settings.durationSeconds !== undefined) {
      if (duration === undefined || Math.abs(duration / rt.job.settings.durationSeconds - 1) > 0.1) notes.push('Duration differs from the request by more than 10%.');
    }
    if (rt.job.job === 'music.scored') {
      const expected = rt.job.settings.score?.reduce((sum, section) => sum + section.seconds, 0);
      if (!expected || duration === undefined || Math.abs(duration / expected - 1) > 0.1) notes.push('Duration differs from the score plan by more than 10%.');
    }
    if (rt.job.job.startsWith('video.')) {
      const expected = videoDuration(rt.job.model, rt.job.settings.durationSeconds ?? 5);
      if (expected !== undefined && (duration === undefined || (duration < expected * 0.9 || duration - expected > Math.max(expected * 0.1, 0.8)))) notes.push('Duration differs from the request by more than 10% or 0.8 seconds.');
      if (asset.hasAudio) notes.push('This video has its own audio track.');
    }
    if (rt.job.job === 'image.cutout') {
      const path = resolvePublicPath(deps.publicDir, asset.src);
      const bytes = path ? await readFile(path) : Buffer.alloc(0);
      if (bytes.length < 26 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        || bytes.toString('ascii', 12, 16) !== 'IHDR' || ![4, 6].includes(bytes[25])) notes.push('Output does not have a PNG alpha channel.');
    }
    rt.checks[asset.id] = { matches: !notes.length, notes };
  };

  async function run(rt: Runtime, index: number): Promise<void> {
    if (!active(rt.job)) return;
    const request = rt.requests[index];
    let handle = request.handle;
    let importing = false;
    try {
      if (!handle) {
        // References are shared by all takes, before the first provider submission.
        const refs = rt.resolvedReferences ?? await (rt.references ??= references(rt));
        rt.resolvedReferences = refs;
        if (!active(rt.job)) return;
        let input: Record<string, unknown>;
        try { input = falInputs(rt.req, rt.job.model, refs, rt.ctx)[index]; }
        catch (err) { throw new FalError(err instanceof Error ? redact(err.message) : 'These references cannot be used with this model.', { kind: 'rejected_input' }); }
        if (rt.firstSubmittedAt === undefined) {
          rt.firstSubmittedAt = now();
          armTimeout(rt);
        }
        request.attempted = true;
        // Retain uncertain liability if the process exits during submit.
        await persist(rt);
        if (!active(rt.job)) return;
        submittedRequests.add(request);
        handle = await deps.fal.submit(rt.job.endpoint, input, { tags: { mge_job: rt.job.job.replaceAll('.', '_'), mge_route: ROUTE_VERSION }, expirySeconds: 3600, signal: rt.controller.signal });
        request.handle = handle;
        request.requestId = redact(handle.requestId);
        rt.handles.add(handle);
        rt.job.falRequestIds.push(redact(handle.requestId));
        if (!active(rt.job)) { await persist(rt); await cancelRequest(rt, request); billing(rt.job.id); return; }
        await persist(rt);
        changed(rt);
      }
      while (active(rt.job)) {
        const state = await retry(rt, () => deps.fal.status(handle!, rt.controller.signal));
        if (!active(rt.job)) return;
        const previousStatus = request.lastStatus;
        request.lastStatus = state.status;
        if (state.error || state.errorType) throw new FalError(state.error ?? 'fal could not complete the request.', { kind: state.errorType === 'content_policy_violation' ? 'rejected_input' : 'provider_error', verdict: true });
        if (state.status === 'IN_PROGRESS') {
          rt.job.status = 'running';
          rt.job.startedAt ??= now();
          delete rt.job.queuePosition;
        } else if (state.status === 'IN_QUEUE') {
          // A sibling request may already be running or importing.
          if (rt.job.startedAt === undefined && rt.job.status !== 'importing') rt.job.status = 'queued';
          rt.job.queuePosition = state.queuePosition;
        } else {
          rt.job.startedAt ??= now();
          await persist(rt);
          if (!active(rt.job)) return;
          break;
        }
        if (previousStatus !== state.status) await persist(rt);
        if (!active(rt.job)) return;
        changed(rt);
        await delay(deps.pollMs ?? 1500, undefined, { signal: rt.controller.signal });
      }
      const result = await retry(rt, () => deps.fal.result(handle!, rt.controller.signal));
      if (!active(rt.job)) return;
      const outputs = extractOutputs(rt.job.job, result);
      if (!outputs.length) throw new FalError('fal returned no media files.', { kind: 'provider_error' });
      rt.job.status = 'importing';
      await persist(rt);
      if (!active(rt.job)) return;
      changed(rt);
      importing = true;
      for (const output of outputs.slice(request.importedCount ?? 0)) {
        if (!active(rt.job)) return;
        const imported = await importFromUrl(deps.publicDir, output.url, undefined, { ...deps.importOptions, signal: rt.controller.signal });
        if (imported.kind === 'video') void Promise.resolve().then(() => deps.requestProxy?.(imported.src)).catch(() => undefined);
        if (!active(rt.job)) return;
        const name = `${shortLabels[rt.job.job]} — take ${rt.job.outputs.length + 1}${extname(imported.src)}`.slice(0, 60);
        const sceneId = bodySceneIds(rt.req)[index];
        const asset: Asset = {
          id: newId('ast'), kind: imported.kind, name, src: imported.src, mimeType: imported.mimeType,
          ...(imported.width ? { width: imported.width } : {}), ...(imported.height ? { height: imported.height } : {}),
          ...(imported.durationSeconds !== undefined ? { durationInFrames: Math.max(1, Math.round(imported.durationSeconds * (rt.scoreProject?.fps ?? rt.project?.fps ?? rt.ctx.project?.fps ?? 30))) } : {}),
          ...(imported.fps !== undefined ? { fps: imported.fps } : {}),
          ...(imported.hasAudio !== undefined ? { hasAudio: imported.hasAudio } : {}),
          provenance: { source: 'generated', provider: 'fal', model: rt.job.modelLabel, prompt: rt.job.prompt,
            ...(output.seed !== undefined ? { seed: output.seed } : {}), requestId: rt.job.id,
            providerRefs: { ...(sceneId !== undefined ? { sceneId } : {}), falRequestId: redact(handle.requestId), endpoint: rt.job.endpoint, job: rt.job.job, modelId: rt.job.model, route: ROUTE_VERSION, policy: rt.job.policy, settings: JSON.stringify(rt.job.settings) },
            cost: rt.job.estimate.reserve ? `≈${formatUsd(rt.job.estimate.usd)} budget reserve` : `~${formatUsd(rt.job.estimate.usd)} estimate`, createdAt: now() },
        };
        if (rt.job.job.startsWith('voice.')) {
          const timestamps = result && typeof result === 'object' ? (result as Record<string, unknown>).timestamps : undefined;
          const words = parseWords(timestamps)?.map((word) => ({ ...word, text: redact(word.text) }));
          if (sceneId !== undefined || words) (rt.job.outputMeta ??= {})[asset.id] = {
            ...(sceneId !== undefined ? { sceneId } : {}), ...(words ? { words } : {}),
          };
        }
        const scoreProject = rt.scoreProject ?? rt.project;
        if (rt.job.job === 'music.scored' && scoreProject) {
          try {
            const { downbeats, bpm } = await (deps.beats ?? beatsFor)(deps.publicDir, asset.src, scoreProject.fps);
            if (!active(rt.job)) return;
            (rt.job.outputMeta ??= {})[asset.id] = { cuts: cutAlignment(scoreProject, downbeats, bpm), downbeats: [...downbeats], bpm };
          } catch { /* Analysis is optional; the generated bed is still usable. */ }
        }
        if (!active(rt.job)) return;
        rt.job.outputs.push(asset);
        await checkOutput(rt, asset, imported.durationSeconds);
        request.importedCount = (request.importedCount ?? 0) + 1;
        await persist(rt);
        changed(rt);
      }
    } catch (err) {
      if (err instanceof FalError && ((!handle && err.status !== undefined) || (err.verdict && err.kind === 'provider_error'))) request.costUsd = 0;
      if (!active(rt.job)) {
        if (request.costUsd !== undefined) { account(rt); await persist(rt); }
        return;
      }
      const type = importing ? 'import_failed' : err instanceof FalError ? err.kind : 'network';
      const message = err instanceof FalError ? redact(err.message) : importing ? 'Could not import the generated file. Try again.' : 'Could not complete generation. Try again.';
      rt.errors.push({ type, message });
    } finally {
      if (handle) {
        if (active(rt.job)) await cancelRequest(rt, request);
        rt.handles.delete(handle);
      }
      request.completed = true;
      if (active(rt.job)) await persist(rt);
      rt.remaining--;
      if (rt.remaining === 0 && active(rt.job)) {
        if (rt.errors.length) {
          const error = rt.errors[0];
          rt.job.error = { type: error.type, message: error.message };
        }
        await finish(rt, rt.job.outputs.length ? 'done' : 'failed');
      }
    }
  }
  function armTimeout(rt: Runtime) {
    clearTimeout(rt.timer);
    const timeout = deps.jobTimeoutMs ?? (rt.job.job.startsWith('video.') ? 30 : 15) * 60_000;
    rt.timer = setTimeout(() => { void stop(rt, true).catch(() => console.warn('Could not save generation timeout.')); }, Math.max(0, timeout - (now() - rt.firstSubmittedAt!)));
    rt.timer.unref();
  }
  function pump() {
    while (running < concurrency && tasks.length) {
      const task = tasks.shift()!;
      if (!active(task.rt.job)) continue;
      running++;
      void run(task.rt, task.index).catch(async () => {
        task.rt.job.error = { type: 'interrupted', message: 'Could not complete generation. Try again.' };
        task.rt.controller.abort();
        await Promise.allSettled([finish(task.rt, 'failed'), ...task.rt.requests.filter((r) => r.handle && task.rt.handles.has(r.handle)).map((r) => cancelRequest(task.rt, r))]);
        console.warn('Could not save generation job activity.');
      }).finally(() => { running--; pump(); });
    }
  }
  const enqueue = async (rt: Runtime) => {
    if (!active(rt.job)) return;
    rt.job.status = 'queued';
    rt.remaining = rt.requests.length;
    rt.requests.forEach((_request, index) => { tasks.push({ rt, index }); });
    rt.timer = setTimeout(() => { void stop(rt, true).catch(() => console.warn('Could not save generation timeout.')); }, deps.queueTimeoutMs ?? 30 * 60_000);
    rt.timer.unref();
    await persist(rt);
    changed(rt);
    pump();
  };

  async function prepare(raw: unknown) {
    const valid = validateRequest(raw);
    if (!valid.ok) return refuse(400, valid.error, valid.path);
    const settings = await deps.settings.get();
    const ctx = await context(settings);
    const req = { ...valid.value, settings: normalizeSettings(valid.value.job, valid.value.settings, ctx) };
    const project = deps.project();
    const media = requiredMedia(req);
    const frames = [...(media.start ? [media.start] : []), ...(media.end ? [media.end] : []), ...media.keyframes];
    if (project?.id !== req.projectId && (frames.length || media.referenceImageIds.length || media.referenceVideoIds.length || req.settings.referenceAssetIds?.length || req.settings.maskAssetId)) refuse(409, 'Open the project first');
    for (const frame of frames) if ('projectFrame' in frame) {
      if (!deps.renderStill) refuse(409, "Rendering frames isn't available on this server.");
      if (!Number.isInteger(frame.projectFrame) || frame.projectFrame < 0 || frame.projectFrame >= projectDurationInFrames(project!)) refuse(409, 'Choose a frame within the open project.');
    }
    // Validate every clip before permission, rendering, reading bytes or uploading any media.
    let referenceSeconds = 0;
    for (const id of media.referenceImageIds) {
      const asset = project?.assets[id];
      if (asset?.kind !== 'video') continue;
      const seconds = ctx.referenceAssetSeconds?.[id] ?? NaN;
      if (!Number.isFinite(seconds) || seconds <= 0) refuse(400, 'The reference video has no known duration.');
      referenceSeconds += seconds;
      if (seconds > 15 || referenceSeconds > 15) refuse(400, 'Reference videos must be at most 15 seconds in total.');
      const path = resolvePublicPath(deps.publicDir, asset.src);
      if (!path) return refuse(400, 'The reference video is not in the project.');
      let size: number;
      try {
        const [root, target] = await Promise.all([realpath(deps.publicDir), realpath(path)]);
        const rel = relative(root, target);
        if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Outside project');
        size = (await stat(target)).size;
      } catch { return refuse(400, 'The reference video is not in the project.'); }
      if (size > 200 * 1024 * 1024) refuse(400, 'Use a shorter or lighter clip (under 200 MB)');
    }
    return { req, inputReq: valid.value, settings, ctx, project: project?.id === req.projectId ? copy(project) : null };
  }
  async function pick(prepared: Awaited<ReturnType<typeof prepare>>) {
    const { req, settings, ctx } = prepared;
    const routed = route(req, req.policy ?? settings.policy, ctx);
    if (!routed.ok) return refuse(400, routed.error);
    const cost = estimate(req, routed.decision.model, ctx);
    rollover();
    const spend = committed;
    return { decision: routed.decision, cost, spend, total: spend + reserved() + cost.usd };
  }
  const withCredentialChange = <T>(fn: () => Promise<T>): Promise<T> => {
    const result = credentialChanges.then(fn);
    credentialChanges = result.catch(() => undefined);
    return result;
  };

  const service: GenerationService = {
    init() {
      return initialized ??= (async () => {
        await readKey();
        let saved: SavedRuntime[] = [];
        try {
          const parsed: unknown = JSON.parse(await readFile(jobsPath, 'utf8'));
          if (Array.isArray(parsed)) saved = parsed.filter((r): r is SavedRuntime => !!r?.job?.id && !!r.req && !!r.ctx && Array.isArray(r.requests));
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
            const corruptPath = join(storageDir, `generation-jobs.corrupt-${now()}.json`);
            const moved = await rename(jobsPath, corruptPath).then(() => true, () => false);
            if (!warned.has('journal')) {
              warned.add('journal');
              console.warn(`Could not read saved generation jobs: ${jobsPath}${moved ? `; moved to ${corruptPath}` : '; could not move aside'}. Recovering from records.`);
            }
          }
        }
        await deps.records.recover(new Set(saved.map((r) => r.job.id)));
        for (const stored of saved) {
          if (!active(stored.job) && (stored.job.finishedAt ?? stored.job.createdAt) < now() - 86_400_000) continue;
          const project = deps.project();
          const rt: Runtime = { ...stored, req: stored.inputReq ?? stored.req, project: project?.id === stored.job.projectId ? copy(project) : null,
            controller: new AbortController(), handles: new Set(stored.requests.filter((r) => r.handle && !r.completed).map((r) => r.handle!)),
            remaining: 0, errors: stored.errors ?? [], checks: stored.checks ?? {} };
          // Restored attempts are uncertain even without a saved handle.
          for (const request of rt.requests) if (request.attempted) submittedRequests.add(request);
          jobs.set(rt.job.id, rt);
        }
        for (const rt of jobs.values()) {
          if (!active(rt.job)) continue;
          if (!rt.requests.some((r) => r.handle)) {
            rt.job.error = rt.job.status === 'awaiting-permission' ? undefined : { type: 'interrupted', message: 'Generation was interrupted before it could finish. Try again.' };
            await finish(rt, rt.job.status === 'awaiting-permission' ? 'denied' : 'failed');
            continue;
          }
          // An attempted submit without a handle is ambiguous: never risk billing it twice.
          for (const request of rt.requests) if (!request.handle && request.attempted) {
            request.completed = true;
            rt.errors.push({ type: 'interrupted', message: 'A take was interrupted during submission and could not be resumed.' });
          }
          rt.remaining = rt.requests.filter((r) => !r.completed).length;
          rt.job.status = 'running';
          rt.job.note = 'Resumed after a restart';
          rt.firstSubmittedAt ??= rt.job.startedAt ?? rt.job.createdAt;
          if (!rt.remaining) { await finish(rt, rt.job.outputs.length ? 'done' : 'failed'); continue; }
          armTimeout(rt);
          if (now() - rt.firstSubmittedAt >= (deps.jobTimeoutMs ?? (rt.job.job.startsWith('video.') ? 30 : 15) * 60_000)) {
            await stop(rt, true);
            continue;
          }
          rt.requests.forEach((r, index) => { if (!r.completed) tasks.push({ rt, index }); });
          changed(rt);
        }
        // Repair the ledger too if a crash landed between the journal and record writes.
        for (const rt of jobs.values()) await persist(rt);
        const currentRows = await deps.records.recover(new Set(jobs.keys()));
        for (const row of currentRows) if (['done', 'failed', 'cancelled'].includes(row.status)) {
          commitments.set(row.id, { day: row.day, usd: row.billed === false ? 0 : row.liabilityUsd ?? row.actualUsd ?? row.estimateUsd });
        }
        accountingDay = localDay(now());
        committed = await deps.records.spendToday();
        await saveJobs();
        discoverBilling();
        pump();
      })().catch((err) => { initialized = undefined; throw err; });
    },
    async status() {
      await service.init();
      const stored = await readKey();
      return { key: { ...keyTest, configured: !!stored, ...(stored ? { source: stored.source, last4: stored.key.slice(-4) } : {}) }, settings: await deps.settings.get(), spendTodayUsd: await deps.records.spendToday(), activeJobs: [...jobs.values()].filter((r) => active(r.job)).length };
    },
    async models() { const settings = await deps.settings.get(); return modelsResponse(settings.policy, await context(settings)); },
    async scoreboard() { await service.init(); return scores(await deps.settings.get()); },
    async dismissSuggestion(job, model) {
      await service.init();
      return scores(await deps.settings.dismissSuggestion(job, model));
    },
    async setRouteOverride(job, model) {
      await service.init();
      const settings = await deps.settings.setRouteOverride(job, model);
      return scores(settings);
    },
    async quote(raw) {
      await service.init();
      const prepared = await prepare(raw);
      const { decision, cost, spend, total } = await pick(prepared);
      return { route: decision, estimate: cost, spendTodayUsd: spend, budgetUsd: prepared.settings.dailyBudgetUsd, overBudget: total > prepared.settings.dailyBudgetUsd, needsConfirm: cost.usd > prepared.settings.confirmOverUsd };
    },
    async create(raw, who, signal) {
      // Admission reserves spend before releasing the lock to a permission wait.
      const admitted = admission.then(async () => {
        await service.init();
        const prepared = await prepare(raw);
        if (!await readKey()) return refuse(409, 'No fal key is set. Add one in Settings › Generation.', undefined, 'PROTOCOL');
        const { decision, cost, spend, total } = await pick(prepared);
        const { req, settings, ctx } = prepared;
        const person = who.origin === 'user';
        const label = who.agent?.trim();
        const agentLabel = !label || label.toLowerCase() === 'you' ? 'Agent' : redact(label).slice(0, 40);
        const needsCard = !person || !settings.skipCardForOwnClicks;
        const job: GenerationJob = {
          id: newId('req').replace(/^req_/, 'gjob_'), projectId: req.projectId, job: req.job, prompt: secret ? req.prompt.split(secret).join('[redacted]') : req.prompt,
          model: decision.model, modelLabel: decision.modelLabel, endpoint: decision.endpoint, policy: req.policy ?? settings.policy, routeVersion: ROUTE_VERSION, overridden: decision.overridden,
          settings: req.settings, takes: req.takes ?? 1, requestedBy: { origin: who.origin, agent: person ? 'You' : agentLabel },
          ...(req.regenerateOf ? { regenerateOf: req.regenerateOf } : {}), status: needsCard ? 'awaiting-permission' : 'queued', createdAt: now(), estimate: cost, falRequestIds: [], outputs: [], delivered: false,
        };
        if (total > settings.dailyBudgetUsd) {
          const message = `This would take today's generation spend to ${formatUsd(total)}, over your ${formatUsd(settings.dailyBudgetUsd)} daily budget. Raise it in Settings › Generation.`;
          await log('limit', job, 'Daily generation budget reached', message);
          return refuse(402, message);
        }
        if (person && cost.usd > settings.confirmOverUsd && !who.confirmed) return refuse(409, `This request is estimated at ${formatUsd(cost.usd)}, over your ${formatUsd(settings.confirmOverUsd)} confirmation threshold.`, 'confirmed');
        if (signal?.aborted) return refuse(409, 'Generation request was cancelled.');
        const estimates = bodyEstimates(prepared.inputReq, job.model, ctx);
        const requestCount = estimates.length;
        if (req.job === 'voice.narration' && req.settings.lines?.length) job.takes = requestCount;
        const rt: Runtime = { job, req: prepared.inputReq, ctx, project: prepared.project, controller: new AbortController(), handles: new Set(), remaining: 0, requests: estimates.map((estimateUsd) => ({ estimateUsd })), errors: [], checks: {} };
        if (job.job === 'music.scored' && prepared.project) rt.scoreProject = timingProject(prepared.project);
        await deps.records.add({ id: job.id, at: job.createdAt, day: localDay(job.createdAt), projectId: job.projectId, job: job.job, model: job.model, endpoint: job.endpoint, routeVersion: job.routeVersion, policy: job.policy, overridden: job.overridden,
          settings: job.settings, takes: job.takes, origin: who.origin, agent: job.requestedBy.agent, regenerateOf: job.regenerateOf, status: job.status, requests: rt.requests, estimateUsd: cost.usd, reserve: cost.reserve, costSource: 'estimate', outputs: [], checks: {}, outcomes: { auditioned: [], used: [], kept: [], replaced: [], deleted: [] }, thumbs: {}, regenerations: 0 });
        jobs.set(job.id, rt);
        try {
          await saveJobs();
          if (job.regenerateOf) await deps.records.update(job.regenerateOf, (r) => { r.regenerations++; });
          changed(rt);
        } catch {
          rt.job.error = { type: 'interrupted', message: 'Could not prepare generation. Try again.' };
          await finish(rt, 'failed');
        }
        return { rt, needsCard, spend, settings };
      });
      admission = admitted.catch(() => undefined);
      const { rt, needsCard, spend, settings } = await admitted;
      try {
        if (!active(rt.job)) return copy(rt.job);
        if (needsCard) {
          await log('requested', rt.job, `Generate ${shortLabels[rt.job.job]}`);
          const agent = who.origin === 'user' ? 'You' : rt.job.requestedBy.agent ?? 'Agent';
          const generation: GenerationAsk = {
            provider: 'fal', tool: 'editor_generate', kind: 'generate', title: `Generate ${shortLabels[rt.job.job]}`, media: JOBS[rt.job.job].media,
            prompt: rt.job.prompt, model: rt.job.modelLabel, settings: Object.entries(rt.job.settings).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`),
            generations: rt.job.takes, usedToday: 0, dailyLimit: 0, estimateUsd: rt.job.estimate.usd, estimateBasis: rt.job.estimate.basis, reserve: rt.job.estimate.reserve, spendTodayUsd: spend, budgetUsd: settings.dailyBudgetUsd,
          };
          const permissionSignal = signal ? AbortSignal.any([signal, rt.controller.signal]) : rt.controller.signal;
          let answer: 'allowed' | 'denied' | 'timeout' | 'unavailable' = 'unavailable';
          if (!permissionSignal.aborted) {
            try { answer = await deps.askPermission({ agent, action: `Generate ${shortLabels[rt.job.job]} with ${rt.job.modelLabel} (~${formatUsd(rt.job.estimate.usd)})`, generation }, permissionSignal); }
            catch { answer = 'unavailable'; }
          }
          if (!active(rt.job)) return copy(rt.job);
          if (answer !== 'allowed' || permissionSignal.aborted) {
            await log('denied', rt.job, 'Generation declined', permissionSignal.aborted ? 'The request was cancelled.' : answer === 'unavailable' ? 'The editor is not connected.' : answer === 'timeout' ? 'Permission timed out.' : 'Permission was denied.');
            await finish(rt, 'denied');
            return copy(rt.job);
          }
          await log('approved', rt.job, `Approved ${shortLabels[rt.job.job]}`);
        }
        await enqueue(rt);
      } catch {
        rt.job.error = { type: 'interrupted', message: 'Could not prepare generation. Try again.' };
        await finish(rt, 'failed');
      }
      return copy(rt.job);
    },
    list(projectId) { return [...jobs.values()].map((r) => r.job).filter((j) => !projectId || j.projectId === projectId).reverse().map(copy); },
    get(id) { const rt = jobs.get(id); return rt ? copy(rt.job) : undefined; },
    async cancel(id) { const rt = jobs.get(id); if (!rt) return undefined; await stop(rt); await journalWrites; return copy(rt.job); },
    async delivered(id) {
      const rt = jobs.get(id);
      if (!rt) return undefined;
      if (rt.delivery) return rt.delivery;
      rt.delivery = (async () => {
        const previous = rt.job.delivered;
        rt.job.delivered = true;
        try { await persist(rt); }
        catch (err) {
          rt.job.delivered = previous;
          await saveJobs().catch(() => undefined);
          throw err;
        }
        changed(rt);
        return copy(rt.job);
      })();
      try { return await rt.delivery; } finally { rt.delivery = undefined; }
    },
    outcome: (r) => deps.records.outcome(r),
    thumbs: (ids) => deps.records.thumbs(ids),
    async markKept(project) {
      const usage = takeUsage(project);
      for (const asset of Object.values(project.assets)) if (asset.provenance?.requestId?.startsWith('gjob_') && (usage.get(asset.id) ?? 0) > 0) {
        await deps.records.outcome({ jobId: asset.provenance.requestId, assetId: asset.id, event: 'kept' });
      }
    },
    updateSettings: (patch) => deps.settings.update(patch),
    setKey: (raw) => withCredentialChange(async () => {
      const checked = checkKeyShape(raw);
      if (!checked.ok) throw new SettingsError(checked.error, 'key');
      let test: Awaited<ReturnType<FalClient['testKey']>>;
      try { test = await (deps.falFactory ?? createFalClient)({ key: async () => checked.key }).testKey(); }
      catch { throw new SettingsError('Could not test the fal key. Try again.', 'key'); }
      if (!test.valid) throw new SettingsError(redact(test.error ?? 'fal did not accept this key.', checked.key), 'key');
      await keys.set(checked.key);
      keyRevision++;
      await readKey();
      keyTest = { valid: true, billing: test.billing, checkedAt: now() };
      availability = {}; prices = {};
      discoverBilling();
      scheduleBilling();
      await service.checkEndpoints();
      return (await service.status()).key;
    }),
    testKey: () => withCredentialChange(async () => {
      if (!await readKey()) { keyTest = {}; return { configured: false }; }
      const tested = await deps.fal.testKey();
      keyTest = { valid: tested.valid, billing: tested.billing, checkedAt: now(), ...(tested.error ? { error: redact(tested.error) } : {}) };
      scheduleBilling();
      return (await service.status()).key;
    }),
    removeKey: () => withCredentialChange(async () => {
      await keys.remove(); keyRevision++; keyTest = {}; availability = {}; prices = {}; await readKey();
      return (await service.status()).key;
    }),
    async checkEndpoints() {
      if (!await readKey()) return;
      const revision = keyRevision;
      const endpoints = [...new Set(Object.values(MODELS).flatMap((m) => Object.values(m.endpoints)))];
      try {
        const found = await deps.fal.pricing(endpoints);
        if (revision !== keyRevision) return;
        prices = Object.fromEntries(Object.entries(found).filter(([, p]) => p.currency === 'USD'));
        availability = Object.fromEntries(endpoints.map((e) => [e, Object.hasOwn(found, e)]));
        for (const model of Object.values(MODELS)) if (Object.values(model.endpoints).some((e) => !availability[e]) && !warned.has(model.id)) {
          warned.add(model.id);
          console.warn(`Generation model unavailable: ${model.label}.`);
        }
      } catch { console.warn('Could not check fal generation endpoints. Using registry prices.'); }
    },
  };
  return service;
}
