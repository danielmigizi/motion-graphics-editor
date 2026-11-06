// Whole-document validation (used on load/import and after every command).
//
// Two layers:
// 1. Shape — zod schemas in schema.ts (types, required keys, enums).
// 2. Semantics — checkProject(): component prop schemas, numeric ranges,
//    integer frames, timing bounds, sorted keyframes, unique IDs and asset
//    references. Returns the FIRST error with a precise path such as
//    `scenes[1].elements[2].props.fontSize` and an actionable message.

import { parseColor } from './color';
import { migrateProject, migrateProjectFile } from './migrate';
import { projectDurationInFrames } from './timing';
import { PaintSchema, PathNodeSchema } from './schema';
import { COMPONENTS, componentFields } from './components';
import { deepEqual } from './diff';
import { MAX_INSTANCE_DEPTH } from './limits';
import { videoMaxDuration } from './video';
import type { FieldDescriptor } from './components';
import { firstIssue, ProjectFileSchema, ProjectSchema } from './schema';
import type { AnimationTrack, Asset, AudioClip, CommandError, EasingSpec, Element, Project, ProjectFile, ProjectStory, Scene, StyleCraft, StylePack } from './types';
import { STORY_BEAT_ROLES } from './types';

export type ValidateResult<T> = { ok: true; value: T } | { ok: false; error: CommandError };

export function isValidColor(value: unknown, allowNone = false): boolean {
  if (allowNone && value === 'none') return true;
  return parseColor(value) !== null;
}

class Invalid extends Error {
  constructor(
    readonly path: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
  }
}

const fmt = (v: unknown) => (typeof v === 'string' ? JSON.stringify(v) : String(v));

function fail(path: string, message: string, hint?: string): never {
  throw new Invalid(path, message, hint);
}

function int(path: string, name: string, v: number, min: number, max = Infinity) {
  if (!Number.isInteger(v)) fail(path, `${name} must be a whole number; got ${fmt(v)}`);
  if (v < min || v > max) {
    fail(path, max === Infinity ? `${name} must be at least ${min}; got ${v}` : `${name} must be between ${min} and ${max}; got ${v}`);
  }
}

function range(path: string, name: string, v: number, min: number, max: number) {
  if (v < min || v > max) fail(path, `${name} must be between ${min} and ${max}; got ${v}`);
}

function color(path: string, name: string, v: unknown, allowNone = false) {
  if (!isValidColor(v, allowNone)) {
    fail(path, `${name} must be a hex colour (#RGB, #RRGGBB or #RRGGBBAA) or rgb()/rgba()${allowNone ? " or 'none'" : ''}; got ${fmt(v)}`);
  }
}

function checkField(f: FieldDescriptor, value: unknown, path: string, project: Project) {
  const name = f.key;
  switch (f.kind) {
    case 'text':
    case 'multiline':
      if (typeof value !== 'string') fail(path, `${name} must be a string; got ${fmt(value)}`);
      if (f.maxLength !== undefined && value.length > f.maxLength) {
        fail(path, `${name} must be at most ${f.maxLength} characters; got ${value.length}`, 'Shorten the text.');
      }
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, `${name} must be a number; got ${fmt(value)}`);
      if (f.integer && !Number.isInteger(value)) fail(path, `${name} must be a whole number; got ${value}`);
      range(path, name, value, f.min, f.max);
      return;
    case 'composition':
      if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(project.compositions, value)) fail(path, `${name} references unknown composition ${fmt(value)}`);
      return;
    case 'pathNodes': {
      if (!Array.isArray(value) || value.length < 2) fail(path, 'nodes must contain at least two path nodes');
      value.forEach((node, i) => { const result = PathNodeSchema.safeParse(node); if (!result.success) { const issue = firstIssue(result.error, `${path}[${i}]`); fail(issue.path, issue.message); } });
      return;
    }
    case 'paint': {
      const result = PaintSchema.safeParse(value);
      if (!result.success) { const issue = firstIssue(result.error, path); fail(issue.path, issue.message); }
      const paint = result.data;
      if (typeof paint === 'string') color(path, name, paint, f.allowNone);
      else {
        if (paint.stops.length < 2) fail(`${path}.stops`, 'A gradient needs at least two stops');
        let previous = -Infinity;
        paint.stops.forEach((stop, i) => {
          range(`${path}.stops[${i}].offset`, 'offset', stop.offset, 0, 1);
          if (stop.offset < previous) fail(`${path}.stops[${i}].offset`, 'Gradient stops must be sorted by offset');
          previous = stop.offset;
          color(`${path}.stops[${i}].color`, 'color', stop.color);
        });
      }
      return;
    }
    case 'color':
      color(path, name, value, f.allowNone);
      return;
    case 'select': {
      const allowed = f.options.map((o) => o.value);
      if (!allowed.includes(value as string | number)) {
        fail(path, `${name} must be one of ${allowed.map(fmt).join(', ')}; got ${fmt(value)}`);
      }
      return;
    }
    case 'boolean':
      if (typeof value !== 'boolean') fail(path, `${name} must be true or false; got ${fmt(value)}`);
      return;
    case 'asset': {
      if (typeof value !== 'string' || value === '') {
        fail(path, `${name} must reference an asset (${f.assetKinds.join(' or ')}); got ${fmt(value)}`, 'Pick a file for this element.');
      }
      const asset = Object.prototype.hasOwnProperty.call(project.assets, value) ? project.assets[value] : undefined;
      if (!asset) fail(path, `${name} references unknown asset ${fmt(value)}`, 'Add the asset first or pick an existing one.');
      if (!f.assetKinds.includes(asset.kind)) {
        fail(path, `${name} must reference a ${f.assetKinds.join(' or ')} asset; ${fmt(value)} is ${asset.kind}`);
      }
      return;
    }
  }
}

