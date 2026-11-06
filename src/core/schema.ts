// Zod schemas for the project document, commands, AI patches and the project
// file. These check SHAPE (types, required keys, enums). Semantic rules that
// need the whole document — component prop schemas, ranges, timing bounds,
// ID uniqueness, asset references — live in validate.ts (checkProject), which
// produces precise paths and actionable messages.

import { z } from 'zod';
import type { AiPatch, Command, Project, ProjectFile } from './types';
import { ANIMATABLE_PROPERTIES, PATCH_PROTOCOL, PROJECT_SCHEMA_VERSION, STORY_BEAT_ROLES } from './types';

const finite = () => z.number().refine(Number.isFinite, { message: 'must be a finite number' });
const id = () => z.string().min(1, { message: 'must be a non-empty id' });

export const NamedEasingSchema = z.enum(['linear', 'easeIn', 'easeOut', 'easeInOut', 'backOut', 'easeInCubic', 'easeOutCubic', 'easeInOutCubic', 'easeOutExpo', 'easeInOutExpo', 'hold']);
export const EasingSchema = z.union([NamedEasingSchema, z.strictObject({ type: z.literal('cubicBezier'), x1: finite(), y1: finite(), x2: finite(), y2: finite() })]);
export const BlendModeSchema = z.enum(['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'soft-light', 'hard-light', 'difference', 'exclusion']);
export const EffectsSchema = z.strictObject({ blur: finite().optional(), brightness: finite().optional(), contrast: finite().optional(), saturate: finite().optional(), dropShadow: z.strictObject({ x: finite(), y: finite(), blur: finite(), color: z.string() }).optional() });
export const ElementMaskSchema = z.strictObject({ sourceId: id(), mode: z.enum(['alpha', 'inverted']) });
const PointSchema = z.strictObject({ x: finite(), y: finite() });
export const PathNodeSchema = z.strictObject({ x: finite(), y: finite(), in: PointSchema.optional(), out: PointSchema.optional() });
export const GradientStopSchema = z.strictObject({ offset: finite(), color: z.string() });
export const PaintSchema = z.union([z.string(), z.strictObject({ type: z.literal('linear'), angle: finite(), stops: z.array(GradientStopSchema) }), z.strictObject({ type: z.literal('radial'), stops: z.array(GradientStopSchema) })]);
export const PropertyKeyframeSchema = z.strictObject({ frame: finite(), value: z.union([finite(), z.string(), z.boolean()]), easing: EasingSchema });
export const PropertyTrackSchema = z.strictObject({ key: z.string(), keyframes: z.array(PropertyKeyframeSchema) });
export const AnimatablePropertySchema = z.enum(ANIMATABLE_PROPERTIES as unknown as ['x', 'y', 'rotation', 'scale', 'opacity']);
export const ElementTypeSchema = z.enum(['text', 'shape', 'logo', 'image', 'uiCard', 'chatBubble', 'path', 'group', 'instance', 'video']);
export const AssetKindSchema = z.enum(['image', 'svg', 'audio', 'video']);
export const TransitionTypeSchema = z.enum(['none', 'fade', 'slide', 'wipe', 'zoom', 'blur']);

export const TransformSchema = z.strictObject({
  x: finite(),
  y: finite(),
  width: finite(),
  height: finite(),
  rotation: finite(),
  scale: finite(),
  opacity: finite(),
});

export const KeyframeSchema = z.strictObject({
  frame: finite(),
  value: finite(),
  easing: EasingSchema,
});

export const AnimationTrackSchema = z.strictObject({
  property: AnimatablePropertySchema,
  keyframes: z.array(KeyframeSchema),
});

export const ElementSchema = z.strictObject({
  id: id(),
  type: ElementTypeSchema,
  name: z.string(),
  startFrame: finite(),
  durationInFrames: finite(),
  visible: z.boolean(),
  locked: z.boolean().optional(),
  transform: TransformSchema,
  props: z.record(z.string(), z.unknown()),
  tracks: z.array(AnimationTrackSchema),
  propTracks: z.array(PropertyTrackSchema).optional(),
  parentId: id().optional(),
  blendMode: BlendModeSchema.optional(),
  effects: EffectsSchema.optional(),
  mask: ElementMaskSchema.optional(),
});

export const SceneTransitionSchema = z.strictObject({
  type: TransitionTypeSchema,
  durationInFrames: finite(),
});

export const SceneSchema = z.strictObject({
  id: id(),
  name: z.string(),
  durationInFrames: finite(),
  backgroundColor: z.string(),
  locked: z.boolean(),
  transitionIn: SceneTransitionSchema,
  elements: z.array(ElementSchema),
});

// Asset-root-relative path under assets/ only: no '..', no URL-encoding, no absolute paths.
const assetPath = () =>
  z
    .string()
    .min(1, { message: 'must be a non-empty asset path' })
    .regex(/^assets\/(?!.*\.\.)[A-Za-z0-9._\/-]+$/, { message: 'must be a path under assets/ (letters, digits, . _ - /; no "..")' });

export const AssetLicenseSchema = z.strictObject({
  spdxOrCc: z.string(),
  version: z.string().optional(),
  licenseUrl: z.string().optional(),
  attribution: z.string(),
  creator: z.string().optional(),
  creatorUrl: z.string().optional(),
  foreignLandingUrl: z.string().optional(),
  openverseId: z.string().optional(),
  cachedAt: finite().optional(),
});

export const AssetProvenanceSchema = z.strictObject({
  source: z.enum(['upload', 'generated', 'openverse']),
  provider: z.string().optional(),
  providerRefs: z.record(z.string(), z.string()).optional(),
  model: z.string().optional(),
  prompt: z.string().optional(),
  seed: z.union([z.string(), finite()]).optional(),
  requestId: z.string().optional(),
  cost: z.string().optional(),
  createdAt: finite().optional(),
  license: AssetLicenseSchema.optional(),
});

export const AssetSchema = z.strictObject({
  id: id(),
  kind: AssetKindSchema,
  name: z.string(),
  src: assetPath(),
  mimeType: z.string(),
  width: finite().optional(),
  height: finite().optional(),
  durationInFrames: finite().optional(),
  fps: finite().optional(),
  hasAudio: z.boolean().optional(),
  proxySrc: assetPath().optional(),
  reference: z.boolean().optional(),
  provenance: AssetProvenanceSchema.optional(),
});

export const AudioClipSchema = z.strictObject({
  id: id(),
  assetId: id(),
  name: z.string(),
  sceneId: id().optional(),
  startFrame: finite(),
  trimStartFrames: finite(),
  durationInFrames: finite(),
  volume: finite(),
  fadeInFrames: finite(),
  fadeOutFrames: finite(),
  volumeEnvelope: z.array(z.strictObject({ frame: finite(), value: finite() })).optional(),
});

export const NestedCompositionSchema = z.strictObject({ id: id(), name: z.string(), width: finite(), height: finite(), durationInFrames: finite(), backgroundColor: z.string(), elements: z.array(ElementSchema) });
export const MarkerSchema = z.strictObject({ id: id(), frame: finite(), label: z.string(), color: z.string().optional() });

export const MotionPersonalitySchema = z.strictObject({
  id: z.enum(['snappy', 'smooth', 'playful', 'premium', 'editorial', 'percussive', 'custom']),
  timingScale: finite(),
  staggerFrames: finite(),
  overshoot: finite(),
  enter: EasingSchema,
  exit: EasingSchema,
});

const FrameBandSchema = z.strictObject({ min: finite(), max: finite() });

/** Shape only; numeric ranges are checked in validate.ts. */
export const StyleCraftSchema = z.strictObject({
  popFrames: FrameBandSchema,
  staggerFrames: FrameBandSchema,
  landCadence: finite(),
  typeCharsPerFrame: finite(),
  trueHoldMaxFrames: finite(),
  driftPxPerFrame: finite(),
  cameraFrames: FrameBandSchema,
  spring: z.strictObject({ fromScale: finite(), frames: finite() }),
  beatOffsetFrames: finite(),
  beatOffsetWindow: finite(),
  smear: z.strictObject({ blurPx: finite(), frames: finite() }),
  typeHeightShare: FrameBandSchema,
  maxEmptyShare: finite(),
  readingHoldOnKeyLines: z.boolean(),
});

/** Shape only; colour values and motion ranges are checked in validate.ts. */
export const StylePackSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  fonts: z.strictObject({ heading: z.string(), body: z.string(), mono: z.string().optional() }),
  colors: z.strictObject({ background: z.string(), surface: z.string(), text: z.string(), muted: z.string(), accent: z.string(), accent2: z.string().optional() }),
  motion: MotionPersonalitySchema,
  craft: StyleCraftSchema.optional(),
});

