// Exercise real Express middleware and routes without requiring a listening socket.
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Express } from 'express';
import { sampleProject } from '../src/sample/sampleProject';
import { projectDurationInFrames } from '../src/core/timing';
import { createApp, type AppDeps } from './app';
import { createProjectStore } from './projects';
import { RenderManager } from './renders';

function request(app: Express, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? '' : JSON.stringify(body);
    const req = new IncomingMessage(new Socket());
    req.method = method;
    req.url = path;
    req.headers = { host: 'localhost:5618', ...(body !== undefined ? { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(bytes)) } : {}) };
    const chunks: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    const res = new ServerResponse(req);
    res.assignSocket(socket as Socket);
    res.on('finish', () => {
      const raw = Buffer.concat(chunks).toString();
      const payload = raw.slice(raw.indexOf('\r\n\r\n') + 4);
      try { resolve({ status: res.statusCode, body: JSON.parse(payload) }); } catch (err) { reject(err); }
      socket.destroy();
      req.destroy();
    });
    req.on('error', reject);
    res.on('error', reject);
    app(req, res);
    if (bytes) req.push(bytes);
    req.push(null);
  });
}

let dir: string;
let deps: AppDeps;
let manager: RenderManager;
let seen: any[];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mge-render-routes-'));
  const publicDir = join(dir, 'public');
  await mkdir(publicDir);
  manager = new RenderManager({ rendersDir: join(dir, 'renders'), publicDir, renderer: async () => undefined });
  seen = [];
  deps = {
    publicDir, rendersDir: join(dir, 'renders'), projects: createProjectStore(join(dir, 'projects')), renders: manager,
    webPort: 5617, serverPort: 5618,
    renderStill: async (args) => { seen.push(args); await writeFile(args.outputPath, 'png'); },
    renderContactSheet: async (args) => { seen.push(args); await writeFile(args.outputPath, 'png'); },
  };
});
afterEach(async () => { await manager.whenIdle(); await rm(dir, { recursive: true, force: true }); });
const post = (app: Express, path: string, body?: unknown) => request(app, 'POST', path, body);

describe('contact sheet route', () => {
  it('returns capped dimensions, selected frames and a PNG path', async () => {
    const frames = [30, 150, 240, 420, 510, 690];
    const result = await post(createApp(deps), '/api/stills/contact-sheet', { project: sampleProject, frames, columns: 3 });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ frames, width: 1920, height: 784, url: expect.stringMatching(/^\/renders\/stills\/cs_.*\.png$/), path: expect.stringContaining(dir) });
    expect(seen[0]).toMatchObject({ frames, columns: 3, labels: true, scale: 1, signal: expect.any(AbortSignal) });
  });
  it('rejects invalid frames, count, columns and scale before invoking the renderer', async () => {
    const app = createApp(deps);
    for (const frames of [[], Array(25).fill(0), [-1], [0.5], [projectDurationInFrames(sampleProject)], ['0'], null]) {
      const result = await post(app, '/api/stills/contact-sheet', { project: sampleProject, frames });
      expect(result.status).toBe(400);
      expect(result.body.error.path).toBe('frames');
    }
    for (const columns of [0, 25, 1.5, '2']) expect((await post(app, '/api/stills/contact-sheet', { project: sampleProject, frames: [0], columns })).status).toBe(400);
    for (const scale of [0, 2, '0.5']) expect((await post(app, '/api/stills/contact-sheet', { project: sampleProject, frames: [0], scale })).status).toBe(400);
    expect((await post(app, '/api/stills/contact-sheet', { frames: [0] })).status).toBe(400);
    expect(seen).toEqual([]);
  });
  it('accepts the last frame and the maximum 24 cells, and reports an unavailable renderer', async () => {
    const frames = Array(24).fill(projectDurationInFrames(sampleProject) - 1);
    expect((await post(createApp(deps), '/api/stills/contact-sheet', { project: sampleProject, frames })).status).toBe(200);
    expect((await post(createApp({ ...deps, renderContactSheet: undefined }), '/api/stills/contact-sheet', { project: sampleProject, frames: [0] })).status).toBe(503);
  });
});

