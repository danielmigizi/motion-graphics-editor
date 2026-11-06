import { describe, expect, it } from 'vitest';
import { fixtureProject as sampleProject } from './__fixtures__/fixtureProject';
import { EASINGS, evaluateElement } from './animation';
import { applyCommand } from './commands';
import { audioClipStartFrame, formatTimecode, locateFrame, projectDurationInFrames, sceneStartFrames } from './timing';
import type { Element } from './types';

const findEl = (id: string): Element => sampleProject.scenes.flatMap((s) => s.elements).find((e) => e.id === id)!;

describe('timing', () => {
  it('computes scene start frames and total duration', () => {
    expect(sceneStartFrames(sampleProject)).toEqual([0, 210, 480]);
    expect(projectDurationInFrames(sampleProject)).toBe(720);
  });

  it('locates frames at scene boundaries and clamps out of range', () => {
    expect(locateFrame(sampleProject, 0)).toMatchObject({ sceneIndex: 0, frameInScene: 0 });
    expect(locateFrame(sampleProject, 209)).toMatchObject({ sceneIndex: 0, frameInScene: 209 });
    expect(locateFrame(sampleProject, 210)).toMatchObject({ sceneIndex: 1, sceneStart: 210, frameInScene: 0 });
    expect(locateFrame(sampleProject, 9999)).toMatchObject({ sceneIndex: 2, frameInScene: 239 });
    expect(locateFrame(sampleProject, -5)).toMatchObject({ sceneIndex: 0, frameInScene: 0 });
  });

  it('scene-anchored audio follows its scene after moveScene; absolute audio does not', () => {
    const whoosh = sampleProject.audio.find((c) => c.id === 'aud_whoosh')!;
    const music = sampleProject.audio.find((c) => c.id === 'aud_music')!;
    expect(audioClipStartFrame(sampleProject, whoosh)).toBe(210);
    const r = applyCommand(sampleProject, { type: 'moveScene', sceneId: 'scn_product', toIndex: 0 }, { source: 'user' });
    if (!r.ok) throw new Error(r.error.message);
    expect(audioClipStartFrame(r.project, whoosh)).toBe(0);
    expect(audioClipStartFrame(r.project, music)).toBe(0);
    const r2 = applyCommand(sampleProject, { type: 'moveScene', sceneId: 'scn_product', toIndex: 2 }, { source: 'user' });
    if (!r2.ok) throw new Error(r2.error.message);
    expect(audioClipStartFrame(r2.project, whoosh)).toBe(450);
  });

  it('formats timecode', () => {
    expect(formatTimecode(0, 30)).toBe('0:00:00');
    expect(formatTimecode(95, 30)).toBe('0:03:05');
    expect(formatTimecode(1830, 30)).toBe('1:01:00');
  });
});

describe('animation', () => {
  it('easings hit exact ends', () => {
    for (const fn of Object.values(EASINGS)) {
      expect(fn(0)).toBe(0);
      expect(fn(1)).toBe(1);
    }
    expect(EASINGS.easeInOut(0.5)).toBeCloseTo(0.5, 5);
  });

  it('applies additive offsets and multiplicative factors', () => {
    const logo = findEl('el_intro_logo'); // y: slideUp(40, 24); opacity: fadeIn(20)
    const at0 = evaluateElement(logo, 0);
    expect(at0.y).toBe(300 + 40);
    expect(at0.opacity).toBe(0);
    const end = evaluateElement(logo, 30);
    expect(end.y).toBe(300);
    expect(end.opacity).toBe(1);
    const glow = findEl('el_intro_glow'); // base opacity 0.35, scale track 0.6 → 1
    const g0 = evaluateElement(glow, 0);
    expect(g0.scale).toBeCloseTo(0.6);
    expect(g0.opacity).toBeCloseTo(0.35);
    expect(evaluateElement(glow, 90).scale).toBe(1);
  });

  it('reports element-relative frame and activity', () => {
    const headline = findEl('el_intro_headline'); // startFrame 20, duration 190
    expect(evaluateElement(headline, 10).active).toBe(false);
    expect(evaluateElement(headline, 20)).toMatchObject({ active: true, localFrame: 0 });
    expect(evaluateElement(headline, 210).active).toBe(false);
  });

  it('editing the base transform keeps tracks identical and the offset relative to the new base', () => {
    const before = findEl('el_intro_logo');
    const r = applyCommand(
      sampleProject,
      { type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_logo', changes: { transform: { x: 100, y: 500 } } },
      { source: 'user' },
    );
    if (!r.ok) throw new Error(r.error.message);
    const after = r.project.scenes[0].elements.find((e) => e.id === 'el_intro_logo')!;
    expect(after.tracks).toEqual(before.tracks);
    expect(after.tracks).toBe(before.tracks);
    for (const f of [0, 6, 12, 24, 40]) {
      const a = evaluateElement(before, f);
      const b = evaluateElement(after, f);
      expect(b.y - 500).toBeCloseTo(a.y - 300, 10);
      expect(b.x - 100).toBeCloseTo(a.x - 720, 10);
      expect(b.opacity).toBeCloseTo(a.opacity, 10);
    }
  });
});