const storyBeatRole = () => z.enum(STORY_BEAT_ROLES);

export const StoryBeatSchema = z.strictObject({
  role: storyBeatRole(),
  summary: z.string(),
  sceneId: id().optional(),
  sceneName: z.string().optional(),
  fromFrame: finite().optional(),
  toFrame: finite().optional(),
  fromSeconds: finite().optional(),
  toSeconds: finite().optional(),
});

export const ProjectStorySchema = z.strictObject({
  idea: z.string(),
  hook: z.string(),
  audience: z.string().optional(),
  tension: z.string().optional(),
  payoff: z.string(),
  cta: z.string().optional(),
  beats: z.array(StoryBeatSchema),
});

export const ProjectSchema = z.strictObject({
  schemaVersion: z.literal(PROJECT_SCHEMA_VERSION),
  id: id(),
  name: z.string(),
  revision: finite(),
  fps: finite(),
  width: finite(),
  height: finite(),
  backgroundColor: z.string(),
  scenes: z.array(SceneSchema),
  assets: z.record(z.string(), AssetSchema),
  audio: z.array(AudioClipSchema),
  compositions: z.record(z.string(), NestedCompositionSchema),
  markers: z.array(MarkerSchema),
  style: StylePackSchema.optional(),
  banned: z.array(z.string()).optional(),
  story: ProjectStorySchema.optional(),
});

