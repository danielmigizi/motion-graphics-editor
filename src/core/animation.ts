// Deterministic animation evaluation shared by the composition (preview and
// export) and the editor (selection overlay, inspector). Pure functions of
// (element, frame) — no time, no randomness.

import { COMPONENTS } from './components';
import { interpolateColor } from './color';
import { ADDITIVE_PROPERTIES } from './types';
import type { AnimatableProperty, AnimationTrack, Easing, EasingSpec, Effects, Element, Keyframe } from './types';

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

// Cubic-bezier evaluation (CSS semantics) solved with Newton + bisection.
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const ax = 3 * x1 - 3 * x2 + 1;
  const bx = 3 * x2 - 6 * x1;
  const cx = 3 * x1;
  const ay = 3 * y1 - 3 * y2 + 1;
  const by = 3 * y2 - 6 * y1;
  const cy = 3 * y1;
  const sampleX = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  const sampleDX = (t: number) => (3 * ax * t + 2 * bx) * t + cx;
  return (x: number) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {
      const err = sampleX(t) - x;
      if (Math.abs(err) < 1e-6) return sampleY(t);
      const d = sampleDX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= err / d;
      if (t < 0 || t > 1) break;
    }
    let lo = 0;
    let hi = 1;
    t = x;
    for (let i = 0; i < 30; i++) {
      const v = sampleX(t);
      if (Math.abs(v - x) < 1e-6) break;
      if (v < x) lo = t;
      else hi = t;
      t = (lo + hi) / 2;
    }
    return sampleY(t);
  };
}

export const EASINGS: Record<Easing, (t: number) => number> = {
  linear: (t) => clamp01(t),
  easeIn: cubicBezier(0.42, 0, 1, 1),
  easeOut: cubicBezier(0, 0, 0.58, 1),
  easeInOut: cubicBezier(0.42, 0, 0.58, 1),
  backOut: cubicBezier(0.34, 1.56, 0.64, 1),
  easeInCubic: t => clamp01(t) ** 3,
  easeOutCubic: t => 1 - (1 - clamp01(t)) ** 3,
  easeInOutCubic: t => (t = clamp01(t)) < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2,
  easeOutExpo: t => t <= 0 ? 0 : t >= 1 ? 1 : 1 - 2 ** (-10 * t),
  easeInOutExpo: t => t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2,
  hold: t => t < 1 ? 0 : 1,
};

const bezierCache = new Map<string, (t: number) => number>();
export function easingFn(spec: EasingSpec): (t: number) => number {
  if (typeof spec === 'string') return EASINGS[spec];
  const key = [spec.x1, spec.y1, spec.x2, spec.y2].join(',');
  let fn = bezierCache.get(key);
  if (!fn) { fn = cubicBezier(spec.x1, spec.y1, spec.x2, spec.y2); bezierCache.set(key, fn); }
  return fn;
}

export const EASING_NAMES = Object.keys(EASINGS) as Easing[];

/** Neutral value of a track property: 0 offset for additive, factor 1 for multiplicative. */
export function neutralValue(property: AnimatableProperty): number {
  return ADDITIVE_PROPERTIES.includes(property) ? 0 : 1;
}

export function isAdditive(property: AnimatableProperty): boolean {
  return ADDITIVE_PROPERTIES.includes(property);
}

/** Value of a track at an element-relative frame. Holds first/last values outside the keyed range. */
export function evaluateKeyframes(keyframes: readonly Keyframe[], frame: number, fallback: number): number {
  if (keyframes.length === 0) return fallback;
  const first = keyframes[0];
  if (frame <= first.frame) return first.value;
  const last = keyframes[keyframes.length - 1];
  if (frame >= last.frame) return last.value;
  for (let i = 0; i < keyframes.length - 1; i++) {
    const a = keyframes[i];
    const b = keyframes[i + 1];
    if (frame >= a.frame && frame <= b.frame) {
      const span = b.frame - a.frame;
      const t = span === 0 ? 1 : (frame - a.frame) / span;
      const eased = easingFn(a.easing)(t);
      return a.value + (b.value - a.value) * eased;
    }
  }
  return last.value;
}