export function checkElementProps(element: Element, path: string, project: Project) {
  const def = COMPONENTS[element.type];
  const known = new Set(def.fields.map((f) => f.key));
  for (const key of Object.keys(element.props)) {
    if (!known.has(key)) {
      fail(`${path}.props.${key}`, `${key} is not a property of ${def.label} elements`, `Allowed properties: ${[...known].join(', ')}.`);
    }
  }
  for (const f of componentFields(element.type, project.fps)) {
    const p = `${path}.props.${f.key}`;
    if (!Object.prototype.hasOwnProperty.call(element.props, f.key) || element.props[f.key] === undefined) {
      if (f.optional) continue;
      fail(p, `${f.key} is required for ${def.label} elements`);
    }
    checkField(f, element.props[f.key], p, project);
  }
}

function checkTracks(tracks: AnimationTrack[], path: string) {
  const seen = new Set<string>();
  tracks.forEach((t, ti) => {
    const tp = `${path}.tracks[${ti}]`;
    if (seen.has(t.property)) fail(`${tp}.property`, `Element has more than one ${t.property} track; merge them into one`);
    seen.add(t.property);
    let prev = -Infinity;
    t.keyframes.forEach((k, ki) => {
      checkEasing(k.easing, `${tp}.keyframes[${ki}].easing`);
      const kp = `${tp}.keyframes[${ki}].frame`;
      int(kp, 'Keyframe frame', k.frame, 0);
      if (k.frame === prev) fail(kp, `Keyframes of the ${t.property} track must have unique frames; frame ${k.frame} appears twice`);
      if (k.frame < prev) fail(kp, `Keyframes of the ${t.property} track must be sorted by frame; ${k.frame} comes after ${prev}`);
      prev = k.frame;
    });
  });
}

function checkElement(el: Element, scene: Pick<Scene, 'name' | 'durationInFrames'>, path: string, project: Project) {
  int(`${path}.startFrame`, 'startFrame', el.startFrame, 0);
  int(`${path}.durationInFrames`, 'durationInFrames', el.durationInFrames, 1);
  if (!el.parentId && el.startFrame + el.durationInFrames > scene.durationInFrames) {
    fail(
      `${path}.durationInFrames`,
      `Element "${el.name}" ends at frame ${el.startFrame + el.durationInFrames} but scene "${scene.name}" is only ${scene.durationInFrames} frames long`,
      'Shorten or move the element, or lengthen the scene first.',
    );
  }
  const t = el.transform;
  if (t.width <= 0) fail(`${path}.transform.width`, `width must be greater than 0; got ${t.width}`);
  if (t.height <= 0) fail(`${path}.transform.height`, `height must be greater than 0; got ${t.height}`);
  if (t.scale <= 0) fail(`${path}.transform.scale`, `scale must be greater than 0; got ${t.scale}`);
  range(`${path}.transform.opacity`, 'opacity', t.opacity, 0, 1);
  checkTracks(el.tracks, path);
  checkElementProps(el, path, project);
  checkEffectsAndPropertyTracks(el, path, project);
  if (el.type === 'video') checkVideo(el, path, project);
}