// --- Commands --------------------------------------------------------------

const ElementChangesSchema = z.strictObject({
  name: z.string().optional(),
  visible: z.boolean().optional(),
  locked: z.boolean().optional(),
  startFrame: finite().optional(),
  durationInFrames: finite().optional(),
  transform: TransformSchema.partial().optional(),
  props: z.record(z.string(), z.unknown()).optional(),
  blendMode: BlendModeSchema.nullable().optional(),
  effects: z.strictObject({ blur: finite().nullable().optional(), brightness: finite().nullable().optional(), contrast: finite().nullable().optional(), saturate: finite().nullable().optional(), dropShadow: EffectsSchema.shape.dropShadow.unwrap().nullable().optional() }).nullable().optional(),
  mask: ElementMaskSchema.nullable().optional(),
});

const SceneChangesSchema = z.strictObject({
  name: z.string().optional(),
  durationInFrames: finite().optional(),
  backgroundColor: z.string().optional(),
  transitionIn: SceneTransitionSchema.partial().optional(),
});

const index = () => finite().optional();

export const CommandSchema: z.ZodType<Command> = z.lazy(() =>
  z.discriminatedUnion('type', [
    z.strictObject({ type: z.literal('updateProject'), changes: z.strictObject({ name: z.string().optional(), backgroundColor: z.string().optional() }) }),
    z.strictObject({ type: z.literal('addScene'), scene: SceneSchema, index: index() }),
    z.strictObject({ type: z.literal('removeScene'), sceneId: id() }),
    z.strictObject({ type: z.literal('moveScene'), sceneId: id(), toIndex: finite() }),
    z.strictObject({ type: z.literal('updateScene'), sceneId: id(), changes: SceneChangesSchema }),
    z.strictObject({ type: z.literal('setSceneLock'), sceneId: id(), locked: z.boolean() }),
    z.strictObject({ type: z.literal('addElement'), sceneId: id(), element: ElementSchema, index: index() }),
    z.strictObject({ type: z.literal('removeElement'), sceneId: id(), elementId: id() }),
    z.strictObject({ type: z.literal('moveElement'), sceneId: id(), elementId: id(), toIndex: finite() }),
    z.strictObject({ type: z.literal('updateElement'), sceneId: id(), elementId: id(), changes: ElementChangesSchema }),
    z.strictObject({
      type: z.literal('setKeyframe'),
      sceneId: id(),
      elementId: id(),
      property: AnimatablePropertySchema,
      frame: finite(),
      value: finite(),
      easing: EasingSchema.optional(),
    }),
    z.strictObject({ type: z.literal('removeKeyframe'), sceneId: id(), elementId: id(), property: AnimatablePropertySchema, frame: finite() }),
    z.strictObject({ type: z.literal('addAsset'), asset: AssetSchema }),
    z.strictObject({ type: z.literal('replaceAsset'), assetId: id(), changes: AssetSchema.omit({ id: true }).partial() }),
    z.strictObject({ type: z.literal('addAudioClip'), clip: AudioClipSchema }),
    z.strictObject({ type: z.literal('updateAudioClip'), clipId: id(), changes: AudioClipSchema.omit({ id: true }).partial() }),
    z.strictObject({ type: z.literal('removeAudioClip'), clipId: id() }),
    z.strictObject({ type: z.literal('setPropertyKeyframe'), sceneId: id(), elementId: id(), key: z.string(), frame: finite(), value: z.union([finite(), z.string(), z.boolean()]), easing: EasingSchema.optional() }),
    z.strictObject({ type: z.literal('removePropertyKeyframe'), sceneId: id(), elementId: id(), key: z.string(), frame: finite() }),
    z.strictObject({ type: z.literal('setParent'), sceneId: id(), elementId: id(), parentId: id().nullable(), keepWorld: z.boolean().optional() }),
    z.strictObject({ type: z.literal('groupElements'), sceneId: id(), elementIds: z.array(id()).min(1), group: z.strictObject({ id: id(), name: z.string() }) }),
    z.strictObject({ type: z.literal('ungroup'), sceneId: id(), groupId: id() }),
    z.strictObject({ type: z.literal('addComposition'), composition: NestedCompositionSchema }),
    z.strictObject({ type: z.literal('updateComposition'), compositionId: id(), changes: NestedCompositionSchema.omit({ id: true }).partial() }),
    z.strictObject({ type: z.literal('removeComposition'), compositionId: id() }),
    z.strictObject({ type: z.literal('setMarker'), marker: MarkerSchema }),
    z.strictObject({ type: z.literal('removeMarker'), markerId: id() }),
    z.strictObject({ type: z.literal('changeFormat'), width: finite(), height: finite(), fps: finite(), conversion: z.strictObject({ layout: z.enum(['scale', 'fit', 'none']), timing: z.enum(['keepSeconds', 'keepFrames']) }) }),
    z.strictObject({ type: z.literal('detachVideoAudio'), sceneId: id(), elementId: id(), clipId: id() }),
    z.strictObject({ type: z.literal('setStyle'), style: StylePackSchema.nullable() }),
    z.strictObject({ type: z.literal('batch'), label: z.string(), commands: z.array(CommandSchema) }),
  ]),
) as z.ZodType<Command>;

