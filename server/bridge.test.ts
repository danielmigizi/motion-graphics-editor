// Agent bridge relay and still-frame endpoint, through the real Express app.

import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { BridgeReply, EditorStateResponse, StillResponse } from '../src/core/api-contract';
import { fixtureProject } from '../src/core/__fixtures__/fixtureProject';
import { PATCH_PROTOCOL, type AiPatch } from '../src/core/types';
import { createApp } from './app';
import { EditorSession } from './session';
import { EditorBridge } from './bridge';
import { createProjectStore } from './projects';
import { RenderManager } from './renders';
import { connectFakeEditor, type FakeEditor } from './testing/fakeEditor';

const session = new EditorSession({ token: 'bridge-test' });
const credentials = session.claim('bridge-test')!;
const cookie = `${session.cookieName}=${credentials.sessionId}`;
const tabSecret = credentials.tabSecret;
const WEB_PORT = 5927;
let root: string;
let server: Server;
let port: number;
const bridge = new EditorBridge({ timeoutMs: 300, heartbeatMs: 60000 });
const stillCalls: { frame: number; scale: number }[] = [];
const editors: FakeEditor[] = [];

function send(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { Cookie: cookie, 'X-MGE-Tab': tabSecret, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: data ? JSON.parse(data) : null }));
    });
    req.on('error', reject);
    req.end(body !== undefined ? JSON.stringify(body) : undefined);
  });
}

const connect = async (project: Parameters<typeof connectFakeEditor>[1], handle?: Parameters<typeof connectFakeEditor>[3]) => {
  const ed = await connectFakeEditor(port, project, { Cookie: cookie, 'X-MGE-Tab': tabSecret }, handle);
  editors.push(ed);
  return ed;
};

const patch = (over: Partial<AiPatch> = {}): AiPatch => ({
  protocol: PATCH_PROTOCOL,
  projectId: fixtureProject.id,
  baseRevision: fixtureProject.revision,
  summary: 'Bigger headline',
  targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }],
  commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 120 } } }],
  ...over,
});

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mge-bridge-'));
  const app = createApp({
    session,
    publicDir: join(root, 'public'),
    rendersDir: join(root, 'renders'),
    projects: createProjectStore(join(root, 'projects')),
    renders: new RenderManager({ rendersDir: join(root, 'renders'), renderer: async () => undefined }),
    webPort: WEB_PORT,
    serverPort: 5928,
    bridge,
    renderStill: async ({ frame, scale, outputPath }) => {
      stillCalls.push({ frame, scale });
      await writeFile(outputPath, 'png');
    },
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
  editors.splice(0).forEach((e) => e.close());
  // Let the server see the closed streams.
  await new Promise((r) => setTimeout(r, 30));
});

