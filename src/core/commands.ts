// applyCommand: pure document transform for one Command. Does NOT bump the
// revision — history.ts owns revisions and undo.
//
// - Immutable with structural sharing: untouched scenes, elements, assets and
//   clips keep their object identity.
// - The command is shape-checked first, and the resulting project is
//   validated as a whole (validate.ts). On any failure the result is
//   { ok: false } — never a partial project.
// - Scene locks: nothing inside a locked scene may change. `setSceneLock` is
//   user-only; `moveScene` of a locked scene is user-only (order only).
// - A batch is atomic; intermediate states inside a batch are not validated,
//   only the final one, so order-dependent edits (shorten element, then
//   shorten scene) work in either order.
// - Indices (`index`, `toIndex`) are clamped into range; frames never are.
//
// Touched refs: element-level for element commands (including moveElement),
// scene-level for scene fields/add/remove/lock, `project` for updateProject,
// setStyle and moveScene (scene order is a project-level field; the scene's
// content and its elements are untouched), asset/audio refs for those commands.

import { evaluateElement, evaluateElementWorld, invertMatrix, multiplyMatrices, transformPoint, worldCorners } from './animation';
import { COMPONENTS } from './components';
import { deepEqual } from './diff';
import { CommandSchema, firstIssue, ProjectSchema } from './schema';
import { checkProject } from './validate';
import { detachedAudioClip, videoMaxDuration } from './video';
import type { AnimationTrack, Asset, Command, CommandError, CommandResult, CommandSource, Element, Project, Scene, TouchedRef } from './types';

export interface CommandContext {
  source: CommandSource;
}

type Inner = { ok: true; project: Project; touched: TouchedRef[] } | { ok: false; error: CommandError };

const err = (code: CommandError['code'], message: string, extra: Partial<CommandError> = {}): Inner => ({
  ok: false,
  error: { code, message, ...extra },
});

const clampIndex = (i: number | undefined, max: number) => (i === undefined ? max : Math.max(0, Math.min(Math.trunc(i), max)));

function lockedError(scene: Scene, what = 'change it'): Inner {
  return err('LOCKED', `Scene "${scene.name}" (${scene.id}) is locked. Unlock it first to ${what}.`, {
    hint: 'Approved scenes are locked; unlock the scene in the editor, then retry.',
  });
}

function findScene(project: Project, sceneId: string): { scene: Scene; index: number } | null {
  const index = project.scenes.findIndex((s) => s.id === sceneId);
  return index < 0 ? null : { scene: project.scenes[index], index };
}

const sceneNotFound = (sceneId: string) => err('NOT_FOUND', `Scene ${sceneId} not found`, { hint: 'Use an id from the current scene list.' });

function withScene(project: Project, index: number, scene: Scene): Project {
  const scenes = project.scenes.slice();
  scenes[index] = scene;
  return { ...project, scenes };
}

function withElement(scene: Scene, index: number, element: Element): Scene {
  const elements = scene.elements.slice();
  elements[index] = element;
  return { ...scene, elements };
}

function move<T>(arr: readonly T[], from: number, to: number): T[] {
  const out = arr.slice();
  const [item] = out.splice(from, 1);
  out.splice(to, 0, item);
  return out;
}

/** Resolve scene + element, enforcing the scene lock. */
function locateElement(project: Project, sceneId: string, elementId: string) {
  const found = findScene(project, sceneId);
  if (!found) return { error: sceneNotFound(sceneId) };
  const elIndex = found.scene.elements.findIndex((e) => e.id === elementId);
  if (elIndex < 0) {
    return { error: err('NOT_FOUND', `Element ${elementId} not found in scene "${found.scene.name}" (${sceneId})`) };
  }
  if (found.scene.locked) return { error: lockedError(found.scene) };
  return { ...found, elIndex, element: found.scene.elements[elIndex] };
}

function updateTracks(element: Element, property: AnimationTrack['property'], fn: (track: AnimationTrack | undefined) => AnimationTrack | null): Element {
  const i = element.tracks.findIndex((t) => t.property === property);
  const next = fn(i < 0 ? undefined : element.tracks[i]);
  const tracks = element.tracks.slice();
  if (i < 0) {
    if (next) tracks.push(next);
  } else if (next) tracks[i] = next;
  else tracks.splice(i, 1);
  return { ...element, tracks };
}

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  return out;
}

function prefixPath(error: CommandError, prefix: string): CommandError {
  return { ...error, path: error.path ? `${prefix}.${error.path}` : prefix };
}

function allElements(project: Project): Element[] { return [...project.scenes.flatMap(s => s.elements), ...Object.values(project.compositions).flatMap(c => c.elements)]; }

/** Transitive instance dependencies, also used by locks and rollback checks. */
export function compositionDependencies(project: Project, elements: Element[]): Set<string> {
  const ids = new Set<string>();
  const visit = (els: Element[]) => { for (const el of els) if (el.type === 'instance' && typeof el.props.compositionId === 'string' && !ids.has(el.props.compositionId)) {
    ids.add(el.props.compositionId); const comp = project.compositions[el.props.compositionId]; if (comp) visit(comp.elements);
  } };
  visit(elements); return ids;
}