/** Video: the in-point lies inside the file, and without loop the trimmed source (÷ speed) fills the element. */
function checkVideo(el: Element, path: string, project: Project) {
  const asset = project.assets[el.props.assetId as string];
  const trim = el.props.trimStartFrames as number;
  const rate = el.props.playbackRate as number;
  if (asset.durationInFrames === undefined) return;
  if (trim >= asset.durationInFrames) {
    fail(`${path}.props.trimStartFrames`, `trimStartFrames ${trim} is past the end of “${asset.name}” (${asset.durationInFrames} frames)`, `Use an in-point below ${asset.durationInFrames}.`);
  }
  const max = videoMaxDuration(asset.durationInFrames, trim, rate, el.props.loop === true);
  if (el.durationInFrames > max) {
    fail(
      `${path}.durationInFrames`,
      `Video "${el.name}" lasts ${el.durationInFrames} frames but “${asset.name}” has only ${max} frames left after trimStartFrames ${trim} at ${rate}× speed`,
      `Shorten the element to at most ${max} frames, lower the speed or the in-point, or turn on loop.`,
    );
  }
}

function checkScene(scene: Scene, path: string, project: Project) {
  int(`${path}.durationInFrames`, 'Scene durationInFrames', scene.durationInFrames, 1);
  color(`${path}.backgroundColor`, 'backgroundColor', scene.backgroundColor);
  int(`${path}.transitionIn.durationInFrames`, 'transitionIn.durationInFrames', scene.transitionIn.durationInFrames, 0, scene.durationInFrames);
  checkTree(scene, path, project);
}

function checkEasing(spec: EasingSpec, path: string) {
  if (typeof spec === 'string') return;
  for (const key of ['x1', 'x2'] as const) range(`${path}.${key}`, key, spec[key], 0, 1);
  for (const key of ['y1', 'y2'] as const) range(`${path}.${key}`, key, spec[key], -2, 3);
}

function checkEffectsAndPropertyTracks(el: Element, path: string, project: Project) {
  for (const key of ['blur', 'brightness', 'contrast', 'saturate'] as const) {
    const value = el.effects?.[key];
    if (value !== undefined) range(`${path}.effects.${key}`, key, value, 0, key === 'blur' ? 200 : 3);
  }
  if (el.effects?.dropShadow) {
    range(`${path}.effects.dropShadow.blur`, 'blur', el.effects.dropShadow.blur, 0, 200);
    color(`${path}.effects.dropShadow.color`, 'color', el.effects.dropShadow.color);
  }
  const keys = new Set<string>();
  el.propTracks?.forEach((track, ti) => {
    const tp = `${path}.propTracks[${ti}]`;
    if (keys.has(track.key)) fail(`${tp}.key`, 'Property tracks must have unique keys');
    keys.add(track.key);
    const [namespace, fieldKey, extra] = track.key.split('.');
    let field: FieldDescriptor;
    if (namespace === 'effects' && !extra && ['blur', 'brightness', 'contrast', 'saturate'].includes(fieldKey)) {
      field = { kind: 'number', key: fieldKey, label: fieldKey, min: 0, max: fieldKey === 'blur' ? 200 : 3, step: 0.01 };
    } else {
      const candidate = componentFields(el.type, project.fps).find(f => f.key === fieldKey);
      if (namespace !== 'props' || extra || !candidate?.animatable) fail(`${tp}.key`, `${track.key} is not an animatable property`);
      field = candidate;
      if (field.kind === 'paint') {
        if (!isValidColor(el.props[fieldKey])) fail(`${tp}.key`, 'Colour tracks cannot target a gradient or none paint');
        field = { kind: 'color', key: fieldKey, label: field.label };
      }
    }
    let prev = -Infinity;
    track.keyframes.forEach((keyframe, ki) => {
      const kp = `${tp}.keyframes[${ki}]`;
      int(`${kp}.frame`, 'Keyframe frame', keyframe.frame, 0);
      if (keyframe.frame <= prev) fail(`${kp}.frame`, 'Keyframes must be sorted with unique frames');
      prev = keyframe.frame;
      checkEasing(keyframe.easing, `${kp}.easing`);
      checkField(field, keyframe.value, `${kp}.value`, project);
    });
  });
}

