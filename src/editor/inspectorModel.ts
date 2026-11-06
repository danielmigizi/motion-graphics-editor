// Inspector model: pure derivations and command builders behind the
// inspector. Nothing here touches the store; every builder returns the ONE
// command (plus its undo label) a gesture commits, so the routing rules are
// testable without React.
//
// Base vs animated (the rule the inspector shows and enforces):
// - A field with no animation edits its BASE value (transform / props / effects).
// - A field with animation edits the value AT THE PLAYHEAD: it updates the
//   keyframe there, or creates one — never the base. Transform tracks store
//   offsets/factors (see types.ts), so a typed final value is converted with
//   trackValueForFinal().
// - Editing a base value never touches a track. Only "Remove animation"
//   (an explicit, confirmed action) deletes a whole track.

import { elementMatrix, evaluateElement, evaluatePropertyTrack, evaluateTrack, findTrack, neutralValue, trackValueForFinal, transformPoint } from '../core/animation';
import { interpolateColor, parseColor } from '../core/color';
import { COMPONENTS } from '../core/components';
import type { AnimatableProperty, Command, Easing, EasingSpec, Effects, Element, GradientStop, NestedComposition, Paint, Project } from '../core/types';
import { round2 } from './geometry';

// ---------------------------------------------------------------------------
// Animatable field references
// ---------------------------------------------------------------------------

export type EffectKey = 'blur' | 'brightness' | 'contrast' | 'saturate';
export const ANIMATABLE_EFFECTS: readonly EffectKey[] = ['blur', 'brightness', 'contrast', 'saturate'];
/** Value an effect has when it is not set (matches the renderer and evaluatePropertyTrack). */
export const EFFECT_DEFAULTS: Record<EffectKey, number> = { blur: 0, brightness: 1, contrast: 1, saturate: 1 };

export type FieldRef =
  | { kind: 'transform'; property: AnimatableProperty }
  | { kind: 'prop'; key: string }
  | { kind: 'effect'; key: EffectKey };

/** Base values a reset returns a transform field to. x / y have no meaningful default. */
const TRANSFORM_DEFAULTS: Partial<Record<AnimatableProperty, number>> = { rotation: 0, scale: 1, opacity: 1 };

/** 'x' for transform tracks, 'props.fontSize' / 'effects.blur' for property tracks. */
export function trackKeyOf(ref: FieldRef): string {
  return ref.kind === 'transform' ? ref.property : ref.kind === 'prop' ? `props.${ref.key}` : `effects.${ref.key}`;
}

export interface AnyKeyframe {
  frame: number;
  value: number | string | boolean;
  easing: EasingSpec;
}

export function keyframesOf(element: Element, ref: FieldRef): readonly AnyKeyframe[] {
  if (ref.kind === 'transform') return findTrack(element, ref.property)?.keyframes ?? [];
  const key = trackKeyOf(ref);
  return element.propTracks?.find((t) => t.key === key)?.keyframes ?? [];
}

/** ◇ none: not animated · ◆ key: a keyframe sits at the playhead · ◈ animated, between keys. */
export type KeyState = 'none' | 'key' | 'animated';

export function keyState(element: Element, ref: FieldRef, localFrame: number): KeyState {
  const frames = keyframesOf(element, ref);
  if (frames.length === 0) return 'none';
  return frames.some((k) => k.frame === localFrame) ? 'key' : 'animated';
}

export function inLifetime(element: Element, localFrame: number): boolean {
  return localFrame >= 0 && localFrame < element.durationInFrames;
}

/** Element-relative frame at a scene frame, through every parent group's start. */
export function localFrameOf(elements: readonly Element[], element: Element, frameInScene: number): number {
  let start = element.startFrame;
  const seen = new Set([element.id]);
  for (let p = element.parentId; p; ) {
    const parent = elements.find((e) => e.id === p);
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    start += parent.startFrame;
    p = parent.parentId;
  }
  return frameInScene - start;
}

