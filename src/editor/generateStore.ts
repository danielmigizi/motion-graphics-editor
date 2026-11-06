// The Generate tab's state (GenerateTab.tsx): the draft request, the models
// and key status from the local server, the price quote, and the job queue.
// Jobs arrive as `generation-job` events (agentBridge.ts) and from a fetch on
// project open and on reconnect; either way a finished job for the open
// project is delivered here: once no drag is in progress its takes become
// project assets in one undo step (once per document session, so Undo
// sticks), and the server is told (POST …/delivered); takes a later document
// lacks are offered on the job's row, never re-added by themselves. The
// draft's project frames remember where they came from and follow the scenes
// (refreshFrames); a scored bed's plan and narration's lines are rebuilt the
// same way, keeping what was written for scenes still there (scoring.ts).
// Takes are assets only: placing one in the video goes through "Use this
// take" (TakesPanel.tsx) or a job row's Place buttons, both proposals.
// The server may be down or have no key: every call degrades to a state the
// tab can explain, never a throw.

import { create } from 'zustand';
import { excerpt } from '../core/generation';
import { JOB_KINDS, type FrameSource, type GenerateRequest, type GenerationJob, type GenerationJobStatus, type GenerationModelsResponse, type GenerationQuote, type GenerationScoreboard, type GenerationStatus, type JobKind, type JobSettings, type RoutePolicy, type RouteSuggestion } from '../core/generationStudio';
import { buildScorePlan, narrationLines, planProblem } from '../core/scorePlan';
import { locateFrame, projectDurationInFrames, sceneStartFrame } from '../core/timing';
import type { Asset, Project, Scene, TransitionType } from '../core/types';
import { api, ApiRequestError, ServerDownError } from './api';
import { useLayout } from './layout';
import { mergeNarrationLines, mergeScorePlan } from './scoring';
import { useEditor, whenEditorIdle } from './store';

/** Phase A media, and video (Phase B). */
export type GenerateMode = 'music' | 'voice' | 'sfx' | 'image' | 'video';

/** `short`: what the media switch says when the column is too narrow for the full word (generate.css). */
export const GENERATE_MODES: { id: GenerateMode; label: string; short?: string }[] = [
  { id: 'music', label: 'Music' },
  { id: 'voice', label: 'Voice-over', short: 'Voice' },
  { id: 'sfx', label: 'Sound effect', short: 'SFX' },
  { id: 'image', label: 'Image' },
  { id: 'video', label: 'Video' },
];

export interface GenerateDraft {
  mode: GenerateMode;
  job: JobKind;
  prompt: string;
  /** null = the routed default for the policy. */
  model: string | null;
  /** null = the settings policy. */
  policy: RoutePolicy | null;
  settings: JobSettings;
  /** 1–4. */
  takes: number;
  regenerateOf?: string;
  /** Frames dropped because their scene was deleted, by slot: what the tab says until another is picked. */
  lostFrames?: LostFrames;
  /**
   * Music for one scene (Generate music for this scene): its length, and
   * where Use this take puts the take. Narration for one scene (More like
   * this on a line's take): the only line asked for. Never sent.
   */
  forScene?: string;
}

/** What a frame slot lost, in words ("The end of “Show”, which was deleted"). */
export type LostFrames = Partial<Record<'start' | 'end' | 'keyframes', string>>;

/** Plain choice text while the server's own labels (models.jobs[].label) are not loaded. */
export const JOB_LABELS: Record<JobKind, string> = {
  'music.bed': 'Music bed for the whole video',
  'music.scored': 'Music scored to the cut',
  'voice.line': 'A short line',
  'voice.narration': 'Narration, a line per scene',
  'sfx.hit': 'A single hit',
  'sfx.ambience': 'Ambience that loops',
  'image.generate': 'A still image',
  'image.cutout': 'Cutout with transparent background',
  'image.typography': 'Image with text in it',
  'image.plate': 'Wide or high-resolution background',
  'image.edit': 'Change one thing in a project image',
  'image.composite': 'Combine project images',
  'video.generate': 'A clip from text',
  'video.animate': 'Animate this image',
  'video.between': 'Between two frames (across a cut)',
  'video.keyframes': 'Through pinned keyframes',
  'video.reference': 'Keep a subject consistent across shots',
  'video.long': 'Longer clip, or from a document or web page',
};

/** Sound effects take at most this many characters of prompt. */
export const SFX_PROMPT_MAX = 450;
export const MAX_TAKES = 4;

export const modeOf = (job: JobKind): GenerateMode => job.slice(0, job.indexOf('.')) as GenerateMode;
export const jobsOf = (mode: GenerateMode): JobKind[] => JOB_KINDS.filter((j) => modeOf(j) === mode);

/** Aspect ratios offered for images, widest first. */
export const ASPECT_RATIOS = ['21:9', '16:9', '3:2', '4:3', '1:1', '4:5', '3:4', '2:3', '9:16'] as const;

/** Aspect ratios video models take, widest first. */
export const VIDEO_ASPECTS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const;

/** The offered ratio closest to the video's frame. */
export function aspectFor(width: number, height: number, ratios: readonly string[] = ASPECT_RATIOS): string {
  const want = Math.log(width / height);
  let best: string = '16:9';
  let gap = Infinity;
  for (const r of ratios) {
    const [w, h] = r.split(':').map(Number);
    const d = Math.abs(Math.log(w / h) - want);
    if (d < gap) [best, gap] = [r, d];
  }
  return best;
}

/** The whole video, in seconds, within music's 3–600 s. */
export const videoSeconds = (project: Project) => Math.min(600, Math.max(3, Math.round(projectDurationInFrames(project) / project.fps)));

/** Music for one scene: whole seconds, never shorter than the scene (the clip trims to it), within 3–600 s. */
export function sceneMusicSeconds(project: Project, sceneId: string): number {
  const scene = project.scenes.find((s) => s.id === sceneId);
  return Math.min(600, Math.max(3, Math.ceil((scene ? scene.durationInFrames / project.fps : 3) - 1e-6)));
}

// ---------------------------------------------------------------------------
// Video (Phase B): the length from the scene, frames of the video, keyframes, references.
// ---------------------------------------------------------------------------

/** A generated clip's length, seconds (the widest range the video models take). */
export const VIDEO_SECONDS = { min: 2, max: 30 } as const;
/** video.keyframes: how many frames can be pinned. */
export const KEYFRAME_COUNT = { min: 3, max: 10 } as const;
/** video.reference: what the reference models take. */
export const VIDEO_REFERENCE_LIMITS = { images: 9, clips: 3, clipSeconds: 15 } as const;