/** Children may extend beyond a group; world evaluation clips to every ancestor lifetime. */
function checkTree(tree: Pick<Scene, 'name' | 'durationInFrames' | 'elements'>, path: string, project: Project) {
  const byId = new Map(tree.elements.map(el => [el.id, el]));
  tree.elements.forEach((el, i) => {
    const ep = `${path}.elements[${i}]`;
    if (el.parentId) {
      const parent = byId.get(el.parentId);
      if (!parent || parent.type !== 'group') fail(`${ep}.parentId`, 'parentId must reference a group in the same scene or composition');
      const visited = new Set([el.id]);
      let cursor: Element | undefined = parent;
      while (cursor) {
        if (visited.has(cursor.id)) fail(`${ep}.parentId`, 'Parent chains must not contain cycles');
        visited.add(cursor.id);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      }
    }
    if (el.mask) {
      const source = byId.get(el.mask.sourceId);
      if (!source || source.id === el.id || !['shape', 'path'].includes(source.type) || source.parentId !== el.parentId || source.mask) {
        fail(`${ep}.mask.sourceId`, 'Mask source must be another unmasked shape or path with the same parent');
      }
    }
    checkElement(el, tree, ep, project);
  });
}

function checkAsset(asset: Asset, key: string, path: string) {
  if (asset.id !== key) fail(`${path}.id`, `Asset id ${fmt(asset.id)} must match its key ${fmt(key)}`);
  if (asset.width !== undefined && !(asset.width > 0)) fail(`${path}.width`, `width must be greater than 0; got ${asset.width}`);
  if (asset.height !== undefined && !(asset.height > 0)) fail(`${path}.height`, `height must be greater than 0; got ${asset.height}`);
  if (asset.durationInFrames !== undefined) int(`${path}.durationInFrames`, 'durationInFrames', asset.durationInFrames, 1);
  if (asset.fps !== undefined && !(asset.fps > 0)) fail(`${path}.fps`, `fps must be greater than 0; got ${asset.fps}`);
}

const STORY_TEXT_MAX = 400;
const STORY_BEATS_MAX = 24;

function checkStoryText(path: string, name: string, value: string | undefined, required: boolean) {
  if (value === undefined) {
    if (required) fail(path, `${name} is required`);
    return;
  }
  if (typeof value !== 'string' || !value.trim()) fail(path, `${name} must be a non-empty string`);
  if (value.length > STORY_TEXT_MAX) fail(path, `${name} must be at most ${STORY_TEXT_MAX} characters`);
}

function checkStory(story: ProjectStory, path: string) {
  checkStoryText(`${path}.idea`, 'idea', story.idea, true);
  checkStoryText(`${path}.hook`, 'hook', story.hook, true);
  checkStoryText(`${path}.audience`, 'audience', story.audience, false);
  checkStoryText(`${path}.tension`, 'tension', story.tension, false);
  checkStoryText(`${path}.payoff`, 'payoff', story.payoff, true);
  checkStoryText(`${path}.cta`, 'cta', story.cta, false);
  if (story.beats.length > STORY_BEATS_MAX) fail(`${path}.beats`, `beats may list at most ${STORY_BEATS_MAX} items`);
  story.beats.forEach((beat, i) => {
    const bp = `${path}.beats[${i}]`;
    if (!(STORY_BEAT_ROLES as readonly string[]).includes(beat.role)) {
      fail(`${bp}.role`, `role must be one of ${STORY_BEAT_ROLES.join(', ')}; got ${fmt(beat.role)}`);
    }
    checkStoryText(`${bp}.summary`, 'summary', beat.summary, true);
    if (beat.sceneName !== undefined && beat.sceneName.length > 80) fail(`${bp}.sceneName`, 'sceneName must be at most 80 characters');
    if (beat.fromFrame !== undefined) int(`${bp}.fromFrame`, 'fromFrame', beat.fromFrame, 0);
    if (beat.toFrame !== undefined) int(`${bp}.toFrame`, 'toFrame', beat.toFrame, 0);
    if (beat.fromFrame !== undefined && beat.toFrame !== undefined && beat.toFrame < beat.fromFrame) {
      fail(`${bp}.toFrame`, 'toFrame must be at or after fromFrame');
    }
    if (beat.fromSeconds !== undefined) range(`${bp}.fromSeconds`, 'fromSeconds', beat.fromSeconds, 0, 120);
    if (beat.toSeconds !== undefined) range(`${bp}.toSeconds`, 'toSeconds', beat.toSeconds, 0, 120);
  });
}