export function findTrack(element: Element, property: AnimatableProperty): AnimationTrack | undefined {
  return element.tracks.find((t) => t.property === property);
}

export function evaluateTrack(element: Element, property: AnimatableProperty, localFrame: number): number {
  const track = findTrack(element, property);
  return track ? evaluateKeyframes(track.keyframes, localFrame, neutralValue(property)) : neutralValue(property);
}

export interface EvaluatedElement {
  /** True when frameInScene is inside the element's lifetime and it is not hidden. */
  active: boolean;
  /** Element-relative frame (frameInScene - startFrame). May be out of range when inactive. */
  localFrame: number;
  /** Final composited values: base transform with animation applied. */
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  scale: number;
  opacity: number;
}

/** Final on-screen geometry and opacity of an element at a scene-relative frame. */
export function evaluateElement(element: Element, frameInScene: number): EvaluatedElement {
  const localFrame = frameInScene - element.startFrame;
  const inRange = localFrame >= 0 && localFrame < element.durationInFrames;
  const base = element.transform;
  const opacity = base.opacity * evaluateTrack(element, 'opacity', localFrame);
  return {
    active: element.visible && inRange,
    localFrame,
    x: base.x + evaluateTrack(element, 'x', localFrame),
    y: base.y + evaluateTrack(element, 'y', localFrame),
    width: base.width,
    height: base.height,
    rotation: base.rotation + evaluateTrack(element, 'rotation', localFrame),
    scale: base.scale * evaluateTrack(element, 'scale', localFrame),
    opacity: opacity < 0 ? 0 : opacity > 1 ? 1 : opacity,
  };
}

/**
 * Convert a desired final value at the playhead into the track value to key.
 * Used by "animate" mode: dragging an element at the playhead writes a
 * keyframe offset instead of moving the base layout.
 */
export function trackValueForFinal(element: Element, property: AnimatableProperty, finalValue: number): number {
  const base = element.transform[property];
  if (isAdditive(property)) return finalValue - base;
  return base === 0 ? 0 : finalValue / base;
}

/** Absolute property value; missing tracks fall back to the base property/effect. */
export function evaluatePropertyTrack(element: Element, key: string, localFrame: number): unknown {
  const [namespace, field] = key.split('.');
  const fallback = namespace === 'effects' ? element.effects?.[field as keyof Effects] ?? (field === 'blur' ? 0 : 1) : element.props[field];
  const frames = element.propTracks?.find(track => track.key === key)?.keyframes;
  if (!frames?.length) return fallback;
  if (localFrame <= frames[0].frame) return frames[0].value;
  if (localFrame >= frames[frames.length - 1].frame) return frames[frames.length - 1].value;
  const descriptor = COMPONENTS[element.type].fields.find(f => f.key === field);
  const isColor = namespace === 'props' && (descriptor?.kind === 'color' || descriptor?.kind === 'paint');
  for (let i = 0; i < frames.length - 1; i++) {
    const a = frames[i], b = frames[i + 1];
    if (localFrame === b.frame) return b.value;
    if (localFrame >= a.frame && localFrame < b.frame) {
      const t = easingFn(a.easing)((localFrame - a.frame) / (b.frame - a.frame));
      if ((namespace === 'effects' || descriptor?.kind === 'number') && typeof a.value === 'number' && typeof b.value === 'number') return a.value + (b.value - a.value) * t;
      if (isColor && typeof a.value === 'string' && typeof b.value === 'string') return interpolateColor(a.value, b.value, t) ?? a.value;
      return a.value;
    }
  }
  return fallback;
}

export function resolvedProps(element: Element, localFrame: number): Record<string, unknown> {
  const props = { ...element.props };
  for (const track of element.propTracks ?? []) if (track.key.startsWith('props.')) props[track.key.slice(6)] = evaluatePropertyTrack(element, track.key, localFrame);
  return props;
}

