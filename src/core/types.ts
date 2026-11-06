// Project document — the single source of truth for manual edits, AI patches,
// preview and export. All timing is in integer frames at `project.fps`.
//
// Contract notes (read before changing):
// - IDs are stable strings and never reused. Reordering scenes or elements
//   never changes an ID.
// - Element timing (`startFrame`) is relative to its scene's start.
// - `transform` is the BASE layout. Animation tracks are layered on top of it:
//   x / y / rotation tracks are ADDITIVE offsets (px, degrees); scale / opacity
//   tracks are MULTIPLICATIVE factors. Editing the base transform therefore
//   never touches or invalidates animation tracks.
// - Keyframe frames are relative to the element's own start (0 = first frame
//   the element is on screen).
// - Groups (schemaVersion 2): an element with `parentId` belongs to that group
//   element (type 'group', same scene). Its transform is LOCAL: x/y are
//   relative to the group's top-left, and the group's rotation, scale and
//   opacity apply to it around the group's centre. Its startFrame is relative
//   to the group's start. Paint order inside a group follows scene.elements.
//   Parent chains never form cycles.
// - Nested compositions: `project.compositions` holds reusable element trees;
//   an 'instance' element plays one at its own local frame. Instances never
//   (transitively) contain themselves.
// - Older documents are upgraded by src/core/migrate.ts on every load path;
//   nothing else may read a document whose schemaVersion is not current.
// - Nothing in the render path may depend on wall-clock time or randomness.

export type ID = string;

export const PROJECT_SCHEMA_VERSION = 3 as const;
/** Every schemaVersion migrate.ts can read. */
export const SUPPORTED_SCHEMA_VERSIONS = [1, 2, 3] as const;

export interface Project {
  schemaVersion: typeof PROJECT_SCHEMA_VERSION;
  id: ID;
  name: string;
  /** Monotonic. Incremented by every committed change (including undo/redo/rollback). */
  revision: number;
  /** Integer frames per second. */
  fps: number;
  width: number;
  height: number;
  backgroundColor: string;
  /** Playback order. */
  scenes: Scene[];
  assets: Record<ID, Asset>;
  audio: AudioClip[];
  /** Reusable element trees played by 'instance' elements (schemaVersion 2). */
  compositions: Record<ID, NestedComposition>;
  /** Timeline markers (beats, sync points, notes), sorted by frame. */
  markers: Marker[];
  /**
   * Style pack (schemaVersion 3, optional): fonts, colour roles and a motion
   * personality that templates, presets and agents read. Absent = editor defaults.
   */
  style?: StylePack;
  /**
   * Extra banned look items for this project (schemaVersion 3, optional).
   * Seeded clichés always apply; agents append what a contact sheet showed.
   */
  banned?: string[];
  /**
   * Story the video is telling (schemaVersion 3, optional). Written in the
   * outline before any motion: one idea, a hook, payoff, and beats mapped to
   * scenes. Critique uses it for mapping checks; visual story checks always run.
   */
  story?: ProjectStory;
}

/**
 * Beat roles. `proof` (the product doing its job) and `turn` (the flip from
 * problem to answer) are the cut-card beats: a cut is hook → proof → turn → cta.
 */
export const STORY_BEAT_ROLES = ['hook', 'setup', 'tension', 'turn', 'proof', 'payoff', 'cta', 'loop'] as const;
export type StoryBeatRole = (typeof STORY_BEAT_ROLES)[number];

/** One beat of the story, mapped onto a scene and (once stamped) a frame range. */
export interface StoryBeat {
  role: StoryBeatRole;
  /** What happens in this beat, in one sentence. */
  summary: string;
  /** Project scene this beat plays in, stamped from sceneName on approval. */
  sceneId?: ID;
  /** Outline scene name; used to stamp sceneId. */
  sceneName?: string;
  /** Inclusive start on the project timeline. */
  fromFrame?: number;
  /** Exclusive end on the project timeline. */
  toFrame?: number;
  /** Outline-only: seconds from the start of the video. Stamped to fromFrame. */
  fromSeconds?: number;
  /** Outline-only: seconds from the start of the video. Stamped to toFrame. */
  toSeconds?: number;
}