function absoluteStart(elements: Element[], el: Element): number {
  let frame = el.startFrame, parentId = el.parentId;
  const seen = new Set([el.id]);
  while (parentId) {
    if (seen.has(parentId)) throw new Error('Parent cycle');
    seen.add(parentId);
    const parent = elements.find(e => e.id === parentId);
    if (!parent) throw new Error('Missing parent');
    frame += parent.startFrame; parentId = parent.parentId;
  }
  return frame;
}

function reparent(elements: Element[], el: Element, parentId: string | null, keepWorld: boolean): { ok: true; element: Element } | { ok: false; error: CommandError } {
  const bad = (message: string, path = 'parentId', hint?: string): { ok: false; error: CommandError } => ({ ok: false, error: { code: 'INVALID', message, path, ...(hint ? { hint } : {}) } });
  const parent = parentId ? elements.find(e => e.id === parentId) : undefined;
  if (parentId && (!parent || parent.type !== 'group')) return bad('parentId must reference a group in this scene');
  let cursor = parent;
  const seen = new Set([el.id]);
  while (cursor) {
    if (seen.has(cursor.id)) return bad('Reparenting would create a parent cycle');
    seen.add(cursor.id); cursor = elements.find(e => e.id === cursor!.parentId);
  }
  const next = { ...el };
  if (parentId) next.parentId = parentId; else delete next.parentId;
  if (!keepWorld || el.parentId === (parentId ?? undefined)) return { ok: true, element: next };
  const frame = absoluteStart(elements, el);
  next.startFrame = frame - (parent ? absoluteStart(elements, parent) : 0);
  if (next.startFrame < 0) return bad(`“${el.name}” starts before “${parent?.name ?? 'the group'}” does, so it can't move into that group without its timing changing.`, 'parentId', 'Start the group earlier first (agents: or pass keepWorld: false to keep local timing).');
  try {
    const world = evaluateElementWorld(elements, el, frame);
    const oldParent = el.parentId ? elements.find(e => e.id === el.parentId) : undefined;
    const oldWorld = oldParent ? evaluateElementWorld(elements, oldParent, frame) : undefined;
    const pw = parent ? evaluateElementWorld(elements, parent, frame) : undefined;
    const matrix = pw ? multiplyMatrices(invertMatrix(pw.worldMatrix), world.worldMatrix) : world.worldMatrix;
    const centre = transformPoint(matrix, { x: el.transform.width/2, y: el.transform.height/2 });
    const local = evaluateElement(el, el.startFrame);
    const baseScale = el.transform.scale*(oldWorld?.scale ?? 1)/(pw?.scale ?? 1);
    if (baseScale <= 0 || !Number.isFinite(baseScale)) return bad('Cannot preserve placement through a collapsed or flipped parent with a positive base scale');
    next.transform = { ...el.transform,
      x: Math.round(centre.x-el.transform.width/2-(local.x-el.transform.x)),
      y: Math.round(centre.y-el.transform.height/2-(local.y-el.transform.y)),
      rotation: world.rotation-(pw?.rotation ?? 0)-(local.rotation-el.transform.rotation),
      scale: baseScale,
    };
    // Use ancestor opacity directly, even when the child's own entrance starts at zero.
    const oldOpacity = oldWorld?.opacity ?? 1, newOpacity = pw?.opacity ?? 1;
    const baseOpacity = newOpacity === 0 ? el.transform.opacity : el.transform.opacity*oldOpacity/newOpacity;
    if (baseOpacity >= 0 && baseOpacity <= 1) next.transform.opacity = baseOpacity;
    return { ok: true, element: next };
  } catch { return bad('Cannot preserve world placement through a singular parent transform'); }
}

