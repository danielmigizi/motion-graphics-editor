// Whole-app key containment through HTTP, editor SSE, permissions and disk.

import { IncomingMessage, ServerResponse, request as httpRequest, type ClientRequest, type RequestOptions } from 'node:http';
import { Socket } from 'node:net';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GENERATION_JOB_EVENT, type GenerationJob } from '../../src/core/generationStudio';
import { MODELS } from '../../src/core/generationRoutes';
import { newId } from '../../src/core/ids';
import { sampleProject } from '../../src/sample/sampleProject';
import { childEnv } from '../agents/shared';
import { createApp } from '../app';
import { EditorSession } from '../session';
import { EditorBridge } from '../bridge';
import { GenerationLog } from '../generation-log';
import { createProjectStore } from '../projects';
import { RenderManager } from '../renders';
import { connectFakeEditor, type FakeEditor } from '../testing/fakeEditor';
import { createKeyStore, GenerationSettingsStore } from './config';
import { createFalClient, FalError } from './fal';
import { cachedGenerationKeys, createGenerationService, type GenerationService } from './jobs';
import { GenerationRecords } from './records';


// The sandbox cannot bind loopback sockets. Retain the real Express request,
// response and SSE paths and fake editor, with only HTTP's socket replaced.
const transport = vi.hoisted(() => ({ request: undefined as unknown as typeof httpRequest }));
vi.mock('node:http', async (original) => {
  const http = await original<typeof import('node:http')>();
  return { ...http, request: (...args: unknown[]) => Reflect.apply(transport.request, undefined, args) };
});

