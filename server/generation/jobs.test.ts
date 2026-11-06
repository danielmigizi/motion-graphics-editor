// Generation admission, permissions, request concurrency, imports and billing.

import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerateRequest, GenerationJob } from '../../src/core/generationStudio';
import { MODELS, ROUTE_VERSION } from '../../src/core/generationRoutes';
import type { Project } from '../../src/core/types';
import { sampleProject } from '../../src/sample/sampleProject';
import { GenerationLog } from '../generation-log';
import type { ImportOptions } from '../url-import';
import { createKeyStore, GenerationSettingsStore, type KeyStore } from './config';
import { FalError, type FalClient, type FalQueueHandle } from './fal';
import { cachedGenerationKeys, createGenerationService, type GenerationService } from './jobs';
import { GenerationRecords } from './records';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
let dir: string;
let project: Project | null;
let settings: GenerationSettingsStore;
let records: GenerationRecords;
let keys: KeyStore;
let fal: FalClient;
let service: GenerationService;
let emissions: GenerationJob[];
type AskPermission = Parameters<typeof createGenerationService>[0]['askPermission'];
let ask: ReturnType<typeof vi.fn<AskPermission>>;
let network: Pick<ImportOptions, 'lookup' | 'connect' | 'probe'>;
const request = (patch: Partial<GenerateRequest> = {}): GenerateRequest => ({ job: 'image.generate', prompt: 'A red kite', projectId: project?.id ?? 'prj_test', settings: { aspectRatio: '1:1' }, ...patch });
const handle = (id: string): FalQueueHandle => ({ requestId: id, statusUrl: `https://queue.test/${id}/status`, responseUrl: `https://queue.test/${id}`, cancelUrl: `https://queue.test/${id}/cancel` });
const person = { origin: 'user' as const };
const agent = { origin: 'agent' as const, agent: 'Test agent' };
const waitFor = async (fn: () => unknown) => vi.waitFor(fn, { timeout: 4000, interval: 5 });
const done = async (id: string, status = 'done') => {
  await waitFor(() => expect(service.get(id)?.status).toBe(status));
  await waitFor(async () => expect((await records.get(id))?.status).toBe(status));
  if (['done', 'failed', 'cancelled', 'denied'].includes(status)) await waitFor(() => expect(emissions.some((e) => e.id === id && e.status === status)).toBe(true));
  return service.get(id)!;
};
function build(extra: Partial<Parameters<typeof createGenerationService>[0]> = {}) {
  service = createGenerationService({ fal, keys, settings, records, publicDir: dir, project: () => project, emit: (j) => emissions.push(j), askPermission: ask,
    log: new GenerationLog({ dir }), falFactory: () => fal, importOptions: network, pollMs: 1, ...extra });
  return service;
}
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mge-jobs-'));
  project = structuredClone(sampleProject);
  project.assets = {};
  keys = createKeyStore({ dir, env: {}, keychain: { get: async () => null, set: async () => false, remove: async () => undefined } });
  await keys.set('fal_test-key');
  settings = new GenerationSettingsStore({ dir });
  records = new GenerationRecords({ dir });
  let sequence = 0;
  fal = {
    submit: vi.fn(async () => handle(`fal_${++sequence}`)),
    status: vi.fn(async () => ({ status: 'COMPLETED' as const })),
    result: vi.fn(async () => ({ images: [{ url: 'https://cdn.example.com/a.png', width: 1, height: 1 }], seed: 42 })),
    cancel: vi.fn(async () => true), pricing: vi.fn(async () => Object.fromEntries(Object.values(MODELS).flatMap((m) => Object.values(m.endpoints).map((e) => [e, { unitPrice: m.price.usd, unit: m.price.unit, currency: 'USD' }])))),
    billingEvents: vi.fn(async () => []), upload: vi.fn(async () => 'https://cdn.example.com/reference.png'),
    testKey: vi.fn(async () => ({ valid: true, billing: false })),
  };
  network = { lookup: async () => [{ address: '93.184.216.34', family: 4 }], connect: async () => ({ status: 200, headers: {}, body: Readable.from([PNG]) }), probe: async () => null };
  emissions = [];
  ask = vi.fn<AskPermission>(async () => 'allowed');
  build();
});
afterEach(async () => {
  for (const job of service.list()) await service.cancel(job.id);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  // Journal and record writes can still be landing after a cancel: retry the removal instead of racing them.
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

describe('admission and permissions', () => {
  it('quotes routing, normalized settings and price without provider calls', async () => {
    const quote = await service.quote(request({ job: 'image.typography', takes: 2 }));
    expect(quote).toMatchObject({ route: { model: 'seedream-5-pro' }, estimate: { usd: 0.135 }, overBudget: false, needsConfirm: false });
    expect(fal.submit).not.toHaveBeenCalled();
    expect(await service.models()).toMatchObject({ routeVersion: ROUTE_VERSION, policy: 'quality' });
  });
  it('refuses malformed requests, no key, and references in a closed project', async () => {
    await expect(service.create({}, person)).rejects.toMatchObject({ status: 400, error: { path: 'job' } });
    await service.removeKey();
    await expect(service.create(request(), person)).rejects.toMatchObject({ status: 409, error: { code: 'PROTOCOL', message: 'No fal key is set. Add one in Settings › Generation.' } });
    await expect(service.create(request({ projectId: 'other', settings: { referenceAssetIds: ['a'] } }), person)).rejects.toMatchObject({ status: 409, message: 'Open the project first' });
  });
  it('checks confirmation and allows an explicit confirmation', async () => {
    await settings.update({ confirmOverUsd: 0.2 });
    await expect(service.create(request(), person)).rejects.toMatchObject({ status: 409, error: { path: 'confirmed' } });
    const job = await service.create(request(), { ...person, confirmed: true });
    await done(job.id);
    expect(ask).not.toHaveBeenCalled();
  });
  it('shows the own-click card as You when configured', async () => {
    await settings.update({ skipCardForOwnClicks: false });
    const job = await service.create(request(), person);
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ agent: 'You' }), expect.any(AbortSignal));
    await done(job.id);
  });
  it('emits awaiting permission and sends the complete priced ask before queueing', async () => {
    const job = await service.create(request({ takes: 2 }), agent);
    expect(emissions[0].status).toBe('awaiting-permission');
    expect(ask.mock.calls[0][0]).toMatchObject({ agent: 'Test agent', generation: { provider: 'fal', tool: 'editor_generate', kind: 'generate', title: 'Generate Image', media: 'image', prompt: 'A red kite', model: 'GPT Image 2.5 Flare', settings: ['aspectRatio: 1:1', 'resolution: 1k'], generations: 2, usedToday: 0, dailyLimit: 0, estimateUsd: 1, reserve: true, spendTodayUsd: 0, budgetUsd: 5 } });
    await done(job.id);
    const entries = JSON.parse(await readFile(join(dir, 'generation-log.json'), 'utf8')).entries;
    expect(entries.map((e: { kind: string }) => e.kind)).toEqual(['imported', 'approved', 'requested']);
  });
  it.each(['denied', 'unavailable', 'timeout'] as const)('returns a denied job for permission %s', async (answer) => {
    ask.mockResolvedValue(answer);
    const job = await service.create(request(), agent);
    expect(job).toMatchObject({ status: 'denied', billed: false });
    expect(fal.submit).not.toHaveBeenCalled();
    expect((await records.get(job.id))?.status).toBe('denied');
  });
  it('cancels a pending card and never submits after a late approval', async () => {
    let allow!: (answer: 'allowed') => void;
    ask.mockImplementation(() => new Promise<'allowed'>((resolve) => { allow = resolve; }));
    const pending = service.create(request(), agent);
    await waitFor(() => expect(ask).toHaveBeenCalled());
    const [job] = service.list();
    await service.cancel(job.id);
    allow('allowed');
    expect((await pending).status).toBe('cancelled');
    expect(fal.submit).not.toHaveBeenCalled();
  });
  it('reserves awaiting and running spend atomically, and logs a budget refusal', async () => {
    await settings.update({ dailyBudgetUsd: 0.75 });
    vi.mocked(fal.status).mockResolvedValue({ status: 'IN_PROGRESS' });
    const results = await Promise.allSettled([service.create(request(), person), service.create(request(), person)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 402 } });
    expect((await service.quote(request())).overBudget).toBe(true);
    expect(JSON.parse(await readFile(join(dir, 'generation-log.json'), 'utf8')).entries[0].kind).toBe('limit');
    const job = service.list()[0];
    await done(job.id, 'running');
    await expect(service.create(request(), agent)).rejects.toMatchObject({ status: 402 });
  });
  it('reserves spend while permission is pending and releases a denied reservation', async () => {
    await settings.update({ dailyBudgetUsd: 0.75 });
    let answer!: (decision: 'denied') => void;
    ask.mockImplementation(() => new Promise<'denied'>((resolve) => { answer = resolve; }));
    const pending = service.create(request(), agent);
    await waitFor(() => expect(ask).toHaveBeenCalled());
    await expect(service.create(request(), person)).rejects.toMatchObject({ status: 402 });
    answer('denied');
    expect((await pending).status).toBe('denied');
    const job = await service.create(request(), person);
    await done(job.id);
  });
  it('counts persisted spend against the daily budget', async () => {
    const job = await service.create(request(), person);
    await done(job.id);
    await settings.update({ dailyBudgetUsd: 0.75 });
    await expect(service.create(request(), person)).rejects.toMatchObject({ status: 402 });
  });
});

