// Versioned, immutable upgrades. Shape validation follows migration.
import { PROJECT_SCHEMA_VERSION } from './types';
import type { CommandError } from './types';

type MigrationResult = { ok: true; project: unknown; from: number; to: number } | { ok: false; error: CommandError };
const object = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const migrations: Record<number, (raw: Record<string, unknown>) => Record<string, unknown>> = {
  1: (raw) => ({ ...raw, compositions: {}, markers: [], schemaVersion: 2 }),
  // v3 only adds optional fields (style, video assets/elements, asset provenance, audio targets, banned, story).
  // Openverse catalog imports reuse the same version: provenance.source 'openverse' and
  // provenance.license are optional and ignored by older readers.
  2: (raw) => ({ ...raw, schemaVersion: 3 }),
};

export function migrateProject(raw: unknown): MigrationResult {
  const version = object(raw) ? raw.schemaVersion : undefined;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return { ok: false, error: { code: 'INVALID', path: 'schemaVersion', message: `Unsupported project schema ${String(version)}; expected schema 1 or ${PROJECT_SCHEMA_VERSION}` } };
  }
  if (version > PROJECT_SCHEMA_VERSION) return { ok: false, error: { code: 'INVALID', path: 'schemaVersion', message: `This project was saved by a newer editor (schema ${version})` } };
  let project = raw as Record<string, unknown>;
  let current = version;
  while (current < PROJECT_SCHEMA_VERSION) {
    const upgrade = migrations[current];
    if (!upgrade) return { ok: false, error: { code: 'INVALID', path: 'schemaVersion', message: `Unsupported project schema ${current}` } };
    project = upgrade(project);
    current++;
  }
  return { ok: true, project, from: version, to: current };
}

/** Same result envelope; `project` contains the upgraded file, including all snapshots. */
export function migrateProjectFile(raw: unknown): MigrationResult {
  if (!object(raw)) return { ok: false, error: { code: 'INVALID', message: 'Project file must be an object', path: '' } };
  const main = migrateProject(raw.project);
  if (!main.ok) return { ok: false, error: { ...main.error, path: `project.${main.error.path}` } };
  const revisions: unknown[] = [];
  if (Array.isArray(raw.revisions)) {
    for (let i = 0; i < raw.revisions.length; i++) {
      const record = raw.revisions[i];
      const snapshot = migrateProject(object(record) ? record.snapshot : undefined);
      if (!snapshot.ok) return { ok: false, error: { ...snapshot.error, path: `revisions[${i}].snapshot.${snapshot.error.path}` } };
      revisions.push(snapshot.project === record.snapshot ? record : { ...record, snapshot: snapshot.project });
    }
  }
  const changed = main.project !== raw.project || (Array.isArray(raw.revisions) && revisions.some((r, i) => r !== (raw.revisions as unknown[])[i]));
  return { ok: true, project: changed ? { ...raw, project: main.project, ...(Array.isArray(raw.revisions) ? { revisions } : {}) } : raw, from: main.from, to: main.to };
}
