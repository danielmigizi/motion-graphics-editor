import { describe, expect, it } from 'vitest';
import { transformPoint } from '../core/animation';
import { pathData } from '../core/path';
import type { PathNode } from '../core/types';
import {
  cubicPoint,
  cycleNode,
  deleteNodes,
  fitBoxToPath,
  frameMatrix,
  handleLink,
  hitPath,
  insertNode,
  isSmooth,
  mapNodes,
  moveHandle,
  moveNodes,
  nodesInBox,
  pathBounds,
  segmentCount,
  segmentCubic,
  splitCubic,
  toggleSmooth,
  type Cubic,
} from './pathEdit';

const close = (a: { x: number; y: number }, b: { x: number; y: number }, eps = 1e-6) => {
  expect(Math.abs(a.x - b.x)).toBeLessThan(eps);
  expect(Math.abs(a.y - b.y)).toBeLessThan(eps);
};

const wave: PathNode[] = [
  { x: 10, y: 80, out: { x: 60, y: 0 } },
  { x: 150, y: 60, in: { x: 110, y: 120 }, out: { x: 190, y: 0 } },
  { x: 300, y: 40, in: { x: 250, y: 100 } },
];

/** Every point of the original segment, before and after the split point, lies on the new halves. */
function expectSplitPreserves(original: Cubic, left: Cubic, right: Cubic, t: number) {
  for (let i = 0; i <= 20; i++) {
    const s = i / 20;
    const p = cubicPoint(original, s);
    close(p, s <= t ? cubicPoint(left, t ? s / t : 0) : cubicPoint(right, (s - t) / (1 - t)));
  }
}

describe('de Casteljau', () => {
  it('splitCubic halves trace the original curve', () => {
    const c: Cubic = [{ x: 0, y: 0 }, { x: 30, y: -90 }, { x: 140, y: 120 }, { x: 200, y: 10 }];
    for (const t of [0.1, 0.37, 0.5, 0.9]) {
      const [l, r] = splitCubic(c, t);
      expectSplitPreserves(c, l, r, t);
    }
  });
});