// --- Patches, revisions, files ----------------------------------------------

export const AiPatchSchema: z.ZodType<AiPatch> = z.strictObject({
  protocol: z.literal(PATCH_PROTOCOL, { message: `protocol must be "${PATCH_PROTOCOL}"` }),
  projectId: id(),
  baseRevision: z.number().int({ message: 'baseRevision must be an integer' }),
  summary: z.string().min(1, { message: 'summary must be a non-empty string' }),
  targets: z.array(z.union([z.strictObject({ sceneId: id(), elementId: id().optional() }), z.strictObject({ audio: z.literal('project') }), z.strictObject({ style: z.literal('project') })])).min(1, { message: 'targets must list at least one { sceneId, elementId? }' }),
  commands: z.array(CommandSchema).min(1, { message: 'commands must contain at least one command' }),
}) as z.ZodType<AiPatch>;

const TouchedRefSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('project') }),
  z.strictObject({ kind: z.literal('composition'), compositionId: id() }),
  z.strictObject({ kind: z.literal('scene'), sceneId: id() }),
  z.strictObject({ kind: z.literal('element'), sceneId: id(), elementId: id() }),
  z.strictObject({ kind: z.literal('asset'), assetId: id() }),
  z.strictObject({ kind: z.literal('audio'), clipId: id() }),
]);