/** The stored base value (transform / prop / effect, or the effect's neutral default). */
export function baseValueOf(element: Element, ref: FieldRef): unknown {
  if (ref.kind === 'transform') return element.transform[ref.property];
  if (ref.kind === 'prop') return element.props[ref.key];
  return element.effects?.[ref.key] ?? EFFECT_DEFAULTS[ref.key];
}

/** What the viewer sees at the playhead: base with animation applied (transforms are final values). */
export function valueAt(element: Element, ref: FieldRef, localFrame: number): unknown {
  if (ref.kind === 'transform') {
    const ev = evaluateElement(element, element.startFrame + localFrame);
    return ev[ref.property];
  }
  return evaluatePropertyTrack(element, trackKeyOf(ref), localFrame);
}

/** The raw value a new key at the playhead would store (track offset/factor for transforms). */
function trackValueAt(element: Element, ref: FieldRef, localFrame: number): number | string | boolean {
  if (ref.kind === 'transform') return round2(evaluateTrack(element, ref.property, localFrame));
  return evaluatePropertyTrack(element, trackKeyOf(ref), localFrame) as number | string | boolean;
}

// ---------------------------------------------------------------------------
// Command builders
// ---------------------------------------------------------------------------

export interface ElementTarget {
  sceneId: string;
  element: Element;
}

export interface Edit {
  command: Command;
  label: string;
}

const ids = (t: ElementTarget) => ({ sceneId: t.sceneId, elementId: t.element.id });

/** Set the BASE value. Never touches a track. */
export function baseEdit(t: ElementTarget, ref: FieldRef, value: unknown, label: string): Edit {
  const changes =
    ref.kind === 'transform'
      ? { transform: { [ref.property]: value as number } }
      : ref.kind === 'prop'
        ? { props: { [ref.key]: value } }
        : { effects: { [ref.key]: value as number } as Partial<Record<EffectKey, number>> };
  return { command: { type: 'updateElement', ...ids(t), changes }, label: `Set ${label}` };
}

function keyCommand(t: ElementTarget, ref: FieldRef, frame: number, value: number | string | boolean, easing?: EasingSpec): Command {
  if (ref.kind === 'transform') {
    return { type: 'setKeyframe', ...ids(t), property: ref.property, frame, value: value as number, ...(typeof easing === 'string' ? { easing } : {}) };
  }
  return { type: 'setPropertyKeyframe', ...ids(t), key: trackKeyOf(ref), frame, value, ...(easing !== undefined ? { easing } : {}) };
}

function unkeyCommand(t: ElementTarget, ref: FieldRef, frame: number): Command {
  if (ref.kind === 'transform') return { type: 'removeKeyframe', ...ids(t), property: ref.property, frame };
  return { type: 'removePropertyKeyframe', ...ids(t), key: trackKeyOf(ref), frame };
}

/**
 * The command for typing / scrubbing `value` into a field.
 * Not animated → base. Animated → key at the playhead (existing easing kept).
 * Returns null when the field is animated but the playhead is outside the
 * element's lifetime (there is no frame to key).
 */
export function routeEdit(t: ElementTarget, ref: FieldRef, value: unknown, localFrame: number, label: string): Edit | null {
  const state = keyState(t.element, ref, localFrame);
  if (state === 'none') return baseEdit(t, ref, value, label);
  if (!inLifetime(t.element, localFrame)) return null;
  const stored = ref.kind === 'transform' ? round2(trackValueForFinal(t.element, ref.property, value as number)) : (value as number | string | boolean);
  return { command: keyCommand(t, ref, localFrame, stored), label: `${state === 'key' ? 'Update' : 'Add'} ${label} keyframe` };
}

/** ◇/◈ → add a key at the playhead holding the current value; ◆ → remove that key. */
export function toggleKey(t: ElementTarget, ref: FieldRef, localFrame: number, label: string): Edit | null {
  if (!inLifetime(t.element, localFrame)) return null;
  if (keyState(t.element, ref, localFrame) === 'key') return { command: unkeyCommand(t, ref, localFrame), label: `Remove ${label} keyframe` };
  return { command: keyCommand(t, ref, localFrame, trackValueAt(t.element, ref, localFrame)), label: `Add ${label} keyframe` };
}

