// Generated takes: assets an agent generated (provenance.source 'generated'),
// grouped by the request that made them, and what "Use this take" changes.
// Pure, so it is tested without a DOM.
//
// Every take becomes a pasted-style patch the user reviews (nothing changes
// until Apply). Picture takes (image, SVG, video): every scene element showing
// another take of the same request switches to this one, or, when none does,
// a new element shows it in the current scene. Audio takes: clips playing
// another take switch to it (targets: their scenes, or the project audio), or
// a clip is added to the current scene. Durations, trims, fades and envelopes
// are fitted to the take, so a shorter take still validates. Narration (a
// line per scene) is scoped to the take's own scene: only that line's takes
// count, and a new clip goes into that scene, never the selected one.
//
// Reusable components (compositions) can't be changed by a patch: a take used
// inside one counts as in use, and is never "placed" again as a new element.
// A take already in the video, with no other take of its request in use, has
// nothing to switch: "Use this take" is a no-op (the button is disabled).

import { create } from 'zustand';
import { trimEnvelope } from '../core/audioDucking';
import type { JobSettings } from '../core/generationStudio';
import { placeNarrationCommands } from '../core/scorePlan';
import { takeUsage } from '../core/takeUsage';
import { COMPONENTS } from '../core/components';
import { newId } from '../core/ids';
import { PATCH_PROTOCOL } from '../core/types';
import type { AiPatch, Asset, AudioClip, Command, Element, ElementChanges, ElementType, PatchTarget, Project, Scene } from '../core/types';
import { videoMaxDuration, videoProps } from '../core/video';
import { createElement } from './doc';

export { takeUsage };

export interface TakeGroup {
  /** provenance.requestId, or the asset id when the request is unknown. */
  key: string;
  /** Generator id, e.g. 'fal'. */
  provider?: string;
  prompt?: string;
  model?: string;
  cost?: string;
  /** Oldest first. */
  takes: Asset[];
  /** Newest take's time (groups are sorted by it, newest first). */
  at: number;
}

const at = (a: Asset) => a.provenance?.createdAt ?? 0;

/** Generated assets grouped by request, newest request first. */
export function groupTakes(project: Project): TakeGroup[] {
  const groups = new Map<string, TakeGroup>();
  for (const a of Object.values(project.assets)) {
    const p = a.provenance;
    if (p?.source !== 'generated') continue;
    const key = p.requestId || a.id;
    let g = groups.get(key);
    if (!g) {
      g = { key, takes: [], at: 0 };
      groups.set(key, g);
    }
    g.takes.push(a);
    g.at = Math.max(g.at, at(a));
    // The first take that says so names the request.
    g.provider ??= p.provider;
    g.prompt ??= p.prompt;
    g.model ??= p.model;
    g.cost ??= p.cost;
  }
  for (const g of groups.values()) g.takes.sort((x, y) => at(x) - at(y) || x.name.localeCompare(y.name));
  return [...groups.values()].sort((a, b) => b.at - a.at);
}

/** The asset fields of `el` that show one of `ids` and accept an asset of `kind`. */
function fieldsShowing(el: Element, ids: Set<string>, kind: Asset['kind']): string[] {
  return (COMPONENTS[el.type]?.fields ?? []).flatMap((f) => (f.kind === 'asset' && ids.has(String(el.props[f.key] ?? '')) && f.assetKinds.includes(kind) ? [f.key] : []));
}

/** A clip switched to a take `length` frames long: in-point, duration, fades and envelope fitted so it still validates. */
function fitClip(c: AudioClip, length: number | undefined): Partial<Omit<AudioClip, 'id'>> {
  if (!length) return {};
  const trimStartFrames = c.trimStartFrames < length ? c.trimStartFrames : 0;
  const durationInFrames = Math.max(1, Math.min(length - trimStartFrames, c.durationInFrames));
  const shorter = durationInFrames < c.durationInFrames;
  return {
    ...(trimStartFrames !== c.trimStartFrames ? { trimStartFrames } : {}),
    ...(shorter ? { durationInFrames } : {}),
    ...(c.fadeInFrames > durationInFrames ? { fadeInFrames: durationInFrames } : {}),
    ...(c.fadeOutFrames > durationInFrames ? { fadeOutFrames: durationInFrames } : {}),
    ...(shorter && c.volumeEnvelope ? { volumeEnvelope: trimEnvelope(c.volumeEnvelope, 0, durationInFrames) } : {}),
  };
}

