// Origin rule: foreign origins cannot read or write; CLI and local editor origins are allowed.

import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ProjectFile } from '../src/core/types';
import { sampleProject } from '../src/sample/sampleProject';
import { createApp } from './app';
import { createProjectStore } from './projects';
import { RenderManager } from './renders';

const WEB_PORT = 5917;
const SERVER_PORT = 5918;

let root: string;
let server: Server;
let port: number;

interface Reply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function send(method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const file = (): ProjectFile => ({ format: 'mge.project/1', project: sampleProject, revisions: [], savedAt: new Date(0).toISOString() });
const put = (origin?: string) =>
  send('PUT', `/api/projects/${sampleProject.id}`, { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, JSON.stringify(file()));

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mge-app-'));
  const app = createApp({
    publicDir: join(root, 'public'),
    rendersDir: join(root, 'renders'),
    projects: createProjectStore(join(root, 'projects')),
    renders: new RenderManager({ rendersDir: join(root, 'renders'), renderer: async () => undefined }),
    webPort: WEB_PORT,
    serverPort: SERVER_PORT,
  });
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
});

describe('origin rule', () => {
  it('allows writes without an Origin header (CLI, scripts)', async () => {
    expect((await put()).status).toBe(200);
  });

  it('allows writes from the editor and the server origin on localhost and 127.0.0.1', async () => {
    for (const origin of [`http://localhost:${WEB_PORT}`, `http://127.0.0.1:${WEB_PORT}`, `http://localhost:${SERVER_PORT}`, `http://127.0.0.1:${SERVER_PORT}`]) {
      const r = await put(origin);
      expect(r.status, origin).toBe(200);
      expect(r.headers['access-control-allow-origin'], origin).toBe(origin);
    }
  });

  it('rejects writes from any other origin with a 403 ApiError and changes nothing', async () => {
    for (const origin of ['http://evil.example', 'http://localhost:5317', `https://localhost:${WEB_PORT}`, `http://[::1]:${WEB_PORT}`, 'null']) {
      const r = await put(origin);
      expect(r.status, origin).toBe(403);
      const body = JSON.parse(r.body);
      expect(body.error.message, origin).toContain(origin);
    }
    const upload = await send('POST', '/api/assets?filename=x.svg', { Origin: 'http://evil.example', 'Content-Type': 'image/svg+xml' }, '<svg/>');
    expect(upload.status).toBe(403);
    const render = await send('POST', '/api/renders', { Origin: 'http://evil.example', 'Content-Type': 'application/json' }, JSON.stringify({ project: sampleProject }));
    expect(render.status).toBe(403);
    expect((await send('DELETE', '/api/projects/prj_sample', { Origin: 'http://evil.example' })).status).toBe(403);
  });

  it('rejects foreign-origin GET and HEAD reads', async () => {
    for (const method of ['GET', 'HEAD']) {
      const r = await send(method, '/api/health', { Origin: 'http://evil.example' });
      expect(r.status, method).toBe(403);
      expect(r.headers['access-control-allow-origin'], method).toBeUndefined();
    }
  });

  it('answers preflights only for allowed origins', async () => {
    const readPreflight = await send('OPTIONS', '/api/projects', { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'GET' });
    expect(readPreflight.status).toBe(403);
    const evilWrite = await send('OPTIONS', '/api/renders', { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' });
    expect(evilWrite.status).toBe(403);
    const editorWrite = await send('OPTIONS', '/api/renders', { Origin: `http://localhost:${WEB_PORT}`, 'Access-Control-Request-Method': 'POST' });
    expect(editorWrite.status).toBe(204);
    expect(editorWrite.headers['access-control-allow-origin']).toBe(`http://localhost:${WEB_PORT}`);
    expect(String(editorWrite.headers['access-control-allow-methods'])).toContain('POST');
  });
});

describe('host check', () => {
  it('rejects requests addressed to a non-loopback hostname', async () => {
    const http = await import('node:http');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const root = mkdtempSync(join(tmpdir(), 'mge-host-'));
    const app = createApp({
      publicDir: join(root, 'public'),
      rendersDir: join(root, 'renders'),
      projects: createProjectStore(join(root, 'projects')),
      renders: new RenderManager({ rendersDir: join(root, 'renders'), renderer: async () => undefined }),
    });
    const server = http.createServer(app).listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    const status = (host: string) =>
      new Promise<number>((resolve, reject) => {
        http.get({ host: '127.0.0.1', port, path: '/api/health', headers: { host } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }).on('error', reject);
      });
    const ok = await status(`localhost:${port}`);
    const bad = await status('evil.example');
    server.close();
    expect(ok).toBe(200);
    expect(bad).toBe(403);
  });
});

describe('GET /api/assets/probe', () => {
  it('probes an uploaded file and reports a missing one', async () => {
    const up = await send('POST', '/api/assets?filename=mark.svg', { 'Content-Type': 'image/svg+xml' }, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 24"/>');
    expect(up.status).toBe(200);
    const { src } = JSON.parse(up.body) as { src: string };
    const probe = await send('GET', `/api/assets/probe?src=${encodeURIComponent(src)}`);
    expect(probe.status).toBe(200);
    expect(JSON.parse(probe.body)).toMatchObject({ exists: true, decodable: true, mimeType: 'image/svg+xml', width: 48, height: 24 });
    const missing = JSON.parse((await send('GET', '/api/assets/probe?src=assets/nope.png')).body);
    expect(missing).toMatchObject({ exists: false, decodable: false });
    expect(JSON.parse((await send('GET', '/api/assets/probe')).body)).toMatchObject({ exists: false, decodable: false });
  });
});