/** The scene a request is about: the given (selected) one, else the first. */
function sceneOf(project: Project, sceneId?: string | null): Scene | undefined {
  return project.scenes.find((s) => s.id === sceneId) ?? project.scenes[0];
}

/** The scene's length in seconds, unrounded (null without scenes). */
export function sceneSeconds(project: Project, sceneId?: string | null): number | null {
  const scene = sceneOf(project, sceneId);
  return scene ? scene.durationInFrames / project.fps : null;
}

/** A clip as long as the scene, in whole seconds within 2–30 s. */
export function videoLengthFor(project: Project, sceneId?: string | null): number {
  const s = sceneSeconds(project, sceneId) ?? 5;
  return Math.min(VIDEO_SECONDS.max, Math.max(VIDEO_SECONDS.min, Math.round(s)));
}

/** A transition or keyframed clip is a bridge, not a scene: it starts at this length, whatever the scene's. */
export const BRIDGE_SECONDS = 5;

/** The length a job starts at: a bridge for transitions and keyframes, the selected scene's for the rest. */
export function usualVideoLength(job: JobKind, project: Project, sceneId?: string | null): number {
  return job === 'video.between' || job === 'video.keyframes' ? BRIDGE_SECONDS : videoLengthFor(project, sceneId);
}

/**
 * How many of a scene's first frames its entrance transition covers (a fade
 * or zoom starts transparent, a slide or wipe off-frame): 0 without one. The
 * frame after them is the scene's first fully visible frame.
 */
export function entranceFrames(scene: Scene): number {
  const t = scene.transitionIn;
  return t && t.type !== 'none' && t.durationInFrames > 0 ? Math.min(t.durationInFrames, scene.durationInFrames - 1) : 0;
}

/** The cut after a scene: its last frame, and the next scene's first fully visible one (null when it is the last scene). */
export interface SceneCut {
  scene: Scene;
  next: Scene | null;
  /** Project frame: the scene's last. */
  end: number;
  /** Project frame: the next scene's first fully visible one (after its entrance transition, if it has one). */
  start: number | null;
  /** The next scene's entrance transition, when `start` waits for it. */
  entrance: TransitionType | null;
}

export function cutAfter(project: Project, sceneId?: string | null): SceneCut | null {
  const scene = sceneOf(project, sceneId);
  if (!scene) return null;
  const next = project.scenes[project.scenes.indexOf(scene) + 1] ?? null;
  const after = sceneStartFrame(project, scene.id) + scene.durationInFrames;
  const hidden = next ? entranceFrames(next) : 0;
  return { scene, next, end: after - 1, start: next ? after + hidden : null, entrance: next && hidden ? next.transitionIn.type : null };
}

/**
 * Where a project frame came from, kept beside it in the draft (never sent):
 * a scene's last frame, its first fully visible frame, or a frame picked at a
 * time. Scene edges follow the scene when the video changes; a picked frame
 * stays where it is and says when it has moved into another scene.
 */
export interface FrameOrigin {
  sceneId: string;
  /** The scene's name when last seen, to say what went missing. */
  sceneName: string;
  edge: 'start' | 'end' | 'frame';
}

/** A frame in the draft: what the server gets, plus where a project frame came from. */
export type DraftFrame = FrameSource & { from?: FrameOrigin };

const originOf = (f?: FrameSource): FrameOrigin | undefined => (f && 'projectFrame' in f ? (f as DraftFrame).from : undefined);

/** A scene's first fully visible frame, or its last, as a project frame. */
function edgeOf(project: Project, scene: Scene, edge: 'start' | 'end'): number {
  const start = sceneStartFrame(project, scene.id);
  return edge === 'end' ? start + scene.durationInFrames - 1 : start + entranceFrames(scene);
}

/** A scene's edge as a draft frame that follows the scene. */
export function sceneEdgeFrame(project: Project, scene: Scene, edge: 'start' | 'end'): DraftFrame {
  return { projectFrame: edgeOf(project, scene, edge), from: { sceneId: scene.id, sceneName: scene.name, edge } };
}

/** A frame picked at a time (the playhead): it stays put; the scene it was in is remembered. */
export function pickedFrame(project: Project, frame: number): DraftFrame {
  const at = locateFrame(project, frame);
  return at ? { projectFrame: frame, from: { sceneId: at.scene.id, sceneName: at.scene.name, edge: 'frame' } } : { projectFrame: frame };
}

/** Where a frame that arrived without one (a take's request, a prefill) sits now: a scene edge if it is on one, else a picked frame. */
function inferOrigin(f: FrameSource, project: Project): FrameSource {
  if (!('projectFrame' in f) || originOf(f)) return f;
  const at = locateFrame(project, f.projectFrame);
  if (!at || f.projectFrame >= projectDurationInFrames(project)) return f;
  const edge = at.frameInScene === at.scene.durationInFrames - 1 ? 'end' : at.frameInScene === entranceFrames(at.scene) ? 'start' : 'frame';
  return { projectFrame: f.projectFrame, from: { sceneId: at.scene.id, sceneName: at.scene.name, edge } } as DraftFrame;
}

/** The frame as the server takes it. */
const bareFrame = (f: FrameSource): FrameSource => ('assetId' in f ? { assetId: f.assetId } : { projectFrame: f.projectFrame });

/** Every frame in the settings, with an origin for any project frame that came without one. */
function withOrigins(s: JobSettings, project: Project): JobSettings {
  const out = { ...s };
  if (out.start) out.start = inferOrigin(out.start, project);
  if (out.end) out.end = inferOrigin(out.end, project);
  if (out.keyframes) out.keyframes = out.keyframes.map((k) => ({ ...k, frame: inferOrigin(k.frame, project) }));
  return out;
}

const deletedText = (o: FrameOrigin) => `${o.edge === 'end' ? 'The end' : 'The start'} of “${o.sceneName}”, which was deleted`;

/** One frame again from its origin: moved with its scene, or gone with it. */
function rederive(f: FrameSource | undefined, project: Project): { frame: FrameSource | undefined; lost?: FrameOrigin } {
  const from = originOf(f);
  if (!f || !from || from.edge === 'frame') return { frame: f };
  const scene = project.scenes.find((s) => s.id === from.sceneId);
  if (!scene) return { frame: undefined, lost: from };
  const projectFrame = edgeOf(project, scene, from.edge);
  if ('projectFrame' in f && f.projectFrame === projectFrame && scene.name === from.sceneName) return { frame: f };
  return { frame: { projectFrame, from: { ...from, sceneName: scene.name } } as DraftFrame };
}

/**
 * The draft's project frames again after the video changed (scene lengths,
 * order, entrances, a deleted scene): scene edges follow their scenes; a frame
 * whose scene is gone is cleared and said. Null when nothing moved.
 */
