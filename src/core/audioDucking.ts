// Volume envelopes and ducking. An envelope is ordinary clip data
// (`AudioClip.volumeEnvelope`, clip-relative frames, values 0..1) that
// multiplies the clip's volume and fades, so ducking is an editable curve the
// user can see and undo, never hidden processing. Pure.

import { audioClipStartFrame } from './timing';
import type { AudioClip, Command, ID, Project } from './types';

export type EnvelopePoint = { frame: number; value: number };

/**
 * Envelope gain at a clip-relative frame: 1 without points, linear between
 * points, and the end values held before the first and after the last point.
 */
export function envelopeAt(points: readonly EnvelopePoint[] | undefined, frame: number): number {
  if (!points || points.length === 0) return 1;
  if (frame <= points[0].frame) return points[0].value;
  const last = points[points.length - 1];
  if (frame >= last.frame) return last.value;
  // Envelopes are short (a few points per voice line): a linear scan is fine.
  for (let i = 1; i < points.length; i++) {
    const b = points[i];
    if (frame <= b.frame) {
      const a = points[i - 1];
      const t = b.frame === a.frame ? 1 : (frame - a.frame) / (b.frame - a.frame);
      return a.value + (b.value - a.value) * t;
    }
  }
  return last.value;
}

/** Crop [fromFrame, toFrame] and rebase to zero, sampling both boundaries.
 * Outside the original curve the endpoint gain is held, so extending a trim
 * has the same gain as playback. The input points are never mutated.
 */
export function trimEnvelope(envelope: readonly EnvelopePoint[] | undefined, fromFrame: number, toFrame: number): EnvelopePoint[] | undefined {
  if (!envelope) return undefined;
  if (!envelope.length) return [];
  const duration = Math.max(0, toFrame - fromFrame);
  const points = [{ frame: 0, value: envelopeAt(envelope, fromFrame) }];
  for (const point of envelope) {
    if (point.frame > fromFrame && point.frame < toFrame) points.push({ frame: point.frame - fromFrame, value: point.value });
  }
  if (duration > 0) points.push({ frame: duration, value: envelopeAt(envelope, toFrame) });
  return points;
}

export const dbToGain = (db: number) => 10 ** (db / 20);

export interface DuckOptions {
  /** How far the bed dips under the voice, in dB (positive; default 12). */
  dropDb?: number;
  /** Frames to dip before each voice line starts (default 0.2 s). */
  attackFrames?: number;
  /** Frames to come back up after it ends (default 0.4 s). */
  releaseFrames?: number;
}

export type DuckResult = { ok: true; command: Extract<Command, { type: 'updateAudioClip' }>; sections: number } | { ok: false; message: string };

/**
 * Clips that look like voice-over for ducking `bedClipId` under: named like
 * voice/VO/narration (clip or asset), otherwise any other clip at least 1.5 s
 * long (sound effects are short and should not pump the music).
 */
export function likelyVoiceClips(project: Project, bedClipId: ID): AudioClip[] {
  const others = project.audio.filter((c) => c.id !== bedClipId);
  const named = others.filter((c) => /\b(voice|vo|narrat\w*|speech|dialog\w*|speaker)\b/i.test(`${c.name} ${project.assets[c.assetId]?.name ?? ''}`));
  return named.length ? named : others.filter((c) => c.durationInFrames >= project.fps * 1.5);
}

/**
 * An `updateAudioClip` that gives the bed a volume envelope dipping by
 * `dropDb` under every voice clip (project timing, so scene-anchored voice
 * lines count where they play), easing down over `attackFrames` before each
 * line and back up over `releaseFrames` after it. Lines closer than
 * attack + release share one dip so the music does not pump. Replaces any
 * existing envelope on the bed.
 */
export function duckUnder(project: Project, bedClipId: ID, voiceClipIds: readonly ID[], opts: DuckOptions = {}): DuckResult {
  const bed = project.audio.find((c) => c.id === bedClipId);
  if (!bed) return { ok: false, message: `Audio clip ${bedClipId} not found` };
  const dropDb = Math.max(0, opts.dropDb ?? 12);
  const attack = Math.max(1, Math.round(opts.attackFrames ?? project.fps * 0.2));
  const release = Math.max(1, Math.round(opts.releaseFrames ?? project.fps * 0.4));
  const low = Math.round(dbToGain(-dropDb) * 1000) / 1000;
  const bedStart = audioClipStartFrame(project, bed);
  const len = bed.durationInFrames;

  // Voice spans in bed-relative frames, clipped to the bed, merged.
  const spans = voiceClipIds
    .map((id) => project.audio.find((c) => c.id === id))
    .filter((c): c is AudioClip => !!c && c.id !== bed.id)
    .map((c) => {
      const s = audioClipStartFrame(project, c) - bedStart;
      return [s, s + c.durationInFrames] as [number, number];
    })
    .filter(([a, b]) => b > 0 && a < len)
    .sort((x, y) => x[0] - y[0]);
  const merged: [number, number][] = [];
  for (const [a, b] of spans) {
    const prev = merged[merged.length - 1];
    if (prev && a - prev[1] <= attack + release) prev[1] = Math.max(prev[1], b);
    else merged.push([a, b]);
  }
  if (!merged.length) return { ok: false, message: `No voice clip plays under “${bed.name}”` };

  // The full polyline (may run past the bed), then sampled at the bed's edges.
  const raw: EnvelopePoint[] = [];
  for (const [a, b] of merged) raw.push({ frame: a - attack, value: 1 }, { frame: a, value: low }, { frame: b, value: low }, { frame: b + release, value: 1 });
  const points: EnvelopePoint[] = [];
  const push = (frame: number, value: number) => {
    const f = Math.max(0, Math.min(len, Math.round(frame)));
    const v = Math.round(value * 1000) / 1000;
    const last = points[points.length - 1];
    if (last && last.frame === f) last.value = Math.min(last.value, v);
    else if (!last || f > last.frame) points.push({ frame: f, value: v });
  };
  if (raw[0].frame > 0) push(0, 1);
  else push(0, envelopeAt(raw, 0));
  for (const p of raw) if (p.frame > 0 && p.frame < len) push(p.frame, p.value);
  push(len, envelopeAt(raw, len));
  return { ok: true, command: { type: 'updateAudioClip', clipId: bed.id, changes: { volumeEnvelope: points } }, sections: merged.length };
}
