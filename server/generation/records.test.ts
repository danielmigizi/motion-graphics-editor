// Outcome deduplication, daily billing and private, bounded persistence.

import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { localDay } from '../generation-log';
import { GenerationRecords, type GenerationRecord } from './records';

let dir: string;
let clock: number;
let records: GenerationRecords;
const row = (id = 'gjob_a', patch: Partial<GenerationRecord> = {}): GenerationRecord => ({
  id, at: clock, day: localDay(clock), projectId: 'prj_a', job: 'image.generate', model: 'model', endpoint: 'endpoint', routeVersion: 'test', policy: 'quality', overridden: false,
  settings: {}, takes: 1, origin: 'user', status: 'done', estimateUsd: 0.5, costSource: 'estimate', outputs: ['ast_a'], checks: {},
  outcomes: { auditioned: [], used: [], kept: [], replaced: [], deleted: [] }, thumbs: {}, regenerations: 0, ...patch,
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mge-records-'));
  clock = new Date(2026, 9, 21, 12).getTime();
  records = new GenerationRecords({ dir, now: () => clock });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('generation records', () => {
  it('uses private atomic persistence, detached reads and one record per job', async () => {
    const original = row();
    await records.add(original);
    original.outputs.push('mutated');
    await records.add(row());
    const got = (await records.get('gjob_a'))!;
    got.outputs.push('also-mutated');
    expect((await records.get('gjob_a'))!.outputs).toEqual(['ast_a']);
    expect((await stat(join(dir, 'generation-records.json'))).mode & 0o777).toBe(0o600);
    const saved = JSON.parse(await readFile(join(dir, 'generation-records.json'), 'utf8'));
    expect(saved).toHaveLength(1);
    expect(await new GenerationRecords({ dir }).get('gjob_a')).toMatchObject({ id: 'gjob_a' });
  });
  it('deduplicates every outcome, sets/replaces/clears thumbs, and handles unknown jobs', async () => {
    await records.add(row());
    for (const event of ['auditioned', 'used', 'kept', 'replaced', 'deleted'] as const) {
      await Promise.all([1, 2, 3].map(() => records.outcome({ jobId: 'gjob_a', assetId: 'ast_a', event })));
      expect((await records.get('gjob_a'))!.outcomes[event]).toEqual(['ast_a']);
    }
    for (const [event, expected] of [['thumbsUp', { ast_a: 1 }], ['thumbsDown', { ast_a: -1 }], ['thumbCleared', {}]] as const) {
      expect(await records.outcome({ jobId: 'gjob_a', assetId: 'ast_a', event })).toBe(true);
      expect(await records.thumbs(['gjob_a'])).toEqual(expected);
    }
    expect(await records.outcome({ jobId: 'missing', assetId: 'ast_a', event: 'used' })).toBe(false);
    expect(await records.update('missing', () => undefined)).toBeNull();
  });
  it('sums only terminal billable jobs on the local day, preferring actual cost', async () => {
    await records.add(row('done'));
    await records.add(row('actual', { actualUsd: 0.12, costSource: 'billing', status: 'failed' }));
    await records.add(row('cancelled', { status: 'cancelled' }));
    await records.add(row('free', { status: 'failed', billed: false }));
    for (const status of ['queued', 'running', 'importing', 'awaiting-permission', 'denied'] as const) await records.add(row(status, { status }));
    await records.add(row('yesterday', { day: localDay(clock - 86_400_000) }));
    expect(await records.spendToday()).toBeCloseTo(1.12);
    clock += 86_400_000;
    expect(await records.spendToday()).toBe(0);
  });
  it('serializes concurrent updates without losing outcomes', async () => {
    await records.add(row());
    await Promise.all(Array.from({ length: 20 }, (_, i) => records.update('gjob_a', (r) => { r.regenerations++; r.outputs.push(`ast_${i}`); })));
    expect(await records.get('gjob_a')).toMatchObject({ regenerations: 20 });
    expect((await records.get('gjob_a'))!.outputs).toHaveLength(21);
  });
  it('drops the oldest records at 5,000', async () => {
    await writeFile(join(dir, 'generation-records.json'), JSON.stringify(Array.from({ length: 5000 }, (_, i) => row(`gjob_${i}`))));
    await records.add(row('newest'));
    expect(await records.get('gjob_0')).toBeNull();
    expect(await records.get('gjob_1')).not.toBeNull();
    expect(await records.get('newest')).not.toBeNull();
    const all = await records.all();
    expect(all).toHaveLength(5000);
    expect(all[0].id).toBe('gjob_1');
    expect(all.at(-1)?.id).toBe('newest');
    all[0].outputs.push('mutated');
    expect((await records.all())[0].outputs).toEqual(['ast_a']);
    expect(JSON.parse(await readFile(join(dir, 'generation-records.json'), 'utf8'))).toHaveLength(5000);
  });
  it.each(['{broken', '{}', '[null, {}, 42]'])('tolerates corrupt or malformed storage: %s', async (text) => {
    await writeFile(join(dir, 'generation-records.json'), text);
    expect(await records.spendToday()).toBe(0);
    await records.add(row());
    expect(await records.get('gjob_a')).not.toBeNull();
  });
});

it('preserves resumable records while interrupting only orphaned jobs', async () => {
  await records.add(row('resumable', { status: 'running', requests: [{ requestId: 'fal_1', estimateUsd: 0.5, attempted: true }] }));
  await records.add(row('orphan', { status: 'running' }));
  await records.recover(new Set(['resumable']));
  expect(await records.get('resumable')).toMatchObject({ status: 'running', requests: [{ requestId: 'fal_1', estimateUsd: 0.5, attempted: true }] });
  expect((await records.get('resumable'))?.failure).toBeUndefined();
  expect(await records.get('orphan')).toMatchObject({ status: 'failed', failure: 'interrupted' });
});
