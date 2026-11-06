import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import type { Express } from 'express';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { serializeDoc, createDocState } from '../src/core/history';
import type { ProjectFile } from '../src/core/types';
import { sampleProject } from '../src/sample/sampleProject';
import { createApp } from './app';
import { EditorSession } from './session';
import { createProjectStore } from './projects';
import { RenderManager } from './renders';

let root: string;
let app: Express;
const session = new EditorSession({ token: 'recovery-test' });
const credentials = session.claim('recovery-test')!;
const cookie = `${session.cookieName}=${credentials.sessionId}`;
const tabSecret = credentials.tabSecret;
const renderStill = vi.fn(async (args: { outputPath: string }) => { await writeFile(args.outputPath, 'fake still'); });
const file = (revision = 1): ProjectFile => serializeDoc(createDocState({ ...structuredClone(sampleProject), revision }));
// Real Express parsing/middleware without opening a socket (also works in the sandbox).
function send(path: string, method = 'GET', body?: unknown): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const bytes = body === undefined ? '' : JSON.stringify(body);
    const req = new IncomingMessage(new Socket());
    req.method = method; req.url = path;
    req.headers = { host: 'localhost:5718', cookie, 'x-mge-tab': tabSecret, ...(body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(bytes)) }) };
    const chunks: Buffer[] = [];
    const socket = new Duplex({ read() {}, write(chunk, _encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    const res = new ServerResponse(req);
    res.assignSocket(socket as Socket);
    res.on('finish', () => {
      const raw = Buffer.concat(chunks).toString();
      try { resolve({ status: res.statusCode, body: JSON.parse(raw.slice(raw.indexOf('\r\n\r\n') + 4)) }); }
      catch (err) { reject(err); }
      socket.destroy(); req.destroy();
    });
    req.on('error', reject); res.on('error', reject);
    app(req, res); if (bytes) req.push(bytes); req.push(null);
  });
}
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'p4-routes-'));
  app = createApp({ session, publicDir: join(root, 'public'), rendersDir: join(root, 'renders'), projects: createProjectStore(join(root, 'projects')), renders: new RenderManager({ rendersDir: join(root, 'renders'), renderer: async () => undefined }), renderStill });
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});
const projectPath = '/api/projects/prj_sample';
describe('checkpoint routes', () => {
  it('stores full files, returns summaries without files, isolates projects and deletes', async () => {
    const created = await send(`${projectPath}/checkpoints`, 'POST', { name: 'Approved', note: 'Client review', file: file(12) });
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ name: 'Approved', note: 'Client review', revision: 12 });
    expect(created.body.projectHash).toMatch(/^[a-f0-9]{64}$/);
    expect(created.body.file).toBeUndefined();
    const path = `${projectPath}/checkpoints/${created.body.id}`;
    expect((await send(path)).body.file.project.revision).toBe(12);
    expect((await send(`${projectPath}/checkpoints`)).body).toContainEqual(created.body);
    expect((await send(`/api/projects/other/checkpoints/${created.body.id}`)).status).toBe(404);
    expect((await send(path, 'DELETE')).status).toBe(200);
    expect((await send(path)).status).toBe(404);
  });
  it('rejects names, ids, malformed files and project mismatch', async () => {
    for (const name of ['', ' ', 'x'.repeat(81), 123]) expect((await send(`${projectPath}/checkpoints`, 'POST', { name, file: file() })).status).toBe(400);
    expect((await send(`${projectPath}/checkpoints`, 'POST', { name: 'ok', note: 42, file: file() })).status).toBe(400);
    expect((await send(`${projectPath}/checkpoints`, 'POST', { name: 'ok', file: {} })).status).toBe(400);
    expect((await send('/api/projects/other/checkpoints', 'POST', { name: 'ok', file: file() })).body.error.code).toBe('PROJECT_MISMATCH');
    for (const path of ['/api/projects/bad.id/checkpoints', `${projectPath}/checkpoints/bad.id`, `${projectPath}/checkpoints/${'x'.repeat(81)}`, `${projectPath}/journal/bad.id`]) expect((await send(path)).status).toBe(400);
  });
});
describe('durable journal routes', () => {
  it('caps concurrent autosaves at 20, survives a fresh store, and preserves explicit saved file', async () => {
    expect((await send(projectPath, 'PUT', file(1))).status).toBe(200);
    const writes = await Promise.all(Array.from({ length: 24 }, (_, i) => send(`${projectPath}?autosave=1`, 'PUT', file(i + 2))));
    expect(writes.every((r) => r.status === 200)).toBe(true);
    const entries = (await send(`${projectPath}/journal`)).body;
    expect(entries).toHaveLength(20);
    expect(entries.every((e: { file?: unknown }) => e.file === undefined)).toBe(true);
    expect((await readdir(join(root, 'projects/prj_sample.journal'))).filter((n) => n.endsWith('.json'))).toHaveLength(20);
    expect(await createProjectStore(join(root, 'projects')).journal('prj_sample')).toEqual(entries);
    expect((await send(projectPath)).body.project.revision).toBe(1);
    const newest = entries[0];
    expect((await send(`${projectPath}/journal/${newest.id}`)).body.file.project.revision).toBe(newest.revision);
    expect((await send(`/api/projects/other/journal/${newest.id}`)).status).toBe(404);
    expect((await send('/api/projects/other?autosave=1', 'PUT', file())).body.error.code).toBe('PROJECT_MISMATCH');
    expect((await send(`${projectPath}?autosave=1`, 'PUT', {})).status).toBe(400);
  });
});
describe('delivery routes', () => {
  it('renders full PNG and JPEG thumbnails with quality 80', async () => {
    for (const preset of ['png-full', 'jpeg-thumb']) {
      const reply = await send('/api/renders/still', 'POST', { project: sampleProject, frame: 30, preset });
      expect(reply.status).toBe(200);
      const thumb = preset === 'jpeg-thumb';
      expect(reply.body.url).toMatch(thumb ? /\.jpg$/ : /\.png$/);
      expect(reply.body.height).toBe(sampleProject.height * (thumb ? 0.25 : 1));
      expect(renderStill).toHaveBeenLastCalledWith(expect.objectContaining({ frame: 30, scale: thumb ? 0.25 : 1, imageFormat: thumb ? 'jpeg' : 'png', ...(thumb ? { jpegQuality: 80 } : {}) }));
    }
  });
  it('rejects invalid still frames/presets and excessive 2160p upscaling', async () => {
    for (const body of [{ frame: -1, preset: 'png-full' }, { frame: 0.5, preset: 'png-full' }, { frame: 999999, preset: 'png-full' }, { frame: 0, preset: 'bad' }]) expect((await send('/api/renders/still', 'POST', { project: sampleProject, ...body })).status).toBe(400);
    expect((await send('/api/renders', 'POST', { project: { ...sampleProject, height: 480 }, preset: 'mp4-2160' })).status).toBe(400);
    expect((await send('/api/renders', 'POST', { project: sampleProject, preset: 'bad' })).status).toBe(400);
  });
});