/**
 * Reset: an animated field goes back to its base at the playhead (key with
 * the neutral offset / the base value); a static field goes back to the
 * component default (effects: unset). Null when there is nothing to reset.
 */
export function resetEdit(t: ElementTarget, ref: FieldRef, localFrame: number, label: string): Edit | null {
  const el = t.element;
  if (keyState(el, ref, localFrame) !== 'none') {
    if (!inLifetime(el, localFrame)) return null;
    const target = ref.kind === 'transform' ? neutralValue(ref.property) : (baseValueOf(el, ref) as number | string | boolean);
    if (trackValueAt(el, ref, localFrame) === target) return null;
    return { command: keyCommand(t, ref, localFrame, target), label: `Reset ${label} to base at playhead` };
  }
  if (ref.kind === 'transform') {
    const def = TRANSFORM_DEFAULTS[ref.property];
    if (def === undefined || el.transform[ref.property] === def) return null;
    return { command: { type: 'updateElement', ...ids(t), changes: { transform: { [ref.property]: def } } }, label: `Reset ${label}` };
  }
  if (ref.kind === 'prop') {
    const def = COMPONENTS[el.type].defaultProps[ref.key];
    if (def === undefined || JSON.stringify(def) === JSON.stringify(el.props[ref.key])) return null;
    return { command: { type: 'updateElement', ...ids(t), changes: { props: { [ref.key]: def } } }, label: `Reset ${label}` };
  }
  if (el.effects?.[ref.key] === undefined) return null;
  return { command: { type: 'updateElement', ...ids(t), changes: { effects: { [ref.key]: null } } }, label: `Reset ${label}` };
}

/** Remove one keyframe (the track goes when its last key does). */
export function removeKeyEdit(t: ElementTarget, ref: FieldRef, frame: number, label: string): Edit | null {
  if (!keyframesOf(t.element, ref).some((k) => k.frame === frame)) return null;
  return { command: unkeyCommand(t, ref, frame), label: `Remove ${label} keyframe` };
}

/** Delete the field's whole track (every keyframe) in one undo step. */
export function removeAnimation(t: ElementTarget, ref: FieldRef, label: string): Edit | null {
  const frames = keyframesOf(t.element, ref);
  if (!frames.length) return null;
  const name = `Remove ${label} animation`;
  return { command: { type: 'batch', label: name, commands: frames.map((k) => unkeyCommand(t, ref, k.frame)) }, label: name };
}

/** Switch one keyframe's easing to a named preset (value unchanged). */
export function easingEdit(t: ElementTarget, ref: FieldRef, frame: number, easing: Easing, label: string): Edit | null {
  const k = keyframesOf(t.element, ref).find((kf) => kf.frame === frame);
  if (!k || k.easing === easing) return null;
  return { command: keyCommand(t, ref, frame, k.value, easing), label: `Set ${label} easing` };
}

/** "cubic-bezier(0.42, 0, 0.58, 1)" for a custom curve; the preset name otherwise. */
export function easingText(spec: EasingSpec): string {
  if (typeof spec === 'string') return spec;
  return `cubic-bezier(${[spec.x1, spec.y1, spec.x2, spec.y2].map((n) => round2(n)).join(', ')})`;
}

/** Element with one field set to a value — used for the live (transient) preview of a scrub. */
export function previewElement(element: Element, ref: FieldRef, value: unknown, localFrame: number): Element {
  const state = keyState(element, ref, localFrame);
  if (state === 'none') {
    if (ref.kind === 'transform') return { ...element, transform: { ...element.transform, [ref.property]: value as number } };
    if (ref.kind === 'prop') return { ...element, props: { ...element.props, [ref.key]: value } };
    return { ...element, effects: { ...element.effects, [ref.key]: value as number } as Effects };
  }
  if (!inLifetime(element, localFrame)) return element;
  if (ref.kind === 'transform') {
    const stored = trackValueForFinal(element, ref.property, value as number);
    return {
      ...element,
      tracks: element.tracks.map((tr) => (tr.property !== ref.property ? tr : { ...tr, keyframes: upsertKey(tr.keyframes, localFrame, stored) })),
    };
  }
  const key = trackKeyOf(ref);
  return {
    ...element,
    propTracks: (element.propTracks ?? []).map((tr) => (tr.key !== key ? tr : { ...tr, keyframes: upsertKey(tr.keyframes, localFrame, value as number | string | boolean) })),
  };
}

