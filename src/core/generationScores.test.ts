import { describe, expect, it } from 'vitest';
import { scoreboard, type ScoreRecord } from './generationScores';
import { SUGGESTION_THRESHOLD } from './generationStudio';

const opts = { overrides: {}, labelFor: (model: string) => model === 'candidate' ? 'Seedream 5.0 Pro' : model, defaultFor: () => 'default' };
function run(id: string, extra: Partial<ScoreRecord> = {}): ScoreRecord {
  return { id, job: 'image.generate', model: 'default', status: 'done', overridden: false,
    estimateUsd: 0.5, requests: [{ requestId: `fal_${id}` }], outputs: [id], checks: {}, outcomes: { used: [id], kept: [id] }, thumbs: {}, ...extra };
}
function seed(model: string, runs: number, kept: number, cost = 0.5, used = kept): ScoreRecord[] {
  return Array.from({ length: runs }, (_, i) => {
    const id = `${model}-${i}`;
    return run(id, { model, estimateUsd: cost, outcomes: { used: i < used ? [id] : [], kept: i < kept ? [id] : [] } });
  });
}

describe('generation scoreboard evidence', () => {
  it('flags small samples and suggests nothing below threshold', () => {
    const result = scoreboard([...seed('default', 19, 12), ...seed('candidate', 19, 12, 0.05)], opts);
    expect(result.rows.every((row) => row.smallSample)).toBe(true);
    expect(result.suggestions).toEqual([]);
    expect(result.threshold).toBe(SUGGESTION_THRESHOLD);
  });
  it.each([[19, 20], [20, 19]])('requires both default and candidate to have 20 runs (%s, %s)', (defaultRuns, candidateRuns) => {
    expect(scoreboard([...seed('default', defaultRuns, 12), ...seed('candidate', candidateRuns, 12, 0.05)], opts).suggestions).toEqual([]);
  });
  it('suggests a cheaper model within five points of both use and keep rates', () => {
    const result = scoreboard([...seed('default', 20, 13, 0.5, 15), ...seed('candidate', 20, 12, 0.0675, 14)], opts);
    expect(result.suggestions).toEqual([{ job: 'image.generate', from: 'default', to: 'candidate', kind: 'cheaper',
      reason: 'Seedream 5.0 Pro keeps 60% of takes (default 65%) at $0.11 per kept take instead of $0.77.' }]);
  });
  it('requires a cheaper candidate to keep both rates within five points', () => {
    for (const [used, kept] of [[12, 12], [15, 11], [19, 13]]) {
      expect(scoreboard([...seed('default', 20, 13, 0.5, 15), ...seed('candidate', 20, kept, 0.01, used)], opts).suggestions).toEqual([]);
    }
  });
  it('prefers better over cheaper, then the lowest cost per kept take', () => {
    const records = [...seed('default', 20, 10), ...seed('cheaper', 20, 10, 0.01), ...seed('candidate', 20, 14, 0.2), ...seed('best', 20, 14, 0.1)];
    expect(scoreboard(records, opts).suggestions).toMatchObject([{ to: 'best', kind: 'better' }]);
    expect(scoreboard([...seed('default', 20, 10), ...seed('candidate', 20, 14, 1)], opts).suggestions).toEqual([]);
  });
  it('allows equal cost for better and does not call exactly five points better', () => {
    expect(scoreboard([...seed('default', 20, 10, 0.5), ...seed('candidate', 20, 12, 0.6)], opts).suggestions).toMatchObject([{ kind: 'better' }]);
    expect(scoreboard([...seed('default', 20, 10), ...seed('candidate', 20, 11, 0.01)], opts).suggestions).toMatchObject([{ kind: 'cheaper' }]);
  });
  it('compares against accepted defaults and never suggests that same model', () => {
    const result = scoreboard([...seed('default', 20, 12), ...seed('candidate', 20, 12, 0.05)], { ...opts, overrides: { 'image.generate': 'candidate' } });
    expect(result.overrides).toEqual({ 'image.generate': 'candidate' });
    expect(result.suggestions).toEqual([]);
  });
  it('excludes denied and pending permission; unbilled failures count but cost nothing', () => {
    const result = scoreboard([
      run('denied', { status: 'denied', estimateUsd: 500 }), run('pending', { status: 'awaiting-permission', estimateUsd: 500 }),
      run('failed', { status: 'failed', billed: false, estimateUsd: 500, outputs: [], outcomes: { used: [], kept: [] } }),
      run('cancelled', { status: 'cancelled', billed: false, estimateUsd: 500, outputs: [], outcomes: { used: [], kept: [] } }),
      run('done', { liabilityUsd: 0.2, actualUsd: 0.1, overridden: true }), run('actual', { actualUsd: 0.3 }), run('estimate'),
    ], opts);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ runs: 5, takes: 3, useRate: 1, keepRate: 1, costPerKept: 1 / 3, failureRate: 1 / 5, overrides: 1 });
  });
  it('deduplicates outcome intersections, counts checks and thumbs, and groups per job/model without mutation', () => {
    const records = [run('a', { outputs: ['a', 'b'], outcomes: { used: ['a', 'a', 'foreign'], kept: ['b', 'b', 'foreign'] }, checks: { a: { matches: true }, b: { matches: false } }, thumbs: { a: 1, b: -1 } }), run('voice', { job: 'voice.line' }), run('other', { model: 'candidate' })];
    const original = structuredClone(records);
    const result = scoreboard(records, opts);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0]).toMatchObject({ runs: 1, takes: 2, useRate: 0.5, keepRate: 0.5, matchRate: 0.5, thumbsUp: 1, thumbsDown: 1 });
    expect(records).toEqual(original);
  });
  it('computes odd and even medians from queue plus run time, ignoring unknown timings', () => {
    const records = [run('a', { queueMs: 1000, runMs: 2000 }), run('b', { runMs: 1000 }), run('unknown')];
    expect(scoreboard(records, opts).rows[0].p50Seconds).toBe(2);
    expect(scoreboard([...records, run('c', { queueMs: 7000 })], opts).rows[0].p50Seconds).toBe(3);
    expect(scoreboard([run('unknown')], opts).rows[0].p50Seconds).toBeNull();
    expect(scoreboard([run('zero', { runMs: 0 })], opts).rows[0].p50Seconds).toBe(0);
  });
  it('returns null cost per kept take and match rate when nothing was kept or checked', () => {
    expect(scoreboard(seed('default', 20, 0), opts).rows[0]).toMatchObject({ costPerKept: null, matchRate: null, keepRate: 0 });
    expect(scoreboard([...seed('default', 20, 0), ...seed('candidate', 20, 20, 0.01)], opts).suggestions).toMatchObject([{ kind: 'better' }]);
    expect(scoreboard([run('failed', { status: 'failed', outputs: [], outcomes: { used: [], kept: [] } })], opts).rows[0]).toMatchObject({ takes: 0, useRate: 0, keepRate: 0, costPerKept: null, failureRate: 1 });
  });
});


it('counts only finished runs with provider submission evidence', () => {
  const records = ['queued', 'running', 'importing', 'cancelled', 'failed', 'done'].map((status, i) => run(String(i), { status: status as ScoreRecord['status'], requests: [] }));
  records.push(run('active', { status: 'running' }), run('provider-failed', { status: 'failed', billed: false }));
  expect(scoreboard(records, opts).rows).toMatchObject([{ runs: 1, failureRate: 1, smallSample: true }]);
});
it('filters dismissed targets while allowing another candidate', () => {
  const records = [...seed('default', 20, 12), ...seed('candidate', 20, 12, 0.01), ...seed('other', 20, 12, 0.02)];
  expect(scoreboard(records, { ...opts, dismissedSuggestions: ['image.generate:candidate'] }).suggestions).toMatchObject([{ to: 'other' }]);
});
