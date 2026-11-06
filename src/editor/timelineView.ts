// Pure view math for the advanced timeline (Timeline.tsx): zoom as pixels per
// frame and the header's zoom slider, horizontal scroll, fitting a range, the
// adaptive ruler, the work area, marker snapping, and which colour each bar
// takes. No React, no DOM, no document edits: navigation never changes timing.
//
// Coordinates: a "content x" is measured from the left edge of the scrolled
// track area (frame 0 sits at `TRACK_PAD_PX`); a "viewport x" is measured from
// the left edge of the visible track area. viewport x = content x - scrollPx.

import type { ElementType } from '../core/types';
import { clamp } from './simpleTimelineEdits';

/** Closest zoom: 8 px per frame (frame-accurate editing). */
export const MAX_PX_PER_FRAME = 8;
/** Breathing room before frame 0. */
export const TRACK_PAD_PX = 10;
/** Room after the last frame (the last ruler label hangs past it). */
export const END_PAD_PX = 30;
/** Zoom step for the +/- buttons and keyboard. */
export const ZOOM_STEP = 1.5;

export interface TimelineView {
  pxPerFrame: number;
  scrollPx: number;
}

/** px per frame that shows `frames` frames across `viewportPx` (the "Fit project" zoom). */
export function fitPxPerFrame(frames: number, viewportPx: number): number {
  const usable = Math.max(1, viewportPx - TRACK_PAD_PX - END_PAD_PX);
  return Math.min(MAX_PX_PER_FRAME, usable / Math.max(1, frames));
}

/** Zoom range: the whole project (fit) down to MAX_PX_PER_FRAME. */
export function clampPxPerFrame(pxPerFrame: number, fit: number): number {
  return clamp(pxPerFrame, Math.min(fit, MAX_PX_PER_FRAME), MAX_PX_PER_FRAME);
}

/** Width of the scrolled track area for `frames` frames. */
export function contentWidth(frames: number, pxPerFrame: number): number {
  return Math.ceil(frames * pxPerFrame + TRACK_PAD_PX + END_PAD_PX);
}

export function clampScroll(scrollPx: number, contentPx: number, viewportPx: number): number {
  return clamp(scrollPx, 0, Math.max(0, contentPx - viewportPx));
}

/** Content x of a frame. */
export const frameX = (frame: number, pxPerFrame: number) => TRACK_PAD_PX + frame * pxPerFrame;

/** The whole frame at a content x, clamped to [0, frames - 1]. */
export function frameAtX(x: number, pxPerFrame: number, frames: number): number {
  return clamp(Math.round((x - TRACK_PAD_PX) / pxPerFrame), 0, Math.max(0, frames - 1));
}

/**
 * Zoom by `factor` about a viewport x: the frame under the pointer stays under
 * the pointer (⌘-wheel, pinch). The +/- buttons zoom about the playhead.
 */
export function zoomAbout(view: TimelineView, factor: number, anchorPx: number, fit: number, frames: number, viewportPx: number): TimelineView {
  const pxPerFrame = clampPxPerFrame(view.pxPerFrame * factor, fit);
  const frame = (view.scrollPx + anchorPx - TRACK_PAD_PX) / view.pxPerFrame;
  const scrollPx = frameX(frame, pxPerFrame) - anchorPx;
  return { pxPerFrame, scrollPx: clampScroll(scrollPx, contentWidth(frames, pxPerFrame), viewportPx) };
}

/** The view that shows frames [start, end) across the viewport ("Fit scene"). */
export function fitRange(start: number, end: number, viewportPx: number, fit: number, frames: number): TimelineView {
  const span = Math.max(1, end - start);
  const pxPerFrame = clampPxPerFrame((viewportPx - 4 * TRACK_PAD_PX) / span, fit);
  const scrollPx = frameX(start, pxPerFrame) - TRACK_PAD_PX;
  return { pxPerFrame, scrollPx: clampScroll(scrollPx, contentWidth(frames, pxPerFrame), viewportPx) };
}

