import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CLIP_COLOR,
  clampPxPerFrame,
  contentWidth,
  dragWorkArea,
  fitPxPerFrame,
  fitRange,
  frameAtX,
  frameX,
  MAX_PX_PER_FRAME,
  resolveWorkArea,
  revealFrame,
  rulerTicks,
  sceneAccent,
  setWorkAreaEdge,
  stepTo,
  tickFrames,
  tickLabel,
  TRACK_PAD_PX,
  workAreaLoopProps,
  zoomAbout,
  zoomAtSliderPos,
  zoomPercent,
  ZOOM_SLIDER_MAX,
  zoomSliderPos,
} from './timelineView';

describe('zoom ↔ px per frame', () => {
  it('fits the whole project into the viewport', () => {
    const fit = fitPxPerFrame(720, 1220);
    expect(fit).toBeCloseTo((1220 - 40) / 720);
    expect(contentWidth(720, fit)).toBeLessThanOrEqual(1220);
    // A tiny project never zooms past the closest zoom.
    expect(fitPxPerFrame(10, 1220)).toBe(MAX_PX_PER_FRAME);
  });

  it('clamps between fit and 8 px per frame', () => {
    expect(clampPxPerFrame(0.1, 1.5)).toBe(1.5);
    expect(clampPxPerFrame(40, 1.5)).toBe(MAX_PX_PER_FRAME);
    expect(clampPxPerFrame(3, 1.5)).toBe(3);
  });

  it('maps frames to content x and back to whole, clamped frames', () => {
    expect(frameX(0, 4)).toBe(TRACK_PAD_PX);
    expect(frameX(30, 4)).toBe(TRACK_PAD_PX + 120);
    expect(frameAtX(TRACK_PAD_PX + 121, 4, 720)).toBe(30);
    expect(frameAtX(TRACK_PAD_PX + 123, 4, 720)).toBe(31);
    expect(frameAtX(-50, 4, 720)).toBe(0);
    expect(frameAtX(1e6, 4, 720)).toBe(719);
  });

  it('zooms about the pointer: the frame under it stays put', () => {
    const fit = fitPxPerFrame(720, 1220);
    const view = { pxPerFrame: 2, scrollPx: 300 };
    const anchor = 400;
    const before = (view.scrollPx + anchor - TRACK_PAD_PX) / view.pxPerFrame;
    const next = zoomAbout(view, 2, anchor, fit, 720, 1220);
    expect(next.pxPerFrame).toBe(4);
    expect((next.scrollPx + anchor - TRACK_PAD_PX) / next.pxPerFrame).toBeCloseTo(before);
  });

  it('zooming out to fit scrolls back to the start', () => {
    const fit = fitPxPerFrame(720, 1220);
    const next = zoomAbout({ pxPerFrame: 4, scrollPx: 900 }, 1 / 100, 600, fit, 720, 1220);
    expect(next.pxPerFrame).toBeCloseTo(fit);
    expect(next.scrollPx).toBe(0);
  });

  it('fits a scene range', () => {
    const fit = fitPxPerFrame(720, 1220);
    const v = fitRange(210, 480, 1220, fit, 720);
    expect(frameX(210, v.pxPerFrame) - v.scrollPx).toBeGreaterThanOrEqual(0);
    expect(frameX(480, v.pxPerFrame) - v.scrollPx).toBeLessThanOrEqual(1220);
    expect(v.pxPerFrame).toBeGreaterThan(fit);
  });

  it('maps the zoom slider logarithmically between fit and 8 px per frame', () => {
    const fit = fitPxPerFrame(720, 1220);
    expect(zoomSliderPos(fit, fit)).toBe(0);
    expect(zoomSliderPos(MAX_PX_PER_FRAME, fit)).toBe(ZOOM_SLIDER_MAX);
    expect(zoomAtSliderPos(0, fit)).toBeCloseTo(fit);
    expect(zoomAtSliderPos(ZOOM_SLIDER_MAX, fit)).toBeCloseTo(MAX_PX_PER_FRAME);
    // Halfway along is the geometric middle, and positions round-trip.
    expect(zoomAtSliderPos(ZOOM_SLIDER_MAX / 2, fit)).toBeCloseTo(Math.sqrt(fit * MAX_PX_PER_FRAME));
    expect(zoomSliderPos(zoomAtSliderPos(371, fit), fit)).toBe(371);
    // A project short enough to fit at the closest zoom pins the slider at the end.
    expect(zoomSliderPos(MAX_PX_PER_FRAME, MAX_PX_PER_FRAME)).toBe(ZOOM_SLIDER_MAX);
  });

  it('reads the zoom as a percentage of "Fit project"', () => {
    const fit = fitPxPerFrame(720, 1220);
    expect(zoomPercent(fit, fit)).toBe(100);
    expect(zoomPercent(fit * 2.5, fit)).toBe(250);
    expect(zoomPercent(MAX_PX_PER_FRAME, MAX_PX_PER_FRAME)).toBe(100);
  });

  it('pages the scroll to keep the playhead visible', () => {
    const view = { pxPerFrame: 8, scrollPx: 0 };
    expect(revealFrame(view, 10, 1000, 720)).toBe(0);
    const s = revealFrame(view, 400, 1000, 720);
    expect(frameX(400, 8) - s).toBeGreaterThan(0);
    expect(frameX(400, 8) - s).toBeLessThan(1000);
    const back = revealFrame({ pxPerFrame: 8, scrollPx: 3000 }, 10, 1000, 720);
    expect(back).toBe(0);
  });
});

