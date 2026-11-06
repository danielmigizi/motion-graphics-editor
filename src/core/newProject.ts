// A new, empty video and filling it from an approved outline. Pure.
//
// "New video" no longer collects a brief in a dialog: it creates a blank
// project (one empty scene in the last-used format), opens it, and the chat is
// where the brief is written. When the agent's outline is approved, the open
// blank project is filled in place (applyOutline): one empty scene per
// outline item, the brand files as assets, the chosen track as the music bed,
// and the outline's title as the name. The project keeps its id, so its chat
// and its place on the server stay.

import { brandAssets, musicFile, stampStory, type Outline, type VideoBrief } from './outline';
import { STYLE_PACKS } from './style';
import { PROJECT_SCHEMA_VERSION, type AudioClip, type Project, type Scene } from './types';

export interface ProjectFormat {
  width: number;
  height: number;
  fps: number;
  backgroundColor: string;
}

// The light plate of the editor's direction: a new video starts on paper, not in the dark.
export const DEFAULT_FORMAT: ProjectFormat = { width: 1920, height: 1080, fps: 30, backgroundColor: '#F7F6F2' };

/** The name a blank project starts with (renamed by the outline's title, or by the user). */
export const UNTITLED_NAME = 'Untitled video';

/** Seconds the single starting scene lasts. */
export const BLANK_SCENE_SECONDS = 5;
/** The starting scene's name; a scene named otherwise was shaped by someone (or by an outline). */
export const BLANK_SCENE_NAME = 'Scene 1';

export const formatOf = (p: Pick<Project, 'width' | 'height' | 'fps' | 'backgroundColor'>): ProjectFormat => ({ width: p.width, height: p.height, fps: p.fps, backgroundColor: p.backgroundColor });

/** A valid empty project: one empty scene, no assets, no audio. */
export function blankProject(ids: { project: string; scene: string }, format: ProjectFormat = DEFAULT_FORMAT, name = UNTITLED_NAME): Project {
  const scene: Scene = {
    id: ids.scene,
    name: BLANK_SCENE_NAME,
    durationInFrames: Math.max(1, Math.round(BLANK_SCENE_SECONDS * format.fps)),
    backgroundColor: format.backgroundColor,
    locked: false,
    transitionIn: { type: 'none', durationInFrames: 0 },
    elements: [],
  };
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: ids.project,
    name,
    revision: 1,
    fps: format.fps,
    width: format.width,
    height: format.height,
    backgroundColor: format.backgroundColor,
    scenes: [scene],
    assets: {},
    audio: [],
    compositions: {},
    markers: [],
    // Templates and presets read the pack; without one they assume a dark plate.
    style: structuredClone(STYLE_PACKS.paper),
  };
}

/**
 * True when nothing has been made in the project yet: at most one scene, still
 * named as the blank project named it, with no element, asset, audio clip or
 * marker. Such a project is replaced by an approved outline (or an agent's
 * whole draft) without asking, and is never worth an "unsaved changes" prompt.
 * A skeleton of named, timed scenes is already work, even before any element
 * and even when the outline had a single scene: it is not untouched.
 */
export function isUntouched(p: Project): boolean {
  return p.scenes.length <= 1 && p.scenes.every((s) => s.elements.length === 0 && !s.locked && s.name === BLANK_SCENE_NAME) && Object.keys(p.assets).length === 0 && p.audio.length === 0 && p.markers.length === 0;
}

export interface OutlineIds {
  scene: (index: number) => string;
  audioClip: () => string;
}

/**
 * The open project filled from an approved outline: its scenes replaced by one
 * empty scene per outline item (named and timed as approved), the brief's
 * brand files added as assets, the chosen track (or the first audio file)
 * placed as a music bed across the whole video, and the outline's title as the
 * name. Format comes from the brief (the user may have changed it in the
 * chat); id, revision, compositions and style are kept. Existing assets stay;
 * existing audio and markers are dropped with the scenes they belonged to.
 */
export function applyOutline(project: Project, outline: Outline, brief: VideoBrief, ids: OutlineIds): Project {
  let seconds = 0;
  let boundary = 0;
  const scenes: Scene[] = outline.scenes.map((s, i) => {
    seconds += s.durationSeconds;
    const nextBoundary = Math.max(boundary + 1, Math.round(seconds * brief.fps));
    const durationInFrames = nextBoundary - boundary;
    boundary = nextBoundary;
    return { id: ids.scene(i), name: s.name, durationInFrames, backgroundColor: brief.backgroundColor, locked: false, transitionIn: { type: 'none', durationInFrames: 0 }, elements: [] };
  });
  const total = scenes.reduce((n, s) => n + s.durationInFrames, 0);
  const added = brandAssets(brief);
  const assets = { ...project.assets, ...Object.fromEntries(added.map((a) => [a.id, a])) };
  const chosen = musicFile(brief);
  const music = chosen ? assets[chosen.id] : undefined;
  const audio: AudioClip[] = [];
  if (music) {
    const durationInFrames = Math.min(total, music.durationInFrames ?? total);
    audio.push({ id: ids.audioClip(), assetId: music.id, name: 'Music bed', startFrame: 0, trimStartFrames: 0, durationInFrames, volume: 0.6, fadeInFrames: Math.min(durationInFrames, Math.round(brief.fps * 0.5)), fadeOutFrames: Math.min(durationInFrames, Math.round(brief.fps * 1.5)) });
  }
  const story = stampStory(outline.story, scenes, brief.fps);
  const next: Project = {
    ...project,
    name: outline.title,
    fps: brief.fps,
    width: brief.width,
    height: brief.height,
    backgroundColor: brief.backgroundColor,
    scenes,
    assets,
    audio,
    markers: [],
  };
  if (story) next.story = story;
  else delete next.story;
  return next;
}
