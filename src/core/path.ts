// Pure path geometry shared by the renderer (PathElement, mask mattes) and the
// editor's path tool. Coordinates are the element's own box pixels.

import type { PathNode } from './types';

/** Fixed-precision number for SVG strings: deterministic, no exponent, no "-0". */
export function svgNumber(n: number, digits = 3): string {
  const f = 10 ** digits;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? '0' : String(r);
}

const pt = (p: { x: number; y: number }) => `${svgNumber(p.x)} ${svgNumber(p.y)}`;

function segment(a: PathNode, b: PathNode): string {
  // A segment is cubic when either end has a handle; a missing handle sits on its node.
  return a.out || b.in ? `C${pt(a.out ?? a)} ${pt(b.in ?? b)} ${pt(b)}` : `L${pt(b)}`;
}

/**
 * SVG path data for box-relative nodes. Each segment uses the start node's
 * `out` handle and the end node's `in` handle (cubic), or is straight when
 * both are absent. `closed` adds the segment from the last node back to the
 * first, then `Z`.
 */
export function pathData(nodes: readonly PathNode[], closed: boolean): string {
  if (nodes.length === 0) return '';
  const parts = [`M${pt(nodes[0])}`];
  for (let i = 1; i < nodes.length; i++) parts.push(segment(nodes[i - 1], nodes[i]));
  if (closed && nodes.length > 1) {
    const last = nodes[nodes.length - 1];
    if (last.out || nodes[0].in) parts.push(segment(last, nodes[0]));
    parts.push('Z');
  }
  return parts.join(' ');
}

/** Bounding box of every node and handle (a bound for the curve: Béziers stay inside their control hull). */
export function pathControlBounds(nodes: readonly PathNode[]): { x: number; y: number; width: number; height: number } {
  const points = nodes.flatMap((n) => [n, n.in, n.out].filter((p): p is { x: number; y: number } => !!p));
  if (points.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

export type TrimDash =
  /** Nothing of the stroke is visible. */
  | { visible: false }
  /** Stroke visible; with a dash when only part of it is. Values are fractions of a pathLength of 1. */
  | { visible: true; dashArray?: string; dashOffset?: string };

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);
const EPS = 1e-6;

/**
 * Stroke dash for trim paths, for an SVG path drawn with `pathLength={1}`.
 * The visible run is [min(start, end), max(start, end)] shifted by `offset`
 * along the path; it wraps past the end back to the start (the dash pattern
 * repeats with period 1, so the wrapped part is drawn by the previous period).
 */
export function trimDash(trimStart: number, trimEnd: number, trimOffset: number): TrimDash {
  const lo = clamp01(Math.min(trimStart, trimEnd));
  const hi = clamp01(Math.max(trimStart, trimEnd));
  const length = hi - lo;
  if (length <= EPS) return { visible: false };
  if (length >= 1 - EPS) return { visible: true };
  const start = (((lo + trimOffset) % 1) + 1) % 1;
  // 6 digits: a fraction of pathLength 1 must stay sub-pixel on long paths.
  return { visible: true, dashArray: `${svgNumber(length, 6)} ${svgNumber(1 - length, 6)}`, dashOffset: svgNumber(-start, 6) };
}