export function refreshFrames(s: JobSettings, project: Project): { settings: JobSettings; lost: LostFrames } | null {
  const out: JobSettings = { ...s };
  const lost: LostFrames = {};
  let changed = false;
  for (const slot of ['start', 'end'] as const) {
    const r = rederive(s[slot], project);
    if (r.frame === s[slot]) continue;
    changed = true;
    if (r.frame) out[slot] = r.frame;
    else delete out[slot];
    if (r.lost) lost[slot] = deletedText(r.lost);
  }
  if (s.keyframes) {
    const gone: FrameOrigin[] = [];
    const keys = s.keyframes.flatMap((k) => {
      const r = rederive(k.frame, project);
      if (r.frame === k.frame) return [k];
      changed = true;
      if (!r.frame) {
        gone.push(r.lost!);
        return [];
      }
      return [{ ...k, frame: r.frame }];
    });
    out.keyframes = keys;
    if (gone.length) lost.keyframes = `Removed ${gone.length === 1 ? 'a pinned frame' : `${gone.length} pinned frames`}: ${gone.map(deletedText).join('; ')}.`;
  }
  return changed ? { settings: out, lost } : null;
}

/** A picked frame that now lies in another scene than when it was picked (or past the end), in words; null when it is where it was. */
export function frameWarning(f: FrameSource | undefined, project: Project): string | null {
  const from = originOf(f);
  if (!f || !from || from.edge !== 'frame' || !('projectFrame' in f)) return null;
  if (f.projectFrame >= projectDurationInFrames(project)) return 'This frame is now past the end of the video. Pick it again.';
  const at = locateFrame(project, f.projectFrame);
  if (!at || at.scene.id === from.sceneId) return null;
  return `Picked in “${from.sceneName}”; scenes have changed and this time is now in “${at.scene.name}”.`;
}

/** The scenes either side of the cut a start and end frame span ("Across the cut from Intro to Product"); null when they are not exactly a cut. */
export function acrossCut(project: Project, start?: FrameSource, end?: FrameSource): { from: Scene; to: Scene } | null {
  if (!start || !end || !('projectFrame' in start) || !('projectFrame' in end)) return null;
  const at = locateFrame(project, start.projectFrame);
  if (!at || at.frameInScene !== at.scene.durationInFrames - 1) return null;
  const cut = cutAfter(project, at.scene.id);
  if (!cut?.next || cut.start === null) return null;
  // The next scene's first frame counts too (a request from before entrances were waited for, or picked by hand).
  return end.projectFrame === cut.start || end.projectFrame === cut.end + 1 ? { from: cut.scene, to: cut.next } : null;
}

/** A first and last frame that came from either side of a cut whose scenes no longer meet: "“Show” no longer comes right after “Open”". */
export function brokenCut(project: Project, start?: FrameSource, end?: FrameSource): string | null {
  const a = originOf(start);
  const b = originOf(end);
  if (a?.edge !== 'end' || b?.edge !== 'start' || acrossCut(project, start, end)) return null;
  const i = project.scenes.findIndex((s) => s.id === a.sceneId);
  if (i < 0 || !project.scenes.some((s) => s.id === b.sceneId) || project.scenes[i + 1]?.id === b.sceneId) return null;
  return `“${b.sceneName}” no longer comes right after “${a.sceneName}”.`;
}

export const sameFrame = (a?: FrameSource, b?: FrameSource): boolean =>
  !!a && !!b && ('assetId' in a ? 'assetId' in b && a.assetId === b.assetId : 'projectFrame' in b && a.projectFrame === b.projectFrame);

/** "8 s", "2.5 s". */
export const secondsText = (s: number) => `${Number.isInteger(s) ? s : s.toFixed(1)} s`;

/** A frame source in words: the image's name, "End of Intro", "Start of Product", "Start of Product (after its fade)", "Intro at 2.5 s". */
export function frameSourceLabel(src: FrameSource, project: Project): string {
  if ('assetId' in src) return project.assets[src.assetId]?.name ?? 'An image no longer in the project';
  const at = locateFrame(project, src.projectFrame);
  if (!at) return `Frame ${src.projectFrame}`;
  if (at.frameInScene === at.scene.durationInFrames - 1) return `End of ${at.scene.name}`;
  if (at.frameInScene === 0) return `Start of ${at.scene.name}`;
  const hidden = entranceFrames(at.scene);
  if (hidden && at.frameInScene === hidden) return `Start of ${at.scene.name} (after its ${at.scene.transitionIn.type})`;
  return `${at.scene.name} at ${secondsText(Math.round((at.frameInScene / project.fps) * 10) / 10)}`;
}

/** Where to pin a new keyframe: the clip's start, its end, then the middle of the widest gap (0.1 s steps). */
export function nextKeyframeTime(times: number[], length: number): number {
  if (!times.includes(0)) return 0;
  if (!times.some((t) => t >= length)) return length;
  const sorted = [...times].sort((a, b) => a - b);
  let best = 0;
  let gap = -1;
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > gap) [best, gap] = [(sorted[i] + sorted[i - 1]) / 2, sorted[i] - sorted[i - 1]];
  }
  return Math.round(best * 10) / 10;
}

export type PinnedFrame = NonNullable<JobSettings['keyframes']>[number];

/** Keyframes in time order (the editor keeps them so). */
export const sortKeyframes = (keyframes: PinnedFrame[]) => [...keyframes].sort((a, b) => a.atSeconds - b.atSeconds);

/** video.reference: the chosen images and clips, and the clips' seconds (asset lengths are in project frames). */
export function referenceTally(ids: string[], project: Project): { images: number; clips: number; clipSeconds: number } {
  let images = 0;
  let clips = 0;
  let frames = 0;
  for (const id of ids) {
    const a = project.assets[id];
    if (a?.kind === 'image') images++;
    else if (a?.kind === 'video') {
      clips++;
      frames += a.durationInFrames ?? 0;
    }
  }
  return { images, clips, clipSeconds: frames / project.fps };
}

/**
 * video.reference: each chosen asset's name as the model sees it. The server
 * sends images and clips as two lists, so they are numbered apart, in the
 * order chosen: "Image 1", "Video 1", "Image 2".
 */
export function referenceLabels(ids: string[], project: Project): Map<string, string> {
  const out = new Map<string, string>();
  let images = 0;
  let clips = 0;
  for (const id of ids) {
    const kind = project.assets[id]?.kind;
    if (kind === 'image') out.set(id, `Image ${++images}`);
    else if (kind === 'video') out.set(id, `Video ${++clips}`);
  }
  return out;
}

