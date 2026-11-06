import { describe, expect, it } from 'vitest';
import v1 from './__fixtures__/v1-project.json';
import v2 from './__fixtures__/v2-project.json';
import { evaluateElement } from './animation';
import { loadDoc, serializeDoc } from './history';
import { migrateProject, migrateProjectFile } from './migrate';
import { parseProjectFile, validateProject } from './validate';
import { loadDoc as editorLoadDoc } from '../editor/doc';
import type { Element } from './types';

const file = () => ({ format: 'mge.project/1', project: structuredClone(v1), revisions: [{ revision: v1.revision, snapshot: structuredClone(v1), source: 'load', label: 'Opened', touched: [], at: 0 }], savedAt: '2026-01-01T00:00:00Z' });

describe('project migrations', () => {
  it('upgrades only the version, compositions and markers without mutating input', () => {
    const before = structuredClone(v1);
    const r = migrateProject(v1);
    expect(r).toEqual({ ok: true, from: 1, to: 3, project: { ...v1, schemaVersion: 3, compositions: {}, markers: [] } });
    expect(v1).toEqual(before);
    const current = validateProject(v1);
    if (!current.ok) throw new Error(current.error.message);
    expect(migrateProject(current.value)).toMatchObject({ ok: true, from: 3, to: 3, project: current.value });
    const again = migrateProject(current.value);
    if (again.ok) expect(again.project).toBe(current.value);
  });
  it('upgrades v2 by bumping only the version, without mutating input', () => {
    const before = structuredClone(v2);
    expect(migrateProject(v2)).toEqual({ ok: true, from: 2, to: 3, project: { ...v2, schemaVersion: 3 } });
    expect(v2).toEqual(before);
    const migrated = validateProject(v2);
    if (!migrated.ok) throw new Error(migrated.error.message);
    expect(migrated.value).toEqual({ ...v2, schemaVersion: 3 });
    expect(migrated.value.style).toBeUndefined();
    const raw = { format: 'mge.project/1', project: structuredClone(v2), revisions: [{ revision: v2.revision, snapshot: structuredClone(v2), source: 'load', label: 'Opened', touched: [], at: 0 }], savedAt: '2026-01-01T00:00:00Z' };
    const loaded = loadDoc(raw);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const saved = serializeDoc(loaded.state);
    expect(saved.project.schemaVersion).toBe(3);
    expect(saved.revisions.every(r => r.snapshot.schemaVersion === 3)).toBe(true);
    expect(saved.project.scenes).toEqual(v2.scenes);
  });
  it.each([undefined, null, {}, { schemaVersion: 0 }, { schemaVersion: '1' }, { schemaVersion: 1.5 }, { schemaVersion: 4 }])('rejects unsupported version: %j', raw => {
    const r = migrateProject(raw);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'schemaVersion' } });
    if (!r.ok && raw && typeof raw === 'object' && 'schemaVersion' in raw && raw.schemaVersion === 4) expect(r.error.message).toBe('This project was saved by a newer editor (schema 4)');
  });
  it('migrates every snapshot and round-trips through load/save as v3', () => {
    const raw = file(), before = structuredClone(raw);
    const result = migrateProjectFile(raw);
    expect(result.ok).toBe(true);
    const loaded = loadDoc(raw);
    if (!loaded.ok) throw new Error(loaded.error.message);
    const saved = serializeDoc(loaded.state);
    expect(saved.project.schemaVersion).toBe(3);
    expect(saved.revisions.every(r => r.snapshot.schemaVersion === 3)).toBe(true);
    expect(saved.project.scenes).toEqual(v1.scenes);
    expect(saved.project.assets).toEqual(v1.assets);
    expect(saved.project.audio).toEqual(v1.audio);
    expect(parseProjectFile(JSON.parse(JSON.stringify(saved))).ok).toBe(true);
    expect(editorLoadDoc(raw).ok).toBe(true);
    expect(editorLoadDoc(v1).ok).toBe(true);
    expect(raw).toEqual(before);
  });
  it('keeps every evaluated v1 element identical at sampled frames', () => {
    const migrated = validateProject(v1);
    if (!migrated.ok) throw new Error(migrated.error.message);
    v1.scenes.forEach((scene, si) => scene.elements.forEach((el, ei) => {
      for (const frame of [-1, 0, 5, 15, 30, 90, 150, scene.durationInFrames - 1, scene.durationInFrames]) {
        expect(evaluateElement(migrated.value.scenes[si].elements[ei], frame)).toEqual(evaluateElement(el as Element, frame));
      }
    }));
  });
  it('reports a newer snapshot version with its full path', () => {
    const raw = file(); raw.revisions[0].snapshot.schemaVersion = 9;
    expect(parseProjectFile(raw)).toMatchObject({ ok: false, error: { path: 'revisions[0].snapshot.schemaVersion', message: 'This project was saved by a newer editor (schema 9)' } });
  });
  it('validates migrated historical snapshot semantics', () => {
    const raw = file(); raw.project.revision = 2; raw.revisions[0].snapshot.fps = 0;
    expect(parseProjectFile(raw)).toMatchObject({ ok: false, error: { path: 'revisions[0].snapshot.fps' } });
  });
});