/** The header's zoom slider runs 0 (fit) to ZOOM_SLIDER_MAX (MAX_PX_PER_FRAME). */
export const ZOOM_SLIDER_MAX = 1000;

/** Slider position of a zoom: logarithmic, so every step along it zooms by the same factor. */
export function zoomSliderPos(pxPerFrame: number, fit: number): number {
  const lo = Math.min(fit, MAX_PX_PER_FRAME);
  if (lo >= MAX_PX_PER_FRAME) return ZOOM_SLIDER_MAX;
  return clamp(Math.round((ZOOM_SLIDER_MAX * Math.log(pxPerFrame / lo)) / Math.log(MAX_PX_PER_FRAME / lo)), 0, ZOOM_SLIDER_MAX);
}

/** The zoom (px per frame) at a slider position. */
export function zoomAtSliderPos(pos: number, fit: number): number {
  const lo = Math.min(fit, MAX_PX_PER_FRAME);
  return lo * (MAX_PX_PER_FRAME / lo) ** (clamp(pos, 0, ZOOM_SLIDER_MAX) / ZOOM_SLIDER_MAX);
}

/** The zoom readout in percent of "Fit project": 100 shows the whole project, 200 half of it. */
export function zoomPercent(pxPerFrame: number, fit: number): number {
  return Math.round((100 * pxPerFrame) / Math.min(fit, MAX_PX_PER_FRAME));
}

/**
 * Scroll needed to keep `frame` visible. Off the right edge it pages (the
 * frame lands near the left), off the left edge it lands near the right, like
 * an NLE following the playhead. Returns the current scroll when visible.
 */
export function revealFrame(view: TimelineView, frame: number, viewportPx: number, frames: number, marginPx = 24): number {
  const x = frameX(frame, view.pxPerFrame);
  const contentPx = contentWidth(frames, view.pxPerFrame);
  if (x < view.scrollPx + marginPx) return clampScroll(x - viewportPx + 3 * marginPx, contentPx, viewportPx);
  if (x > view.scrollPx + viewportPx - marginPx) return clampScroll(x - 2 * marginPx, contentPx, viewportPx);
  return view.scrollPx;
}

// ---------------------------------------------------------------------------
// Ruler
// ---------------------------------------------------------------------------

export interface RulerTicks {
  /** Frames between labelled ticks. */
  major: number;
  /** Frames between unlabelled ticks (divides major). */
  minor: number;
}

const SECOND_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Tick candidates in frames: whole-frame divisors of a second, then whole seconds. */
function tickCandidates(fps: number): number[] {
  const sub: number[] = [];
  for (let d = 1; d < fps; d++) if (fps % d === 0) sub.push(d);
  return [...sub, ...SECOND_STEPS.map((s) => s * fps)];
}

/**
 * Tick spacing for a zoom: labels at least `minLabelPx` apart, stepping
 * frames → seconds → 5 s …; minor ticks at least `minMinorPx` apart.
 */
export function rulerTicks(pxPerFrame: number, fps: number, minLabelPx = 52, minMinorPx = 7): RulerTicks {
  const c = tickCandidates(fps);
  const major = c.find((f) => f * pxPerFrame >= minLabelPx) ?? c[c.length - 1];
  const minor = c.find((f) => f < major && major % f === 0 && f * pxPerFrame >= minMinorPx) ?? major;
  return { major, minor };
}

/** Multiples of `step` in [from, to]. */
export function tickFrames(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let f = Math.max(0, Math.ceil(from / step) * step); f <= to; f += step) out.push(f);
  return out;
}

