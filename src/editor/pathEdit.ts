// Node editing for path elements: pure geometry on PathNode lists. Nodes live
// in the element's own box (0..width, 0..height; handles absolute in the same
// space), segment i runs from node i to node i+1 (the last wraps to the first
// when the path is closed), and a missing handle sits on its node — the same
// reading as pathData() in src/core/path.ts. Every function returns new
// arrays; the editor turns one gesture's result into one updateElement.

import { elementMatrix, transformPoint, type Matrix } from '../core/animation';
import type { PathNode } from '../core/types';
import type { Point } from './geometry';

export type Cubic = [Point, Point, Point, Point];
export type HandleKey = 'in' | 'out';

const EPS = 1e-9;
const xy = (p: Point): Point => ({ x: p.x, y: p.y });
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const opposite = (k: HandleKey): HandleKey => (k === 'in' ? 'out' : 'in');

function cloneNode(n: PathNode): PathNode {
  const c: PathNode = { x: n.x, y: n.y };
  if (n.in) c.in = xy(n.in);
  if (n.out) c.out = xy(n.out);
  return c;
}

/** The node with handle `key` at `p`, or without it when `p` sits on the node (same geometry, tidier data). */
function withHandle(n: PathNode, key: HandleKey, p: Point | undefined): PathNode {
  const c = cloneNode(n);
  if (!p || dist(p, n) < EPS) delete c[key];
  else c[key] = xy(p);
  return c;
}

export const segmentCount = (n: number, closed: boolean) => (n < 2 ? 0 : closed ? n : n - 1);

/** Control points of segment `i`. */
export function segmentCubic(nodes: readonly PathNode[], i: number): Cubic {
  const a = nodes[i];
  const b = nodes[(i + 1) % nodes.length];
  return [xy(a), xy(a.out ?? a), xy(b.in ?? b), xy(b)];
}

export function cubicPoint([p0, p1, p2, p3]: Cubic, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

/** de Casteljau split at t: the two halves trace exactly the original curve. */
export function splitCubic([p0, p1, p2, p3]: Cubic, t: number): [Cubic, Cubic] {
  const q0 = lerp(p0, p1, t);
  const q1 = lerp(p1, p2, t);
  const q2 = lerp(p2, p3, t);
  const r0 = lerp(q0, q1, t);
  const r1 = lerp(q1, q2, t);
  const s = lerp(r0, r1, t);
  return [
    [p0, q0, r0, s],
    [s, r1, q2, p3],
  ];
}

/** Closest point of a cubic to `p`: coarse samples, then a ternary search round the best one. */
export function nearestOnCubic(c: Cubic, p: Point, samples = 48): { t: number; point: Point; dist: number } {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i <= samples; i++) {
    const d = dist(cubicPoint(c, i / samples), p);
    if (d < bestD) {
      bestD = d;
      best = i / samples;
    }
  }
  let lo = Math.max(0, best - 1 / samples);
  let hi = Math.min(1, best + 1 / samples);
  for (let k = 0; k < 40; k++) {
    const m1 = lo + (hi - lo) / 3;
    const m2 = hi - (hi - lo) / 3;
    if (dist(cubicPoint(c, m1), p) < dist(cubicPoint(c, m2), p)) hi = m2;
    else lo = m1;
  }
  const t = (lo + hi) / 2;
  const point = cubicPoint(c, t);
  return { t, point, dist: dist(point, p) };
}

/**
 * Insert a node on segment `segment` at cubic parameter t (as segmentCubic /
 * hitPath define it, for straight segments too) without changing the
 * shape: a straight segment gains a corner node on the line; a curve is split
 * by de Casteljau, so the neighbours' handles shorten and the new node gets
 * the collinear handles of the split point. Returns the new node's index.
 */