// Rounding can merge keys or push a final frame past a rounded scene end.
// Last key wins at collisions; lifetimes stay positive and markers stay inside the timeline.
function convertFormat(project: Project, command: Extract<Command, { type: 'changeFormat' }>): Project {
  const ratio = command.conversion.timing === 'keepSeconds' ? command.fps/project.fps : 1;
  const frame = (v: number) => Math.round(v*ratio);
  const duration = (v: number) => Math.max(1, frame(v));
  const rx = command.width/project.width, ry = command.height/project.height;
  const uniform = command.conversion.layout === 'none' ? 1 : Math.min(rx, ry);
  const sx = command.conversion.layout === 'scale' ? rx : uniform;
  const sy = command.conversion.layout === 'scale' ? ry : uniform;
  const dx = command.conversion.layout === 'fit' ? (command.width-project.width*uniform)/2 : 0;
  const dy = command.conversion.layout === 'fit' ? (command.height-project.height*uniform)/2 : 0;
  const resample = <T extends { frame: number }>(keys: T[]): T[] => {
    const byFrame = new Map<number,T>(); for (const key of keys) byFrame.set(frame(key.frame), { ...key, frame: frame(key.frame) });
    return [...byFrame.values()].sort((a,b) => a.frame-b.frame);
  };
  const elements = (els: Element[], length: number, offsetX = dx, offsetY = dy): Element[] => els.map(el => {
    const props = { ...el.props };
    const fontField = COMPONENTS[el.type].fields.find(f => f.key === 'fontSize');
    const font = (value: number) => fontField?.kind === 'number' ? Math.min(fontField.max, Math.max(fontField.min, fontField.integer ? Math.round(value*uniform) : value*uniform)) : value;
    if (typeof props.fontSize === 'number') props.fontSize = font(props.fontSize);
    for (const key of ['revealDurationInFrames', 'typingDurationInFrames', 'revealStagger', 'timeOffset', 'trimStartFrames']) if (typeof props[key] === 'number') props[key] = frame(props[key]);
    if (el.type === 'path' && Array.isArray(props.nodes) && uniform !== 1) props.nodes = props.nodes.map(node => {
      const n = node as import('./types').PathNode;
      const point = (p: { x: number; y: number }) => ({ x: p.x*uniform, y: p.y*uniform });
      return { ...point(n), ...(n.in ? { in: point(n.in) } : {}), ...(n.out ? { out: point(n.out) } : {}) };
    });
    const startFrame = el.parentId ? frame(el.startFrame) : Math.min(frame(el.startFrame), length-1);
    let durationInFrames = el.parentId ? duration(el.durationInFrames) : Math.min(duration(el.durationInFrames), length-startFrame);
    // A video never outlasts its (rescaled) trimmed source after rounding.
    const video = el.type === 'video' ? project.assets[String(props.assetId)] : undefined;
    if (video?.durationInFrames !== undefined && typeof props.trimStartFrames === 'number' && typeof props.playbackRate === 'number') {
      const sourceLength = duration(video.durationInFrames);
      const trim = Math.min(props.trimStartFrames, sourceLength - 1);
      props.trimStartFrames = trim;
      durationInFrames = Math.max(1, Math.min(durationInFrames, videoMaxDuration(sourceLength, trim, props.playbackRate, props.loop === true)));
    }
    return { ...el, startFrame, durationInFrames, props,
      transform: command.conversion.layout === 'none' ? el.transform : { ...el.transform, x: Math.round(el.transform.x*sx+(el.parentId ? 0 : offsetX)), y: Math.round(el.transform.y*sy+(el.parentId ? 0 : offsetY)), width: el.transform.width*uniform, height: el.transform.height*uniform },
      tracks: el.tracks.map(track => ({ ...track, keyframes: resample(track.keyframes).map(k => ({ ...k, value: k.value*(track.property === 'x' ? sx : track.property === 'y' ? sy : 1) })) })),
      ...(el.propTracks ? { propTracks: el.propTracks.map(track => ({ ...track, keyframes: resample(track.keyframes).map(k => ({ ...k, value: track.key === 'props.fontSize' && typeof k.value === 'number' ? font(k.value) : k.value })) })) } : {}),
    };
  });
  const scenes = project.scenes.map(scene => { const length = duration(scene.durationInFrames); return { ...scene, durationInFrames: length, transitionIn: { ...scene.transitionIn, durationInFrames: Math.min(length,frame(scene.transitionIn.durationInFrames)) }, elements: elements(scene.elements,length) }; });
  const compositions = Object.fromEntries(Object.entries(project.compositions).map(([id,comp]) => { const length = duration(comp.durationInFrames); return [id,{ ...comp, width: Math.max(1,Math.round(comp.width*uniform)), height: Math.max(1,Math.round(comp.height*uniform)), durationInFrames: length, elements: elements(comp.elements,length,0,0) }]; }));
  const total = scenes.reduce((n,s) => n+s.durationInFrames,0);
  const audio = project.audio.map(clip => {
    const length = duration(clip.durationInFrames);
    const envelope = clip.volumeEnvelope && [...new Map(resample(clip.volumeEnvelope).map(point => {
      const f = Math.min(length, Math.max(0, point.frame));
      return [f, { ...point, frame: f }] as const;
    })).values()];
    return { ...clip, startFrame: frame(clip.startFrame), trimStartFrames: frame(clip.trimStartFrames), durationInFrames: length, fadeInFrames: Math.min(length,frame(clip.fadeInFrames)), fadeOutFrames: Math.min(length,frame(clip.fadeOutFrames)), ...(envelope ? { volumeEnvelope: envelope } : {}) };
  });
  const assets = Object.fromEntries(Object.entries(project.assets).map(([id,asset]) => [id,asset.durationInFrames === undefined ? asset : { ...asset, durationInFrames: duration(asset.durationInFrames) }]));
  const markers = project.markers.map(marker => ({ ...marker, frame: Math.max(0, Math.min(total-1,frame(marker.frame))) })).sort((a,b) => a.frame-b.frame);
  return { ...project, width: command.width, height: command.height, fps: command.fps, scenes, compositions, audio, assets, markers };
}