/** A full https address, as video.long needs. */
export function httpsUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/** The asset of the selected image element, when it is an image file. Also a useEditor selector. */
export function selectedImageAssetId(st: ReturnType<typeof useEditor.getState> = useEditor.getState()): string | undefined {
  const scene = st.doc.project.scenes.find((s) => s.id === st.selection.sceneId);
  const el = scene?.elements.find((e) => e.id === st.selection.elementId);
  if (el?.type !== 'image') return undefined;
  const id = String(el.props.assetId ?? '');
  return st.doc.project.assets[id]?.kind === 'image' ? id : undefined;
}

/** A job's settings filled from the video: its format, its length (a clip: the selected scene's; a transition or keyframes: 5 s), the selected image, the cut after the scene. */
export function jobDefaults(job: JobKind, project: Project, selectedImage?: string, sceneId?: string | null): JobSettings {
  if (modeOf(job) === 'video') {
    const s: JobSettings = { durationSeconds: usualVideoLength(job, project, sceneId), aspectRatio: aspectFor(project.width, project.height, VIDEO_ASPECTS), videoResolution: '1080p' };
    if (job === 'video.animate' && selectedImage) s.start = { assetId: selectedImage };
    if (job === 'video.between') {
      // Across the cut: the scene's last frame to the next scene's first fully visible one; both follow their scenes.
      const cut = cutAfter(project, sceneId);
      if (cut) s.start = sceneEdgeFrame(project, cut.scene, 'end');
      if (cut?.next) s.end = sceneEdgeFrame(project, cut.next, 'start');
    }
    if (job === 'video.keyframes') s.keyframes = [];
    if (job === 'video.reference') s.referenceAssetIds = selectedImage ? [selectedImage] : [];
    return s;
  }
  switch (job) {
    case 'music.bed':
      return { durationSeconds: videoSeconds(project), instrumental: true };
    case 'music.scored':
      // A section per scene, its direction from the story beat; the length is the video's.
      return { score: buildScorePlan(project) };
    case 'sfx.hit':
      return { durationSeconds: 2 };
    case 'sfx.ambience':
      return { durationSeconds: 10, loop: true };
    case 'voice.line':
      return {};
    case 'voice.narration':
      // A line per scene, from its story beat.
      return { lines: narrationLines(project) };
    default: {
      const s: JobSettings = { aspectRatio: aspectFor(project.width, project.height), resolution: job === 'image.plate' ? '2k' : '1k' };
      if (job === 'image.edit' || job === 'image.composite') s.referenceAssetIds = selectedImage ? [selectedImage] : [];
      return s;
    }
  }
}

const clampTakes = (n: number) => Math.min(MAX_TAKES, Math.max(1, Math.round(n) || 1));

/** The job's defaults for what the editor shows now: the open project, the selected scene and image. */
function defaultsNow(job: JobKind): JobSettings {
  const st = useEditor.getState();
  return jobDefaults(job, st.doc.project, selectedImageAssetId(st), st.selection.sceneId);
}

/** The draft after a change: a new job (or a `fresh` prefill) brings its own defaults and the routed model. */
function nextDraft(cur: GenerateDraft, patch: Partial<GenerateDraft>, fresh = false): GenerateDraft {
  const job = patch.job ?? (patch.mode && patch.mode !== cur.mode ? jobsOf(patch.mode)[0] : cur.job);
  const jobChanged = job !== cur.job;
  const base = jobChanged || fresh ? defaultsNow(job) : cur.settings;
  // A frame put in a slot replaces what the slot lost.
  const lost: LostFrames = jobChanged || fresh ? {} : { ...cur.lostFrames };
  for (const slot of ['start', 'end', 'keyframes'] as const) if (patch.settings && slot in patch.settings) delete lost[slot];
  return {
    ...cur,
    ...patch,
    mode: modeOf(job),
    job,
    model: patch.model !== undefined ? patch.model : jobChanged || fresh ? null : cur.model,
    // The scene a bed is for goes with a new job or prefill unless the prefill names it.
    forScene: 'forScene' in patch ? patch.forScene : jobChanged || fresh ? undefined : cur.forScene,
    settings: withOrigins({ ...base, ...patch.settings }, useEditor.getState().doc.project),
    takes: clampTakes(patch.takes ?? cur.takes),
    lostFrames: Object.keys(lost).length ? lost : undefined,
  };
}

/** What the request still needs before it can go, in words; null when it is complete. */
export function draftProblem(d: GenerateDraft, project: Project = useEditor.getState().doc.project): string | null {
  // Narration by scene: the lines are the words; the prompt box is not shown.
  if (d.job === 'voice.narration' && d.settings.lines) return d.settings.lines.some((l) => l.text.trim()) ? null : 'Write a line for at least one scene.';
  if (d.job === 'music.scored') {
    if (!d.prompt.trim()) return 'Describe the genre and instruments first.';
    const score = d.settings.score ?? [];
    if (score.length === 0) return 'Add a scene first: the music follows the scenes.';
    // The model's limits (sections, their lengths, the whole), said before the server would refuse.
    return planProblem(score);
  }
  if (!d.prompt.trim()) return d.mode === 'voice' ? 'Write the words to speak first.' : d.mode === 'video' ? 'Describe the shot first.' : 'Describe what to generate first.';
  if (d.mode === 'video') return videoProblem(d.job, d.settings, project);
  if (d.job === 'sfx.hit' || d.job === 'sfx.ambience') {
    if (d.prompt.length > SFX_PROMPT_MAX) return `Sound effect prompts take at most ${SFX_PROMPT_MAX} characters.`;
  }
  const refs = d.settings.referenceAssetIds ?? [];
  if (d.job === 'image.edit' && refs.length === 0) return 'Pick the image to edit.';
  if (d.job === 'image.composite' && refs.length < 2) return refs.length ? 'Pick at least one more image to combine.' : 'Pick at least two images to combine.';
  return null;
}

