// Video elements (pure): which source frame a video element shows, how long it
// may run, how timeline trims map onto its in-point, and the audio clip that
// "Detach audio" makes from it. Shared by validation, the detach command, the
// renderer, the inspector and both timelines so they cannot disagree.
//
// Timing contract: source frames are counted at the PROJECT frame rate from
// the start of the file (asset.durationInFrames is too). At element-local
// frame f the element shows source time (trimStartFrames + f × playbackRate) / fps,
// wrapped to the trimmed source when `loop` is set.

import { evaluatePropertyTrack } from './animation';
import { COMPONENTS } from './components';
import { trimEnvelope } from './audioDucking';
import type { Asset, AudioClip, Element, ID, Project, Scene } from './types';

export const VIDEO_RATE_MIN = 0.25;
export const VIDEO_RATE_MAX = 4;

export interface VideoProps {
  assetId: string;
  trimStartFrames: number;
  playbackRate: number;
  volume: number;
  muted: boolean;
  loop: boolean;
  fit: 'cover' | 'contain';
  cornerRadius: number;
}

/** The element's video props, with registry defaults for anything missing or mistyped. */
export function videoProps(element: Pick<Element, 'props'>): VideoProps {
  const d = COMPONENTS.video.defaultProps as unknown as VideoProps;
  const p = element.props;
  const num = (k: keyof VideoProps) => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : (d[k] as number));
  const bool = (k: keyof VideoProps) => (typeof p[k] === 'boolean' ? (p[k] as boolean) : (d[k] as boolean));
  return {
    assetId: typeof p.assetId === 'string' ? p.assetId : '',
    trimStartFrames: Math.max(0, num('trimStartFrames')),
    playbackRate: Math.min(VIDEO_RATE_MAX, Math.max(VIDEO_RATE_MIN, num('playbackRate'))),
    volume: Math.min(1, Math.max(0, num('volume'))),
    muted: bool('muted'),
    loop: bool('loop'),
    fit: p.fit === 'contain' ? 'contain' : 'cover',
    cornerRadius: Math.max(0, num('cornerRadius')),
  };
}

/**
 * Source frame (project-fps frames from the file start, fractional) shown at
 * element-local frame `localFrame`. With `loop` and a known source length the
 * trimmed range [trim, duration) repeats.
 */
export function videoSourceFrame(trimStartFrames: number, playbackRate: number, localFrame: number, loop = false, sourceDuration?: number): number {
  const advance = Math.max(0, localFrame) * playbackRate;
  if (loop && sourceDuration !== undefined && sourceDuration > trimStartFrames) {
    const span = sourceDuration - trimStartFrames;
    return trimStartFrames + (advance % span);
  }
  return trimStartFrames + advance;
}

/**
 * Longest element duration (frames) the trimmed source can fill at `rate`.
 * Infinity when looping or when the source length is unknown.
 */
export function videoMaxDuration(sourceDuration: number | undefined, trimStartFrames: number, playbackRate: number, loop: boolean): number {
  if (loop || sourceDuration === undefined) return Infinity;
  return Math.max(0, Math.floor((sourceDuration - trimStartFrames) / playbackRate + 1e-9));
}

/** videoMaxDuration for an element (looks its asset up). */
export function elementVideoMaxDuration(element: Element, assets: Record<ID, Asset>): number {
  const v = videoProps(element);
  const asset = Object.prototype.hasOwnProperty.call(assets, v.assetId) ? assets[v.assetId] : undefined;
  return videoMaxDuration(asset?.kind === 'video' ? asset.durationInFrames : undefined, v.trimStartFrames, v.playbackRate, v.loop);
}

export interface VideoSpan {
  /** Element startFrame (relative to its scene or group). */
  start: number;
  dur: number;
  /** trimStartFrames. */
  trim: number;
}

/**
 * Apply a timeline drag result to a video element so the picture stays put
 * under the bar: moving the start edge by Δ frames moves the in-point by
 * Δ × rate (never before the file start), and the end edge never runs past
 * the source (unless looping). `next` is the span the generic bar drag
 * produced; the result is clamped and carries the new in-point.
 */
export function trimVideoSpan(orig: VideoSpan, next: { start: number; dur: number }, mode: 'move' | 'start' | 'end', rate: number, sourceDuration: number | undefined, loop: boolean): VideoSpan {
  if (mode === 'move') return { start: next.start, dur: next.dur, trim: orig.trim };
  if (mode === 'end') {
    const max = videoMaxDuration(sourceDuration, orig.trim, rate, loop);
    return { start: orig.start, dur: Math.max(1, Math.min(next.dur, max)), trim: orig.trim };
  }
  const end = orig.start + orig.dur;
  // Earliest start: the in-point reaches the file start.
  const earliest = orig.start - Math.floor(orig.trim / rate + 1e-9);
  let start = Math.max(next.start, earliest);
  if (sourceDuration !== undefined) {
    // Latest start keeps a valid in-point, including for a looping source.
    const latest = orig.start + Math.floor((sourceDuration - 1 - orig.trim) / rate);
    start = Math.min(start, latest);
  }
  start = Math.min(start, end - 1);
  const trim = Math.max(0, Math.round(orig.trim + (start - orig.start) * rate));
  let dur = end - start;
  dur = Math.max(1, Math.min(dur, videoMaxDuration(sourceDuration, trim, rate, loop)));
  return { start, dur, trim };
}