export function resolvedEffects(element: Element, localFrame: number): Effects {
  const effects = { ...element.effects };
  for (const track of element.propTracks ?? []) if (track.key.startsWith('effects.')) {
    const key = track.key.slice(8) as 'blur' | 'brightness' | 'contrast' | 'saturate';
    effects[key] = evaluatePropertyTrack(element, track.key, localFrame) as number;
  }
  return effects;
}

export type Matrix = [number, number, number, number, number, number];
export type WorldElement = EvaluatedElement & { worldMatrix: Matrix; parentChainActive: boolean };
export type Point = { x: number; y: number };
export function multiplyMatrices(a: Matrix, b: Matrix): Matrix {
  return [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
}
export function invertMatrix(m: Matrix): Matrix {
  const det = m[0]*m[3]-m[1]*m[2];
  if (Math.abs(det) < 1e-12) throw new Error('Cannot invert a zero-scale transform');
  return [m[3]/det,-m[1]/det,-m[2]/det,m[0]/det,(m[2]*m[5]-m[3]*m[4])/det,(m[1]*m[4]-m[0]*m[5])/det];
}
export function transformPoint(m: Matrix, p: Point): Point { return { x: m[0]*p.x+m[2]*p.y+m[4], y: m[1]*p.x+m[3]*p.y+m[5] }; }
/** Local matrix of an evaluated element: box pixels → its parent's pixels (rotation/scale about the box centre). */
export function elementMatrix(el: EvaluatedElement): Matrix {
  const rad = el.rotation * Math.PI / 180, a = Math.cos(rad)*el.scale, b = Math.sin(rad)*el.scale;
  return [a, b, -b, a, el.x+el.width/2-a*el.width/2+b*el.height/2, el.y+el.height/2-b*el.width/2-a*el.height/2];
}

/** Parent matrices map group-local coordinates into scene/composition pixels. */
export function evaluateElementWorld(elements: Element[], element: Element, frameInScene: number): WorldElement {
  const byId = new Map(elements.map(el => [el.id, el]));
  const visiting = new Set<string>();
  const evaluate = (el: Element): WorldElement => {
    if (visiting.has(el.id)) throw new Error('Parent cycle in world evaluation');
    visiting.add(el.id);
    const parent = el.parentId ? byId.get(el.parentId) : undefined;
    if (el.parentId && (!parent || parent.type !== 'group')) throw new Error('Missing parent group in world evaluation');
    const pw = parent ? evaluate(parent) : undefined;
    const local = evaluateElement(el, pw ? pw.localFrame : frameInScene);
    const worldMatrix = pw ? multiplyMatrices(pw.worldMatrix, elementMatrix(local)) : elementMatrix(local);
    const centre = transformPoint(worldMatrix, { x: local.width/2, y: local.height/2 });
    visiting.delete(el.id);
    return { ...local,
      // Parentless values are byte-for-byte the existing evaluator's values.
      x: pw ? centre.x-local.width/2 : local.x, y: pw ? centre.y-local.height/2 : local.y,
      rotation: local.rotation+(pw?.rotation ?? 0), scale: local.scale*(pw?.scale ?? 1),
      opacity: local.opacity*(pw?.opacity ?? 1), active: local.active && (pw?.active ?? true),
      worldMatrix, parentChainActive: pw?.active ?? true,
    };
  };
  return evaluate(element);
}

/** Clockwise corners, starting at local top-left, in scene/composition pixels. */
export function worldCorners(elements: Element[], element: Element, frameInScene: number): [Point, Point, Point, Point] {
  const { worldMatrix, width, height } = evaluateElementWorld(elements, element, frameInScene);
  return [{ x: 0, y: 0 }, { x: width, y: 0 }, { x: width, y: height }, { x: 0, y: height }].map(p => transformPoint(worldMatrix, p)) as [Point, Point, Point, Point];
}
