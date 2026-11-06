// The pen tool as pure steps over the open path being drawn. Points are in
// whatever space the caller draws in (the stage passes composition pixels so
// tolerances and the 45° constraint follow the screen); the finished path is
// mapped into its parent's space and given a box by penGeometry.

import type { PathNode } from '../core/types';
import type { Point } from './geometry';
import { pathBounds, pullHandles, roundNodes, translateNodes, type Cubic } from './pathEdit';

const STEP = Math.PI / 4;
const clean = (v: number) => Math.round(v * 1e12) / 1e12;

/** `to`, moved onto the nearest 45° ray from `from` (keeping its distance along that ray). */
export function constrain45(from: Point, to: Point): Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (!dx && !dy) return { x: to.x, y: to.y };
  const a = Math.round(Math.atan2(dy, dx) / STEP) * STEP;
  const ux = clean(Math.cos(a));
  const uy = clean(Math.sin(a));
  const l = dx * ux + dy * uy;
  return { x: from.x + ux * l, y: from.y + uy * l };
}

export interface PenOptions {
  /** How close (in the drawing space) a press must be to a node to hit it. */
  tolerance: number;
  /** Shift: 45° steps from the previous node (or round the node for a dragged handle). */
  constrain?: boolean;
}

export type PenPress =
  /** A new corner node at `index`. */
  | { action: 'add'; nodes: PathNode[]; index: number }
  /** The press is on the first node: the path closes (a drag shapes the first node's handles). */
  | { action: 'close'; nodes: PathNode[]; index: 0 }
  /** The press is on the last node (the second click of a double-click): nothing added; a drag re-pulls its handles. */
  | { action: 'none'; nodes: PathNode[]; index: number };

const near = (a: Point, b: Point, tol: number) => Math.hypot(a.x - b.x, a.y - b.y) <= tol;

/** One press of the pen at `p`. */
export function penPress(nodes: readonly PathNode[], p: Point, opts: PenOptions): PenPress {
  const last = nodes[nodes.length - 1];
  if (nodes.length >= 2 && near(nodes[0], p, opts.tolerance)) return { action: 'close', nodes: [...nodes], index: 0 };
  if (last && near(last, p, opts.tolerance)) return { action: 'none', nodes: [...nodes], index: nodes.length - 1 };
  const at = last && opts.constrain ? constrain45(last, p) : p;
  return { action: 'add', nodes: [...nodes, { x: at.x, y: at.y }], index: nodes.length };
}

/** Dragging after a press: node `index` becomes smooth with `out` at the pointer and `in` mirrored. */
export function penDrag(nodes: readonly PathNode[], index: number, p: Point, opts: Pick<PenOptions, 'constrain'> = {}): PathNode[] {
  const n = nodes[index];
  return pullHandles(nodes, index, opts.constrain ? constrain45(n, p) : p);
}

/** Backspace while drawing: drop the last node. */
export const penUndoPoint = (nodes: readonly PathNode[]): PathNode[] => nodes.slice(0, -1);

/** A drawn path can become an element once it has two nodes. */
export const penCanFinish = (nodes: readonly PathNode[]) => nodes.length >= 2;

/**
 * The live segment from the last node to the pointer: it leaves along the
 * last node's handle; over the first node (closing) it arrives along that
 * node's `in` handle.
 */
export function rubberBand(nodes: readonly PathNode[], pointer: Point, opts: PenOptions): { cubic: Cubic; closing: boolean } | null {
  const last = nodes[nodes.length - 1];
  if (!last) return null;
  const first = nodes[0];
  const start = { x: last.x, y: last.y };
  const lead = last.out ?? start;
  if (nodes.length >= 2 && near(first, pointer, opts.tolerance)) {
    return { cubic: [start, lead, first.in ?? first, { x: first.x, y: first.y }], closing: true };
  }
  const end = opts.constrain ? constrain45(last, pointer) : pointer;
  return { cubic: [start, lead, end, end], closing: false };
}

/**
 * Box and box-relative nodes for a finished path whose nodes are in its
 * parent's space: whole-pixel box edges round the curve (at least 1 px each
 * way), nodes re-based into it and rounded to 0.01 px.
 */
export function penGeometry(nodes: readonly PathNode[], closed: boolean): { x: number; y: number; width: number; height: number; nodes: PathNode[] } {
  const b = pathBounds(nodes, closed);
  const x = Math.floor(b.x);
  const y = Math.floor(b.y);
  const width = Math.max(1, Math.ceil(b.x + b.width) - x);
  const height = Math.max(1, Math.ceil(b.y + b.height) - y);
  return { x, y, width, height, nodes: roundNodes(translateNodes(nodes, { x: -x, y: -y })) };
}