describe('labelled stills', () => {
  it('labels committed and proposal frames with the same snapshot and composition identity', async () => {
    const app = createApp(deps);
    const committed = await post(app, '/api/stills', { project: sampleProject, frame: 30 });
    const proposal = await post(app, '/api/stills', { project: sampleProject, frame: 30, proposalId: 'proposal_1' });
    expect(committed.status).toBe(200);
    expect(committed.body.identity).toMatchObject({
      projectId: sampleProject.id, revision: sampleProject.revision, frame: 30, kind: 'committed',
      projectHash: expect.stringMatching(/^[a-f0-9]{64}$/), compositionHash: expect.stringMatching(/^[a-f0-9]{64}$/), rendererVersion: expect.any(String),
    });
    expect(committed.body.identity.proposalId).toBeUndefined();
    expect(proposal.body.identity).toEqual({ ...committed.body.identity, kind: 'proposal', proposalId: 'proposal_1' });
    expect((await post(app, '/api/stills', { project: sampleProject, frame: 0, proposalId: '' })).status).toBe(400);
  });
});

describe('render lifecycle routes', () => {
  it('returns 404 for unknown cancel/retry/manifest and 409 for terminal cancellation or successful retry', async () => {
    const app = createApp(deps);
    for (const action of ['cancel', 'retry']) expect((await post(app, `/api/renders/nope/${action}`)).status).toBe(404);
    expect((await request(app, 'GET', '/api/renders/nope/manifest')).status).toBe(404);
    const job = await manager.start(sampleProject);
    await manager.whenIdle();
    for (const action of ['cancel', 'retry']) {
      const result = await post(app, `/api/renders/${job.id}/${action}`);
      expect(result.status).toBe(409);
      expect(result.body.error.message).toContain('done');
    }
  });
  it('cancels a running render through the HTTP route and leaves no output', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    manager = new RenderManager({ rendersDir: deps.rendersDir, publicDir: deps.publicDir, renderer: async ({ signal, outputPath, onProgress }) => {
      await writeFile(outputPath, 'partial');
      onProgress({ stage: 'rendering', progress: 0.2 });
      entered();
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      signal.throwIfAborted();
    } });
    const app = createApp({ ...deps, renders: manager });
    const start = await post(app, '/api/renders', { project: sampleProject });
    await started;
    const result = await post(app, `/api/renders/${start.body.id}/cancel`);
    expect(result.status).toBe(200);
    expect(result.body.status).toBe('cancelled');
    expect((await request(app, 'GET', `/api/renders/${start.body.id}`)).body.status).toBe('cancelled');
    const repeat = await post(app, `/api/renders/${start.body.id}/cancel`);
    expect(repeat.status).toBe(409);
    expect(repeat.body.error.message).toContain('already cancelled');
  });
  it('serves the frozen manifest and verifies changed assets after restart', async () => {
    const project = structuredClone(sampleProject);
    project.assets = { ast_logo: { ...project.assets.ast_logo, src: 'logo.svg' } };
    await writeFile(join(deps.publicDir, 'logo.svg'), 'first');
    const job = await manager.start(project, { simulateFailureAtProgress: 0 });
    await manager.whenIdle();
    const restored = new RenderManager({ rendersDir: deps.rendersDir, publicDir: deps.publicDir, renderer: async () => undefined });
    await restored.load();
    const app = createApp({ ...deps, renders: restored });
    const manifest = await request(app, 'GET', `/api/renders/${job.id}/manifest`);
    expect(manifest.status).toBe(200);
    expect(manifest.body.projectHash).toBe(restored.get(job.id)?.projectHash);
    await writeFile(join(deps.publicDir, 'logo.svg'), 'second');
    const verified = await request(app, 'GET', `/api/renders/${job.id}/manifest?verify=1`);
    expect(verified.body).toEqual({ manifest: manifest.body, changedAssets: ['ast_logo'] });
    const list = await request(app, 'GET', '/api/renders');
    expect(list.body[0].id).toBe(job.id);
    const retried = await post(app, `/api/renders/${job.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body.retryOf).toBe(job.id);
    await restored.whenIdle();
  });
});


it('labels a still with the actual bundle identity instead of current source bytes', async () => {
  deps.renderStill = async ({ outputPath, onCompositionHash }) => {
    await onCompositionHash?.('cached-bundle-code');
    await writeFile(outputPath, 'png');
  };
  const result = await post(createApp(deps), '/api/stills', { project: sampleProject, frame: 0 });
  expect(result.status).toBe(200);
  expect(result.body.identity.compositionHash).toBe('cached-bundle-code');
});