function applyInner(project: Project, command: Command, ctx: CommandContext): Inner {
  switch (command.type) {
    case 'updateProject': {
      const changes = stripUndefined(command.changes);
      return { ok: true, project: { ...project, ...changes }, touched: [{ kind: 'project' }] };
    }

    case 'addScene': {
      const index = clampIndex(command.index, project.scenes.length);
      const scenes = project.scenes.slice();
      scenes.splice(index, 0, command.scene);
      return { ok: true, project: { ...project, scenes }, touched: [{ kind: 'scene', sceneId: command.scene.id }] };
    }

    case 'removeScene': {
      const found = findScene(project, command.sceneId);
      if (!found) return sceneNotFound(command.sceneId);
      if (found.scene.locked) return lockedError(found.scene, 'remove it');
      const anchored = project.audio.filter((c) => c.sceneId === command.sceneId);
      if (anchored.length) {
        return err('INVALID', `Scene "${found.scene.name}" has anchored audio clips (${anchored.map((c) => c.name).join(', ')})`, {
          hint: 'Remove or re-anchor those audio clips first (in the same batch is fine).',
        });
      }
      const scenes = project.scenes.filter((s) => s.id !== command.sceneId);
      return { ok: true, project: { ...project, scenes }, touched: [{ kind: 'scene', sceneId: command.sceneId }] };
    }

    case 'moveScene': {
      const found = findScene(project, command.sceneId);
      if (!found) return sceneNotFound(command.sceneId);
      if (found.scene.locked && ctx.source !== 'user') return lockedError(found.scene, 'move it');
      const to = clampIndex(command.toIndex, project.scenes.length - 1);
      if (to === found.index) return { ok: true, project, touched: [] };
      return { ok: true, project: { ...project, scenes: move(project.scenes, found.index, to) }, touched: [{ kind: 'project' }] };
    }

    case 'updateScene': {
      const found = findScene(project, command.sceneId);
      if (!found) return sceneNotFound(command.sceneId);
      const { scene } = found;
      if (scene.locked) return lockedError(scene);
      const { transitionIn, ...rest } = command.changes;
      const next: Scene = { ...scene, ...stripUndefined(rest) };
      if (transitionIn) next.transitionIn = { ...scene.transitionIn, ...stripUndefined(transitionIn) };
      if (rest.durationInFrames !== undefined) {
        const over = scene.elements.find((e) => !e.parentId && e.startFrame + e.durationInFrames > rest.durationInFrames!);
        if (over) {
          return err(
            'INVALID',
            `Scene "${scene.name}" cannot be ${rest.durationInFrames} frames long: element "${over.name}" (${over.id}) ends at frame ${over.startFrame + over.durationInFrames}`,
            { path: 'changes.durationInFrames', hint: 'Shorten or move the element first (or in the same batch, before this command).' },
          );
        }
      }
      return { ok: true, project: withScene(project, found.index, next), touched: [{ kind: 'scene', sceneId: scene.id }] };
    }

    case 'setSceneLock': {
      const found = findScene(project, command.sceneId);
      if (!found) return sceneNotFound(command.sceneId);
      if (ctx.source !== 'user') {
        return err('LOCKED', `Only the user can lock or unlock scenes; scene "${found.scene.name}" (${found.scene.id}) was not changed.`);
      }
      if (found.scene.locked === command.locked) return { ok: true, project, touched: [] };
      return {
        ok: true,
        project: withScene(project, found.index, { ...found.scene, locked: command.locked }),
        touched: [{ kind: 'scene', sceneId: found.scene.id }],
      };
    }

    case 'addElement': {
      const found = findScene(project, command.sceneId);
      if (!found) return sceneNotFound(command.sceneId);
      if (found.scene.locked) return lockedError(found.scene);
      const elements = found.scene.elements.slice();
      elements.splice(clampIndex(command.index, elements.length), 0, command.element);
      return {
        ok: true,
        project: withScene(project, found.index, { ...found.scene, elements }),
        touched: [{ kind: 'element', sceneId: found.scene.id, elementId: command.element.id }],
      };
    }

    case 'removeElement': {
      const loc = locateElement(project, command.sceneId, command.elementId);
      if ('error' in loc) return loc.error!;
      const removed = new Set([command.elementId]);
      let grew = true;
      while (grew) { grew = false; for (const el of loc.scene.elements) if (el.parentId && removed.has(el.parentId) && !removed.has(el.id)) { removed.add(el.id); grew = true; } }
      const cleared: string[] = [];
      const elements = loc.scene.elements.filter(e => !removed.has(e.id)).map(e => {
        if (!e.mask || !removed.has(e.mask.sourceId)) return e;
        const next = { ...e }; delete next.mask; cleared.push(e.id); return next;
      });
      return {
        ok: true,
        project: withScene(project, loc.index, { ...loc.scene, elements }),
        touched: [...removed, ...cleared].map(elementId => ({ kind: 'element', sceneId: loc.scene.id, elementId })),
      };
    }

    case 'moveElement': {
      const loc = locateElement(project, command.sceneId, command.elementId);
      if ('error' in loc) return loc.error!;
      const to = clampIndex(command.toIndex, loc.scene.elements.length - 1);
      if (to === loc.elIndex) return { ok: true, project, touched: [] };
      return {
        ok: true,
        project: withScene(project, loc.index, { ...loc.scene, elements: move(loc.scene.elements, loc.elIndex, to) }),
        touched: [{ kind: 'element', sceneId: loc.scene.id, elementId: command.elementId }],
      };
    }

    case 'updateElement': {
      const loc = locateElement(project, command.sceneId, command.elementId);
      if ('error' in loc) return loc.error!;
      const { transform, props, blendMode, effects, mask, ...rest } = command.changes;
      const el = loc.element;
      // Base transform edits never touch `tracks` (same array reference is kept).
      const next: Element = { ...el, ...stripUndefined(rest) };
      if (transform) next.transform = { ...el.transform, ...stripUndefined(transform) };
      if (props) next.props = { ...el.props, ...stripUndefined(props) };
      if (next.locked === false) delete next.locked;
      if (blendMode === null) delete next.blendMode; else if (blendMode !== undefined) next.blendMode = blendMode;
      if (mask === null) delete next.mask; else if (mask !== undefined) next.mask = mask;
      if (effects === null) delete next.effects;
      else if (effects !== undefined) {
        const merged = { ...el.effects };
        for (const [key, value] of Object.entries(effects)) {
          if (value === null) delete (merged as Record<string, unknown>)[key];
          else if (value !== undefined) (merged as Record<string, unknown>)[key] = value;
        }
        if (Object.keys(merged).length) next.effects = merged; else delete next.effects;
      }
      return {
        ok: true,
        project: withScene(project, loc.index, withElement(loc.scene, loc.elIndex, next)),
        touched: [{ kind: 'element', sceneId: loc.scene.id, elementId: el.id }],
      };
    }

    case 'setKeyframe': {
      const loc = locateElement(project, command.sceneId, command.elementId);
      if ('error' in loc) return loc.error!;
      const { frame, value } = command;
      const next = updateTracks(loc.element, command.property, (track) => {
        const keyframes = track ? track.keyframes.slice() : [];
        const i = keyframes.findIndex((k) => k.frame >= frame);
        if (i >= 0 && keyframes[i].frame === frame) {
          keyframes[i] = { frame, value, easing: command.easing ?? keyframes[i].easing };
        } else {
          const kf = { frame, value, easing: command.easing ?? ('easeInOut' as const) };
          if (i < 0) keyframes.push(kf);
          else keyframes.splice(i, 0, kf);
        }
        return { property: command.property, keyframes };
      });
      return {
        ok: true,
        project: withScene(project, loc.index, withElement(loc.scene, loc.elIndex, next)),
        touched: [{ kind: 'element', sceneId: loc.scene.id, elementId: loc.element.id }],
      };
    }

    case 'removeKeyframe': {
      const loc = locateElement(project, command.sceneId, command.elementId);
      if ('error' in loc) return loc.error!;
      const track = loc.element.tracks.find((t) => t.property === command.property);
      if (!track || !track.keyframes.some((k) => k.frame === command.frame)) {
        return err('NOT_FOUND', `Element "${loc.element.name}" has no ${command.property} keyframe at frame ${command.frame}`);
      }
      const next = updateTracks(loc.element, command.property, (t) => {
        const keyframes = t!.keyframes.filter((k) => k.frame !== command.frame);
        return keyframes.length ? { ...t!, keyframes } : null;
      });
      return {
        ok: true,
        project: withScene(project, loc.index, withElement(loc.scene, loc.elIndex, next)),
        touched: [{ kind: 'element', sceneId: loc.scene.id, elementId: loc.element.id }],
      };
    }

    case 'setPropertyKeyframe':
    case 'removePropertyKeyframe': {
      const loc = locateElement(project, command.sceneId, command.elementId);
      if ('error' in loc) return loc.error!;
      const tracks = (loc.element.propTracks ?? []).slice();
      const index = tracks.findIndex(t => t.key === command.key);
      const frames = index < 0 ? [] : tracks[index].keyframes.slice();
      const ki = frames.findIndex(k => k.frame === command.frame);
      if (command.type === 'removePropertyKeyframe') {
        if (ki < 0) return err('NOT_FOUND', `No ${command.key} keyframe at frame ${command.frame}`, { path: 'frame' });
        frames.splice(ki, 1);
      } else {
        const keyframe = { frame: command.frame, value: command.value, easing: command.easing ?? (ki < 0 ? 'easeInOut' as const : frames[ki].easing) };
        if (ki < 0) frames.push(keyframe); else frames[ki] = keyframe;
        frames.sort((a,b) => a.frame-b.frame);
      }
      if (frames.length) { const track = { key: command.key, keyframes: frames }; if (index < 0) tracks.push(track); else tracks[index] = track; }
      else if (index >= 0) tracks.splice(index, 1);
      const element: Element = { ...loc.element, propTracks: tracks };
      if (!tracks.length) delete element.propTracks;
      return { ok: true, project: withScene(project, loc.index, withElement(loc.scene, loc.elIndex, element)), touched: [{ kind: 'element', sceneId: command.sceneId, elementId: command.elementId }] };
    }

    case 'setParent': {
      const loc = locateElement(project, command.sceneId, command.elementId);
      if ('error' in loc) return loc.error!;
      const result = reparent(loc.scene.elements, loc.element, command.parentId, command.keepWorld !== false);
      if (!result.ok) return result;
      return { ok: true, project: withScene(project, loc.index, withElement(loc.scene, loc.elIndex, result.element)), touched: [{ kind: 'element', sceneId: command.sceneId, elementId: command.elementId }] };
    }

    case 'groupElements': {
      const found = findScene(project, command.sceneId);
      if (!found) return sceneNotFound(command.sceneId);
      if (found.scene.locked) return lockedError(found.scene);
      const ids = new Set(command.elementIds);
      if (ids.size !== command.elementIds.length) return err('INVALID', 'elementIds must be unique', { path: 'elementIds' });
      const children = found.scene.elements.filter(el => ids.has(el.id));
      if (children.length !== ids.size) return err('NOT_FOUND', 'Every grouped element must exist in this scene', { path: 'elementIds' });
      if (children.some(el => el.parentId !== children[0].parentId)) return err('INVALID', 'Grouped elements must share the same parent', { path: 'elementIds' });
      if (allElements(project).some(el => el.id === command.group.id)) return err('INVALID', 'Group id already exists', { path: 'group.id' });
      const parentId = children[0].parentId;
      const startFrame = Math.min(...children.map(el => el.startFrame));
      const endFrame = Math.max(...children.map(el => el.startFrame+el.durationInFrames));
      const points = children.flatMap(el => worldCorners(found.scene.elements, el, absoluteStart(found.scene.elements, el)));
      const x = Math.min(...points.map(p => p.x)), y = Math.min(...points.map(p => p.y));
      const width = Math.max(1, Math.max(...points.map(p => p.x))-x), height = Math.max(1, Math.max(...points.map(p => p.y))-y);
      const group: Element = { id: command.group.id, name: command.group.name, type: 'group', startFrame: startFrame+(parentId ? absoluteStart(found.scene.elements, found.scene.elements.find(e => e.id === parentId)!) : 0), durationInFrames: endFrame-startFrame, visible: true, transform: { x, y, width, height, rotation: 0, scale: 1, opacity: 1 }, props: { clip: false }, tracks: [] };
      let elements = [...found.scene.elements, group];
      if (parentId) {
        const result = reparent(elements, group, parentId, true);
        if (!result.ok) return result;
        Object.assign(group, result.element);
      }
      for (const child of children) {
        const result = reparent(elements, child, group.id, true);
        if (!result.ok) return result;
        elements = elements.map(el => el.id === child.id ? result.element : el);
      }
      // Later elements are topmost. Insert at that child's slot after removing the appended group.
      const top = Math.max(...children.map(el => found.scene.elements.indexOf(el)));
      elements.pop(); elements.splice(top, 0, group);
      return { ok: true, project: withScene(project, found.index, { ...found.scene, elements }), touched: [{ kind: 'scene', sceneId: command.sceneId }] };
    }

    case 'ungroup': {
      const loc = locateElement(project, command.sceneId, command.groupId);
      if ('error' in loc) return loc.error!;
      if (loc.element.type !== 'group') return err('INVALID', 'ungroup requires a group element', { path: 'groupId' });
      let elements = loc.scene.elements;
      const children = loc.scene.elements.filter(el => el.parentId === command.groupId);
      const promoted = new Set(children.map(el => el.id));
      for (const child of children) {
        const result = reparent(elements, child, loc.element.parentId ?? null, true);
        if (!result.ok) return result;
        elements = elements.map(el => el.id === child.id ? result.element : el);
      }
      const promotedChildren = elements.filter(el => promoted.has(el.id));
      // Replace the group's current paint slot with its children, in their paint order.
      elements = elements.flatMap(el => el.id === command.groupId ? promotedChildren : promoted.has(el.id) ? [] : [el]);
      return { ok: true, project: withScene(project, loc.index, { ...loc.scene, elements }), touched: [{ kind: 'scene', sceneId: command.sceneId }] };
    }

    case 'addComposition':
    case 'updateComposition':
    case 'removeComposition': {
      const id = command.type === 'addComposition' ? command.composition.id : command.compositionId;
      const existing = Object.prototype.hasOwnProperty.call(project.compositions, id) ? project.compositions[id] : undefined;
      if (command.type === 'addComposition' && existing) return err('INVALID', `Composition ${id} already exists`, { path: 'composition.id' });
      if (command.type !== 'addComposition' && !existing) return err('NOT_FOUND', `Composition ${id} not found`, { path: 'compositionId' });
      if (command.type !== 'addComposition') {
        const locked = project.scenes.find(scene => scene.locked && compositionDependencies(project, scene.elements).has(id));
        if (locked) return lockedError(locked, 'change a composition it renders');
      }
      if (command.type === 'removeComposition' && allElements(project).some(el => el.type === 'instance' && el.props.compositionId === id)) return err('INVALID', `Composition ${id} is still referenced by an instance`, { path: 'compositionId', hint: 'Remove or retarget its instances first.' });
      const compositions = { ...project.compositions };
      if (command.type === 'removeComposition') delete compositions[id];
      else compositions[id] = command.type === 'addComposition' ? command.composition : { ...existing!, ...stripUndefined(command.changes) };
      return { ok: true, project: { ...project, compositions }, touched: [{ kind: 'composition', compositionId: id }] };
    }

    case 'setMarker': {
      const markers = project.markers.filter(m => m.id !== command.marker.id);
      markers.push(command.marker); markers.sort((a,b) => a.frame-b.frame || a.id.localeCompare(b.id));
      return { ok: true, project: { ...project, markers }, touched: [{ kind: 'project' }] };
    }
    case 'removeMarker': {
      if (!project.markers.some(m => m.id === command.markerId)) return err('NOT_FOUND', `Marker ${command.markerId} not found`, { path: 'markerId' });
      return { ok: true, project: { ...project, markers: project.markers.filter(m => m.id !== command.markerId) }, touched: [{ kind: 'project' }] };
    }
    case 'changeFormat': {
      const locked = project.scenes.find(scene => scene.locked);
      if (locked && (command.width !== project.width || command.height !== project.height || command.fps !== project.fps)) return lockedError(locked, 'change the project format');
      const converted = convertFormat(project, command);
      const audioTouches = converted.audio.filter((clip, i) => !deepEqual(clip, project.audio[i])).map(clip => ({ kind: 'audio' as const, clipId: clip.id }));
      return { ok: true, project: converted, touched: [{ kind: 'project' }, ...project.scenes.map(scene => ({ kind: 'scene' as const, sceneId: scene.id })), ...audioTouches] };
    }

    case 'addAsset': {
      const { asset } = command;
      if (Object.prototype.hasOwnProperty.call(project.assets, asset.id)) {
        return err('INVALID', `Asset id ${asset.id} already exists`, { path: 'asset.id', hint: 'Use replaceAsset to swap the file, or a new id.' });
      }
      return { ok: true, project: { ...project, assets: { ...project.assets, [asset.id]: asset } }, touched: [{ kind: 'asset', assetId: asset.id }] };
    }

    case 'replaceAsset': {
      const asset = Object.prototype.hasOwnProperty.call(project.assets, command.assetId) ? project.assets[command.assetId] : undefined;
      if (!asset) return err('NOT_FOUND', `Asset ${command.assetId} not found`);
      const next = { ...asset, ...stripUndefined(command.changes), id: asset.id };
      if (deepEqual(next, asset)) return { ok: true, project, touched: [] };
      // Replacing a file used by an approved scene would change that scene's render.
      // (Renaming the asset does not, so it stays allowed.)
      const lockedUsers = renderedAssetEqual(next, asset) ? [] : project.scenes.filter((s) => s.locked && sceneAssetIds(project, s).has(asset.id));
      if (lockedUsers.length) {
        return err(
          'LOCKED',
          `Asset "${asset.name}" (${asset.id}) is used by locked scene${lockedUsers.length > 1 ? 's' : ''} ${lockedUsers.map((s) => `"${s.name}" (${s.id})`).join(', ')}. Unlock ${lockedUsers.length > 1 ? 'them' : 'it'} first to replace this asset.`,
          { hint: 'Approved scenes are locked; unlock the scene in the editor, or add a new asset for the unlocked scenes.' },
        );
      }
      return { ok: true, project: { ...project, assets: { ...project.assets, [asset.id]: next } }, touched: [{ kind: 'asset', assetId: asset.id }] };
    }

    case 'addAudioClip': {
      const { clip } = command;
      if (project.audio.some((c) => c.id === clip.id)) return err('INVALID', `Audio clip id ${clip.id} already exists`, { path: 'clip.id', hint: 'Use a new id for the clip.' });
      if (clip.sceneId) {
        const found = findScene(project, clip.sceneId);
        if (found?.scene.locked) return lockedError(found.scene, 'add audio to it');
      }
      return { ok: true, project: { ...project, audio: [...project.audio, clip] }, touched: [{ kind: 'audio', clipId: clip.id }] };
    }

    case 'updateAudioClip': {
      const i = project.audio.findIndex((c) => c.id === command.clipId);
      if (i < 0) return err('NOT_FOUND', `Audio clip ${command.clipId} not found`);
      const clip = project.audio[i];
      const next = { ...clip, ...command.changes, id: clip.id };
      if ('sceneId' in command.changes && command.changes.sceneId === undefined) delete next.sceneId;
      for (const sid of new Set([clip.sceneId, next.sceneId])) {
        const found = sid ? findScene(project, sid) : null;
        if (found?.scene.locked) return lockedError(found.scene, 'change its audio');
      }
      const audio = project.audio.slice();
      audio[i] = next;
      return { ok: true, project: { ...project, audio }, touched: [{ kind: 'audio', clipId: clip.id }] };
    }

    case 'removeAudioClip': {
      const clip = project.audio.find((c) => c.id === command.clipId);
      if (!clip) return err('NOT_FOUND', `Audio clip ${command.clipId} not found`);
      const found = clip.sceneId ? findScene(project, clip.sceneId) : null;
      if (found?.scene.locked) return lockedError(found.scene, 'change its audio');
      return { ok: true, project: { ...project, audio: project.audio.filter((c) => c.id !== clip.id) }, touched: [{ kind: 'audio', clipId: clip.id }] };
    }

    case 'setStyle': {
      // Project-level: presets, templates and agents read it; nothing in a scene changes.
      if (command.style === null) {
        if (!project.style) return { ok: true, project, touched: [] };
        const { style: _cleared, ...rest } = project;
        return { ok: true, project: rest, touched: [{ kind: 'project' }] };
      }
      if (deepEqual(project.style, command.style)) return { ok: true, project, touched: [] };
      return { ok: true, project: { ...project, style: command.style }, touched: [{ kind: 'project' }] };
    }

    case 'detachVideoAudio': {
      const loc = locateElement(project, command.sceneId, command.elementId);
      if ('error' in loc) return loc.error!;
      if (project.audio.some((c) => c.id === command.clipId)) return err('INVALID', `Audio clip id ${command.clipId} already exists`, { path: 'clipId', hint: 'Use a new id for the detached clip.' });
      const detached = detachedAudioClip(project, loc.scene, loc.element, command.clipId);
      if (!detached.ok) return err('INVALID', detached.message, { ...(detached.path ? { path: detached.path } : {}), ...(detached.hint ? { hint: detached.hint } : {}) });
      const muted: Element = { ...loc.element, props: { ...loc.element.props, muted: true } };
      return {
        ok: true,
        project: { ...withScene(project, loc.index, withElement(loc.scene, loc.elIndex, muted)), audio: [...project.audio, detached.clip] },
        touched: [{ kind: 'element', sceneId: loc.scene.id, elementId: loc.element.id }, { kind: 'audio', clipId: command.clipId }],
      };
    }

    case 'batch': {
      let cur = project;
      const touched: TouchedRef[] = [];
      for (let i = 0; i < command.commands.length; i++) {
        const r = applyInner(cur, command.commands[i], ctx);
        if (!r.ok) return { ok: false, error: prefixPath(r.error, `commands[${i}]`) };
        cur = r.project;
        touched.push(...r.touched);
      }
      return { ok: true, project: cur, touched };
    }
  }
}

