// Pure logic behind the simple timeline (SimpleTimeline.tsx): frames ↔ px,
// clamping, snapping, trim-to-playhead, scene-length limits, and turning a
// finished drag into exactly one command with a human label.
//
// Frame conventions (same as core): element frames are relative to their
// scene's start; anchored audio clips (sceneId set) are relative to their
// scene, the music bed is absolute. Ends are exclusive (start + duration).

import type { AudioClip, Command, Element, Project, Scene } from '../core/types';
import { trimEnvelope } from '../core/audioDucking';
import { videoSpanChanges } from './videoEdits';

export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Pixel distance within which an edge snaps to a target. */
export const SNAP_PX = 8;

/** Convert a horizontal pixel delta to whole frames at the current fit-to-width scale. */
export function pxToFrames(dxPx: number, totalFrames: number, widthPx: number): number {
  if (widthPx <= 0) return 0;
  return Math.round((dxPx * totalFrames) / widthPx);
}

/** Frames covered by `px` pixels (snap threshold). */
export function framesForPx(px: number, totalFrames: number, widthPx: number): number {
  return widthPx <= 0 ? 0 : (px * totalFrames) / widthPx;
}

export interface Snapped {
  frame: number;
  /** The target it snapped to, or null when it moved freely. */
  snap: number | null;
}

/** Snap `frame` to the nearest target within `threshold` frames. */
export function snapFrame(frame: number, targets: readonly number[], threshold: number): Snapped {
  let best: number | null = null;
  for (const t of targets) {
    const d = Math.abs(t - frame);
    if (d <= threshold && (best === null || d < Math.abs(best - frame))) best = t;
  }
  return best === null ? { frame, snap: null } : { frame: best, snap: best };
}

/**
 * Snap a span [start, start + dur) as a whole: whichever edge is closer to a
 * target wins. Returns the new start.
 */
export function snapSpan(start: number, dur: number, targets: readonly number[], threshold: number): Snapped {
  const a = snapFrame(start, targets, threshold);
  const b = snapFrame(start + dur, targets, threshold);
  const da = a.snap === null ? Infinity : Math.abs(a.snap - start);
  const db = b.snap === null ? Infinity : Math.abs(b.snap - (start + dur));
  if (da === Infinity && db === Infinity) return { frame: start, snap: null };
  return da <= db ? { frame: a.frame, snap: a.snap } : { frame: b.frame - dur, snap: b.snap };
}

// ---------------------------------------------------------------------------
// Element clips
// ---------------------------------------------------------------------------

export type EdgeMode = 'move' | 'start' | 'end';

export interface Span {
  start: number;
  dur: number;
}

/** Scene-relative snap targets for an element: scene edges, playhead, other clips' edges. */
export function elementSnapTargets(scene: Scene, elementId: string, playheadInScene: number | null): number[] {
  const t = [0, scene.durationInFrames];
  if (playheadInScene !== null && playheadInScene >= 0 && playheadInScene <= scene.durationInFrames) t.push(playheadInScene);
  for (const e of scene.elements) if (e.id !== elementId) t.push(e.startFrame, e.startFrame + e.durationInFrames);
  return t;
}

/**
 * Where a clip ends up after dragging `mode` by `df` frames: clamped inside
 * its scene (never shorter than one frame), then snapped and clamped again.
 */
export function dragElementSpan(orig: Span, mode: EdgeMode, df: number, sceneDuration: number, targets: readonly number[], threshold: number): Span & { snap: number | null } {
  const end = orig.start + orig.dur;
  if (mode === 'move') {
    const hi = Math.max(0, sceneDuration - orig.dur);
    const s = snapSpan(clamp(orig.start + df, 0, hi), orig.dur, targets, threshold);
    const start = clamp(s.frame, 0, hi);
    return { start, dur: orig.dur, snap: start === s.frame ? s.snap : null };
  }
  if (mode === 'start') {
    const s = snapFrame(clamp(orig.start + df, 0, end - 1), targets, threshold);
    const start = clamp(s.frame, 0, end - 1);
    return { start, dur: end - start, snap: start === s.frame ? s.snap : null };
  }
  const s = snapFrame(clamp(end + df, orig.start + 1, sceneDuration), targets, threshold);
  const e = clamp(s.frame, orig.start + 1, sceneDuration);
  return { start: orig.start, dur: e - orig.start, snap: e === s.frame ? s.snap : null };
}