/** A video element switched to `take`: the in-point stays inside the new file and the element never outlasts it. */
function fitVideo(el: Element, take: Asset): ElementChanges {
  const v = videoProps(el);
  const length = take.durationInFrames;
  if (length === undefined) return {};
  const trim = v.trimStartFrames < length && videoMaxDuration(length, v.trimStartFrames, v.playbackRate, v.loop) >= 1 ? v.trimStartFrames : 0;
  const dur = Math.max(1, Math.min(el.durationInFrames, videoMaxDuration(length, trim, v.playbackRate, v.loop)));
  return { ...(dur !== el.durationInFrames ? { durationInFrames: dur } : {}), ...(trim !== v.trimStartFrames ? { props: { trimStartFrames: trim } } : {}) };
}

const sameTarget = (a: PatchTarget, b: PatchTarget) => JSON.stringify(a) === JSON.stringify(b);
const pushTarget = (targets: PatchTarget[], t: PatchTarget) => {
  if (!targets.some((x) => sameTarget(x, t))) targets.push(t);
};
const names = (list: string[]) => list.map((n) => `“${n}”`).join(', ');

/** The element type that shows an asset of this kind, or null for audio. */
function elementTypeFor(kind: Asset['kind']): ElementType | null {
  if (kind === 'image' || kind === 'svg') return 'image';
  if (kind === 'video' && COMPONENTS.video) return 'video';
  return null;
}

/** A clip take's length to lead its status line, "8.0 s · " (asset lengths are in project frames); '' for pictures and sound. */
export function takeLength(take: Asset, fps: number): string {
  return take.kind === 'video' && take.durationInFrames ? `${(take.durationInFrames / fps).toFixed(1)} s · ` : '';
}

/** A narration take's scene: the line it says was written for that scene (the studio's voice.narration job tags each take); undefined for any other take. */
export function narrationSceneOf(take: Asset): string | undefined {
  const refs = take.provenance?.providerRefs;
  return refs?.job === 'voice.narration' && refs.sceneId ? refs.sceneId : undefined;
}

/**
 * The takes "Use this take" chooses between. A narration request holds a
 * different line per scene, not interchangeable takes: a line's takes are
 * only the takes of that line (its scene). Any other request: all its takes.
 */
export function takeChoices(group: TakeGroup, take: Asset): TakeGroup {
  const sceneId = narrationSceneOf(take);
  return sceneId ? { ...group, takes: group.takes.filter((t) => narrationSceneOf(t) === sceneId) } : group;
}

/** More like this from a studio take: its request's settings, but for a narration line's take only that line (two more takes of it, not of every scene). */
export function moreLikeThisSettings(settings: JobSettings, take: Asset): { settings: JobSettings; forScene?: string } {
  const line = narrationSceneOf(take);
  return line ? { settings: { ...settings, lines: (settings.lines ?? []).filter((l) => l.sceneId === line) }, forScene: line } : { settings };
}

/** "Already in the video": this take is placed and no other take of its request is, so "Use this take" has nothing to switch. */
export const ALREADY_PLACED = 'Already in the video';

/**
 * Whether "Use this take" has nothing to do: the take is in use (scenes,
 * reusable components or audio) and no other take of its request is. Using
 * it again would only add a duplicate layer.
 */
export function takeAlreadyPlaced(group: TakeGroup, takeId: string, usage: ReadonlyMap<string, number>): boolean {
  if (!(usage.get(takeId) ?? 0)) return false;
  return !group.takes.some((t) => t.id !== takeId && (usage.get(t.id) ?? 0) > 0);
}

export type TakePlan =
  /** `note`: something the patch could not change (a reusable component still showing another take). */
  | { kind: 'patch'; patch: AiPatch; summary: string; note?: string }
  | { kind: 'none'; message: string };

/**
 * What "Use this take" does for `takeId` in `request`, inserting into
 * `sceneId` when no element uses the request yet. A narration line's take
 * (narrationSceneOf) stays in its own scene: it switches only the clips in
 * that scene playing another take of the line, and is otherwise placed there
 * as narration (after the lead-in, in place of narration already there, the
 * music ducked), whatever scene is selected.
 */
