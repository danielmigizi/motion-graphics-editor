import { describe, expect, it } from 'vitest';
import { validateProject } from '../core/validate';
import { projectDurationInFrames } from '../core/timing';
import { SHOWCASE_STILLS, showcaseV2 } from '../sample/showcaseV2';
import { sceneTransitionStyle } from './MainComposition';

describe('scene entrance transitions', () => {
  it('zooms from 1.08 to 1 while fading in', () => {
    const zoom = { type: 'zoom' as const, durationInFrames: 10 };
    expect(sceneTransitionStyle(zoom, 0)).toEqual({ opacity: 0, transform: 'scale(1.08)' });
    expect(sceneTransitionStyle(zoom, 5)).toMatchObject({ opacity: 0.5 });
    expect(sceneTransitionStyle(zoom, 10)).toEqual({});
  });

  it('blurs from 24px to 0 while fading in', () => {
    const blur = { type: 'blur' as const, durationInFrames: 10 };
    expect(sceneTransitionStyle(blur, 0)).toEqual({ opacity: 0, filter: 'blur(24px)' });
    expect(sceneTransitionStyle(blur, 9)).toMatchObject({ opacity: 0.9 });
    expect(sceneTransitionStyle(blur, 10)).toEqual({});
  });
});

describe('showcaseV2 fixture', () => {
  it('is a valid v2 project whose stills fall inside it', () => {
    const r = validateProject(showcaseV2);
    expect(r.ok, r.ok ? '' : `${r.error.path}: ${r.error.message}`).toBe(true);
    for (const still of SHOWCASE_STILLS) expect(still.frame).toBeLessThan(projectDurationInFrames(showcaseV2));
  });
});