describe('requests, imports and provenance', () => {
  it('runs queued → running → importing → done, batches GPT takes, tags requests, and records alpha/aspect checks', async () => {
    vi.mocked(fal.status).mockResolvedValueOnce({ status: 'IN_QUEUE', queuePosition: 3 }).mockResolvedValueOnce({ status: 'IN_PROGRESS' }).mockResolvedValue({ status: 'COMPLETED' });
    vi.mocked(fal.result).mockResolvedValue({ images: [{ url: 'https://cdn.example.com/one.png' }, { url: 'https://cdn.example.com/two.png' }], seed: 42 });
    const job = await service.create(request({ job: 'image.cutout', takes: 2 }), person);
    const result = await done(job.id);
    expect(fal.submit).toHaveBeenCalledTimes(1);
    expect(fal.submit).toHaveBeenCalledWith(job.endpoint, expect.objectContaining({ num_images: 2, background: 'transparent' }), expect.objectContaining({ tags: { mge_job: 'image_cutout', mge_route: ROUTE_VERSION }, expirySeconds: 3600 }));
    expect(emissions.map((e) => e.status)).toEqual(expect.arrayContaining(['queued', 'running', 'importing', 'done']));
    expect(emissions.find((e) => e.queuePosition === 3)).toBeDefined();
    expect(result.outputs).toHaveLength(2);
    expect(result.outputs[0]).toMatchObject({ kind: 'image', name: 'Cutout — take 1.png', mimeType: 'image/png', width: 1, height: 1, provenance: { source: 'generated', provider: 'fal', model: 'GPT Image 2.5 Flare', prompt: 'A red kite', seed: 42, requestId: job.id, providerRefs: { falRequestId: 'fal_1', endpoint: job.endpoint, job: 'image.cutout', modelId: job.model, route: ROUTE_VERSION, policy: 'quality', settings: JSON.stringify(job.settings) }, cost: '≈$1.00 budget reserve' } });
    const record = (await records.get(job.id))!;
    expect(record.outputs).toEqual(result.outputs.map((a) => a.id));
    expect(record.checks[result.outputs[0].id]).toEqual({ matches: true, notes: [] });
    expect(record.queueMs).toBeGreaterThanOrEqual(0);
    expect(record.runMs).toBeGreaterThanOrEqual(0);
    expect((await service.delivered(job.id))?.delivered).toBe(true);
  });
  it('limits requests to two globally and admits the third FIFO', async () => {
    vi.mocked(fal.status).mockResolvedValue({ status: 'IN_PROGRESS' });
    const first = await service.create(request({ model: 'flux-3-image' }), person);
    const second = await service.create(request({ model: 'flux-3-image' }), person);
    const third = await service.create(request({ model: 'flux-3-image' }), person);
    await waitFor(() => expect(fal.submit).toHaveBeenCalledTimes(2));
    expect(service.get(third.id)?.falRequestIds).toEqual([]);
    await service.cancel(first.id);
    await waitFor(() => expect(fal.submit).toHaveBeenCalledTimes(3));
    expect(service.get(second.id)?.falRequestIds).toEqual(['fal_2']);
    expect(service.get(third.id)?.falRequestIds).toEqual(['fal_3']);
  });
  it('counts separate requests within a multi-take job against concurrency', async () => {
    vi.mocked(fal.status).mockResolvedValue({ status: 'IN_PROGRESS' });
    const job = await service.create(request({ model: 'flux-3-image', takes: 3 }), person);
    await waitFor(() => expect(fal.submit).toHaveBeenCalledTimes(2));
    expect(service.get(job.id)?.falRequestIds).toHaveLength(2);
    await service.cancel(job.id);
    expect(fal.cancel).toHaveBeenCalledTimes(2);
  });
  it('computes audio frames at project fps, checks duration and keeps estimate provenance', async () => {
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
    network.connect = async () => ({ status: 200, headers: {}, body: Readable.from([mp3]) });
    network.probe = async () => ({ durationSeconds: 8, audio: true });
    vi.mocked(fal.result).mockResolvedValue({ audio: { url: 'https://cdn.example.com/music.mp3' } });
    build();
    project!.fps = 24;
    const job = await service.create(request({ job: 'music.bed', settings: { durationSeconds: 10 } }), person);
    const result = await done(job.id);
    expect(result.outputs[0]).toMatchObject({ name: 'Music bed — take 1.mp3', durationInFrames: 192, provenance: { cost: '~$0.10 estimate' } });
    expect((await records.get(job.id))!.checks[result.outputs[0].id]).toMatchObject({ matches: false, notes: ['Duration differs from the request by more than 10%.'] });
  });
  it('marks a wrong aspect and opaque cutout as mismatches', async () => {
    const opaque = Buffer.from(PNG); opaque[25] = 2;
    network.connect = async () => ({ status: 200, headers: {}, body: Readable.from([opaque]) });
    const job = await service.create(request({ job: 'image.cutout', settings: { aspectRatio: '16:9' } }), person);
    const result = await done(job.id);
    expect((await records.get(job.id))!.checks[result.outputs[0].id]).toMatchObject({ matches: false });
    expect((await records.get(job.id))!.checks[result.outputs[0].id].notes).toHaveLength(2);
  });
  it('retains imported takes after a later import fails', async () => {
    vi.mocked(fal.result).mockResolvedValue({ images: [{ url: 'https://cdn.example.com/ok.png' }, { url: 'https://cdn.example.com/fail.png' }] });
    network.connect = async (url) => {
      if (url.pathname.includes('fail')) throw new Error('Download failed');
      return { status: 200, headers: {}, body: Readable.from([PNG]) };
    };
    const job = await service.create(request({ takes: 2 }), person);
    expect(await done(job.id)).toMatchObject({ status: 'done', outputs: [expect.any(Object)], error: { type: 'import_failed' } });
  });
  it.each(['provider_error', 'rejected_input', 'auth'] as const)('maps %s failures and records billing eligibility', async (kind) => {
    vi.mocked(fal.result).mockRejectedValue(new FalError('A plain provider reason.', { kind, verdict: true }));
    const job = await service.create(request(), person);
    expect(await done(job.id, 'failed')).toMatchObject({ error: { type: kind, message: 'A plain provider reason.' } });
    expect((await records.get(job.id))!.billed).toBe(kind === 'provider_error' ? false : undefined);
  });
  it('cancels queued jobs without submitting, and running jobs at fal', async () => {
    build({ concurrency: 1 });
    vi.mocked(fal.status).mockResolvedValue({ status: 'IN_PROGRESS' });
    const first = await service.create(request(), person);
    await done(first.id, 'running');
    const queued = await service.create(request(), person);
    expect(await service.cancel(queued.id)).toMatchObject({ status: 'cancelled', billed: false });
    expect(await service.cancel(first.id)).toMatchObject({ status: 'cancelled' });
    expect(fal.cancel).toHaveBeenCalledWith(handle('fal_1'));
    expect(fal.submit).toHaveBeenCalledTimes(1);
    expect(await service.cancel('missing')).toBeUndefined();
  });
  it('cancels a fal submission whose handle arrives after the local cancellation', async () => {
    let resolve!: (handle: FalQueueHandle) => void;
    vi.mocked(fal.submit).mockImplementation(() => new Promise<FalQueueHandle>((done) => { resolve = done; }));
    const job = await service.create(request(), person);
    await waitFor(() => expect(fal.submit).toHaveBeenCalled());
    expect(await service.cancel(job.id)).toMatchObject({ status: 'cancelled' });
    expect(service.get(job.id)?.billed).toBeUndefined();
    resolve(handle('late'));
    await waitFor(() => expect(fal.cancel).toHaveBeenCalledWith(handle('late')));
    expect(service.get(job.id)?.status).toBe('cancelled');
    expect((await records.get(job.id))?.billed).toBeUndefined();
  });
  it('times out the overall job and cancels its fal requests', async () => {
    build({ jobTimeoutMs: 40 });
    vi.mocked(fal.status).mockResolvedValue({ status: 'IN_PROGRESS' });
    const job = await service.create(request(), person);
    expect(await done(job.id, 'failed')).toMatchObject({ error: { type: 'timeout' } });
    expect(fal.cancel).toHaveBeenCalledWith(handle('fal_1'));
  });
});

