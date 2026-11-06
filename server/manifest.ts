// Export identity uses canonical JSON and the bytes captured for this export.
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createReadStream } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import type { RenderManifest } from '../src/core/api-contract';
import type { Project } from '../src/core/types';

const exec = promisify(execFile);
const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).filter((key) => obj[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export const projectHash = (project: Project): string => sha256(canonicalJson(project));
/** Fresh source identity; the renderer caches this together with its bundle. */
export async function compositionHash(rootDir: string): Promise<string> {
  const root = resolve(rootDir);
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(path);
    }
  };
  for (const dir of ['src/composition', 'src/runtime', 'src/render']) {
    if (await stat(join(root, dir)).then((s) => s.isDirectory(), () => false)) await walk(dir);
  }
  files.push(...['animation', 'timing', 'types', 'components', 'limits'].map(name => `src/core/${name}.ts`));
  const hash = createHash('sha256');
  for (const path of files.sort()) hash.update(await readFile(join(root, path)));
  return hash.digest('hex');
}

/** The export engine's identity: our native engine at this app version. */
export async function rendererVersion(rootDir: string): Promise<string> {
  return `native ${JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8')).version}`;
}

/** Files this size or larger (and every video) are hashed by streaming and frozen by copying — never read whole. */
export const STREAM_HASH_BYTES = 16 * 1024 * 1024;

/** Real path of an asset file inside publicDir; null when missing or outside it. */
async function assetPath(publicDir: string, src: string): Promise<string | null> {
  try {
    if (/^[a-z]+:/i.test(src)) return null;
    const root = await realpath(publicDir);
    const path = await realpath(resolve(root, src.replace(/^\/+/, '')));
    const rel = relative(root, path);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return path;
  } catch (err) {
    if (['ENOENT', 'ENOTDIR'].includes((err as NodeJS.ErrnoException).code ?? '')) return null;
    throw err;
  }
}

/** sha256 and size of a file, streamed in chunks. */
export function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    let bytes = 0;
    createReadStream(path)
      .on('data', (chunk) => {
        bytes += chunk.length;
        hash.update(chunk);
      })
      .on('error', reject)
      .on('end', () => resolvePromise({ sha256: hash.digest('hex'), bytes }));
  });
}

export interface ManifestOptions {
  publicDir: string;
  rootDir: string;
  /** Receives the very bytes hashed, avoiding a second read for asset freezing (small files). */
  captureAsset?: (id: string, bytes: Buffer) => void;
  /**
   * Large files and videos: copy the file to its frozen location and return
   * that path; the copy is what gets hashed (streamed), so the manifest names
   * exactly the bytes the render reads.
   */
  freezeLargeAsset?: (id: string, path: string) => Promise<string>;
}

export async function buildManifest(project: Project, options: ManifestOptions): Promise<RenderManifest> {
  const { publicDir, rootDir } = options;
  const reads = new Map<string, Promise<Buffer | null>>();
  const assets = await Promise.all(Object.values(project.assets).sort((a, b) => a.id.localeCompare(b.id)).map(async (asset) => {
    const path = await assetPath(publicDir, asset.src);
    if (path && (asset.kind === 'video' || (await stat(path)).size >= STREAM_HASH_BYTES)) {
      const hashed = await hashFile(options.freezeLargeAsset ? await options.freezeLargeAsset(asset.id, path) : path);
      return { id: asset.id, src: asset.src, sha256: hashed.sha256, bytes: hashed.bytes, missing: false };
    }
    if (!reads.has(asset.src)) reads.set(asset.src, path ? readFile(path) : Promise.resolve(null));
    const bytes = await reads.get(asset.src)!;
    if (bytes) options.captureAsset?.(asset.id, bytes);
    return { id: asset.id, src: asset.src, sha256: bytes ? sha256(bytes) : null, bytes: bytes?.length ?? null, missing: bytes === null };
  }));
  const pkg = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
  const fonts = await Promise.all(Object.keys(pkg.dependencies ?? {}).filter((name) => /^@fontsource[^/]*\//.test(name)).sort().map(async (name) => {
    const installed = JSON.parse(await readFile(join(rootDir, 'node_modules', name, 'package.json'), 'utf8'));
    let family = installed.fontsource?.family ?? name.split('/')[1].split('-').map((word) => word[0].toUpperCase() + word.slice(1)).join(' ');
    try {
      const metadata = JSON.parse(await readFile(join(rootDir, 'node_modules', name, 'metadata.json'), 'utf8'));
      family = metadata.family ?? family;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    return { family, package: name, version: installed.version };
  }));
  let gitCommit: string | null = null;
  let dirty: boolean | null = null;
  try {
    const [commit, status] = await Promise.all([
      exec('git', ['rev-parse', 'HEAD'], { cwd: rootDir, timeout: 5000 }),
      exec('git', ['status', '--porcelain'], { cwd: rootDir, timeout: 5000 }),
    ]);
    gitCommit = commit.stdout.trim();
    dirty = status.stdout.trim().length > 0;
  } catch { /* Source archives have no Git metadata. */ }
  return {
    format: 'mge.manifest/1', projectId: project.id, projectRevision: project.revision, projectHash: projectHash(project),
    assets, fonts, renderer: { engine: 'native', version: await rendererVersion(rootDir), node: process.version },
    code: { gitCommit, dirty, compositionHash: await compositionHash(rootDir) }, createdAt: new Date().toISOString(),
  };
}

export async function verifyManifest(manifest: RenderManifest, publicDir: string): Promise<string[]> {
  const changed = await Promise.all(manifest.assets.map(async (asset) => {
    const path = await assetPath(publicDir, asset.src);
    return (path ? (await hashFile(path)).sha256 : null) !== asset.sha256 ? asset.id : null;
  }));
  return changed.filter((id): id is string => id !== null);
}