/** A video request's gaps: frames to pick, keyframes to pin, references within the models' limits, an https link. */
function videoProblem(job: JobKind, s: JobSettings, project: Project): string | null {
  const length = s.durationSeconds ?? VIDEO_SECONDS.min;
  if (job === 'video.animate' && !s.start) return 'Pick the image to animate.';
  if (job === 'video.between') {
    if (!s.start) return 'Pick the first frame.';
    if (!s.end) return 'Pick the last frame.';
  }
  if (job === 'video.keyframes') {
    const keys = s.keyframes ?? [];
    if (keys.length < KEYFRAME_COUNT.min) return `Pin at least ${KEYFRAME_COUNT.min} frames (${keys.length} so far).`;
    if (keys.length > KEYFRAME_COUNT.max) return `Pin at most ${KEYFRAME_COUNT.max} frames.`;
    const late = keys.find((k) => k.atSeconds < 0 || k.atSeconds > length);
    if (late) return `A frame is pinned at ${secondsText(late.atSeconds)}, past the end of the ${secondsText(length)} clip.`;
    if (new Set(keys.map((k) => k.atSeconds)).size < keys.length) return 'Two frames are pinned at the same time.';
  }
  if (job === 'video.reference') {
    const { images, clips, clipSeconds } = referenceTally(s.referenceAssetIds ?? [], project);
    const L = VIDEO_REFERENCE_LIMITS;
    if (images + clips === 0) return 'Pick at least one image or clip of the subject.';
    if (images > L.images) return `Use at most ${L.images} images (${images} picked).`;
    if (clips > L.clips) return `Use at most ${L.clips} clips (${clips} picked).`;
    if (clipSeconds > L.clipSeconds) return `The clips run ${secondsText(Math.round(clipSeconds * 10) / 10)}; ${L.clipSeconds} s of video at most in total.`;
  }
  if (job === 'video.long') {
    const url = s.documentUrl || s.webUrl;
    if (url && !httpsUrl(url)) return 'The link must be a full https:// address.';
  }
  return null;
}

/** The settings a request carries: an empty link is left out; keyframes go in time order; where frames came from stays in the editor. */
function requestSettings(s: JobSettings): JobSettings {
  const out: JobSettings = { ...s };
  if (!out.documentUrl) delete out.documentUrl;
  if (!out.webUrl) delete out.webUrl;
  if (out.start) out.start = bareFrame(out.start);
  if (out.end) out.end = bareFrame(out.end);
  if (out.keyframes) out.keyframes = sortKeyframes(out.keyframes).map((k) => ({ ...k, frame: bareFrame(k.frame) }));
  // Narration: only the lines with words, trimmed; each becomes a take tagged with its scene.
  if (out.lines) out.lines = out.lines.map((l) => ({ sceneId: l.sceneId, text: l.text.trim() })).filter((l) => l.text);
  if (out.bpm === undefined) delete out.bpm;
  return out;
}

/** A narration request's prompt: a short label, "Narration · 4 lines" (the lines are in its settings; the job row shows the first). */
export const narrationLabel = (lines: number) => `Narration · ${lines} ${lines === 1 ? 'line' : 'lines'}`;

/** What a request says it is: the prompt, or for narration by scene a label naming how many lines (records stay readable). */
const requestPrompt = (d: GenerateDraft) => (d.job === 'voice.narration' && d.settings.lines ? narrationLabel(d.settings.lines.filter((l) => l.text.trim()).length) : d.prompt.trim());

/** Where a request's frames came from, in the order the request carries them (keyframes sorted). */
interface RequestOrigins {
  start?: FrameOrigin;
  end?: FrameOrigin;
  keyframes?: (FrameOrigin | null)[];
}

function requestOrigins(s: JobSettings): RequestOrigins | null {
  const o: RequestOrigins = {};
  if (originOf(s.start)) o.start = originOf(s.start);
  if (originOf(s.end)) o.end = originOf(s.end);
  if (s.keyframes?.some((k) => originOf(k.frame))) o.keyframes = sortKeyframes(s.keyframes).map((k) => originOf(k.frame) ?? null);
  return Object.keys(o).length ? o : null;
}

/** A request's frames with the origins they were sent with put back beside them (More like this). */
function restoreOrigins(s: JobSettings, o: RequestOrigins): JobSettings {
  const put = (f: FrameSource | undefined, from: FrameOrigin | null | undefined) => (f && from && 'projectFrame' in f ? ({ projectFrame: f.projectFrame, from } as DraftFrame) : f);
  const out = { ...s, start: put(s.start, o.start), end: put(s.end, o.end) };
  if (!out.start) delete out.start;
  if (!out.end) delete out.end;
  if (s.keyframes && o.keyframes?.length === s.keyframes.length) out.keyframes = s.keyframes.map((k, i) => ({ ...k, frame: put(k.frame, o.keyframes![i])! }));
  return out;
}

// ---------------------------------------------------------------------------
// Remembered per browser (a convenience, never in a document, like layout.ts):
// the last mode and job, where each request's frames came from, so More
// like this follows the scenes as they are now, and the scene a bed was made
// for, so Use this take puts it there.
// ---------------------------------------------------------------------------

const PREFS_KEY = 'mge.generate';
/** Requests whose frame origins (and scenes) are kept. */
const MAX_REMEMBERED = 30;

interface GeneratePrefs {
  job: JobKind;
  /** Request (job) id → where its frames came from; newest last. */
  origins: Record<string, RequestOrigins>;
  /** Request (job) id → the scene its music was made for; newest last. */
  scenes: Record<string, string>;
}

const isRecord = (v: unknown): v is Record<string, never> => !!v && typeof v === 'object' && !Array.isArray(v);