export function insertNode(nodes: readonly PathNode[], segment: number, t: number): { nodes: PathNode[]; index: number } {
  const n = nodes.length;
  const ai = segment;
  const bi = (segment + 1) % n;
  const a = nodes[ai];
  const b = nodes[bi];
  const out = nodes.map(cloneNode);
  let node: PathNode;
  if (!a.out && !b.in) {
    // t is the cubic parameter of [a, a, b, b] (what hitPath reports), not a linear fraction.
    node = cubicPoint(segmentCubic(nodes, segment), t);
  } else {
    const [l, r] = splitCubic(segmentCubic(nodes, segment), t);
    out[ai] = withHandle(out[ai], 'out', l[1]);
    out[bi] = withHandle(out[bi], 'in', r[2]);
    node = withHandle(withHandle(xy(l[3]), 'in', l[2]), 'out', r[1]);
  }
  const index = segment + 1;
  out.splice(index, 0, node);
  return { nodes: out, index };
}

/** Move the nodes at `indices` (with their handles) by d. */
export function moveNodes(nodes: readonly PathNode[], indices: readonly number[], d: Point): PathNode[] {
  const set = new Set(indices);
  const shift = (p: Point) => ({ x: p.x + d.x, y: p.y + d.y });
  return nodes.map((n, i) => {
    if (!set.has(i)) return cloneNode(n);
    const c: PathNode = shift(n);
    if (n.in) c.in = shift(n.in);
    if (n.out) c.out = shift(n.out);
    return c;
  });
}

export const translateNodes = (nodes: readonly PathNode[], d: Point) => moveNodes(nodes, nodes.map((_, i) => i), d);

/** Coordinates rounded to 0.01 px for the document (at most 0.005 px of drift). */
export function roundNodes(nodes: readonly PathNode[]): PathNode[] {
  const r = (v: number) => Math.round(v * 100) / 100;
  const rp = (p: Point) => ({ x: r(p.x), y: r(p.y) });
  return nodes.map((n) => {
    const c: PathNode = rp(n);
    if (n.in) c.in = rp(n.in);
    if (n.out) c.out = rp(n.out);
    return c;
  });
}

/** Every node and handle through an affine matrix (an affine image of a Bézier is the Bézier of the images). */
export function mapNodes(nodes: readonly PathNode[], m: Matrix): PathNode[] {
  return nodes.map((n) => {
    const c: PathNode = transformPoint(m, n);
    if (n.in) c.in = transformPoint(m, n.in);
    if (n.out) c.out = transformPoint(m, n.out);
    return c;
  });
}

/**
 * How a node's two handles are tied: 'mirror' (opposite, equal length),
 * 'collinear' (opposite, own lengths) or 'none' (a corner, or fewer than two
 * handles). Tolerances allow for coordinates rounded to 0.01 px.
 */
export function handleLink(n: PathNode): 'mirror' | 'collinear' | 'none' {
  if (!n.in || !n.out) return 'none';
  const a = { x: n.in.x - n.x, y: n.in.y - n.y };
  const b = { x: n.out.x - n.x, y: n.out.y - n.y };
  const la = Math.hypot(a.x, a.y);
  const lb = Math.hypot(b.x, b.y);
  if (la < 1e-6 || lb < 1e-6) return 'none';
  const cross = (a.x * b.y - a.y * b.x) / (la * lb);
  const dot = (a.x * b.x + a.y * b.y) / (la * lb);
  if (Math.abs(cross) > 2e-3 || dot > 0) return 'none';
  return Math.abs(la - lb) <= Math.max(0.02, 0.005 * Math.max(la, lb)) ? 'mirror' : 'collinear';
}

export const isSmooth = (n: PathNode) => handleLink(n) !== 'none';

/**
 * Drag one handle to `to`. A smooth node keeps its other handle opposite
 * (a mirrored pair keeps equal lengths, a collinear one keeps the other's
 * length); `broken` (Alt) moves this handle alone, making a corner.
 */
