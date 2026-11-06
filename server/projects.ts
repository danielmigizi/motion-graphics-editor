// Project persistence: ProjectFile JSON in `projects/<id>.json`, written atomically.

import { validateProposal } from '../src/core/savedProposal';
import { mkdir, readdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { Checkpoint, CheckpointSummary, JournalEntry, JournalSummary, ProjectSummary, SavedProposal } from '../src/core/api-contract';
import { parseProjectFile } from '../src/core/validate';
import { projectHash } from './manifest';
import type { ProjectFile } from '../src/core/types';

const PROJECT_ID_RE = /^[A-Za-z0-9_-]+$/;

export function isValidProjectId(id: unknown): id is string {
  return typeof id === 'string' && id.length > 0 && id.length <= 128 && PROJECT_ID_RE.test(id);
}

/** Write via temp file + rename so a crash mid-write never leaves a truncated file. */
export async function writeFileAtomic(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, data, 'utf8');
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

export interface ProjectStore {
  list(): Promise<ProjectSummary[]>;
  /** null when the file does not exist. */
  load(id: string): Promise<ProjectFile | null>;
  save(id: string, file: ProjectFile, options?: { by: 'user' | 'agent' }): Promise<void>;
  checkpoints(id: string): Promise<CheckpointSummary[]>;
  checkpoint(id: string, cp: string): Promise<Checkpoint | null>;
  saveCheckpoint(id: string, name: string, note: string | undefined, file: ProjectFile): Promise<CheckpointSummary>;
  deleteCheckpoint(id: string, cp: string): Promise<boolean>;
  journal(id: string): Promise<JournalSummary[]>;
  journalEntry(id: string, entry: string): Promise<JournalEntry | null>;
  autosave(id: string, file: ProjectFile, options?: { by: 'user' | 'agent' }): Promise<void>;
  loadProposal(id: string): Promise<SavedProposal | null>;
  saveProposal(id: string, file: SavedProposal): Promise<void>;
  deleteProposal(id: string): Promise<void>;
}

export function createProjectStore(dir: string): ProjectStore {
  const pathFor = (id: string) => {
    if (!isValidProjectId(id)) throw new Error(`Invalid project id "${id}"`);
    return join(dir, `${id}.json`);
  };

  const archiveDir = (id: string, kind: 'checkpoints' | 'journal') => {
    pathFor(id);
    return join(dir, `${id}.${kind}`);
  };
  const readArchive = async <T>(id: string, kind: 'checkpoints' | 'journal', key: string): Promise<T | null> => {
    if (!isValidProjectId(key) || key.length > 80) throw new Error('Invalid entry id');
    try {
      const value = JSON.parse(await readFile(join(archiveDir(id, kind), `${key}.json`), 'utf8'));
      return (kind === 'journal' ? { id: key, revision: value.project.revision, createdAt: new Date(Number(key.split('-')[1])).toISOString(), file: value } : value) as T;
    }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null; throw err; }
  };
  const listArchive = async <T extends { id: string; createdAt: string; file: ProjectFile }>(id: string, kind: 'checkpoints' | 'journal'): Promise<T[]> => {
    let names: string[];
    try { names = await readdir(archiveDir(id, kind)); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []; throw err; }
    const entries = await Promise.all(names.filter((n) => /^[A-Za-z0-9_-]+\.json$/.test(n)).map((n) => readArchive<T>(id, kind, n.slice(0, -5)))) as (T | null)[];
    return entries.filter((entry): entry is T => entry !== null).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  };
  // All canonical saves and autosaves share this queue: load → archive → replace.
  const journalWrites = new Map<string, Promise<void>>();
  const serialized = (id: string, operation: () => Promise<void>) => {
    const write = (journalWrites.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
    journalWrites.set(id, write);
    void write.finally(() => { if (journalWrites.get(id) === write) journalWrites.delete(id); }).catch(() => undefined);
    return write;
  };
  const archive = async (id: string, file: ProjectFile, kind: 'user' | 'agent' | 'baseline') => {
    const folder = archiveDir(id, 'journal');
    await mkdir(folder, { recursive: true });
    const entries = await listArchive<JournalEntry>(id, 'journal');
    const timestamp = Math.max(Date.now(), entries[0] ? Date.parse(entries[0].createdAt) + 1 : 0);
    const entryId = `${file.project.revision}-${timestamp}${kind === 'agent' ? '-a' : kind === 'baseline' ? '-u' : ''}`;
    await writeFileAtomic(join(folder, `${entryId}.json`), JSON.stringify(file, null, 2));
    const all = [{ id: entryId }, ...entries];
    const pruned = [
      ...all.filter(entry => !/-[au]$/.test(entry.id)).slice(20),
      ...all.filter(entry => entry.id.endsWith('-a')).slice(20),
      ...all.filter(entry => entry.id.endsWith('-u')).slice(1),
    ];
    await Promise.all(pruned.map(old => unlink(join(folder, `${old.id}.json`))));
  };

  return {
    async checkpoints(id) {
      return (await listArchive<Checkpoint>(id, 'checkpoints')).map(({ file: _file, ...summary }) => summary);
    },
    checkpoint: (id, cp) => readArchive<Checkpoint>(id, 'checkpoints', cp),
    async saveCheckpoint(id, name, note, file) {
      const summary: CheckpointSummary = { id: `cp_${randomBytes(8).toString('hex')}`, name, ...(note ? { note } : {}), createdAt: new Date().toISOString(), revision: file.project.revision, projectHash: projectHash(file.project) };
      const folder = archiveDir(id, 'checkpoints');
      await mkdir(folder, { recursive: true });
      await writeFileAtomic(join(folder, `${summary.id}.json`), JSON.stringify({ ...summary, file }, null, 2));
      return summary;
    },
    async deleteCheckpoint(id, cp) {
      if (!isValidProjectId(cp) || cp.length > 80) throw new Error('Invalid checkpoint id');
      try { await unlink(join(archiveDir(id, 'checkpoints'), `${cp}.json`)); return true; }
      catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false; throw err; }
    },
    async journal(id) {
      return (await listArchive<JournalEntry>(id, 'journal')).map(({ file: _file, ...summary }) => summary);
    },
    journalEntry: (id, entry) => readArchive<JournalEntry>(id, 'journal', entry),
    autosave(id, file, { by } = { by: 'user' }) {
      return serialized(id, () => archive(id, file, by));
    },
    async list() {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      const out: ProjectSummary[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        const id = name.slice(0, -5);
        if (!isValidProjectId(id)) continue;
        try {
          const parsed = parseProjectFile(JSON.parse(await readFile(join(dir, name), 'utf8')));
          if (!parsed.ok) continue;
          const file = parsed.value;
          out.push({ id, name: file.project?.name ?? id, revision: file.project?.revision ?? 0, savedAt: file.savedAt ?? '' });
        } catch {
          // Unreadable file: skip it rather than failing the whole listing.
        }
      }
      return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
    },

    async load(id) {
      try {
        const parsed = parseProjectFile(JSON.parse(await readFile(pathFor(id), 'utf8')));
        if (!parsed.ok) throw new Error(`${parsed.error.path}: ${parsed.error.message}`);
        return parsed.value;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
    },

    async loadProposal(id) {
      const path = pathFor(id).replace(/\.json$/, '.proposal.json');
      let text: string;
      try { text = await readFile(path, 'utf8'); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw err;
      }
      let file: SavedProposal | null = null;
      try { file = JSON.parse(text) as SavedProposal; } catch { /* unreadable, below */ }
      const valid = file ? validateProposal(file.proposal, id) : null;
      if (!file || !valid?.ok || typeof file.savedAt !== 'string' || !Number.isFinite(Date.parse(file.savedAt))) {
        // A saved proposal this build can't read (older format, hand-edited) is set aside, not served
        // as an error forever: the editor then sees no saved proposal.
        await rename(path, path.replace(/\.proposal\.json$/, `.proposal.invalid-${Date.now()}.json`)).catch(() => undefined);
        return null;
      }
      return { proposal: valid.proposal, savedAt: file.savedAt };
    },

    async saveProposal(id, file) {
      await mkdir(dir, { recursive: true });
      await writeFileAtomic(pathFor(id).replace(/\.json$/, '.proposal.json'), JSON.stringify(file, null, 2));
    },

    async deleteProposal(id) {
      try { await unlink(pathFor(id).replace(/\.json$/, '.proposal.json')); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
    },

    save(id, file, { by } = { by: 'user' }) {
      return serialized(id, async () => {
        const path = pathFor(id);
        await mkdir(dir, { recursive: true });
        let existing: ProjectFile | null = null;
        try { existing = JSON.parse(await readFile(path, 'utf8')) as ProjectFile; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (existing) {
          // Legacy saved files belong to the user until known otherwise.
          const writer = await readFile(`${path}.writer`, 'utf8').catch(error => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            return 'user';
          });
          // Filed by who wrote the archived version: an agent's content never lands in the person's ring
          // (recovery offers only the person's entries).
          await archive(id, existing, writer === 'agent' ? 'agent' : by === 'agent' ? 'baseline' : 'user');
        }
        // Never let an agent's content be labelled the person's, even if a write fails between the two:
        // an agent's save marks the writer first, the person's after their content is in place.
        if (by === 'agent') await writeFileAtomic(`${path}.writer`, by);
        await writeFileAtomic(path, JSON.stringify(file, null, 2));
        if (by === 'user') await writeFileAtomic(`${path}.writer`, by);
      });
    },
  };
}
