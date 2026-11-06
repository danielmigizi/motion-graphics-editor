// Snapping for canvas drags: the moving selection's edges and centre snap to
// the canvas edges and centre and to other elements' edges and centres. Pure
// math in composition pixels; the stage passes a zoom-aware threshold
// (6 screen px ÷ zoom) and draws the returned guides.

/** Axis-aligned bounds in composition pixels. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** A guide line: vertical at x = `at` (axis 'x') or horizontal at y = `at` (axis 'y'), drawn from → to along the other axis. */
export interface Guide {
  axis: 'x' | 'y';
  at: number;
  from: number;
  to: number;
}

export interface SnapResult {
  /** Correction to add to the raw drag delta. */
  dx: number;
  dy: number;
  guides: Guide[];
}

/** Screen pixels within which an edge or centre snaps. */
export const SNAP_PX = 6;

const xs = (b: Box) => [b.left, (b.left + b.right) / 2, b.right];
const ys = (b: Box) => [b.top, (b.top + b.bottom) / 2, b.bottom];

/** The closest candidate on one axis: the offset that lands a moving line on it, or null when none is within threshold. */
function bestOffset(moving: number[], targets: Box[], lines: (b: Box) => number[], threshold: number): number | null {
  let best: number | null = null;
  for (const t of targets) {
    for (const c of lines(t)) {
      for (const m of moving) {
        const d = c - m;
        if (Math.abs(d) <= threshold && (best === null || Math.abs(d) < Math.abs(best))) best = d;
      }
    }
  }
  return best;
}

/**
 * Snap `moving` (already offset by the raw drag delta) to `targets` (include
 * the canvas as a box to snap to its edges and centre). Each axis snaps on its
 * own to the nearest line within `threshold`. Guides span the moving box and
 * every target box that lines up after the correction.
 */
export function snapMove(moving: Box, targets: Box[], threshold: number): SnapResult {
  const ox = bestOffset(xs(moving), targets, xs, threshold);
  const oy = bestOffset(ys(moving), targets, ys, threshold);
  const dx = ox ?? 0;
  const dy = oy ?? 0;
  const m: Box = { left: moving.left + dx, right: moving.right + dx, top: moving.top + dy, bottom: moving.bottom + dy };
  const guides: Guide[] = [];
  const add = (axis: 'x' | 'y', at: number, from: number, to: number) => {
    const g = guides.find((x) => x.axis === axis && Math.abs(x.at - at) < 0.01);
    if (g) {
      g.from = Math.min(g.from, from);
      g.to = Math.max(g.to, to);
    } else guides.push({ axis, at, from, to });
  };
  for (const t of targets) {
    if (ox !== null) for (const c of xs(t)) if (xs(m).some((v) => Math.abs(v - c) < 0.01)) add('x', c, Math.min(m.top, t.top), Math.max(m.bottom, t.bottom));
    if (oy !== null) for (const c of ys(t)) if (ys(m).some((v) => Math.abs(v - c) < 0.01)) add('y', c, Math.min(m.left, t.left), Math.max(m.right, t.right));
  }
  return { dx, dy, guides };
}

export function boxUnion(boxes: Box[]): Box {
  return {
    left: Math.min(...boxes.map((b) => b.left)),
    top: Math.min(...boxes.map((b) => b.top)),
    right: Math.max(...boxes.map((b) => b.right)),
    bottom: Math.max(...boxes.map((b) => b.bottom)),
  };
}

export const offsetBox = (b: Box, dx: number, dy: number): Box => ({ left: b.left + dx, top: b.top + dy, right: b.right + dx, bottom: b.bottom + dy });