/**
 * IDs of every asset a scene renders: asset-typed props of its elements plus
 * audio clips anchored to it. Project-level audio clips belong to no scene.
 */
export function sceneAssetIds(project: Project, scene: Scene): Set<string> {
  const ids = new Set<string>();
  const elements = [...scene.elements, ...[...compositionDependencies(project, scene.elements)].flatMap(id => project.compositions[id]?.elements ?? [])];
  for (const el of elements) {
    const def = COMPONENTS[el.type];
    if (!def) continue;
    for (const f of def.fields) {
      if (f.kind !== 'asset') continue;
      const v = el.props[f.key];
      if (typeof v === 'string' && v) ids.add(v);
    }
  }
  for (const clip of project.audio) if (clip.sceneId === scene.id) ids.add(clip.assetId);
  return ids;
}

/** Do two assets render identically? Everything but the display `name` and the preview-only `proxySrc` counts. */
export function renderedAssetEqual(a: Asset | undefined, b: Asset | undefined): boolean {
  if (!a || !b) return a === b;
  const { name: _a, proxySrc: _pa, ...ra } = a;
  const { name: _b, proxySrc: _pb, ...rb } = b;
  return deepEqual(ra, rb);
}

export function touchedKey(ref: TouchedRef): string {
  switch (ref.kind) {
    case 'project':
      return 'project';
    case 'composition':
      return `composition:${ref.compositionId}`;
    case 'scene':
      return `scene:${ref.sceneId}`;
    case 'element':
      return `element:${ref.sceneId}/${ref.elementId}`;
    case 'asset':
      return `asset:${ref.assetId}`;
    case 'audio':
      return `audio:${ref.clipId}`;
  }
}