/** Ruler label: whole seconds as "3s" (or "1:05" past a minute); frames inside a second as "15f". */
export function tickLabel(frame: number, fps: number): string {
  if (frame % fps !== 0) return `${frame % fps}f`;
  const s = frame / fps;
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// Work area (view state; playback loops it when "Loop work area" is on)
// ---------------------------------------------------------------------------

/** In/out range on the project timeline. `end` is exclusive. */
export interface WorkArea {
  start: number;
  end: number;
}

/** The effective work area: the stored one clamped into the project, or the whole project. */
export function resolveWorkArea(area: WorkArea | null, frames: number): WorkArea {
  const total = Math.max(1, frames);
  if (!area) return { start: 0, end: total };
  const start = clamp(Math.round(area.start), 0, total - 1);
  return { start, end: clamp(Math.round(area.end), start + 1, total) };
}

/** Drag one edge (or the whole range) of the work area by `df` frames. Always ≥ 1 frame long. */
export function dragWorkArea(orig: WorkArea, mode: 'start' | 'end' | 'move', df: number, frames: number): WorkArea {
  const total = Math.max(1, frames);
  if (mode === 'move') {
    const len = orig.end - orig.start;
    const start = clamp(orig.start + df, 0, total - len);
    return { start, end: start + len };
  }
  if (mode === 'start') return { start: clamp(orig.start + df, 0, orig.end - 1), end: orig.end };
  return { start: orig.start, end: clamp(orig.end + df, orig.start + 1, total) };
}

/** Set the in (B) or out (N) point at the playhead, keeping the other edge when it still fits. */
export function setWorkAreaEdge(area: WorkArea, edge: 'start' | 'end', playhead: number, frames: number): WorkArea {
  const total = Math.max(1, frames);
  if (edge === 'start') {
    const start = clamp(playhead, 0, total - 1);
    return { start, end: area.end > start ? area.end : total };
  }
  const end = clamp(playhead + 1, 1, total);
  return { start: area.start < end ? area.start : 0, end };
}

/**
 * Player props that loop the work area while "Loop work area" is on. The
 * Player loops natively between `inFrame` and `outFrame` (both inclusive), so the
 * loop never pauses or seeks mid-playback; null leaves that end open. Off
 * (or a one-frame area) → no in/out, no loop.
 */
export function workAreaLoopProps(area: WorkArea | null, frames: number, on: boolean): { inFrame: number | null; outFrame: number | null; loop: boolean } {
  const a = resolveWorkArea(area, frames);
  if (!on || a.end - 1 <= a.start) return { inFrame: null, outFrame: null, loop: false };
  return { inFrame: a.start > 0 ? a.start : null, outFrame: a.end < frames ? a.end - 1 : null, loop: true };
}

// ---------------------------------------------------------------------------
// Colours (tokens in styles.css; the bars and scene blocks set them as --type
// and --scene-accent)
// ---------------------------------------------------------------------------

/**
 * Each element type's clip colour: its bar is filled with a tint of it and
 * edged in it. Types differ by value and the track icon, never by a new hue,
 * so the kinds without a token of their own borrow the nearest: a path is
 * drawn like a shape, a component instance like a UI card, and a group in the
 * video's charcoal, the grey furthest from the text it usually holds in both
 * themes (a video bar also carries its waveform).
 */
export const CLIP_COLOR: Record<ElementType, string> = {
  text: 'var(--clip-text)',
  shape: 'var(--clip-shape)',
  path: 'var(--clip-shape)',
  image: 'var(--clip-image)',
  logo: 'var(--clip-logo)',
  uiCard: 'var(--clip-ui-card)',
  chatBubble: 'var(--clip-chat)',
  video: 'var(--clip-video)',
  instance: 'var(--clip-ui-card)',
  group: 'var(--clip-video)',
};

/** A scene's colour by its position: the four scene accents in turn. */
export const sceneAccent = (index: number) => `var(--scene-accent-${index % 4})`;

// ---------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------

/** Previous / next frame among `frames` strictly before / after `from` (sorted or not). */
export function stepTo(frames: readonly number[], from: number, dir: -1 | 1): number | null {
  let best: number | null = null;
  for (const f of frames) {
    if (dir < 0 ? f < from && (best === null || f > best) : f > from && (best === null || f < best)) best = f;
  }
  return best;
}