export const RevisionRecordSchema = z.strictObject({
  revision: finite(),
  label: z.string(),
  source: z.enum(['load', 'user', 'ai', 'undo', 'redo', 'rollback']),
  touched: z.array(TouchedRefSchema),
  snapshot: ProjectSchema,
  at: finite(),
});

export const ProjectFileSchema: z.ZodType<ProjectFile> = z.strictObject({
  format: z.literal('mge.project/1', { message: 'format must be "mge.project/1"' }),
  project: ProjectSchema,
  revisions: z.array(RevisionRecordSchema),
  savedAt: z.string(),
}) as unknown as z.ZodType<ProjectFile>;

/** Typed view for callers that only need the Project shape check. */
export const ProjectShapeSchema = ProjectSchema as unknown as z.ZodType<Project>;

/** `['scenes', 1, 'elements', 2, 'props', 'fontSize']` → `scenes[1].elements[2].props.fontSize` */
export function formatPath(path: readonly PropertyKey[], prefix = ''): string {
  let out = prefix;
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${String(seg)}` : String(seg);
  }
  return out;
}

/** First zod issue as `{ path, message }` with a readable message. */
export function firstIssue(error: z.ZodError, prefix = ''): { path: string; message: string } {
  // A union may fail a primitive alternative and an object alternative.
  // Prefer the deepest field error, which points to the malformed object.
  const descend = (issue: z.core.$ZodIssue, path: PropertyKey[]): { issue: z.core.$ZodIssue; path: PropertyKey[] } => {
    const nested = (issue as { errors?: z.core.$ZodIssue[][] }).errors;
    if (issue.code !== 'invalid_union' || !nested?.length) return { issue, path };
    const candidates = nested.flatMap(branch => branch.map(inner => descend(inner, [...path, ...inner.path])));
    if (!candidates.length) return { issue, path };
    return candidates.reduce((best, next) => next.path.length > best.path.length ? next : best);
  };
  const selected = descend(error.issues[0], [...error.issues[0].path]);
  const issue = selected.issue;
  let basePath = selected.path;
  let message = issue.message;
  if (issue.code === 'unrecognized_keys' && issue.keys.length > 0) {
    // Strict objects: name the offending key in the path so the caller can find it.
    const key = issue.keys[0];
    basePath = [...basePath, key];
    const others = issue.keys.length > 1 ? ` (also: ${issue.keys.slice(1).map((k) => `"${k}"`).join(', ')})` : '';
    message = `unknown field "${key}"${others} is not allowed here; remove it`;
  }
  const path = formatPath(basePath, prefix);
  const where = path || '(root)';
  return { path, message: `${where}: ${message}` };
}