describe('references, outcomes, endpoint discovery and credentials', () => {
  async function reference(size: number, id = 'ast_ref') {
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, `assets/${id}.png`), Buffer.alloc(size, 1));
    project!.assets[id] = { id, kind: 'image', name: `${id}.png`, src: `assets/${id}.png`, mimeType: 'image/png' };
  }
  it('uses data URLs at 2 MB, uploads larger references, and preserves automatic edit size', async () => {
    await reference(2 * 1024 * 1024);
    await reference(2 * 1024 * 1024 + 1, 'ast_large');
    const job = await service.create(request({ job: 'image.edit', settings: { referenceAssetIds: ['ast_ref'], maskAssetId: 'ast_large' } }), person);
    await done(job.id);
    expect(fal.submit).toHaveBeenCalledWith(job.endpoint, expect.objectContaining({ image_size: 'auto', image_urls: [expect.stringMatching(/^data:image\/png;base64,/)], mask_url: 'https://cdn.example.com/reference.png' }), expect.anything());
    expect(fal.upload).toHaveBeenCalledWith(expect.any(Buffer), 'ast_large.png', 'image/png');
  });
  it.each(['missing', 'escape', 'symlink'])('rejects %s reference assets before submission', async (mode) => {
    if (mode !== 'missing') {
      project!.assets.bad = { id: 'bad', name: 'bad.png', kind: 'image', mimeType: 'image/png', src: mode === 'escape' ? '../outside.png' : 'link.png' };
      if (mode === 'symlink') await symlink('/etc/hosts', join(dir, 'link.png'));
    }
    const job = await service.create(request({ job: 'image.edit', settings: { referenceAssetIds: ['bad'] } }), person);
    expect(await done(job.id, 'failed')).toMatchObject({ error: { type: 'rejected_input', message: 'Reference bad is not in the project' }, billed: false });
    expect(fal.submit).not.toHaveBeenCalled();
  });
  it('counts regenerations, deduplicates kept-at-export and serves outcome thumbs', async () => {
    const first = await service.create(request(), person);
    const result = await done(first.id);
    const second = await service.create(request({ regenerateOf: first.id }), person);
    await done(second.id);
    expect((await records.get(first.id))!.regenerations).toBe(1);
    const asset = result.outputs[0];
    project!.assets[asset.id] = asset;
    // Audio usage also counts, regardless of the asset's media type.
    project!.audio = [{ id: 'aud_use', assetId: asset.id } as Project['audio'][number]];
    await service.markKept(project!);
    await service.markKept(project!);
    expect((await records.get(first.id))!.outcomes.kept).toEqual([asset.id]);
    await service.outcome({ jobId: first.id, assetId: asset.id, event: 'thumbsUp' });
    expect(await service.thumbs([first.id])).toEqual({ [asset.id]: 1 });
  });
  it('skips missing endpoints in routing and warns once per missing model', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const all = await fal.pricing([]);
    for (const endpoint of Object.values(MODELS['gpt-image-2.5-flare'].endpoints)) delete all[endpoint];
    vi.mocked(fal.pricing).mockResolvedValue(all);
    await service.checkEndpoints(); await service.checkEndpoints();
    expect(warn).toHaveBeenCalledTimes(1);
    expect((await service.quote(request())).route.model).toBe('seedream-5-pro');
    expect((await service.models()).jobs.find((j) => j.job === 'image.generate')!.models[0].available).toBe(false);
    await expect(service.create(request({ job: 'image.cutout' }), person)).rejects.toMatchObject({ status: 400 });
  });
  it('uses live prices, skips endpoint discovery without a key, and keeps unknown availability', async () => {
    await service.removeKey();
    await service.checkEndpoints();
    expect(fal.pricing).not.toHaveBeenCalled();
    expect((await service.models()).jobs[0].models[0].available).toBeNull();
    await service.setKey('fal_again');
    vi.mocked(fal.pricing).mockResolvedValue({ [MODELS['seedream-5-pro'].endpoints['image.generate']!]: { unitPrice: 0.1, unit: 'units', currency: 'USD' } });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await service.checkEndpoints();
    expect((await service.quote(request({ model: 'seedream-5-pro' }))).estimate.usd).toBe(0.1);
  });
  it('tests candidate keys before saving, invalidates caches and never overwrites a valid key on rejection', async () => {
    const get = vi.spyOn(keys, 'get');
    build();
    await service.status(); await service.status();
    expect(get).toHaveBeenCalledTimes(1);
    expect(await service.setKey('fal_new')).toMatchObject({ configured: true, last4: '_new', valid: true });
    expect((await keys.get())?.key).toBe('fal_new');
    expect(fal.pricing).toHaveBeenCalled();
    vi.mocked(fal.testKey).mockResolvedValue({ valid: false, billing: null, error: 'Key fal_bad rejected' });
    await expect(service.setKey('fal_bad')).rejects.toMatchObject({ path: 'key', message: '[redacted] rejected' });
    expect((await keys.get())?.key).toBe('fal_new');
    await expect(service.setKey('spaces in key')).rejects.toMatchObject({ path: 'key' });
    expect(await service.removeKey()).toEqual({ configured: false });
    expect(await service.testKey()).toEqual({ configured: false });
  });
  it('shares one cached getter between the client and service', async () => {
    const get = vi.spyOn(keys, 'get');
    const cached = cachedGenerationKeys(keys);
    expect(cachedGenerationKeys(cached)).toBe(cached);
    await Promise.all([cached.get(), cached.get(), cached.status()]);
    expect(get).toHaveBeenCalledTimes(1);
    await cached.set('fal_changed');
    expect((await cached.get())?.key).toBe('fal_changed');
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('reconciles actual billing at 60 seconds and stops once all requests resolve', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.mocked(fal.testKey).mockResolvedValue({ valid: true, billing: true });
    await service.testKey();
    const job = await service.create(request(), person);
    // vi.waitFor advances fake timers, so wait using real immediates here.
    while (!emissions.some((e) => e.id === job.id && e.status === 'done')) await new Promise<void>((resolve) => setImmediate(resolve));
    await records.get(job.id);
    vi.mocked(fal.billingEvents).mockResolvedValue([{ requestId: 'fal_1', endpointId: job.endpoint, costUsd: 0.123 }]);
    await vi.advanceTimersByTimeAsync(60_000);
    while ((await records.get(job.id))?.actualUsd === undefined) await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.get(job.id)?.actualUsd).toBe(0.123);
    expect((await records.get(job.id))?.costSource).toBe('billing');
    expect(await records.spendToday()).toBe(0.123);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(fal.billingEvents).toHaveBeenCalledTimes(1);
  });
  it('disables billing reconciliation on 403', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.mocked(fal.testKey).mockResolvedValue({ valid: true, billing: true });
    await service.testKey();
    const job = await service.create(request(), person);
    while (!emissions.some((e) => e.id === job.id && e.status === 'done')) await new Promise<void>((resolve) => setImmediate(resolve));
    await records.get(job.id);
    vi.mocked(fal.billingEvents).mockRejectedValue(new FalError('Billing unavailable.', { kind: 'auth', status: 403 }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect((await service.status()).key.billing).toBe(false);
    await vi.advanceTimersByTimeAsync(240_000);
    expect(fal.billingEvents).toHaveBeenCalledTimes(1);
  });
});

