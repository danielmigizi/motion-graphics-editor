// The render page bundle: render.html built by Vite into
// .engine-bundle/<hash>/, where <hash> covers every source the page can
// import. An unchanged tree reuses the build across server restarts. A tiny static server serves the bundle and the
// exporter's decoded video frames to headless Chrome.

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { createServer, type RequestListener, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize, resolve, sep } from 'node:path';

/** Sources the render page is built from (relative to the repo root). */
const SOURCE_DIRS = ['src/composition', 'src/core', 'src/runtime', 'src/render'];
const SOURCE_FILES = ['render.html', 'package.json', 'server/engine/bundle.ts'];

export async function renderBundleHash(rootDir: string): Promise<string> {
  const files: string[] = [...SOURCE_FILES];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(join(rootDir, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && !/\.test\.tsx?$/.test(entry.name)) files.push(path);
    }
  };
  for (const dir of SOURCE_DIRS) await walk(dir);
  const hash = createHash('sha256');
  for (const path of files.sort()) {
    hash.update(path);
    hash.update(await readFile(join(rootDir, path)));
  }
  return hash.digest('hex').slice(0, 20);
}

/** Build (or reuse) the render page; resolves to the directory holding render.html. */
export async function buildRenderBundle(rootDir: string, log: (m: string) => void, force = false): Promise<{ dir: string; hash: string; built: boolean }> {
  const hash = await renderBundleHash(rootDir);
  const base = join(rootDir, '.engine-bundle');
  const dir = join(base, hash);
  if (!force && (await stat(join(dir, 'render.html')).then(() => true, () => false))) return { dir, hash, built: false };
  const started = Date.now();
  const { build } = await import('vite');
  const { default: react } = await import('@vitejs/plugin-react');
  const tmp = `${dir}.tmp-${process.pid}`;
  await rm(tmp, { recursive: true, force: true });
  await build({
    root: rootDir,
    configFile: false,
    publicDir: false,
    base: './',
    logLevel: 'warn',
    plugins: [react()],
    build: { outDir: tmp, emptyOutDir: true, sourcemap: false, rollupOptions: { input: join(rootDir, 'render.html') } },
  });
  await mkdir(base, { recursive: true });
  await rm(dir, { recursive: true, force: true });
  await rename(tmp, dir);
  // Keep the newest few builds.
  const builds = (await readdir(base, { withFileTypes: true })).filter((d) => d.isDirectory() && !d.name.includes('.tmp-'));
  const dated = await Promise.all(builds.map(async (d) => ({ name: d.name, t: (await stat(join(base, d.name))).mtimeMs })));
  for (const old of dated.sort((a, b) => b.t - a.t).slice(4)) await rm(join(base, old.name), { recursive: true, force: true });
  log(`render page built in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return { dir, hash, built: true };
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.json': 'application/json',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export interface StaticServer {
  url: string;
  /** Serve `dir` under `/<prefix>/`. */
  mount(prefix: string, dir: string): void;
  close(): Promise<void>;
}

/** Exported so request security can be checked without binding a socket. */
export function staticBundleHandler(mounts: ReadonlyMap<string, string>, port: () => number): RequestListener {
  return (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port()}` && host !== `localhost:${port()}`) return void res.writeHead(403).end();
    if (req.headers.origin !== undefined && req.headers.origin !== `http://127.0.0.1:${port()}`) return void res.writeHead(403).end();
    let path: string;
    try { path = decodeURIComponent((req.url ?? '/').split('?')[0]); }
    catch { return void res.writeHead(404).end(); }
    if (path.includes('\0')) return void res.writeHead(404).end();
    const [, prefix, ...rest] = path.split('/');
    const root = mounts.get(prefix);
    const file = root ? normalize(join(root, ...rest)) : null;
    if (!root || !file || !(file === root || file.startsWith(root + sep))) {
      res.writeHead(404).end();
      return;
    }
    stat(file).then(
      (s) => {
        if (!s.isFile()) return void res.writeHead(404).end();
        res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream', 'Content-Length': s.size, 'Cache-Control': 'max-age=31536000, immutable' });
        createReadStream(file).on('error', () => res.destroy()).pipe(res);
      },
      () => res.writeHead(404).end(),
    );
  };
}

/** Loopback static file server for the bundle and decoded frames. */
export async function startStaticServer(): Promise<StaticServer> {
  const mounts = new Map<string, string>();
  const server: Server = createServer(staticBundleHandler(mounts, () => (server.address() as AddressInfo).port));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    mount: (prefix, dir) => void mounts.set(prefix, resolve(dir)),
    close: () => new Promise((r) => server.close(() => r())),
  };
}