describe('insertNode', () => {
  it('splits a curved segment without changing the shape', () => {
    for (const t of [0.2, 0.5, 0.73]) {
      const before = segmentCubic(wave, 1);
      const { nodes, index } = insertNode(wave, 1, t);
      expect(index).toBe(2);
      expect(nodes).toHaveLength(4);
      expectSplitPreserves(before, segmentCubic(nodes, 1), segmentCubic(nodes, 2), t);
      // Untouched segments stay identical, and the new node is smooth (collinear handles).
      expect(segmentCubic(nodes, 0)).toEqual(segmentCubic(wave, 0));
      expect(isSmooth(nodes[2])).toBe(true);
    }
  });

  it('keeps a straight segment straight with a corner node on the line, at the cubic parameter t', () => {
    const line: PathNode[] = [{ x: 0, y: 0 }, { x: 100, y: 50 }];
    const { nodes, index } = insertNode(line, 0, 0.5);
    expect(index).toBe(1);
    expect(nodes[1]).toEqual({ x: 50, y: 25 });
    expect(pathData(nodes, false)).toBe('M0 0 L50 25 L100 50');
    // t is the segment's cubic parameter (as hitPath reports it), not a linear fraction.
    close(insertNode(line, 0, 0.25).nodes[1], cubicPoint(segmentCubic(line, 0), 0.25));
  });

  it('puts a node clicked on a straight segment under the pointer', () => {
    const line: PathNode[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
    const hit = hitPath(line, false, { x: 25, y: 0 }, [], 7, 6);
    expect(hit?.kind).toBe('segment');
    if (hit?.kind !== 'segment') return;
    const { nodes } = insertNode(line, hit.segment, hit.t);
    close(nodes[1], { x: 25, y: 0 }, 1e-3);
  });

  it('works when only one end has a handle (the other sits on its node)', () => {
    const half: PathNode[] = [{ x: 0, y: 0 }, { x: 100, y: 0, in: { x: 50, y: 80 } }];
    const before = segmentCubic(half, 0);
    const { nodes } = insertNode(half, 0, 0.4);
    expect(nodes[0].out).toBeUndefined(); // still on its node: tidy data, same geometry
    expectSplitPreserves(before, segmentCubic(nodes, 0), segmentCubic(nodes, 1), 0.4);
  });

  it('splits the closing segment of a closed path, appending the node', () => {
    const tri: PathNode[] = [
      { x: 0, y: 0, in: { x: -40, y: 30 } },
      { x: 100, y: 0 },
      { x: 50, y: 80, out: { x: 10, y: 90 } },
    ];
    expect(segmentCount(tri.length, true)).toBe(3);
    const before = segmentCubic(tri, 2);
    const { nodes, index } = insertNode(tri, 2, 0.6);
    expect(index).toBe(3);
    expectSplitPreserves(before, segmentCubic(nodes, 2), segmentCubic(nodes, 3), 0.6);
    expect(nodes[0].x).toBe(0);
  });
});

describe('smooth and corner nodes', () => {
  it('toggleSmooth gives a corner collinear handles a third of the way to each neighbour, and back', () => {
    const zig: PathNode[] = [{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 90, y: 120 }];
    const smooth = toggleSmooth(zig, 1, false);
    const n = smooth[1];
    expect(isSmooth(n)).toBe(true);
    expect(handleLink(n)).toBe('collinear');
    expect(Math.hypot(n.in!.x - n.x, n.in!.y - n.y)).toBeCloseTo(30, 9);
    expect(Math.hypot(n.out!.x - n.x, n.out!.y - n.y)).toBeCloseTo(40, 9);
    // Direction: previous → next.
    const d = { x: 90 / 150, y: 120 / 150 };
    close({ x: (n.out!.x - n.x) / 40, y: (n.out!.y - n.y) / 40 }, d);
    expect(toggleSmooth(smooth, 1, false)[1]).toEqual({ x: 90, y: 0 });
  });

  it('end nodes of an open path use their one neighbour; closed paths wrap', () => {
    const open = toggleSmooth([{ x: 0, y: 0 }, { x: 60, y: 0 }], 0, false)[0];
    expect(open.out).toEqual({ x: 20, y: 0 });
    expect(open.in).toEqual({ x: -20, y: 0 });
    const sq: PathNode[] = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    const c = toggleSmooth(sq, 0, true)[0];
    expect(isSmooth(c)).toBe(true);
    close({ x: c.out!.x - c.x, y: c.out!.y - c.y }, { x: (100 / 3) * Math.SQRT1_2, y: -(100 / 3) * Math.SQRT1_2 });
  });
});

describe('moveHandle', () => {
  const mirrored: PathNode = { x: 100, y: 100, in: { x: 60, y: 100 }, out: { x: 140, y: 100 } };
  const collinear: PathNode = { x: 100, y: 100, in: { x: 80, y: 100 }, out: { x: 160, y: 100 } };
  const corner: PathNode = { x: 100, y: 100, in: { x: 80, y: 80 }, out: { x: 160, y: 100 } };
  const ends: PathNode[] = [{ x: 0, y: 0 }, { x: 300, y: 0 }];
  const withNode = (n: PathNode) => [ends[0], n, ends[1]];

  it('a mirrored pair stays mirrored (angle and length)', () => {
    const n = moveHandle(withNode(mirrored), 1, 'out', { x: 100, y: 150 }, false)[1];
    expect(n.out).toEqual({ x: 100, y: 150 });
    close(n.in!, { x: 100, y: 50 });
    expect(handleLink(n)).toBe('mirror');
  });

  it('a collinear pair keeps the other handle opposite at its own length', () => {
    const n = moveHandle(withNode(collinear), 1, 'out', { x: 100, y: 40 }, false)[1];
    close(n.in!, { x: 100, y: 120 });
    expect(handleLink(n)).toBe('collinear');
  });

  it('Alt (broken) moves one handle; a corner never drags its partner', () => {
    expect(moveHandle(withNode(mirrored), 1, 'in', { x: 100, y: 40 }, true)[1].out).toEqual(mirrored.out);
    expect(moveHandle(withNode(corner), 1, 'out', { x: 100, y: 200 }, false)[1].in).toEqual(corner.in);
  });

  it('moving nodes carries their handles; mapNodes maps handles too', () => {
    const moved = moveNodes(wave, [1], { x: 5, y: -10 });
    expect(moved[1]).toEqual({ x: 155, y: 50, in: { x: 115, y: 110 }, out: { x: 195, y: -10 } });
    expect(moved[0]).toEqual(wave[0]);
    const m = mapNodes(wave, [2, 0, 0, 2, 10, 20]);
    expect(m[1]).toEqual({ x: 310, y: 140, in: { x: 230, y: 260 }, out: { x: 390, y: 20 } });
  });
});

describe('deleteNodes', () => {
  it('removes the selected nodes and keeps at least two', () => {
    expect(deleteNodes(wave, [1])).toEqual([wave[0], wave[2]]);
    expect(deleteNodes(wave, [0, 2])).toBeNull();
    expect(deleteNodes(wave.slice(0, 2), [0])).toBeNull();
  });
});

describe('hit-testing and selection helpers', () => {
  it('nodes and shown handles win over the outline; the outline reports t', () => {
    expect(hitPath(wave, false, { x: 152, y: 61 }, [], 7, 6)).toEqual({ kind: 'node', index: 1 });
    expect(hitPath(wave, false, { x: 190, y: 2 }, [], 7, 6)).toBeNull(); // handle of an unselected node: not shown
    expect(hitPath(wave, false, { x: 190, y: 2 }, [1], 7, 6)).toEqual({ kind: 'handle', index: 1, key: 'out' });
    const on = cubicPoint(segmentCubic(wave, 1), 0.4);
    const hit = hitPath(wave, false, { x: on.x + 2, y: on.y }, [], 7, 6);
    expect(hit?.kind).toBe('segment');
    if (hit?.kind === 'segment') {
      expect(hit.segment).toBe(1);
      expect(Math.abs(hit.t - 0.4)).toBeLessThan(0.05);
    }
    expect(hitPath(wave, false, { x: 150, y: 300 }, [], 7, 6)).toBeNull();
  });

  it('cycleNode wraps both ways; nodesInBox picks the nodes inside', () => {
    expect(cycleNode([], 3, 1)).toBe(0);
    expect(cycleNode([], 3, -1)).toBe(2);
    expect(cycleNode([2], 3, 1)).toBe(0);
    expect(cycleNode([0], 3, -1)).toBe(2);
    expect(nodesInBox(wave, { left: 0, top: 50, right: 200, bottom: 100 })).toEqual([0, 1]);
  });
});

describe('bounds and fit box to path', () => {
  it('pathBounds uses the curve extrema, not the control points', () => {
    const arch: PathNode[] = [{ x: 0, y: 0, out: { x: 0, y: -100 } }, { x: 100, y: 0, in: { x: 100, y: -100 } }];
    const b = pathBounds(arch, false);
    expect(b.x).toBeCloseTo(0, 9);
    expect(b.width).toBeCloseTo(100, 9);
    expect(b.y).toBeCloseTo(-75, 9);
    expect(b.height).toBeCloseTo(75, 9);
  });

  it('re-bases nodes into a box round the curve and keeps every world position (rotated, scaled box)', () => {
    // Nodes overhang the box on every side.
    const nodes: PathNode[] = [
      { x: -40, y: 30, out: { x: 20, y: -80 } },
      { x: 260, y: 90, in: { x: 200, y: -20 }, out: { x: 300, y: 160 } },
      { x: 120, y: 240, in: { x: 200, y: 260 } },
    ];
    for (const closed of [false, true]) {
      const box = { x: 300, y: 200, width: 200, height: 150, rotation: 33, scale: 1.7 };
      const fit = fitBoxToPath(nodes, closed, box);
      const before = frameMatrix(box);
      const after = frameMatrix({ ...box, x: fit.x, y: fit.y, width: fit.width, height: fit.height });
      for (let i = 0; i < segmentCount(nodes.length, closed); i++) {
        for (let k = 0; k <= 10; k++) {
          close(transformPoint(after, cubicPoint(segmentCubic(fit.nodes, i), k / 10)), transformPoint(before, cubicPoint(segmentCubic(nodes, i), k / 10)));
        }
      }
      const b = pathBounds(fit.nodes, closed);
      close({ x: b.x, y: b.y }, { x: 0, y: 0 });
      close({ x: b.width, y: b.height }, { x: fit.width, y: fit.height });
    }
  });

  it('a flat path gets a 1 px box with the line centred in it', () => {
    const fit = fitBoxToPath([{ x: 10, y: 50 }, { x: 90, y: 50 }], false, { x: 0, y: 0, width: 100, height: 100, rotation: 0, scale: 1 });
    expect(fit).toMatchObject({ x: 10, y: 49.5, width: 80, height: 1 });
    expect(fit.nodes).toEqual([{ x: 0, y: 0.5 }, { x: 80, y: 0.5 }]);
  });
});
