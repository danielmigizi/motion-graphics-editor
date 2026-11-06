import { describe, expect, it } from 'vitest';
import { alignOffsets, distributeOffsets, type ArrangeItem } from './arrange';
import type { Box } from './snap';

const canvas: Box = { left: 0, top: 0, right: 1920, bottom: 1080 };
const item = (id: string, left: number, top: number, w: number, h: number): ArrangeItem => ({ id, box: { left, top, right: left + w, bottom: top + h } });
const items = [item('a', 100, 50, 200, 100), item('b', 400, 300, 100, 50), item('c', 250, 600, 300, 200)];
const moved = (offs: { id: string; dx: number; dy: number }[]) => Object.fromEntries(offs.map((o) => [o.id, [o.dx, o.dy]]));

describe('align to the selection bounds', () => {
  it('left / centre / right', () => {
    expect(moved(alignOffsets(items, 'left', canvas))).toEqual({ a: [0, 0], b: [-300, 0], c: [-150, 0] });
    // bounds 100..550 → centre 325
    expect(moved(alignOffsets(items, 'centre', canvas))).toEqual({ a: [125, 0], b: [-125, 0], c: [-75, 0] });
    expect(moved(alignOffsets(items, 'right', canvas))).toEqual({ a: [250, 0], b: [50, 0], c: [0, 0] });
  });

  it('top / middle / bottom', () => {
    expect(moved(alignOffsets(items, 'top', canvas))).toEqual({ a: [0, 0], b: [0, -250], c: [0, -550] });
    // bounds 50..800 → middle 425
    expect(moved(alignOffsets(items, 'middle', canvas))).toEqual({ a: [0, 325], b: [0, 100], c: [0, -275] });
    expect(moved(alignOffsets(items, 'bottom', canvas))).toEqual({ a: [0, 650], b: [0, 450], c: [0, 0] });
  });

  it('one element aligns to the canvas', () => {
    expect(alignOffsets([item('a', 100, 50, 200, 100)], 'centre', canvas)).toEqual([{ id: 'a', dx: 760, dy: 0 }]);
    expect(alignOffsets([item('a', 100, 50, 200, 100)], 'bottom', canvas)).toEqual([{ id: 'a', dx: 0, dy: 930 }]);
    expect(alignOffsets([], 'left', canvas)).toEqual([]);
  });
});

describe('distribute', () => {
  it('equalises the gaps between neighbours, keeping the ends', () => {
    // horizontal order a(100..300) c(250..550) b(400..500): span 100..500 = 400, widths 600 → gap −100
    const h = moved(distributeOffsets(items, 'horizontal'));
    expect(h.a).toEqual([0, 0]);
    expect(h.b).toEqual([0, 0]);
    expect(h.c).toEqual([300 - 100 - 250, 0]); // c starts at a.right + gap = 200
  });

  it('vertical spacing with three rows', () => {
    const rows = [item('top', 0, 0, 10, 100), item('mid', 0, 150, 10, 100), item('bot', 0, 500, 10, 100)];
    // span 0..600 = 600, heights 300 → gap 150; mid goes to 250
    expect(moved(distributeOffsets(rows, 'vertical'))).toEqual({ top: [0, 0], mid: [0, 100], bot: [0, 0] });
  });

  it('needs three or more items', () => {
    expect(distributeOffsets(items.slice(0, 2), 'vertical').every((o) => o.dx === 0 && o.dy === 0)).toBe(true);
  });
});
