import { describe, expect, it } from 'vitest';
import { clicheProject } from './critique.test';
import { compareToCraft, formatBar, computeMotionStats } from './motionStats';
import { GOLDEN_EXAMPLES } from '../sample/golden';
import { pulseReference, pulseReferenceBefore } from '../sample/golden/pulseReference';
import { PULSE_CRAFT } from './styleCraft';
import { STYLE_PACKS } from './style';
import { validateProject } from './validate';

describe('motion stats vs Pulse craft', () => {
  it('measures pops, stagger, drift and type share on the house reference', () => {
    const project = pulseReference();
    expect(validateProject(project).ok).toBe(true);
    const stats = computeMotionStats(project, { beats: [0, 30, 60, 90, 120, 150, 180, 210], downbeats: [0, 180], confidence: 0.9 });
    const pop = [...stats.popDurations].sort((a, b) => a - b);
    expect(pop[0]).toBeGreaterThanOrEqual(2);
    expect(pop[Math.floor(pop.length / 2)]).toBeLessThanOrEqual(5);
    expect(stats.staggers.some((g) => g >= 1 && g <= 4)).toBe(true);
    expect(stats.hasDrift).toBe(true);
    expect(stats.deadRuns.every((r) => r.frames <= PULSE_CRAFT.trueHoldMaxFrames)).toBe(true);
    const type = stats.typeShares.reduce((a, b) => a + b, 0) / stats.typeShares.length;
    expect(type).toBeGreaterThan(0.02);
    expect(type).toBeLessThan(0.08);
    expect(stats.beatOffsets).toContain(3);
    const notes = compareToCraft(stats, PULSE_CRAFT, project);
    expect(notes.filter((n) => n.rule === 'baseline:pop' || n.rule === 'baseline:drift')).toEqual([]);
    expect(formatBar(stats, PULSE_CRAFT, 'pulse')).toMatch(/Bar vs pulse/);
  });

  it('flags the naive before draft as off the bar', () => {
    const project = pulseReferenceBefore();
    expect(validateProject(project).ok).toBe(true);
    const stats = computeMotionStats(project);
    const notes = compareToCraft(stats, PULSE_CRAFT, { ...project, style: STYLE_PACKS.pulse });
    const rules = notes.map((n) => n.rule);
    expect(rules).toEqual(expect.arrayContaining(['baseline:pop', 'baseline:drift']));
  });

  it('flags an AI-default sample against Pulse tokens', () => {
    const project = clicheProject();
    project.style = STYLE_PACKS.pulse;
    const notes = compareToCraft(computeMotionStats(project), PULSE_CRAFT, project);
    expect(notes.map((n) => n.rule)).toEqual(expect.arrayContaining(['baseline:pop', 'baseline:drift']));
  });

  it('does not add error-level baseline notes on shipped goldens', () => {
    for (const g of GOLDEN_EXAMPLES) {
      const stats = computeMotionStats(g.project);
      expect(stats.popDurations.length + stats.typeShares.length).toBeGreaterThan(0);
    }
  });
});