export type TrimResult = { ok: true; changes: { startFrame?: number; durationInFrames?: number } } | { ok: false; reason: string };

/**
 * "[" (edge 'start') / "]" (edge 'end'): move that edge of the clip to the
 * playhead. The playhead must be inside the clip's scene and leave at least
 * one frame of clip. Extends as well as trims.
 */
export function trimToPlayhead(scene: Scene, sceneStart: number, element: Element, playhead: number, edge: 'start' | 'end'): TrimResult {
  const p = playhead - sceneStart;
  if (p < 0 || p > scene.durationInFrames) return { ok: false, reason: `Move the playhead into “${scene.name}” first.` };
  const end = element.startFrame + element.durationInFrames;
  if (edge === 'start') {
    if (p >= end) return { ok: false, reason: `The playhead is after the end of “${element.name}”.` };
    if (p === element.startFrame) return { ok: false, reason: `“${element.name}” already starts at the playhead.` };
    return { ok: true, changes: { startFrame: p, durationInFrames: end - p } };
  }
  if (p <= element.startFrame) return { ok: false, reason: `The playhead is before the start of “${element.name}”.` };
  if (p === end) return { ok: false, reason: `“${element.name}” already ends at the playhead.` };
  return { ok: true, changes: { durationInFrames: p - element.startFrame } };
}

/** Frame to show when a clip is selected: inside its range, past most entrance animations. */
export function focusFrame(sceneStart: number, element: Element, fps: number): number {
  return sceneStart + element.startFrame + Math.min(fps, Math.floor(element.durationInFrames / 2));
}

// ---------------------------------------------------------------------------
// Scene length
// ---------------------------------------------------------------------------

/** Shortest the scene can be: up to its last-ending element (the reason), or one frame. */
export function minSceneLength(scene: Scene): { frames: number; blocker: Element | null } {
  let blocker: Element | null = null;
  for (const e of scene.elements) {
    if (!blocker || e.startFrame + e.durationInFrames > blocker.startFrame + blocker.durationInFrames) blocker = e;
  }
  return blocker ? { frames: Math.max(1, blocker.startFrame + blocker.durationInFrames), blocker } : { frames: 1, blocker: null };
}

export interface SceneLengthInput {
  /** Project length (frames) when the drag started: with `width`, the timeline's scale for the whole drag. */
  total: number;
  sceneDuration: number;
  /** Pointer movement since the drag started, px. */
  dx: number;
  width: number;
  min: number;
  max: number;
  fps: number;
  /** Snap distance in frames. */
  threshold: number;
}

/**
 * New scene length while dragging the scene's right edge `dx` px. The
 * timeline keeps its scale from the start of the drag (it refits on release),
 * so the edge stays under the pointer for every scene, the last one included.
 * Snaps to whole seconds and to the minimum, then clamps. `clamped` is true
 * when the pointer asks for less than the minimum.
 */
export function sceneLengthAt(i: SceneLengthInput): { frames: number; clamped: boolean } {
  const { total, sceneDuration, dx, width, min, max, fps, threshold } = i;
  let frames = sceneDuration + pxToFrames(dx, total, width);
  const asked = frames;
  const sec = Math.round(frames / fps) * fps;
  if (Math.abs(sec - frames) <= threshold) frames = sec;
  if (Math.abs(min - frames) <= threshold) frames = min;
  const out = clamp(frames, min, max);
  return { frames: out, clamped: asked < min };
}

/** Ceiling for one scene's length while dragging (keeps a runaway drag sane). */
export function maxSceneLength(sceneDuration: number, total: number, fps: number): number {
  return Math.max(sceneDuration + total, sceneDuration + 10 * fps);
}

// ---------------------------------------------------------------------------
// Scene order
// ---------------------------------------------------------------------------

/**
 * Drop slot (0..n) for a scene dragged to global `frame`: after every scene
 * whose midpoint is left of the pointer. `toIndex` is the moveScene index
 * (the slot once the dragged scene is taken out).
 */
