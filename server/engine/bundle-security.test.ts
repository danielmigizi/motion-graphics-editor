import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { buildRenderBundle, renderBundleHash, staticBundleHandler } from './bundle';

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'mge-bundle-security-')); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function send(headers: Record<string, string>, path = '/bundle/render.html') {
  return new Promise<{ status: number; headers: ReturnType<ServerResponse['getHeaders']> }>((resolve, reject) => {
    const req = new IncomingMessage(new Socket()); req.url = path; req.method = 'GET'; req.headers = headers;
    const socket = new Duplex({ read() {}, write(_chunk, _encoding, cb) { cb(); } });
    const res = new ServerResponse(req); res.assignSocket(socket as Socket);
    res.on('finish', () => { resolve({ status: res.statusCode, headers: res.getHeaders() }); socket.destroy(); req.destroy(); });
    res.on('error', reject);
    staticBundleHandler(new Map([['bundle', root]]), () => 43210)(req, res);
  });
}
it('refuses rebinding Hosts and foreign Origins, including on reads', async () => {
  await writeFile(join(root, 'render.html'), '<html>render</html>');
  for (const host of ['evil.example:43210', '127.0.0.1:43211', 'localhost', '']) {
    expect((await send({ host })).status).toBe(403);
  }
  for (const origin of ['https://evil.example', 'http://localhost:5317', 'null']) {
    expect((await send({ host: '127.0.0.1:43210', origin })).status).toBe(403);
  }
  for (const headers of [{ host: 'localhost:43210' }, { host: '127.0.0.1:43210', origin: 'http://127.0.0.1:43210' }] as Record<string, string>[]) {
    const response = await send(headers);
    expect(response.status).toBe(200);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  }
  expect((await send({ host: '127.0.0.1:43210' }, '/bad%ZZ')).status).toBe(404);
});
it('disables publicDir and invalidates legacy bundle hashes when build policy changes', async () => {
  for (const dir of ['src/composition', 'src/core', 'src/runtime', 'src/render', 'server/engine', 'public/assets/uploads']) await mkdir(join(root, dir), { recursive: true });
  for (const file of ['render.html', 'package.json', 'server/engine/bundle.ts', 'public/assets/uploads/private.svg']) await writeFile(join(root, file), file === 'package.json' ? '{}' : file === 'render.html' ? '<!doctype html><p>render</p>' : file);
  const result = await buildRenderBundle(root, () => {});
  expect(await readFile(join(result.dir, 'render.html'), 'utf8')).toContain('render');
  await writeFile(join(root, 'server/engine/bundle.ts'), 'updated build policy');
  expect(await renderBundleHash(root)).not.toBe(result.hash);
  await expect(readFile(join(result.dir, 'assets/uploads/private.svg'))).rejects.toThrow();
});