/** The story layer: one idea, told in beats, before any motion is built. */
export interface ProjectStory {
  /** The one idea the video is about. */
  idea: string;
  /** First 1–2 seconds: what happens and why someone stops scrolling. */
  hook: string;
  audience?: string;
  /** Tension or setup that makes the payoff land. */
  tension?: string;
  payoff: string;
  /** Optional call to action or loop-back. */
  cta?: string;
  beats: StoryBeat[];
}

/** How motion feels across a project; presets and templates scale their timing and easing from it. */
export interface MotionPersonality {
  id: 'snappy' | 'smooth' | 'playful' | 'premium' | 'editorial' | 'percussive' | 'custom';
  /** Multiplies preset/template durations (1 = default). 0.5..2 */
  timingScale: number;
  /** Frames between sibling arrivals in staggers. 0..12 */
  staggerFrames: number;
  /** Overshoot amount for settle moves, as a fraction (0.04 = 4 %). 0..0.3 */
  overshoot: number;
  /** Easing for arrivals and exits. */
  enter: EasingSpec;
  exit: EasingSpec;
}

/**
 * Frame-level craft tokens (30 fps). Optional on a pack; critique and
 * `computeMotionStats` fall back to DEFAULT_CRAFT when this is missing.
 */
export interface StyleCraft {
  /** Scale/fade pop entrance. */
  popFrames: { min: number; max: number };
  /** Irregular sibling stagger. */
  staggerFrames: { min: number; max: number };
  /** Rhythmic landing cadence (frames between hits). */
  landCadence: number;
  /** Typewriter characters per frame (0 = not this style). */
  typeCharsPerFrame: number;
  /** Longest acceptable true hold (no new arrivals) in frames. */
  trueHoldMaxFrames: number;
  /** Idle drift, px per frame at 1920×1080. */
  driftPxPerFrame: number;
  /** Slow camera push / orbit. */
  cameraFrames: { min: number; max: number };
  /** Spring settle: start scale → 1 over N frames. */
  spring: { fromScale: number; frames: number };
  /** Cut lands this many frames AFTER the beat (positive = after). */
  beatOffsetFrames: number;
  /** Allowed slack around beatOffsetFrames. */
  beatOffsetWindow: number;
  /** Motion-blur smear during a fast travel. */
  smear: { blurPx: number; frames: number };
  /** Caption / calm headline height as a share of the frame height. */
  typeHeightShare: { min: number; max: number };
  /** Intentional empty share of a content frame (Pulse uses lots of air). */
  maxEmptyShare: number;
  /** When true, full reading holds apply only to key lines, not chips. */
  readingHoldOnKeyLines: boolean;
}

export interface StylePack {
  /** Shipped pack id ('pulse', 'snappy-saas', …) or 'custom'. */
  id: string;
  name: string;
  fonts: { heading: string; body: string; mono?: string };
  /** Colour roles; values are colours. */
  colors: { background: string; surface: string; text: string; muted: string; accent: string; accent2?: string };
  motion: MotionPersonality;
  /** Optional measured craft tokens; Pulse ships them. */
  craft?: StyleCraft;
}

export interface Marker {
  id: ID;
  /** Global frame. */
  frame: number;
  label: string;
  /** Optional colour token, e.g. '#F59E0B'. */
  color?: string;
}

/** A reusable piece of motion: its own element list, size and length. */
export interface NestedComposition {
  id: ID;
  name: string;
  width: number;
  height: number;
  durationInFrames: number;
  /** 'transparent' or a colour. */
  backgroundColor: string;
  /** Same rules as scene elements (ids unique project-wide, groups allowed). */
  elements: Element[];
}

export type TransitionType = 'none' | 'fade' | 'slide' | 'wipe' | 'zoom' | 'blur';

export interface SceneTransition {
  type: TransitionType;
  /** Entrance transition played over the scene's first N frames. Scenes never overlap. */
  durationInFrames: number;
}

export interface Scene {
  id: ID;
  name: string;
  durationInFrames: number;
  backgroundColor: string;
  /** Approved scenes are locked: no command may modify them until explicitly unlocked by the user. */
  locked: boolean;
  transitionIn: SceneTransition;
  /** Paint order: later elements draw on top. */
  elements: Element[];
}

export type AssetKind = 'image' | 'svg' | 'audio' | 'video';

