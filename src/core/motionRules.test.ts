import { describe, expect, it } from 'vitest';
import { contrastRatio, CRAFT_VERSION, EXIT_RATIO, FRAME_USE, heroSizeFor, LIVENESS, motionRole, readingFrames, safeMargin, scaledFrames, SEAM, staggerFor, staggerOrder, STORY, TYPE_MIN, TYPE_SCALE } from './motionRules';
import { MOTION_PERSONALITIES } from './style';

const box = (x: number, y: number, width = 100, height = 100) => ({ transform: { x, y, width, height, scale: 1 } });

describe('motion rules (craft v2)', () => {
  it('keeps frames alive, uses the frame and sets video-safe type minimums', () => {
    expect(CRAFT_VERSION).toBe('craft v2');
    expect(LIVENESS.maxStillSeconds).toBe(0.5);
    expect(TYPE_SCALE.minBodyPx).toBe(TYPE_MIN.body);
    expect(TYPE_MIN).toMatchObject({ label: 24, trackedCaps: 32, body: 32, callout: 26, ctaLabel: 30, contrast: 4.5 });
    expect(FRAME_USE.screenshotWidthShare[0]).toBeGreaterThanOrEqual(0.6);
    expect(STORY).toMatchObject({ hookSeconds: [1.5, 2], minSceneSeconds: 2.5, payoffShare: 0.22, deadMiddleSeconds: 8 });
    expect(SEAM).toMatchObject({ maxEntrySeconds: 0.8, exitRatio: 0.75, stillnessSeconds: [0.3, 0.75], idleReversals: 3 });
    expect(EXIT_RATIO).toBe(0.75);
    // A hero headline's cap height is 7 % of the short side: 105 px at 1080.
    expect(heroSizeFor({ width: 1920, height: 1080 })).toBe(105);
    expect(heroSizeFor({ width: 1080, height: 1920 }, 0.1)).toBe(150);
  });

  it('measures WCAG contrast, compositing translucent colours over what is below', () => {
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
    expect(contrastRatio('rgba(255, 255, 255, 0)', '#000000')).toBeCloseTo(1, 5);
    // A 4 % white panel over black lifts the backdrop a little; the last layer counts as opaque.
    expect(contrastRatio('#FFFFFF', 'rgba(255, 255, 255, 0.04)', '#000000')!).toBeLessThan(21);
    expect(contrastRatio('#FFFFFF', '#00000080')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF')).toBeNull();
    expect(contrastRatio('#FFFFFF', 'linear-gradient(red, blue)')).toBeNull();
  });

  it('reading time: 3.5 words a second plus half a second to find it, never under 1.2 s', () => {
    expect(readingFrames('Ship it', 30)).toBe(36); // floor 1.2 s
    expect(readingFrames('Your week of engineering changes, summarised in two minutes', 30)).toBe(Math.round((9 / 3.5 + 0.5) * 30));
  });

  it('orders siblings for arrive-apart staggers', () => {
    const items = [box(500, 400), box(100, 410), box(300, 100, 400, 300)];
    expect(staggerOrder(items, 'reading')).toEqual([items[2], items[1], items[0]]);
    expect(staggerOrder(items, 'importance')[0]).toBe(items[2]);
    expect(staggerOrder(items, 'given')).toEqual(items);
    expect(staggerOrder([box(0, 0), box(450, 200), box(900, 400)], 'centerOut')[0].transform.x).toBe(450);
  });

  it('scales timing and stagger with the personality', () => {
    expect(scaledFrames(0.6, 30)).toBe(18);
    expect(scaledFrames(0.6, 30, MOTION_PERSONALITIES.premium)).toBe(24);
    expect(staggerFor()).toBe(4);
    expect(staggerFor(MOTION_PERSONALITIES.snappy)).toBe(3);
  });

  it('sizes roles and margins to the frame', () => {
    const p = { width: 1920, height: 1080 };
    expect(motionRole(box(0, 0, 80, 80), p)).toBe('micro');
    expect(motionRole(box(0, 0, 360, 120), p)).toBe('small');
    expect(motionRole(box(0, 0, 900, 300), p)).toBe('medium');
    expect(motionRole(box(0, 0, 1600, 900), p)).toBe('large');
    expect(safeMargin({ width: 1080, height: 1920 })).toBe(96);
    expect(safeMargin({ width: 3840, height: 2160 }, 'min')).toBe(128);
  });
});
