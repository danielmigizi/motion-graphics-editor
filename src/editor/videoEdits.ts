// Editor-side video helpers (pure): the element a new video becomes, the
// source range an element plays, and the changes the inspector's in/out
// trim and speed controls commit (each as ONE updateElement).

import { COMPONENTS } from '../core/components';
import { newId } from '../core/ids';
import type { Asset, Element, ElementChanges, ID, Project, Scene } from '../core/types';
import { retimeVideo, trimVideoSpan, videoMaxDuration, videoProps } from '../core/video';

/** A video element for `asset` at `startFrame` of `scene`: half the frame wide (aspect kept), centred, as long as the scene and the file allow. */
export function videoElementFor(project: Project, scene: Scene, asset: Asset, startFrame = 0): Element {
  const def = COMPONENTS.video;
  const aspect = asset.width && asset.height ? asset.height / asset.width : def.defaultSize.height / def.defaultSize.width;
  let width = Math.round(project.width * 0.5);
  let height = Math.round(width * aspect);
  if (height > project.height * 0.8) {
    height = Math.round(project.height * 0.8);
    width = Math.round(height / aspect);
  }
  const start = Math.max(0, Math.min(startFrame, scene.durationInFrames - 1));
  const room = scene.durationInFrames - start;
  return {
    id: newId('el'),
    type: 'video',
    name: asset.name.replace(/\.[A-Za-z0-9]+$/, '').slice(0, 80) || def.label,
    startFrame: start,
    durationInFrames: Math.max(1, Math.min(room, asset.durationInFrames ?? room)),
    visible: true,
    transform: { x: Math.round((project.width - width) / 2), y: Math.round((project.height - height) / 2), width, height, rotation: 0, scale: 1, opacity: 1 },
    props: { ...structuredClone(def.defaultProps), assetId: asset.id },
    tracks: [],
  };
}

export interface SourceRange {
  /** Source frames (project fps) the element plays: [in, out). */
  in: number;
  out: number;
  /** Source length, when known. */
  length?: number;
  rate: number;
  loop: boolean;
}

export function sourceRange(element: Element, assets: Record<ID, Asset>): SourceRange {
  const v = videoProps(element);
  const asset = assets[v.assetId];
  const length = asset?.kind === 'video' ? asset.durationInFrames : undefined;
  return { in: v.trimStartFrames, out: v.trimStartFrames + element.durationInFrames * v.playbackRate, length, rate: v.playbackRate, loop: v.loop };
}

/** Frames the element may run before its scene ends (children of groups are not bounded by the scene). */
const sceneRoom = (scene: Scene, element: Element) => (element.parentId ? Infinity : scene.durationInFrames - element.startFrame);

/** New in-point; the element keeps its start and its out-point (its duration changes). */
export function inPointChanges(scene: Scene, element: Element, assets: Record<ID, Asset>, nextIn: number): ElementChanges | null {
  const r = sourceRange(element, assets);
  const maxIn = Math.max(0, Math.floor(Math.min(r.out, r.length ?? Infinity) - r.rate));
  const trim = Math.max(0, Math.min(Math.round(nextIn), maxIn));
  const dur = Math.max(1, Math.min(Math.round((r.out - trim) / r.rate), sceneRoom(scene, element), videoMaxDuration(r.length, trim, r.rate, r.loop)));
  if (trim === r.in && dur === element.durationInFrames) return null;
  return { durationInFrames: dur, props: { trimStartFrames: trim } };
}

/** New out-point; the element keeps its start and in-point (its duration changes). */
export function outPointChanges(scene: Scene, element: Element, assets: Record<ID, Asset>, nextOut: number): ElementChanges | null {
  const r = sourceRange(element, assets);
  const dur = Math.max(1, Math.min(Math.round((nextOut - r.in) / r.rate), sceneRoom(scene, element), videoMaxDuration(r.length, r.in, r.rate, r.loop)));
  return dur === element.durationInFrames ? null : { durationInFrames: dur };
}

/** New speed; the in-point stays, the element shortens when the file no longer fills it. */
export function speedChanges(element: Element, assets: Record<ID, Asset>, rate: number): ElementChanges | null {
  const r = retimeVideo(element, rate, assets);
  if (r.playbackRate === videoProps(element).playbackRate && r.durationInFrames === element.durationInFrames) return null;
  return { durationInFrames: r.durationInFrames, props: { playbackRate: r.playbackRate } };
}

/** Loop on/off; turning it off shortens the element to one pass of the trimmed source. */
export function loopChanges(element: Element, assets: Record<ID, Asset>, loop: boolean): ElementChanges {
  const r = sourceRange(element, assets);
  const max = videoMaxDuration(r.length, r.in, r.rate, loop);
  return { props: { loop }, ...(element.durationInFrames > max ? { durationInFrames: Math.max(1, max) } : {}) };
}

/** Changes for a replaceAsset that swaps a file: a video drops its old preview proxy (the new file's own one is filled in when ready). */
export function replacementChanges(old: Asset, fields: Omit<Asset, 'id'>): Partial<Omit<Asset, 'id'>> {
  const { name: _name, ...file } = fields;
  // replaceAsset merges, so an old proxySrc would survive: point it at the new file itself until its proxy is ready.
  return old.proxySrc ? { ...file, proxySrc: file.src } : file;
}

/** One gesture: add the uploaded video and place it at the playhead. */
export function insertVideoCommands(project: Project, scene: Scene, asset: Asset, startFrame: number) {
  const element = videoElementFor(project, scene, asset, startFrame);
  return { element, command: { type: 'batch' as const, label: `Insert video ${asset.name}`, commands: [{ type: 'addAsset' as const, asset }, { type: 'addElement' as const, sceneId: scene.id, element }] } };
}

/** A proxy is "missing" when there is none or it is the file itself. */
export const hasRealProxy = (asset: Asset) => !!asset.proxySrc && asset.proxySrc !== asset.src;

/**
 * A timeline drag of a video bar as element changes: the start edge moves the
 * in-point with it (× speed) and the end edge stops at the file's end. Null when
 * nothing changes.
 */
export function videoSpanChanges(project: Project, element: Element, next: { start: number; dur: number }, mode: 'move' | 'start' | 'end'): ElementChanges | null {
  const v = videoProps(element);
  const asset = project.assets[v.assetId];
  const r = trimVideoSpan({ start: element.startFrame, dur: element.durationInFrames, trim: v.trimStartFrames }, next, mode, v.playbackRate, asset?.kind === 'video' ? asset.durationInFrames : undefined, v.loop);
  const changes: ElementChanges = {};
  if (r.start !== element.startFrame) changes.startFrame = r.start;
  if (r.dur !== element.durationInFrames) changes.durationInFrames = r.dur;
  if (r.trim !== v.trimStartFrames) changes.props = { trimStartFrames: r.trim };
  return Object.keys(changes).length ? changes : null;
}
