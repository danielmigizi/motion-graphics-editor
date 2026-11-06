import { describe, expect, it } from 'vitest';
import type { PathNode } from '../core/types';
import { handleLink, pathBounds } from './pathEdit';
import { constrain45, penCanFinish, penDrag, penGeometry, penPress, penUndoPoint, rubberBand } from './penTool';

const opts = { tolerance: 8 };

/** Replay presses (with optional drags) the way the stage does. */
function draw(steps: ({ x: number; y: number; drag?: { x: number; y: number }; shift?: boolean })[]) {
  let nodes: PathNode[] = [];
  let last = penPress(nodes, steps[0], opts);
  for (const s of steps) {
    last = penPress(nodes, s, { ...opts, constrain: s.shift });
    nodes = last.nodes;
    if (s.drag) nodes = penDrag(nodes, last.index, s.drag, { constrain: s.shift });
  }
  return { nodes, last };
}

describe('pen presses', () => {
  it('clicks add corner nodes in order', () => {
    const { nodes, last } = draw([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }]);
    expect(last.action).toBe('add');
    expect(nodes).toEqual([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }]);
  });

  it('click-drag makes a smooth node with symmetric handles (out at the pointer)', () => {
    const { nodes } = draw([{ x: 0, y: 0 }, { x: 100, y: 0, drag: { x: 130, y: 40 } }]);
    expect(nodes[1]).toEqual({ x: 100, y: 0, out: { x: 130, y: 40 }, in: { x: 70, y: -40 } });
    expect(handleLink(nodes[1])).toBe('mirror');
  });

  it('pressing the first node closes a path of two or more nodes', () => {
    const { last } = draw([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 80 }, { x: 3, y: -4 }]);
    expect(last.action).toBe('close');
    expect(last.nodes).toHaveLength(3);
    expect(last.index).toBe(0);
    // Dragging on the closing press shapes the first node.
    const shaped = penDrag(last.nodes, 0, { x: 20, y: -20 });
    expect(shaped[0]).toEqual({ x: 0, y: 0, out: { x: 20, y: -20 }, in: { x: -20, y: 20 } });
  });

  it('a press on the last node adds nothing (the second click of a double-click)', () => {
    const { nodes, last } = draw([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 102, y: 1 }]);
    expect(last.action).toBe('none');
    expect(last.index).toBe(1);
    expect(nodes).toHaveLength(2);
    // With one node, pressing it again neither closes nor adds.
    expect(penPress([{ x: 0, y: 0 }], { x: 1, y: 1 }, opts).action).toBe('none');
  });

  it('Shift constrains a new segment to 45° steps from the last node', () => {
    const { nodes } = draw([{ x: 0, y: 0 }, { x: 100, y: 12, shift: true }, { x: 160, y: 75, shift: true }]);
    expect(nodes[1]).toEqual({ x: 100, y: 0 });
    // 45° from (100, 0): projection of (60, 75) on (1, 1)/√2 → 67.5 each way.
    expect(nodes[2].x).toBeCloseTo(167.5, 9);
    expect(nodes[2].y).toBeCloseTo(67.5, 9);
  });

  it('Shift constrains a dragged handle round its node', () => {
    const nodes = penDrag([{ x: 0, y: 0 }, { x: 100, y: 100 }], 1, { x: 100 + 3, y: 100 + 50 }, { constrain: true });
    expect(nodes[1].out!.x).toBeCloseTo(100, 9);
    expect(nodes[1].out!.y).toBeCloseTo(150, 9);
    expect(nodes[1].in!.y).toBeCloseTo(50, 9);
  });

  it('Backspace takes back points; two nodes are needed to finish', () => {
    const { nodes } = draw([{ x: 0, y: 0 }, { x: 100, y: 0 }]);
    expect(penCanFinish(nodes)).toBe(true);
    expect(penCanFinish(penUndoPoint(nodes))).toBe(false);
    expect(penUndoPoint(penUndoPoint(nodes))).toEqual([]);
  });
});

describe('constrain45', () => {
  it('snaps to the nearest of the eight directions, keeping the distance along it', () => {
    expect(constrain45({ x: 0, y: 0 }, { x: 10, y: 3 })).toEqual({ x: 10, y: 0 });
    expect(constrain45({ x: 0, y: 0 }, { x: -2, y: -30 })).toEqual({ x: 0, y: -30 });
    const d = constrain45({ x: 0, y: 0 }, { x: 10, y: 9 });
    expect(d.x).toBeCloseTo(9.5, 9);
    expect(d.y).toBeCloseTo(9.5, 9);
    expect(constrain45({ x: 5, y: 5 }, { x: 5, y: 5 })).toEqual({ x: 5, y: 5 });
  });
});

describe('rubber band', () => {
  it('runs from the last node (along its handle) to the pointer, or to the first node when closing', () => {
    const nodes: PathNode[] = [{ x: 0, y: 0, in: { x: -10, y: 10 } }, { x: 100, y: 0, out: { x: 120, y: 30 }, in: { x: 80, y: -30 } }];
    const open = rubberBand(nodes, { x: 200, y: 50 }, opts)!;
    expect(open.closing).toBe(false);
    expect(open.cubic).toEqual([{ x: 100, y: 0 }, { x: 120, y: 30 }, { x: 200, y: 50 }, { x: 200, y: 50 }]);
    const closing = rubberBand(nodes, { x: 3, y: 2 }, opts)!;
    expect(closing.closing).toBe(true);
    expect(closing.cubic[2]).toEqual({ x: -10, y: 10 });
    expect(closing.cubic[3]).toEqual({ x: 0, y: 0 });
    expect(rubberBand([], { x: 0, y: 0 }, opts)).toBeNull();
  });
});

describe('penGeometry', () => {
  it('whole-pixel box round the curve, nodes re-based into it', () => {
    const nodes: PathNode[] = [{ x: 100.4, y: 200.6 }, { x: 300.2, y: 120.25, in: { x: 250, y: 60 } }, { x: 180, y: 260.9 }];
    const g = penGeometry(nodes, true);
    const b = pathBounds(nodes, true);
    expect(g.x).toBe(Math.floor(b.x));
    expect(g.y).toBe(Math.floor(b.y));
    expect(g.x + g.width).toBe(Math.ceil(b.x + b.width));
    expect(g.y + g.height).toBe(Math.ceil(b.y + b.height));
    expect(g.nodes[0]).toEqual({ x: 0.4, y: 200.6 - g.y });
    const inner = pathBounds(g.nodes, true);
    expect(inner.x).toBeGreaterThanOrEqual(0);
    expect(inner.y).toBeGreaterThanOrEqual(-0.01);
    expect(inner.x + inner.width).toBeLessThanOrEqual(g.width);
    expect(inner.y + inner.height).toBeLessThanOrEqual(g.height + 0.01);
  });

  it('a horizontal line still gets a box at least 1 px tall', () => {
    const g = penGeometry([{ x: 10, y: 40 }, { x: 90, y: 40 }], false);
    expect(g).toMatchObject({ x: 10, y: 40, width: 80, height: 1 });
    expect(g.nodes).toEqual([{ x: 0, y: 0 }, { x: 80, y: 0 }]);
  });
});