function virtualRequest(options: RequestOptions, callback?: (res: IncomingMessage) => void): ClientRequest {
  const incoming = new IncomingMessage(new Socket());
  incoming.method = options.method ?? 'GET';
  incoming.url = options.path ?? '/';
  incoming.headers = { host: `127.0.0.1:${options.port}`, ...Object.fromEntries(Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])) } as IncomingMessage['headers'];
  const response = new ServerResponse(incoming);
  let received: PassThrough | undefined;
  const client = new EventEmitter() as ClientRequest;
  const headers = () => {
    if (received) return received;
    received = new PassThrough();
    Object.assign(received, { statusCode: response.statusCode, headers: response.getHeaders() });
    // Match headersSent, which Express uses to avoid a second error response.
    Object.defineProperty(response, 'headersSent', { configurable: true, value: true });
    callback?.(received as unknown as IncomingMessage);
    return received;
  };
  response.flushHeaders = () => { headers(); };
  response.write = ((chunk: string | Buffer, encoding?: BufferEncoding | (() => void), cb?: () => void) => {
    headers().write(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    (typeof encoding === 'function' ? encoding : cb)?.();
    return true;
  }) as typeof response.write;
  response.end = ((chunk?: string | Buffer, encoding?: BufferEncoding | (() => void), cb?: () => void) => {
    const stream = headers();
    if (chunk) stream.write(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    response.finished = true;
    stream.end();
    response.emit('finish');
    (typeof encoding === 'function' ? encoding : cb)?.();
    return response;
  }) as typeof response.end;
  client.end = ((body?: string | Buffer) => {
    if (body !== undefined) incoming.headers['content-length'] = String(Buffer.byteLength(body));
    queueMicrotask(() => {
      app(incoming, response);
      if (body !== undefined) incoming.push(body);
      incoming.complete = true;
      incoming.push(null);
    });
    return client;
  }) as typeof client.end;
  client.destroy = (() => {
    response.destroyed = true;
    response.emit('close');
    incoming.destroy();
    received?.destroy();
    return client;
  }) as typeof client.destroy;
  return client;
}

const SENTINEL = 'fal_LEAKSENTINEL_9f8e7d6c5b4a3210';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const origin = 'http://localhost:5917';
let root: string;
let port: number;
let bridge: EditorBridge;
let editor: FakeEditor | undefined;
let generation: GenerationService;
let records: GenerationRecords;
let renders: RenderManager;
let responses: string[];
let events: string[];
let emitted: GenerationJob[];
let rejectSubmit: boolean;
let hold: boolean;
let fetchFake: ReturnType<typeof vi.fn<typeof fetch>>;
let logs: ReturnType<typeof vi.spyOn>[];
let cookie: string;
let tabSecret: string;
let app: ReturnType<typeof createApp>;

function send(method: string, path: string, body?: unknown, editorOrigin: boolean | string = true): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { 'Content-Type': 'application/json', ...(editorOrigin ? { Origin: typeof editorOrigin === 'string' ? editorOrigin : origin, ...(editorOrigin === true ? { Cookie: cookie, 'X-MGE-Tab': tabSecret } : {}) } : {}) } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => { responses.push(text); resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
const reqBody = () => ({ job: 'image.cutout', prompt: 'A paper kite', projectId: sampleProject.id, settings: { aspectRatio: '1:1' } });
async function terminal(id: string, status = 'done') {
  await vi.waitFor(() => expect(emitted.some((job) => job.id === id && job.status === status)).toBe(true), { timeout: 4000, interval: 5 });
  return (await send('GET', `/api/generation/jobs/${id}`)).body as GenerationJob;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mge-leaks-'));
  responses = []; events = []; emitted = []; rejectSubmit = false; hold = false;
  logs = ['warn', 'error', 'log'].map((key) => vi.spyOn(console, key as 'warn' | 'error' | 'log').mockImplementation(() => undefined));
  bridge = new EditorBridge();
  const connect = bridge.connect.bind(bridge);
  vi.spyOn(bridge, 'connect').mockImplementation((res) => {
    const write = res.write;
    vi.spyOn(res, 'write').mockImplementation((...args: any[]) => {
      events.push(String(args[0]));
      return Reflect.apply(write, res, args);
    });
    return connect(res);
  });
  const prices = Object.fromEntries(Object.values(MODELS).flatMap((m) => Object.values(m.endpoints).map((endpoint) => [endpoint, m.price])));
  let sequence = 0;
  fetchFake = vi.fn<typeof fetch>(async (raw, init) => {
    const url = new URL(String(raw));
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
    if (url.pathname.endsWith('/models/pricing')) return json({ prices: (url.searchParams.get('endpoint_id') ?? '').split(',').map((id) => ({ endpoint_id: id, unit_price: prices[id]?.usd ?? 0.025, unit: prices[id]?.unit ?? 'units', currency: 'USD' })) });
    if (url.pathname.endsWith('/models/billing-events')) return json({ detail: 'Billing permission is unavailable.' }, 403);
    if (init?.method === 'POST') {
      if (rejectSubmit) return json({ detail: `Refused ${new Headers(init.headers).get('Authorization')}` }, 401);
      const id = `request_${++sequence}`;
      return json({ request_id: id, status_url: `https://queue.fal.run/requests/${id}/status`, response_url: `https://queue.fal.run/requests/${id}`, cancel_url: `https://queue.fal.run/requests/${id}/cancel` });
    }
    if (url.pathname.endsWith('/cancel')) return json({});
    if (url.pathname.endsWith('/status')) return json({ status: hold ? 'IN_PROGRESS' : 'COMPLETED' });
    return json({ images: [{ url: 'https://cdn.example.com/kite.png', width: 1, height: 1 }], seed: 42 });
  });
  const keys = cachedGenerationKeys(createKeyStore({ dir: root, env: {}, keychain: { get: async () => null, set: async () => false, remove: async () => undefined } }));
  const fal = createFalClient({ key: async () => (await keys.get())?.key ?? null, fetch: fetchFake, env: {} });
  records = new GenerationRecords({ dir: root });
  const log = new GenerationLog({ dir: root });
  generation = createGenerationService({ fal, keys, records, settings: new GenerationSettingsStore({ dir: root }), log, publicDir: join(root, 'public'),
    project: () => bridge.state().project, emit: (job) => { emitted.push(job); bridge.broadcast(GENERATION_JOB_EVENT, job); },
    askPermission: async (ask, signal) => {
      const reply = await bridge.send({ type: 'askPermission', requestId: newId('req'), ...ask }, undefined, signal);
      return reply.ok && reply.message === 'allowed' ? 'allowed' : 'denied';
    },
    falFactory: (opts) => createFalClient({ ...opts, fetch: fetchFake, env: {} }),
    importOptions: { lookup: async () => [{ address: '93.184.216.34', family: 4 }], connect: async () => ({ status: 200, headers: {}, body: Readable.from([PNG]) }), probe: async () => null }, pollMs: 1,
  });
  renders = new RenderManager({ rendersDir: join(root, 'renders'), renderer: async () => undefined });
  const session = new EditorSession({ token: 'leak-test' });
  const credentials = session.claim('leak-test')!;
  cookie = `${session.cookieName}=${credentials.sessionId}`;
  tabSecret = credentials.tabSecret;
  app = createApp({ session, generation, generations: log, bridge, publicDir: join(root, 'public'), rendersDir: join(root, 'renders'), projects: createProjectStore(join(root, 'projects')), renders, webPort: 5917, serverPort: 5918 });
  port = 5918;
  transport.request = virtualRequest as typeof httpRequest;
  editor = await connectFakeEditor(port, structuredClone(sampleProject), { Cookie: cookie, 'X-MGE-Tab': tabSecret });
});
afterEach(async () => {
  for (const job of generation.list()) await generation.cancel(job.id);
  await renders.whenIdle();
  editor?.close();
  bridge.close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('fal key containment', () => {
  it('keeps the sentinel only in private key storage across HTTP, SSE, permission, errors and persisted outputs', async () => {
    expect((await send('PUT', '/api/generation/key', { key: SENTINEL })).body).toMatchObject({ configured: true, valid: true, last4: '3210' });
    await send('GET', '/api/generation/status');
    await send('GET', '/api/generation/models');
    await send('GET', '/api/generation/scoreboard');
    await send('POST', '/api/generation/estimate', reqBody());
    await send('PUT', '/api/generation/settings', { dailyBudgetUsd: 10 });
    const created = await send('POST', '/api/generation/jobs', reqBody());
    expect(created).toMatchObject({ status: 200, body: { job: { status: 'queued' } } });
    const userJob = created.body.job as GenerationJob;
    const userDone = await terminal(userJob.id);
    const agentJob = (await send('POST', '/api/generation/jobs', { ...reqBody(), agent: 'Test agent' }, false)).body.job as GenerationJob;
    await terminal(agentJob.id);
    expect(editor!.commands.find((c) => c.type === 'askPermission')).toMatchObject({ type: 'askPermission', agent: 'Test agent', generation: { provider: 'fal', estimateUsd: 0.5 } });
    rejectSubmit = true;
    const failed = (await send('POST', '/api/generation/jobs', reqBody())).body.job as GenerationJob;
    const failure = await terminal(failed.id, 'failed');
    expect(failure.error).toMatchObject({ type: 'auth', message: 'Refused [redacted]' });
    rejectSubmit = false;
    const asset = userDone.outputs[0];
    for (const event of ['auditioned', 'used', 'thumbsUp']) expect((await send('POST', '/api/generation/outcomes', { jobId: userJob.id, assetId: asset.id, event })).status).toBe(200);
    expect((await send('GET', `/api/generation/thumbs?jobIds=${userJob.id}`)).body).toEqual({ [asset.id]: 1 });
    expect((await send('POST', `/api/generation/jobs/${userJob.id}/delivered`)).body.delivered).toBe(true);
    hold = true;
    const cancelled = (await send('POST', '/api/generation/jobs', reqBody())).body.job as GenerationJob;
    await vi.waitFor(() => expect(generation.get(cancelled.id)?.status).toBe('running'), { interval: 5 });
    expect((await send('POST', `/api/generation/jobs/${cancelled.id}/cancel`)).body.status).toBe('cancelled');
    await send('GET', `/api/generation/jobs?projectId=${sampleProject.id}`);
    await send('GET', '/api/generations/log');
    await send('POST', '/api/generation/key/test');
    const saved = structuredClone(sampleProject);
    saved.assets[asset.id] = asset;
    const save = await send('PUT', `/api/projects/${saved.id}`, { format: 'mge.project/1', project: saved, revisions: [], savedAt: new Date().toISOString() });
    expect(save.status).toBe(200);
    const captured: unknown[] = [...responses, ...events, editor!.commands, emitted, generation.list(), logs.flatMap((spy) => spy.mock.calls)];
    for (const name of ['generation-stats.json', 'generation-jobs.json', 'generation-log.json', 'generation-records.json', 'generation-settings.json', `projects/${saved.id}.json`]) captured.push(await readFile(join(root, name), 'utf8'));
    const errors = createFalClient({ key: async () => SENTINEL, env: {}, fetch: async (_url, init) => new Response(JSON.stringify({ detail: new Headers(init?.headers).get('Authorization') }), { status: 401 }) });
    try { await errors.pricing(['test']); } catch (err) { expect(err).toBeInstanceOf(FalError); captured.push((err as Error).message); }
    vi.stubEnv('FAL_KEY', SENTINEL);
    expect(childEnv([])).not.toHaveProperty('FAL_KEY');
    captured.push(childEnv([]));
    expect(events.some((event) => event.includes('event: generation-job'))).toBe(true);
    expect(events.some((event) => event.includes('askPermission'))).toBe(true);
    for (const value of captured) expect(JSON.stringify(value)).not.toContain(SENTINEL);
    expect(await readFile(join(root, 'fal-key'), 'utf8')).toBe(SENTINEL);
    expect(fetchFake.mock.calls.some(([, init]) => new Headers(init?.headers).get('Authorization') === `Key ${SENTINEL}`)).toBe(true);
    expect((await records.get(userJob.id))?.outcomes.used).toEqual([asset.id]);
  });

  it('serves a private scoreboard and applies editor route overrides to the next quote', async () => {
    const initial = await send('GET', '/api/generation/scoreboard', undefined, false);
    expect(initial).toMatchObject({ status: 200, body: { rows: [], suggestions: [], overrides: {}, threshold: 20 } });
    expect(JSON.parse(await readFile(join(root, 'generation-stats.json'), 'utf8'))).toEqual(initial.body);
    expect((await stat(join(root, 'generation-stats.json'))).mode & 0o777).toBe(0o600);
    const quote = () => send('POST', '/api/generation/estimate', { ...reqBody(), job: 'image.generate' });
    expect((await quote()).body.route.model).toBe('gpt-image-2.5-flare');
    expect(await send('POST', '/api/generation/route-overrides', { job: 'image.generate', model: 'seedream-5-pro' }, false)).toMatchObject({ status: 401 });
    expect((await quote()).body.route.model).toBe('gpt-image-2.5-flare');
    expect(await send('POST', '/api/generation/route-overrides', { job: 'image.generate', model: 'seedream-5-pro' })).toMatchObject({ status: 200, body: { overrides: { 'image.generate': 'seedream-5-pro' } } });
    expect((await quote()).body.route.model).toBe('seedream-5-pro');
    expect(JSON.parse(await readFile(join(root, 'generation-stats.json'), 'utf8')).overrides).toEqual({ 'image.generate': 'seedream-5-pro' });
    expect(await send('POST', '/api/generation/route-overrides', { job: 'image.generate', model: null })).toMatchObject({ status: 200, body: { overrides: {} } });
    expect((await quote()).body.route.model).toBe('gpt-image-2.5-flare');
    for (const body of [{ job: 'bogus', model: null }, { job: 'image.generate', model: 'bogus' }, { job: 'image.generate' }]) {
      expect((await send('POST', '/api/generation/route-overrides', body)).status).toBe(400);
    }
  });

  it('persists editor suggestion dismissals and rejects invalid jobs or models', async () => {
    expect(await send('POST', '/api/generation/suggestions/dismiss', { job: 'image.generate', model: 'seedream-5-pro' })).toMatchObject({ status: 200, body: { suggestions: [] } });
    expect((await send('GET', '/api/generation/status')).body.settings.dismissedSuggestions).toEqual(['image.generate:seedream-5-pro']);
    for (const body of [{ job: 'bogus', model: 'seedream-5-pro' }, { job: 'image.generate', model: 'bogus' }, { job: 'music.bed', model: 'seedream-5-pro' }, {}]) {
      expect((await send('POST', '/api/generation/suggestions/dismiss', body)).status).toBe(400);
    }
  });

  it('returns HTTP 500 on a failed delivery write and succeeds on retry', async () => {
    await send('PUT', '/api/generation/key', { key: SENTINEL });
    const job = (await send('POST', '/api/generation/jobs', reqBody())).body.job as GenerationJob;
    await terminal(job.id);
    const update = vi.spyOn(records, 'update').mockRejectedValueOnce(new Error('delivery write failed'));
    expect(await send('POST', `/api/generation/jobs/${job.id}/delivered`)).toMatchObject({ status: 500, body: { error: { code: 'PROTOCOL' } } });
    expect(generation.get(job.id)?.delivered).toBe(false);
    expect((await send('POST', `/api/generation/jobs/${job.id}/delivered`)).body.delivered).toBe(true);
    expect((await records.get(job.id))?.delivered).toBe(true);
    update.mockRestore();
  });

  it('enforces editor-only key/settings routes and validates outcome and thumbs input', async () => {
    for (const [method, path, body] of [['PUT', '/key', { key: SENTINEL }], ['DELETE', '/key', undefined], ['POST', '/key/test', undefined], ['PUT', '/settings', { dailyBudgetUsd: 100 }], ['POST', '/route-overrides', { job: 'image.generate', model: 'seedream-5-pro' }], ['POST', '/suggestions/dismiss', { job: 'image.generate', model: 'seedream-5-pro' }]] as const) {
      expect(await send(method, `/api/generation${path}`, body, false)).toMatchObject({ status: 401, body: { error: { code: 'PROTOCOL', message: 'This needs the editor tab that was opened from the editor link.', hint: 'Open the editor link printed by npm run dev (it ends in ?session=…).' } } });
    }
    expect((await send('PUT', '/api/generation/settings', { dailyBudgetUsd: -1 })).status).toBe(400);
    expect((await send('POST', '/api/generation/outcomes', { jobId: 'a', assetId: 'b', event: 'bogus' })).status).toBe(400);
    expect((await send('POST', '/api/generation/outcomes', { jobId: 'missing', assetId: 'b', event: 'used' })).status).toBe(404);
    expect((await send('GET', `/api/generation/thumbs?jobIds=${Array(101).fill('a').join(',')}`)).status).toBe(400);
    expect((await send('GET', '/api/generation/thumbs?jobIds=a&jobIds=b')).status).toBe(400);
    for (const path of ['/api/generation/jobs/missing', '/api/generation/jobs/missing/cancel', '/api/generation/jobs/missing/delivered']) expect((await send(path.endsWith('missing') ? 'GET' : 'POST', path)).status).toBe(404);
  });

  it('aborts the permission wait when the HTTP client disconnects', async () => {
    await send('PUT', '/api/generation/key', { key: SENTINEL });
    // Keep the editor connected but withhold this command's reply.
    const originalSend = bridge.send.bind(bridge);
    vi.spyOn(bridge, 'send').mockImplementation((command, _timeout, signal) => originalSend(command, command.type === 'askPermission' ? 100_000 : undefined, signal));
    const replies = vi.spyOn(bridge, 'reply').mockReturnValue(true);
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/api/generation/jobs', headers: { 'Content-Type': 'application/json' } });
    req.on('error', () => undefined);
    req.end(JSON.stringify(reqBody()));
    await vi.waitFor(() => expect(generation.list()[0]?.status).toBe('awaiting-permission'), { interval: 5 });
    req.destroy();
    await vi.waitFor(() => expect(generation.list()[0]?.status).toBe('denied'), { interval: 5 });
    expect(fetchFake.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    replies.mockRestore();
  });

  it('marks takes kept after a render starts and swallows outcome-storage errors', async () => {
    const kept = vi.spyOn(generation, 'markKept').mockRejectedValue(new Error('Storage unavailable'));
    const rendered = await send('POST', '/api/renders', { project: sampleProject });
    expect(rendered.status).toBe(200);
    expect(kept).toHaveBeenCalledWith(sampleProject);
    await renders.whenIdle();
    expect((await send('POST', '/api/renders', { project: null })).status).toBe(400);
    expect(kept).toHaveBeenCalledTimes(1);
  });
});


describe('generation origin protection', () => {
  it.each(['/status', '/scoreboard', '/models', '/jobs', '/jobs/missing', '/thumbs'])('refuses cross-origin GET %s and permits editor and no-Origin reads', async (path) => {
    expect((await send('GET', `/api/generation${path}`, undefined, 'https://untrusted.example')).status).toBe(403);
    for (const allowed of [true, false]) expect((await send('GET', `/api/generation${path}`, undefined, allowed)).status).toBe(path === '/jobs/missing' ? 404 : 200);
  });
});