/** Remove duplicates, preserving first-seen order. */
export function dedupeTouched(refs: readonly TouchedRef[]): TouchedRef[] {
  const seen = new Set<string>();
  const out: TouchedRef[] = [];
  for (const r of refs) {
    const k = touchedKey(r);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(r);
    }
  }
  return out;
}

export function applyCommand(project: Project, command: Command, ctx: CommandContext): CommandResult {
  const shape = CommandSchema.safeParse(command);
  if (!shape.success) {
    const { path, message } = firstIssue(shape.error);
    return { ok: false, error: { code: 'INVALID', message, path } };
  }
  // Apply only the parsed value: strict schemas reject unknown keys, so the
  // command cannot smuggle undeclared fields (tracks, locked, elements…) in.
  const r = applyInner(project, shape.data, ctx);
  if (!r.ok) return r;
  if (r.project !== project) {
    // Full validation (shape + semantics) before anything is committed: a
    // command must never produce a project that validateProject/loadDoc rejects.
    const full = ProjectSchema.safeParse(r.project);
    if (!full.success) {
      const { path, message } = firstIssue(full.error);
      return { ok: false, error: { code: 'INVALID', message, path } };
    }
    const invalid = checkProject(r.project);
    if (invalid) return { ok: false, error: invalid };
  }
  return { ok: true, project: r.project, touched: dedupeTouched(r.touched) };
}