export function parseGeneratePrefs(raw: string | null | undefined): GeneratePrefs {
  const prefs: GeneratePrefs = { job: 'music.bed', origins: {}, scenes: {} };
  try {
    const v = JSON.parse(raw ?? '{}') as Partial<GeneratePrefs>;
    if (typeof v.job === 'string' && JOB_KINDS.includes(v.job)) prefs.job = v.job;
    if (isRecord(v.origins)) prefs.origins = v.origins;
    if (isRecord(v.scenes)) prefs.scenes = Object.fromEntries(Object.entries(v.scenes as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    // Unreadable: start from Music.
  }
  return prefs;
}

function readPrefs(): GeneratePrefs {
  try {
    return parseGeneratePrefs(localStorage.getItem(PREFS_KEY));
  } catch {
    return parseGeneratePrefs(null);
  }
}

function writePrefs(patch: Partial<GeneratePrefs>): void {
  try {
    const next = { ...readPrefs(), ...patch };
    for (const map of [next.origins, next.scenes]) {
      const ids = Object.keys(map);
      for (const id of ids.slice(0, Math.max(0, ids.length - MAX_REMEMBERED))) delete map[id];
    }
    localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the tab still works, it just starts on Music next time.
  }
}

/** After a request starts: where its frames came from, the scene it is for, and the job it was (the tab opens on it next time). */
function rememberRequest(jobId: string, draft: GenerateDraft): void {
  const o = requestOrigins(draft.settings);
  const prefs = readPrefs();
  writePrefs({ job: draft.job, ...(o ? { origins: { ...prefs.origins, [jobId]: o } } : {}), ...(draft.forScene ? { scenes: { ...prefs.scenes, [jobId]: draft.forScene } } : {}) });
}

/** The scene a request's music was made for (Generate music for this scene), when this browser started it. */
export const takeSceneOf = (requestId: string): string | undefined => readPrefs().scenes[requestId];

/** "Music for Show": what music made for one scene is called, in place of "Music bed for the whole video". */
export const sceneMusicLabel = (sceneName: string) => `Music for ${sceneName}`;

/** A job row's label: music made for one scene says which (when this browser started it and the scene is still there); any other, `label`. */
export function jobRowLabel(job: GenerationJob, project: Project, label: string): string {
  if (job.job !== 'music.bed') return label;
  const scene = project.scenes.find((s) => s.id === takeSceneOf(job.id));
  return scene ? sceneMusicLabel(scene.name) : label;
}

/** What a job row quotes: the prompt, or for narration by scene its first line ("… + 3 more"), with every line in the tooltip. */
export function jobPromptText(job: GenerationJob): { text: string; title: string } | null {
  const lines = job.job === 'voice.narration' ? (job.settings.lines ?? []).filter((l) => l.text.trim()) : [];
  if (lines.length) return { text: `“${excerpt(lines[0].text, 120)}”${lines.length > 1 ? ` + ${lines.length - 1} more` : ''}`, title: lines.map((l) => l.text).join('\n') };
  return job.prompt ? { text: `“${excerpt(job.prompt, 120)}”`, title: job.prompt } : null;
}

export function toRequest(d: GenerateDraft, projectId: string): GenerateRequest {
  return {
    job: d.job,
    prompt: requestPrompt(d),
    ...(d.model ? { model: d.model } : {}),
    ...(d.policy ? { policy: d.policy } : {}),
    settings: requestSettings(d.settings),
    takes: d.takes,
    projectId,
    ...(d.regenerateOf ? { regenerateOf: d.regenerateOf } : {}),
  };
}

/** The local server: unknown before the first answer, offline when it is not running. */
export type GenerateLink = 'unknown' | 'up' | 'offline';

interface GenerateState {
  draft: GenerateDraft;
  link: GenerateLink;
  status: GenerationStatus | null;
  models: GenerationModelsResponse | null;
  /** Your results and the open route suggestions: why Balanced picks what it does before a prompt is priced (null until loaded, or from an older server). */
  scoreboard: GenerationScoreboard | null;
  /** The price of the last draft asked about (null while it is incomplete or not yet asked). */
  quote: GenerationQuote | null;
  /** The draft `quote` (or `quoteError`) answers: the button waits until it is the current one. */
  quoteFor: GenerateDraft | null;
  /** statusStamp(status) when the quote was asked for: a changed budget, spend, policy or key makes it stale. */
  quoteStamp: string | null;
  quoting: boolean;
  /** Why the server would not price the draft, in its words. */
  quoteError: string | null;
  submitting: boolean;
  /** A refusal from the server for the last Generate click, shown under the button. */
  submitError: string | null;
  /** Every job heard this server run, newest first (the tab shows the open project's). */
  jobs: GenerationJob[];
  /** `fresh`: the settings start again from the job's defaults (a prefill from an action or a take), not from the current draft's. */
  setDraft: (patch: Partial<GenerateDraft>, fresh?: boolean) => void;
}

/** The tab opens on the mode and job used last in this browser. */
const initialDraft = (): GenerateDraft => {
  const { job } = readPrefs();
  return { mode: modeOf(job), job, prompt: '', model: null, policy: null, settings: defaultsNow(job), takes: 1 };
};

/** Waiting, queued, running or importing: its row pulses and its time ticks. */
export const ACTIVE_STATUSES: readonly GenerationJobStatus[] = ['awaiting-permission', 'queued', 'running', 'importing'];

/** When this page opened. */
export const PAGE_OPENED_AT = Date.now();

/** How long a job has run (or ran), from the server's timestamps: a reload does not restart the count. */
export const jobElapsedMs = (job: GenerationJob, now: number) => Math.max(0, (job.finishedAt ?? now) - (job.startedAt ?? job.createdAt));

/** "8 s", "1:05". */
export function elapsedText(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * An active job that began before this page opened (a reload, or the editor
 * opened again while the server kept working), said on its row. The server's
 * own note (e.g. "Resumed after a restart") is shown instead when it has one.
 */
export function carriedOverNote(job: GenerationJob, openedAt = PAGE_OPENED_AT): string | null {
  if (job.note || !ACTIVE_STATUSES.includes(job.status) || job.createdAt >= openedAt) return null;
  return 'Started before this page opened';
}

export const useGenerate = create<GenerateState>((set, get) => ({
  draft: initialDraft(),
  link: 'unknown',
  status: null,
  models: null,
  scoreboard: null,
  quote: null,
  quoteFor: null,
  quoteStamp: null,
  quoting: false,
  quoteError: null,
  submitting: false,
  submitError: null,
  jobs: [],
  setDraft: (patch, fresh) => {
    const before = get().draft.job;
    set({ draft: nextDraft(get().draft, patch, fresh), submitError: null });
    const { job } = get().draft;
    if (job !== before) writePrefs({ job });
  },
}));

/** The draft's frames again for the video as it is now (see refreshFrames); a no-op when nothing moved. */
function refreshDraftFrames(project: Project = useEditor.getState().doc.project): void {
  const { draft } = useGenerate.getState();
  const r = refreshFrames(draft.settings, project);
  if (!r) return;
  const lostFrames = { ...draft.lostFrames, ...r.lost };
  useGenerate.setState({ draft: { ...draft, settings: r.settings, lostFrames: Object.keys(lostFrames).length ? lostFrames : undefined } });
}

/**
 * A scored bed's plan and narration's lines again for the scenes as they are
 * now (added, removed, lengthened, renamed), keeping the styles and words
 * already written for scenes still there; a no-op when nothing changed.
 */
function refreshDraftPlan(project: Project = useEditor.getState().doc.project): void {
  const { draft } = useGenerate.getState();
  const s = draft.settings;
  const next: JobSettings = { ...s };
  if (draft.job === 'music.scored' && s.score) next.score = mergeScorePlan(s.score, buildScorePlan(project));
  else if (draft.job === 'voice.narration' && s.lines) {
    const lines = mergeNarrationLines(s.lines, narrationLines(project));
    // Asked for one scene's line: that line only (none once its scene is deleted).
    next.lines = draft.forScene ? lines.filter((l) => l.sceneId === draft.forScene) : lines;
  } else return;
  if (JSON.stringify(next) !== JSON.stringify(s)) useGenerate.setState({ draft: { ...draft, settings: next } });
}

/**
 * Switch the right column to Generate and prefill it. Used by actions and by
 * the Takes panel's "More like this". `fresh`: the job's defaults plus the
 * prefill, whatever the draft held before (a take's exact request, a scene's cut).
 * More like this (`regenerateOf`) puts back where that request's frames came
 * from, so they follow the scenes as they are now.
 */
export function openGenerate(draft: Partial<GenerateDraft>, fresh = false): void {
  const origins = draft.regenerateOf && draft.settings ? readPrefs().origins[draft.regenerateOf] : undefined;
  const prefill = origins ? { ...draft, settings: restoreOrigins(draft.settings!, origins) } : draft;
  // A prefill without its own regenerateOf is a new request, not "more like" the last one;
  // one without its own scene is for the whole video (More like this keeps the scene its request was for).
  const forScene = draft.regenerateOf ? readPrefs().scenes[draft.regenerateOf] : undefined;
  useGenerate.getState().setDraft({ regenerateOf: undefined, forScene, ...prefill }, fresh);
  refreshDraftFrames();
  refreshDraftPlan();
  useLayout.getState().setRightTab('generate');
}

const MAX_JOBS = 50;

function upsert(jobs: GenerationJob[], job: GenerationJob): GenerationJob[] {
  const prev = jobs.find((j) => j.id === job.id);
  // An event sent before the delivery report can arrive after it: delivered never goes back.
  const next = prev?.delivered && !job.delivered ? { ...job, delivered: true } : job;
  return [next, ...jobs.filter((j) => j.id !== job.id)].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_JOBS);
}

function offline(e: unknown): boolean {
  if (!(e instanceof ServerDownError)) return false;
  useGenerate.setState({ link: 'offline' });
  return true;
}

/**
 * What a price and a refusal depend on besides the draft: the settings (budget,
 * confirmation threshold, policy, reserve), today's spend, the jobs holding
 * reservations, and the key. '' before the first answer.
 */
export function statusStamp(status: GenerationStatus | null): string {
  if (!status) return '';
  const { key, settings, spendTodayUsd, activeJobs } = status;
  return JSON.stringify([settings, spendTodayUsd, activeJobs, key.configured, key.valid ?? null, key.last4 ?? null, key.source ?? null]);
}

/** The quote answers the current draft under the current status. Also a useGenerate selector. */
export const quoteFresh = (s: Pick<GenerateState, 'quoteFor' | 'draft' | 'quoteStamp' | 'status'> = useGenerate.getState()) => s.quoteFor === s.draft && s.quoteStamp === statusStamp(s.status);

/** Key status, budget and today's spend. A change makes the quote stale and clears the last refusal (it may no longer hold). */
export async function refreshGenerationStatus(): Promise<void> {
  try {
    const status = await api.generationStatus();
    const changed = statusStamp(status) !== statusStamp(useGenerate.getState().status);
    useGenerate.setState({ status, link: 'up', ...(changed ? { submitError: null } : {}) });
  } catch (e) {
    // An older server without the studio answers 404: treat it like no key rather than offline.
    if (!offline(e)) useGenerate.setState({ link: 'up' });
  }
}

/** Status, the model list and the scoreboard (best effort: it only explains Balanced's pick); the tab calls it when it opens and when Settings closes. */
export async function loadGenerationStudio(): Promise<void> {
  await refreshGenerationStatus();
  if (useGenerate.getState().link !== 'up') return;
  const board = api.generationScoreboard().then(
    (scoreboard) => useGenerate.setState({ scoreboard }),
    () => undefined,
  );
  try {
    useGenerate.setState({ models: await api.generationModels() });
  } catch (e) {
    offline(e);
  }
  await board;
}

/** A route suggestion as GenerationSettings.dismissedSuggestions stores it: "<job>:<model>". */
export const suggestionKey = (s: Pick<RouteSuggestion, 'job' | 'to'>) => `${s.job}:${s.to}`;

/**
 * Why the routed model was picked, in words, for the draft's job under
 * `policy` with no model chosen, before (or without) a price: the route's own
 * reason when a quote for this job has one, else worked out as the router
 * does (an accepted suggestion, then for Balanced an open suggestion for the
 * job). Null when the policy's plain line says it all.
 */
export function routeReason(s: Pick<GenerateState, 'draft' | 'models' | 'status' | 'scoreboard' | 'quote' | 'quoteFor'>, policy: RoutePolicy): string | null {
  const { job } = s.draft;
  if (s.draft.model || policy === 'draft') return null;
  const quoted = s.quoteFor?.job === job && s.quote ? s.quote.route.reason : null;
  if (quoted?.startsWith('balanced: ')) return `Balanced: ${quoted.slice('balanced: '.length)}`;
  const route = s.models?.jobs.find((j) => j.job === job);
  if (!route || s.status?.settings.routeOverrides?.[job] === route.defaults[policy]) return null;
  if (policy !== 'balanced') return null;
  const dismissed = s.status?.settings.dismissedSuggestions ?? [];
  const open = s.scoreboard?.suggestions.find((x) => x.job === job && x.to === route.defaults.balanced && !dismissed.includes(suggestionKey(x)));
  if (open) return `Balanced: ${open.reason}`;
  return route.defaults.balanced === route.defaults.quality ? 'Balanced: no open suggestion for this job, so the quality default' : null;
}

let statusTimer: ReturnType<typeof setTimeout> | null = null;
/** Jobs change spend and the active count: refresh once a burst of events settles. */
function scheduleStatusRefresh() {
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusTimer = null;
    void refreshGenerationStatus();
  }, 400);
}

