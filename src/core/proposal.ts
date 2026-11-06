// Proposals: an agent edit (or a pasted patch) the user reviews before it
// lands. These are pure checks over the core patch logic; the editor keeps the
// proposal state (src/editor/proposals.ts) and never puts the candidate into
// the document, its history or its saves.

import type { ProposalSource } from './api-contract';
import { checkPatch } from './patch';
import { audioClipStartFrame, formatTimecode, projectDurationInFrames, sceneStartFrame } from './timing';
import type { AiPatch, AudioClip, ChangeEntry, CommandError, DocState, PatchTarget, Project, TouchedRef } from './types';

export interface Proposal {
  id: string;
  projectId: string;
  /** The editor document session it was proposed in: another project opened makes it stale. */
  docSession: string;
  patch: AiPatch;
  /** Who proposed it: an agent label ("Codex") or "You" for a pasted patch. */
  agent: string;
  model?: string;
  source: ProposalSource;
  /**
   * Rebase onto later revisions when none of its targets changed since
   * `patch.baseRevision`. The editor sets this once a proposal is accepted, so
   * the user's own later edits elsewhere never invalidate it, while an edit to
   * a target makes it stale.
   */
  reconcile: boolean;
  /** Epoch ms. */
  createdAt: number;
}

export type ProposalCheck =
  | {
      status: 'ready';
      /** The document Apply would produce from the CURRENT document (revision not yet bumped). */
      candidate: Project;
      diff: ChangeEntry[];
      touched: TouchedRef[];
      label: string;
    }
  | { status: 'stale'; error: CommandError; conflicts?: AiPatch['targets'] }
  | { status: 'invalid'; error: CommandError };

/**
 * Re-run every patch check against the current document. A document that moved
 * past `patch.baseRevision` is reconciled when the proposal allows it, so
 * unrelated edits are kept in the candidate and a changed target is STALE.
 */
export function checkProposal(state: DocState, p: Proposal): ProposalCheck {
  const r = checkPatch(state, p.patch, { reconcile: p.reconcile, actor: p.agent });
  if (r.ok) return { status: 'ready', candidate: r.project, diff: r.diff, touched: r.touched, label: r.label };
  if (r.error.code === 'STALE') return r.conflicts ? { status: 'stale', error: r.error, conflicts: r.conflicts } : { status: 'stale', error: r.error };
  return { status: 'invalid', error: r.error };
}

/** Global frames, both ends inclusive. */
export interface FrameRange {
  start: number;
  end: number;
}

/** Where a touched audio clip plays in one document, or null when it is not there. */
function audioSpanIn(project: Project, clipId: string): FrameRange | null {
  const clip = project.audio.find((c) => c.id === clipId);
  if (!clip || clip.durationInFrames <= 0) return null;
  const start = audioClipStartFrame(project, clip);
  return { start, end: start + clip.durationInFrames - 1 };
}

/** On-screen (or audible) span of a touched scene, element or audio clip in one document, or null when it is not there. */
function spanIn(project: Project, ref: TouchedRef): FrameRange | null {
  if (ref.kind === 'audio') return audioSpanIn(project, ref.clipId);
  if (ref.kind !== 'scene' && ref.kind !== 'element') return null;
  const start = sceneStartFrame(project, ref.sceneId);
  const scene = project.scenes.find((s) => s.id === ref.sceneId);
  if (start < 0 || !scene || scene.durationInFrames <= 0) return null;
  const sceneEnd = start + scene.durationInFrames - 1;
  if (ref.kind === 'scene') return { start, end: sceneEnd };
  const el = scene.elements.find((e) => e.id === ref.elementId);
  if (!el) return null;
  let from = el.startFrame, to = el.startFrame + el.durationInFrames - 1;
  let parentId = el.parentId;
  const seen = new Set([el.id]);
  while (parentId) {
    if (seen.has(parentId)) return null;
    seen.add(parentId);
    const parent = scene.elements.find(e => e.id === parentId);
    if (!parent) return null;
    from += parent.startFrame;
    to = Math.min(to + parent.startFrame, parent.startFrame + parent.durationInFrames - 1);
    parentId = parent.parentId;
  }
  to = Math.min(to, scene.durationInFrames - 1);
  return from > to ? null : { start: start + from, end: start + to };
}

