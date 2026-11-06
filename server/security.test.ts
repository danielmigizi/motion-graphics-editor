import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { mkdtemp, mkdir, rm, writeFile, readFile, stat, readdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from './app';
import { LocalApiError, LocalEditor } from '../mcp/local';
import { createHandlers } from '../mcp/tools';
import { PRIVATE_FILE_MESSAGE } from './local-file';
import { EditorSession } from './session';
import { writeEditorLink } from './editor-link';
import { serializeDoc, createDocState } from '../src/core/history';
import { blankProject } from '../src/core/newProject';
import { sampleProject } from '../src/sample/sampleProject';
import { EditorBridge } from './bridge';
import { createProjectStore } from './projects';
import { RenderManager } from './renders';
import type { GenerationService } from './generation/jobs';

const origin = 'http://localhost:5917';
const evil = 'https://evil.example';
const bundle = 'http://127.0.0.1:43210';
let root: string;
let session: EditorSession;
let bridge: EditorBridge;
let app: ReturnType<typeof createApp>;
let rendererOrigins: string[];
let sockets: Duplex[];
const generation = {
  updateSettings: vi.fn(async () => ({})), setKey: vi.fn(async () => ({})),
  testKey: vi.fn(async () => ({})), removeKey: vi.fn(async () => ({})),
  setRouteOverride: vi.fn(async () => ({})), dismissSuggestion: vi.fn(async () => ({})),
  create: vi.fn(async () => ({ id: 'job_test' })),
  get: vi.fn((id: string) => id === 'user_job' ? { id, requestedBy: { origin: 'user' } }
    : id === 'agent_job' ? { id, requestedBy: { origin: 'agent' } } : undefined),
  cancel: vi.fn(async (id: string) => ({ id, status: 'cancelled' })),
  delivered: vi.fn(async () => ({})), outcome: vi.fn(async () => true), markKept: vi.fn(async () => undefined),
};

// Exercise Express, JSON parsing, static serving and middleware using Node's
// HTTP request/response objects without needing permission to bind a socket.
function send(method: string, path: string, headers: Record<string, string> = {}, body?: unknown, onStart?: (req: IncomingMessage, res: ServerResponse) => void) {
  return new Promise<{ status: number; headers: ReturnType<ServerResponse['getHeaders']>; body: any }>((resolve, reject) => {
    const req = new IncomingMessage(new Socket());
    const bytes = body === undefined ? '' : JSON.stringify(body);
    req.method = method; req.url = path;
    req.headers = { host: 'localhost:5918', ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])),
      ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(bytes)) }) };
    const chunks: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    sockets.push(socket);
    const res = new ServerResponse(req);
    res.assignSocket(socket as Socket);
    const result = (stream = false) => {
      const raw = Buffer.concat(chunks).toString();
      let body: any = raw.slice(raw.indexOf('\r\n\r\n') + 4);
      try { body = JSON.parse(body); } catch { /* Static files and empty replies. */ }
      resolve({ status: res.statusCode, headers: res.getHeaders(), body });
      if (!stream) { socket.destroy(); req.destroy(); }
    };
    const flush = res.flushHeaders.bind(res);
    res.flushHeaders = () => { flush(); result(true); };
    res.on('finish', () => result());
    req.on('error', reject); res.on('error', reject);
    app(req, res);
    if (bytes) req.push(bytes);
    req.complete = true; // Node marks a fully received HTTP body complete before EOF.
    req.push(null);
    onStart?.(req, res);
  });
}
const tabSecrets = new Map<string, string>();
const auth = (cookie: string) => ({ Cookie: cookie, 'X-MGE-Tab': tabSecrets.get(cookie)! });
async function claim(token = 'launch-test') {
  let response = await send('POST', '/api/session', { Origin: origin }, { token });
  if (response.status === 202) response = await send('POST', '/api/session/pending', { Origin: origin }, { pending: response.body.pending });
  expect(response.status).toBe(200);
  const cookie = response.headers['set-cookie'];
  const value = String(Array.isArray(cookie) ? cookie[0] : cookie).split(';')[0];
  expect(response.body).toEqual({ editor: true, tabSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
  tabSecrets.set(value, response.body.tabSecret);
  return value;
}

beforeEach(async () => {
  vi.clearAllMocks();
  tabSecrets.clear();
  root = await mkdtemp(join(tmpdir(), 'mge-security-'));
  await mkdir(join(root, 'public'));
  await writeFile(join(root, 'public', 'asset.txt'), 'private asset');
  session = new EditorSession({ token: 'launch-test', port: 5918 });
  bridge = new EditorBridge();
  sockets = []; rendererOrigins = [];
  app = createApp({ publicDir: join(root, 'public'), rendersDir: join(root, 'renders'),
    projects: createProjectStore(join(root, 'projects')),
    renders: new RenderManager({ rendersDir: join(root, 'renders'), renderer: async () => undefined }),
    webPort: 5917, serverPort: 5918, session, bridge, extraOrigins: () => rendererOrigins,
    generation: generation as unknown as GenerationService,
  });
});
afterEach(async () => {
  bridge.close(); sockets.forEach((socket) => socket.destroy());
  vi.restoreAllMocks(); vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('read lockdown', () => {
  it.each(['/api/projects', '/api/projects/prj_test', '/api/editor/state', '/api/renders', '/api/chat/prj_test',
    '/api/generations/log', '/api/projects/prj_test/journal', '/api/projects/prj_test/checkpoints',
    '/api/renders/render_test/project', '/api/renders/render_test/manifest', '/api/assets/probe', '/api/session', '/asset.txt'])
  ('blocks foreign-origin GET %s without ACAO', async (path) => {
    const response = await send('GET', path, { Origin: evil });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('PROTOCOL');
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('blocks foreign preflights and HEAD requests', async () => {
    for (const method of ['OPTIONS', 'HEAD']) {
      const response = await send(method, '/api/projects', { Origin: evil, 'Access-Control-Request-Method': 'GET' });
      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('blocks cross-site API embedding without Origin while allowing static embedding', async () => {
    for (const path of ['/api/projects', '/API/projects', '/api']) {
      expect((await send('GET', path, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    }
    expect((await send('GET', '/asset.txt', { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(200);
  });

  it('refuses a <script> from another localhost port holding the event stream with the cookie', async () => {
    const cookie = await claim();
    // SameSite=Strict still sends the cookie to another port of localhost (same site), with no Origin on a no-cors GET.
    for (const site of ['same-site', 'cross-site']) {
      expect((await send('GET', '/api/editor/events', { ...auth(cookie), 'Sec-Fetch-Site': site })).status).toBe(403);
      expect((await send('GET', '/api/projects', { 'Sec-Fetch-Site': site })).status).toBe(403);
    }
    expect((await send('GET', '/api/projects', { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
    expect((await send('GET', '/api/session', { ...auth(cookie), 'Sec-Fetch-Site': 'same-origin' })).status).toBe(200);
  });

  it('allows CLI reads without ACAO, echoes editor origins, and answers allowed preflights', async () => {
    const cli = await send('GET', '/api/projects');
    expect(cli.status).toBe(200);
    expect(cli.headers['access-control-allow-origin']).toBeUndefined();
    const editor = await send('GET', '/api/projects', { Origin: origin });
    expect(editor.status).toBe(200);
    expect(editor.headers['access-control-allow-origin']).toBe(origin);
    expect(editor.headers.vary).toContain('Origin');
    const preflight = await send('OPTIONS', '/api/projects', { Origin: origin });
    expect(preflight.status).toBe(204);
    expect(preflight.headers['access-control-allow-methods']).toBe('GET,HEAD,PUT,POST,DELETE,OPTIONS');
    expect(preflight.headers['access-control-allow-headers']).toBe('Content-Type, X-MGE-Tab');
    expect((await send('OPTIONS', '/api/projects')).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('evaluates live renderer origins on each request and allows asset fetches', async () => {
    expect((await send('GET', '/asset.txt', { Origin: bundle })).status).toBe(403);
    rendererOrigins.push(bundle);
    const response = await send('GET', '/asset.txt', { Origin: bundle });
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBe(bundle);
    rendererOrigins = [];
    expect((await send('GET', '/asset.txt', { Origin: bundle })).status).toBe(403);
  });
});

const protectedRoutes = [
  ['POST', '/api/session/link', 200], ['PUT', '/api/projects/prj_test?autosave=1', 400],
  ['POST', '/api/generation/outcomes', 400], ['POST', '/api/generation/jobs/user_job/delivered', 200],
  ['POST', '/api/generation/jobs/user_job/cancel', 200],
  ['PUT', '/api/generation/settings', 200], ['PUT', '/api/generation/key', 200],
  ['POST', '/api/generation/key/test', 200], ['DELETE', '/api/generation/key', 200],
  ['POST', '/api/generation/route-overrides', 200], ['POST', '/api/generation/suggestions/dismiss', 200],
  ['GET', '/api/editor/events', 200], ['POST', '/api/editor/replies/x', 400], ['POST', '/api/editor/state', 400],
  ['POST', '/api/chat/prj_test/messages', 503], ['POST', '/api/chat/prj_test/cancel', 503],
  ['POST', '/api/chat/prj_test/reset', 503], ['POST', '/api/chat/prj_test/settings', 503],
  ['DELETE', '/api/projects/prj_test/checkpoints/cp_test', 404],
  ['PUT', '/api/projects/prj_test/proposal', 400], ['DELETE', '/api/projects/prj_test/proposal', 200],
] as const;

describe('editor identity', () => {
  it.each(protectedRoutes)('refuses forged editor Origin for %s %s; requires a cookie and tab secret', async (method, path, handlerStatus) => {
    const forged = await send(method, path, { Origin: origin });
    expect(forged.status).toBe(401);
    expect(forged.body.error).toEqual({ code: 'PROTOCOL', message: 'This needs the editor tab that was opened from the editor link.',
      hint: 'Open the editor link printed by npm run dev (it ends in ?session=…).' });
    expect((await send(method, path)).status).toBe(401);
    const cookie = await claim();
    for (const headers of [{ Cookie: cookie }, { 'X-MGE-Tab': tabSecrets.get(cookie)! }, { Cookie: cookie, 'X-MGE-Tab': 'forged' }] as Record<string, string>[]) {
      expect((await send(method, path, headers)).status).toBe(401);
    }
    const queryPath = `${path}${path.includes('?') ? '&' : '?'}tab=${tabSecrets.get(cookie)}`;
    expect((await send(method, queryPath, { Cookie: cookie })).status).toBe(path === '/api/editor/events' ? handlerStatus : 401);
    expect((await send(method, path, { Origin: origin, ...auth(cookie) })).status).toBe(handlerStatus);
  });

  it('classifies forged editor jobs as agent and claimed jobs as user', async () => {
    expect((await send('POST', '/api/generation/jobs', { Origin: origin }, {})).status).toBe(200);
    expect(generation.create).toHaveBeenLastCalledWith({}, expect.objectContaining({ origin: 'agent' }), expect.any(AbortSignal));
    const cookie = await claim();
    await send('POST', '/api/generation/jobs', { Cookie: cookie }, {});
    expect(generation.create).toHaveBeenLastCalledWith({}, expect.objectContaining({ origin: 'agent' }), expect.any(AbortSignal));
    await send('POST', '/api/generation/jobs', { Origin: origin, ...auth(cookie) }, {});
    expect(generation.create).toHaveBeenLastCalledWith({}, expect.objectContaining({ origin: 'user' }), expect.any(AbortSignal));
    await send('POST', '/api/generation/jobs', { ...auth(cookie) }, {});
    expect(generation.create).toHaveBeenLastCalledWith({}, expect.objectContaining({ origin: 'user' }), expect.any(AbortSignal));
  });

  it('refuses cookies with foreign origins and denies renderer-origin user privileges', async () => {
    const cookie = await claim();
    const foreign = await send('GET', '/api/session', { Origin: evil, ...auth(cookie) });
    expect(foreign.status).toBe(403);
    expect(foreign.headers['access-control-allow-origin']).toBeUndefined();
    rendererOrigins.push(bundle);
    expect((await send('GET', '/api/session', { Origin: bundle, ...auth(cookie) })).body).toEqual({ editor: false });
    expect((await send('PUT', '/api/generation/settings', { Origin: bundle, ...auth(cookie) }, {})).status).toBe(401);
    expect((await send('POST', '/api/session', { Origin: bundle }, { token: session.mintLink() })).status).toBe(403);
  });
});

describe('one-time editor links', () => {
  it('burns launch tokens, rejects wrong tokens and sets a browser-session HttpOnly Strict cookie', async () => {
    expect(session.launchToken()).toBe('launch-test');
    expect((await send('POST', '/api/session', { Origin: origin }, { token: 'wrong' })).status).toBe(403);
    expect((await send('GET', '/api/session')).body).toEqual({ editor: false });
    const response = await send('POST', '/api/session', { Origin: origin }, { token: 'launch-test' });
    expect(response.status).toBe(200);
    expect(response.headers['set-cookie']).toMatch(/^mge_editor_5918=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Strict$/);
    expect(session.launchToken()).toBeNull();
    const reused = await send('POST', '/api/session', { Origin: origin }, { token: 'launch-test' });
    expect(reused.status).toBe(403);
    expect(reused.body.error).toEqual({ code: 'PROTOCOL', message: 'This editor link was already used or is from an earlier server start.',
      hint: 'Use the newest editor link printed by npm run dev, or restart the server for a new one.' });
  });

  it('requires an editor Origin for claims without consuming the token on rejection', async () => {
    for (const headers of [{}, { Origin: evil }] as Record<string, string>[]) {
      expect((await send('POST', '/api/session', headers, { token: 'launch-test' })).status).toBe(403);
    }
    await claim();
  });

  it('accepts only web-port origins for claims while retaining server-port CORS', async () => {
    const cookie = await claim();
    await send('GET', '/api/editor/events', auth(cookie));
    vi.spyOn(bridge, 'send').mockResolvedValue({ ok: true, message: 'allowed' });
    for (const allowed of [origin, 'http://127.0.0.1:5917']) {
      const response = await send('POST', '/api/session', { Origin: allowed }, { token: session.mintLink() });
      expect(response.status).toBe(202);
      expect(response.headers['access-control-allow-origin']).toBe(allowed);
      expect((await send('POST', '/api/session/pending', { Origin: allowed }, { pending: response.body.pending })).status).toBe(200);
    }
    for (const serverOrigin of ['http://localhost:5918', 'http://127.0.0.1:5918']) {
      expect((await send('GET', '/api/session', { Origin: serverOrigin, ...auth(cookie) })).body.editor).toBe(false);
      expect((await send('PUT', '/api/generation/settings', { Origin: serverOrigin, ...auth(cookie) }, {})).status).toBe(401);
      const token = session.mintLink();
      const response = await send('POST', '/api/session', { Origin: serverOrigin }, { token });
      expect(response.status).toBe(403);
      expect(response.headers['access-control-allow-origin']).toBe(serverOrigin);
      expect((await send('POST', '/api/session', { Origin: origin }, { token })).status).toBe(202);
    }
  });

  it('requires the user to mint links whose tokens work once and preserves existing sessions', async () => {
    expect((await send('POST', '/api/session/link', { Origin: origin })).status).toBe(401);
    const cookie = await claim();
    expect((await send('GET', '/api/session', { ...auth(cookie), Cookie: `other=ignored; ${cookie}` })).body).toEqual({ editor: true });
    const response = await send('POST', '/api/session/link', { Origin: origin, ...auth(cookie) });
    expect(response.status).toBe(200);
    const link = new URL(response.body.url);
    expect(link.origin).toBe(origin);
    const token = link.searchParams.get('session')!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await send('GET', '/api/editor/events', auth(cookie));
    vi.spyOn(bridge, 'send').mockResolvedValue({ ok: true, revision: 0, projectId: '', message: 'allowed' });
    const secondCookie = await claim(token);
    expect(secondCookie).not.toBe(cookie);
    expect((await send('GET', '/api/session', { Cookie: secondCookie, 'X-MGE-Tab': tabSecrets.get(cookie)! })).body).toEqual({ editor: true });
    expect((await send('POST', '/api/session', { Origin: origin }, { token })).status).toBe(403);
    for (const value of [cookie, secondCookie]) expect((await send('GET', '/api/session', { ...auth(value) })).body.editor).toBe(true);
  });

  it('caps outstanding tokens at eight and forgets sessions on restart', async () => {
    const cookie = await claim();
    const tokens = Array.from({ length: 9 }, () => session.mintLink());
    expect(session.claim(tokens[0])).toBeNull();
    for (const token of tokens.slice(1)) expect(session.claim(token)).toEqual({ kind: 'minted', sessionId: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), tabSecret: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    const unclaimed = new EditorSession({ token: 'old-launch' });
    for (let i = 0; i < 8; i++) unclaimed.mintLink();
    expect(unclaimed.launchToken()).toBeNull();
    expect(unclaimed.claim('old-launch')).toBeNull();
    const restarted = new EditorSession();
    expect(restarted.launchToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(restarted.isEditor({ headers: { cookie } } as Parameters<EditorSession['isEditor']>[0])).toBe(false);
    expect(restarted.claim('launch-test')).toBeNull();
  });
});

describe('round-two abuse regressions', () => {
  it('expires minted links at five minutes while keeping the launch token valid', () => {
    let now = 1000;
    const timed = new EditorSession({ token: 'timed-launch', now: () => now });
    const expired = timed.mintLink();
    const valid = timed.mintLink();
    now += 5 * 60 * 1000 - 1;
    expect(timed.claim(valid)).not.toBeNull();
    now += 1;
    expect(timed.claim(expired)).toBeNull();
    now += 365 * 24 * 60 * 60 * 1000;
    expect(timed.claim('timed-launch')).not.toBeNull();
  });

  it('does not grant user identity through a tab query on other routes or HEAD events', async () => {
    const cookie = await claim();
    const query = `tab=${tabSecrets.get(cookie)}`;
    expect((await send('GET', `/api/session?${query}`, { Cookie: cookie })).body).toEqual({ editor: false });
    expect((await send('HEAD', `/api/editor/events?${query}`, { Cookie: cookie })).status).toBe(401);
    expect((await send('GET', '/api/editor/events?tab=forged', { Cookie: cookie })).status).toBe(401);
    expect((await send('GET', `/api/editor/events?${query}`)).status).toBe(401);
  });

  it('sandboxes script-bearing SVG documents from both static mounts', async () => {
    await mkdir(join(root, 'renders'), { recursive: true });
    for (const [folder, url] of [['public', '/evil.svg'], ['renders', '/renders/evil.svg']]) {
      await writeFile(join(root, folder, 'evil.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><script>fetch("/api/session/link", {method:"POST"})</script></svg>');
      const response = await send('GET', url);
      expect(response.status).toBe(200);
      expect(response.headers['content-security-policy']).toBe("sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; media-src 'self'");
      expect(response.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('rejects agent autosaves and preserves user history and the first overwritten saved file after 25 agent writes', async () => {
    const cookie = await claim();
    const path = `/api/projects/${sampleProject.id}`;
    const file = (revision: number) => serializeDoc(createDocState({ ...structuredClone(sampleProject), revision }));
    const original = file(1);
    expect((await send('PUT', path, auth(cookie), original)).status).toBe(200);
    const saved = (await send('GET', path)).body;
    for (let i = 0; i < 20; i++) expect((await send('PUT', `${path}?autosave=1`, auth(cookie), file(i + 100))).status).toBe(200);
    const userEntries = (await send('GET', `${path}/journal`)).body;
    expect(userEntries).toHaveLength(20);
    expect((await send('PUT', `${path}?autosave=1`, {}, file(900))).status).toBe(401);
    for (let i = 0; i < 25; i++) expect((await send('PUT', path, {}, file(i + 2))).status).toBe(200);
    const entries = (await send('GET', `${path}/journal`)).body;
    expect(entries.filter((entry: { id: string }) => !/-[au]$/.test(entry.id))).toEqual(userEntries);
    expect(entries.filter((entry: { id: string }) => entry.id.endsWith('-a'))).toHaveLength(20);
    const first = entries.find((entry: { revision: number }) => entry.revision === 1);
    expect(first).toBeDefined();
    expect((await send('GET', `${path}/journal/${first.id}`)).body.file).toEqual(saved);
    const recovered = (await send('GET', `${path}/journal/${first.id}`)).body.file;
    expect((await send('PUT', path, auth(cookie), recovered)).status).toBe(200);
    expect((await send('GET', path)).body.project).toEqual(original.project);
    // User pruning remains independent of the agent's twenty entries.
    expect((await send('PUT', `${path}?autosave=1`, auth(cookie), file(120))).status).toBe(200);
    const pruned = (await send('GET', `${path}/journal`)).body;
    expect(pruned).toHaveLength(41);
    // The agent-written version the user's save replaced went to the agent ring (it is the agent's content); still 20 there.
    expect(pruned.filter((entry: { id: string }) => entry.id.endsWith('-a'))).toHaveLength(20);
    expect(pruned.filter((entry: { id: string }) => !/-[au]$/.test(entry.id))).toHaveLength(20);
  });

  it('blocks forged outcomes and deliveries, protects user cancellations, and keeps agent cancellation working', async () => {
    const outcome = { jobId: 'user_job', assetId: 'asset_test', event: 'used' };
    expect((await send('POST', '/api/generation/outcomes', {}, outcome)).status).toBe(401);
    expect(generation.outcome).not.toHaveBeenCalled();
    expect((await send('POST', '/api/generation/jobs/user_job/delivered')).status).toBe(401);
    expect(generation.delivered).not.toHaveBeenCalled();
    expect((await send('POST', '/api/generation/jobs/user_job/cancel')).status).toBe(401);
    expect(generation.cancel).not.toHaveBeenCalled();
    expect((await send('POST', '/api/generation/jobs/agent_job/cancel')).status).toBe(200);
    expect(generation.cancel).toHaveBeenLastCalledWith('agent_job');
    const cookie = await claim();
    expect((await send('POST', '/api/generation/outcomes', auth(cookie), outcome)).status).toBe(200);
    expect(generation.outcome).toHaveBeenLastCalledWith(outcome);
    expect((await send('POST', '/api/generation/jobs/user_job/delivered', auth(cookie))).status).toBe(200);
    expect(generation.delivered).toHaveBeenLastCalledWith('user_job');
    expect((await send('POST', '/api/generation/jobs/user_job/cancel', auth(cookie))).status).toBe(200);
    expect(generation.cancel).toHaveBeenLastCalledWith('user_job');
  });

  it('stores the editor link privately and replaces an existing permissive file on every start', async () => {
    const folder = join(root, 'private', 'config');
    const path = join(folder, 'editor-link');
    await writeEditorLink(path, 'http://localhost:5917/?session=first');
    expect((await stat(folder)).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await rm(path);
    await writeFile(path, 'old link', { mode: 0o644 });
    await writeEditorLink(path, 'http://localhost:5917/?session=second');
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, 'utf8')).toBe('http://localhost:5917/?session=second\n');
    expect(await readdir(folder)).toEqual(['editor-link']);
    await expect(writeEditorLink('relative/editor-link', 'secret')).rejects.toThrow('absolute path');
  });
});

describe('S4 two-step minted browser approval', () => {
  const connect = async () => {
    const cookie = await claim();
    await send('GET', '/api/editor/events', auth(cookie));
    return cookie;
  };
  const poll = (pending: string, headers: Record<string, string> = { Origin: origin }) =>
    send('POST', '/api/session/pending', headers, { pending });

  it('returns 202 first and restores an unavailable tab token for retry', async () => {
    const token = session.mintLink();
    const result = await send('POST', '/api/session', { Origin: origin }, { token });
    expect(result.status).toBe(202);
    expect(result.headers['set-cookie']).toBeUndefined();
    const refused = await poll(result.body.pending);
    expect(refused.status).toBe(403);
    expect(refused.body.error.message).toBe('The unlocked tab is busy with another request. Try the link again in a moment.');
    expect(session.claim(token)?.kind).toBe('minted');
    expect((await send('POST', '/api/session', { Origin: origin }, { token: 'launch-test' })).status).toBe(200);
  });
  it.each(['denied', 'timeout', 'cancelled'])('refuses %s replies and burns the token', async decision => {
    await connect();
    vi.spyOn(bridge, 'send').mockResolvedValue(decision === 'cancelled'
      ? { ok: false, error: { code: 'CANCELLED', message: 'closed' } } : { ok: true, revision: 0, projectId: '', message: decision });
    const token = session.mintLink();
    const start = await send('POST', '/api/session', { Origin: origin }, { token });
    expect(start.status).toBe(202);
    const result = await poll(start.body.pending);
    expect(result.status).toBe(403);
    expect(result.body.error.message).toBe("The unlocked editor tab didn't allow this.");
    expect(result.headers['set-cookie']).toBeUndefined();
    expect((await poll(start.body.pending)).status).toBe(403);
    expect(session.claim(token)).toBeNull();
  });
  it('reserves the token, shows a pairing code, and delivers credentials exactly once', async () => {
    await connect();
    let approve!: (reply: import('../src/core/api-contract').BridgeReply) => void;
    const spy = vi.spyOn(bridge, 'send').mockImplementation(() => new Promise(resolve => { approve = resolve; }));
    const token = session.mintLink();
    const start = await send('POST', '/api/session', { Origin: origin, 'User-Agent': 'attacker-controlled' }, { token });
    expect(start.status).toBe(202);
    expect(start.body).toEqual({ pending: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/), code: expect.stringMatching(/^[A-HJ-NP-Z2-9]{3}-[A-HJ-NP-Z2-9]{3}$/) });
    expect(start.headers['set-cookie']).toBeUndefined();
    expect((await poll(start.body.pending)).body).toEqual({ waiting: true });
    expect((await poll(start.body.pending)).status).toBe(202);
    expect((await send('POST', '/api/session', { Origin: origin }, { token })).status).toBe(403);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ type: 'askPermission', agent: 'Another browser',
      action: 'Unlock the editor in another browser or tab', detail: `Code ${start.body.code}. Allow only if the other tab shows this code.` }), undefined, expect.any(AbortSignal));
    expect(JSON.stringify(spy.mock.calls)).not.toContain('attacker-controlled');
    approve({ ok: true, message: 'allowed' });
    await Promise.resolve();
    for (const headers of [{}, { Origin: 'http://localhost:5918' }, { Origin: bundle }] as Record<string, string>[]) {
      expect((await poll(start.body.pending, headers)).status).toBe(403);
    }
    const result = await poll(start.body.pending);
    expect(result.status).toBe(200);
    const cookie = String(result.headers['set-cookie']).split(';')[0];
    expect((await send('GET', '/api/session', { Cookie: cookie, 'X-MGE-Tab': result.body.tabSecret })).body.editor).toBe(true);
    const reused = await poll(start.body.pending);
    expect(reused.status).toBe(403); expect(reused.headers['set-cookie']).toBeUndefined();
    expect((await poll('unknown')).status).toBe(403);
  });
  it('restores a busy token, preserves its expiry, and permits a later approval', async () => {
    await connect();
    const spy = vi.spyOn(bridge, 'send').mockResolvedValue({ ok: true, message: 'denied', reason: 'another request is waiting' });
    const token = session.mintLink();
    const start = await send('POST', '/api/session', { Origin: origin }, { token });
    const result = await poll(start.body.pending);
    expect(result.status).toBe(403);
    expect(result.body.error.message).toBe('The unlocked tab is busy with another request. Try the link again in a moment.');
    spy.mockResolvedValue({ ok: true, message: 'allowed' });
    const retry = await send('POST', '/api/session', { Origin: origin }, { token });
    expect(retry.status).toBe(202);
    expect(retry.body.pending).not.toBe(start.body.pending);
    expect((await poll(retry.body.pending)).status).toBe(200);
  });
  it('expires waiting and approved pending ids with the card and ignores late approvals', () => {
    let now = 1000;
    const timed = new EditorSession({ now: () => now });
    for (const allowed of [false, true]) {
      const token = timed.mintLink();
      const pending = timed.beginPending(timed.claim(token)!);
      if (allowed) timed.resolvePending(pending.pending, 'allowed');
      now += 120000;
      timed.resolvePending(pending.pending, 'allowed');
      expect(timed.pollPending(pending.pending).status).toBe('denied');
      expect(timed.claim(token)).toBeNull();
    }
  });
  it('never extends a token lifetime after busy replies', () => {
    let now = 1000;
    const timed = new EditorSession({ now: () => now });
    const token = timed.mintLink();
    now += 299000;
    const pending = timed.beginPending(timed.claim(token)!);
    timed.resolvePending(pending.pending, 'busy');
    now += 1000;
    expect(timed.claim(token)).toBeNull();
  });
});

describe('S3 instance isolation and private file routes', () => {
  it('isolates cookies by server port and reports the configured link file', async () => {
    const other = new EditorSession({ port: 6018, token: 'other' });
    const id = other.claim('other')!;
    const cookie = `${other.cookieName}=${id.sessionId}`;
    expect(other.cookieName).toBe('mge_editor_6018');
    expect(session.cookieName).toBe('mge_editor_5918');
    expect((await send('GET', '/api/session', { Cookie: cookie, 'X-MGE-Tab': id.tabSecret })).body.editor).toBe(false);
    vi.stubEnv('MGE_EDITOR_LINK_FILE', join(root, 'editor-link-5918'));
    try {
      expect((await send('GET', '/api/session')).body.linkFile).toBe(join(root, 'editor-link-5918'));
      const local = new LocalEditor({ rootDir: root, serverPort: 5918, webPort: 5917, openBrowser: false });
      expect(local.editorLinkFile.endsWith('/editor-link-5918')).toBe(true);
    } finally { vi.unstubAllEnvs(); }
  });
  it('keeps missing local reference paths as a client error', async () => {
    expect((await send('POST', '/api/reference/analyze', {}, { path: join(root, 'missing.mp4') })).status).toBe(400);
  });
  it('refuses reference-analysis symlinks into private locations for agents and users', async () => {
    const privateDir = join(root, 'private-config'); await mkdir(privateDir);
    await writeFile(join(privateDir, 'key.mp4'), 'private');
    const alias = join(root, 'innocent.mp4'); await symlink(join(privateDir, 'key.mp4'), alias);
    vi.stubEnv('MGE_CONFIG_DIR', privateDir);
    try {
      const cookie = await claim();
      for (const headers of [{}, auth(cookie)]) {
        const result = await send('POST', '/api/reference/analyze', headers, { path: alias });
        expect(result.status).toBe(403); expect(result.body.error.message).toBe(PRIVATE_FILE_MESSAGE);
      }
    } finally { vi.unstubAllEnvs(); }
  });
});

describe('S3 serialized canonical history', () => {
  const path = `/api/projects/${sampleProject.id}`;
  const file = (revision: number) => serializeDoc(createDocState({ ...structuredClone(sampleProject), revision }));
  it('archives the last agent version when the user saves after agent overwrites, in the agent\u2019s ring (its content)', async () => {
    const cookie = await claim();
    await send('PUT', path, auth(cookie), file(1));
    await send('PUT', path, {}, file(2));
    await send('PUT', path, auth(cookie), file(3));
    const entries = (await send('GET', `${path}/journal`)).body;
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ revision: 1, id: expect.stringMatching(/-u$/) }),
      expect.objectContaining({ revision: 2, id: expect.stringMatching(/-a$/) })]));
  });
  it('preserves the newest user baseline across repeated rounds of agent floods', async () => {
    const cookie = await claim();
    await send('PUT', path, auth(cookie), file(1));
    await send('PUT', path, {}, file(2));
    await send('PUT', path, auth(cookie), file(100));
    for (let revision = 101; revision <= 125; revision++) await send('PUT', path, {}, file(revision));
    const entries = (await send('GET', `${path}/journal`)).body;
    const baselines = entries.filter((entry: { id: string }) => entry.id.endsWith('-u'));
    expect(baselines).toHaveLength(1);
    expect(baselines[0].revision).toBe(100);
    expect((await send('GET', `${path}/journal/${baselines[0].id}`)).body.file.project.revision).toBe(100);
    expect(entries.filter((entry: { id: string }) => entry.id.endsWith('-a'))).toHaveLength(20);
  });
  it('serializes concurrent PUTs so both submitted versions become archived on the next save', async () => {
    const cookie = await claim();
    await send('PUT', path, auth(cookie), file(1));
    const results = await Promise.all([send('PUT', path, auth(cookie), file(2)), send('PUT', path, {}, file(3))]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    await send('PUT', path, auth(cookie), file(4));
    const entries = (await send('GET', `${path}/journal`)).body;
    expect(entries.map((entry: { revision: number }) => entry.revision).sort()).toEqual([1, 2, 3]);
  });
  it('files user-authenticated by=agent saves in the agent ring and marks the writer', async () => {
    const cookie = await claim();
    await send('PUT', path, auth(cookie), file(1));
    await send('PUT', `${path}?by=agent`, auth(cookie), file(2));
    await send('PUT', `${path}?by=agent`, auth(cookie), file(3));
    const entries = (await send('GET', `${path}/journal`)).body;
    expect(entries).toEqual(expect.arrayContaining([expect.objectContaining({ revision: 1, id: expect.stringMatching(/-u$/) }),
      expect.objectContaining({ revision: 2, id: expect.stringMatching(/-a$/) })]));
    expect(await readFile(join(root, 'projects', `${sampleProject.id}.json.writer`), 'utf8')).toBe('agent');
    // An agent cannot use by=user to evade its ring.
    await send('PUT', `${path}?by=user`, {}, file(4));
    expect((await send('GET', `${path}/journal`)).body).toEqual(expect.arrayContaining([expect.objectContaining({ revision: 3, id: expect.stringMatching(/-a$/) })]));
  });

  it('files Auto-apply autosaves (?autosave=1&by=agent) in the agent ring: 25 of them leave the user\'s History intact', async () => {
    const cookie = await claim();
    for (let r = 1; r <= 5; r++) await send('PUT', `${path}?autosave=1`, auth(cookie), file(r));
    for (let r = 6; r <= 30; r++) expect((await send('PUT', `${path}?autosave=1&by=agent`, auth(cookie), file(r))).status).toBe(200);
    const entries = (await send('GET', `${path}/journal`)).body as { id: string; revision: number }[];
    const userRevisions = entries.filter((e) => !/-[au]$/.test(e.id)).map((e) => e.revision).sort((a, b) => a - b);
    expect(userRevisions).toEqual([1, 2, 3, 4, 5]);
    expect(entries.filter((e) => /-a$/.test(e.id)).length).toBeLessThanOrEqual(20);
  });
});

describe('S4 server-side local imports and response policy', () => {
  it('uses the server config policy even when MCP has a different environment', async () => {
    const config = join(root, 'server-config'); await mkdir(config);
    const secret = join(config, 'key.svg'); await writeFile(secret, '<svg/>');
    const alias = join(root, 'innocent.svg'); await symlink(secret, alias);
    vi.stubEnv('MGE_CONFIG_DIR', join(root, 'mcp-config'));
    const local = new LocalEditor({ rootDir: root, serverPort: 5918, webPort: 5917, openBrowser: false });
    vi.spyOn(local, 'state').mockRejectedValue(new Error('no editor'));
    const request = vi.spyOn(local, 'request').mockImplementation(async (method, path, body) => {
      // In production this runs in the other process, with the server's env.
      vi.stubEnv('MGE_CONFIG_DIR', config);
      try {
        const response = await send(method, path, {}, body);
        if (response.status >= 400) throw new LocalApiError(response.status, response.body.error.message, response.body.error);
        return response.body;
      } finally { vi.stubEnv('MGE_CONFIG_DIR', join(root, 'mcp-config')); }
    });
    const result = await createHandlers(local).editor_import_asset({ path: alias });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: PRIVATE_FILE_MESSAGE }]);
    expect(request).toHaveBeenCalledExactlyOnceWith('POST', '/api/assets/import-local', { path: alias, name: undefined });
  });
  it('refuses aliases into the server config, editor link and process pseudo-files', async () => {
    const config = join(root, 'private'); await mkdir(config);
    const secret = join(config, 'key.png'); await writeFile(secret, 'private');
    const link = join(root, 'editor-link.png'); await writeFile(link, 'private link');
    vi.stubEnv('MGE_CONFIG_DIR', config);
    vi.stubEnv('MGE_EDITOR_LINK_FILE', link);
    for (const [i, target] of [secret, link, ...(process.platform === 'linux' ? ['/proc/self/environ'] : [])].entries()) {
      const path = join(root, `innocent-${i}.png`); await symlink(target, path);
      const result = await send('POST', '/api/assets/import-local', {}, { path });
      expect(result.status).toBe(403); expect(result.body.error.message).toBe(PRIVATE_FILE_MESSAGE);
    }
  });
  it('imports valid files and refuses text disguised as an image through the local route', async () => {
    const path = join(root, 'allowed.svg'); await writeFile(path, '<svg width="12" height="8"/>');
    const result = await send('POST', '/api/assets/import-local', {}, { path, name: 'My logo' });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ kind: 'svg', name: 'My logo', mimeType: 'image/svg+xml', width: 12, height: 8 });
    expect(await readFile(join(root, 'public', result.body.src), 'utf8')).toBe('<svg width="12" height="8"/>');
    for (const ext of ['svg', 'png']) {
      const path = join(root, `fake.${ext}`); await writeFile(path, 'plain text');
      const result = await send('POST', '/api/assets/import-local', {}, { path });
      expect(result.status).toBe(400); expect(result.body.error.message).toBe("The file's contents don't match its type.");
    }
    expect((await send('POST', '/api/assets/import-local', {}, { path: join(root, 'missing.svg') })).status).toBe(400);
    expect((await send('POST', '/api/assets/import-local', {}, { path: 42 })).status).toBe(400);
  });
  it('records render outcomes only for authenticated editor requests', async () => {
    const cookie = await claim();
    const project = blankProject({ project: 'prj_render', scene: 'scn_render' });
    expect((await send('POST', '/api/renders', {}, { project })).status).toBe(200);
    expect(generation.markKept).not.toHaveBeenCalled();
    const result = await send('POST', '/api/renders', auth(cookie), { project });
    expect(result.status).toBe(200);
    expect(generation.markKept).toHaveBeenCalledExactlyOnceWith(project);
  });
  it('sets no-store on API successes, failures, preflights and event streams', async () => {
    for (const [method, path, headers] of [
      ['GET', '/api/health', {}], ['GET', '/api/missing', {}],
      ['GET', '/api/projects', { Origin: evil }], ['GET', '/api/projects', { Host: 'evil.example' }],
      ['OPTIONS', '/api/projects', { Origin: origin }], ['GET', '/API/session', {}],
    ] as [string, string, Record<string, string>][]) {
      expect((await send(method, path, headers)).headers['cache-control']).toBe('no-store');
    }
    expect((await send('GET', '/api/editor/events', auth(await claim()))).headers['cache-control']).toBe('no-store');
  });
});