describe('ruler ticks', () => {
  it('labels whole seconds when zoomed out, frames when zoomed in', () => {
    // Fit 24 s into ~1200 px: ~1.67 px per frame → a label every 2 s.
    expect(rulerTicks(1200 / 720, 30)).toEqual({ major: 60, minor: 5 });
    // 8 px per frame: labels every 10 frames, a tick per frame.
    expect(rulerTicks(8, 30)).toEqual({ major: 10, minor: 1 });
    // ~4 px per second (a long project): every 15 s.
    expect(rulerTicks(4 / 30, 30).major).toBe(15 * 30);
  });

  it('keeps labels at least the minimum apart at every zoom', () => {
    for (let ppf = 0.05; ppf <= 8; ppf *= 1.3) {
      const { major, minor } = rulerTicks(ppf, 30);
      expect(major * ppf).toBeGreaterThanOrEqual(52);
      expect(major % minor).toBe(0);
    }
  });

  it('uses frame steps that divide a second (24 fps)', () => {
    const { major } = rulerTicks(5, 24);
    expect(24 % major === 0 || major % 24 === 0).toBe(true);
  });

  it('lists ticks in a range and formats readable labels', () => {
    expect(tickFrames(25, 95, 30)).toEqual([30, 60, 90]);
    expect(tickFrames(-10, 10, 5)).toEqual([0, 5, 10]);
    expect(tickLabel(0, 30)).toBe('0s');
    expect(tickLabel(90, 30)).toBe('3s');
    expect(tickLabel(95, 30)).toBe('5f');
    expect(tickLabel(65 * 30, 30)).toBe('1:05');
  });
});

describe('work area', () => {
  it('defaults to the whole project and clamps stored ranges', () => {
    expect(resolveWorkArea(null, 720)).toEqual({ start: 0, end: 720 });
    expect(resolveWorkArea({ start: 700, end: 900 }, 720)).toEqual({ start: 700, end: 720 });
    expect(resolveWorkArea({ start: 800, end: 900 }, 720)).toEqual({ start: 719, end: 720 });
  });

  it('drags edges and the whole range, never below one frame', () => {
    const a = { start: 100, end: 200 };
    expect(dragWorkArea(a, 'start', 150, 720)).toEqual({ start: 199, end: 200 });
    expect(dragWorkArea(a, 'end', -500, 720)).toEqual({ start: 100, end: 101 });
    expect(dragWorkArea(a, 'move', 600, 720)).toEqual({ start: 620, end: 720 });
    expect(dragWorkArea(a, 'move', -500, 720)).toEqual({ start: 0, end: 100 });
  });

  it('sets in/out at the playhead', () => {
    const a = { start: 100, end: 200 };
    expect(setWorkAreaEdge(a, 'start', 150, 720)).toEqual({ start: 150, end: 200 });
    expect(setWorkAreaEdge(a, 'start', 300, 720)).toEqual({ start: 300, end: 720 });
    expect(setWorkAreaEdge(a, 'end', 149, 720)).toEqual({ start: 100, end: 150 });
    expect(setWorkAreaEdge(a, 'end', 50, 720)).toEqual({ start: 0, end: 51 });
  });

  it('gives the player inclusive in/out frames to loop natively', () => {
    expect(workAreaLoopProps({ start: 100, end: 200 }, 720, true)).toEqual({ inFrame: 100, outFrame: 199, loop: true });
    // Open ends at the project's edges; the whole project just loops.
    expect(workAreaLoopProps({ start: 0, end: 200 }, 720, true)).toEqual({ inFrame: null, outFrame: 199, loop: true });
    expect(workAreaLoopProps(null, 720, true)).toEqual({ inFrame: null, outFrame: null, loop: true });
    // Off, or too short to loop.
    expect(workAreaLoopProps({ start: 100, end: 200 }, 720, false)).toEqual({ inFrame: null, outFrame: null, loop: false });
    expect(workAreaLoopProps({ start: 100, end: 101 }, 720, true)).toEqual({ inFrame: null, outFrame: null, loop: false });
  });
});

describe('clip and scene colours', () => {
  const css = readFileSync(new URL('./styles.css', import.meta.url), 'utf8');
  const root = css.slice(css.indexOf(':root {'), css.indexOf('/* stylelint-enable'));
  const declared = (v: string) => root.includes(`${v.slice(4, -1)}:`);

  it('takes every bar colour from a token declared in :root', () => {
    for (const [type, color] of Object.entries(CLIP_COLOR)) {
      expect(color, type).toMatch(/^var\(--clip-[a-z-]+\)$/);
      expect(declared(color), color).toBe(true);
    }
  });

  it('cycles the four scene accents', () => {
    expect([0, 1, 2, 3, 4, 9].map(sceneAccent)).toEqual(['var(--scene-accent-0)', 'var(--scene-accent-1)', 'var(--scene-accent-2)', 'var(--scene-accent-3)', 'var(--scene-accent-0)', 'var(--scene-accent-1)']);
    expect(declared(sceneAccent(3))).toBe(true);
  });
});

describe('stepTo', () => {
  it('finds the previous / next frame', () => {
    const f = [30, 0, 90, 60];
    expect(stepTo(f, 45, 1)).toBe(60);
    expect(stepTo(f, 45, -1)).toBe(30);
    expect(stepTo(f, 60, 1)).toBe(90);
    expect(stepTo(f, 90, 1)).toBeNull();
    expect(stepTo(f, 0, -1)).toBeNull();
  });
});