function upsertKey<K extends { frame: number; value: V; easing: EasingSpec }, V>(keys: readonly K[], frame: number, value: V): K[] {
  const i = keys.findIndex((k) => k.frame === frame);
  if (i >= 0) return keys.map((k, j) => (j === i ? { ...k, value } : k));
  return [...keys, { frame, value, easing: 'easeInOut' } as K].sort((a, b) => a.frame - b.frame);
}

// ---------------------------------------------------------------------------
// Paint (solid / linear / radial)
// ---------------------------------------------------------------------------

export type PaintKind = 'none' | 'solid' | 'linear' | 'radial';
export type GradientPaint = Exclude<Paint, string>;

export function paintKind(paint: Paint): PaintKind {
  if (typeof paint !== 'string') return paint.type;
  return paint === 'none' ? 'none' : 'solid';
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, '0').toUpperCase();

/** '#RRGGBB' (or '#RRGGBBAA' when not opaque) for any colour parseColor reads; null otherwise. */
export function colorToHex(color: string): string | null {
  const c = parseColor(color);
  if (!c) return null;
  const [r, g, b, a] = c;
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ''}`;
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

/**
 * Canonical paint: colours as upper-case hex, gradient stops clamped to 0..1,
 * rounded, sorted (stable) and at least two; linear angle in [0, 360).
 */
export function normalizePaint(paint: Paint): Paint {
  if (typeof paint === 'string') return paint === 'none' ? paint : (colorToHex(paint) ?? paint);
  let stops: GradientStop[] = paint.stops
    .map((s, i) => ({ s: { offset: round3(clamp01(Number.isFinite(s.offset) ? s.offset : 0)), color: colorToHex(s.color) ?? s.color }, i }))
    .sort((a, b) => a.s.offset - b.s.offset || a.i - b.i)
    .map((x) => x.s);
  if (stops.length === 0) stops = [{ offset: 0, color: '#FFFFFF' }, { offset: 1, color: '#FFFFFF00' }];
  else if (stops.length === 1) stops = [{ ...stops[0], offset: 0 }, { ...stops[0], offset: 1 }];
  if (paint.type === 'radial') return { type: 'radial', stops };
  const angle = round2((((paint.angle % 360) + 360) % 360) || 0);
  return { type: 'linear', angle, stops };
}

/** Same colour at zero alpha ('#3B82F6' → '#3B82F600'). */
function transparentOf(color: string): string {
  const hex = colorToHex(color) ?? '#FFFFFF';
  return `${hex.slice(0, 7)}00`;
}

/**
 * Convert between paint kinds keeping as much as possible: a colour becomes a
 * colour → transparent gradient; a gradient's first stop becomes the solid
 * colour; linear ↔ radial keeps the stops.
 */
export function convertPaint(paint: Paint, to: PaintKind, fallbackColor = '#FFFFFF'): Paint {
  const from = paintKind(paint);
  if (from === to) return paint;
  if (to === 'none') return 'none';
  const solid = typeof paint === 'string' ? (paint === 'none' ? fallbackColor : paint) : (paint.stops[0]?.color ?? fallbackColor);
  if (to === 'solid') return colorToHex(solid) ?? solid;
  const stops: GradientStop[] =
    typeof paint === 'string' ? [{ offset: 0, color: colorToHex(solid) ?? solid }, { offset: 1, color: transparentOf(solid) }] : paint.stops;
  return normalizePaint(to === 'linear' ? { type: 'linear', angle: typeof paint !== 'string' && paint.type === 'linear' ? paint.angle : 90, stops } : { type: 'radial', stops });
}

/** Colour of a (sorted) gradient at an offset, as hex. */
export function gradientColorAt(paint: GradientPaint, offset: number): string {
  const stops = paint.stops;
  if (offset <= stops[0].offset) return colorToHex(stops[0].color) ?? stops[0].color;
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];
    if (offset <= b.offset) {
      const t = b.offset === a.offset ? 0 : (offset - a.offset) / (b.offset - a.offset);
      return colorToHex(interpolateColor(a.color, b.color, t) ?? a.color) ?? a.color;
    }
  }
  const last = stops[stops.length - 1];
  return colorToHex(last.color) ?? last.color;
}

/**
 * Insert a stop at `offset` (default: the middle of the widest gap), coloured
 * as the gradient already is there, so adding a stop never changes the look.
 */
export function addStop(paint: GradientPaint, offset?: number): { paint: GradientPaint; index: number } {
  const p = normalizePaint(paint) as GradientPaint;
  let at = offset;
  if (at === undefined) {
    let best = 0;
    for (let i = 1; i < p.stops.length - 1; i++) if (p.stops[i + 1].offset - p.stops[i].offset > p.stops[best + 1].offset - p.stops[best].offset) best = i;
    at = (p.stops[best].offset + p.stops[best + 1].offset) / 2;
  }
  const stop = { offset: round3(clamp01(at)), color: gradientColorAt(p, at) };
  const index = p.stops.filter((s) => s.offset <= stop.offset).length;
  return { paint: { ...p, stops: [...p.stops.slice(0, index), stop, ...p.stops.slice(index)] }, index };
}

/** Remove a stop; a gradient keeps at least two. */
export function removeStop(paint: GradientPaint, index: number): GradientPaint {
  if (paint.stops.length <= 2 || index < 0 || index >= paint.stops.length) return paint;
  return { ...paint, stops: paint.stops.filter((_, i) => i !== index) };
}

/** Move one stop; returns where that stop ended up after re-sorting. */
export function moveStop(paint: GradientPaint, index: number, offset: number): { paint: GradientPaint; index: number } {
  const marked = paint.stops.map((s, i) => ({ s: i === index ? { ...s, offset: round3(clamp01(offset)) } : s, mine: i === index }));
  const sorted = marked.map((m, i) => ({ ...m, i })).sort((a, b) => a.s.offset - b.s.offset || (a.mine ? -1 : b.mine ? 1 : a.i - b.i));
  return { paint: { ...paint, stops: sorted.map((m) => m.s) }, index: sorted.findIndex((m) => m.mine) };
}

export function setStop(paint: GradientPaint, index: number, change: Partial<GradientStop>): GradientPaint {
  return { ...paint, stops: paint.stops.map((s, i) => (i === index ? { ...s, ...change } : s)) };
}

// ---------------------------------------------------------------------------
// Masks
// ---------------------------------------------------------------------------

/** Shapes / paths that may mask `element`: same parent, not itself, not masked themselves. */
export function maskSources(elements: readonly Element[], element: Element): Element[] {
  return elements.filter((e) => e.id !== element.id && (e.type === 'shape' || e.type === 'path') && e.parentId === element.parentId && !e.mask);
}

/** Elements that use `element` as their mask source (it then cannot be masked itself). */
export function maskedBy(elements: readonly Element[], element: Element): Element[] {
  return elements.filter((e) => e.mask?.sourceId === element.id);
}

// ---------------------------------------------------------------------------
// Make reusable component from a group
// ---------------------------------------------------------------------------

export interface ComponentIds {
  compositionId: string;
  instanceId: string;
  /** New id for each copied descendant. */
  elementId: (oldId: string) => string;
}

export interface ComponentFromGroup {
  command: Command;
  label: string;
  compositionId: string;
  instanceId: string;
  /** Some child sticks out of the group box; the instance clips to it. */
  overhang: boolean;
}

/**
 * One batch: add a composition holding copies (new ids) of the group's whole
 * subtree — direct children become top-level, positions stay relative to the
 * group box, frame 0 is the group's start — then replace the group with an
 * instance of it at the same slot, transform, timing, animation and look.
 */
export function componentFromGroup(project: Project, sceneId: string, groupId: string, newIds: ComponentIds): ComponentFromGroup | { error: string } {
  const scene = project.scenes.find((s) => s.id === sceneId);
  if (!scene) return { error: 'Scene not found.' };
  if (scene.locked) return { error: `“${scene.name}” is approved — unlock it to make a component.` };
  const group = scene.elements.find((e) => e.id === groupId);
  if (!group || group.type !== 'group') return { error: 'Select a group to make a component from it.' };

  const subtree = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const e of scene.elements) if (e.parentId && (e.parentId === groupId || subtree.has(e.parentId)) && !subtree.has(e.id)) {
      subtree.add(e.id);
      grew = true;
    }
  }
  if (!subtree.size) return { error: 'This group is empty.' };
  const late = scene.elements.find((e) => e.parentId === groupId && e.startFrame >= group.durationInFrames);
  if (late) return { error: `“${late.name}” starts after the group ends, so it never shows — move or delete it first.` };

  const remap = new Map([...subtree].map((id) => [id, newIds.elementId(id)]));
  const copies: Element[] = scene.elements
    .filter((e) => subtree.has(e.id))
    .map((e) => {
      const copy: Element = structuredClone(e);
      copy.id = remap.get(e.id)!;
      if (e.parentId === groupId) {
        // Top level in the composition: must end inside it. The group already
        // clipped the child to its own lifetime, so this changes nothing on screen.
        delete copy.parentId;
        copy.durationInFrames = Math.min(e.durationInFrames, group.durationInFrames - e.startFrame);
      } else if (e.parentId) copy.parentId = remap.get(e.parentId);
      if (e.mask) copy.mask = { ...e.mask, sourceId: remap.get(e.mask.sourceId) ?? e.mask.sourceId };
      return copy;
    });

  const { width, height } = group.transform;
  const composition: NestedComposition = {
    id: newIds.compositionId,
    name: group.name,
    width: Math.max(1, Math.round(width)),
    height: Math.max(1, Math.round(height)),
    durationInFrames: group.durationInFrames,
    backgroundColor: 'transparent',
    elements: copies,
  };

  // Effect tracks (and any prop track the instance can also animate) carry over,
  // so the instance looks the same as the group at every frame.
  const propTracks = (group.propTracks ?? []).filter((t) => {
    const [namespace, field] = t.key.split('.');
    return namespace === 'effects' || (namespace === 'props' && !!COMPONENTS.instance.fields.find((f) => f.key === field)?.animatable);
  });

  const instance: Element = {
    id: newIds.instanceId,
    type: 'instance',
    name: group.name,
    startFrame: group.startFrame,
    durationInFrames: group.durationInFrames,
    visible: group.visible,
    transform: { ...group.transform },
    props: { ...COMPONENTS.instance.defaultProps, compositionId: composition.id },
    tracks: structuredClone(group.tracks),
    ...(propTracks.length ? { propTracks: structuredClone(propTracks) } : {}),
    ...(group.parentId ? { parentId: group.parentId } : {}),
    ...(group.blendMode ? { blendMode: group.blendMode } : {}),
    ...(group.effects ? { effects: structuredClone(group.effects) } : {}),
    ...(group.mask ? { mask: { ...group.mask } } : {}),
  };

  const groupIndex = scene.elements.indexOf(group);
  const index = scene.elements.slice(0, groupIndex).filter((e) => !subtree.has(e.id)).length;
  const overhang = scene.elements.some((e) => {
    if (e.parentId !== groupId) return false;
    const m = elementMatrix(evaluateElement(e, e.startFrame));
    const { width: w, height: h } = e.transform;
    return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }].some((c) => {
      const p = transformPoint(m, c);
      return p.x < -0.5 || p.y < -0.5 || p.x > width + 0.5 || p.y > height + 0.5;
    });
  });

  const label = `Make component “${group.name}”`;
  return {
    command: {
      type: 'batch',
      label,
      commands: [
        { type: 'addComposition', composition },
        { type: 'removeElement', sceneId, elementId: groupId },
        { type: 'addElement', sceneId, element: instance, index },
      ],
    },
    label,
    compositionId: composition.id,
    instanceId: instance.id,
    overhang,
  };
}