/** Style pack (schemaVersion 3): colour roles are colours; motion stays inside its documented ranges. */
function checkStyle(style: StylePack, path: string) {
  for (const [key, value] of Object.entries(style.colors)) if (value !== undefined) color(`${path}.colors.${key}`, key, value);
  const m = style.motion, mp = `${path}.motion`;
  range(`${mp}.timingScale`, 'timingScale', m.timingScale, 0.5, 2);
  int(`${mp}.staggerFrames`, 'staggerFrames', m.staggerFrames, 0, 12);
  range(`${mp}.overshoot`, 'overshoot', m.overshoot, 0, 0.3);
  checkEasing(m.enter, `${mp}.enter`);
  checkEasing(m.exit, `${mp}.exit`);
  if (style.craft) checkCraft(style.craft, `${path}.craft`);
}

function checkBand(path: string, name: string, band: { min: number; max: number }, min: number, max: number) {
  range(`${path}.min`, `${name}.min`, band.min, min, max);
  range(`${path}.max`, `${name}.max`, band.max, min, max);
  if (band.max < band.min) fail(`${path}.max`, `${name}.max must be ≥ ${name}.min`);
}

function checkCraft(craft: StyleCraft, path: string) {
  checkBand(`${path}.popFrames`, 'popFrames', craft.popFrames, 1, 40);
  checkBand(`${path}.staggerFrames`, 'staggerFrames', craft.staggerFrames, 0, 16);
  int(`${path}.landCadence`, 'landCadence', craft.landCadence, 1, 30);
  range(`${path}.typeCharsPerFrame`, 'typeCharsPerFrame', craft.typeCharsPerFrame, 0, 4);
  int(`${path}.trueHoldMaxFrames`, 'trueHoldMaxFrames', craft.trueHoldMaxFrames, 1, 180);
  range(`${path}.driftPxPerFrame`, 'driftPxPerFrame', craft.driftPxPerFrame, 0, 20);
  checkBand(`${path}.cameraFrames`, 'cameraFrames', craft.cameraFrames, 4, 180);
  range(`${path}.spring.fromScale`, 'spring.fromScale', craft.spring.fromScale, 1, 8);
  int(`${path}.spring.frames`, 'spring.frames', craft.spring.frames, 2, 40);
  int(`${path}.beatOffsetFrames`, 'beatOffsetFrames', craft.beatOffsetFrames, -12, 12);
  int(`${path}.beatOffsetWindow`, 'beatOffsetWindow', craft.beatOffsetWindow, 0, 8);
  range(`${path}.smear.blurPx`, 'smear.blurPx', craft.smear.blurPx, 0, 80);
  int(`${path}.smear.frames`, 'smear.frames', craft.smear.frames, 0, 20);
  checkBand(`${path}.typeHeightShare`, 'typeHeightShare', craft.typeHeightShare, 0.01, 0.3);
  range(`${path}.maxEmptyShare`, 'maxEmptyShare', craft.maxEmptyShare, 0.2, 0.95);
}

function checkClip(clip: AudioClip, path: string, project: Project) {
  const asset = Object.prototype.hasOwnProperty.call(project.assets, clip.assetId) ? project.assets[clip.assetId] : undefined;
  if (!asset) fail(`${path}.assetId`, `Audio clip "${clip.name}" references unknown asset ${fmt(clip.assetId)}`);
  // A clip may play a video file's soundtrack (detached video audio).
  if (asset.kind !== 'audio' && asset.kind !== 'video') fail(`${path}.assetId`, `Audio clip "${clip.name}" must reference an audio asset (or a video with sound); ${fmt(clip.assetId)} is ${asset.kind}`);
  if (asset.kind === 'video' && asset.hasAudio === false) fail(`${path}.assetId`, `Audio clip "${clip.name}" references video ${fmt(clip.assetId)}, which has no soundtrack`);
  if (clip.sceneId !== undefined && !project.scenes.some((s) => s.id === clip.sceneId)) {
    fail(`${path}.sceneId`, `Audio clip "${clip.name}" is anchored to unknown scene ${fmt(clip.sceneId)}`, 'Anchor it to an existing scene or remove sceneId.');
  }
  int(`${path}.startFrame`, 'startFrame', clip.startFrame, 0);
  int(`${path}.trimStartFrames`, 'trimStartFrames', clip.trimStartFrames, 0);
  int(`${path}.durationInFrames`, 'durationInFrames', clip.durationInFrames, 1);
  range(`${path}.volume`, 'volume', clip.volume, 0, 1);
  int(`${path}.fadeInFrames`, 'fadeInFrames', clip.fadeInFrames, 0, clip.durationInFrames);
  int(`${path}.fadeOutFrames`, 'fadeOutFrames', clip.fadeOutFrames, 0, clip.durationInFrames);
  let previous = -Infinity;
  clip.volumeEnvelope?.forEach((point, i) => {
    const pp = `${path}.volumeEnvelope[${i}]`;
    int(`${pp}.frame`, 'Envelope frame', point.frame, 0, clip.durationInFrames);
    if (point.frame <= previous) fail(`${pp}.frame`, 'Volume envelope points must be sorted with unique frames');
    previous = point.frame;
    range(`${pp}.value`, 'value', point.value, 0, 1);
  });
}