export function moveHandle(nodes: readonly PathNode[], index: number, key: HandleKey, to: Point, broken: boolean): PathNode[] {
  const out = nodes.map(cloneNode);
  const n = nodes[index];
  const link = broken ? 'none' : handleLink(n);
  let next = withHandle(n, key, to);
  const v = { x: to.x - n.x, y: to.y - n.y };
  const len = Math.hypot(v.x, v.y);
  const other = n[opposite(key)];
  if (link !== 'none' && other && len > EPS) {
    const l = link === 'mirror' ? len : dist(other, n);
    next = withHandle(next, opposite(key), { x: n.x - (v.x / len) * l, y: n.y - (v.y / len) * l });
  }
  out[index] = next;
  return out;
}

/** Pull symmetric handles out of a node (the pen's drag, Alt-drag on a node): `out` at p, `in` mirrored. */
export function pullHandles(nodes: readonly PathNode[], index: number, p: Point): PathNode[] {
  const out = nodes.map(cloneNode);
  const n = nodes[index];
  out[index] = withHandle(withHandle(n, 'out', p), 'in', { x: 2 * n.x - p.x, y: 2 * n.y - p.y });
  return out;
}

/**
 * Double-click: a smooth node becomes a corner (no handles); anything else
 * becomes smooth, with handles along the direction from the previous to the
 * next node, each a third of the way to its neighbour.
 */
export function toggleSmooth(nodes: readonly PathNode[], index: number, closed: boolean): PathNode[] {
  const out = nodes.map(cloneNode);
  const n = nodes[index];
  if (isSmooth(n)) {
    out[index] = { x: n.x, y: n.y };
    return out;
  }
  const count = nodes.length;
  const prev = index > 0 ? nodes[index - 1] : closed ? nodes[count - 1] : null;
  const next = index < count - 1 ? nodes[index + 1] : closed ? nodes[0] : null;
  let d = { x: (next ?? n).x - (prev ?? n).x, y: (next ?? n).y - (prev ?? n).y };
  let len = Math.hypot(d.x, d.y);
  if (len < EPS) {
    d = { x: 1, y: 0 };
    len = 1;
  }
  const u = { x: d.x / len, y: d.y / len };
  const lin = (prev ? dist(prev, n) : next ? dist(next, n) : 0) / 3;
  const lout = (next ? dist(next, n) : lin * 3) / 3;
  out[index] = withHandle(withHandle({ x: n.x, y: n.y }, 'in', { x: n.x - u.x * lin, y: n.y - u.y * lin }), 'out', { x: n.x + u.x * lout, y: n.y + u.y * lout });
  return out;
}

/** Remove the nodes at `indices`; null when fewer than two would remain. */
export function deleteNodes(nodes: readonly PathNode[], indices: readonly number[]): PathNode[] | null {
  const set = new Set(indices);
  const rest = nodes.filter((_, i) => !set.has(i)).map(cloneNode);
  return rest.length >= 2 ? rest : null;
}

/** Tab / Shift+Tab through the nodes from the last selected one. */
export function cycleNode(selected: readonly number[], count: number, dir: 1 | -1): number {
  if (count <= 0) return -1;
  const cur = selected.length ? selected[selected.length - 1] : -1;
  if (cur < 0) return dir > 0 ? 0 : count - 1;
  return (cur + dir + count) % count;
}

/** Indices of the nodes (already in screen space) inside an axis-aligned box. */
export function nodesInBox(nodes: readonly Point[], box: { left: number; top: number; right: number; bottom: number }): number[] {
  return nodes.flatMap((p, i) => (p.x >= box.left && p.x <= box.right && p.y >= box.top && p.y <= box.bottom ? [i] : []));
}

export type PathHit =
  | { kind: 'handle'; index: number; key: HandleKey }
  | { kind: 'node'; index: number }
  | { kind: 'segment'; segment: number; t: number; point: Point };

/**
 * What lies under `p`, with the path already in screen space. The nearest
 * node or shown handle within `radius` wins (a node on a tie); otherwise the
 * nearest segment within `segmentRadius`.
 */