/** Changing speed keeps the in-point and shortens the element when the trimmed source no longer fills it. */
export function retimeVideo(element: Element, rate: number, assets: Record<ID, Asset>): { playbackRate: number; durationInFrames: number } {
  const v = videoProps(element);
  const asset = assets[v.assetId];
  const r = Math.min(VIDEO_RATE_MAX, Math.max(VIDEO_RATE_MIN, rate));
  const max = videoMaxDuration(asset?.kind === 'video' ? asset.durationInFrames : undefined, v.trimStartFrames, r, v.loop);
  return { playbackRate: r, durationInFrames: Math.max(1, Math.min(element.durationInFrames, max)) };
}

// ---------------------------------------------------------------------------
// Detach audio
// ---------------------------------------------------------------------------

export type DetachResult = { ok: true; clip: AudioClip } | { ok: false; message: string; hint?: string; path?: string };

/** Scene-relative start of an element and the frames of its lifetime its ancestors let it play. */
function sceneSpan(scene: Scene, element: Element): { start: number; skip: number; dur: number } {
  let start = element.startFrame;
  let lo = element.startFrame;
  let hi = element.startFrame + element.durationInFrames;
  let parentId = element.parentId;
  const seen = new Set([element.id]);
  // Walk up: convert [lo, hi) into each ancestor's parent space and clip to the ancestor's lifetime.
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = scene.elements.find((e) => e.id === parentId);
    if (!parent) break;
    lo = Math.max(0, lo) + parent.startFrame;
    hi = Math.min(hi, parent.durationInFrames) + parent.startFrame;
    start += parent.startFrame;
    parentId = parent.parentId;
  }
  lo = Math.max(lo, start);
  return { start: lo, skip: lo - start, dur: Math.max(0, hi - lo) };
}

/** Clip-relative volume envelope points for an animated volume track (sampled where the curve bends). */
function volumeEnvelope(element: Element, skip: number, dur: number): { frame: number; value: number }[] | undefined {
  const track = element.propTracks?.find((t) => t.key === 'props.volume');
  if (!track || track.keyframes.length === 0) return undefined;
  const frames = new Set<number>([skip, skip + dur]);
  track.keyframes.forEach((k, i) => {
    frames.add(k.frame);
    const next = track.keyframes[i + 1];
    // Eased segments are sampled every 3 frames; linear and hold segments only at their ends.
    if (next && k.easing !== 'linear' && k.easing !== 'hold') for (let f = k.frame + 3; f < next.frame; f += 3) frames.add(f);
    if (next && k.easing === 'hold') frames.add(next.frame - 1);
  });
  const points = [...frames]
    .sort((a, b) => a - b)
    .map((frame) => ({ frame, value: Math.min(1, Math.max(0, Number(evaluatePropertyTrack(element, 'props.volume', frame)) || 0)) }));
  return trimEnvelope(points, skip, skip + dur);
}

/**
 * The audio clip "Detach audio" creates: same source file and in-point,
 * anchored to the element's scene at the element's current timing (inside
 * groups: the part of its lifetime its groups let it play), with the
 * element's volume (an animated volume becomes the clip's envelope).
 */
export function detachedAudioClip(project: Project, scene: Scene, element: Element, clipId: ID): DetachResult {
  if (element.type !== 'video') return { ok: false, message: `Element "${element.name}" is a ${element.type}, not a video`, path: 'elementId' };
  const v = videoProps(element);
  const asset = Object.prototype.hasOwnProperty.call(project.assets, v.assetId) ? project.assets[v.assetId] : undefined;
  if (!asset || asset.kind !== 'video') return { ok: false, message: `Video "${element.name}" has no video file`, path: 'elementId', hint: 'Pick a video file first.' };
  if (asset.hasAudio === false) return { ok: false, message: `“${asset.name}” has no soundtrack to detach`, path: 'elementId' };
  // Detaching mutes the element, so a muted video has nothing (left) to detach — this also stops a double detach.
  if (v.muted) return { ok: false, message: `Video "${element.name}" is muted (its soundtrack may already be detached)`, path: 'elementId', hint: 'Unmute it first to detach its soundtrack.' };
  if (v.playbackRate !== 1) {
    return { ok: false, message: `Video "${element.name}" plays at ${v.playbackRate}×; a detached audio clip always plays at 1×`, path: 'elementId', hint: 'Set Speed to 1× before detaching its audio.' };
  }
  const span = sceneSpan(scene, element);
  if (span.dur < 1) return { ok: false, message: `Video "${element.name}" is never on screen inside its group, so it has no audio to detach`, path: 'elementId' };
  const remaining = asset.durationInFrames !== undefined ? asset.durationInFrames - v.trimStartFrames - span.skip : Infinity;
  if (v.loop && remaining < span.dur) {
    return { ok: false, message: `Video "${element.name}" loops; an audio clip cannot loop`, path: 'elementId', hint: 'Turn Loop off (or shorten the element to one pass) before detaching its audio.' };
  }
  const dur = Math.max(1, Math.min(span.dur, remaining));
  const envelope = volumeEnvelope(element, span.skip, dur);
  const clip: AudioClip = {
    id: clipId,
    assetId: asset.id,
    name: `${element.name} audio`.slice(0, 120),
    sceneId: scene.id,
    startFrame: span.start,
    trimStartFrames: v.trimStartFrames + span.skip,
    durationInFrames: dur,
    volume: envelope ? 1 : v.volume,
    fadeInFrames: 0,
    fadeOutFrames: 0,
  };
  if (envelope) clip.volumeEnvelope = envelope;
  return { ok: true, clip };
}
