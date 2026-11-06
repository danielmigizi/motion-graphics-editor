// Outcome evidence and route suggestions, without storage or routing side effects.
import { formatUsd, SUGGESTION_THRESHOLD } from './generationStudio';
import type { GenerationJobStatus, GenerationScoreboard, JobKind, ModelScore, RouteSuggestion } from './generationStudio';

/** Structural subset of the server's durable GenerationRecord. */
export interface ScoreRecord {
  id: string;
  job: JobKind;
  model: string;
  status: GenerationJobStatus;
  overridden: boolean;
  estimateUsd: number;
  actualUsd?: number;
  liabilityUsd?: number;
  billed?: boolean;
  queueMs?: number;
  runMs?: number;
  requests?: { requestId?: string }[];
  outputs: string[];
  checks: Record<string, { matches: boolean }>;
  outcomes: { used: string[]; kept: string[] };
  thumbs: Record<string, 1 | -1>;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  values.sort((a, b) => a - b);
  const middle = Math.floor(values.length / 2);
  return values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
}

/** Aggregate each job/model's runs; denied and pending permission are not runs.
 * Unbilled failures remain in reliability evidence but contribute no spend. */
export function scoreboard(records: readonly ScoreRecord[], opts: { overrides: Partial<Record<JobKind, string>>; dismissedSuggestions?: readonly string[]; labelFor: (model: string) => string; defaultFor: (job: JobKind) => string }): GenerationScoreboard {
  const groups = new Map<JobKind, Map<string, ScoreRecord[]>>();
  for (const record of records) {
    if (!['done', 'failed', 'cancelled'].includes(record.status) || !record.requests?.some((request) => request.requestId)) continue;
    let models = groups.get(record.job);
    if (!models) groups.set(record.job, models = new Map());
    const runs = models.get(record.model) ?? [];
    runs.push(record);
    models.set(record.model, runs);
  }
  const rows: ModelScore[] = [];
  for (const [job, models] of groups) for (const [model, records] of models) {
    let takes = 0, used = 0, kept = 0, cost = 0, checked = 0, matches = 0, thumbsUp = 0, thumbsDown = 0;
    const seconds: number[] = [];
    for (const record of records) {
      const outputs = new Set(record.outputs);
      takes += record.outputs.length;
      used += [...new Set(record.outcomes.used)].filter((id) => outputs.has(id)).length;
      kept += [...new Set(record.outcomes.kept)].filter((id) => outputs.has(id)).length;
      if (record.billed !== false) cost += record.liabilityUsd ?? record.actualUsd ?? record.estimateUsd;
      for (const check of Object.values(record.checks)) { checked++; if (check.matches) matches++; }
      for (const thumb of Object.values(record.thumbs)) { if (thumb === 1) thumbsUp++; else if (thumb === -1) thumbsDown++; }
      if (record.queueMs !== undefined || record.runMs !== undefined) seconds.push(((record.queueMs ?? 0) + (record.runMs ?? 0)) / 1000);
    }
    rows.push({ job, model, modelLabel: opts.labelFor(model), runs: records.length, takes,
      useRate: takes ? used / takes : 0, keepRate: takes ? kept / takes : 0,
      thumbsUp, thumbsDown, matchRate: checked ? matches / checked : null,
      costPerKept: kept ? cost / kept : null, p50Seconds: median(seconds),
      failureRate: records.filter((record) => record.status === 'failed').length / records.length,
      smallSample: records.length < SUGGESTION_THRESHOLD, overrides: records.filter((record) => record.overridden).length,
    });
  }
  const suggestions: RouteSuggestion[] = [];
  for (const job of groups.keys()) {
    const defaultModel = opts.overrides[job] ?? opts.defaultFor(job);
    const baseline = rows.find((row) => row.job === job && row.model === defaultModel);
    if (!baseline || baseline.smallSample) continue;
    const baselineCost = baseline.costPerKept ?? Infinity;
    const candidates = rows.flatMap((candidate): { row: ModelScore; kind: RouteSuggestion['kind'] }[] => {
      if (opts.dismissedSuggestions?.includes(`${job}:${candidate.model}`) || candidate.job !== job || candidate.model === defaultModel || candidate.model === opts.overrides[job] || candidate.smallSample || candidate.costPerKept === null) return [];
      if (candidate.keepRate > baseline.keepRate + 0.05 + Number.EPSILON && candidate.costPerKept <= baselineCost) return [{ row: candidate, kind: 'better' }];
      if (Math.abs(candidate.useRate - baseline.useRate) <= 0.05 + Number.EPSILON && Math.abs(candidate.keepRate - baseline.keepRate) <= 0.05 + Number.EPSILON && candidate.costPerKept < baselineCost) return [{ row: candidate, kind: 'cheaper' }];
      return [];
    });
    candidates.sort((a, b) => Number(b.kind === 'better') - Number(a.kind === 'better') || a.row.costPerKept! - b.row.costPerKept! || a.row.model.localeCompare(b.row.model));
    const best = candidates[0];
    if (best) suggestions.push({ job, from: defaultModel, to: best.row.model, kind: best.kind,
      reason: `${best.row.modelLabel} keeps ${Math.round(best.row.keepRate * 100)}% of takes (default ${Math.round(baseline.keepRate * 100)}%) at ${formatUsd(best.row.costPerKept!)} per kept take instead of ${baseline.costPerKept === null ? 'no kept takes for the default' : formatUsd(baseline.costPerKept)}.`,
    });
  }
  return { rows, suggestions, overrides: { ...opts.overrides }, threshold: SUGGESTION_THRESHOLD };
}
