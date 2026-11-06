import { describe, expect, it } from 'vitest';
import { readingFrames } from '../../core/motionRules';
import { projectDurationInFrames } from '../../core/timing';
import type { Element } from '../../core/types';
import { validateProject } from '../../core/validate';
import { GOLDEN_EXAMPLES } from './index';

describe('golden examples', () => {
  it.each(GOLDEN_EXAMPLES.map((g) => [g.id, g] as const))('%s validates, uses its style pack and frames its sheet', (_id, golden) => {
    const r = validateProject(golden.project);
    expect(r.ok, r.ok ? '' : `${r.error.message} at ${r.error.path}`).toBe(true);
    expect(golden.project.style).toBeDefined();
    const total = projectDurationInFrames(golden.project);
    for (const f of golden.frames) expect(f).toBeLessThan(total);
    expect(golden.frames.length).toBeLessThanOrEqual(24);
    expect(golden.notes.length).toBeGreaterThanOrEqual(3);
  });

  it('are the lengths the brief asks for', () => {
    const seconds = Object.fromEntries(GOLDEN_EXAMPLES.map((g) => [g.id, projectDurationInFrames(g.project) / g.project.fps]));
    expect(seconds['saas-launch']).toBeGreaterThanOrEqual(20);
    expect(seconds['saas-launch']).toBeLessThanOrEqual(30);
    expect(seconds['kinetic-promo']).toBe(15);
    expect(seconds['product-walkthrough']).toBe(20);
    expect(seconds['pulse-reference']).toBeCloseTo((183 + 225) / 30);
  });

  it.each(GOLDEN_EXAMPLES.map((g) => [g.id, g] as const))('%s holds every text for its reading time after it lands', (_id, golden) => {
    const short: string[] = [];
    for (const scene of golden.project.scenes) {
      const byId = new Map(scene.elements.map((e) => [e.id, e]));
      const startOf = (e: Element): number => e.startFrame + (e.parentId ? startOf(byId.get(e.parentId)!) : 0);
      for (const el of scene.elements.filter((e) => e.type === 'text')) {
        const entrance = [...el.tracks, ...(el.propTracks ?? [])].flatMap((t) => t.keyframes.map((k) => k.frame)).filter((f) => f <= el.durationInFrames * 0.6);
        const reveal = el.props.reveal !== 'none' ? Number(el.props.revealDurationInFrames) : 0;
        const landed = startOf(el) + Math.max(0, reveal, ...entrance);
        const gone = Math.min(scene.durationInFrames, startOf(el) + el.durationInFrames);
        const need = readingFrames(String(el.props.text), golden.project.fps);
        if (gone - landed < need - 3) short.push(`${scene.name} › ${el.name}: ${gone - landed} f of ${need}`);
      }
    }
    expect(short).toEqual([]);
  });
});