export function sceneDropTarget(frame: number, starts: readonly number[], durations: readonly number[], fromIndex: number): { slot: number; toIndex: number } {
  let slot = 0;
  for (let i = 0; i < starts.length; i++) if (frame > starts[i] + durations[i] / 2) slot = i + 1;
  return { slot, toIndex: slot > fromIndex ? slot - 1 : slot };
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

export interface AudioSpan {
  startFrame: number;
  trimStartFrames: number;
  durationInFrames: number;
}

/** Source trims keep the envelope on the retained audio, in the same command. */
export function audioSpanChanges(clip: AudioClip, span: AudioSpan): Partial<AudioClip> {
  const changes: Partial<AudioClip> = { startFrame: span.startFrame, trimStartFrames: span.trimStartFrames, durationInFrames: span.durationInFrames };
  if (span.trimStartFrames !== clip.trimStartFrames || span.durationInFrames !== clip.durationInFrames) {
    const from = span.trimStartFrames - clip.trimStartFrames;
    if (clip.volumeEnvelope) changes.volumeEnvelope = trimEnvelope(clip.volumeEnvelope, from, from + span.durationInFrames);
    changes.fadeInFrames = Math.min(clip.fadeInFrames, span.durationInFrames);
    changes.fadeOutFrames = Math.min(clip.fadeOutFrames, span.durationInFrames);
  }
  return changes;
}

export interface AudioDragInput {
  clip: AudioClip;
  /** Absolute frame the clip's startFrame is relative to: its scene's start, or 0 for the music bed. */
  base: number;
  total: number;
  /** Source length in frames, when known. */
  sourceFrames?: number;
  mode: EdgeMode;
  df: number;
  /** Absolute snap targets (playhead, scene boundaries). */
  targets: readonly number[];
  threshold: number;
}

/**
 * Move/trim an audio clip by `df` frames, clamped to the project (an anchored
 * clip never starts before its scene; a clip already running past the end
 * may keep doing so), to the source file, and never shorter than its fades.
 * Left-edge trims also advance trimStartFrames so the audio stays in sync.
 */
export function dragAudioSpan(i: AudioDragInput): AudioSpan & { snap: number | null } {
  const { clip, base, total, mode, df, targets, threshold } = i;
  const a = base + clip.startFrame;
  const end = a + clip.durationInFrames;
  const minDur = Math.max(1, clip.fadeInFrames, clip.fadeOutFrames);
  const srcStart = a - clip.trimStartFrames;
  const srcEnd = i.sourceFrames === undefined ? Infinity : srcStart + i.sourceFrames;
  const projectEnd = Math.max(total, end);
  if (mode === 'move') {
    const hi = Math.max(base, projectEnd - clip.durationInFrames);
    const s = snapSpan(clamp(a + df, base, hi), clip.durationInFrames, targets, threshold);
    const start = clamp(s.frame, base, hi);
    return { startFrame: start - base, trimStartFrames: clip.trimStartFrames, durationInFrames: clip.durationInFrames, snap: start === s.frame ? s.snap : null };
  }
  if (mode === 'start') {
    const lo = Math.max(base, srcStart);
    const hi = Math.max(lo, end - minDur);
    const s = snapFrame(clamp(a + df, lo, hi), targets, threshold);
    const start = clamp(s.frame, lo, hi);
    return { startFrame: start - base, trimStartFrames: clip.trimStartFrames + (start - a), durationInFrames: end - start, snap: start === s.frame ? s.snap : null };
  }
  const lo = a + minDur;
  const hi = Math.max(lo, Math.min(projectEnd, srcEnd));
  const s = snapFrame(clamp(end + df, lo, hi), targets, threshold);
  const e = clamp(s.frame, lo, hi);
  return { startFrame: clip.startFrame, trimStartFrames: clip.trimStartFrames, durationInFrames: e - a, snap: e === s.frame ? s.snap : null };
}

/** Greedy row packing so overlapping clips get separate rows. */
export function packRows(items: readonly { id: string; start: number; end: number }[]): { rows: Map<string, number>; count: number } {
  const rows = new Map<string, number>();
  const rowEnds: number[] = [];
  for (const it of [...items].sort((x, y) => x.start - y.start || x.end - y.end)) {
    let r = rowEnds.findIndex((e) => e <= it.start);
    if (r < 0) r = rowEnds.push(0) - 1;
    rowEnds[r] = it.end;
    rows.set(it.id, r);
  }
  return { rows, count: rowEnds.length };
}

// ---------------------------------------------------------------------------
// Live preview + commit
// ---------------------------------------------------------------------------

/** What a drag in progress would change. Rendered live; committed once on pointer-up. */
export type EditPreview =
  | { kind: 'element'; sceneId: string; elementId: string; mode: EdgeMode; start: number; dur: number }
  | { kind: 'audio'; clipId: string; mode: EdgeMode; span: AudioSpan }
  | { kind: 'sceneLength'; sceneId: string; durationInFrames: number };

/** The project as it would look with `preview` applied (copies only along the changed path). */
export function applyPreview(project: Project, preview: EditPreview | null): Project {
  if (!preview) return project;
  switch (preview.kind) {
    case 'element':
      return {
        ...project,
        scenes: project.scenes.map((s) =>
          s.id !== preview.sceneId ? s : { ...s, elements: s.elements.map((e) => (e.id === preview.elementId ? { ...e, startFrame: preview.start, durationInFrames: preview.dur } : e)) },
        ),
      };
    case 'audio':
      return { ...project, audio: project.audio.map((c) => (c.id === preview.clipId ? { ...c, ...audioSpanChanges(c, preview.span) } : c)) };
    case 'sceneLength':
      return { ...project, scenes: project.scenes.map((s) => (s.id === preview.sceneId ? { ...s, durationInFrames: preview.durationInFrames } : s)) };
  }
}

/** The single command (and Activity label) for a finished drag, or null when nothing changed. */
export function previewCommand(project: Project, preview: EditPreview): { command: Command; label: string } | null {
  switch (preview.kind) {
    case 'element': {
      const el = project.scenes.find((s) => s.id === preview.sceneId)?.elements.find((e) => e.id === preview.elementId);
      if (!el) return null;
      if (el.type === 'video') {
        // Video clips trim their source: the start edge moves the in-point, the end edge stops at the file's end.
        const vc = videoSpanChanges(project, el, preview, preview.mode);
        return vc && { command: { type: 'updateElement', sceneId: preview.sceneId, elementId: el.id, changes: vc }, label: `${preview.mode === 'move' ? 'Moved' : 'Trimmed'} “${el.name}”` };
      }
      const changes: { startFrame?: number; durationInFrames?: number } = {};
      if (preview.start !== el.startFrame) changes.startFrame = preview.start;
      if (preview.dur !== el.durationInFrames) changes.durationInFrames = preview.dur;
      if (!Object.keys(changes).length) return null;
      return { command: { type: 'updateElement', sceneId: preview.sceneId, elementId: el.id, changes }, label: `${preview.mode === 'move' ? 'Moved' : 'Trimmed'} “${el.name}”` };
    }
    case 'audio': {
      const clip = project.audio.find((c) => c.id === preview.clipId);
      if (!clip) return null;
      const changes = audioSpanChanges(clip, preview.span);
      for (const k of Object.keys(changes) as (keyof AudioClip)[]) if (changes[k] === clip[k]) delete changes[k];
      if (!Object.keys(changes).length) return null;
      return { command: { type: 'updateAudioClip', clipId: clip.id, changes }, label: `${preview.mode === 'move' ? 'Moved' : 'Trimmed'} “${clip.name}”` };
    }
    case 'sceneLength': {
      const scene = project.scenes.find((s) => s.id === preview.sceneId);
      if (!scene || scene.durationInFrames === preview.durationInFrames) return null;
      return { command: { type: 'updateScene', sceneId: scene.id, changes: { durationInFrames: preview.durationInFrames } }, label: `Changed “${scene.name}” length` };
    }
  }
}

// ---------------------------------------------------------------------------
// Ruler
// ---------------------------------------------------------------------------

const TICK_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300];

/** Seconds between labelled ruler ticks, so labels stay at least `minPx` apart. */
export function rulerStep(totalFrames: number, fps: number, widthPx: number, minPx = 44): number {
  const pxPerSecond = widthPx > 0 ? (widthPx * fps) / Math.max(1, totalFrames) : 0;
  return TICK_STEPS.find((s) => s * pxPerSecond >= minPx) ?? TICK_STEPS[TICK_STEPS.length - 1];
}

export const fmtSeconds = (frames: number, fps: number) => `${(frames / fps).toFixed(1)} s`;