export function hitPath(
  nodes: readonly PathNode[],
  closed: boolean,
  p: Point,
  shownHandles: readonly number[],
  radius: number,
  segmentRadius: number,
): PathHit | null {
  let best: PathHit | null = null;
  let bestD = radius;
  for (let index = 0; index < nodes.length; index++) {
    const d = dist(nodes[index], p);
    if (d <= bestD) {
      bestD = d;
      best = { kind: 'node', index };
    }
  }
  for (const index of shownHandles) {
    const n = nodes[index];
    if (!n) continue;
    for (const key of ['in', 'out'] as const) {
      const h = n[key];
      if (!h) continue;
      const d = dist(h, p);
      if (d < bestD) {
        bestD = d;
        best = { kind: 'handle', index, key };
      }
    }
  }
  if (best) return best;
  let seg: PathHit | null = null;
  let segD = segmentRadius;
  for (let i = 0; i < segmentCount(nodes.length, closed); i++) {
    const h = nearestOnCubic(segmentCubic(nodes, i), p);
    if (h.dist <= segD) {
      segD = h.dist;
      seg = { kind: 'segment', segment: i, t: h.t, point: h.point };
    }
  }
  return seg;
}

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Roots in (0, 1) of a·t² + b·t + c. */
function unitRoots(a: number, b: number, c: number): number[] {
  if (Math.abs(a) < 1e-12) return Math.abs(b) < 1e-12 ? [] : [-c / b].filter((t) => t > 0 && t < 1);
  const disc = b * b - 4 * a * c;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [(-b + s) / (2 * a), (-b - s) / (2 * a)].filter((t) => t > 0 && t < 1);
}

/** Exact bounds of the drawn curve (the cubics' extrema, not their control points). */
export function pathBounds(nodes: readonly PathNode[], closed: boolean): Bounds {
  if (!nodes.length) return { x: 0, y: 0, width: 0, height: 0 };
  const pts: Point[] = nodes.map(xy);
  for (let i = 0; i < segmentCount(nodes.length, closed); i++) {
    const c = segmentCubic(nodes, i);
    const [p0, p1, p2, p3] = c;
    for (const k of ['x', 'y'] as const) {
      // B'(t)/3 = a·t² + b·t + c
      const a = -p0[k] + 3 * p1[k] - 3 * p2[k] + p3[k];
      const b = 2 * (p0[k] - 2 * p1[k] + p2[k]);
      const cc = p1[k] - p0[k];
      for (const t of unitRoots(a, b, cc)) pts.push(cubicPoint(c, t));
    }
  }
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** The base box values a fit changes, plus the rotation and scale it keeps the picture still under. */
export interface BoxFrame {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scale: number;
}

/**
 * "Fit box to path": a new box hugging the curve (at least 1 px each way, the
 * path centred in a thin axis) and the nodes re-based into it, with x/y
 * chosen so the path stays where it is on screen. Rotation and scale act
 * round the box centre, so the centre moves by the rotated, scaled offset
 * between the old and new centres. Exact for the given rotation/scale.
 */
export function fitBoxToPath(nodes: readonly PathNode[], closed: boolean, box: BoxFrame): { x: number; y: number; width: number; height: number; nodes: PathNode[] } {
  const b = pathBounds(nodes, closed);
  const width = Math.max(1, b.width);
  const height = Math.max(1, b.height);
  const bx = b.x - (width - b.width) / 2;
  const by = b.y - (height - b.height) / 2;
  // Local offset from the old box centre to the new one, then through rotation and scale.
  const d = { x: bx + width / 2 - box.width / 2, y: by + height / 2 - box.height / 2 };
  const r = (box.rotation * Math.PI) / 180;
  const cos = Math.cos(r) * box.scale;
  const sin = Math.sin(r) * box.scale;
  const moved = { x: d.x * cos - d.y * sin, y: d.x * sin + d.y * cos };
  return {
    x: box.x + box.width / 2 + moved.x - width / 2,
    y: box.y + box.height / 2 + moved.y - height / 2,
    width,
    height,
    nodes: translateNodes(nodes, { x: -bx, y: -by }),
  };
}

/** Box pixels → parent pixels for a box frame (the composition's own matrix). */
export const frameMatrix = (f: BoxFrame): Matrix => elementMatrix({ ...f, active: true, localFrame: 0, opacity: 1 });