/** Semantic validation of a shape-valid project. Returns the first error, or null. */
export function checkProject(project: Project): CommandError | null {
  try {
    int('revision', 'revision', project.revision, 0);
    int('fps', 'fps', project.fps, 1, 120);
    int('width', 'width', project.width, 1, 8192);
    int('height', 'height', project.height, 1, 8192);
    color('backgroundColor', 'backgroundColor', project.backgroundColor);
    if (project.style) checkStyle(project.style, 'style');
    if (project.banned) {
      if (project.banned.length > 40) fail('banned', 'banned may list at most 40 items');
      project.banned.forEach((item, i) => {
        if (typeof item !== 'string' || !item.trim()) fail(`banned[${i}]`, 'banned items must be non-empty strings');
        if (item.length > 80) fail(`banned[${i}]`, 'banned items must be at most 80 characters');
      });
    }
    if (project.story) checkStory(project.story, 'story');

    const ids = new Map<string, string>([[project.id, 'id']]);
    const claim = (id: string, path: string) => {
      const prev = ids.get(id);
      if (prev !== undefined) fail(path, `ID ${fmt(id)} is used more than once (also at ${prev}); IDs must be unique across the project`);
      ids.set(id, path);
    };
    project.scenes.forEach((s, si) => {
      claim(s.id, `scenes[${si}].id`);
      s.elements.forEach((e, ei) => claim(e.id, `scenes[${si}].elements[${ei}].id`));
    });
    for (const [key, comp] of Object.entries(project.compositions)) {
      claim(comp.id, `compositions.${key}.id`);
      if (comp.id !== key) fail(`compositions.${key}.id`, 'Composition id must match its map key');
      comp.elements.forEach((el, i) => claim(el.id, `compositions.${key}.elements[${i}].id`));
      int(`compositions.${key}.width`, 'width', comp.width, 1);
      int(`compositions.${key}.height`, 'height', comp.height, 1);
      int(`compositions.${key}.durationInFrames`, 'durationInFrames', comp.durationInFrames, 1);
      if (comp.backgroundColor !== 'transparent') color(`compositions.${key}.backgroundColor`, 'backgroundColor', comp.backgroundColor);
      checkTree(comp, `compositions.${key}`, project);
    }
    const visiting = new Set<string>(), depths = new Map<string, number>();
    const visit = (id: string, path: string): number => {
      if (visiting.has(id)) fail(path, 'Composition instances must not contain cycles');
      if (depths.has(id)) return depths.get(id)!;
      visiting.add(id);
      let depth = 1;
      project.compositions[id].elements.forEach((el, i) => {
        if (el.type !== 'instance') return;
        const instancePath = `compositions.${id}.elements[${i}].props.compositionId`;
        depth = Math.max(depth, 1 + visit(el.props.compositionId as string, instancePath));
        if (depth > MAX_INSTANCE_DEPTH) fail(instancePath, `Composition instances may nest at most ${MAX_INSTANCE_DEPTH} levels`);
      });
      visiting.delete(id);
      depths.set(id, depth);
      return depth;
    };
    for (const id of Object.keys(project.compositions)) visit(id, `compositions.${id}`);
    let previousMarker = -Infinity;
    project.markers.forEach((marker, i) => {
      const path = `markers[${i}]`;
      claim(marker.id, `${path}.id`);
      int(`${path}.frame`, 'Marker frame', marker.frame, 0, projectDurationInFrames(project) - 1);
      if (marker.frame < previousMarker) fail(`${path}.frame`, 'Markers must be sorted by frame');
      previousMarker = marker.frame;
      if (marker.color !== undefined) color(`${path}.color`, 'color', marker.color);
    });
    for (const key of Object.keys(project.assets)) claim(key, `assets.${key}`);
    project.audio.forEach((c, ci) => claim(c.id, `audio[${ci}].id`));

    for (const [key, asset] of Object.entries(project.assets)) checkAsset(asset, key, `assets.${key}`);
    project.scenes.forEach((s, si) => checkScene(s, `scenes[${si}]`, project));
    project.audio.forEach((c, ci) => checkClip(c, `audio[${ci}]`, project));
    return null;
  } catch (e) {
    if (e instanceof Invalid) {
      const err: CommandError = { code: 'INVALID', message: e.message, path: e.path };
      if (e.hint) err.hint = e.hint;
      return err;
    }
    throw e;
  }
}

