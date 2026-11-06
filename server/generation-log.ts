// Today's generation activity and approved-generation count, provider-neutral,
// in .mge/generation-log.json (gitignored). A new local day starts from zero.
// Entries stream to the editor as `generation` events (server/app.ts) and are
// served by GET /api/generations/log.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { GenerationEntry } from '../src/core/generation';
import { newId } from '../src/core/ids';

const LOG_SIZE = 50;

interface Usage {
  day: string;
  generations: number;
  entries: GenerationEntry[];
}

/** Local calendar day, "2026-10-13". */
export function localDay(at = Date.now()): string {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

async function writeJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`);
  await rename(tmp, path);
}

export interface GenerationLogOptions {
  /** Directory for generation-log.json (the repo's .mge/). */
  dir: string;
  now?: () => number;
}

export class GenerationLog {
  private usageCache: Usage | null = null;
  private listeners = new Set<(e: GenerationEntry) => void>();
  readonly path: string;
  private readonly now: () => number;

  constructor(opts: GenerationLogOptions) {
    this.path = join(opts.dir, 'generation-log.json');
    this.now = opts.now ?? Date.now;
  }

  private async usage(): Promise<Usage> {
    const today = localDay(this.now());
    if (!this.usageCache) {
      const raw = (await readJson(this.path)) as Partial<Usage> | null;
      this.usageCache = raw && typeof raw.day === 'string' && typeof raw.generations === 'number' && Array.isArray(raw.entries)
        ? { day: raw.day, generations: raw.generations, entries: raw.entries as GenerationEntry[] }
        : { day: today, generations: 0, entries: [] };
    }
    // A new day starts from zero.
    if (this.usageCache.day !== today) this.usageCache = { day: today, generations: 0, entries: [] };
    return this.usageCache;
  }

  /** Approved generations today (local day). */
  async usedToday(): Promise<number> {
    return (await this.usage()).generations;
  }

  /** Today's generation activity, newest first. */
  async log(): Promise<GenerationEntry[]> {
    return [...(await this.usage()).entries];
  }

  /** `generation` entries as they happen (the server broadcasts them to the editor). */
  onEntry(fn: (e: GenerationEntry) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Add one entry; `addGenerations` counts approved generations toward today's total. */
  async record(entry: Omit<GenerationEntry, 'id' | 'at'>, addGenerations = 0): Promise<GenerationEntry> {
    const usage = await this.usage();
    usage.generations += addGenerations;
    const e: GenerationEntry = { id: newId('req').replace('req_', 'gen_'), at: this.now(), ...entry };
    usage.entries = [e, ...usage.entries].slice(0, LOG_SIZE);
    await writeJson(this.path, usage);
    for (const fn of this.listeners) fn(e);
    return e;
  }

  /** A generated asset was imported into the editor. */
  imported(agent: string, name: string, provider: string): Promise<GenerationEntry> {
    return this.record({ kind: 'imported', agent, provider, title: `Imported “${name}” from ${provider}` });
  }
}
