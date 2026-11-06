import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { sampleProject } from '../src/sample/sampleProject';
import { buildManifest, compositionHash, projectHash, verifyManifest } from './manifest';

let dir: string;
afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

describe('render manifest', () => {
  it('hashes canonical snapshots independently of object key order', () => {
    const reordered = Object.fromEntries(Object.entries(sampleProject).reverse()) as typeof sampleProject;
    expect(projectHash(reordered)).toBe(projectHash(sampleProject));
    expect(projectHash({ ...sampleProject, revision: sampleProject.revision + 1 })).not.toBe(projectHash(sampleProject));
  });

  it('records installed versions and hashes bytes; verification detects changed, removed and newly present assets', async () => {
    dir = await mkdtemp(join(tmpdir(), 'mge-manifest-'));
    await mkdir(join(dir, 'assets'));
    const src = 'assets/logo.svg';
    await writeFile(join(dir, src), 'first');
    const project = structuredClone(sampleProject);
    project.assets = {
      ast_logo: { ...project.assets.ast_logo, src },
      ast_missing: { ...project.assets.ast_logo, id: 'ast_missing', src: 'assets/later.svg' },
    };
    let captured: Buffer | undefined;
    const manifest = await buildManifest(project, { publicDir: dir, rootDir: process.cwd(), captureAsset: (_id, bytes) => { captured = bytes; } });
    expect(captured?.toString()).toBe('first');
    expect(manifest.assets.find((asset) => asset.id === 'ast_logo')).toMatchObject({ sha256: createHash('sha256').update('first').digest('hex'), bytes: 5, missing: false });
    expect(manifest.assets.find((asset) => asset.id === 'ast_missing')).toMatchObject({ sha256: null, bytes: null, missing: true });
    const font = JSON.parse(await readFile('node_modules/@fontsource/ibm-plex-mono/package.json', 'utf8'));
    expect(manifest.fonts).toContainEqual({ family: 'IBM Plex Mono', package: '@fontsource/ibm-plex-mono', version: font.version });
    const app = JSON.parse(await readFile('package.json', 'utf8'));
    expect(manifest.renderer).toEqual({ engine: 'native', version: `native ${app.version}`, node: process.version });
    expect(manifest.code.compositionHash).toBe(await compositionHash(process.cwd()));
    expect(await verifyManifest(manifest, dir)).toEqual([]);
    await writeFile(join(dir, src), 'changed');
    await writeFile(join(dir, 'assets/later.svg'), 'now here');
    expect(await verifyManifest(manifest, dir)).toEqual(['ast_logo', 'ast_missing']);
    await rm(join(dir, src));
    expect(await verifyManifest(manifest, dir)).toContain('ast_logo');
  });
});


it('refreshes source identity after renderer source changes', async () => {
  dir = await mkdtemp(join(tmpdir(), 'mge-code-hash-'));
  await mkdir(join(dir, 'src/composition'), { recursive: true });
  await mkdir(join(dir, 'src/core'), { recursive: true });
  for (const name of ['animation', 'timing', 'types', 'components', 'limits']) await writeFile(join(dir, `src/core/${name}.ts`), name);
  const path = join(dir, 'src/composition/MainComposition.tsx');
  await writeFile(path, 'old renderer');
  const before = await compositionHash(dir);
  await writeFile(path, 'new renderer');
  const after = await compositionHash(dir);
  expect(after).not.toBe(before);
  // The runtime the composition runs on is part of its identity too.
  await mkdir(join(dir, 'src/runtime'), { recursive: true });
  await writeFile(join(dir, 'src/runtime/TimeSpan.tsx'), 'runtime');
  expect(await compositionHash(dir)).not.toBe(after);
});
