// Stage geometry in composition pixels, using the same evaluation the
// composition renders with: rotation + uniform scale around the element
// centre, and group children placed through their parents' matrices
// (evaluateElementWorld). Overlays and hit-testing read world geometry so
// children of rotated or scaled groups line up with the picture.

import { evaluateElementWorld, invertMatrix, transformPoint, type EvaluatedElement, type Matrix, type WorldElement } from '../core/animation';
import type { AnimatableProperty, Element, Project } from '../core/types';
import { childrenOf } from './canvasTree';
import type { Box } from './snap';

export interface Point {
  x: number;
  y: number;
}

export type Quad = [Point, Point, Point, Point];

const rad = (deg: number) => (deg * Math.PI) / 180;

export function rotate(p: Point, deg: number): Point {
  const c = Math.cos(rad(deg));
  const s = Math.sin(rad(deg));
  return { x: p.x * c - p.y * s, y: p.x * s + p.y * c };
}

export function centre(e: EvaluatedElement): Point {
  return { x: e.x + e.width / 2, y: e.y + e.height / 2 };
}

/** World geometry of an element at a scene frame (its own values when it has no parent). */
export function worldOf(elements: Element[], el: Element, frameInScene: number): WorldElement {
  return evaluateElementWorld(elements, el, frameInScene);
}

/** Clockwise corners from the local top-left, in composition pixels. */
export function cornersOf(w: WorldElement): Quad {
  return [
    { x: 0, y: 0 },
    { x: w.width, y: 0 },
    { x: w.width, y: w.height },
    { x: 0, y: w.height },
  ].map((p) => transformPoint(w.worldMatrix, p)) as Quad;
}

export function worldCentre(w: WorldElement): Point {
  return transformPoint(w.worldMatrix, { x: w.width / 2, y: w.height / 2 });
}

export function pointsBounds(points: readonly Point[]): Box {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

/** Is the point inside the element's (rotated, scaled) world box? */
export function containsWorld(w: WorldElement, p: Point): boolean {
  let inv: Matrix;
  try {
    inv = invertMatrix(w.worldMatrix);
  } catch {
    return false; // zero scale: nothing on screen to hit
  }
  const l = transformPoint(inv, p);
  return l.x >= 0 && l.x <= w.width && l.y >= 0 && l.y <= w.height;
}

/**
 * Deepest painted element under the point, in reverse paint order. Groups are
 * hit through their children (a clipped group only inside its box); mask
 * sources are never painted, so never hit; inactive subtrees are skipped.
 */
export function hitTestDeep(elements: Element[], frameInScene: number, p: Point): Element | null {
  const sources = new Set(elements.flatMap((e) => (e.mask ? [e.mask.sourceId] : [])));
  const visit = (parentId: string | null): Element | null => {
    const kids = childrenOf(elements, parentId);
    for (let i = kids.length - 1; i >= 0; i--) {
      const el = kids[i];
      if (sources.has(el.id)) continue;
      const w = worldOf(elements, el, frameInScene);
      if (!w.active) continue;
      if (el.type === 'group') {
        if (el.props.clip === true && !containsWorld(w, p)) continue;
        const hit = visit(el.id);
        if (hit) return hit;
      } else if (containsWorld(w, p)) return el;
    }
    return null;
  };
  return visit(null);
}

/** Do two convex polygons overlap (separating-axis test)? Touching counts. */
export function polygonsIntersect(a: readonly Point[], b: readonly Point[]): boolean {
  for (const poly of [a, b]) {
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const axis = { x: q.y - p.y, y: p.x - q.x };
      const project = (pts: readonly Point[]) => pts.map((v) => v.x * axis.x + v.y * axis.y);
      const pa = project(a);
      const pb = project(b);
      if (Math.max(...pa) < Math.min(...pb) || Math.max(...pb) < Math.min(...pa)) return false;
    }
  }
  return true;
}

export function boxQuad(b: Box): Quad {
  return [
    { x: b.left, y: b.top },
    { x: b.right, y: b.top },
    { x: b.right, y: b.bottom },
    { x: b.left, y: b.bottom },
  ];
}

/** Linear part of a matrix, inverted: maps a world-space vector into that space. */
export function inverseLinear(m: Matrix): Matrix {
  try {
    return invertMatrix([m[0], m[1], m[2], m[3], 0, 0]);
  } catch {
    return [1, 0, 0, 1, 0, 0];
  }
}

/** World → parent-local mapping for an element (identity at the top level). */
export function parentInverse(elements: Element[], el: Element, frameInScene: number): Matrix {
  const parent = el.parentId ? elements.find((e) => e.id === el.parentId) : undefined;
  if (!parent) return [1, 0, 0, 1, 0, 0];
  try {
    return invertMatrix(worldOf(elements, parent, frameInScene).worldMatrix);
  } catch {
    return [1, 0, 0, 1, 0, 0];
  }
}

/** A world-space displacement expressed in the parent's local axes (what the element's x/y must change by). */
export function vectorIn(m: Matrix, v: Point): Point {
  return { x: m[0] * v.x + m[2] * v.y, y: m[1] * v.x + m[3] * v.y };
}


/** Angle in (−180, 180]. */
export function normalizeAngle(deg: number): number {
  const a = ((((deg + 180) % 360) + 360) % 360) - 180;
  return a === -180 ? 180 : a;
}

/** Direction from `c` to `p` in degrees (0 = +x, clockwise on screen). */
export const angleOf = (c: Point, p: Point) => (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI;

/** Rotation after sweeping `swept` degrees from `start`; Shift snaps to 15° steps. */
export function rotationFor(start: number, swept: number, snap: boolean): number {
  const r = start + swept;
  return snap ? Math.round(r / 15) * 15 : round2(r);
}

/** Local preview only: insert/replace a keyframe on a copy of the element. */
export function withKeyframe(element: Element, property: AnimatableProperty, frame: number, value: number): Element {
  const tracks = element.tracks.map((t) => ({ ...t, keyframes: [...t.keyframes] }));
  let track = tracks.find((t) => t.property === property);
  if (!track) {
    track = { property, keyframes: [] };
    tracks.push(track);
  }
  const i = track.keyframes.findIndex((k) => k.frame === frame);
  if (i >= 0) track.keyframes[i] = { ...track.keyframes[i], value };
  else {
    track.keyframes.push({ frame, value, easing: 'easeInOut' });
    track.keyframes.sort((a, b) => a.frame - b.frame);
  }
  return { ...element, tracks };
}

/** Project with elements swapped for their transient drag previews. */
export function withTransient(project: Project, t: { sceneId: string; element: Element; others?: Element[] } | null): Project {
  if (!t) return project;
  const byId = new Map([t.element, ...(t.others ?? [])].map((e) => [e.id, e]));
  return {
    ...project,
    scenes: project.scenes.map((s) => (s.id !== t.sceneId ? s : { ...s, elements: s.elements.map((e) => byId.get(e.id) ?? e) })),
  };
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