// Regression cases from the two Phase A server reviews.
describe('review fixes: accounting and lifecycle', () => {
  it.each(['queued', 'running', 'importing', 'awaiting-permission'] as const)('recovers %s records before concurrent admission after restart', async (status) => {
    const first = await service.create(request(), person);
    await done(first.id);
    await records.update(first.id, (r) => { r.status = status; });
    // Phase A recovery applies only when there is no runtime journal.
    await rm(join(dir, 'generation-jobs.json'), { force: true });
    records = new GenerationRecords({ dir });
    build();
    await settings.update({ dailyBudgetUsd: 0.75 });
    if (status === 'awaiting-permission') {
      const second = await service.create(request(), person);
      await done(second.id);
      expect(await records.get(first.id)).toMatchObject({ status: 'denied', billed: false });
    } else {
      const attempts = await Promise.allSettled([service.create(request(), person), service.create(request(), person)]);
      expect(attempts.every((r) => r.status === 'rejected' && r.reason.status === 402)).toBe(true);
      const orphan = await records.get(first.id);
      expect(orphan).toMatchObject({ status: 'failed', failure: 'interrupted' });
      expect(orphan?.billed).toBeUndefined();
      expect(await records.spendToday()).toBe(0.5);
    }
  });

  it.each(['status', 'result'] as const)('retries transient %s errors without abandoning or releasing a take', async (method) => {
    build({ retryMs: 1 });
    vi.mocked(fal[method])
      .mockRejectedValueOnce(new Error('socket reset'))
      .mockRejectedValueOnce(new FalError('timeout', { kind: 'timeout' }))
      .mockRejectedValueOnce(new FalError('limited', { kind: 'provider_error', status: 429 }))
      .mockRejectedValueOnce(new FalError('unavailable', { kind: 'provider_error', status: 503 }));
    const job = await service.create(request(), person);
    expect(await done(job.id)).toMatchObject({ outputs: [expect.any(Object)] });
    expect(fal[method]).toHaveBeenCalledTimes(5);
    expect(await records.spendToday()).toBe(0.5);
  });

  it.each([undefined, 422, 503])('keeps uncertain submit liability but releases HTTP refusal %s', async (status) => {
    vi.mocked(fal.submit).mockRejectedValue(new FalError('submit failed', { kind: status ? 'provider_error' : 'network', status }));
    const job = await service.create(request(), person);
    const result = await done(job.id, 'failed');
    expect(result.billed).toBe(status ? false : undefined);
    expect(await records.spendToday()).toBe(status ? 0 : job.estimate.usd);
  });

  it('retries persistent transport failures until the job deadline, then cancels and keeps liability', async () => {
    build({ retryMs: 1, jobTimeoutMs: 50 });
    vi.mocked(fal.status).mockRejectedValue(new FalError('unavailable', { kind: 'provider_error', status: 503 }));
    const job = await service.create(request(), person);
    expect(await done(job.id, 'failed')).toMatchObject({ error: { type: 'timeout' } });
    expect(vi.mocked(fal.status).mock.calls.length).toBeGreaterThan(1);
    expect(fal.cancel).toHaveBeenCalledWith(handle('fal_1'));
    expect(await records.spendToday()).toBe(job.estimate.usd);
  });

  it('keeps liability and cancels a completed request that returned no media', async () => {
    vi.mocked(fal.result).mockResolvedValue({});
    const job = await service.create(request(), person);
    expect((await done(job.id, 'failed')).billed).toBeUndefined();
    expect(await records.spendToday()).toBe(job.estimate.usd);
    expect(fal.cancel).toHaveBeenCalledWith(handle('fal_1'));
  });

  it('releases a provider server-failure verdict and cancels the abandoned request', async () => {
    vi.mocked(fal.status).mockResolvedValue({ status: 'COMPLETED', errorType: 'runner_server_error' });
    const job = await service.create(request(), person);
    expect(await done(job.id, 'failed')).toMatchObject({ billed: false, error: { type: 'provider_error' } });
    expect(fal.cancel).toHaveBeenCalledWith(handle('fal_1'));
  });

  it('commits spend synchronously while terminal persistence is blocked', async () => {
    vi.mocked(fal.status).mockResolvedValue({ status: 'IN_PROGRESS' });
    const job = await service.create(request(), person);
    await done(job.id, 'running');
    await settings.update({ dailyBudgetUsd: 0.75 });
    const original = records.update.bind(records);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(records, 'update').mockImplementation(async (...args) => { await gate; return original(...args); });
    const cancelling = service.cancel(job.id);
    try {
      expect(service.get(job.id)?.status).toBe('cancelled');
      await expect(service.create(request(), person)).rejects.toMatchObject({ status: 402 });
      expect((await service.quote(request())).spendTodayUsd).toBe(0.5);
    } finally { release(); await cancelling; }
  });

  it('rolls committed spend over on a new local day', async () => {
    let clock = Date.now();
    build({ now: () => clock });
    const job = await service.create(request(), person);
    await done(job.id);
    expect((await service.quote(request())).spendTodayUsd).toBe(0.5);
    clock += 86_400_000;
    expect((await service.quote(request())).spendTodayUsd).toBe(0);
  });

  it.each([[true, 'IN_QUEUE', 0], [false, 'IN_QUEUE', 0.5], [true, 'IN_PROGRESS', 0.5]] as const)('releases only an accepted queued cancel (%s, %s)', async (accepted, status, spend) => {
    vi.mocked(fal.status).mockResolvedValue({ status });
    vi.mocked(fal.cancel).mockResolvedValue(accepted);
    const job = await service.create(request(), person);
    await waitFor(() => expect(fal.status).toHaveBeenCalled());
    await service.cancel(job.id);
    expect(await records.spendToday()).toBe(spend);
    expect(service.get(job.id)?.billed).toBe(spend === 0 ? false : undefined);
  });

  it('delivers imported outputs as done with a note after cancelling remaining takes', async () => {
    build({ concurrency: 1 });
    vi.mocked(fal.status).mockImplementation(async (h) => ({ status: h.requestId === 'fal_1' ? 'COMPLETED' : 'IN_QUEUE' }));
    const job = await service.create(request({ model: 'flux-3-image', takes: 2 }), person);
    await waitFor(() => expect(service.get(job.id)?.outputs).toHaveLength(1));
    await waitFor(() => expect(fal.status).toHaveBeenCalledWith(handle('fal_2'), expect.any(AbortSignal)));
    const result = await service.cancel(job.id);
    expect(result).toMatchObject({ status: 'done', note: 'Cancelled after 1 of 2 takes', outputs: [expect.any(Object)] });
    expect(result?.error).toBeUndefined();
    expect(await records.spendToday()).toBeCloseTo(job.estimate.usd / 2);
  });

  it('continues permission and generation when every audit-log write fails, warning once', async () => {
    const log = new GenerationLog({ dir });
    vi.spyOn(log, 'record').mockRejectedValue(new Error('disk denied'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    build({ log });
    const job = await service.create(request(), agent);
    await done(job.id);
    expect(ask).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledExactlyOnceWith('Could not write the generation log.');
  });

  it('terminates an admitted job if regeneration bookkeeping fails', async () => {
    vi.spyOn(records, 'update').mockRejectedValueOnce(new Error('write failed'));
    const job = await service.create(request({ regenerateOf: 'gjob_old' }), agent);
    expect(job).toMatchObject({ status: 'failed', billed: false, error: { type: 'interrupted' } });
    expect(fal.submit).not.toHaveBeenCalled();
    expect((await service.status()).activeJobs).toBe(0);
  });

  it.each(['you', ' YOU ', 'You', '', '   '])('normalizes agent label %j to Agent', async (label) => {
    const job = await service.create(request(), { origin: 'agent', agent: label });
    expect(ask).toHaveBeenCalledWith(expect.objectContaining({ agent: 'Agent' }), expect.any(AbortSignal));
    expect(job.requestedBy.agent).toBe('Agent');
    await done(job.id);
  });
});

describe('review fixes: billing and timeouts', () => {
  const settle = async (check: () => Promise<boolean> | boolean) => {
    for (let i = 0; i < 20_000; i++) {
      if (await check()) return;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    throw new Error('The asynchronous operation did not settle.');
  };
  beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });

  it('discovers saved-key billing and preserves unresolved request shares at 60 seconds, 5 minutes and 20 minutes', async () => {
    vi.mocked(fal.testKey).mockResolvedValue({ valid: true, billing: true });
    const job = await service.create(request({ model: 'flux-3-image', takes: 3 }), person);
    await settle(() => emissions.some((e) => e.id === job.id && e.status === 'done'));
    expect(fal.testKey).toHaveBeenCalled();
    const share = job.estimate.usd / 3;
    vi.mocked(fal.billingEvents).mockResolvedValue([{ requestId: 'fal_1', endpointId: job.endpoint, costUsd: 0.01 }]);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(async () => (await records.get(job.id))?.billed === true);
    expect(await records.spendToday()).toBeCloseTo(0.01 + 2 * share);
    expect(service.get(job.id)?.actualUsd).toBeCloseTo(0.01 + 2 * share);
    vi.mocked(fal.billingEvents).mockResolvedValue([{ requestId: 'fal_2', endpointId: job.endpoint, costUsd: 0.02 }]);
    await vi.advanceTimersByTimeAsync(240_000);
    await settle(async () => Math.abs(((await records.get(job.id))?.actualUsd ?? 0) - (0.03 + share)) < 1e-8);
    expect((await service.quote(request())).spendTodayUsd).toBeCloseTo(0.03 + share);
    vi.mocked(fal.billingEvents).mockResolvedValue([{ requestId: 'fal_3', endpointId: job.endpoint, costUsd: 0.03 }]);
    await vi.advanceTimersByTimeAsync(900_000);
    await settle(async () => Math.abs(((await records.get(job.id))?.actualUsd ?? 0) - 0.06) < 1e-8);
    expect(fal.billingEvents).toHaveBeenCalledTimes(3);
    expect(await records.spendToday()).toBeCloseTo(0.06);
  });

  it.each(['failed', 'cancelled', 'interrupted'] as const)('reconciles %s requests without pressing Test', async (mode) => {
    vi.mocked(fal.testKey).mockResolvedValue({ valid: true, billing: true });
    if (mode === 'failed') vi.mocked(fal.result).mockResolvedValue({});
    else if (mode === 'cancelled') vi.mocked(fal.status).mockResolvedValue({ status: 'IN_PROGRESS' });
    const job = await service.create(request(), person);
    await settle(() => emissions.some((e) => e.id === job.id && e.status === (mode === 'failed' ? 'failed' : mode === 'cancelled' ? 'running' : 'done')));
    if (mode === 'cancelled') await service.cancel(job.id);
    if (mode === 'interrupted') {
      await records.update(job.id, (r) => { r.status = 'running'; });
      await rm(join(dir, 'generation-jobs.json'), { force: true });
      vi.clearAllTimers();
      records = new GenerationRecords({ dir });
      build();
      await service.init();
      await settle(async () => (await service.status()).key.billing === true);
      expect(await records.get(job.id)).toMatchObject({ failure: 'interrupted' });
    }
    vi.mocked(fal.billingEvents).mockResolvedValue([{ requestId: 'fal_1', endpointId: job.endpoint, costUsd: 0.12 }]);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(async () => (await records.get(job.id))?.actualUsd === 0.12);
    expect(await records.spendToday()).toBe(0.12);
    expect((await records.get(job.id))?.billed).toBe(true);
  });

  it('starts reconciliation after saving a billing-capable key', async () => {
    const job = await service.create(request(), person);
    await settle(() => emissions.some((e) => e.id === job.id && e.status === 'done'));
    vi.mocked(fal.testKey).mockResolvedValue({ valid: true, billing: true });
    await service.setKey('fal_billing');
    vi.mocked(fal.billingEvents).mockResolvedValue([{ requestId: 'fal_1', endpointId: job.endpoint, costUsd: 0.08 }]);
    await vi.advanceTimersByTimeAsync(60_000);
    await settle(async () => (await records.get(job.id))?.actualUsd === 0.08);
    expect(await records.spendToday()).toBe(0.08);
  });

  it('starts the job timeout at first submission and bounds local waiting separately', async () => {
    build({ concurrency: 1, jobTimeoutMs: 1000, queueTimeoutMs: 30 * 60_000 });
    vi.mocked(fal.status).mockResolvedValue({ status: 'IN_PROGRESS' });
    const first = await service.create(request(), person);
    await settle(() => service.get(first.id)?.status === 'running');
    await vi.advanceTimersByTimeAsync(500);
    const second = await service.create(request(), person);
    expect(service.get(second.id)?.falRequestIds).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(501);
    await settle(() => service.get(second.id)?.status === 'running');
    await vi.advanceTimersByTimeAsync(500);
    expect(service.get(second.id)?.status).toBe('running');
    await vi.advanceTimersByTimeAsync(501);
    await settle(() => service.get(second.id)?.status === 'failed');
    expect(service.get(second.id)?.error?.type).toBe('timeout');
  });

  it('expires locally queued jobs as unbilled without submitting them', async () => {
    build({ concurrency: 1, jobTimeoutMs: 5000, queueTimeoutMs: 1000 });
    vi.mocked(fal.status).mockResolvedValue({ status: 'IN_PROGRESS' });
    const first = await service.create(request(), person);
    await settle(() => service.get(first.id)?.status === 'running');
    const second = await service.create(request(), person);
    await vi.advanceTimersByTimeAsync(1001);
    await settle(async () => (await records.get(second.id))?.status === 'failed');
    expect(service.get(second.id)).toMatchObject({ billed: false, falRequestIds: [], error: { type: 'timeout' } });
    expect(fal.submit).toHaveBeenCalledTimes(1);
  });
});

// Phase B server behavior uses the shared router's video contract.
describe('video frames, references and imports', () => {
  const videoRequest = (settings: GenerateRequest['settings'], job: GenerateRequest['job'] = 'video.animate', takes = 1) => request({ job, settings, takes, policy: 'draft' });
  const confirm = { ...person, confirmed: true };
  beforeEach(async () => { await settings.update({ dailyBudgetUsd: 100 }); });
  const renderer = (size = 100) => vi.fn<NonNullable<Parameters<typeof createGenerationService>[0]['renderStill']>>(async ({ outputPath }) => { await writeFile(outputPath, Buffer.alloc(size)); });
  async function settle(id: string) {
    await waitFor(() => expect(['done', 'failed']).toContain(service.get(id)?.status));
    await waitFor(() => expect(emissions.some((e) => e.id === id && ['done', 'failed'].includes(e.status))).toBe(true));
  }
  async function asset(id: string, kind: 'image' | 'svg' | 'video', seconds = 5) {
    await writeFile(join(dir, id), Buffer.alloc(50));
    project!.assets[id] = { id, name: id, src: id, kind, mimeType: kind === 'video' ? 'video/mp4' : kind === 'svg' ? 'image/svg+xml' : 'image/png', durationInFrames: seconds * 60, fps: 60 };
  }
  it.each([2 * 1024 * 1024, 2 * 1024 * 1024 + 1])('renders each distinct project frame once across takes; JPEG size %i always uploads and removes the temp file', async (size) => {
    const renderStill = renderer(size);
    project!.width = 3840; project!.height = 2160;
    build({ renderStill });
    const job = await service.create(videoRequest({ start: { projectFrame: 0 }, end: { projectFrame: 0 }, durationSeconds: 5 }, 'video.between', 2), confirm);
    await settle(job.id);
    expect(renderStill).toHaveBeenCalledTimes(1);
    expect(renderStill).toHaveBeenCalledWith(expect.objectContaining({ frame: 0, scale: 0.5, imageFormat: 'jpeg', jpegQuality: 90 }));
    await expect(readFile(renderStill.mock.calls[0][0].outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fal.upload).toHaveBeenCalledWith(expect.any(Buffer), 'frame.jpg', 'image/jpeg');
    expect(JSON.stringify(vi.mocked(fal.submit).mock.calls)).not.toContain('data:');
    expect(fal.submit).toHaveBeenCalledTimes(2);
  });
  it('resolves keyframes in order and renders repeated frames only once', async () => {
    const renderStill = renderer();
    build({ renderStill });
    const job = await service.create(videoRequest({ durationSeconds: 5, keyframes: [{ frame: { projectFrame: 0 }, atSeconds: 0 }, { frame: { projectFrame: 1 }, atSeconds: 2 }, { frame: { projectFrame: 0 }, atSeconds: 4 }] }, 'video.keyframes'), confirm);
    await settle(job.id);
    expect(renderStill.mock.calls.map(([args]) => args.frame).sort()).toEqual([0, 1]);
    expect(fal.submit).toHaveBeenCalledTimes(1);
  });
  it('removes temporary rendered files when rendering fails', async () => {
    const renderStill = renderer();
    renderStill.mockImplementation(async ({ outputPath }) => { await writeFile(outputPath, 'partial'); throw new Error('renderer failed'); });
    build({ renderStill });
    const job = await service.create(videoRequest({ start: { projectFrame: 0 } }), confirm);
    await settle(job.id);
    await expect(readFile(renderStill.mock.calls[0][0].outputPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fal.submit).not.toHaveBeenCalled();
  });
  it('refuses closed projects, unavailable rendering and out-of-range project frames at admission', async () => {
    await expect(service.create(videoRequest({ start: { projectFrame: 0 } }), confirm)).rejects.toMatchObject({ status: 409, message: "Rendering frames isn't available on this server." });
    build({ renderStill: renderer() });
    await expect(service.create(videoRequest({ start: { projectFrame: 1_000_000 } }), confirm)).rejects.toMatchObject({ status: 409, message: 'Choose a frame within the open project.' });
    project = null;
    for (const start of [{ projectFrame: 0 }, { assetId: 'image' }]) await expect(service.create(videoRequest({ start }), confirm)).rejects.toMatchObject({ status: 409, message: 'Open the project first' });
    expect(fal.submit).not.toHaveBeenCalled();
  });
  it('splits reference images and SVGs from videos and always uploads video bytes', async () => {
    await asset('image', 'image'); await asset('vector', 'svg'); await asset('video', 'video');
    const job = await service.create(videoRequest({ referenceAssetIds: ['image', 'video', 'vector'], durationSeconds: 5 }, 'video.reference'), confirm);
    await settle(job.id);
    expect(fal.upload).toHaveBeenCalledTimes(3);
    expect(fal.upload).toHaveBeenCalledWith(expect.any(Buffer), 'video', 'video/mp4');
    const body = vi.mocked(fal.submit).mock.calls[0][1];
    expect(JSON.stringify(body)).not.toContain('data:');
    expect(JSON.stringify(body)).toContain('https://cdn.example.com/reference.png');
  });
  it.each([[16], [8, 8]])('rejects reference videos over the 15-second individual or total limit before submit: %j', async (...durations) => {
    const ids = durations.map((_, i) => `video${i}`);
    await Promise.all(ids.map((id, i) => asset(id, 'video', durations[i])));
    await expect(service.create(videoRequest({ referenceAssetIds: ids }, 'video.reference'), confirm)).rejects.toMatchObject({ status: 400, message: 'Reference videos must be at most 15 seconds in total.' });
    expect(fal.upload).not.toHaveBeenCalled();
    expect(fal.submit).not.toHaveBeenCalled();
  });
  it('prices reference seconds using asset fps and project fps as fallback', async () => {
    await asset('video', 'video', 6);
    const req = { ...videoRequest({ referenceAssetIds: ['video'], durationSeconds: 5 }, 'video.reference'), model: 'h3-max' };
    expect((await service.quote(req)).estimate.usd).toBe(1.28);
    project!.assets.video.fps = undefined;
    project!.assets.video.durationInFrames = 6 * project!.fps;
    expect((await service.quote(req)).estimate.usd).toBe(1.28);
  });
  it.each([['h3-max', 1.99, 60, 'at least 2 s'], ['wan-3-prime', 2, 15, 'at least 16 fps']] as const)('refuses incompatible %s clips at admission before any upload', async (model, seconds, fps, message) => {
    await asset('video', 'video', seconds);
    project!.assets.video.fps = fps;
    project!.assets.video.durationInFrames = seconds * fps;
    await expect(service.create({ ...videoRequest({ referenceAssetIds: ['video'] }, 'video.reference'), model }, confirm)).rejects.toMatchObject({ status: 400, message: expect.stringContaining(message) });
    expect(fal.upload).not.toHaveBeenCalled();
    expect(fal.submit).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
  });
  it('refuses reference video files over 200 MB before any frame or reference upload', async () => {
    await asset('image', 'image'); await asset('video', 'video');
    await truncate(join(dir, 'video'), 200 * 1024 * 1024 + 1);
    const req = videoRequest({ referenceAssetIds: ['image', 'video'] }, 'video.reference');
    await expect(service.create(req, confirm)).rejects.toMatchObject({ status: 400, message: 'Use a shorter or lighter clip (under 200 MB)' });
    expect(fal.upload).not.toHaveBeenCalled();
    expect(fal.submit).not.toHaveBeenCalled();
    await truncate(join(dir, 'video'), 200 * 1024 * 1024);
    await expect(service.quote(req)).resolves.toHaveProperty('estimate');
  });
  it('journals only uploaded URLs for video keyframes and references', async () => {
    await asset('image', 'image'); await asset('video', 'video');
    build({ renderStill: renderer() });
    vi.mocked(fal.status).mockImplementation(() => new Promise(() => undefined));
    const first = await service.create(videoRequest({ referenceAssetIds: ['image', 'video'], start: { projectFrame: 0 } }, 'video.reference'), confirm);
    const second = await service.create(videoRequest({ durationSeconds: 5, keyframes: [0, 2, 5].map((atSeconds) => ({ frame: { assetId: 'image' }, atSeconds })) }, 'video.keyframes'), confirm);
    await waitFor(() => expect(fal.status).toHaveBeenCalledTimes(2));
    const saved = await readFile(join(dir, 'generation-jobs.json'), 'utf8');
    expect(saved).not.toContain('data:');
    const rows = JSON.parse(saved);
    for (const id of [first.id, second.id]) expect(JSON.stringify(rows.find((row: { job: GenerationJob }) => row.job.id === id).resolvedReferences)).toContain('https://cdn.example.com/reference.png');
    expect(fal.upload).toHaveBeenCalledWith(expect.any(Buffer), 'frame.jpg', 'image/jpeg');
    expect(fal.upload).toHaveBeenCalledWith(expect.any(Buffer), 'image', 'image/png');
    expect(fal.upload).toHaveBeenCalledWith(expect.any(Buffer), 'video', 'video/mp4');
  });
  it.each([['flux-3-max', 4, 5], ['wan-3-prime', 2.4, 2]] as const)('checks %s output against submitted duration rather than requested %s seconds', async (model, durationSeconds, generatedSeconds) => {
    const mp4 = Buffer.alloc(128); mp4.write('ftyp', 4); mp4.write('isom', 8);
    network.connect = async () => ({ status: 200, headers: {}, body: Readable.from([mp4]) });
    network.probe = async () => ({ video: { width: 1920, height: 1080, fps: 24 }, audio: false, durationSeconds: generatedSeconds });
    vi.mocked(fal.result).mockResolvedValue({ video: { url: 'https://cdn.example.com/video.mp4' } });
    build();
    const job = await service.create({ ...videoRequest({ durationSeconds, aspectRatio: '16:9' }, 'video.generate'), model }, confirm);
    const result = await done(job.id);
    expect(vi.mocked(fal.submit).mock.calls[0][1].duration).toBe(generatedSeconds);
    expect((await records.get(job.id))?.checks[result.outputs[0].id]).toEqual({ matches: true, notes: [] });
  });
  it.each([false, true])('imports video probe fields, requests a proxy and records output checks (audio=%s)', async (hasAudio) => {
    const mp4 = Buffer.alloc(128); mp4.write('ftyp', 4); mp4.write('isom', 8);
    network.connect = async () => ({ status: 200, headers: {}, body: Readable.from([mp4]) });
    network.probe = async () => ({ video: { width: 1920, height: 1080, fps: 24 }, audio: hasAudio, durationSeconds: 5.7 });
    vi.mocked(fal.result).mockResolvedValue({ video: { url: 'https://cdn.example.com/video.mp4' }, seed: 7 });
    const requestProxy = vi.fn(async () => { throw new Error('proxy unavailable'); });
    build({ requestProxy });
    project!.fps = 30;
    const job = await service.create(videoRequest({ durationSeconds: 5, aspectRatio: '16:9' }, 'video.generate'), confirm);
    const result = await done(job.id);
    expect(result.outputs[0]).toMatchObject({ kind: 'video', fps: 24, hasAudio, durationInFrames: 171 });
    expect(requestProxy).toHaveBeenCalledWith(result.outputs[0].src);
    expect((await records.get(job.id))?.checks[result.outputs[0].id]).toEqual({ matches: !hasAudio, notes: hasAudio ? ['This video has its own audio track.'] : [] });
  });
  it('flags video duration and aspect outside tolerance', async () => {
    const mp4 = Buffer.alloc(128); mp4.write('ftyp', 4); mp4.write('isom', 8);
    network.connect = async () => ({ status: 200, headers: {}, body: Readable.from([mp4]) });
    network.probe = async () => ({ video: { width: 100, height: 100, fps: 30 }, audio: false, durationSeconds: 7 });
    vi.mocked(fal.result).mockResolvedValue({ video: { url: 'https://cdn.example.com/video.mp4' } });
    build();
    const job = await service.create(videoRequest({ durationSeconds: 5, aspectRatio: '16:9' }, 'video.generate'), confirm);
    const result = await done(job.id);
    expect((await records.get(job.id))?.checks[result.outputs[0].id]).toEqual({ matches: false, notes: ['Aspect ratio differs from the request by more than 2%.', 'Duration differs from the request by more than 10% or 0.8 seconds.'] });
  });
  it('sets the video deadline to 30 minutes from submission and images to 15', async () => {
    const timer = vi.spyOn(globalThis, 'setTimeout');
    vi.mocked(fal.status).mockImplementation(() => new Promise(() => undefined));
    const video = await service.create(videoRequest({ durationSeconds: 5 }, 'video.generate'), confirm);
    await waitFor(() => expect(fal.status).toHaveBeenCalled());
    expect(timer.mock.calls.some(([, ms]) => ms !== undefined && ms > 29 * 60_000 && ms <= 30 * 60_000)).toBe(true);
    await service.cancel(video.id);
    timer.mockClear();
    await service.create(request(), person);
    await waitFor(() => expect(fal.status).toHaveBeenCalledTimes(2));
    expect(timer.mock.calls.some(([, ms]) => ms !== undefined && ms > 14 * 60_000 && ms <= 15 * 60_000)).toBe(true);
  });
});

describe('durable generation runtime', () => {
  const journal = () => readFile(join(dir, 'generation-jobs.json'), 'utf8');
  // Capture an abrupt process exit, then stop the old instance before restoring those bytes.
  async function restart() {
    const saved = await journal();
    const ledger = await readFile(join(dir, 'generation-records.json'), 'utf8');
    for (const job of service.list()) await service.cancel(job.id);
    await writeFile(join(dir, 'generation-jobs.json'), saved);
    await writeFile(join(dir, 'generation-records.json'), ledger);
    records = new GenerationRecords({ dir });
    build();
    await service.init();
  }
  it('persists private handles without the key, resumes polling without submit, holds the budget and lists outputs after another restart', async () => {
    vi.mocked(fal.status).mockImplementation(() => new Promise(() => undefined)).mockResolvedValueOnce({ status: 'IN_PROGRESS' });
    const job = await service.create(request(), person);
    await waitFor(() => expect(fal.status).toHaveBeenCalled());
    await waitFor(() => expect(fal.status).toHaveBeenCalledTimes(2));
    const saved = JSON.parse(await journal());
    expect(saved[0]).toMatchObject({ job: { id: job.id }, requests: [{ handle: handle('fal_1'), lastStatus: 'IN_PROGRESS', attempted: true, estimateUsd: 0.5, takeIndex: 0 }] });
    expect(await journal()).not.toContain('fal_test-key');
    const { stat } = await import('node:fs/promises');
    expect((await stat(join(dir, 'generation-jobs.json'))).mode & 0o777).toBe(0o600);
    await settings.update({ dailyBudgetUsd: 0.75 });
    await restart();
    expect(service.get(job.id)).toMatchObject({ status: 'running', note: 'Resumed after a restart' });
    expect(await records.get(job.id)).toMatchObject({ status: 'running' });
    expect((await records.get(job.id))?.failure).toBeUndefined();
    expect((await service.quote(request())).overBudget).toBe(true);
    expect(fal.submit).toHaveBeenCalledTimes(1);
    // Restart again with a provider that can finish the already existing handle.
    vi.mocked(fal.status).mockResolvedValue({ status: 'COMPLETED' });
    await restart();
    const result = await done(job.id);
    expect(result.outputs).toHaveLength(1);
    expect(service.list(project!.id)[0]).toMatchObject({ id: job.id, delivered: false });
    expect(fal.submit).toHaveBeenCalledTimes(1);
    await service.delivered(job.id);
    await waitFor(async () => expect(JSON.parse(await journal())[0].job.delivered).toBe(true));
    await restart();
    expect(service.list(project!.id)[0]).toMatchObject({ id: job.id, status: 'done', delivered: true, outputs: result.outputs });
  });
  it.each(['queued', 'awaiting-permission'] as const)('ends persisted %s jobs that never submitted unbilled', async (status) => {
    const job = await service.create(request(), person);
    await done(job.id);
    const saved = JSON.parse(await journal());
    saved[0].job = { ...saved[0].job, status, outputs: [], falRequestIds: [], finishedAt: undefined };
    saved[0].requests = [{ estimateUsd: 0.5 }];
    await writeFile(join(dir, 'generation-jobs.json'), JSON.stringify(saved));
    await restart();
    expect(service.get(job.id)).toMatchObject({ status: status === 'queued' ? 'failed' : 'denied', billed: false });
    expect(await records.spendToday()).toBe(0);
    expect(fal.submit).toHaveBeenCalledTimes(1);
  });
  it('keeps the original submission deadline on recovery', async () => {
    vi.mocked(fal.status).mockImplementation(() => new Promise(() => undefined));
    const job = await service.create(request(), person);
    await waitFor(() => expect(fal.status).toHaveBeenCalled());
    const saved = JSON.parse(await journal());
    saved[0].firstSubmittedAt = Date.now() - 16 * 60_000;
    await writeFile(join(dir, 'generation-jobs.json'), JSON.stringify(saved));
    await restart();
    expect(service.get(job.id)).toMatchObject({ status: 'failed', error: { type: 'timeout' } });
    expect(fal.submit).toHaveBeenCalledTimes(1);
  });
  it('resumes locally queued sibling takes using saved references without an open project', async () => {
    build({ concurrency: 1 });
    vi.mocked(fal.status).mockImplementation(() => new Promise(() => undefined));
    const job = await service.create(request({ model: 'flux-3-image', takes: 3 }), person);
    await waitFor(() => expect(fal.status).toHaveBeenCalled());
    expect(fal.submit).toHaveBeenCalledTimes(1);
    project = null;
    vi.mocked(fal.status).mockResolvedValue({ status: 'COMPLETED' });
    await restart();
    expect((await done(job.id)).outputs).toHaveLength(3);
    expect(fal.submit).toHaveBeenCalledTimes(3);
  });
  it('skips previously imported outputs when restoring a partially imported provider result', async () => {
    vi.mocked(fal.result).mockResolvedValue({ images: [{ url: 'https://cdn.example.com/one.png' }, { url: 'https://cdn.example.com/two.png' }] });
    const job = await service.create(request({ takes: 2 }), person);
    const completed = await done(job.id);
    const saved = JSON.parse(await journal());
    saved[0].job.status = 'importing';
    saved[0].job.outputs = [completed.outputs[0]];
    delete saved[0].job.finishedAt;
    saved[0].requests[0].completed = false;
    saved[0].requests[0].importedCount = 1;
    await writeFile(join(dir, 'generation-jobs.json'), JSON.stringify(saved));
    await restart();
    const result = await done(job.id);
    expect(result.outputs).toHaveLength(2);
    expect(result.outputs[0].id).toBe(completed.outputs[0].id);
    expect(result.outputs[1].id).not.toBe(completed.outputs[1].id);
    expect(fal.submit).toHaveBeenCalledTimes(1);
  });
  it('retains at most 200 recent terminal jobs and expires results older than 24 hours', async () => {
    const job = await service.create(request(), person);
    await done(job.id);
    const [saved] = JSON.parse(await journal());
    const clock = Date.now();
    const rows = Array.from({ length: 202 }, (_, index) => ({ ...saved, job: { ...saved.job, id: `gjob_${index}`, createdAt: clock - index, finishedAt: index === 201 ? clock - 86_400_001 : clock } }));
    await writeFile(join(dir, 'generation-jobs.json'), JSON.stringify(rows));
    await restart();
    const retained = JSON.parse(await journal());
    expect(retained).toHaveLength(200);
    expect(retained.map((r: { job: GenerationJob }) => r.job.id)).not.toContain('gjob_201');
    expect(retained.map((r: { job: GenerationJob }) => r.job.id)).not.toContain('gjob_200');
  }, 20_000);
  it('redacts a key embedded in the original request even after the key is removed', async () => {
    vi.mocked(fal.status).mockImplementation(() => new Promise(() => undefined));
    const job = await service.create(request({ prompt: 'A kite fal_test-key' }), person);
    await waitFor(() => expect(fal.status).toHaveBeenCalled());
    await service.removeKey();
    await service.cancel(job.id);
    expect(await journal()).not.toContain('fal_test-key');
  });

  it('resumes a 20-minute-old video but times it out at the original 30-minute deadline', async () => {
    vi.mocked(fal.status).mockImplementation(() => new Promise(() => undefined));
    const job = await service.create(request({ job: 'video.generate', policy: 'draft', settings: { durationSeconds: 5 } }), { ...person, confirmed: true });
    await waitFor(() => expect(fal.status).toHaveBeenCalled());
    const saved = JSON.parse(await journal());
    saved[0].firstSubmittedAt = Date.now() - 20 * 60_000;
    await writeFile(join(dir, 'generation-jobs.json'), JSON.stringify(saved));
    await restart();
    expect(service.get(job.id)?.status).toBe('running');
    const aged = JSON.parse(await journal());
    aged[0].firstSubmittedAt = Date.now() - 30 * 60_000 - 1;
    await writeFile(join(dir, 'generation-jobs.json'), JSON.stringify(aged));
    await restart();
    expect(service.get(job.id)).toMatchObject({ status: 'failed', error: { type: 'timeout' } });
    expect(fal.submit).toHaveBeenCalledTimes(1);
  });

});


describe('BF1 journal failure and cancellation regressions', () => {
  it.each(['parse', 'read'] as const)('quarantines a journal %s failure and recovers conservative spend from records', async (failure) => {
    const job = await service.create(request(), person);
    await done(job.id);
    await records.update(job.id, (r) => { r.status = 'running'; r.liabilityUsd = undefined; });
    const path = join(dir, 'generation-jobs.json');
    await rm(path);
    if (failure === 'parse') await writeFile(path, '{truncated private content');
    else await mkdir(path);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    build();
    await expect(service.init()).resolves.toBeUndefined();
    await service.init();
    expect((await readdir(dir)).filter((name) => name.startsWith('generation-jobs.corrupt-'))).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain(path);
    expect(warn.mock.calls[0][0]).not.toContain('private content');
    expect(await records.get(job.id)).toMatchObject({ status: 'failed', failure: 'interrupted', liabilityUsd: 0.5 });
    expect((await service.status()).spendTodayUsd).toBe(0.5);
    const next = await service.create(request(), person);
    await done(next.id);
  });
  it('retries initialization after a rejected dependency instead of caching rejection', async () => {
    vi.spyOn(records, 'recover').mockRejectedValueOnce(new Error('disk temporarily unavailable'));
    await expect(service.init()).rejects.toThrow('disk temporarily unavailable');
    await expect(service.init()).resolves.toBeUndefined();
    const job = await service.create(request(), person);
    await done(job.id);
  });
  it('releases liability when cancellation lands between the attempted journal and submit', async () => {
    const update = records.update.bind(records);
    let entered!: () => void;
    const atAttempt = new Promise<void>((resolve) => { entered = resolve; });
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    let held = false;
    vi.spyOn(records, 'update').mockImplementation(async (id, fn) => {
      const value = await update(id, fn);
      if (!held && value?.requests?.some((r) => r.attempted) && value.status === 'queued') {
        held = true; entered(); await paused;
      }
      return value;
    });
    const job = await service.create(request(), person);
    await atAttempt;
    await service.cancel(job.id);
    resume();
    await done(job.id, 'cancelled');
    expect(fal.submit).not.toHaveBeenCalled();
    expect(await records.get(job.id)).toMatchObject({ liabilityUsd: 0, requests: [{ attempted: true, costUsd: 0 }] });
    expect((await service.status()).spendTodayUsd).toBe(0);
  });
  it('keeps ambiguous attempted-without-handle crash liability after restart', async () => {
    const job = await service.create(request(), person);
    await done(job.id);
    const saved = JSON.parse(await readFile(join(dir, 'generation-jobs.json'), 'utf8'));
    saved[0].job.status = 'queued'; saved[0].job.outputs = []; saved[0].job.finishedAt = undefined;
    saved[0].requests = [{ estimateUsd: 0.5, attempted: true }];
    await writeFile(join(dir, 'generation-jobs.json'), JSON.stringify(saved));
    build(); await service.init();
    expect(service.get(job.id)).toMatchObject({ status: 'failed' });
    expect((await service.status()).spendTodayUsd).toBe(0.5);
    expect(fal.submit).toHaveBeenCalledTimes(1);
  });
  it.each(['journal', 'records'] as const)('surfaces delivered %s write failure and supports a durable retry', async (failure) => {
    const job = await service.create(request(), person);
    await done(job.id);
    const path = join(dir, 'generation-jobs.json');
    if (failure === 'journal') { await rm(path); await mkdir(path); }
    else vi.spyOn(records, 'update').mockRejectedValueOnce(new Error('records write failed'));
    await expect(service.delivered(job.id)).rejects.toThrow();
    expect(service.get(job.id)?.delivered).toBe(false);
    if (failure === 'journal') await rm(path, { recursive: true });
    else expect(JSON.parse(await readFile(path, 'utf8'))[0].job.delivered).toBe(false);
    expect((await service.delivered(job.id))?.delivered).toBe(true);
    expect(JSON.parse(await readFile(path, 'utf8'))[0].job.delivered).toBe(true);
    expect((await records.get(job.id))?.delivered).toBe(true);
  });
  it('does not rewrite either journal on queue-position-only polls but persists transitions', async () => {
    let tick = 0;
    let advance!: () => void;
    vi.mocked(fal.status).mockImplementation(async () => {
      tick++;
      if (tick === 1) return { status: 'IN_QUEUE', queuePosition: 8 };
      if (tick === 2) { await new Promise<void>((resolve) => { advance = resolve; }); return { status: 'IN_QUEUE', queuePosition: 7 }; }
      if (tick === 3) { await new Promise<void>((resolve) => { advance = resolve; }); return { status: 'IN_PROGRESS' }; }
      return new Promise(() => undefined);
    });
    const job = await service.create(request(), person);
    await waitFor(() => expect(tick).toBe(2));
    const path = join(dir, 'generation-jobs.json');
    const before = await stat(path);
    const bytes = await readFile(path, 'utf8');
    const ledger = vi.spyOn(records, 'update');
    advance();
    await waitFor(() => expect(tick).toBe(3));
    expect(service.get(job.id)?.queuePosition).toBe(7);
    expect(await readFile(path, 'utf8')).toBe(bytes);
    expect((await stat(path)).ino).toBe(before.ino);
    expect(ledger).not.toHaveBeenCalled();
    advance();
    await waitFor(() => expect(tick).toBe(4));
    expect(JSON.parse(await readFile(path, 'utf8'))[0].job.status).toBe('running');
    expect(ledger).toHaveBeenCalled();
  });
});

describe('Phase C scene audio', () => {
  const lines = [
    { sceneId: 'scene_a', text: 'Hello world' },
    { sceneId: 'scene_b', text: 'Hi there' },
    { sceneId: 'scene_c', text: 'Unknown timing' },
  ];
  function audio(seconds = 9) {
    const mp3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
    network.connect = async () => ({ status: 200, headers: {}, body: Readable.from([mp3]) });
    network.probe = async () => ({ durationSeconds: seconds, audio: true });
    vi.mocked(fal.result).mockResolvedValue({ audio: { url: 'https://cdn.example.com/music.mp3' } });
  }
  it.each([1, 2])('imports three narration lines with %i take(s) each and persists scene tags and optional word timing', async (takes) => {
    audio();
    const textByRequest = new Map<string, string>();
    vi.mocked(fal.submit).mockImplementation(async (_endpoint, input) => {
      const id = `fal_${textByRequest.size}`;
      textByRequest.set(id, String(input.text));
      return handle(id);
    });
    vi.mocked(fal.result).mockImplementation(async (h) => {
      const text = textByRequest.get(h.requestId);
      return { audio: { url: 'https://cdn.example.com/voice.mp3' }, timestamps: text === 'Hello world'
        ? [{ word: 'Hello', start: 0, end: 0.4 }, { text: 'world', start_time: 0.5, end_time: 0.9 }]
        : text === 'Hi there' ? { characters: [...'Hi there'], character_start_times_seconds: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7], character_end_times_seconds: [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] }
        : { unexpected: true } };
    });
    build();
    const job = await service.create(request({ job: 'voice.narration', takes, settings: { lines } }), person);
    const result = await done(job.id);
    expect(fal.submit).toHaveBeenCalledTimes(3 * takes);
    expect(result.outputs).toHaveLength(3 * takes);
    expect(result.takes).toBe(3 * takes);
    for (const asset of result.outputs) {
      const sceneId = asset.provenance?.providerRefs?.sceneId;
      const words = sceneId === 'scene_a' ? [{ text: 'Hello', start: 0, end: 0.4 }, { text: 'world', start: 0.5, end: 0.9 }]
        : sceneId === 'scene_b' ? [{ text: 'Hi', start: 0, end: 0.2 }, { text: 'there', start: 0.3, end: 0.8 }] : undefined;
      expect(lines.some((line) => line.sceneId === sceneId)).toBe(true);
      expect(result.outputMeta?.[asset.id]).toEqual({ sceneId, ...(words ? { words } : {}) });
    }
    const journal = JSON.parse(await readFile(join(dir, 'generation-jobs.json'), 'utf8'));
    expect(journal[0].job.outputMeta).toEqual(result.outputMeta);
    build();
    await service.init();
    expect(service.get(job.id)?.outputMeta).toEqual(result.outputMeta);
  });

  it('retains the long narration liability after an unbilled short-line failure and refuses overspend', async () => {
    audio();
    await settings.update({ dailyBudgetUsd: 0.4 });
    vi.mocked(fal.status).mockImplementation(async (h) => h.requestId === 'fal_2'
      ? { status: 'COMPLETED', errorType: 'runner_server_error' } : { status: 'COMPLETED' });
    build();
    const job = await service.create(request({ job: 'voice.narration', prompt: '', settings: { lines: [{ sceneId: 'scene_a', text: 'a'.repeat(4900) }, { sceneId: 'scene_b', text: 'b'.repeat(100) }] } }), person);
    await done(job.id);
    expect((await records.get(job.id))?.requests?.map((r) => r.estimateUsd)).toEqual([0.392, 0.008]);
    expect(await records.spendToday()).toBeCloseTo(0.392);
    await expect(service.create(request({ job: 'voice.line', prompt: 'x'.repeat(2500) }), person)).rejects.toMatchObject({ status: 402 });
  });
  it('preserves unequal narration reservations through restart and releases only queued cancellations', async () => {
    audio();
    vi.mocked(fal.status).mockImplementation(async (h) => ({ status: h.requestId === 'fal_1' ? 'IN_PROGRESS' : 'IN_QUEUE' }));
    build();
    const job = await service.create(request({ job: 'voice.narration', prompt: '', settings: { lines: [{ sceneId: 'scene_a', text: 'a'.repeat(4900) }, { sceneId: 'scene_b', text: 'b'.repeat(100) }] } }), person);
    await waitFor(async () => {
      const saved = JSON.parse(await readFile(join(dir, 'generation-jobs.json'), 'utf8'))[0];
      expect(saved.requests.map((r: { lastStatus?: string }) => r.lastStatus)).toEqual(['IN_PROGRESS', 'IN_QUEUE']);
    });
    const journal = await readFile(join(dir, 'generation-jobs.json'), 'utf8');
    const ledger = await readFile(join(dir, 'generation-records.json'), 'utf8');
    await service.cancel(job.id);
    expect(await records.spendToday()).toBeCloseTo(0.392);
    await writeFile(join(dir, 'generation-jobs.json'), journal);
    await writeFile(join(dir, 'generation-records.json'), ledger);
    records = new GenerationRecords({ dir });
    build();
    await service.init();
    expect((await records.get(job.id))?.requests?.map((r) => r.estimateUsd)).toEqual([0.392, 0.008]);
    await settings.update({ dailyBudgetUsd: 0.4 });
    expect((await service.quote(request({ job: 'voice.line', prompt: 'x'.repeat(100) }))).overBudget).toBe(true);
    await service.cancel(job.id);
    expect(await records.spendToday()).toBeCloseTo(0.392);
    expect(fal.submit).toHaveBeenCalledTimes(2);
  });

  it.each([9, 7])('analyzes scored beds at project fps against admission cuts and checks %i s output duration', async (seconds) => {
    audio(seconds);
    project!.fps = 24;
    project!.scenes = lines.map((line) => ({ ...project!.scenes[0], id: line.sceneId, durationInFrames: 72 }));
    const beats = vi.fn(async (_dir: string, src: string, fps: number) => ({ src, fps, durationSeconds: seconds, durationInFrames: seconds * fps, bpm: 120, confidence: 1, beats: [], downbeats: [0, 74, 143], strong: [], onsets: [] }));
    // Editing the open project while fal runs must not move this job's admission cuts.
    vi.mocked(fal.result).mockImplementation(async () => {
      project!.scenes[0].durationInFrames = 240;
      return { audio: { url: 'https://cdn.example.com/score.mp3' } };
    });
    build({ beats });
    const job = await service.create(request({ job: 'music.scored', settings: { score: lines.map((line) => ({ sceneIds: [line.sceneId], seconds: 3, styles: [] })) } }), person);
    const result = await done(job.id);
    const asset = result.outputs[0];
    expect(beats).toHaveBeenCalledWith(dir, asset.src, 24);
    expect(result.outputMeta?.[asset.id]).toEqual({ bpm: 120, downbeats: [0, 74, 143], cuts: [
      { sceneId: 'scene_b', cutFrame: 72, nearestDownbeatFrame: 74, offsetFrames: 2 },
      { sceneId: 'scene_c', cutFrame: 144, nearestDownbeatFrame: 143, offsetFrames: -1 },
    ] });
    expect((await records.get(job.id))?.checks[asset.id].matches).toBe(seconds === 9);
    expect(JSON.parse(await readFile(join(dir, 'generation-jobs.json'), 'utf8'))[0].job.outputMeta).toEqual(result.outputMeta);
  });
  it('resumes scored-bed analysis using saved admission timing with no open project', async () => {
    audio();
    project!.fps = 24;
    project!.scenes = lines.map((line) => ({ ...project!.scenes[0], id: line.sceneId, durationInFrames: 72 }));
    vi.mocked(fal.status).mockImplementation(() => new Promise(() => undefined)).mockResolvedValueOnce({ status: 'IN_PROGRESS' });
    const beats = vi.fn(async (_dir: string, src: string, fps: number) => ({ src, fps, durationSeconds: 9, durationInFrames: 216, bpm: 120, confidence: 1, beats: [], downbeats: [72, 144], strong: [], onsets: [] }));
    build({ beats });
    const job = await service.create(request({ job: 'music.scored', settings: { score: lines.map((line) => ({ sceneIds: [line.sceneId], seconds: 3, styles: [] })) } }), person);
    await waitFor(() => expect(fal.status).toHaveBeenCalledTimes(2));
    const journal = await readFile(join(dir, 'generation-jobs.json'), 'utf8');
    const ledger = await readFile(join(dir, 'generation-records.json'), 'utf8');
    const snapshot = JSON.parse(journal)[0].scoreProject;
    expect(snapshot).toMatchObject({ fps: 24, assets: {}, audio: [], scenes: [{ id: 'scene_a', durationInFrames: 72, elements: [] }, { id: 'scene_b' }, { id: 'scene_c' }] });
    await service.cancel(job.id);
    await writeFile(join(dir, 'generation-jobs.json'), journal);
    await writeFile(join(dir, 'generation-records.json'), ledger);
    project = null;
    records = new GenerationRecords({ dir });
    vi.mocked(fal.status).mockResolvedValue({ status: 'COMPLETED' });
    build({ beats });
    await service.init();
    const result = await done(job.id);
    expect(fal.submit).toHaveBeenCalledOnce();
    const asset = result.outputs[0];
    expect(asset.durationInFrames).toBe(216);
    expect(beats).toHaveBeenCalledWith(dir, asset.src, 24);
    expect(result.outputMeta?.[asset.id]?.cuts?.map((cut) => cut.cutFrame)).toEqual([72, 144]);
  });

  it('completes a scored bed without cuts when beat analysis fails', async () => {
    audio();
    const beats = vi.fn(async () => { throw new Error('No decoder'); });
    build({ beats });
    const job = await service.create(request({ job: 'music.scored', settings: { score: [{ sceneIds: ['scene_a'], seconds: 9, styles: [] }] } }), person);
    const result = await done(job.id);
    expect(beats).toHaveBeenCalledOnce();
    expect(result.outputs).toHaveLength(1);
    expect(result.error).toBeUndefined();
    expect(result.outputMeta?.[result.outputs[0].id]?.cuts).toBeUndefined();
  });
});

describe('measured generation routing', () => {
  async function seed() {
    for (const [model, actualUsd] of [['gpt-image-2.5-flare', 0.5], ['seedream-5-pro', 0.1]] as const) {
      for (let i = 0; i < 20; i++) {
        await records.add({ id: `${model}_${i}`, at: 1, day: '2020-01-01', projectId: `other_project_${i}`, job: 'image.generate', model,
          endpoint: MODELS[model].endpoints['image.generate']!, routeVersion: ROUTE_VERSION, policy: 'quality', overridden: model === 'seedream-5-pro',
          settings: {}, takes: 1, origin: 'user', status: 'done', requests: [{ requestId: `${model}_${i}`, estimateUsd: actualUsd }], estimateUsd: actualUsd, actualUsd, costSource: 'billing', billed: true,
          outputs: ['asset'], checks: { asset: { matches: true, notes: [] } }, outcomes: { auditioned: ['asset'], used: ['asset'], kept: ['asset'], replaced: [], deleted: [] }, thumbs: { asset: 1 }, regenerations: 0 });
      }
    }
  }
  it('uses all projects for a cheaper suggestion and Balanced follows it', async () => {
    await seed();
    const board = await service.scoreboard();
    expect(board.rows).toHaveLength(2);
    expect(board.rows.map((row) => row.runs)).toEqual([20, 20]);
    expect(board.suggestions).toContainEqual(expect.objectContaining({ job: 'image.generate', from: 'gpt-image-2.5-flare', to: 'seedream-5-pro', kind: 'cheaper' }));
    expect((await service.quote(request({ policy: 'balanced' }))).route.model).toBe('seedream-5-pro');
    expect((await service.quote(request({ policy: 'quality' }))).route.model).toBe('gpt-image-2.5-flare');
    expect(JSON.parse(await readFile(join(dir, 'generation-stats.json'), 'utf8'))).toEqual(board);
  });
  it('persists dismissals and immediately stops Balanced following them', async () => {
    await seed();
    expect((await service.quote(request({ policy: 'balanced' }))).route.model).toBe('seedream-5-pro');
    expect((await service.dismissSuggestion('image.generate', 'seedream-5-pro')).suggestions).toEqual([]);
    expect((await service.quote(request({ policy: 'balanced' }))).route.model).toBe('gpt-image-2.5-flare');
    build();
    expect((await service.scoreboard()).suggestions).toEqual([]);
    expect((await service.quote(request({ policy: 'balanced' }))).route.model).toBe('gpt-image-2.5-flare');
  });
  it('keeps models, quotes and admission working when stats writes fail, logging once', async () => {
    await seed();
    await mkdir(join(dir, 'generation-stats.json'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect((await service.quote(request({ policy: 'balanced' }))).route.model).toBe('seedream-5-pro');
    await expect(service.models()).resolves.toHaveProperty('jobs');
    await service.setRouteOverride('image.generate', 'seedream-5-pro');
    const job = await service.create(request(), person);
    await done(job.id);
    expect(warn).toHaveBeenCalledOnce();
  });
  it('coalesces changed records for a minute and does not recompute unchanged records', async () => {
    let clock = Date.now();
    build({ now: () => clock });
    await service.init();
    const all = vi.spyOn(records, 'all');
    expect((await service.scoreboard()).rows).toEqual([]);
    await seed();
    await Promise.all([service.scoreboard(), service.scoreboard()]);
    expect(all).toHaveBeenCalledTimes(1);
    clock += 60_000;
    expect((await service.scoreboard()).rows).toHaveLength(2);
    expect(all).toHaveBeenCalledTimes(2);
    clock += 60_000;
    await service.scoreboard();
    expect(all).toHaveBeenCalledTimes(2);
    await service.setRouteOverride('image.generate', 'seedream-5-pro');
    expect(all).toHaveBeenCalledTimes(3);
    expect((await service.quote(request())).route.model).toBe('seedream-5-pro');
  });
});