afterAll(async () => {
  bridge.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

describe('agent bridge', () => {
  it('reports no editor and refuses commands until one connects', async () => {
    const state = await send('GET', '/api/editor/state');
    expect(state.body.connected).toBe(false);
    const r = await send('POST', '/api/editor/commands', { type: 'save' });
    expect(r.status).toBe(409);
    expect((r.body as BridgeReply).ok).toBe(false);
    expect(r.body.error.code).toBe('EDITOR_NOT_CONNECTED');
  });

  it('relays a patch to the editor and returns its reply', async () => {
    const ed = await connect(fixtureProject);
    const state = (await send('GET', '/api/editor/state')).body as EditorStateResponse;
    expect(state.connected).toBe(true);
    expect(state.context?.projectId).toBe(fixtureProject.id);
    expect(state.project?.revision).toBe(fixtureProject.revision);

    const r = await send('POST', '/api/editor/commands', { type: 'applyPatch', patch: patch() });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.revision).toBe(fixtureProject.revision + 1);
    expect(r.body.changes.some((c: { path: string }) => c.path === 'props.fontSize')).toBe(true);
    expect(ed.commands).toHaveLength(1);
  });

  it('passes editor rejections through as 422 with the core error', async () => {
    await connect(fixtureProject);
    const r = await send('POST', '/api/editor/commands', { type: 'applyPatch', patch: patch({ baseRevision: fixtureProject.revision - 1 }) });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('STALE');
  });

  it('times out when the editor never answers', async () => {
    await connect(fixtureProject, () => new Promise(() => undefined));
    const r = await send('POST', '/api/editor/commands', { type: 'save' });
    expect(r.status).toBe(504);
    expect(r.body.error.code).toBe('TIMEOUT');
  });

  it.each(['allowed', 'denied', 'timeout'] as const)('relays askPermission %s through the fake editor', async (message) => {
    const ed = await connect(fixtureProject);
    ed.permissionDecision = message;
    const r = await send('POST', '/api/editor/commands', { type: 'askPermission', requestId: 'permission-1', agent: 'Codex', action: 'Replace the open project', timeoutMs: 1000 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, message });
    expect(ed.commands).toHaveLength(1);
    expect(ed.doc.project).toEqual(fixtureProject);
  });

  it('uses the permission timeout instead of the ordinary command timeout', async () => {
    await connect(fixtureProject, () => new Promise(() => undefined));
    const r = await send('POST', '/api/editor/commands', { type: 'askPermission', requestId: 'permission-1', agent: 'Codex', action: 'Replace the open project', timeoutMs: 25 });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, message: 'timeout' });
  });

  it('cancels a native approval when its turn stops and ignores a later Allow', async () => {
    let release: ((reply: BridgeReply) => void) | undefined;
    await connect(fixtureProject, () => new Promise(resolve => { release = resolve; }));
    const abort = new AbortController();
    const waiting = bridge.send({ type: 'askPermission', requestId: 'native-stop', agent: 'Codex', action: 'Run a command' }, 1000, abort.signal);
    for (let i = 0; !release && i < 30; i++) await new Promise(resolve => setTimeout(resolve, 5));
    expect(release).toBeTypeOf('function');
    abort.abort();
    expect(await waiting).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
    release!({ ok: true, message: 'allowed' });
  });

  it('withdraws a pending native approval when the active project changes', async () => {
    const editor = await connect(fixtureProject, () => new Promise(() => undefined));
    const waiting = bridge.send({ type: 'askPermission', requestId: 'native-project', agent: 'Cursor Agent', action: 'Change a file' }, 1000);
    bridge.report({ clientId: editor.clientId, context: { ...bridge.state().context!, projectId: 'prj_another' } });
    expect(await waiting).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
  });

  it('sends commands only to the newest tab and ignores reports from older ones', async () => {
    const first = await connect(fixtureProject);
    const second = await connect({ ...fixtureProject, name: 'Second tab' });
    expect((await send('GET', '/api/editor/state')).body.context.projectName).toBe('Second tab');
    await first.report({ projectName: 'Stale tab' });
    expect((await send('GET', '/api/editor/state')).body.context.projectName).toBe('Second tab');
    await send('POST', '/api/editor/commands', { type: 'save' });
    expect(first.commands).toHaveLength(0);
    expect(second.commands).toHaveLength(1);
  });

  it('clears the closed active tab context before falling back to an older tab', async () => {
    const first = await connect(fixtureProject);
    const second = await connect({ ...fixtureProject, id: 'prj_second', name: 'Second tab' }, () => new Promise(() => undefined));
    const waiting = bridge.send({ type: 'save' }, 1000);
    second.close();
    expect(await waiting).toMatchObject({ ok: false, error: { code: 'CANCELLED', message: 'The editor tab closed.' } });
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(bridge.state()).toMatchObject({ connected: true, context: null, project: null });
    await first.report({ projectName: 'First tab again' });
    expect(bridge.state().context?.projectId).toBe(fixtureProject.id);
  });

  it('tells the editor what the agent is doing', async () => {
    const ed = await connect(fixtureProject);
    const seen: string[] = [];
    // The fake editor ignores activity events; read them straight off the bridge.
    const notify = bridge.notify.bind(bridge);
    bridge.notify = (a) => {
      seen.push(`${a.kind}:${a.detail}`);
      notify(a);
    };
    try {
      await send('GET', '/api/editor/state');
      await send('POST', '/api/stills', { project: fixtureProject, frame: 12 });
    } finally {
      bridge.notify = notify;
    }
    expect(seen).toEqual(['reading:looking at the project', 'rendering:rendering frame 12']);
    expect(ed.commands).toHaveLength(0);
  });

  it('rejects unknown commands and malformed replies', async () => {
    expect((await send('POST', '/api/editor/commands', { type: 'deleteEverything' })).status).toBe(400);
    expect((await send('POST', '/api/editor/replies/cmd_nope', { ok: true, revision: 1, projectId: 'x' })).status).toBe(404);
    expect((await send('POST', '/api/editor/replies/cmd_nope', { nope: 1 })).status).toBe(400);
  });

  it('refuses the event stream and commands from foreign web pages', async () => {
    const evil = { Origin: 'https://evil.example' };
    expect((await send('GET', '/api/editor/events', undefined, evil)).status).toBe(403);
    expect((await send('POST', '/api/editor/commands', { type: 'save' }, evil)).status).toBe(403);
  });
});

describe('POST /api/stills', () => {
  it('renders a frame and returns its URL and path', async () => {
    const r = await send('POST', '/api/stills', { project: fixtureProject, frame: 30, scale: 0.25 });
    expect(r.status).toBe(200);
    const still = r.body as StillResponse;
    expect(still.url).toMatch(/^\/renders\/stills\/s_.+\.png$/);
    expect(still.width).toBe(480);
    expect(stillCalls.at(-1)).toEqual({ frame: 30, scale: 0.25 });
  });

  it('validates frame and scale', async () => {
    expect((await send('POST', '/api/stills', { project: fixtureProject, frame: 999999 })).body.error.path).toBe('frame');
    expect((await send('POST', '/api/stills', { project: fixtureProject, frame: 1.5 })).status).toBe(400);
    expect((await send('POST', '/api/stills', { project: fixtureProject, frame: 0, scale: 3 })).body.error.path).toBe('scale');
  });
});

describe('chat routes', () => {
  it('answers 503 when chat is not configured and validates project ids', async () => {
    expect((await send('GET', '/api/chat/prj_x')).status).toBe(503);
    expect((await send('GET', '/api/chat/providers')).body).toEqual([]);
  });
});
