// Execute the actual route handlers against the filesystem without opening a
// socket; the HTTP integration suites cover the common host/origin middleware.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureProject } from '../src/core/__fixtures__/fixtureProject';
import type { Proposal } from '../src/core/proposal';
import { PATCH_PROTOCOL } from '../src/core/types';
import { createApp } from './app';
import { EditorSession } from './session';
import { createProjectStore } from './projects';
import { RenderManager } from './renders';

let root: string;
let cookie: string;
let tabSecret: string;
let app: ReturnType<typeof createApp>;
let projects: ReturnType<typeof createProjectStore>;
const proposal = (): Proposal => ({ id: 'prop_1', projectId: fixtureProject.id, docSession: 'session-1', agent: 'Codex', source: 'mcp', reconcile: true, createdAt: 1000,
  patch: { protocol: PATCH_PROTOCOL, projectId: fixtureProject.id, baseRevision: fixtureProject.revision, summary: 'Bigger headline', targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }], commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 120 } } }] },
});

async function route(method: string, id: string, body?: unknown) {
  // Express exposes its registered router. Call the endpoint after JSON parsing.
  const layer = app.router.stack.find((l: any) => l.route?.path === '/api/projects/:id/proposal' && l.route.methods[method]);
  let status = 200;
  let result: any;
  const res = { status: (code: number) => { status = code; return res; }, json: (data: unknown) => { result = data; return res; } };
  if (!layer?.route) throw new Error('Proposal route is missing');
  const req = { params: { id }, body, headers: { cookie }, get: (name: string) => name.toLowerCase() === 'x-mge-tab' ? tabSecret : undefined };
  for (const handler of layer.route.stack) {
    // JSON has already been parsed by this handler-level harness.
    if (handler.name === 'jsonParser') continue;
    await (handler.handle as Function)(req, res, (error?: unknown) => { if (error) throw error; });
    if (result !== undefined) break;
  }
  return { status, body: result };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mge-proposal-routes-'));
  projects = createProjectStore(join(root, 'projects'));
  await projects.save(fixtureProject.id, { format: 'mge.project/1', project: fixtureProject, revisions: [], savedAt: '2026-10-13T00:00:00Z' });
  const session = new EditorSession({ token: 'proposal-test' });
  const credentials = session.claim('proposal-test')!;
  cookie = `${session.cookieName}=${credentials.sessionId}`;
  tabSecret = credentials.tabSecret;
  app = createApp({ session, projects, publicDir: join(root, 'public'), rendersDir: join(root, 'renders'), renders: new RenderManager({ rendersDir: join(root, 'renders'), renderer: async () => undefined }) });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('proposal persistence routes', () => {
  it('round-trips, survives a new store instance, and deletes idempotently', async () => {
    expect((await route('get', fixtureProject.id)).status).toBe(404);
    expect((await route('put', fixtureProject.id, { proposal: proposal() })).status).toBe(200);
    const saved = (await route('get', fixtureProject.id)).body;
    expect(saved).toEqual({ proposal: proposal(), savedAt: expect.any(String) });
    expect(Number.isFinite(Date.parse(saved.savedAt))).toBe(true);
    const disk = JSON.parse(await readFile(join(root, 'projects', `${fixtureProject.id}.proposal.json`), 'utf8'));
    expect(disk).toEqual(saved);
    expect(await createProjectStore(join(root, 'projects')).loadProposal(fixtureProject.id)).toEqual(saved);
    expect(await projects.list()).toHaveLength(1);
    expect((await route('delete', fixtureProject.id)).status).toBe(200);
    expect((await route('delete', fixtureProject.id)).status).toBe(200);
    expect((await route('get', fixtureProject.id)).status).toBe(404);
  });

  it.each(['get', 'put', 'delete'])('rejects invalid URL ids for %s', async (method) => {
    expect((await route(method, '../invalid', { proposal: proposal() })).status).toBe(400);
  });

  it('validates metadata, patch shape, and both project identities', async () => {
    const p = proposal();
    for (const bad of [{}, { ...p, reconcile: 'yes' }, { ...p, agent: '' }, { ...p, createdAt: -1 }, { ...p, patch: { ...p.patch, protocol: 'bad' } }, { ...p, projectId: 'other' }, { ...p, patch: { ...p.patch, projectId: 'other' } }]) {
      expect((await route('put', fixtureProject.id, { proposal: bad })).status).toBe(400);
    }
    expect(await projects.loadProposal(fixtureProject.id)).toBeNull();
  });

  it('refuses proposal persistence for an unsaved project', async () => {
    const p = proposal();
    p.projectId = p.patch.projectId = 'prj_missing';
    expect((await route('put', p.projectId, { proposal: p })).status).toBe(404);
  });
});
