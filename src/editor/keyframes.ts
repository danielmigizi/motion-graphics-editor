// Keyframe editing behind the advanced timeline and the curve editor
// (Timeline.tsx, CurveEditor.tsx): which tracks an element animates, key
// selection refs, retime / delete / copy / paste as ordinary commands, and
// the easing-curve and value-graph math. Pure: no React, no store.
//
// A track is named the way the selection names it: a transform property
// ('x' | 'y' | 'rotation' | 'scale' | 'opacity') or a property-track key
// ('props.fontSize', 'effects.blur'). Key frames are element-relative.

import { evaluateKeyframes } from '../core/animation';
import { isValidColor } from '../core/validate';
import { COMPONENTS, type FieldDescriptor } from '../core/components';
import { CommandSchema } from '../core/schema';
import { ANIMATABLE_PROPERTIES } from '../core/types';
import type { AnimatableProperty, Command, CubicBezierEasing, Easing, EasingSpec, Element, ElementType } from '../core/types';
import { clamp } from './simpleTimelineEdits';

/** One selected key: its track and element-relative frame. */
export interface KeyRef {
  track: string;
  frame: number;
}

export interface AnyKeyframe {
  frame: number;
  value: number | string | boolean;
  easing: EasingSpec;
}

export type TrackKind = 'transform' | 'prop' | 'effect';

export interface TrackInfo {
  track: string;
  label: string;
  kind: TrackKind;
  /** Numeric values: the value graph applies. */
  numeric: boolean;
  /** Values blend between keys with the segment's easing (numbers, colours): the curve editor applies. Others hold. */
  eased: boolean;
  keyframes: readonly AnyKeyframe[];
}

export const TRANSFORM_LABELS: Record<AnimatableProperty, string> = {
  x: 'X position',
  y: 'Y position',
  rotation: 'Rotation',
  scale: 'Scale',
  opacity: 'Opacity',
};

export const EFFECT_KEYS = ['blur', 'brightness', 'contrast', 'saturate'] as const;
type EffectKey = (typeof EFFECT_KEYS)[number];
const EFFECT_LABELS: Record<EffectKey, string> = { blur: 'Blur', brightness: 'Brightness', contrast: 'Contrast', saturate: 'Saturation' };

export const isTransformTrack = (track: string): track is AnimatableProperty => (ANIMATABLE_PROPERTIES as readonly string[]).includes(track);
const isEffectKey = (key: string): key is EffectKey => (EFFECT_KEYS as readonly string[]).includes(key);

export const sameKey = (a: KeyRef, b: KeyRef) => a.track === b.track && a.frame === b.frame;
export const hasKey = (keys: readonly KeyRef[], k: KeyRef) => keys.some((x) => sameKey(x, k));
/** Shift-click: add the key, or take it out when already selected. */
export const toggleKey = (keys: readonly KeyRef[], k: KeyRef): KeyRef[] => (hasKey(keys, k) ? keys.filter((x) => !sameKey(x, k)) : [...keys, k]);