let quoteSeq = 0;
/** Price the current draft. Only the newest answer lands. */
export async function estimateDraft(): Promise<void> {
  const seq = ++quoteSeq;
  const { draft, status } = useGenerate.getState();
  const quoteStamp = statusStamp(status);
  if (draftProblem(draft)) {
    // Nothing to price yet: the tab says what is missing instead.
    useGenerate.setState({ quote: null, quoteFor: null, quoteStamp: null, quoting: false, quoteError: null });
    return;
  }
  useGenerate.setState({ quoting: true });
  try {
    const quote = await api.estimateGeneration(toRequest(draft, useEditor.getState().doc.project.id));
    if (seq === quoteSeq) useGenerate.setState({ quote, quoteFor: draft, quoteStamp, quoting: false, quoteError: null, link: 'up' });
  } catch (e) {
    if (seq !== quoteSeq) return;
    const down = offline(e);
    useGenerate.setState({ quote: null, quoteFor: down ? null : draft, quoteStamp, quoting: false, quoteError: e instanceof ApiRequestError ? e.message : null });
  }
}

/** Start the draft. `confirmed`: the person confirmed a price over the threshold. Returns the job, or null (the reason is in submitError). */
export async function submitDraft(confirmed = false): Promise<GenerationJob | null> {
  const { draft, submitting } = useGenerate.getState();
  if (submitting || draftProblem(draft)) return null;
  useGenerate.setState({ submitting: true, submitError: null });
  try {
    const { job } = await api.startGeneration(toRequest(draft, useEditor.getState().doc.project.id), confirmed);
    rememberRequest(job.id, draft);
    useGenerate.setState({ submitting: false, link: 'up' });
    applyGenerationJob(job);
    return job;
  } catch (e) {
    const down = offline(e);
    useGenerate.setState({ submitting: false, submitError: down ? 'The local server isn’t running.' : e instanceof Error ? e.message : String(e) });
    return null;
  }
}

