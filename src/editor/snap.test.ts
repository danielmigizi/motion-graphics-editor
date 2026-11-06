import { describe, expect, it } from 'vitest';
import { boxUnion, offsetBox, snapMove, SNAP_PX, type Box } from './snap';

const canvas: Box = { left: 0, top: 0, right: 1920, bottom: 1080 };
const box = (left: number, top: number, w: number, h: number): Box => ({ left, top, right: left + w, bottom: top + h });

describe('snapMove', () => {
  it('snaps a centre to the canvas centre and draws a full-height guide', () => {
    // 200 wide at x 857 → centre 957, 3 px from 960.
    const r = snapMove(box(857, 100, 200, 100), [canvas], 6);
    expect(r.dx).toBe(3);
    expect(r.dy).toBe(0);
    expect(r.guides).toEqual([{ axis: 'x', at: 960, from: 0, to: 1080 }]);
  });

  it('snaps edges to another element and spans both boxes', () => {
    const other = box(500, 600, 300, 100); // left 500, bottom 700
    const r = snapMove(box(504, 300, 100, 100), [other], 6); // left edge 4 px off
    expect(r.dx).toBe(-4);
    expect(r.guides).toContainEqual({ axis: 'x', at: 500, from: 300, to: 700 });
  });

  it('picks the nearest candidate per axis, independently', () => {
    const r = snapMove(box(5, 1078 - 50, 100, 50), [canvas], 6);
    expect(r.dx).toBe(-5); // left → 0
    expect(r.dy).toBe(2); // bottom 1078 → 1080
    expect(r.guides.map((g) => g.axis).sort()).toEqual(['x', 'y']);
  });

  it('does nothing outside the threshold; the threshold is zoom-aware', () => {
    const moving = box(870, 100, 200, 100); // centre 970, 10 px off
    expect(snapMove(moving, [canvas], SNAP_PX / 1)).toEqual({ dx: 0, dy: 0, guides: [] });
    // At 50% zoom 6 screen px are 12 composition px: now it snaps.
    expect(snapMove(moving, [canvas], SNAP_PX / 0.5).dx).toBe(-10);
  });

  it('merges coincident guides from several targets', () => {
    const a = box(100, 0, 50, 50);
    const b = box(100, 500, 80, 50);
    const r = snapMove(box(102, 200, 40, 40), [a, b], 6);
    expect(r.dx).toBe(-2);
    expect(r.guides.filter((g) => g.axis === 'x' && g.at === 100)).toEqual([{ axis: 'x', at: 100, from: 0, to: 550 }]);
  });
});

describe('box helpers', () => {
  it('unions and offsets', () => {
    expect(boxUnion([box(0, 0, 10, 10), box(20, -5, 10, 10)])).toEqual({ left: 0, top: -5, right: 30, bottom: 10 });
    expect(offsetBox(box(0, 0, 10, 10), 3, -2)).toEqual({ left: 3, top: -2, right: 13, bottom: 8 });
  });
});