export interface Asset {
  id: ID;
  kind: AssetKind;
  name: string;
  /**
   * Path relative to the asset root (the `public/` directory), e.g.
   * `assets/logo.svg` or `assets/uploads/abc.png`. Resolved at runtime with
   * `resolveAssetUrl(assetBaseUrl, src)` so preview and export load the same file.
   */
  src: string;
  mimeType: string;
  width?: number;
  height?: number;
  /** Audio and video. */
  durationInFrames?: number;
  /** Video: source frame rate and whether it carries an audio stream. */
  fps?: number;
  hasAudio?: boolean;
  /**
   * Video: a lighter preview copy (asset-root-relative, e.g. `assets/uploads/u_x.proxy.mp4`)
   * the editor preview may use. Exports always use `src`.
   */
  proxySrc?: string;
  /** A reference (style frame, mood, brand image, music reference): steers generation, never placed in the video. */
  reference?: boolean;
  /** Where the file came from; generated and catalog imports record enough to reproduce or credit them. */
  provenance?: AssetProvenance;
}

/** Creative Commons (or similar) terms stored with a third-party import. */
export interface AssetLicense {
  /** Shortcode as stored: 'cc0' | 'by' (this editor never keeps NC/SA/ND). */
  spdxOrCc: string;
  version?: string;
  /** Human license URL from the catalog. */
  licenseUrl?: string;
  /** Ready-made attribution string (e.g. from Openverse). */
  attribution: string;
  creator?: string;
  creatorUrl?: string;
  /** Canonical page on the source (Jamendo, Freesound, …). */
  foreignLandingUrl?: string;
  /** Openverse work id when the catalog was Openverse. */
  openverseId?: string;
  /** When the file was cached locally (epoch ms). */
  cachedAt?: number;
}

export interface AssetProvenance {
  source: 'upload' | 'generated' | 'openverse';
  /** Generator id (e.g. 'fal') or catalog id ('openverse'). */
  provider?: string;
  /** Free-form ids the provider uses for this file (request, job, output ids). */
  providerRefs?: Record<string, string>;
  model?: string;
  prompt?: string;
  seed?: string | number;
  /** Groups takes of one generation request. */
  requestId?: string;
  /** Provider's own cost/allowance note, as text. */
  cost?: string;
  /** Epoch ms. */
  createdAt?: number;
  /** Present for catalog imports (Openverse) so credits can be listed and written on export. */
  license?: AssetLicense;
}

export type ElementType = 'text' | 'shape' | 'logo' | 'image' | 'uiCard' | 'chatBubble' | 'path' | 'group' | 'instance' | 'video';

export interface Transform {
  /** Top-left corner in composition pixels. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Degrees, clockwise, around the element centre. */
  rotation: number;
  /** Uniform scale around the element centre. 1 = 100%. */
  scale: number;
  /** 0..1 */
  opacity: number;
}

export type AnimatableProperty = 'x' | 'y' | 'rotation' | 'scale' | 'opacity';

export const ANIMATABLE_PROPERTIES: readonly AnimatableProperty[] = ['x', 'y', 'rotation', 'scale', 'opacity'];

/** Additive properties offset the base value; multiplicative ones scale it. */
export const ADDITIVE_PROPERTIES: readonly AnimatableProperty[] = ['x', 'y', 'rotation'];

/** Named easing presets. 'hold' keeps the value until the next keyframe (step). */
export type Easing =
  | 'linear'
  | 'easeIn'
  | 'easeOut'
  | 'easeInOut'
  | 'backOut'
  | 'easeInCubic'
  | 'easeOutCubic'
  | 'easeInOutCubic'
  | 'easeOutExpo'
  | 'easeInOutExpo'
  | 'hold';

