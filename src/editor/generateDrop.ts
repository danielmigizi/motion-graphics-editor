// What dropping images or clips on the Generate composer does (GenerateTab.tsx):
// each job takes them its own way, and a job that takes none moves to the
// nearest one that does. Video: text → animate one image → between two frames
// → through keyframes (three or more), and any clip → a consistent subject.
// Image: one image → edit it, two or more → combine them. Sound takes no
// pictures. dropPlan is pure (the tab applies its patch); sendToGenerate
// applies it from the Assets library.

import type { FrameSource, JobKind, JobSettings } from '../core/generationStudio';
import type { Project } from '../core/types';
import { BRIDGE_SECONDS, jobsOf, KEYFRAME_COUNT, nextKeyframeTime, openGenerate, sortKeyframes, useGenerate, type GenerateDraft, type GenerateMode, type PinnedFrame } from './generateStore';
import { useEditor } from './store';

export type DropOutcome = { patch: Partial<GenerateDraft> } | { refused: string };

const dedupe = (ids: string[]) => [...new Set(ids)];

/** Pinned frames for `frames`, spread evenly over `length` seconds (0.1 s steps). */
export function spreadKeyframes(frames: FrameSource[], length: number): PinnedFrame[] {
  const n = frames.length;
  return frames.map((frame, i) => ({ frame, atSeconds: n < 2 ? 0 : Math.round(((i * length) / (n - 1)) * 10) / 10 }));
}

/** The frames a video job holds now, in order. */
function framesOf(job: JobKind, s: JobSettings): FrameSource[] {
  if (job === 'video.animate') return s.start ? [s.start] : [];
  if (job === 'video.between') return [s.start, s.end].filter((f): f is FrameSource => !!f);
  if (job === 'video.keyframes') return (s.keyframes ?? []).map((k) => k.frame);
  return [];
}

/** The fewest-frames job that takes `frames`: one to animate, two to bridge, more to pass through. */
function framesPatch(frames: FrameSource[], length: number): Partial<GenerateDraft> {
  if (frames.length === 1) return { job: 'video.animate', settings: { start: frames[0] } };
  if (frames.length === 2) return { job: 'video.between', settings: { start: frames[0], end: frames[1] } };
  return { job: 'video.keyframes', settings: { keyframes: spreadKeyframes(frames.slice(0, KEYFRAME_COUNT.max), length) } };
}

export function dropPlan(draft: GenerateDraft, ids: string[], project: Project): DropOutcome {
  const assets = ids.map((id) => project.assets[id]).filter((a) => !!a);
  const pictures = assets.filter((a) => a.kind === 'image' || a.kind === 'svg').map((a) => a.id);
  const clips = assets.filter((a) => a.kind === 'video').map((a) => a.id);
  if (!pictures.length && !clips.length) return { refused: 'Only images and video clips can steer generation.' };
  const mode: GenerateMode = draft.mode;
  if (mode === 'music' || mode === 'voice' || mode === 'sfx') return { refused: 'Images and clips steer Image and Video. Switch to one of those to use them.' };
  const s = draft.settings;
  const refs = s.referenceAssetIds ?? [];

  if (mode === 'image') {
    if (!pictures.length) return { refused: 'Image takes pictures, not clips. Switch to Video to use a clip.' };
    const kept = draft.job === 'image.edit' || draft.job === 'image.composite' ? refs : [];
    const all = dedupe([...kept, ...pictures]);
    return { patch: { job: all.length === 1 ? 'image.edit' : 'image.composite', settings: { referenceAssetIds: all } } };
  }

  // Video. A subject's references take both pictures and clips; any clip leads there.
  if (draft.job === 'video.reference' || clips.length) {
    const kept = draft.job === 'video.reference' ? refs : [];
    return { patch: { job: 'video.reference', settings: { referenceAssetIds: dedupe([...kept, ...pictures, ...clips]) } } };
  }
  const added = pictures.map((assetId): FrameSource => ({ assetId }));
  if (draft.job === 'video.keyframes') {
    const keys = [...(s.keyframes ?? [])];
    const length = s.durationSeconds ?? BRIDGE_SECONDS;
    for (const frame of added) {
      if (keys.length >= KEYFRAME_COUNT.max) break;
      keys.push({ frame, atSeconds: nextKeyframeTime(keys.map((k) => k.atSeconds), length) });
    }
    return { patch: { settings: { keyframes: sortKeyframes(keys) } } };
  }
  if (draft.job === 'video.between' && (!s.start || !s.end)) {
    // The empty slot is filled; the picked frame keeps its end of the clip.
    const frames = s.start ? [s.start, ...added] : s.end ? [...added, s.end] : added;
    if (frames.length < 2) return { patch: { settings: { start: added[0] } } };
    return { patch: framesPatch(frames, BRIDGE_SECONDS) };
  }
  return { patch: framesPatch([...framesOf(draft.job, s), ...added], BRIDGE_SECONDS) };
}

/**
 * "Use in Generate" from the Assets library: open the Generate tab with these
 * assets taken the way a drop would. A clip goes to Video; a picture stays in
 * Video when that is open, else goes to Image (sound takes no pictures).
 */
export function sendToGenerate(ids: string[]): void {
  const st = useEditor.getState();
  const project = st.doc.project;
  const { draft } = useGenerate.getState();
  const clip = ids.some((id) => project.assets[id]?.kind === 'video');
  const mode: GenerateMode = clip || draft.mode === 'video' ? 'video' : 'image';
  const base: GenerateDraft = mode === draft.mode ? draft : { ...draft, mode, job: jobsOf(mode)[0], settings: {} };
  const r = dropPlan(base, ids, project);
  if ('refused' in r) return st.toast({ tone: 'info', message: r.refused });
  openGenerate({ ...r.patch, job: r.patch.job ?? base.job });
}