/** "trimStart" → "Trim start", for fields whose label is just their key. */
function humanize(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function propField(type: ElementType, track: string): FieldDescriptor | undefined {
  const [ns, key, extra] = track.split('.');
  return ns === 'props' && !extra ? COMPONENTS[type].fields.find((f) => f.key === key) : undefined;
}

export function trackKind(track: string): TrackKind {
  return isTransformTrack(track) ? 'transform' : track.startsWith('effects.') ? 'effect' : 'prop';
}

/** Timeline row label: transform names, the component field's label (components.ts), effect names. */
export function trackLabel(type: ElementType, track: string): string {
  if (isTransformTrack(track)) return TRANSFORM_LABELS[track];
  const key = track.slice(track.indexOf('.') + 1);
  if (trackKind(track) === 'effect') return isEffectKey(key) ? EFFECT_LABELS[key] : humanize(key);
  const label = propField(type, track)?.label ?? key;
  return label === key ? humanize(key) : label;
}

function isNumericTrack(type: ElementType, track: string): boolean {
  return trackKind(track) !== 'prop' || propField(type, track)?.kind === 'number';
}

function isEasedTrack(type: ElementType, track: string): boolean {
  const kind = propField(type, track)?.kind;
  return isNumericTrack(type, track) || kind === 'color' || kind === 'paint';
}

export function keyframesOf(element: Element, track: string): readonly AnyKeyframe[] {
  if (isTransformTrack(track)) return element.tracks.find((t) => t.property === track)?.keyframes ?? [];
  return element.propTracks?.find((t) => t.key === track)?.keyframes ?? [];
}

/** Every animated track of an element: transform tracks in property order, then property tracks. */
export function animatedTracks(element: Element): TrackInfo[] {
  const info = (track: string, keyframes: readonly AnyKeyframe[]): TrackInfo => ({
    track,
    label: trackLabel(element.type, track),
    kind: trackKind(track),
    numeric: isNumericTrack(element.type, track),
    eased: isEasedTrack(element.type, track),
    keyframes,
  });
  const out: TrackInfo[] = [];
  for (const p of ANIMATABLE_PROPERTIES) {
    const t = element.tracks.find((x) => x.property === p);
    if (t?.keyframes.length) out.push(info(p, t.keyframes));
  }
  for (const t of element.propTracks ?? []) if (t.keyframes.length) out.push(info(t.key, t.keyframes));
  return out;
}

/** Every keyed frame of an element (element-relative), unique and ascending. */
export function allKeyFrames(element: Element): number[] {
  const frames = new Set<number>();
  for (const t of animatedTracks(element)) for (const k of t.keyframes) frames.add(k.frame);
  return [...frames].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Whether core's setKeyframe accepts a cubic-bezier easing. The command
 * contract (core/types.ts, core/schema.ts) types setKeyframe's easing as a
 * named preset, while setPropertyKeyframe takes any EasingSpec; until core
 * widens setKeyframe, custom curves are offered on property tracks only and
 * transform tracks get the presets.
 */
export const transformCurvesSupported: boolean = CommandSchema.safeParse({
  type: 'setKeyframe',
  sceneId: 's',
  elementId: 'e',
  property: 'x',
  frame: 0,
  value: 0,
  easing: { type: 'cubicBezier', x1: 0.5, y1: 0, x2: 0.5, y2: 1 },
}).success;

/** Can this track's segments take a custom cubic-bezier curve? */
export const curvesAllowed = (track: string) => !isTransformTrack(track) || transformCurvesSupported;

/** Insert or replace one key: setKeyframe for transform tracks, setPropertyKeyframe otherwise. */
export function setKeyCommand(sceneId: string, elementId: string, track: string, frame: number, value: AnyKeyframe['value'], easing?: EasingSpec): Command {
  if (isTransformTrack(track)) {
    // A curve reaches setKeyframe only where `curvesAllowed` (see above), or
    // when retiming a curve that is already in the document.
    const e = easing === undefined ? {} : { easing: easing as Easing };
    return { type: 'setKeyframe', sceneId, elementId, property: track, frame, value: Number(value), ...e };
  }
  return { type: 'setPropertyKeyframe', sceneId, elementId, key: track, frame, value, ...(easing === undefined ? {} : { easing }) };
}

export function removeKeyCommand(sceneId: string, elementId: string, track: string, frame: number): Command {
  return isTransformTrack(track) ? { type: 'removeKeyframe', sceneId, elementId, property: track, frame } : { type: 'removePropertyKeyframe', sceneId, elementId, key: track, frame };
}

const findKey = (element: Element, ref: KeyRef) => keyframesOf(element, ref.track).find((k) => k.frame === ref.frame);

/** Keep only refs that still point at a key of the element. */
export const liveKeys = (element: Element, keys: readonly KeyRef[]) => keys.filter((k) => !!findKey(element, k));

/**
 * Clamp a retime so no selected key goes before frame 0, or further past the
 * element's last frame than the latest selected key already is.
 */
export function clampRetime(element: Element, keys: readonly KeyRef[], delta: number): number {
  if (!keys.length) return 0;
  const frames = keys.map((k) => k.frame);
  const lo = Math.min(...frames);
  const hi = Math.max(...frames);
  return clamp(Math.round(delta), -lo, Math.max(element.durationInFrames - 1, hi) - hi);
}

/**
 * Move the selected keys `delta` frames, as the commands of ONE batch: every
 * moved key is removed, then set at its new frame with its own value and
 * easing. Collision rule: a moved key landing on an unselected key replaces
 * it (the moved key wins). Selected keys keep their spacing, so they never
 * land on each other.
 */
export function retimeKeys(sceneId: string, element: Element, keys: readonly KeyRef[], delta: number): { commands: Command[]; keys: KeyRef[] } {
  const live = liveKeys(element, keys);
  const d = clampRetime(element, live, delta);
  if (!d) return { commands: [], keys: live };
  const removes: Command[] = [];
  const sets: Command[] = [];
  const next: KeyRef[] = [];
  for (const ref of live) {
    const k = findKey(element, ref)!;
    removes.push(removeKeyCommand(sceneId, element.id, ref.track, ref.frame));
    sets.push(setKeyCommand(sceneId, element.id, ref.track, ref.frame + d, k.value, k.easing));
    next.push({ track: ref.track, frame: ref.frame + d });
  }
  return { commands: [...removes, ...sets], keys: next };
}

export function deleteKeys(sceneId: string, element: Element, keys: readonly KeyRef[]): Command[] {
  return liveKeys(element, keys).map((k) => removeKeyCommand(sceneId, element.id, k.track, k.frame));
}

/** Copied keys, relative to the earliest one. */
export interface KeyClipboard {
  entries: { track: string; offset: number; value: AnyKeyframe['value']; easing: EasingSpec }[];
}

export function copyKeys(element: Element, keys: readonly KeyRef[]): KeyClipboard | null {
  const live = liveKeys(element, keys);
  if (!live.length) return null;
  const base = Math.min(...live.map((k) => k.frame));
  const entries = live
    .map((ref) => {
      const k = findKey(element, ref)!;
      return { track: ref.track, offset: ref.frame - base, value: k.value, easing: k.easing };
    })
    .sort((a, b) => a.offset - b.offset || a.track.localeCompare(b.track));
  return { entries };
}

/** Would `value` be a valid key of `track` on this element (same property must exist and accept it)? */
export function acceptsKey(element: Element, track: string, value: AnyKeyframe['value']): boolean {
  if (isTransformTrack(track)) return typeof value === 'number' && Number.isFinite(value);
  const [ns, key, extra] = track.split('.');
  if (extra) return false;
  if (ns === 'effects') return isEffectKey(key) && typeof value === 'number' && value >= 0 && value <= (key === 'blur' ? 200 : 3);
  const f = propField(element.type, track);
  if (ns !== 'props' || !f?.animatable) return false;
  switch (f.kind) {
    case 'number':
      return typeof value === 'number' && value >= f.min && value <= f.max;
    case 'color':
      return isValidColor(value);
    case 'paint':
      // Colour tracks cannot target a gradient or 'none' paint.
      return isValidColor(value) && isValidColor(element.props[key]);
    case 'boolean':
      return typeof value === 'boolean';
    case 'select':
      return f.options.some((o) => o.value === value);
    default:
      return typeof value === 'string';
  }
}

/**
 * Paste copied keys at element frame `at`, keeping their spacing, onto the
 * same properties of `element`. Keys the element cannot take (a property its
 * type lacks, a value out of range, a frame before 0) are skipped and counted.
 * Existing keys at the target frames are replaced.
 */
export function pasteKeys(sceneId: string, element: Element, clip: KeyClipboard, at: number): { commands: Command[]; keys: KeyRef[]; skipped: number } {
  const commands: Command[] = [];
  const keys: KeyRef[] = [];
  let skipped = 0;
  for (const e of clip.entries) {
    const frame = at + e.offset;
    if (frame < 0 || !acceptsKey(element, e.track, e.value)) {
      skipped++;
      continue;
    }
    commands.push(setKeyCommand(sceneId, element.id, e.track, frame, e.value, e.easing));
    keys.push({ track: e.track, frame });
  }
  return { commands, keys, skipped };
}

/** The segment that starts at a key: that key and the next one on its track. */
export function segmentAt(element: Element, ref: KeyRef): { from: AnyKeyframe; to: AnyKeyframe } | null {
  const keys = keyframesOf(element, ref.track);
  const i = keys.findIndex((k) => k.frame === ref.frame);
  return i >= 0 && i < keys.length - 1 ? { from: keys[i], to: keys[i + 1] } : null;
}

// ---------------------------------------------------------------------------
// Easing curves
// ---------------------------------------------------------------------------

export const EASING_LABELS: Record<Easing, string> = {
  linear: 'Linear',
  easeIn: 'Ease in',
  easeOut: 'Ease out',
  easeInOut: 'Ease in-out',
  backOut: 'Back out',
  easeInCubic: 'In cubic',
  easeOutCubic: 'Out cubic',
  easeInOutCubic: 'In-out cubic',
  easeOutExpo: 'Out expo',
  easeInOutExpo: 'In-out expo',
  hold: 'Hold',
};

const bez = (x1: number, y1: number, x2: number, y2: number): CubicBezierEasing => ({ type: 'cubicBezier', x1, y1, x2, y2 });

/** Cubic-bezier stand-ins for the named presets: where a handle drag starts from. Hold has none (it is a step). */
export const PRESET_BEZIERS: Record<Exclude<Easing, 'hold'>, CubicBezierEasing> = {
  linear: bez(0, 0, 1, 1),
  easeIn: bez(0.42, 0, 1, 1),
  easeOut: bez(0, 0, 0.58, 1),
  easeInOut: bez(0.42, 0, 0.58, 1),
  backOut: bez(0.34, 1.56, 0.64, 1),
  easeInCubic: bez(0.32, 0, 0.67, 0),
  easeOutCubic: bez(0.33, 1, 0.68, 1),
  easeInOutCubic: bez(0.65, 0, 0.35, 1),
  easeOutExpo: bez(0.16, 1, 0.3, 1),
  easeInOutExpo: bez(0.87, 0, 0.13, 1),
};

/** Presets that exist only as curves. */
export const CURVE_PRESETS: readonly { id: string; label: string; curve: CubicBezierEasing }[] = [
  // Overshoots past the target, dips back under it, settles.
  { id: 'bounce', label: 'Bounce-ish', curve: bez(0.3, 1.9, 0.5, 0.8) },
  // Pulls back below the start before leaving.
  { id: 'anticipate', label: 'Anticipate', curve: bez(0.5, -0.6, 0.7, 1) },
];

/** Editable range of handles (CSS cubic-bezier, as validated by core). */
export const CURVE_X: readonly [number, number] = [0, 1];
export const CURVE_Y: readonly [number, number] = [-2, 3];

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/** Clamp handles into the editable range and round to 3 decimals. */
export function clampBezier(b: CubicBezierEasing): CubicBezierEasing {
  return bez(r3(clamp(b.x1, CURVE_X[0], CURVE_X[1])), r3(clamp(b.y1, CURVE_Y[0], CURVE_Y[1])), r3(clamp(b.x2, CURVE_X[0], CURVE_X[1])), r3(clamp(b.y2, CURVE_Y[0], CURVE_Y[1])));
}

/** The curve a spec stands for (named presets via PRESET_BEZIERS), or null for hold. */
export function toBezier(spec: EasingSpec): CubicBezierEasing | null {
  if (typeof spec !== 'string') return spec;
  return spec === 'hold' ? null : PRESET_BEZIERS[spec];
}

export function sameEasing(a: EasingSpec, b: EasingSpec): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b;
  return a.x1 === b.x1 && a.y1 === b.y1 && a.x2 === b.x2 && a.y2 === b.y2;
}

export function easingLabel(spec: EasingSpec): string {
  if (typeof spec === 'string') return EASING_LABELS[spec];
  const preset = CURVE_PRESETS.find((p) => sameEasing(p.curve, spec));
  return preset ? preset.label : `Custom (${spec.x1}, ${spec.y1}, ${spec.x2}, ${spec.y2})`;
}

/** The curve box: x 0..1 across `width`; y from `yMax` at the top to `yMin` at the bottom. */
export interface CurveBox {
  width: number;
  height: number;
  yMin: number;
  yMax: number;
}

export function curveToPx(box: CurveBox, x: number, y: number): { px: number; py: number } {
  return { px: x * box.width, py: ((box.yMax - y) / (box.yMax - box.yMin)) * box.height };
}

export function pxToCurve(box: CurveBox, px: number, py: number): { x: number; y: number } {
  return { x: px / box.width, y: box.yMax - (py / box.height) * (box.yMax - box.yMin) };
}

/**
 * Drag handle 1 (from the start) or 2 (into the end) to a point in the box.
 * x clamps to 0..1; y clamps to -2..3, which may lie outside the visible
 * window (the editor then pins the handle to the edge with an overflow mark).
 */
export function dragHandle(b: CubicBezierEasing, handle: 1 | 2, px: number, py: number, box: CurveBox): CubicBezierEasing {
  const p = pxToCurve(box, px, py);
  return clampBezier(handle === 1 ? { ...b, x1: p.x, y1: p.y } : { ...b, x2: p.x, y2: p.y });
}

/** -1 below the visible window, 1 above it, 0 inside. */
export const curveOverflow = (box: CurveBox, y: number): -1 | 0 | 1 => (y < box.yMin ? -1 : y > box.yMax ? 1 : 0);

// ---------------------------------------------------------------------------
// Value graph (a numeric track's value over time)
// ---------------------------------------------------------------------------

export interface GraphBox {
  width: number;
  height: number;
  frameMin: number;
  frameMax: number;
  valueMin: number;
  valueMax: number;
}

/**
 * Frames and values a graph shows: the keyed span plus a margin (keys use
 * the width), and the curve's value range (overshoot included) plus a margin.
 */
export function graphRange(keys: readonly { frame: number; value: number; easing: EasingSpec }[]): Omit<GraphBox, 'width' | 'height'> {
  const first = keys.length ? keys[0].frame : 0;
  const last = keys.length ? keys[keys.length - 1].frame : 1;
  const margin = Math.max(4, Math.round((last - first) * 0.2));
  const frameMin = Math.max(0, first - margin);
  const frameMax = last + margin;
  let lo = Infinity;
  let hi = -Infinity;
  for (let f = frameMin; f <= frameMax; f++) {
    const v = evaluateKeyframes(keys, f, 0);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  // A flat track still gets a usable vertical range around its value.
  const pad = hi === lo ? Math.max(1, Math.abs(hi) * 0.5) : (hi - lo) * 0.14;
  return { frameMin, frameMax, valueMin: lo - pad, valueMax: hi + pad };
}

export function graphToPx(box: GraphBox, frame: number, value: number): { px: number; py: number } {
  return {
    px: ((frame - box.frameMin) / (box.frameMax - box.frameMin)) * box.width,
    py: ((box.valueMax - value) / (box.valueMax - box.valueMin)) * box.height,
  };
}

/** Value precision and limits per track when dragging in the graph. */
export function roundTrackValue(type: ElementType, track: string, value: number): number {
  if (isTransformTrack(track)) {
    if (track === 'x' || track === 'y' || track === 'rotation') return Math.round(value * 10) / 10;
    return Math.max(track === 'scale' ? 0.001 : 0, r3(value));
  }
  const key = track.slice(track.indexOf('.') + 1);
  if (trackKind(track) === 'effect') return clamp(Math.round(value * 100) / 100, 0, key === 'blur' ? 200 : 3);
  const f = propField(type, track);
  if (f?.kind !== 'number') return value;
  const decimals = f.integer ? 0 : Math.max(0, -Math.floor(Math.log10(f.step)));
  const p = 10 ** decimals;
  return clamp(Math.round(value * p) / p, f.min, f.max);
}

/**
 * Drag a graph key by (dx, dy) px: horizontal retimes (whole frames, kept
 * strictly between its neighbours so keys never swap or merge in the graph),
 * vertical changes the value. `lockAxis` keeps only the larger movement.
 */
export function dragGraphKey(
  type: ElementType,
  track: string,
  key: { frame: number; value: number },
  dx: number,
  dy: number,
  box: GraphBox,
  neighbours: { prev: number | null; next: number | null },
  lockAxis = false,
): { frame: number; value: number } {
  let ddx = dx;
  let ddy = dy;
  if (lockAxis) {
    if (Math.abs(dx) >= Math.abs(dy)) ddy = 0;
    else ddx = 0;
  }
  const framesPerPx = (box.frameMax - box.frameMin) / box.width;
  const valuePerPx = (box.valueMax - box.valueMin) / box.height;
  const lo = neighbours.prev === null ? 0 : neighbours.prev + 1;
  const hi = neighbours.next === null ? Infinity : neighbours.next - 1;
  const frame = clamp(Math.round(key.frame + ddx * framesPerPx), lo, hi);
  const value = ddy === 0 ? key.value : roundTrackValue(type, track, key.value - ddy * valuePerPx);
  return { frame, value };
}