/** A custom curve with CSS cubic-bezier semantics: x1, x2 in 0..1; y1, y2 in -2..3. */
export interface CubicBezierEasing {
  type: 'cubicBezier';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export type EasingSpec = Easing | CubicBezierEasing;

export interface Keyframe {
  /** Relative to the element's startFrame. Integer. */
  frame: number;
  value: number;
  /** Easing of the segment that STARTS at this keyframe. */
  easing: EasingSpec;
}

export interface AnimationTrack {
  property: AnimatableProperty;
  /** Sorted ascending by frame; frames unique. */
  keyframes: Keyframe[];
}

/**
 * Animation of a registry-declared animatable component property or effect.
 * `key` is 'props.<field>' (a field marked `animatable` in components.ts) or
 * 'effects.<name>'. Numbers interpolate with the segment's easing; colours
 * interpolate in linear sRGB; every other kind (select, boolean, text) holds.
 */
export interface PropertyTrack {
  key: string;
  /** Sorted ascending by frame; frames unique. */
  keyframes: PropertyKeyframe[];
}

export interface PropertyKeyframe {
  /** Relative to the element's startFrame. Integer. */
  frame: number;
  value: number | string | boolean;
  easing: EasingSpec;
}

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn' | 'soft-light' | 'hard-light' | 'difference' | 'exclusion';

/** A bounded set of per-element effects, applied as CSS filters in this order. */
export interface Effects {
  /** px, 0..200 */
  blur?: number;
  /** factors, 0..3 (1 = unchanged) */
  brightness?: number;
  contrast?: number;
  saturate?: number;
  dropShadow?: { x: number; y: number; blur: number; color: string };
}

/**
 * Track matte: the element is visible only where `sourceId` (a 'shape' or
 * 'path' element with the same parent) is opaque ('alpha') or transparent
 * ('inverted'). A mask source is not painted itself.
 */
export interface ElementMask {
  sourceId: ID;
  mode: 'alpha' | 'inverted';
}

export interface Element {
  id: ID;
  type: ElementType;
  name: string;
  /** Relative to scene start (or to the parent group's start). */
  startFrame: number;
  durationInFrames: number;
  visible: boolean;
  /** Locked in the editor: the canvas will not select or move it (the layers panel and inspector still can). Omitted when false. */
  locked?: boolean;
  /** Base layout; LOCAL to the parent group when parentId is set. */
  transform: Transform;
  /** Validated against the component's property schema in `components.ts`. */
  props: Record<string, unknown>;
  tracks: AnimationTrack[];
  /** Animated component properties / effects (schemaVersion 2). Omitted when empty. */
  propTracks?: PropertyTrack[];
  /** Group element this belongs to (same scene or composition). */
  parentId?: ID;
  blendMode?: BlendMode;
  effects?: Effects;
  mask?: ElementMask;
}

/** Path geometry, in the element's own box (0..width, 0..height). Handles are absolute in the same space. */
export interface PathNode {
  x: number;
  y: number;
  in?: { x: number; y: number };
  out?: { x: number; y: number };
}

export interface GradientStop {
  /** 0..1 */
  offset: number;
  color: string;
}

/** A fill or stroke: a colour string ('none' allowed where the field says so) or a gradient. */
export type Paint =
  | string
  | { type: 'linear'; angle: number; stops: GradientStop[] }
  | { type: 'radial'; stops: GradientStop[] };

export interface AudioClip {
  id: ID;
  assetId: ID;
  name: string;
  /**
   * When set, `startFrame` is relative to that scene's start and the clip
   * moves with the scene when scenes are reordered (sound effects). When
   * unset, `startFrame` is absolute on the project timeline (music bed).
   */
  sceneId?: ID;
  startFrame: number;
  /** Frames skipped from the start of the source file. */
  trimStartFrames: number;
  durationInFrames: number;
  /** 0..1 */
  volume: number;
  fadeInFrames: number;
  fadeOutFrames: number;
  /**
   * Optional volume automation (schemaVersion 3), clip-relative frames, values 0..1,
   * sorted by frame; multiplies `volume` and the fades. Used for ducking under voice-over.
   */
  volumeEnvelope?: { frame: number; value: number }[];
}

// ---------------------------------------------------------------------------
// Commands — the only way the document changes. Manual edits and AI patches
// share this vocabulary, validation and undo stack.
// ---------------------------------------------------------------------------

export interface ElementChanges {
  name?: string;
  visible?: boolean;
  /** false clears it. */
  locked?: boolean;
  startFrame?: number;
  durationInFrames?: number;
  /** Base layout. Never touches tracks. */
  transform?: Partial<Transform>;
  /** Shallow-merged into props, then validated against the component schema. */
  props?: Record<string, unknown>;
  /** null clears. */
  blendMode?: BlendMode | null;
  /** Shallow-merged; a key set to null is removed. null clears all effects. */
  effects?: { [K in keyof Effects]?: Effects[K] | null } | null;
  /** null clears. */
  mask?: ElementMask | null;
}

/** How changeFormat adapts content to a new size / frame rate. Never silent: the caller chooses. */
export interface FormatConversion {
  /** 'scale': scale positions/sizes by the width/height ratios (non-uniform allowed, sizes use the smaller ratio); 'fit': uniform scale to fit and centre; 'none': keep pixel values. */
  layout: 'scale' | 'fit' | 'none';
  /** 'keepSeconds': rescale every frame value (durations, starts, keyframes, audio, markers) by newFps/oldFps and round; 'keepFrames': keep frame numbers (playback speed changes). */
  timing: 'keepSeconds' | 'keepFrames';
}

export interface SceneChanges {
  name?: string;
  durationInFrames?: number;
  backgroundColor?: string;
  transitionIn?: Partial<SceneTransition>;
}

export type Command =
  | { type: 'updateProject'; changes: { name?: string; backgroundColor?: string } }
  | { type: 'addScene'; scene: Scene; index?: number }
  | { type: 'removeScene'; sceneId: ID }
  | { type: 'moveScene'; sceneId: ID; toIndex: number }
  | { type: 'updateScene'; sceneId: ID; changes: SceneChanges }
  | { type: 'setSceneLock'; sceneId: ID; locked: boolean }
  | { type: 'addElement'; sceneId: ID; element: Element; index?: number }
  | { type: 'removeElement'; sceneId: ID; elementId: ID }
  | { type: 'moveElement'; sceneId: ID; elementId: ID; toIndex: number }
  | { type: 'updateElement'; sceneId: ID; elementId: ID; changes: ElementChanges }
  /** Insert or replace the keyframe at `frame` (element-relative). */
  | { type: 'setKeyframe'; sceneId: ID; elementId: ID; property: AnimatableProperty; frame: number; value: number; easing?: EasingSpec }
  | { type: 'removeKeyframe'; sceneId: ID; elementId: ID; property: AnimatableProperty; frame: number }
  | { type: 'addAsset'; asset: Asset }
  /** Swap an asset's file in place; every reference follows. */
  | { type: 'replaceAsset'; assetId: ID; changes: Partial<Omit<Asset, 'id'>> }
  | { type: 'addAudioClip'; clip: AudioClip }
  | { type: 'updateAudioClip'; clipId: ID; changes: Partial<Omit<AudioClip, 'id'>> }
  | { type: 'removeAudioClip'; clipId: ID }
  /** Insert or replace a keyframe of a component-property/effect track (key: 'props.<field>' | 'effects.<name>'). */
  | { type: 'setPropertyKeyframe'; sceneId: ID; elementId: ID; key: string; frame: number; value: number | string | boolean; easing?: EasingSpec }
  | { type: 'removePropertyKeyframe'; sceneId: ID; elementId: ID; key: string; frame: number }
  /** Re-parent (parentId null = top level). keepWorld (default true) preserves on-screen placement and timing. */
  | { type: 'setParent'; sceneId: ID; elementId: ID; parentId: ID | null; keepWorld?: boolean }
  /** Wrap elements (same parent) in a new group whose box fits them; children keep their on-screen placement. */
  | { type: 'groupElements'; sceneId: ID; elementIds: ID[]; group: { id: ID; name: string } }
  /** Remove a group, moving its children to the group's parent with on-screen placement kept. */
  | { type: 'ungroup'; sceneId: ID; groupId: ID }
  | { type: 'addComposition'; composition: NestedComposition }
  | { type: 'updateComposition'; compositionId: ID; changes: Partial<Omit<NestedComposition, 'id'>> }
  /** Refused while any instance references it. */
  | { type: 'removeComposition'; compositionId: ID }
  /** Insert or replace by id. */
  | { type: 'setMarker'; marker: Marker }
  | { type: 'removeMarker'; markerId: ID }
  /** Change size and/or fps with an explicit conversion. */
  | { type: 'changeFormat'; width: number; height: number; fps: number; conversion: FormatConversion }
  /**
   * Turn a video element's soundtrack into its own scene-anchored audio clip
   * (same source and trim, aligned to the element's current timing) and mute
   * the element. `clipId` is the new clip's id. One undo step.
   */
  | { type: 'detachVideoAudio'; sceneId: ID; elementId: ID; clipId: ID }
  /** Set (or with null, clear) the project's style pack. Project-level; AI patches need { style: "project" }. */
  | { type: 'setStyle'; style: StylePack | null }
  /** Atomic: all sub-commands apply or none do. One undo step, one revision. */
  | { type: 'batch'; label: string; commands: Command[] };

export type CommandSource = 'user' | 'ai';

export type CommandErrorCode =
  | 'NOT_FOUND'
  | 'INVALID'
  | 'LOCKED'
  | 'STALE'
  | 'OUT_OF_SCOPE'
  | 'PROJECT_MISMATCH'
  | 'PROTOCOL';

export interface CommandError {
  code: CommandErrorCode;
  /** Human-readable, actionable: says what was wrong and what to do. */
  message: string;
  /** e.g. `commands[2].changes.props.fontSize` */
  path?: string;
  hint?: string;
}

export type TouchedRef =
  | { kind: 'project' }
  | { kind: 'composition'; compositionId: ID }
  | { kind: 'scene'; sceneId: ID }
  | { kind: 'element'; sceneId: ID; elementId: ID }
  | { kind: 'asset'; assetId: ID }
  | { kind: 'audio'; clipId: ID };

export type CommandResult =
  | { ok: true; project: Project; touched: TouchedRef[] }
  | { ok: false; error: CommandError };

// ---------------------------------------------------------------------------
// History, revisions and AI patches
// ---------------------------------------------------------------------------

export type RevisionSource = 'load' | 'user' | 'ai' | 'undo' | 'redo' | 'rollback';

export interface RevisionRecord {
  revision: number;
  label: string;
  source: RevisionSource;
  touched: TouchedRef[];
  /** Full document at this revision (structurally shared with neighbours). */
  snapshot: Project;
  /** Epoch ms — metadata only, never used in rendering. */
  at: number;
}

export interface UndoEntry {
  label: string;
  /** Revision numbers before/after the change. */
  beforeRevision: number;
  afterRevision: number;
  before: Project;
  after: Project;
}

export interface DocState {
  project: Project;
  undoStack: UndoEntry[];
  redoStack: UndoEntry[];
  /** Oldest first. Capped (see history.ts). */
  revisions: RevisionRecord[];
}

export type PatchTarget = { sceneId: ID; elementId?: ID } | { audio: 'project' } | { style: 'project' };

export type DocResult = { ok: true; state: DocState } | { ok: false; error: CommandError };

export const PATCH_PROTOCOL = 'mge.patch/1' as const;

/** Structured revision returned by a coding agent / model. */
export interface AiPatch {
  protocol: typeof PATCH_PROTOCOL;
  projectId: ID;
  /** The revision the agent saw. Applied only if it matches, or after explicit reconcile. */
  baseRevision: number;
  summary: string;
  /** Every command must stay inside these targets. Omit elementId to target a whole scene. */
  /**
   * Every command must stay inside these. `{ sceneId }` covers that scene, its
   * elements and the audio clips anchored to it; `{ sceneId, elementId }` one
   * element; `{ audio: 'project' }` the project-level audio (music bed, clips
   * without a sceneId) — schemaVersion 3; `{ style: 'project' }` the style pack
   * (`setStyle` only).
   */
  targets: PatchTarget[];
  commands: Command[];
}

/** A pending request queued in the editor and batched into an agent prompt. */
export interface EditRequest {
  id: ID;
  sceneId: ID;
  elementId?: ID;
  instruction: string;
  /** Global playhead frame when the request was made (frame context). */
  frame: number;
}

/** One field-level difference between two revisions, for comparison views. */
export interface ChangeEntry {
  kind: 'project' | 'scene' | 'element' | 'asset' | 'audio' | 'composition' | 'marker';
  sceneId?: ID;
  elementId?: ID;
  /** Human label, e.g. `Scene "Intro" › Headline › props.text` */
  label: string;
  /** Dotted path, e.g. `props.text`, `transform.x`, `tracks.opacity`, `order` */
  path: string;
  change: 'added' | 'removed' | 'modified' | 'moved';
  before?: unknown;
  after?: unknown;
}

/** On-disk / import-export file format. */
export interface ProjectFile {
  format: 'mge.project/1';
  project: Project;
  /** Most recent revision records for version history (may be empty). */
  revisions: RevisionRecord[];
  savedAt: string;
}
