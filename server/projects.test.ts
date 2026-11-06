import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProjectFile } from '../src/core/types';
import { sampleProject } from '../src/sample/sampleProject';
import { createProjectStore, isValidProjectId, writeFileAtomic } from './projects';

describe('isValidProjectId', () => {
  it('accepts letters, digits, _ and -', () => {
    expect(isValidProjectId('prj_sample')).toBe(true);
    expect(isValidProjectId('A-b_9')).toBe(true);
  });
  it('rejects traversal, separators, dots, empty and non-strings', () => {
    for (const bad of ['', '../etc', 'a/b', 'a\\b', 'a.json', '..', 'a b', 'ünï', 'x'.repeat(129)]) {
      expect(isValidProjectId(bad), bad).toBe(false);
    }
    expect(isValidProjectId(undefined)).toBe(false);
    expect(isValidProjectId(42)).toBe(false);
  });
});

describe('project store', () => {
  let root: string;
  let dir: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'mge-projects-'));
    dir = join(root, 'projects');
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const file = (revision: number): ProjectFile => ({
    format: 'mge.project/1',
    project: { ...sampleProject, revision },
    revisions: [],
    savedAt: `2026-10-09T00:00:0${revision}.000Z`,
  });

  it('round-trips a ProjectFile and creates the dir on demand', async () => {
    const store = createProjectStore(dir);
    expect(await store.list()).toEqual([]);
    expect(await store.load('prj_sample')).toBeNull();
    await store.save('prj_sample', file(3));
    expect(await store.load('prj_sample')).toEqual(file(3));
    expect(await store.list()).toEqual([{ id: 'prj_sample', name: sampleProject.name, revision: 3, savedAt: file(3).savedAt }]);
  });

  it('overwrites atomically and leaves no temp files', async () => {
    const store = createProjectStore(dir);
    await store.save('prj_sample', file(1));
    await store.save('prj_sample', file(2));
    expect((await store.load('prj_sample'))!.project.revision).toBe(2);
    expect((await readdir(dir)).sort()).toEqual(['prj_sample.journal', 'prj_sample.json', 'prj_sample.json.writer']);
  });

  it('refuses invalid ids', async () => {
    const store = createProjectStore(dir);
    await expect(store.save('../evil', file(1))).rejects.toThrow(/Invalid project id/);
    await expect(store.load('a/b')).rejects.toThrow(/Invalid project id/);
  });

  it('writeFileAtomic replaces content', async () => {
    const store = createProjectStore(dir);
    await store.save('x', file(1));
    const p = join(dir, 'x.json');
    await writeFileAtomic(p, '{"a":1}');
    expect(await readFile(p, 'utf8')).toBe('{"a":1}');
  });
});

// The store is itself a load boundary, including historical snapshots.
describe('project store schema migration', () => {
  it('loads and saves a legacy document as v2 without changing scenes', async () => {
    const { default: legacy } = await import('../src/core/__fixtures__/v1-project.json');
    const root = await mkdtemp(join(tmpdir(), 'mge-project-migrate-'));
    try {
      const raw = { format: 'mge.project/1', project: legacy, revisions: [{revision:legacy.revision, snapshot:legacy, label:'Opened', source:'load', at:0, touched:[]}], savedAt: '2026-01-01T00:00:00Z' };
      await writeFileAtomic(join(root, `${legacy.id}.json`), JSON.stringify(raw));
      const store = createProjectStore(root), loaded = await store.load(legacy.id);
      expect(loaded!.project.schemaVersion).toBe(3); expect(loaded!.revisions[0].snapshot.schemaVersion).toBe(3); expect(loaded!.project.scenes).toEqual(legacy.scenes);
      await store.save(legacy.id, loaded!); expect(JSON.parse(await readFile(join(root, `${legacy.id}.json`),'utf8')).project.schemaVersion).toBe(3);
    } finally { await rm(root,{recursive:true,force:true}); }
  });
  it('refuses newer editor files with an actionable error', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mge-project-newer-'));
    try {
      await writeFileAtomic(join(root, 'new.json'),JSON.stringify({format:'mge.project/1',project:{schemaVersion:10},revisions:[],savedAt:''}));
      const store=createProjectStore(root); await expect(store.load('new')).rejects.toThrow('This project was saved by a newer editor (schema 10)'); expect(await store.list()).toEqual([]);
    } finally { await rm(root,{recursive:true,force:true}); }
  });
});

describe('saved proposals', () => {
  it('sets aside a saved proposal this build can’t read, and answers as if there were none', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mge-proposal-'));
    try {
      const store = createProjectStore(dir);
      await writeFileAtomic(join(dir, `${sampleProject.id}.proposal.json`), '{"proposal":{"not":"valid"},"savedAt":"2026-10-22T00:00:00Z"}');
      expect(await store.loadProposal(sampleProject.id)).toBeNull();
      const names = await readdir(dir);
      expect(names.some((n) => n.startsWith(`${sampleProject.id}.proposal.invalid-`))).toBe(true);
      expect(names).not.toContain(`${sampleProject.id}.proposal.json`);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