/**
 * Where the proposal changes what is seen or heard: the union of the touched
 * scenes', elements' and audio clips' spans in both documents (so a removed or
 * moved thing still counts), clamped to the candidate's length. Falls back to
 * the whole project for project-level changes or when nothing on the timeline
 * was touched.
 */
export function affectedRange(current: Project, candidate: Project, touched: TouchedRef[]): FrameRange {
  const last = Math.max(0, projectDurationInFrames(candidate) - 1);
  const whole = { start: 0, end: last };
  let start = Infinity;
  let end = -Infinity;
  for (const ref of touched) {
    if (ref.kind === 'project') return whole;
    for (const p of [current, candidate]) {
      const s = spanIn(p, ref);
      if (!s) continue;
      start = Math.min(start, s.start);
      end = Math.max(end, s.end);
    }
  }
  if (!Number.isFinite(start)) return whole;
  const from = Math.max(0, Math.min(start, last));
  return { start: from, end: Math.max(from, Math.min(end, last)) };
}

/** "A", "A and B", "A, B and C", "A, B and 2 more". */
export function listNames(names: string[], max = 3): string {
  if (names.length <= 1) return names[0] ?? '';
  if (names.length > max) return `${names.slice(0, max - 1).join(', ')} and ${names.length - (max - 1)} more`;
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** Clip name from an audio diff label (`Audio "Name"` or `Audio "Name" › volume`, see diff.ts). */
const audioLabelName = (label: string): string | undefined => /^Audio "(.*?)"(?: › |$)/.exec(label)?.[1];

const nameOf = (v: unknown): string | undefined => (v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string' ? (v as { name: string }).name : undefined);

/** A scene, or an element in it. */
export interface TargetRef {
  sceneId: string;
  elementId?: string;
}

/**
 * A short plain summary of a proposal's changes, e.g. "3 changes to Headline
 * and Logo in “Intro”", and the scene › layer names it touches (`refs` holds
 * their ids, in the same order). Names come from `project` (the candidate), or
 * from the change itself for removed things.
 */
export function describeProposal(diff: ChangeEntry[], project: Project): { headline: string; targets: string[]; refs: TargetRef[] } {
  const count = diff.length === 1 ? '1 change' : `${diff.length} changes`;
  const scenes = new Map<string, { name: string; elements: Map<string, string> }>();
  // Audio clips by name (audio changes carry no ids; describeAudioChanges has the detail).
  const audio = new Set<string>();
  for (const c of diff) {
    if (c.kind === 'audio') {
      const name = nameOf(c.after) ?? nameOf(c.before) ?? audioLabelName(c.label);
      if (name) audio.add(name);
      continue;
    }
    if (!c.sceneId) continue;
    let entry = scenes.get(c.sceneId);
    if (!entry) {
      const sceneName = project.scenes.find((s) => s.id === c.sceneId)?.name ?? (c.kind === 'scene' && !c.elementId ? (nameOf(c.before) ?? nameOf(c.after)) : undefined) ?? c.sceneId;
      entry = { name: sceneName, elements: new Map() };
      scenes.set(c.sceneId, entry);
    }
    if (c.kind === 'element' && c.elementId && !entry.elements.has(c.elementId)) {
      const live = project.scenes.find((s) => s.id === c.sceneId)?.elements.find((e) => e.id === c.elementId)?.name;
      entry.elements.set(c.elementId, live ?? nameOf(c.before) ?? nameOf(c.after) ?? c.elementId);
    }
  }
  const targets: string[] = [];
  const refs: TargetRef[] = [];
  for (const [sceneId, s] of scenes) {
    if (s.elements.size === 0) {
      targets.push(s.name);
      refs.push({ sceneId });
    }
    for (const [elementId, el] of s.elements) {
      targets.push(`${s.name} › ${el}`);
      refs.push({ sceneId, elementId });
    }
  }
  const out = (headline: string) => ({ headline, targets, refs });
  if (diff.length === 0) return out('No visible changes');
  const list = [...scenes.values()];
  const sounds = [...audio].map((n) => `“${n}”`);
  if (list.length === 0) return out(sounds.length ? `${count} to ${listNames(sounds)}` : `${count} to the project`);
  if (list.length > 1 || sounds.length) return out(`${count} across ${listNames([...list.map((s) => `“${s.name}”`), ...sounds])}`);
  const [only] = list;
  const elements = [...only.elements.values()];
  return out(elements.length ? `${count} to ${listNames(elements)} in “${only.name}”` : `${count} to scene “${only.name}”`);
}

/** "Headline in “Intro”", "scene “Intro”" or "the project audio (“Music bed”)", for a patch target in `project`. */
export function targetName(project: Project, t: TargetRef | PatchTarget): string {
  if ('style' in t) return project.style ? `the project style (“${project.style.name}”)` : 'the project style';
  if (!('sceneId' in t)) {
    const names = project.audio.filter((c) => !c.sceneId).map((c) => `“${c.name}”`);
    return names.length ? `the project audio (${listNames(names)})` : 'the project audio';
  }
  const scene = project.scenes.find((s) => s.id === t.sceneId);
  const sceneName = scene?.name ?? t.sceneId;
  if (!t.elementId) return `scene “${sceneName}”`;
  return `${scene?.elements.find((e) => e.id === t.elementId)?.name ?? t.elementId} in “${sceneName}”`;
}

// ---------------------------------------------------------------------------
// Audio changes in words
// ---------------------------------------------------------------------------

export interface AudioChange {
  clipId: string;
  /** The clip's name (after the change; before it for a removed clip). */
  name: string;
  /** "Music bed: volume 60% → 40%, fade-out 1.5 s → 2 s". */
  text: string;
  /** Where the clip starts (global frame) in the document it is in. */
  frame: number;
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
/** "1.5 s", "2 s", "0.2 s". */
function secs(frames: number, fps: number): string {
  const s = frames / fps;
  return `${Number.isInteger(s) ? s : Number(s.toFixed(s < 10 ? 2 : 1))} s`;
}

function fadeText(kind: 'fade-in' | 'fade-out', a: number, b: number, fps: number): string | null {
  if (a === b) return null;
  if (b === 0) return `no ${kind}`;
  return a === 0 ? `${kind} ${secs(b, fps)}` : `${kind} ${secs(a, fps)} → ${secs(b, fps)}`;
}

function envelopeText(env: AudioClip['volumeEnvelope']): string {
  if (!env?.length) return 'no volume envelope';
  const low = Math.min(...env.map((p) => p.value));
  const dips = env.filter((p, i) => p.value < 1 && (i === 0 || env[i - 1].value >= 1 || env[i - 1].value > p.value) && (i === env.length - 1 || env[i + 1].value <= p.value)).length;
  const db = low > 0 ? ` (${Math.round(20 * Math.log10(low))} dB)` : '';
  return low >= 1 ? `volume envelope (${env.length} points)` : `ducks to ${pct(low)}${db}${dips > 1 ? ` in ${dips} places` : ''}`;
}

function sceneName(project: Project, sceneId: string | undefined): string {
  return sceneId ? `“${project.scenes.find((s) => s.id === sceneId)?.name ?? sceneId}”` : 'the project timeline';
}

function addedText(project: Project, clip: AudioClip): string {
  const fps = project.fps;
  const start = audioClipStartFrame(project, clip);
  const total = projectDurationInFrames(project);
  const where = clip.sceneId
    ? `in ${sceneName(project, clip.sceneId)} at ${formatTimecode(start, fps)}`
    : start === 0 && clip.durationInFrames >= total - 1
      ? 'under the whole video'
      : `at ${formatTimecode(start, fps)}–${formatTimecode(start + clip.durationInFrames, fps)}`;
  const parts = [`added ${where}`, `volume ${pct(clip.volume)}`];
  if (clip.fadeInFrames) parts.push(`fade-in ${secs(clip.fadeInFrames, fps)}`);
  if (clip.fadeOutFrames) parts.push(`fade-out ${secs(clip.fadeOutFrames, fps)}`);
  if (clip.volumeEnvelope?.length) parts.push(envelopeText(clip.volumeEnvelope));
  return parts.join(', ');
}

/**
 * Every audio clip that differs between two documents, in words, for the
 * review's summary: added and removed clips, per changed clip what changed
 * (volume, fades, start, length, trim, scene, file, name, envelope), and last
 * the sound effects that only move because their scene moved.
 */
export function describeAudioChanges(before: Project, after: Project): AudioChange[] {
  if (before.audio === after.audio && before.scenes === after.scenes) return [];
  const fps = after.fps;
  const old = new Map(before.audio.map((c) => [c.id, c]));
  const out: AudioChange[] = [];
  const moved: AudioChange[] = [];
  for (const clip of after.audio) {
    const prev = old.get(clip.id);
    const frame = audioClipStartFrame(after, clip);
    if (!prev) {
      out.push({ clipId: clip.id, name: clip.name, frame, text: `${clip.name}: ${addedText(after, clip)}` });
      continue;
    }
    if (prev === clip && audioClipStartFrame(before, prev) === frame) continue;
    const parts: (string | null)[] = [];
    if (prev.name !== clip.name) parts.push(`renamed from “${prev.name}”`);
    if (prev.assetId !== clip.assetId) parts.push(`file “${before.assets[prev.assetId]?.name ?? prev.assetId}” → “${after.assets[clip.assetId]?.name ?? clip.assetId}”`);
    if (prev.sceneId !== clip.sceneId) parts.push(clip.sceneId ? `anchored to ${sceneName(after, clip.sceneId)}` : 'moved to the project timeline');
    if (prev.volume !== clip.volume) parts.push(`volume ${pct(prev.volume)} → ${pct(clip.volume)}`);
    parts.push(fadeText('fade-in', prev.fadeInFrames, clip.fadeInFrames, fps), fadeText('fade-out', prev.fadeOutFrames, clip.fadeOutFrames, fps));
    const was = audioClipStartFrame(before, prev);
    // A sound effect that only rides along with its retimed scene.
    if (prev === clip) {
      moved.push({ clipId: clip.id, name: clip.name, frame, text: `${clip.name}: moves with ${sceneName(after, clip.sceneId)}, ${formatTimecode(was, fps)} → ${formatTimecode(frame, fps)}` });
      continue;
    }
    if (was !== frame) parts.push(`starts ${formatTimecode(was, fps)} → ${formatTimecode(frame, fps)}`);
    if (prev.durationInFrames !== clip.durationInFrames) parts.push(`length ${secs(prev.durationInFrames, fps)} → ${secs(clip.durationInFrames, fps)}`);
    if (prev.trimStartFrames !== clip.trimStartFrames) parts.push(`trim ${secs(prev.trimStartFrames, fps)} → ${secs(clip.trimStartFrames, fps)}`);
    const envA = prev.volumeEnvelope ?? [];
    const envB = clip.volumeEnvelope ?? [];
    if (envA.length !== envB.length || envA.some((p, i) => p.frame !== envB[i].frame || p.value !== envB[i].value)) parts.push(envelopeText(envB));
    const shown = parts.filter((p): p is string => !!p);
    if (shown.length) out.push({ clipId: clip.id, name: clip.name, frame, text: `${clip.name}: ${shown.join(', ')}` });
  }
  const now = new Set(after.audio.map((c) => c.id));
  for (const clip of before.audio) {
    if (!now.has(clip.id)) out.push({ clipId: clip.id, name: clip.name, frame: audioClipStartFrame(before, clip), text: `${clip.name}: removed` });
  }
  return [...out, ...moved];
}

