import { describe, expect, it } from 'vitest';
import { clampZoom, FIT_VIEW, fitScale, panBy, toComp, toStage, viewTransform, wheelZoomFactor, zoomAbout, zoomStep, ZOOM_MAX, ZOOM_MIN } from './canvasView';

const stage = { width: 1032, height: 572 };
const comp = { width: 1920, height: 1080 };

describe('fit', () => {
  it('fits the picture inside the stage with a margin, centred', () => {
    const t = viewTransform(FIT_VIEW, stage, comp);
    expect(t.scale).toBeCloseTo(Math.min(1000 / 1920, 540 / 1080));
    expect(t.left).toBeCloseTo((1032 - 1920 * t.scale) / 2);
    expect(t.top).toBeCloseTo((572 - 1080 * t.scale) / 2);
  });

  it('ignores pan while fitted and has a fallback before the stage is measured', () => {
    expect(viewTransform({ zoom: 'fit', panX: 300, panY: 300 }, stage, comp)).toEqual(viewTransform(FIT_VIEW, stage, comp));
    expect(fitScale({ width: 0, height: 0 }, comp)).toBe(0.3);
  });

  it('maps composition ↔ stage points both ways', () => {
    const t = viewTransform({ zoom: 2, panX: 40, panY: -10 }, stage, comp);
    const p = { x: 123, y: 456 };
    const back = toComp(t, toStage(t, p));
    expect(back.x).toBeCloseTo(p.x);
    expect(back.y).toBeCloseTo(p.y);
  });
});

describe('zoom about a point', () => {
  it('keeps the composition point under the anchor where it is', () => {
    const anchor = { x: 700, y: 200 };
    for (const from of [FIT_VIEW, { zoom: 1.5, panX: -120, panY: 80 }]) {
      for (const scale of [0.25, 1, 4]) {
        const before = toComp(viewTransform(from, stage, comp), anchor);
        const next = zoomAbout(from, stage, comp, scale, anchor);
        const after = toStage(viewTransform(next, stage, comp), before);
        expect(next.zoom).toBe(scale);
        expect(after.x).toBeCloseTo(anchor.x, 6);
        expect(after.y).toBeCloseTo(anchor.y, 6);
      }
    }
  });

  it('clamps zoom to 10%–800%', () => {
    expect(clampZoom(0.01)).toBe(ZOOM_MIN);
    expect(clampZoom(20)).toBe(ZOOM_MAX);
    expect(zoomAbout(FIT_VIEW, stage, comp, 50, { x: 0, y: 0 }).zoom).toBe(8);
  });

  it('steps through the zoom stops', () => {
    expect(zoomStep(1, 1)).toBe(1.5);
    expect(zoomStep(1, -1)).toBeCloseTo(2 / 3);
    expect(zoomStep(0.47, 1)).toBe(0.5);
    expect(zoomStep(0.47, -1)).toBeCloseTo(1 / 3);
    expect(zoomStep(8, 1)).toBe(8);
    expect(zoomStep(0.1, -1)).toBe(0.1);
  });

  it('turns wheel deltas into gentle, bounded factors (pinch in, notch out)', () => {
    expect(wheelZoomFactor(-100)).toBeCloseTo(Math.exp(0.25));
    expect(wheelZoomFactor(100)).toBeCloseTo(Math.exp(-0.25));
    expect(wheelZoomFactor(-4)).toBeCloseTo(Math.exp(0.04));
    expect(wheelZoomFactor(-3, 1)).toBeCloseTo(Math.exp(0.25)); // lines
  });
});

describe('pan', () => {
  it('moves a fixed view by stage pixels; a fitted view becomes fixed at the fit scale', () => {
    const fitted = viewTransform(FIT_VIEW, stage, comp);
    const v = panBy(FIT_VIEW, stage, comp, 30, -20);
    expect(v).toEqual({ zoom: fitted.scale, panX: 30, panY: -20 });
    const t = viewTransform(v, stage, comp);
    expect(t.left - fitted.left).toBeCloseTo(30);
    expect(t.top - fitted.top).toBeCloseTo(-20);
  });

  it('never pans the picture out of reach', () => {
    const v = panBy({ zoom: 1, panX: 0, panY: 0 }, stage, comp, 100000, -100000);
    const t = viewTransform(v, stage, comp);
    expect(t.left).toBeLessThanOrEqual(stage.width - 64 + 1e-9);
    expect(t.top + comp.height).toBeGreaterThanOrEqual(64 - 1e-9);
  });
});