export async function cancelGenerationJob(id: string): Promise<void> {
  try {
    applyGenerationJob(await api.cancelGeneration(id));
  } catch (e) {
    if (!offline(e)) useEditor.getState().toast({ tone: 'error', message: `Could not cancel: ${e instanceof Error ? e.message : String(e)}` });
  }
}

// Delivery has two halves kept apart. Applying the takes to the document
// happens once per job per document session, whatever the server says later:
// if the person undoes "Add N generated takes", a sync that still lists the
// job as undelivered (its acknowledgement failed) must not add them back.
// Acknowledging (POST …/delivered) is retried on the next event or sync
// until it succeeds.

/** `${docSession}\n${jobId}` → whether this editor added the job's takes in that document session (pending while it waits for a drag to end). */
const applied = new Map<string, Promise<boolean>>();
/** The keys of `applied` that settled as added. */
const appliedDone = new Set<string>();
/** Jobs the server has acknowledged as delivered, or whose acknowledgement is in flight. */
const acknowledged = new Set<string>();

const takesText = (n: number) => `${n} ${n === 1 ? 'take' : 'takes'}`;

/** Tell the server once; a failure leaves it for the next event or sync. */
async function acknowledge(jobId: string): Promise<void> {
  if (acknowledged.has(jobId)) return;
  acknowledged.add(jobId);
  try {
    const after = await api.generationDelivered(jobId);
    useGenerate.setState((s) => ({ jobs: upsert(s.jobs, after) }));
  } catch {
    acknowledged.delete(jobId);
  }
}

/** Once no drag is in progress, add the takes the document lacks as one undo step (an ordinary undo removes them). */
async function addTakes(job: GenerationJob, docSession: string): Promise<boolean> {
  await whenEditorIdle();
  const st = useEditor.getState();
  // Another document opened while the drag lasted: its own sync delivers there.
  if (st.docSession !== docSession) return false;
  const fresh = job.outputs.filter((a) => !Object.prototype.hasOwnProperty.call(st.doc.project.assets, a.id));
  if (!fresh.length) return true;
  const label = `Add ${fresh.length} generated ${fresh.length === 1 ? 'take' : 'takes'}`;
  if (!st.run({ type: 'batch', label, commands: fresh.map((asset) => ({ type: 'addAsset', asset })) }, label)) return false;
  st.toast({ tone: 'success', message: `${takesText(fresh.length)} ready in Assets › Generated` });
  return true;
}

/** A finished job for the open project: its takes go in once per document session, then the server is told. */
async function deliver(job: GenerationJob): Promise<void> {
  if (job.status !== 'done' || job.delivered || job.outputs.length === 0) return;
  const { docSession, doc } = useEditor.getState();
  if (job.projectId !== doc.project.id) return;
  const key = `${docSession}\n${job.id}`;
  let adding = applied.get(key);
  if (!adding) {
    adding = addTakes(job, docSession);
    applied.set(key, adding);
    // Not added (another document opened, or the command failed): a later sync may try again.
    void adding.then((ok) => (ok ? appliedDone.add(key) : applied.delete(key)));
  }
  if (await adding) await acknowledge(job.id);
}

/**
 * A finished job of the open project whose takes the document lacks, once
 * its own delivery is over: they went into a document since replaced (a
 * recovered revision, another open), or the person undid them. Its row offers
 * to add them; nothing re-adds them by itself. Empty while delivery is still
 * to come.
 */
export function missingTakes(job: GenerationJob, project: Project, docSession: string): Asset[] {
  if (job.status !== 'done' || job.projectId !== project.id || job.outputs.length === 0) return [];
  if (!job.delivered && !appliedDone.has(`${docSession}\n${job.id}`)) return [];
  return job.outputs.filter((a) => !Object.prototype.hasOwnProperty.call(project.assets, a.id));
}

/** "Add takes" on a job row: the takes the document lacks, as one undo step, then the server is told. */
export async function addMissingTakes(job: GenerationJob): Promise<void> {
  const { docSession } = useEditor.getState();
  const key = `${docSession}\n${job.id}`;
  const adding = addTakes(job, docSession);
  applied.set(key, adding);
  if (!(await adding)) return;
  appliedDone.add(key);
  await acknowledge(job.id);
}

/** A `generation-job` event (or a fetched job): update the queue; deliver done outputs for the open project. */
export function applyGenerationJob(job: GenerationJob): void {
  const prev = useGenerate.getState().jobs.find((j) => j.id === job.id);
  useGenerate.setState((s) => ({ jobs: upsert(s.jobs, job) }));
  if (prev?.status !== job.status) scheduleStatusRefresh();
  void deliver(job);
}

/** On project open and on reconnect: this project's jobs from the server, delivering any finished while the editor was away. */
export async function syncGenerationJobs(): Promise<void> {
  const projectId = useEditor.getState().doc.project.id;
  let list: GenerationJob[];
  try {
    list = await api.listGenerationJobs(projectId);
  } catch (e) {
    offline(e);
    return;
  }
  if (useEditor.getState().doc.project.id !== projectId) return;
  useGenerate.setState((s) => ({ link: 'up', jobs: list.reduce(upsert, s.jobs) }));
  for (const job of list) await deliver(job);
}

/**
 * Another document opened: re-fill the draft's project-derived settings and
 * fetch its jobs. The same document's scenes changed (lengths, order,
 * entrances, a deletion): the draft's frames follow them. Returns a stop function.
 */
export function watchGenerationProject(): () => void {
  return useEditor.subscribe((s, prev) => {
    if (s.docSession === prev.docSession) {
      if (s.doc.project.scenes !== prev.doc.project.scenes) {
        refreshDraftFrames(s.doc.project);
        refreshDraftPlan(s.doc.project);
      }
      return;
    }
    const g = useGenerate.getState();
    useGenerate.setState({ draft: { ...g.draft, settings: jobDefaults(g.draft.job, s.doc.project, selectedImageAssetId(s), s.selection.sceneId), lostFrames: undefined, forScene: undefined }, quote: null, quoteFor: null, submitError: null });
    void syncGenerationJobs();
  });
}