export function planUseTake(project: Project, request: TakeGroup, takeId: string, sceneId: string | null): TakePlan {
  const take = request.takes.find((t) => t.id === takeId);
  if (!take) return { kind: 'none', message: 'That take is no longer in the project.' };
  if (take.reference) return { kind: 'none', message: `“${take.name}” is marked as a reference; references steer generation and are never placed in the video.` };
  const line = narrationSceneOf(take);
  const group = takeChoices(request, take);
  if (takeAlreadyPlaced(group, takeId, takeUsage(project))) return { kind: 'none', message: `${ALREADY_PLACED}: “${take.name}” is the take of this ${line ? 'line' : 'request'} the video uses.` };
  const others = new Set(group.takes.filter((t) => t.id !== takeId).map((t) => t.id));
  const scene: Scene | undefined = line ? project.scenes.find((s) => s.id === line) : (project.scenes.find((s) => s.id === sceneId) ?? project.scenes[0]);
  const base = { protocol: PATCH_PROTOCOL, projectId: project.id, baseRevision: project.revision } as const;
  const lockedScene = (s: Scene): TakePlan => ({ kind: 'none', message: `“${s.name}” is approved (locked); unlock it or pick another scene to place the take.` });

  if (take.kind === 'audio') {
    const clips = project.audio.filter((c) => others.has(c.assetId) && (!line || c.sceneId === line));
    if (clips.length) {
      const commands: Command[] = clips.map((c) => ({ type: 'updateAudioClip', clipId: c.id, changes: { assetId: take.id, name: line ? `Narration: ${take.name}` : take.name, ...fitClip(c, take.durationInFrames) } }));
      const targets: PatchTarget[] = [];
      for (const c of clips) pushTarget(targets, c.sceneId ? { sceneId: c.sceneId } : { audio: 'project' });
      const summary = `Use take “${take.name}” in ${clips.length} audio clip${clips.length === 1 ? '' : 's'}`;
      return { kind: 'patch', summary, patch: { ...base, summary, targets, commands } };
    }
    if (line) return placeLine(project, take, scene);
    if (!scene) return { kind: 'none', message: 'Add a scene first.' };
    if (scene.locked) return lockedScene(scene);
    const clip: AudioClip = { id: newId('aud'), assetId: take.id, name: take.name, sceneId: scene.id, startFrame: 0, trimStartFrames: 0, durationInFrames: Math.max(1, Math.min(take.durationInFrames ?? scene.durationInFrames, scene.durationInFrames)), volume: 1, fadeInFrames: 0, fadeOutFrames: 0 };
    const summary = `Add take “${take.name}” to “${scene.name}”`;
    return { kind: 'patch', summary, patch: { ...base, summary, targets: [{ sceneId: scene.id }], commands: [{ type: 'addAudioClip', clip }] } };
  }

  const type = elementTypeFor(take.kind);
  if (!type) return { kind: 'none', message: `${take.kind} takes can't be placed yet.` };
  const commands: Command[] = [];
  const targets: PatchTarget[] = [];
  for (const s of project.scenes) {
    for (const el of s.elements) {
      const keys = fieldsShowing(el, others, take.kind);
      if (!keys.length) continue;
      const fit = el.type === 'video' ? fitVideo(el, take) : {};
      commands.push({ type: 'updateElement', sceneId: s.id, elementId: el.id, changes: { ...fit, props: { ...fit.props, ...Object.fromEntries(keys.map((k) => [k, take.id])) } } });
      pushTarget(targets, { sceneId: s.id, elementId: el.id });
    }
  }
  // Reusable components showing another take: a patch can't change them, so say so instead of placing the take again.
  const components = Object.values(project.compositions).filter((c) => c.elements.some((el) => fieldsShowing(el, others, take.kind).length)).map((c) => c.name);
  const componentNote = components.length ? `The reusable component${components.length === 1 ? '' : 's'} ${names(components)} still show${components.length === 1 ? 's' : ''} another take of this request; proposals can't change components yet.` : undefined;
  if (commands.length) {
    const summary = `Use take “${take.name}” (${commands.length} element${commands.length === 1 ? '' : 's'})`;
    return { kind: 'patch', summary, patch: { ...base, summary, targets, commands }, ...(componentNote ? { note: componentNote } : {}) };
  }
  if (componentNote) return { kind: 'none', message: componentNote };
  if (!scene) return { kind: 'none', message: 'Add a scene first.' };
  if (scene.locked) return lockedScene(scene);
  const el = createElement(project, scene, type);
  el.props = { ...el.props, assetId: take.id };
  // Timing from the take itself (createElement sized it from whichever video came first): never outlast the file.
  if (type === 'video') {
    const v = videoProps(el);
    el.props.trimStartFrames = 0;
    el.durationInFrames = Math.max(1, Math.min(scene.durationInFrames, videoMaxDuration(take.durationInFrames, 0, v.playbackRate, v.loop)));
  }
  el.name = take.name.replace(/\.[a-z0-9]+$/i, '').slice(0, 60) || el.name;
  // Fill the frame, keeping the take's aspect when it is known.
  if (take.width && take.height) {
    const s = Math.min(project.width / take.width, project.height / take.height);
    const w = Math.round(take.width * s);
    const h = Math.round(take.height * s);
    el.transform = { ...el.transform, x: Math.round((project.width - w) / 2), y: Math.round((project.height - h) / 2), width: w, height: h };
  }
  const summary = `Place take “${take.name}” in “${scene.name}”`;
  return { kind: 'patch', summary, patch: { ...base, summary, targets: [{ sceneId: scene.id }], commands: [{ type: 'addElement', sceneId: scene.id, element: el, index: 0 } as Command] } };
}

