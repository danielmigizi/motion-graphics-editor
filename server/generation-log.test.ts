// The generation log: today's activity and approved-generation count, per local day.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GenerationEntry } from '../src/core/generation';
import { GenerationLog, localDay } from './generation-log';

let dir: string;
let now: number;
let log: GenerationLog;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mge-gen-'));
  now = new Date(2026, 9, 13, 12, 0, 0).getTime();
  log = new GenerationLog({ dir, now: () => now });
});
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('generation log', () => {
  it('records entries newest first, counts approvals, and streams them', async () => {
    const seen: GenerationEntry[] = [];
    log.onEntry((e) => seen.push(e));
    await log.record({ kind: 'requested', agent: 'Claude Code', provider: 'fal', title: 'Generate an image', usedToday: 0, dailyLimit: 5 });
    await log.record({ kind: 'approved', agent: 'Claude Code', provider: 'fal', title: 'Generate an image', usedToday: 1, dailyLimit: 5 }, 1);
    expect((await log.log()).map((e) => e.kind)).toEqual(['approved', 'requested']);
    expect(seen.map((e) => e.kind)).toEqual(['requested', 'approved']);
    expect(await log.usedToday()).toBe(1);
  });

  it('persists today across a restart, and a new day starts at zero', async () => {
    await log.record({ kind: 'approved', agent: 'Claude Code', title: 'Generate an image' }, 2);
    expect(await new GenerationLog({ dir, now: () => now }).usedToday()).toBe(2);
    now += 24 * 3600 * 1000;
    expect(await log.usedToday()).toBe(0);
    expect(await log.log()).toEqual([]);
    expect(localDay(now)).toBe('2026-10-14');
  });

  it('logs imported generated assets with their provider', async () => {
    await log.imported('Claude Code', 'hero.png', 'fal');
    expect((await log.log())[0]).toMatchObject({ kind: 'imported', agent: 'Claude Code', provider: 'fal', title: 'Imported “hero.png” from fal' });
  });
});
