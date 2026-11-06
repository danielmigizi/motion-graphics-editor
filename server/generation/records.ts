// Per-user generation outcomes and spend, persisted atomically outside projects.

import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GenerationFailure, GenerationJobStatus, JobKind, JobSettings, OutcomeReport, RoutePolicy } from '../../src/core/generationStudio';
import { localDay } from '../generation-log';
import type { ScoreRecord } from '../../src/core/generationScores';

/** Durable per-request liability; unknown costs retain their estimate. */
export interface RequestCost {
  requestId?: string;
  estimateUsd: number;
  attempted?: boolean;
  costUsd?: number;
}

/** One job's costs, output checks and deduplicated take outcomes. */
export interface GenerationRecord extends ScoreRecord {
  id: string;
  at: number; day: string;
  projectId: string; job: JobKind; model: string; endpoint: string; routeVersion: string; policy: RoutePolicy; overridden: boolean;
  settings: JobSettings; takes: number; origin: 'user' | 'agent'; agent?: string; regenerateOf?: string;
  status: GenerationJobStatus;
  delivered?: boolean;
  estimateUsd: number; reserve?: boolean; actualUsd?: number; costSource: 'estimate' | 'billing'; billed?: boolean;
  requests?: RequestCost[];
  liabilityUsd?: number;
  queueMs?: number; runMs?: number;
  failure?: GenerationFailure;
  outputs: string[];
  /** Aspect within 2%, audio duration within 10%, and real PNG alpha for cutouts. */
  checks: Record<string, { matches: boolean; notes: string[] }>;
  outcomes: { auditioned: string[]; used: string[]; kept: string[]; replaced: string[]; deleted: string[] };
  thumbs: Record<string, 1 | -1>;
  regenerations: number;
}

/** A serialized, private outcome log, capped at the latest 5,000 jobs. */
export class GenerationRecords {
  private readonly path: string;
  private readonly now: () => number;
  readonly dir: string;
  private pending: Promise<unknown> = Promise.resolve();
  private rows: Promise<GenerationRecord[]> | undefined;
  private revision = 0;

  /** Changes only after a successful durable ledger write. */
  get version(): number { return this.revision; }

  /** All projects, retaining the same 5,000-job cap as the durable log. */
  async all(): Promise<GenerationRecord[]> {
    await this.pending;
    return structuredClone(await this.read());
  }

  constructor(opts: { dir: string; now?: () => number }) {
    this.dir = opts.dir;
    this.path = join(opts.dir, 'generation-records.json');
    this.now = opts.now ?? Date.now;
  }

  private read(): Promise<GenerationRecord[]> {
    return this.rows ??= readFile(this.path, 'utf8').then((text) => {
      const rows: unknown = JSON.parse(text);
      return Array.isArray(rows) ? rows.filter((r): r is GenerationRecord => !!r && typeof r === 'object'
        && typeof r.id === 'string' && Number.isFinite(r.at) && typeof r.day === 'string'
        && Number.isFinite(r.estimateUsd) && Array.isArray(r.outputs) && !!r.outcomes && !!r.thumbs && !!r.checks).slice(-5000) : [];
    }).catch(() => []);
  }

  private change<T>(fn: (rows: GenerationRecord[]) => T): Promise<T> {
    const result = this.pending.then(async () => {
      // Mutate a copy so a failed write cannot change the in-memory ledger.
      const rows = structuredClone(await this.read());
      const value = fn(rows);
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(tmp, `${JSON.stringify(rows.slice(-5000), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        await rename(tmp, this.path);
      } finally {
        await rm(tmp, { force: true });
      }
      this.rows = Promise.resolve(rows.slice(-5000));
      this.revision++;
      return structuredClone(value);
    });
    this.pending = result.catch(() => undefined);
    return result;
  }

  /** Insert a job once. */
  add(r: GenerationRecord): Promise<void> {
    return this.change((rows) => { if (!rows.some((row) => row.id === r.id)) rows.push(structuredClone(r)); });
  }

  /** Atomically update one job; unknown jobs return null. */
  update(id: string, fn: (r: GenerationRecord) => void): Promise<GenerationRecord | null> {
    return this.change((rows) => {
      const row = rows.find((r) => r.id === id);
      if (!row) return null;
      fn(row);
      return row;
    });
  }

  /** Read a detached record after pending writes. */
  async get(id: string): Promise<GenerationRecord | null> {
    await this.pending;
    return structuredClone((await this.read()).find((r) => r.id === id) ?? null);
  }

  /** Recover abandoned jobs before admission, retaining uncertain liabilities. */
  recover(preservedIds: ReadonlySet<string> = new Set()): Promise<GenerationRecord[]> {
    return this.change((rows) => {
      for (const r of rows) {
        if (preservedIds.has(r.id)) continue;
        if (r.status === 'awaiting-permission') { r.status = 'denied'; r.billed = false; }
        else if (['queued', 'running', 'importing'].includes(r.status)) {
          r.status = 'failed'; r.failure = 'interrupted'; r.billed = undefined;
          r.actualUsd = undefined; r.liabilityUsd = r.estimateUsd; r.costSource = 'estimate';
          for (const request of r.requests ?? []) { request.attempted = true; request.costUsd = undefined; }
        }
      }
      return rows;
    });
  }

  /** Today's actual costs, falling back to estimates for jobs that ran. */
  async spendToday(): Promise<number> {
    await this.pending;
    return (await this.read()).reduce((total, r) => total + (r.day === localDay(this.now())
      && ['done', 'failed', 'cancelled'].includes(r.status) && r.billed !== false ? r.liabilityUsd ?? r.actualUsd ?? r.estimateUsd : 0), 0);
  }

  /** Count each asset/event once, or set/clear the asset's thumb. */
  async outcome(report: OutcomeReport): Promise<boolean> {
    return await this.update(report.jobId, (r) => {
      if (report.event === 'thumbCleared') delete r.thumbs[report.assetId];
      else if (report.event === 'thumbsUp' || report.event === 'thumbsDown') {
        Object.defineProperty(r.thumbs, report.assetId, { value: report.event === 'thumbsUp' ? 1 : -1, enumerable: true, configurable: true, writable: true });
      } else if (!r.outcomes[report.event].includes(report.assetId)) r.outcomes[report.event].push(report.assetId);
    }) !== null;
  }

  /** Current asset thumbs for the requested jobs. */
  async thumbs(jobIds: string[]): Promise<Record<string, 1 | -1>> {
    await this.pending;
    const wanted = new Set(jobIds);
    return Object.fromEntries((await this.read()).filter((r) => wanted.has(r.id)).flatMap((r) => Object.entries(r.thumbs)));
  }
}