/** A narration line's take placed in its own scene, as Place at scenes places it (scorePlan.placeNarrationCommands). */
function placeLine(project: Project, take: Asset, scene: Scene | undefined): TakePlan {
  if (!scene) return { kind: 'none', message: 'The scene this line was written for is no longer in the video.' };
  if (scene.locked) return { kind: 'none', message: `“${scene.name}” is approved (locked); unlock it to place its line.` };
  try {
    const { commands, trimmed } = placeNarrationCommands(project, [{ asset: take, sceneId: scene.id }]);
    const replaced = commands.some((c) => c.type === 'removeAudioClip');
    const summary = `Place narration “${take.name}” in “${scene.name}”${replaced ? ' in place of the narration there' : ''}`;
    const note = trimmed.length ? `“${take.name}” runs longer than “${scene.name}”, so it is cut off: shorten the line or lengthen the scene.` : undefined;
    return { kind: 'patch', summary, patch: commandsPatch(project, commands, summary), ...(note ? { note } : {}) };
  } catch (e) {
    return { kind: 'none', message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * The targets a patch of `commands` needs: each scene it changes or anchors a
 * clip to, and the project audio for clips without a scene (clips added
 * earlier in the list count).
 */
export function targetsFor(project: Project, commands: readonly Command[]): PatchTarget[] {
  const targets: PatchTarget[] = [];
  const scope = new Map<string, string | null>(project.audio.map((c) => [c.id, c.sceneId ?? null]));
  const audio = (sceneId: string | null | undefined) => pushTarget(targets, sceneId ? { sceneId } : { audio: 'project' });
  const visit = (c: Command) => {
    switch (c.type) {
      case 'batch':
        c.commands.forEach(visit);
        break;
      case 'addAudioClip':
        scope.set(c.clip.id, c.clip.sceneId ?? null);
        audio(c.clip.sceneId);
        break;
      case 'updateAudioClip':
      case 'removeAudioClip':
        if (scope.has(c.clipId)) audio(scope.get(c.clipId));
        if (c.type === 'updateAudioClip' && 'sceneId' in c.changes) audio(c.changes.sceneId);
        break;
      default:
        if ('sceneId' in c && typeof c.sceneId === 'string') pushTarget(targets, { sceneId: c.sceneId });
    }
  };
  commands.forEach(visit);
  return targets;
}

/** Commands as a patch for review against the open revision, with the targets they need. */
export function commandsPatch(project: Project, commands: readonly Command[], summary: string): AiPatch {
  return { protocol: PATCH_PROTOCOL, projectId: project.id, baseRevision: project.revision, summary, targets: targetsFor(project, commands), commands: [...commands] };
}

/** "More like this": a chat message the user can edit before sending. */
export function moreLikeThisPrompt(group: TakeGroup, take: Asset): string {
  const what = take.kind === 'audio' ? 'audio' : take.kind === 'video' ? 'clip' : 'image';
  return [
    `Generate two more takes like “${take.name}”${group.provider ? ` with ${group.provider}` : ''}, same request${group.model ? ` and model (${group.model})` : ''}.`,
    group.prompt ? `Original prompt: “${group.prompt}”.` : '',
    `Keep what works in this ${what}; vary the composition. Import them as takes of request ${group.key}.`,
  ].filter(Boolean).join(' ');
}

/**
 * A message for the chat composer (TakesPanel → ChatPanel): the composer
 * takes it, then clears it.
 */
export const useChatDraft = create<{ draft: string | null }>(() => ({ draft: null }));