export function validateProject(input: unknown): ValidateResult<Project> {
  const migration = migrateProject(input);
  if (!migration.ok) return migration;
  input = migration.project;
  const shape = ProjectSchema.safeParse(input);
  if (!shape.success) {
    const { path, message } = firstIssue(shape.error);
    return { ok: false, error: { code: 'INVALID', message, path } };
  }
  // Return the input object itself (not zod's copy) so callers keep object identity.
  const project = input as Project;
  const err = checkProject(project);
  return err ? { ok: false, error: err } : { ok: true, value: project };
}

export function parseProjectFile(input: unknown): ValidateResult<ProjectFile> {
  const migration = migrateProjectFile(input);
  if (!migration.ok) return migration;
  input = migration.project;
  const shape = ProjectFileSchema.safeParse(input);
  if (!shape.success) {
    const { path, message } = firstIssue(shape.error);
    return { ok: false, error: { code: 'INVALID', message, path } };
  }
  const file = input as ProjectFile;
  const err = checkProject(file.project);
  if (err) return { ok: false, error: { ...err, path: err.path ? `project.${err.path}` : 'project' } };
  const historyErr = checkHistory(file);
  if (historyErr) return { ok: false, error: historyErr };
  return { ok: true, value: file };
}

/**
 * Revision history must be consistent with the project it is saved with:
 * every snapshot belongs to this project, each record's revision equals its
 * snapshot's revision, revisions strictly increase and never pass the
 * current one, and a record AT the current revision is the current project.
 * Files written by serializeDoc always satisfy this; a file that does not was
 * edited by hand or by another tool, and its history cannot be trusted for
 * rollback or patch reconcile.
 */
function checkHistory(file: ProjectFile): CommandError | null {
  const { project, revisions } = file;
  const hint = 'Remove the "revisions" entries (set it to []) to open the project without its history, or re-export it from the editor.';
  let prev = -Infinity;
  for (let i = 0; i < revisions.length; i++) {
    const rec = revisions[i];
    const path = `revisions[${i}]`;
    const bad = (sub: string, message: string): CommandError => ({ code: 'INVALID', message: `${path}: ${message}`, path: `${path}${sub}`, hint });
    const snapshotError = checkProject(rec.snapshot);
    if (snapshotError) return { ...snapshotError, path: `${path}.snapshot.${snapshotError.path}` };
    if (rec.snapshot.id !== project.id) {
      return bad('.snapshot.id', `history snapshot belongs to project ${JSON.stringify(rec.snapshot.id)}, not ${JSON.stringify(project.id)}`);
    }
    if (rec.snapshot.revision !== rec.revision) {
      return bad('.snapshot.revision', `record is revision ${rec.revision} but its snapshot is revision ${rec.snapshot.revision}`);
    }
    if (!Number.isInteger(rec.revision) || rec.revision < 0) return bad('.revision', `revision must be a whole number ≥ 0; got ${rec.revision}`);
    if (rec.revision <= prev) return bad('.revision', `revisions must be strictly increasing; ${rec.revision} comes after ${prev}`);
    if (rec.revision > project.revision) {
      return bad('.revision', `revision ${rec.revision} is newer than the project (revision ${project.revision})`);
    }
    if (rec.revision === project.revision && !deepEqual(rec.snapshot, project)) {
      return bad('.snapshot', `the snapshot for the current revision ${rec.revision} does not match the project`);
    }
    prev = rec.revision;
  }
  return null;
}
