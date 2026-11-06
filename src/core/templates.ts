// Templates: parameterised, editable element groups built from registered
// components. A template is one 'group' element with ordinary children — text,
// shapes, paths, cards, bubbles, images — animated with motion presets, so
// after inserting one the user edits plain elements and keys. Nothing
// template-specific is stored in the document.
//
// Layout adapts to the project size (16:9, 1:1, 9:16, 4:5): sizes scale with
// the shorter side, content keeps a safe margin, and portrait frames stack
// what landscape frames place side by side. Fonts and colours come from the
// project's style pack (project.style) when it has one, otherwise from its own
// elements (projectStyle). The pack's motion personality times every part:
// durations scale by timingScale, siblings arrive staggerFrames apart, and the
// presets take its curves and overshoot.

import { interpolateColor, parseColor } from './color';
import { COMPONENTS, FONT_FAMILIES, type FontFamily } from './components';
import { newId } from './ids';
import { contrastRatio, staggerFor, TYPE_MIN } from './motionRules';
import { PRESETS, withPlan, withPreset, type PresetId, type PresetKey } from './presets';
import { bundledFont } from './style';
import type { AnimatableProperty, Asset, Command, EasingSpec, Effects, Element, ElementType, MotionPersonality, PathNode, Project, PropertyTrack } from './types';

export type TemplateId =
  | 'titleCard'
  | 'lowerThird'
  | 'logoOutro'
  | 'featureCallout'
  | 'chatExchange'
  | 'statCounter'
  | 'walkthroughStep'
  | 'kineticTitle'
  | 'uiWalkthrough'
  | 'featureGrid'
  | 'beforeAfter'
  | 'statReveal'
  | 'testimonial'
  | 'logoSting'
  | 'wordSwap'
  | 'checklistStrike'
  | 'queryResults'
  | 'splitReveal'
  | 'timelineScrub'
  | 'stampClose'
  | 'backdrop';

/** Free-form parameters; anything omitted falls back to a default derived from the project. */
export type TemplateParams = Record<string, string | number | undefined>;

export interface TemplateContext {
  sceneId: string;
  /** Scene-relative frame the template starts at. */
  at: number;
  project: Project;
  /** Element id factory (tests pass a deterministic one). Default: fresh `el_` ids. */
  newId?: () => string;
  /**
   * Build inside this group (same scene): `at` stays a scene frame, the layout
   * stays in frame pixels, and the template is placed in the group's local
   * space (offset by its base x/y; its scale and rotation apply on top). It
   * ends when the group does.
   */
  parentId?: string;
}

export type TemplateResult =
  | {
      ok: true;
      /** The group every other element belongs to. */
      group: Element;
      /** Group first, then its children in paint order. */
      elements: Element[];
      /** addElement commands for `elements`, in order. Run them as ONE batch. */
      commands: Command[];
      label: string;
    }
  | { ok: false; code: 'NOT_FOUND' | 'LOCKED' | 'INVALID'; message: string };

/** One template parameter, for the agent tool description and input checks. */
export interface TemplateParamSpec {
  /** text: a string (\n separates lines); number: a finite number; asset: an id in project.assets. */
  type: 'text' | 'number' | 'asset';
  /** One line: what it sets (and its default when not obvious). */
  doc: string;
  /** Allowed values of an enumerated text param. */
  values?: readonly string[];
  /** Asset kinds an asset param accepts. */
  kinds?: readonly Asset['kind'][];
}

export interface TemplateDefinition {
  id: TemplateId;
  label: string;
  description: string;
  /** Designed length in seconds (shorter when the scene ends sooner). */
  seconds: number;
  /** Every parameter the design reads (besides the common `seconds`). */
  params: Readonly<Record<string, TemplateParamSpec>>;
}

/** Parameters every template takes. */
export const COMMON_TEMPLATE_PARAMS: Readonly<Record<string, TemplateParamSpec>> = {
  seconds: { type: 'number', doc: 'length in seconds: a longer hold, same motion (capped at the scene end)' },
};

// ---------------------------------------------------------------------------
// Project style
// ---------------------------------------------------------------------------

export interface TemplateStyle {
  font: FontFamily;
  displayFont: FontFamily;
  monoFont: FontFamily;
  text: string;
  muted: string;
  accent: string;
  /** Secondary accent (chips, avatars); the accent when the project has none. */
  accent2: string;
  /** Text on an accent fill. */
  onAccent: string;
  /** Cards, plates, assistant bubbles. */
  surface: string;
  /** Hairlines and empty ring tracks. */
  faint: string;
  /** Scene background the template sits on. */
  background: string;
  /** Motion personality, when the project has a style pack. */
  motion?: MotionPersonality;
}

const DEFAULT_ACCENT = '#7C83FF';
const DEFAULT_SURFACE = '#161A2C';
const DEFAULT_TEXT = '#F8FAFC';

function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let n = 0;
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c];
  return best;
}

/** HSL saturation and lightness (0..1) of a colour string, or null. */
function satLight(value: string): { s: number; l: number; luminance: number } | null {
  const c = parseColor(value);
  if (!c || c[3] < 0.5) return null;
  const [r, g, b] = c.slice(0, 3).map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  return { s, l, luminance: 0.2126 * r + 0.7152 * g + 0.0722 * b };
}

const rgba = (value: string, alpha: number) => {
  const c = parseColor(value) ?? [255, 255, 255, 1];
  return `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${alpha})`;
};

const onColour = (fill: string) => ((satLight(fill)?.luminance ?? 0) > 0.55 ? '#0B0F1A' : '#FFFFFF');

/** A style pack as template roles (fonts the renderer does not ship fall back to the bundled ones). */
export function packStyle(project: Project): TemplateStyle | null {
  const pack = project.style;
  if (!pack) return null;
  const font = bundledFont(pack.fonts.body, 'Inter');
  return {
    font,
    displayFont: bundledFont(pack.fonts.heading, font),
    monoFont: bundledFont(pack.fonts.mono, 'IBM Plex Mono'),
    text: pack.colors.text,
    muted: pack.colors.muted,
    accent: pack.colors.accent,
    accent2: pack.colors.accent2 ?? pack.colors.accent,
    onAccent: onColour(pack.colors.accent),
    surface: pack.colors.surface,
    faint: rgba(pack.colors.text, 0.14),
    background: pack.colors.background,
    motion: pack.motion,
  };
}

/** Fonts and colours for inserted templates: the style pack's, else what the project already uses. */
export function projectStyle(project: Project): TemplateStyle {
  const fromPack = packStyle(project);
  if (fromPack) return fromPack;
  const all = [...project.scenes.flatMap((s) => s.elements), ...Object.values(project.compositions).flatMap((c) => c.elements)];
  const texts = all.filter((e) => e.type === 'text');
  const isFont = (f: unknown): f is FontFamily => typeof f === 'string' && (FONT_FAMILIES as readonly string[]).includes(f);
  const font = mostCommon(texts.map((e) => e.props.fontFamily).filter(isFont)) ?? 'Inter';
  const largest = [...texts].sort((a, b) => Number(b.props.fontSize) - Number(a.props.fontSize))[0];
  const displayFont = isFont(largest?.props.fontFamily) ? largest.props.fontFamily : font;
  const text = mostCommon(texts.map((e) => e.props.color).filter((c): c is string => typeof c === 'string' && !!satLight(c))) ?? DEFAULT_TEXT;
  const colours: string[] = [];
  for (const e of all) {
    for (const key of ['fill', 'stroke', 'accentColor', 'bubbleColor', 'color']) {
      const v = e.props[key];
      if (typeof v === 'string') colours.push(v.toUpperCase());
    }
  }
  const vivid = colours.filter((c) => {
    const hsl = satLight(c);
    return hsl && hsl.s > 0.35 && hsl.l > 0.25 && hsl.l < 0.82;
  });
  const accent = mostCommon(vivid) ?? DEFAULT_ACCENT;
  const surfaces = all.flatMap((e) => (e.type === 'uiCard' ? [e.props.background] : e.type === 'chatBubble' && e.props.sender === 'assistant' ? [e.props.bubbleColor] : []));
  const surface = mostCommon(surfaces.filter((c): c is string => typeof c === 'string' && !!satLight(c))) ?? DEFAULT_SURFACE;
  return {
    font,
    displayFont,
    monoFont: 'IBM Plex Mono',
    text,
    muted: rgba(text, 0.72),
    accent,
    accent2: accent,
    onAccent: onColour(accent),
    surface,
    faint: rgba(text, 0.14),
    background: project.backgroundColor,
  };
}

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Motion {
  preset: PresetId;
  /** Seconds after the part appears (default 0). */
  at?: number;
  /** Seconds (default: the preset's own length). */
  seconds?: number;
  intensity?: number;
  overshoot?: number;
}

/** A hand-placed key, `s` seconds after the part appears (scaled like every other template time). */
type TimedKey = ({ track: AnimatableProperty; value: number } | { prop: string; value: number | string }) & { s: number; easing?: EasingSpec };

interface Part {
  type: ElementType;
  name: string;
  box: Box;
  props: Record<string, unknown>;
  /** Seconds after the template starts. */
  start?: number;
  /** Frames added after `start` (arrive-apart offsets; not time-scaled). */
  startFrames?: number;
  motion?: Motion[];
  /** Hand-placed keys (masked rises, cursor paths, dims). Applied after `motion`. */
  keys?: TimedKey[];
  propTracks?: PropertyTrack[];
  /** Name of a shape/path part that mattes this one (alpha, or inverted: everything but the source). */
  maskBy?: string;
  maskMode?: 'alpha' | 'inverted';
  /** Base rotation in degrees. */
  rotation?: number;
  effects?: Effects;
}

interface Design {
  parts: Part[];
  /** Motion on the group itself (e.g. one exit for everything). */
  groupMotion?: Motion[];
  /** A slow camera push on the whole group that keeps `focus` (frame px) still, from `at` to the end: the hold never goes dead. `from` starts it already pushed (a step continuing the last one's push). */
  push?: { at: number; scale: number; focus: { x: number; y: number }; from?: number };
  /** A slow constant drift of the whole group (px) from `at` (default 0) to the end, for textures and parallax layers. */
  drift?: { at?: number; x: number; y: number };
  /** Paint under everything already in the scene (background textures). */
  behind?: boolean;
}

/** Sizes and helpers for one frame size. */
interface Kit {
  W: number;
  H: number;
  /** Scale: 1 at 1080 px on the shorter side. */
  u: number;
  /** Safe margin. */
  m: number;
  portrait: boolean;
  style: TemplateStyle;
  project: Project;
  /** Pixels, rounded. */
  px: (n: number) => number;
  /** Frames between sibling arrivals (the style's staggerFrames, 4 without one). */
  stagger: number;
  /** Arrival / exit curves for hand-placed keys. */
  enter: EasingSpec;
  exit: EasingSpec;
}

/** Rough line count of text at a size in a width; `em` is the average glyph width (bold and mono run wider). */
function lineCount(text: string, fontSize: number, width: number, em = 0.56): number {
  const perLine = Math.max(1, Math.floor(width / (fontSize * em)));
  return text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / perLine)), 0);
}

/** A text part whose box fits its lines. */
function textPart(k: Kit, name: string, text: string, at: { x: number; y: number; width: number }, style: { size: number; weight?: number; color?: string; font?: FontFamily; align?: 'left' | 'center' | 'right'; lineHeight?: number; tracking?: number; trackFrom?: number; balance?: boolean }, extra: Partial<Part> = {}): Part {
  const lineHeight = style.lineHeight ?? 1.15;
  // Advance per character in em: the glyph plus its tracking (the widest a tighten-in starts from, so it never re-wraps).
  const em = ((style.font ?? k.style.font) === 'IBM Plex Mono' ? 0.62 : (style.weight ?? 700) >= 600 ? 0.6 : 0.54) + Math.max(0, style.tracking ?? 0, style.trackFrom ?? 0) / style.size;
  const lines = lineCount(text, style.size, at.width, em);
  // Balanced wrap: narrow a multi-line box towards equal lines so no word is left alone on the last one.
  let width = at.width;
  if (style.balance && lines > 1 && !text.includes('\n')) {
    width = Math.min(at.width, Math.ceil((text.length / lines) * style.size * em * 1.15));
    if (style.align === 'center') at = { ...at, x: at.x + Math.round((at.width - width) / 2) };
    else if (style.align === 'right') at = { ...at, x: at.x + at.width - width };
  }
  const height = Math.ceil(lineCount(text, style.size, width, em) * style.size * lineHeight + style.size * 0.25);
  return {
    type: 'text',
    name,
    box: { ...at, width, height },
    props: {
      text,
      fontFamily: style.font ?? k.style.font,
      fontSize: style.size,
      fontWeight: style.weight ?? 700,
      color: style.color ?? k.style.text,
      align: style.align ?? 'left',
      lineHeight,
      letterSpacing: style.tracking ?? 0,
      reveal: 'none',
    },
    ...extra,
  };
}

/** Largest size (stepping down by 4 px) at which bold text fits in `maxLines`. */
function fitSize(text: string, size: number, min: number, width: number, maxLines: number): number {
  let s = size;
  while (s > min && lineCount(text, s, width, 0.6) > maxLines) s -= 4;
  return Math.max(min, s);
}

/**
 * `colour` as type on `on` (painted over the scene background): itself when it
 * reads (TYPE_MIN.contrast), else mixed towards black on a light ground or
 * white on a dark one until it does, so the accent keeps its hue.
 */
function ink(k: Kit, colour: string, on: string = k.style.background): string {
  const ratio = (c: string) => contrastRatio(c, on, k.style.background);
  if ((ratio(colour) ?? Infinity) >= TYPE_MIN.contrast) return colour;
  const toward = (ratio('#000000') ?? 0) > (ratio('#FFFFFF') ?? 0) ? '#000000' : '#FFFFFF';
  for (let i = 1; i < 10; i++) {
    const mixed = interpolateColor(colour, toward, i / 10);
    if (mixed && (ratio(mixed) ?? 0) >= TYPE_MIN.contrast) return mixed;
  }
  return toward;
}

/** A tracked-caps eyebrow (kicker, step badge, panel label): mono at the video-safe size (TYPE_MIN.trackedCaps, never rounded below it), in `colour` made to read on `on`. */
function eyebrow(k: Kit, colour: string = k.style.accent, on?: string) {
  return { size: Math.ceil(TYPE_MIN.trackedCaps * k.u), weight: 600, color: ink(k, colour, on), font: k.style.monoFont, tracking: k.px(4) };
}

const KAPPA = 0.5523;

/** Closed circle in a size×size box, starting at 12 o'clock and running clockwise. */
function circleNodes(size: number, inset: number): PathNode[] {
  const c = size / 2;
  const r = c - inset;
  const k = KAPPA * r;
  return [
    { x: c, y: c - r, in: { x: c - k, y: c - r }, out: { x: c + k, y: c - r } },
    { x: c + r, y: c, in: { x: c + r, y: c - k }, out: { x: c + r, y: c + k } },
    { x: c, y: c + r, in: { x: c + k, y: c + r }, out: { x: c - k, y: c + r } },
    { x: c - r, y: c, in: { x: c - r, y: c + k }, out: { x: c - r, y: c - k } },
  ];
}

/** Closed rounded rectangle in a w×h box, starting at the top-left straight edge, clockwise. */
function roundedRectNodes(w: number, h: number, radius: number): PathNode[] {
  const r = Math.min(radius, w / 2, h / 2);
  const k = KAPPA * r;
  return [
    { x: r, y: 0, in: { x: r - k, y: 0 } },
    { x: w - r, y: 0, out: { x: w - r + k, y: 0 } },
    { x: w, y: r, in: { x: w, y: r - k } },
    { x: w, y: h - r, out: { x: w, y: h - r + k } },
    { x: w - r, y: h, in: { x: w - r + k, y: h } },
    { x: r, y: h, out: { x: r - k, y: h } },
    { x: 0, y: h - r, in: { x: 0, y: h - r + k } },
    { x: 0, y: r, out: { x: 0, y: r - k } },
  ];
}

function pathProps(nodes: PathNode[], closed: boolean, stroke: string, strokeWidth: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...COMPONENTS.path.defaultProps, nodes, closed, fill: 'none', stroke, strokeWidth, lineCap: 'round', lineJoin: 'round', trimStart: 0, trimEnd: 1, trimOffset: 0, ...extra };
}

const str = (p: TemplateParams, key: string, fallback: string) => {
  const v = p[key];
  return typeof v === 'string' && v.trim() ? v : fallback;
};

const assetsOf = (project: Project, kinds: Asset['kind'][]) => Object.values(project.assets).filter((a) => kinds.includes(a.kind));

/** Fit an asset's aspect ratio into a box (contain), centred. */
function containBox(box: Box, asset: Asset | undefined): Box {
  if (!asset?.width || !asset.height) return box;
  const scale = Math.min(box.width / asset.width, box.height / asset.height);
  const width = Math.round(asset.width * scale);
  const height = Math.round(asset.height * scale);
  return { x: Math.round(box.x + (box.width - width) / 2), y: Math.round(box.y + (box.height - height) / 2), width, height };
}

/** Greedy word flow into lines of at most `perLine` characters (a longer word gets its own line). */
function flowWords(text: string, perLine: number): string[] {
  const out: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = out[out.length - 1];
    if (last !== undefined && last.length + 1 + word.length <= perLine) out[out.length - 1] = `${last} ${word}`;
    else out.push(word);
  }
  return out.length ? out : [text];
}

const num = (p: TemplateParams, key: string, fallback: number) => {
  const v = p[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
};

/** Frames a part's own pieces follow it by (a card's title after its plate). */
const FOLLOW = 3;

/** A soft radial glow in the accent behind `around` (a screenshot, a logo): the treatment that makes a hero sit in the frame instead of float on it. */
function glowPart(k: Kit, name: string, around: Box, colour: string, opts: { spread?: number; alpha?: number; start?: number; startFrames?: number; seconds?: number } = {}): Part {
  const spread = opts.spread ?? 0.3;
  const dx = Math.round(around.width * spread);
  const dy = Math.round(around.height * spread + k.px(40));
  const alpha = opts.alpha ?? 0.45;
  return {
    type: 'shape',
    name,
    box: { x: around.x - dx, y: around.y - dy, width: around.width + 2 * dx, height: around.height + 2 * dy },
    props: { shape: 'ellipse', fill: { type: 'radial', stops: [{ offset: 0, color: rgba(colour, alpha) }, { offset: 0.5, color: rgba(colour, alpha * 0.35) }, { offset: 1, color: rgba(colour, 0) }] }, stroke: 'none', strokeWidth: 0, cornerRadius: 0 },
    start: opts.start ?? 0,
    ...(opts.startFrames !== undefined ? { startFrames: opts.startFrames } : {}),
    motion: [{ preset: 'fadeIn', seconds: opts.seconds ?? 0.8 }],
  };
}

/** A pill and its text arrive as one: same frame, same motion, so the pill never shows empty. */
const pillIn = (intensity: number): Motion[] => [{ preset: 'overshootSettle', intensity }];

/** A pill button with its label (≥ 30 px at 1080), arriving together with give. */
function buttonParts(k: Kit, label: string, at: { cx: number; y: number }, timing: { start: number; startFrames?: number }): Part[] {
  const size = k.px(32);
  const padX = k.px(40);
  const h = Math.round(size * 2.2);
  const w = Math.round(label.length * size * 0.56 + 2 * padX);
  const box = { x: Math.round(at.cx - w / 2), y: at.y, width: w, height: h };
  return [
    { type: 'shape', name: 'Button', box, props: { shape: 'rect', fill: k.style.accent, stroke: 'none', strokeWidth: 0, cornerRadius: Math.round(h / 2) }, effects: { dropShadow: { x: 0, y: k.px(10), blur: k.px(30), color: rgba(k.style.accent, 0.35) } }, ...timing, motion: pillIn(0.7) },
    { ...textPart(k, 'Button label', label, { x: box.x, y: box.y + Math.round((h - size * 1.2) / 2), width: w }, { size, weight: 600, color: k.style.onAccent, align: 'center', lineHeight: 1.2 }), ...timing, motion: pillIn(0.7) },
  ];
}

/** Deterministic 0..1 noise for texture layouts (no Math.random: the same insert builds the same document). */
const noise = (i: number, salt = 0) => {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

/** Arrow pointer, tip at (0, 0), `height` px tall. */
function cursorNodes(height: number): { nodes: PathNode[]; width: number } {
  const s = height / 18.2;
  const pts = [[0, 0], [0, 15.5], [3.6, 12.2], [6.2, 18.2], [8.6, 17.2], [6.1, 11.3], [10.9, 11.3]];
  return { nodes: pts.map(([x, y]) => ({ x: Math.round(x * s * 10) / 10, y: Math.round(y * s * 10) / 10 })), width: Math.ceil(10.9 * s) };
}

const overlaps = (a: Box, b: Box, gap = 0) => a.x < b.x + b.width + gap && b.x < a.x + a.width + gap && a.y < b.y + b.height + gap && b.y < a.y + a.height + gap;

/** The box shrunk by `d` on every side. */
const inset = (b: Box, d: number): Box => ({ x: b.x + d, y: b.y + d, width: Math.max(0, b.width - 2 * d), height: Math.max(0, b.height - 2 * d) });

/** `a` ∩ `b` (zero-sized when they miss). */
function within(a: Box, b: Box): Box {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - x), height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - y) };
}

const CALLOUT_SIDES = ['below', 'above', 'right', 'left'] as const;
type CalloutSide = (typeof CALLOUT_SIDES)[number];

/**
 * Where a w×h callout goes beside `target` without covering it, `gap` away:
 * the `first` side in any of `areas`, else below, above, right, then left of
 * it inside the first area that has room (areas tried in order). The other
 * axis is aligned to the target (start or end edge; centred beside it) and
 * clamped in. Nothing fits: below, clamped into the last area.
 */
function besideTarget(target: Box, w: number, h: number, gap: number, areas: Box[], alignEnd: boolean, first?: CalloutSide): Box {
  const clamp = (v: number, lo: number, hi: number) => Math.round(Math.max(lo, Math.min(hi, v)));
  const along = (a: Box) => clamp(alignEnd ? target.x + target.width - w : target.x, a.x, a.x + a.width - w);
  const place = (side: CalloutSide, a: Box): Box | undefined => {
    if (w > a.width || h > a.height) return undefined;
    const middle = clamp(target.y + (target.height - h) / 2, a.y, a.y + a.height - h);
    const b = side === 'below' ? { x: along(a), y: target.y + target.height + gap }
      : side === 'above' ? { x: along(a), y: target.y - gap - h }
      : side === 'right' ? { x: target.x + target.width + gap, y: middle }
      : { x: target.x - gap - w, y: middle };
    return b.x >= a.x && b.y >= a.y && b.x + w <= a.x + a.width && b.y + h <= a.y + a.height ? { ...b, width: w, height: h } : undefined;
  };
  const tries: [CalloutSide, Box][] = [...(first ? areas.map((a): [CalloutSide, Box] => [first, a]) : []), ...areas.flatMap((a) => CALLOUT_SIDES.map((side): [CalloutSide, Box] => [side, a]))];
  for (const [side, a] of tries) {
    const fit = place(side, a);
    if (fit) return fit;
  }
  const last = areas[areas.length - 1];
  return { x: along(last), y: clamp(target.y + target.height + gap, last.y, last.y + last.height - h), width: w, height: h };
}

/** A generic app window drawn with shapes, for walkthroughs without a screenshot. Its primary button sits at (84 %, 11.5 %). */
function mockScreen(k: Kit, box: Box, motion: Motion[]): Part[] {
  const r = (fx: number, fy: number, fw: number, fh: number): Box => ({ x: Math.round(box.x + fx * box.width), y: Math.round(box.y + fy * box.height), width: Math.max(1, Math.round(fw * box.width)), height: Math.max(1, Math.round(fh * box.height)) });
  const shape = (name: string, b: Box, fill: string, radius: number, stroke = 'none'): Part => ({ type: 'shape', name, box: b, props: { shape: 'rect', fill, stroke, strokeWidth: stroke === 'none' ? 0 : k.px(2), cornerRadius: radius }, motion });
  const ink = rgba(k.style.text, 0.08);
  return [
    shape('Window', box, k.style.surface, k.px(16), k.style.faint),
    shape('Sidebar', r(0.02, 0.04, 0.17, 0.92), ink, k.px(10)),
    shape('Heading', r(0.23, 0.08, 0.28, 0.05), rgba(k.style.text, 0.5), k.px(6)),
    shape('Subheading', r(0.23, 0.155, 0.18, 0.025), rgba(k.style.text, 0.22), k.px(4)),
    shape('Button', r(0.755, 0.0775, 0.17, 0.075), k.style.accent, k.px(10)),
    shape('Panel 1', r(0.23, 0.24, 0.45, 0.3), ink, k.px(12)),
    shape('Panel 2', r(0.7, 0.24, 0.255, 0.3), ink, k.px(12)),
    shape('Panel 3', r(0.23, 0.57, 0.725, 0.36), ink, k.px(12)),
  ];
}

// ---------------------------------------------------------------------------
// The templates
// ---------------------------------------------------------------------------

const DESIGNS: Record<TemplateId, TemplateDefinition & { design(p: TemplateParams, k: Kit): Design }> = {
  titleCard: {
    id: 'titleCard',
    label: 'Title card',
    description: 'Centred headline with an accent stroke and a supporting line.',
    seconds: 4,
    params: {
      title: { type: 'text', doc: 'the headline (default: the project name)' },
      subtitle: { type: 'text', doc: 'the supporting line' },
    },
    design(p, k) {
      const width = Math.min(k.W - 2 * k.m, k.px(1500));
      const x = Math.round((k.W - width) / 2);
      const title = str(p, 'title', k.project.name || 'Your headline');
      const subtitle = str(p, 'subtitle', 'One line that sets up the story');
      const titleSize = fitSize(title, k.px(124), k.px(64), width, 2);
      const bar = { width: k.px(140), stroke: k.px(8) };
      const head = textPart(k, 'Title', title, { x, y: 0, width }, { size: titleSize, font: k.style.displayFont, align: 'center', lineHeight: 1.08 }, { start: 0.15, motion: [{ preset: 'riseIn', seconds: 0.7 }] });
      const sub = textPart(k, 'Subtitle', subtitle, { x, y: 0, width }, { size: k.px(44), weight: 400, color: k.style.muted, align: 'center', lineHeight: 1.3 }, { start: 0.5, motion: [{ preset: 'riseIn', intensity: 0.5 }] });
      const gapBar = k.px(40);
      const gapSub = k.px(28);
      const total = bar.stroke + gapBar + head.box.height + gapSub + sub.box.height;
      const top = Math.round((k.H - total) / 2);
      head.box.y = top + bar.stroke + gapBar;
      sub.box.y = head.box.y + head.box.height + gapSub;
      return {
        push: { at: 1.1, scale: 1.03, focus: { x: k.W / 2, y: k.H / 2 } },
        parts: [
          {
            type: 'path',
            name: 'Accent stroke',
            box: { x: Math.round((k.W - bar.width) / 2), y: top, width: bar.width, height: bar.stroke },
            props: pathProps([{ x: 0, y: bar.stroke / 2 }, { x: bar.width, y: bar.stroke / 2 }], false, k.style.accent, bar.stroke),
            motion: [{ preset: 'wipeOn', seconds: 0.8 }],
          },
          head,
          sub,
        ],
      };
    },
  },

  lowerThird: {
    id: 'lowerThird',
    label: 'Lower third',
    description: 'Name and role on a plate in the lower left; slides in, fades out.',
    seconds: 5,
    params: {
      name: { type: 'text', doc: 'the person' },
      role: { type: 'text', doc: 'their role, muted' },
    },
    design(p, k) {
      const width = Math.min(k.W - 2 * k.m, k.px(760));
      const height = k.px(156);
      const x = k.m;
      // Vertical frames keep it clear of the platform UI along the bottom.
      const y = k.portrait ? k.H - Math.round(k.H * 0.2) - height : k.H - k.m - height;
      const inner = x + k.px(56);
      return {
        parts: [
          { type: 'shape', name: 'Plate', box: { x, y, width, height }, props: { shape: 'rect', fill: k.style.surface, stroke: 'none', strokeWidth: 0, cornerRadius: k.px(14) }, motion: [{ preset: 'slideInLeft', intensity: 0.5, seconds: 0.6 }] },
          { type: 'shape', name: 'Accent', box: { x: x + k.px(24), y: y + k.px(22), width: k.px(10), height: height - k.px(44) }, props: { shape: 'rect', fill: k.style.accent, stroke: 'none', strokeWidth: 0, cornerRadius: k.px(5) }, start: 0.1, motion: [{ preset: 'fadeIn', seconds: 0.4 }] },
          textPart(k, 'Name', str(p, 'name', 'Alex Rivera'), { x: inner, y: y + k.px(26), width: width - k.px(80) }, { size: k.px(50) }, { start: 0.2, motion: [{ preset: 'riseIn', intensity: 0.5, seconds: 0.5 }] }),
          textPart(k, 'Role', str(p, 'role', 'Head of Product'), { x: inner, y: y + k.px(90), width: width - k.px(80) }, { size: k.px(30), weight: 500, color: k.style.muted }, { start: 0.35, motion: [{ preset: 'fadeIn', seconds: 0.5 }] }),
        ],
        groupMotion: [{ preset: 'fadeOut', seconds: 0.5 }],
      };
    },
  },

  logoOutro: {
    id: 'logoOutro',
    label: 'Logo outro',
    description: 'Logo (or wordmark) with a tagline and a typed web address.',
    seconds: 4,
    params: {
      logoAssetId: { type: 'asset', kinds: ['svg', 'image'], doc: 'the logo (default: the first SVG, else the first image)' },
      wordmark: { type: 'text', doc: 'text logo when there is no logo file (default: the project name)' },
      tagline: { type: 'text', doc: 'line under the logo' },
      url: { type: 'text', doc: 'web address, typed on' },
    },
    design(p, k) {
      const svg = assetsOf(k.project, ['svg']);
      const images = assetsOf(k.project, ['image']);
      const chosen = typeof p.logoAssetId === 'string' ? k.project.assets[p.logoAssetId] : svg[0] ?? images[0];
      const slot = { x: k.m, y: 0, width: k.W - 2 * k.m, height: k.px(170) };
      const width = Math.min(k.W - 2 * k.m, k.px(1400));
      const tagline = textPart(k, 'Tagline', str(p, 'tagline', 'See it in action'), { x: Math.round((k.W - width) / 2), y: 0, width }, { size: k.px(56), weight: 600, align: 'center' }, { start: 0.45, motion: [{ preset: 'riseIn', intensity: 0.5 }] });
      const url = textPart(k, 'Web address', str(p, 'url', 'yourbrand.com'), { x: Math.round((k.W - width) / 2), y: 0, width }, { size: k.px(34), weight: 500, color: k.style.muted, align: 'center', font: k.style.monoFont }, { start: 0.9, motion: [{ preset: 'typewriter', seconds: 0.9 }] });
      let logo: Part;
      if (chosen && (chosen.kind === 'svg' || chosen.kind === 'image')) {
        const box = containBox({ ...slot, width: Math.min(slot.width, k.px(560)), x: Math.round((k.W - Math.min(slot.width, k.px(560))) / 2) }, chosen);
        logo = chosen.kind === 'svg'
          ? { type: 'logo', name: 'Logo', box, props: { assetId: chosen.id, fit: 'contain' }, motion: [{ preset: 'popIn', intensity: 0.4, seconds: 0.6 }] }
          : { type: 'image', name: 'Logo', box, props: { assetId: chosen.id, fit: 'contain', cornerRadius: 0, shadow: false }, motion: [{ preset: 'popIn', intensity: 0.4, seconds: 0.6 }] };
      } else {
        logo = textPart(k, 'Wordmark', str(p, 'wordmark', k.project.name || 'Brand'), { x: Math.round((k.W - width) / 2), y: 0, width }, { size: fitSize(k.project.name || 'Brand', k.px(112), k.px(56), width, 1), font: k.style.displayFont, align: 'center', tracking: -1 }, { motion: [{ preset: 'popIn', intensity: 0.4, seconds: 0.6 }] });
      }
      const gap1 = k.px(48);
      const gap2 = k.px(20);
      const total = logo.box.height + gap1 + tagline.box.height + gap2 + url.box.height;
      const top = Math.round((k.H - total) / 2);
      logo.box.y = top;
      tagline.box.y = top + logo.box.height + gap1;
      url.box.y = tagline.box.y + tagline.box.height + gap2;
      return { parts: [logo, tagline, url] };
    },
  },

  featureCallout: {
    id: 'featureCallout',
    label: 'Feature callout',
    description: 'A product UI card beside a headline and caption.',
    seconds: 5,
    params: {
      kicker: { type: 'text', doc: 'small accent label' },
      headline: { type: 'text', doc: 'the headline' },
      caption: { type: 'text', doc: 'one supporting sentence' },
      cardTitle: { type: 'text', doc: 'UI card title' },
      cardSubtitle: { type: 'text', doc: 'UI card subtitle' },
      metricLabel: { type: 'text', doc: 'UI card metric label' },
      metricValue: { type: 'text', doc: 'UI card metric value' },
      items: { type: 'text', doc: 'UI card list, one item per line' },
    },
    design(p, k) {
      const card = { width: k.px(640), height: k.px(420) };
      const gap = k.px(72);
      const captionWidth = k.portrait ? Math.min(k.W - 2 * k.m, k.px(900)) : Math.min(k.px(640), k.W - 2 * k.m - card.width - gap);
      const align = k.portrait ? 'center' : 'left';
      const kicker = textPart(k, 'Kicker', str(p, 'kicker', 'NEW'), { x: 0, y: 0, width: captionWidth }, { ...eyebrow(k), align }, { start: 0.3, motion: [{ preset: 'fadeIn', seconds: 0.4 }] });
      const headline = textPart(k, 'Headline', str(p, 'headline', 'Everything in one view'), { x: 0, y: 0, width: captionWidth }, { size: fitSize(str(p, 'headline', 'Everything in one view'), k.px(68), k.px(44), captionWidth, 3), font: k.style.displayFont, align, lineHeight: 1.08 }, { start: 0.4, motion: [{ preset: 'riseIn', seconds: 0.6 }] });
      const body = textPart(k, 'Caption', str(p, 'caption', 'Your numbers update live, so the team always sees the latest.'), { x: 0, y: 0, width: captionWidth }, { size: k.px(32), weight: 400, color: k.style.muted, align, lineHeight: 1.35 }, { start: 0.65, motion: [{ preset: 'riseIn', intensity: 0.5 }] });
      const captionHeight = kicker.box.height + k.px(14) + headline.box.height + k.px(20) + body.box.height;
      let cardX: number, cardY: number, capX: number, capY: number;
      if (k.portrait) {
        const total = card.height + gap + captionHeight;
        cardX = Math.round((k.W - card.width) / 2);
        cardY = Math.round((k.H - total) / 2);
        capX = Math.round((k.W - captionWidth) / 2);
        capY = cardY + card.height + gap;
      } else {
        const total = card.width + gap + captionWidth;
        cardX = Math.round((k.W - total) / 2);
        cardY = Math.round((k.H - card.height) / 2);
        capX = cardX + card.width + gap;
        capY = Math.round((k.H - captionHeight) / 2);
      }
      kicker.box = { ...kicker.box, x: capX, y: capY };
      headline.box = { ...headline.box, x: capX, y: capY + kicker.box.height + k.px(14) };
      body.box = { ...body.box, x: capX, y: headline.box.y + headline.box.height + k.px(20) };
      return {
        push: { at: 1.2, scale: 1.03, focus: { x: cardX + card.width / 2, y: cardY + card.height / 2 } },
        parts: [
          glowPart(k, 'Card glow', { x: cardX, y: cardY, ...card }, k.style.accent, { alpha: 0.4, spread: 0.25 }),
          {
            type: 'uiCard',
            name: 'UI card',
            box: { x: cardX, y: cardY, ...card },
            props: {
              ...COMPONENTS.uiCard.defaultProps,
              title: str(p, 'cardTitle', 'Weekly report'),
              subtitle: str(p, 'cardSubtitle', 'Updated just now'),
              metricLabel: str(p, 'metricLabel', 'Time saved'),
              metricValue: str(p, 'metricValue', '12 h'),
              items: str(p, 'items', 'Drafts in seconds\nShared automatically\nAlways on brand'),
              accentColor: k.style.accent,
              background: k.style.surface,
              textColor: k.style.text,
            },
            motion: [{ preset: 'popIn', intensity: 0.3, seconds: 0.6 }],
          },
          kicker,
          headline,
          body,
        ],
      };
    },
  },

  chatExchange: {
    id: 'chatExchange',
    label: 'Chat exchange',
    description: 'Two or three messages that type in one after another.',
    seconds: 6,
    params: {
      messages: { type: 'text', doc: '2–4 messages, one per line, alternating user / reply' },
      userName: { type: 'text', doc: 'the user\'s name' },
      agentName: { type: 'text', doc: 'the replier\'s name' },
    },
    design(p, k) {
      const messages = str(p, 'messages', "Can you summarise this week's changes?\nThree releases shipped: billing retries, faster search and SSO.\nPerfect — send it to the team.")
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 4);
      const width = Math.min(k.W - 2 * k.m, k.px(980));
      const x = Math.round((k.W - width) / 2);
      const size = k.px(38);
      const gap = k.px(28);
      const bubbles: Part[] = messages.map((text, i) => {
        const user = i % 2 === 0;
        const nameLine = Math.max(12, Math.round(size * 0.5)) * 1.2 + size * 0.45;
        const lines = lineCount(text, size * 0.96, width - size * 1.6);
        const height = Math.ceil(nameLine + size + lines * size * 1.35 + k.px(8));
        return {
          type: 'chatBubble',
          name: user ? `Message ${i + 1} (user)` : `Message ${i + 1} (reply)`,
          box: { x, y: 0, width, height },
          props: {
            text,
            sender: user ? 'user' : 'assistant',
            senderName: user ? str(p, 'userName', 'You') : str(p, 'agentName', 'Assistant'),
            bubbleColor: user ? k.style.accent : k.style.surface,
            textColor: user ? k.style.onAccent : k.style.text,
            fontSize: Math.min(120, size),
            typing: !user,
            typingDurationInFrames: user ? 0 : Math.round(0.9 * k.project.fps),
          },
          start: i * 1.5,
          motion: [{ preset: 'riseIn', intensity: 0.5, seconds: 0.5 }],
        };
      });
      const total = bubbles.reduce((n, b) => n + b.box.height, 0) + gap * Math.max(0, bubbles.length - 1);
      let y = Math.round((k.H - total) / 2);
      for (const b of bubbles) {
        b.box.y = y;
        y += b.box.height + gap;
      }
      return { parts: bubbles };
    },
  },

  statCounter: {
    id: 'statCounter',
    label: 'Stat counter',
    description: 'A big number inside a ring that fills to it, with a label.',
    seconds: 4,
    params: {
      value: { type: 'text', doc: 'the number, e.g. "87%"' },
      progress: { type: 'number', doc: 'ring fill 0–1 (default: a % value, else 0.75)' },
      label: { type: 'text', doc: 'what the number means' },
    },
    design(p, k) {
      const value = str(p, 'value', '87%');
      const parsed = /(-?\d+(?:\.\d+)?)\s*%/.exec(value);
      const progress = Math.max(0.02, Math.min(1, typeof p.progress === 'number' ? p.progress : parsed ? Number(parsed[1]) / 100 : 0.75));
      const size = Math.round(Math.min(k.px(420), (k.H - 2 * k.m) * 0.5, k.W - 2 * k.m));
      const stroke = k.px(26);
      const nodes = circleNodes(size, stroke / 2 + 1);
      const labelWidth = Math.min(k.W - 2 * k.m, k.px(900));
      const label = textPart(k, 'Label', str(p, 'label', 'of teams read every update'), { x: Math.round((k.W - labelWidth) / 2), y: 0, width: labelWidth }, { size: k.px(40), weight: 500, align: 'center', lineHeight: 1.25 }, { start: 0.5, motion: [{ preset: 'riseIn', intensity: 0.5 }] });
      const gap = k.px(40);
      const top = Math.round((k.H - (size + gap + label.box.height)) / 2);
      const ringX = Math.round((k.W - size) / 2);
      label.box.y = top + size + gap;
      const numberSize = Math.round(size * 0.27);
      const number = textPart(k, 'Value', value, { x: ringX, y: 0, width: size }, { size: numberSize, font: k.style.displayFont, align: 'center', lineHeight: 1 }, { start: 0.2, motion: [{ preset: 'popIn', intensity: 0.3, seconds: 0.5 }] });
      number.box.y = top + Math.round((size - number.box.height) / 2);
      const fill = Math.round(1.4 * k.project.fps);
      return {
        parts: [
          { type: 'path', name: 'Ring track', box: { x: ringX, y: top, width: size, height: size }, props: pathProps(nodes, true, k.style.faint, stroke), motion: [{ preset: 'fadeIn', seconds: 0.4 }] },
          {
            type: 'path',
            name: 'Ring',
            box: { x: ringX, y: top, width: size, height: size },
            props: pathProps(nodes, true, k.style.accent, stroke, { trimEnd: progress }),
            propTracks: [{ key: 'props.trimEnd', keyframes: [{ frame: 0, value: 0, easing: 'easeOutCubic' }, { frame: fill, value: progress, easing: 'easeInOut' }] }],
          },
          number,
          label,
        ],
      };
    },
  },

  walkthroughStep: {
    id: 'walkthroughStep',
    label: 'Walkthrough step',
    description: 'A product screenshot (64 % of the width, on a glow, pushing in slowly) with a highlight that draws on, and a numbered caption beside it.',
    seconds: 5,
    params: {
      imageAssetId: { type: 'asset', kinds: ['image', 'svg'], doc: 'the screenshot (default: the first image)' },
      step: { type: 'number', doc: 'step number on the badge' },
      caption: { type: 'text', doc: 'the step, as a short headline' },
      detail: { type: 'text', doc: 'one supporting sentence' },
    },
    design(p, k) {
      const picked = typeof p.imageAssetId === 'string' ? k.project.assets[p.imageAssetId] : assetsOf(k.project, ['image'])[0] ?? assetsOf(k.project, ['svg'])[0];
      const chosen = picked && picked.kind !== 'audio' ? picked : undefined;
      const gap = k.px(64);
      const area = k.portrait
        ? { x: k.m, y: k.m, width: k.W - 2 * k.m, height: Math.round((k.H - 2 * k.m) * 0.55) }
        : { x: k.m, y: k.m, width: Math.round(k.W * 0.64), height: k.H - 2 * k.m };
      const aspect = chosen?.width && chosen.height ? chosen.width / chosen.height : 16 / 10;
      let width = area.width;
      let height = Math.round(width / aspect);
      if (height > area.height) {
        height = area.height;
        width = Math.round(height * aspect);
      }
      const captionWidth = k.portrait ? k.W - 2 * k.m : k.W - 2 * k.m - width - gap;
      const step = Math.max(1, Math.round(typeof p.step === 'number' ? p.step : 1));
      const badge = textPart(k, 'Step', `STEP ${step}`, { x: 0, y: 0, width: captionWidth }, eyebrow(k), { start: 0.3, motion: [{ preset: 'fadeIn', seconds: 0.4 }] });
      const captionText = str(p, 'caption', 'Open your workspace');
      const caption = textPart(k, 'Caption', captionText, { x: 0, y: 0, width: captionWidth }, { size: fitSize(captionText, k.px(60), k.px(40), captionWidth, 3), font: k.style.displayFont, lineHeight: 1.08 }, { start: 0.4, motion: [{ preset: 'riseIn', seconds: 0.6 }] });
      const detail = textPart(k, 'Detail', str(p, 'detail', 'Everything you shared lands here, sorted by project.'), { x: 0, y: 0, width: captionWidth }, { size: k.px(32), weight: 400, color: k.style.muted, lineHeight: 1.35 }, { start: 0.7, motion: [{ preset: 'fadeIn', seconds: 0.5 }] });
      const captionHeight = badge.box.height + k.px(12) + caption.box.height + k.px(18) + detail.box.height;
      const total = k.portrait ? height + gap + captionHeight : width + gap + captionWidth;
      const imageBox = k.portrait
        ? { x: Math.round((k.W - width) / 2), y: Math.round((k.H - total) / 2), width, height }
        : { x: Math.round((k.W - total) / 2), y: Math.round((k.H - height) / 2), width, height };
      const capX = k.portrait ? imageBox.x : imageBox.x + width + gap;
      const capY = k.portrait ? imageBox.y + height + gap : Math.round((k.H - captionHeight) / 2);
      badge.box = { ...badge.box, x: capX, y: capY };
      caption.box = { ...caption.box, x: capX, y: capY + badge.box.height + k.px(12) };
      detail.box = { ...detail.box, x: capX, y: caption.box.y + caption.box.height + k.px(18) };
      const pad = k.px(10);
      const region = { x: imageBox.x + Math.round(width * 0.08) - pad, y: imageBox.y + Math.round(height * 0.2) - pad, width: Math.round(width * 0.46) + 2 * pad, height: Math.round(height * 0.22) + 2 * pad };
      const screen: Part = chosen
        ? { type: 'image', name: 'Screenshot', box: imageBox, props: { assetId: chosen.id, fit: 'cover', cornerRadius: k.px(18), shadow: true }, motion: [{ preset: 'riseIn', intensity: 0.4, seconds: 0.6 }] }
        : { type: 'shape', name: 'Screenshot placeholder', box: imageBox, props: { shape: 'rect', fill: k.style.surface, stroke: k.style.faint, strokeWidth: k.px(2), cornerRadius: k.px(18) }, motion: [{ preset: 'riseIn', intensity: 0.4, seconds: 0.6 }] };
      return {
        parts: [
          glowPart(k, 'Screenshot glow', imageBox, k.style.accent, { alpha: 0.45, spread: 0.2 }),
          screen,
          { type: 'path', name: 'Highlight', box: region, props: pathProps(roundedRectNodes(region.width, region.height, k.px(18)), true, k.style.accent, k.px(6)), start: 0.6, motion: [{ preset: 'wipeOn', seconds: 1 }] },
          badge,
          caption,
          detail,
        ],
        push: { at: 1.2, scale: 1.03, focus: { x: region.x + region.width / 2, y: region.y + region.height / 2 } },
      };
    },
  },
  kineticTitle: {
    id: 'kineticTitle',
    label: 'Kinetic title',
    description: 'Big headline lines rise one by one from behind their own masks; a kicker tightens into place above; an optional punchline (`sub`) lands word by word at full contrast. `widthShare` (0.4–1) narrows the block to leave room for a backdrop texture.',
    seconds: 4,
    params: {
      lines: { type: 'text', doc: '1–4 headline lines, one per line (long lines re-flow)' },
      kicker: { type: 'text', doc: 'small accent label above' },
      sub: { type: 'text', doc: 'punchline under the lines, word by word in the accent' },
      accentLine: { type: 'number', doc: '1-based line in the accent (default: the last line; none with sub)' },
      widthShare: { type: 'number', doc: '0.4–1 share of the width (0.58 leaves room for a backdrop)' },
    },
    design(p, k) {
      const given = str(p, 'lines', 'Ship the brief.\nNot the backlog.').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4);
      const subText = str(p, 'sub', '');
      // The accent marks one thing: the last line by default, or the punchline when there is one.
      const accentIndex = typeof p.accentLine === 'number' ? Math.round(p.accentLine) - 1 : subText ? -1 : given.length - 1;
      const x = k.portrait ? k.m : k.m + k.px(48);
      const width = Math.round((k.W - 2 * x) * Math.min(1, Math.max(0.4, num(p, 'widthShare', 1))));
      // Lines too long to stay big re-flow by words (narrow frames get more, shorter lines).
      const perLine = Math.max(4, Math.floor(width / (k.px(k.portrait ? 128 : 112) * 0.6)));
      const flowed = given.flatMap((line, i) => flowWords(line, perLine).map((text) => ({ text, accent: i === accentIndex })));
      const lines = flowed.slice(0, 6).map((l) => l.text);
      const biggest = k.px(k.portrait ? (lines.length <= 2 ? 160 : 136) : lines.length <= 2 ? 200 : 156);
      const size = Math.min(...lines.map((l) => fitSize(l, biggest, k.px(56), width, 1)));
      const lineBox = Math.round(size * 1.18);
      const ruleW = k.px(56);
      const kickerStyle = { ...eyebrow(k), tracking: k.px(5), trackFrom: k.px(16), lineHeight: 1.2 };
      const kicker = textPart(k, 'Kicker', str(p, 'kicker', 'INTRODUCING'), { x: x + ruleW + k.px(20), y: 0, width: width - ruleW - k.px(20) }, kickerStyle, { start: 0.1, motion: [{ preset: 'fadeIn', seconds: 0.5 }], keys: [{ prop: 'props.letterSpacing', s: 0, value: kickerStyle.trackFrom, easing: k.enter }, { prop: 'props.letterSpacing', s: 0.9, value: kickerStyle.tracking }] });
      const kickerRow = kicker.box.height;
      const kickerGap = k.px(40);
      const subGap = k.px(36);
      const sub = subText ? textPart(k, 'Punchline', subText, { x, y: 0, width }, { size: k.px(52), weight: 600, color: k.style.accent, lineHeight: 1.25 }) : undefined;
      const subH = sub ? subGap + sub.box.height : 0;
      const top = Math.round((k.H - (kickerRow + kickerGap + lines.length * lineBox + subH)) / 2);
      kicker.box.y = top;
      const parts: Part[] = [
        // The rule sits on the kicker's first line.
        { type: 'path', name: 'Kicker rule', box: { x, y: top + Math.round(kickerStyle.size * 0.6) - k.px(2), width: ruleW, height: k.px(4) }, props: pathProps([{ x: 0, y: k.px(2) }, { x: ruleW, y: k.px(2) }], false, k.style.accent, k.px(4), { lineCap: 'butt' }), motion: [{ preset: 'wipeOn', seconds: 0.5 }] },
        kicker,
      ];
      lines.forEach((line, i) => {
        const box = { x, y: top + kickerRow + kickerGap + i * lineBox, width, height: lineBox };
        const timing = { start: 0.2, startFrames: i * k.stagger * 2 };
        parts.push({ type: 'shape', name: `Line ${i + 1} mask`, box, props: { shape: 'rect', fill: '#FFFFFF', stroke: 'none', strokeWidth: 0, cornerRadius: 0 }, ...timing });
        parts.push({
          ...textPart(k, `Line ${i + 1}`, line, box, { size, font: k.style.displayFont, color: flowed[i].accent ? k.style.accent : k.style.text, lineHeight: 1.08, tracking: -Math.round(size * 0.025) }),
          box,
          ...timing,
          maskBy: `Line ${i + 1} mask`,
          keys: [{ track: 'y', s: 0, value: lineBox, easing: k.enter }, { track: 'y', s: 0.6, value: 0 }],
        });
      });
      if (sub) {
        // The punchline gets its own beat: word by word, after the last line has landed.
        const lastLine = 0.2 + ((lines.length - 1) * k.stagger * 2) / k.project.fps + 0.45;
        sub.box.y = top + kickerRow + kickerGap + lines.length * lineBox + subGap;
        sub.props = { ...sub.props, reveal: 'wordStagger', revealDurationInFrames: Math.round(k.project.fps * Math.min(1.2, 0.4 + subText.split(/\s+/).length * 0.12)) };
        parts.push({ ...sub, start: lastLine });
      }
      return { parts, push: { at: 0.8, scale: 1.04, focus: { x: x + width / 2, y: k.H / 2 } } };
    },
  },

  uiWalkthrough: {
    id: 'uiWalkthrough',
    label: 'UI walkthrough',
    description: 'A big screen (72–78 % of the width) on a glow; a cursor arcs to a target and clicks; a ripple, a highlight ring and a callout beside the target (below, above or to a side, never over it) follow under a slow push in. Options: `title` (headline above, word by word) with the logo over it, `bleed: 1` (the screen runs off the bottom edge), `spotlight: 1` (dims the rest of the screen to 60 % for a second, then lifts), `chips` (one per line, staggered at the screen’s edges, clear of the target and callout).',
    seconds: 5,
    params: {
      imageAssetId: { type: 'asset', kinds: ['image', 'svg'], doc: 'the screenshot (default: the first image; none draws a mock app)' },
      label: { type: 'text', doc: 'callout text at the target (the caption in portrait)' },
      title: { type: 'text', doc: 'headline above the screen, word by word' },
      logo: { type: 'number', doc: '1 puts the SVG logo over the title (default 1 with a title)' },
      logoAssetId: { type: 'asset', kinds: ['svg'], doc: 'the logo SVG' },
      bleed: { type: 'number', doc: '1: the screen runs off the bottom edge (78 % wide)' },
      spotlight: { type: 'number', doc: '1: dims the rest of the screen at the click, then lifts' },
      calloutSide: { type: 'text', values: ['auto', ...CALLOUT_SIDES], doc: 'side of the target the callout takes when it fits (default auto: below, above, right, left); it never covers the target, so pick a side clear of what the viewer must read (landscape)' },
      chips: { type: 'text', doc: 'up to 3 chips, one per line, at the screen edges, clear of the target and callout (landscape)' },
      targetX: { type: 'number', doc: 'click target centre, fraction of the screen width' },
      targetY: { type: 'number', doc: 'click target centre, fraction of the screen height' },
      targetW: { type: 'number', doc: 'target width, fraction of the screen' },
      targetH: { type: 'number', doc: 'target height, fraction of the screen' },
      fromX: { type: 'number', doc: 'cursor start, fraction of the screen width (continue a previous step)' },
      fromY: { type: 'number', doc: 'cursor start, fraction of the screen height' },
      screenEnter: { type: 'number', doc: '0: the screen is already there (a one-take step after another)' },
      step: { type: 'number', doc: 'step number on the badge (portrait)' },
      push: { type: 'number', doc: 'scale at the end of the push (default 1.05)' },
      pushFrom: { type: 'number', doc: 'scale the push starts from (default 1; carry a push across steps)' },
      pushFocus: { type: 'text', values: ['target', 'screen'], doc: 'what the push keeps still' },
    },
    design(p, k) {
      const picked = typeof p.imageAssetId === 'string' ? k.project.assets[p.imageAssetId] : assetsOf(k.project, ['image'])[0];
      const chosen = picked && (picked.kind === 'image' || picked.kind === 'svg') ? picked : undefined;
      const aspect = chosen?.width && chosen.height ? chosen.width / chosen.height : 16 / 10;
      const captionText = str(p, 'label', 'Send it to the team');
      const bleed = num(p, 'bleed', 0) > 0;
      const titleText = str(p, 'title', '');
      const logoAsset = typeof p.logoAssetId === 'string' ? k.project.assets[p.logoAssetId] : num(p, 'logo', titleText ? 1 : 0) > 0 ? assetsOf(k.project, ['svg'])[0] : undefined;
      const headW = Math.min(k.W - 2 * k.m, k.px(1400));
      const headX = Math.round((k.W - headW) / 2);
      const logo: Part | undefined = logoAsset && logoAsset.kind === 'svg'
        ? { type: 'logo', name: 'Logo', box: containBox({ x: headX, y: 0, width: headW, height: k.px(44) }, logoAsset), props: { assetId: logoAsset.id, fit: 'contain' }, motion: [{ preset: 'popIn', intensity: 0.4, seconds: 0.5 }] }
        : undefined;
      const title = titleText
        ? { ...textPart(k, 'Title', titleText, { x: headX, y: 0, width: headW }, { size: fitSize(titleText, k.px(k.portrait ? 64 : 72), k.px(44), headW, 2), font: k.style.displayFont, align: 'center', lineHeight: 1.1, tracking: -k.px(1), balance: true }), start: 0.1 }
        : undefined;
      if (title) title.props = { ...title.props, reveal: 'wordStagger', revealDurationInFrames: Math.round(k.project.fps * Math.min(1, 0.35 + titleText.split(/\s+/).length * 0.1)) };
      const headGap = k.px(18);
      const headH = (logo ? logo.box.height + (title ? headGap : 0) : 0) + (title ? title.box.height : 0);
      const screenGap = headH ? k.px(44) : 0;
      const step = Math.max(1, Math.round(num(p, 'step', 1)));
      const badge = textPart(k, 'Step', `STEP ${step}`, { x: 0, y: 0, width: k.W - 2 * k.m }, eyebrow(k), { start: 1.9, motion: [{ preset: 'fadeIn', seconds: 0.4 }] });
      const caption = textPart(k, 'Caption', captionText, { x: 0, y: 0, width: k.W - 2 * k.m }, { size: fitSize(captionText, k.px(68), k.px(44), k.W - 2 * k.m, 2), font: k.style.displayFont, lineHeight: 1.08 }, { start: 1.9, startFrames: k.stagger, motion: [{ preset: 'riseIn', seconds: 0.6 }] });
      const captionH = k.portrait ? k.px(72) + badge.box.height + k.px(12) + caption.box.height : 0;
      // The screen fills 72 % of the width (78 % when it bleeds off the bottom); the head and caption take the rest.
      const maxH = k.portrait ? Math.round((k.H - 2 * k.m) * 0.5) : k.H - 2 * k.m - k.px(24) - headH - screenGap;
      let width = Math.min(k.W - 2 * k.m, k.px(bleed ? 1500 : 1440));
      let height = Math.round(width / aspect);
      if (!bleed && height > maxH) {
        height = maxH;
        width = Math.round(height * aspect);
      }
      const stack = headH + screenGap + height + captionH;
      const top = bleed ? (headH ? k.m : Math.round(k.H * 0.2)) : Math.round((k.H - stack) / 2);
      const screen = { x: Math.round((k.W - width) / 2), y: top + headH + screenGap, width, height };
      if (logo) logo.box.y = top;
      if (title) title.box.y = top + (logo ? logo.box.height + headGap : 0);
      const tx = num(p, 'targetX', chosen ? 0.5 : 0.84);
      const ty = num(p, 'targetY', chosen ? 0.4 : 0.115);
      const tw = num(p, 'targetW', chosen ? 0.2 : 0.17);
      const th = num(p, 'targetH', chosen ? 0.1 : 0.075);
      const target = { x: Math.round(screen.x + tx * width), y: Math.round(screen.y + ty * height) };
      const pad = k.px(10);
      const region = { x: Math.round(target.x - (tw * width) / 2) - pad, y: Math.round(target.y - (th * height) / 2) - pad, width: Math.round(tw * width) + 2 * pad, height: Math.round(th * height) + 2 * pad };
      // A step that continues the previous one keeps the screen still (screenEnter 0) and starts the cursor where it was (fromX/fromY).
      const continuing = num(p, 'screenEnter', 1) <= 0;
      const screenStart = continuing ? 0 : headH ? 0.3 : 0;
      const enterScreen: Motion[] = continuing ? [] : [{ preset: 'riseIn', intensity: 0.6, seconds: 0.7 }];
      const from = { x: Math.round(screen.x + num(p, 'fromX', tx + k.px(440) / width) * width) - target.x, y: Math.round(screen.y + num(p, 'fromY', ty + k.px(300) / height) * height) - target.y };
      const parts: Part[] = [
        ...(continuing ? [glowPart(k, 'Screen glow', screen, k.style.accent, { alpha: 0.5, spread: 0.22, seconds: 0.1 })] : [glowPart(k, 'Screen glow', screen, k.style.accent, { alpha: 0.5, spread: 0.22, start: screenStart })]),
        ...(logo ? [logo] : []),
        ...(title ? [title] : []),
        ...(chosen
          ? [{ type: 'image', name: 'Screen', box: screen, props: { assetId: chosen.id, fit: 'cover', cornerRadius: k.px(16), shadow: true }, start: screenStart, motion: enterScreen } as Part]
          : mockScreen(k, screen, enterScreen).map((part) => ({ ...part, start: screenStart }))),
      ];
      // Cursor: arcs in from the lower right (y eases out fast, x eases in-out), presses, holds.
      const arrive = 0.6;
      const travel = 0.9;
      const click = arrive + travel + 0.08;
      // A continuing step shows the cursor from the first frame, holding where the last step left it.
      const lead = enterScreen.length ? 0 : arrive;
      const ch = k.px(44);
      const cursor = cursorNodes(ch);
      parts.push({
        type: 'path',
        name: 'Cursor',
        box: { x: target.x, y: target.y, width: cursor.width, height: ch },
        props: pathProps(cursor.nodes, true, '#0B0D17', k.px(2.5), { fill: '#FFFFFF', lineJoin: 'round' }),
        start: arrive - lead,
        keys: [
          { track: 'x', s: lead, value: from.x, easing: 'easeInOutCubic' },
          { track: 'x', s: lead + travel, value: 0 },
          { track: 'y', s: lead, value: from.y, easing: 'easeOutExpo' },
          { track: 'y', s: lead + travel, value: 0 },
          ...(enterScreen.length ? [{ track: 'opacity', s: 0, value: 0, easing: 'easeOut' }, { track: 'opacity', s: 0.15, value: 1 }] as TimedKey[] : []),
          { track: 'scale', s: lead + click - arrive, value: 1, easing: 'easeOut' },
          { track: 'scale', s: lead + click - arrive + 0.07, value: 0.82, easing: 'easeOutCubic' },
          { track: 'scale', s: lead + click - arrive + 0.3, value: 1 },
        ],
      });
      const rs = k.px(150);
      parts.push({
        type: 'shape',
        name: 'Click ripple',
        box: { x: target.x - Math.round(rs / 2), y: target.y - Math.round(rs / 2), width: rs, height: rs },
        props: { shape: 'ellipse', fill: 'none', stroke: k.style.accent, strokeWidth: k.px(4), cornerRadius: 0 },
        start: click + 0.05,
        keys: [
          { track: 'scale', s: 0, value: 0.15, easing: 'easeOutCubic' },
          { track: 'scale', s: 0.6, value: 1.15 },
          { track: 'opacity', s: 0, value: 1, easing: 'easeIn' },
          { track: 'opacity', s: 0.6, value: 0 },
        ],
      });
      // Spotlight: at the click the rest of the screen steps back to ~60 % behind the target (a dim plate with the region cut out),
      // holds a second while the callout lands, then lifts again so the product stays the picture.
      const spotlight = num(p, 'spotlight', 0);
      if (spotlight > 0) {
        const cursorIndex = parts.findIndex((part) => part.name === 'Cursor');
        const timing = { start: click + 0.05 };
        const dim = Math.min(0.6, 0.4 * spotlight);
        parts.splice(cursorIndex, 0,
          { type: 'shape', name: 'Spotlight hole', box: region, props: { shape: 'rect', fill: '#FFFFFF', stroke: 'none', strokeWidth: 0, cornerRadius: k.px(14) }, ...timing },
          { type: 'shape', name: 'Spotlight dim', box: screen, props: { shape: 'rect', fill: k.style.background, stroke: 'none', strokeWidth: 0, cornerRadius: k.px(16) }, ...timing, maskBy: 'Spotlight hole', maskMode: 'inverted', keys: [{ track: 'opacity', s: 0, value: 0, easing: k.enter }, { track: 'opacity', s: 0.4, value: dim, easing: 'hold' }, { track: 'opacity', s: 1.5, value: dim, easing: 'easeInOut' }, { track: 'opacity', s: 2.1, value: 0 }] },
        );
      }
      parts.push({ type: 'path', name: 'Highlight', box: region, props: pathProps(roundedRectNodes(region.width, region.height, k.px(14)), true, k.style.accent, k.px(5)), start: click + 0.1, motion: [{ preset: 'wipeOn', seconds: 0.6 }] });
      if (k.portrait) {
        badge.box = { ...badge.box, x: screen.x, y: screen.y + height + k.px(72) };
        caption.box = { ...caption.box, x: screen.x, y: badge.box.y + badge.box.height + k.px(12), width: screen.width };
        parts.push(badge, caption);
      } else {
        // The callout pill sits beside the target, never over it: below, above, right or left of it, whichever fits on the screen (else in the frame).
        const size = k.px(30);
        const padX = k.px(28);
        const pillH = Math.round(size * 2.1);
        const pillW = Math.round(captionText.length * size * 0.56 + 2 * padX);
        const frame = inset({ x: 0, y: 0, width: k.W, height: k.H }, k.px(24));
        const side = str(p, 'calloutSide', 'auto');
        const pill = besideTarget(region, pillW, pillH, k.px(24), [within(inset(screen, k.px(16)), frame), frame], target.x > screen.x + width / 2, CALLOUT_SIDES.find((s) => s === side));
        const timing = { start: click + 0.3 };
        parts.push({ type: 'shape', name: 'Callout', box: pill, props: { shape: 'rect', fill: k.style.accent, stroke: 'none', strokeWidth: 0, cornerRadius: Math.round(pillH / 2) }, effects: { dropShadow: { x: 0, y: k.px(8), blur: k.px(24), color: 'rgba(0, 0, 0, 0.35)' } }, ...timing, motion: pillIn(0.6) });
        parts.push({ ...textPart(k, 'Callout text', captionText, { x: pill.x, y: pill.y + Math.round((pillH - size * 1.25) / 2), width: pill.width }, { size, weight: 600, color: k.style.onAccent, align: 'center', lineHeight: 1.2 }), ...timing, motion: pillIn(0.6) });
        // Chips ride the screen's edges, arriving apart after the click (the hold keeps landing things), each at the
        // first free spot along its edge: never over the target, the callout or another chip.
        const chips = str(p, 'chips', '').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 3);
        const taken: Box[] = [region, pill];
        const rows = [0.44, 0.62, 0.78, 0.26, 0.9];
        chips.forEach((text, i) => {
          const size = k.px(28);
          const dot = k.px(14);
          const padX = k.px(24);
          const h = Math.round(size * 2);
          const w = Math.round(text.length * size * 0.56 + dot + k.px(12) + 2 * padX);
          const over = k.px(48);
          const edges = [screen.x - over, screen.x + width - w + over].map((x) => Math.max(k.px(24), Math.min(k.W - w - k.px(24), x)));
          if (i % 2) edges.reverse();
          const spot = (x: number, row: number): Box => ({ x, y: Math.min(k.H - h - k.px(24), screen.y + Math.round(height * row)), width: w, height: h });
          const order = [rows[i], ...rows.filter((_, j) => j !== i)];
          const chip = edges.flatMap((x) => order.map((row) => spot(x, row))).find((b) => !taken.some((t) => overlaps(b, t, k.px(16)))) ?? spot(edges[0], rows[i]);
          taken.push(chip);
          const { x, y } = chip;
          const timing = { start: click + 1.1 + i * 0.5 };
          parts.push({ type: 'shape', name: `Chip ${i + 1}`, box: chip, props: { shape: 'rect', fill: k.style.surface, stroke: k.style.faint, strokeWidth: k.px(1.5), cornerRadius: Math.round(h / 2) }, effects: { dropShadow: { x: 0, y: k.px(10), blur: k.px(30), color: 'rgba(0, 0, 0, 0.4)' } }, ...timing, motion: pillIn(0.7) });
          parts.push({ type: 'shape', name: `Chip ${i + 1} dot`, box: { x: x + padX, y: y + Math.round((h - dot) / 2), width: dot, height: dot }, props: { shape: 'ellipse', fill: k.style.accent2, stroke: 'none', strokeWidth: 0, cornerRadius: 0 }, ...timing, startFrames: 2, motion: [{ preset: 'popIn', intensity: 0.6, seconds: 0.4 }] });
          parts.push({ ...textPart(k, `Chip ${i + 1} text`, text, { x: x + padX + dot + k.px(12), y: y + Math.round((h - size * 1.2) / 2), width: w - padX - dot - k.px(12) }, { size, weight: 600, lineHeight: 1.2 }), ...timing, motion: pillIn(0.7) });
        });
      }
      // The push: towards the target by default; `pushFocus: 'screen'` with `pushFrom` carries one continuous push across one-take steps (1 → 1.02, 1.02 → 1.04, …).
      const push = num(p, 'push', 1.05);
      const pushFrom = num(p, 'pushFrom', 1);
      const focus = str(p, 'pushFocus', 'target') === 'screen' ? { x: screen.x + width / 2, y: screen.y + height / 2 } : target;
      return { parts, ...(push !== pushFrom ? { push: { at: continuing ? 0 : arrive + travel - 0.3, scale: push, from: pushFrom, focus } } : {}) };
    },
  },

  featureGrid: {
    id: 'featureGrid',
    label: 'Feature grid',
    description: 'A headline over a grid of feature cards that arrive apart in reading order, each card’s icon, title and line following it in.',
    seconds: 6,
    params: {
      features: { type: 'text', doc: 'up to 6 cards, one per line as "Title: one line"' },
      kicker: { type: 'text', doc: 'small accent label' },
      title: { type: 'text', doc: 'the headline' },
    },
    design(p, k) {
      const items = str(p, 'features', 'Instant summaries: Every merged PR, explained in plain words.\nRead receipts: See who caught up, and who still needs to.\nSmart grouping: Changes sorted by team, product and risk.\nOne-click share: Send the brief to Slack, email or Notion.')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(0, 6)
        .map((l) => {
          const [title, ...rest] = l.split(':');
          return { title: title.trim(), body: rest.join(':').trim() };
        });
      const n = items.length;
      const cols = k.portrait ? (n > 3 ? 2 : 1) : n <= 4 ? n : 3;
      const rows = Math.ceil(n / cols);
      const gridW = Math.min(k.W - 2 * k.m, k.px(1680));
      const x0 = Math.round((k.W - gridW) / 2);
      const kicker = textPart(k, 'Kicker', str(p, 'kicker', 'WHAT YOU GET'), { x: x0, y: 0, width: gridW }, eyebrow(k), { motion: [{ preset: 'fadeIn', seconds: 0.4 }] });
      const titleText = str(p, 'title', 'Everything your team shipped, in one place');
      const title = textPart(k, 'Title', titleText, { x: x0, y: 0, width: Math.min(gridW, k.px(1300)) }, { size: fitSize(titleText, k.px(84), k.px(52), Math.min(gridW, k.px(1300)), 2), font: k.style.displayFont, lineHeight: 1.06, tracking: -k.px(1.5), balance: true }, { start: 0.1, motion: [{ preset: 'riseIn', seconds: 0.6 }] });
      const gap = k.px(24);
      const cellW = Math.round((gridW - (cols - 1) * gap) / cols);
      const pad = k.px(cols >= 4 ? 34 : 40);
      const tile = k.px(64);
      const titleSize = k.px(cols >= 4 ? 34 : 38);
      const bodySize = k.px(cols >= 4 ? 26 : 28);
      // Titles share one baseline grid: every body starts below the tallest title.
      const titleLines = Math.min(2, Math.max(...items.map((it) => lineCount(it.title, titleSize, cellW - 2 * pad, 0.56))));
      const bodyLines = Math.min(4, Math.max(...items.map((it) => lineCount(it.body, bodySize, cellW - 2 * pad, 0.54))));
      const titleH = Math.round(titleLines * titleSize * 1.18);
      const cellH = pad + tile + k.px(40) + titleH + k.px(12) + Math.round(bodyLines * bodySize * 1.42) + pad;
      const headH = kicker.box.height + k.px(16) + title.box.height;
      const headGap = k.px(64);
      const top = Math.round((k.H - (headH + headGap + rows * cellH + (rows - 1) * gap)) / 2);
      kicker.box.y = top;
      title.box.y = top + kicker.box.height + k.px(16);
      const parts: Part[] = [kicker, title];
      const step = Math.max(3, Math.round(k.stagger * 1.5));
      items.forEach((it, i) => {
        const col = i % cols;
        const row = Math.floor(i / cols);
        const cx = x0 + col * (cellW + gap);
        const cy = top + headH + headGap + row * (cellH + gap);
        const then = (frames: number) => ({ start: 0.5, startFrames: i * step + frames });
        const textY = cy + pad + tile + k.px(40);
        parts.push({ type: 'shape', name: `Card ${i + 1}`, box: { x: cx, y: cy, width: cellW, height: cellH }, props: { shape: 'rect', fill: k.style.surface, stroke: k.style.faint, strokeWidth: k.px(1.5), cornerRadius: k.px(22) }, ...then(0), motion: [{ preset: 'riseIn', intensity: 0.8, seconds: 0.6 }] });
        parts.push({ type: 'shape', name: `Card ${i + 1} tile`, box: { x: cx + pad, y: cy + pad, width: tile, height: tile }, props: { shape: 'rect', fill: rgba(k.style.accent, 0.16), stroke: rgba(k.style.accent, 0.4), strokeWidth: k.px(1.5), cornerRadius: k.px(16) }, ...then(FOLLOW), motion: [{ preset: 'popIn', intensity: 0.6, seconds: 0.5 }] });
        parts.push({ ...textPart(k, `Card ${i + 1} number`, String(i + 1).padStart(2, '0'), { x: cx + pad, y: cy + pad + Math.round((tile - k.px(24) * 1.2) / 2), width: tile }, { size: k.px(24), weight: 600, color: k.style.accent, font: k.style.monoFont, align: 'center', lineHeight: 1.2 }), ...then(FOLLOW), motion: [{ preset: 'popIn', intensity: 0.6, seconds: 0.5 }] });
        parts.push({ ...textPart(k, `Card ${i + 1} title`, it.title, { x: cx + pad, y: textY, width: cellW - 2 * pad }, { size: titleSize, weight: 600, lineHeight: 1.18 }), ...then(FOLLOW * 2), motion: [{ preset: 'riseIn', intensity: 0.4, seconds: 0.5 }] });
        parts.push({ ...textPart(k, `Card ${i + 1} text`, it.body, { x: cx + pad, y: textY + titleH + k.px(12), width: cellW - 2 * pad }, { size: bodySize, weight: 400, color: k.style.muted, lineHeight: 1.42 }), ...then(FOLLOW * 3), motion: [{ preset: 'fadeIn', seconds: 0.5 }] });
      });
      return { parts, push: { at: 0.5 + (n * step + FOLLOW * 3) / k.project.fps + 0.3, scale: 1.03, focus: { x: k.W / 2, y: k.H / 2 } } };
    },
  },

  beforeAfter: {
    id: 'beforeAfter',
    label: 'Before / after',
    description: 'Two panels: the cluttered before arrives, then the clean after wipes on beside it while the before steps back.',
    seconds: 5,
    params: {
      before: { type: 'text', doc: 'the before statement' },
      after: { type: 'text', doc: 'the after statement' },
      beforeLabel: { type: 'text', doc: 'label on the before panel' },
      afterLabel: { type: 'text', doc: 'label on the after panel' },
    },
    design(p, k) {
      const gap = k.px(40);
      const stacked = k.portrait;
      const panelW = stacked ? k.W - 2 * k.m : Math.round((Math.min(k.W - 2 * k.m, k.px(1640)) - gap) / 2);
      const panelH = stacked ? Math.min(k.px(700), Math.round((k.H - 2 * k.m - gap) / 2)) : Math.min(k.H - 2 * k.m, k.px(600));
      const x0 = stacked ? k.m : Math.round((k.W - (2 * panelW + gap)) / 2);
      const y0 = stacked ? Math.round((k.H - (2 * panelH + gap)) / 2) : Math.round((k.H - panelH) / 2);
      const boxes = [
        { x: x0, y: y0, width: panelW, height: panelH },
        stacked ? { x: x0, y: y0 + panelH + gap, width: panelW, height: panelH } : { x: x0 + panelW + gap, y: y0, width: panelW, height: panelH },
      ];
      const pad = k.px(52);
      const reveal = 1.4;
      const dim = (start: number): TimedKey[] => [
        { track: 'opacity', s: reveal - start, value: 1, easing: 'easeInOut' },
        { track: 'opacity', s: reveal - start + 0.5, value: 0.55 },
      ];
      const parts: Part[] = [];
      const sides = [
        { key: 'Before', label: str(p, 'beforeLabel', 'BEFORE'), text: str(p, 'before', 'Six standups and forty PR threads'), colour: k.style.muted, labelColour: k.style.muted, fill: rgba(k.style.text, 0.04), stroke: k.style.faint },
        { key: 'After', label: str(p, 'afterLabel', 'AFTER'), text: str(p, 'after', 'One brief, read in two minutes'), colour: k.style.text, labelColour: k.style.accent, fill: k.style.surface, stroke: k.style.accent },
      ];
      const textSize = Math.min(...sides.map((side) => fitSize(side.text, k.px(stacked ? 68 : 64), k.px(40), panelW - 2 * pad, 3)));
      sides.forEach((side, i) => {
        const box = boxes[i];
        const before = i === 0;
        const t0 = before ? 0 : reveal;
        const mask = before ? undefined : `${side.key} wipe`;
        const keysFor = (start: number) => (before ? dim(start) : []);
        if (mask) {
          parts.push({ type: 'shape', name: mask, box: { ...box, x: box.x - k.px(4), y: box.y - k.px(4), width: box.width + k.px(8), height: box.height + k.px(8) }, props: { shape: 'rect', fill: '#FFFFFF', stroke: 'none', strokeWidth: 0, cornerRadius: 0 }, start: t0, keys: stacked ? [{ track: 'y', s: 0, value: -box.height - k.px(8), easing: k.enter }, { track: 'y', s: 0.7, value: 0 }] : [{ track: 'x', s: 0, value: -box.width - k.px(8), easing: k.enter }, { track: 'x', s: 0.7, value: 0 }] });
        }
        parts.push({ type: 'shape', name: `${side.key} panel`, box, props: { shape: 'rect', fill: side.fill, stroke: side.stroke, strokeWidth: k.px(before ? 1.5 : 2), cornerRadius: k.px(24) }, start: t0, ...(mask ? { maskBy: mask } : { motion: [{ preset: 'riseIn', intensity: 0.6, seconds: 0.6 }] }), keys: keysFor(t0) });
        const label = textPart(k, `${side.key} label`, side.label, { x: box.x + pad, y: box.y + pad, width: box.width - 2 * pad }, eyebrow(k, side.labelColour, side.fill), { start: t0 + 0.15, motion: [{ preset: 'fadeIn', seconds: 0.4 }], keys: keysFor(t0 + 0.15), ...(mask ? { maskBy: mask } : {}) });
        const statement = textPart(k, `${side.key} text`, side.text, { x: box.x + pad, y: label.box.y + label.box.height + k.px(20), width: box.width - 2 * pad }, { size: textSize, font: k.style.displayFont, color: side.colour, lineHeight: 1.1, tracking: -k.px(1) }, { start: t0 + 0.2, startFrames: k.stagger, motion: [{ preset: 'riseIn', intensity: 0.5, seconds: 0.6 }], keys: keysFor(t0 + 0.2), ...(mask ? { maskBy: mask } : {}) });
        parts.push(label, statement);
        const floor = box.y + box.height - pad;
        if (before) {
          // Clutter: notes at odd angles, piling up.
          const notes = [
            { w: 0.7, x: 0, r: -2.5, a: 0.12 },
            { w: 0.48, x: 0.36, r: 3, a: 0.08 },
            { w: 0.62, x: 0.08, r: -1, a: 0.1 },
            { w: 0.42, x: 0.44, r: -4, a: 0.14 },
            { w: 0.55, x: 0.02, r: 1.5, a: 0.09 },
          ];
          const nh = k.px(30);
          const inner = box.width - 2 * pad;
          notes.forEach((note, j) => {
            const y = floor - (notes.length - j) * (nh + k.px(10)) + k.px(10);
            const startFrames = k.stagger * (j + 2);
            parts.push({ type: 'shape', name: `Before note ${j + 1}`, box: { x: box.x + pad + Math.round(inner * note.x), y, width: Math.round(inner * note.w), height: nh }, rotation: note.r, props: { shape: 'rect', fill: rgba(k.style.text, note.a), stroke: 'none', strokeWidth: 0, cornerRadius: k.px(8) }, start: 0.35, startFrames, motion: [{ preset: 'popIn', intensity: 0.4, seconds: 0.4 }], keys: dim(0.35 + startFrames / k.project.fps) });
          });
        } else {
          // One clean row: a check and a single line.
          const c = k.px(64);
          const rowY = floor - c;
          parts.push({ type: 'shape', name: 'After check', box: { x: box.x + pad, y: rowY, width: c, height: c }, props: { shape: 'ellipse', fill: k.style.accent, stroke: 'none', strokeWidth: 0, cornerRadius: 0 }, start: reveal + 0.45, startFrames: k.stagger, motion: [{ preset: 'overshootSettle', intensity: 0.7 }], maskBy: mask });
          const tick = [{ x: c * 0.28, y: c * 0.52 }, { x: c * 0.44, y: c * 0.68 }, { x: c * 0.73, y: c * 0.36 }];
          parts.push({ type: 'path', name: 'After tick', box: { x: box.x + pad, y: rowY, width: c, height: c }, props: pathProps(tick, false, k.style.onAccent, k.px(6), { lineCap: 'round' }), start: reveal + 0.6, startFrames: k.stagger, motion: [{ preset: 'wipeOn', seconds: 0.35 }], maskBy: mask });
          parts.push({ type: 'shape', name: 'After line', box: { x: box.x + pad + c + k.px(24), y: rowY + Math.round((c - k.px(26)) / 2), width: Math.round((box.width - 2 * pad - c - k.px(24)) * 0.62), height: k.px(26) }, props: { shape: 'rect', fill: rgba(k.style.text, 0.85), stroke: 'none', strokeWidth: 0, cornerRadius: k.px(8) }, start: reveal + 0.55, startFrames: k.stagger * 2, motion: [{ preset: 'fadeIn', seconds: 0.4 }], maskBy: mask });
        }
      });
      // The turn between them.
      const badge = k.px(88);
      const mid = stacked ? { x: Math.round(k.W / 2), y: y0 + panelH + Math.round(gap / 2) } : { x: x0 + panelW + Math.round(gap / 2), y: Math.round(k.H / 2) };
      const arrow = [{ x: badge * 0.3, y: badge * 0.5 }, { x: badge * 0.7, y: badge * 0.5 }];
      const head = [{ x: badge * 0.54, y: badge * 0.34 }, { x: badge * 0.7, y: badge * 0.5 }, { x: badge * 0.54, y: badge * 0.66 }];
      const badgeBox = { x: mid.x - Math.round(badge / 2), y: mid.y - Math.round(badge / 2), width: badge, height: badge };
      const turn = (nodes: { x: number; y: number }[]) => (stacked ? nodes.map((pt) => ({ x: badge - pt.y, y: pt.x })) : nodes);
      parts.push({ type: 'shape', name: 'Turn badge', box: badgeBox, props: { shape: 'ellipse', fill: k.style.text, stroke: k.style.background, strokeWidth: k.px(6), cornerRadius: 0 }, start: reveal - 0.2, motion: [{ preset: 'overshootSettle', intensity: 0.8 }] });
      parts.push({ type: 'path', name: 'Turn arrow', box: badgeBox, props: pathProps(turn(arrow), false, k.style.background, k.px(5)), start: reveal - 0.1, motion: [{ preset: 'wipeOn', seconds: 0.3 }] });
      parts.push({ type: 'path', name: 'Turn arrow head', box: badgeBox, props: pathProps(turn(head), false, k.style.background, k.px(5)), start: reveal, motion: [{ preset: 'wipeOn', seconds: 0.25 }] });
      // After the turn, the camera leans into the after panel.
      return { parts, push: { at: reveal + 0.9, scale: 1.03, focus: { x: boxes[1].x + boxes[1].width / 2, y: boxes[1].y + boxes[1].height / 2 } } };
    },
  },

  statReveal: {
    id: 'statReveal',
    label: 'Stat / pricing reveal',
    description: 'A huge number rises from behind a mask over a rule and a label, with a chip for the delta or the deal. Works for prices.',
    seconds: 4,
    params: {
      value: { type: 'text', doc: 'the number or price, e.g. "12 h", "$29"' },
      kicker: { type: 'text', doc: 'small accent label' },
      label: { type: 'text', doc: 'what the number means' },
      chip: { type: 'text', doc: 'the delta or the deal' },
    },
    design(p, k) {
      const value = str(p, 'value', '12 h');
      const width = Math.min(k.W - 2 * k.m, k.px(1400));
      const x = Math.round((k.W - width) / 2);
      const kickerStyle = { ...eyebrow(k), align: 'center' as const, tracking: k.px(5), trackFrom: k.px(16) };
      const kicker = textPart(k, 'Kicker', str(p, 'kicker', 'THE RESULT'), { x, y: 0, width }, kickerStyle, { motion: [{ preset: 'fadeIn', seconds: 0.5 }], keys: [{ prop: 'props.letterSpacing', s: 0, value: kickerStyle.trackFrom, easing: k.enter }, { prop: 'props.letterSpacing', s: 0.9, value: kickerStyle.tracking }] });
      const vSize = fitSize(value, Math.min(400, k.px(k.portrait ? 260 : 300)), Math.min(400, k.px(120)), width, 1);
      const vBox = Math.round(vSize * 1.08);
      const labelText = str(p, 'label', 'saved per engineer, every week');
      const label = textPart(k, 'Label', labelText, { x, y: 0, width }, { size: fitSize(labelText, k.px(48), k.px(32), width, 2), weight: 500, align: 'center', lineHeight: 1.2 }, { start: 0.6, motion: [{ preset: 'riseIn', intensity: 0.5, seconds: 0.6 }] });
      const chipText = str(p, 'chip', '+38% read rate');
      const chipSize = k.px(30);
      const chipH = Math.round(chipSize * 2);
      const chipW = Math.round(chipText.length * chipSize * 0.58 + k.px(56));
      const ruleW = k.px(96);
      const gaps = { kicker: k.px(20), rule: k.px(28), label: k.px(28), chip: k.px(40) };
      const total = kicker.box.height + gaps.kicker + vBox + gaps.rule + k.px(5) + gaps.label + label.box.height + gaps.chip + chipH;
      let y = Math.round((k.H - total) / 2);
      kicker.box.y = y;
      y += kicker.box.height + gaps.kicker;
      const valueBox = { x, y, width, height: vBox };
      y += vBox + gaps.rule;
      const rule = { x: Math.round((k.W - ruleW) / 2), y, width: ruleW, height: k.px(5) };
      y += k.px(5) + gaps.label;
      label.box.y = y;
      y += label.box.height + gaps.chip;
      const chip = { x: Math.round((k.W - chipW) / 2), y, width: chipW, height: chipH };
      return {
        parts: [
          kicker,
          { type: 'shape', name: 'Value mask', box: valueBox, props: { shape: 'rect', fill: '#FFFFFF', stroke: 'none', strokeWidth: 0, cornerRadius: 0 }, start: 0.15 },
          { ...textPart(k, 'Value', value, valueBox, { size: vSize, font: k.style.displayFont, align: 'center', lineHeight: 1, tracking: -Math.round(vSize * 0.03) }), box: valueBox, start: 0.15, maskBy: 'Value mask', keys: [{ track: 'y', s: 0, value: vBox, easing: k.enter }, { track: 'y', s: 0.8, value: 0 }] },
          { type: 'path', name: 'Rule', box: rule, props: pathProps([{ x: 0, y: rule.height / 2 }, { x: ruleW, y: rule.height / 2 }], false, k.style.accent, rule.height, { lineCap: 'butt' }), start: 0.5, motion: [{ preset: 'wipeOn', seconds: 0.5 }] },
          label,
          { type: 'shape', name: 'Chip', box: chip, props: { shape: 'rect', fill: rgba(k.style.accent2, 0.16), stroke: k.style.accent2, strokeWidth: k.px(2), cornerRadius: Math.round(chipH / 2) }, start: 0.9, motion: pillIn(0.6) },
          { ...textPart(k, 'Chip text', chipText, { x: chip.x, y: chip.y + Math.round((chipH - chipSize * 1.2) / 2), width: chip.width }, { size: chipSize, weight: 600, color: k.style.accent2, align: 'center', lineHeight: 1.2 }), start: 0.9, motion: pillIn(0.6) },
        ],
        push: { at: 1.4, scale: 1.03, focus: { x: k.W / 2, y: valueBox.y + valueBox.height / 2 } },
      };
    },
  },

  testimonial: {
    id: 'testimonial',
    label: 'Testimonial',
    description: 'A large quote mark pops, the quote rises in word by word, then the person arrives: avatar, name, role.',
    seconds: 6,
    params: {
      quote: { type: 'text', doc: 'the quote' },
      name: { type: 'text', doc: 'who said it' },
      role: { type: 'text', doc: 'their role and company' },
      initials: { type: 'text', doc: 'avatar initials (default: from the name)' },
    },
    design(p, k) {
      const quote = str(p, 'quote', 'Our Monday status meeting is now a two-minute read. Nobody misses it.');
      const name = str(p, 'name', 'Maya Kerr');
      const role = str(p, 'role', 'Engineering Manager, Northwind');
      const initials = str(p, 'initials', name.split(/\s+/).map((w) => w[0] ?? '').join('').slice(0, 2).toUpperCase());
      const width = Math.min(k.W - 2 * k.m, k.px(1360));
      const x = Math.round((k.W - width) / 2);
      const markSize = Math.min(400, k.px(240));
      const markBox = { x: x - Math.round(markSize * 0.04), y: 0, width: Math.round(markSize * 0.6), height: Math.round(markSize * 0.5) };
      const quoteSize = fitSize(quote, k.px(k.portrait ? 76 : 88), k.px(46), width, k.portrait ? 6 : 3);
      const words = quote.split(/\s+/).length;
      const body = textPart(k, 'Quote', quote, { x, y: 0, width }, { size: quoteSize, font: k.style.displayFont, weight: 500, lineHeight: 1.16, tracking: -k.px(1), balance: true }, { start: 0.25 });
      body.props = { ...body.props, reveal: 'wordStagger', revealDurationInFrames: Math.min(300, Math.round(k.project.fps * Math.min(1.6, 0.5 + words * 0.06))) };
      const avatar = k.px(96);
      const rowGap = k.px(56);
      const total = markBox.height + k.px(8) + body.box.height + rowGap + avatar;
      const top = Math.round((k.H - total) / 2);
      markBox.y = top;
      body.box.y = top + markBox.height + k.px(8);
      const rowY = body.box.y + body.box.height + rowGap;
      // The person arrives as the last words land (overlap), not after a gap.
      const after = 0.25 + (0.6 * Number(body.props.revealDurationInFrames)) / k.project.fps;
      const textX = x + avatar + k.px(28);
      return {
        parts: [
          { ...textPart(k, 'Quote mark', '“', markBox, { size: markSize, font: 'Fraunces', weight: 600, color: k.style.accent, lineHeight: 1 }), box: markBox, motion: [{ preset: 'overshootSettle', intensity: 0.8 }] },
          body,
          { type: 'shape', name: 'Avatar', box: { x, y: rowY, width: avatar, height: avatar }, props: { shape: 'ellipse', fill: k.style.accent2, stroke: 'none', strokeWidth: 0, cornerRadius: 0 }, start: after, motion: [{ preset: 'popIn', intensity: 0.6, seconds: 0.5 }] },
          { ...textPart(k, 'Initials', initials, { x, y: rowY + Math.round((avatar - k.px(32) * 1.2) / 2), width: avatar }, { size: k.px(32), weight: 600, color: onColour(k.style.accent2), align: 'center', lineHeight: 1.2 }), start: after, motion: [{ preset: 'popIn', intensity: 0.6, seconds: 0.5 }] },
          textPart(k, 'Name', name, { x: textX, y: rowY + k.px(8), width: width - avatar - k.px(28) }, { size: k.px(36), weight: 600, lineHeight: 1.2 }, { start: after, startFrames: k.stagger, motion: [{ preset: 'riseIn', intensity: 0.4, seconds: 0.5 }] }),
          textPart(k, 'Role', role, { x: textX, y: rowY + k.px(8) + Math.round(k.px(36) * 1.25), width: width - avatar - k.px(28) }, { size: k.px(30), weight: 400, color: k.style.muted, lineHeight: 1.3 }, { start: after, startFrames: k.stagger * 2, motion: [{ preset: 'riseIn', intensity: 0.4, seconds: 0.5 }] }),
        ],
        push: { at: after + 0.6, scale: 1.03, focus: { x: k.W / 2, y: body.box.y + body.box.height / 2 } },
      };
    },
  },

  logoSting: {
    id: 'logoSting',
    label: 'Logo sting',
    description: 'End card: the logo lands on a glow in the first frames while a ring draws round it as an accent; when the ring closes it bursts and the logo hits, the tagline and an optional button (`cta`) land right behind it, and the card holds alive under a slow push.',
    seconds: 3,
    params: {
      logoAssetId: { type: 'asset', kinds: ['svg', 'image'], doc: 'the logo (default: the first SVG)' },
      wordmark: { type: 'text', doc: 'text logo instead of a file (default: the project name)' },
      tagline: { type: 'text', doc: 'line under the logo' },
      cta: { type: 'text', doc: 'button label under the tagline' },
    },
    design(p, k) {
      // A logo file only when one is named or the project has an SVG; raster images are usually screenshots.
      const chosen = typeof p.logoAssetId === 'string' ? k.project.assets[p.logoAssetId] : typeof p.wordmark === 'string' ? undefined : assetsOf(k.project, ['svg'])[0];
      const cta = str(p, 'cta', '');
      const cx = Math.round(k.W / 2);
      const cy = Math.round(k.H / 2 - k.px(cta ? 90 : 36));
      const slot = { width: Math.min(k.W - 2 * k.m, k.px(520)), height: k.px(150) };
      // The card reads from its first frames: the logo lands at once (opaque within ~5 f) and the ring draws round it as
      // the accent; when the ring closes, the rays burst and the logo hits on that frame (holdHit starts one frame early).
      const hit = 0.55;
      const logoMotion: Motion[] = [{ preset: 'overshootSettle', intensity: 0.5, seconds: 0.45 }, { preset: 'holdHit', at: hit - 1 / k.project.fps, intensity: 0.6 }];
      let logo: Part;
      if (chosen && (chosen.kind === 'svg' || chosen.kind === 'image')) {
        const box = containBox({ x: cx - Math.round(slot.width / 2), y: cy - Math.round(slot.height / 2), ...slot }, chosen);
        logo = chosen.kind === 'svg'
          ? { type: 'logo', name: 'Logo', box, props: { assetId: chosen.id, fit: 'contain' }, motion: logoMotion }
          : { type: 'image', name: 'Logo', box, props: { assetId: chosen.id, fit: 'contain', cornerRadius: 0, shadow: false }, motion: logoMotion };
      } else {
        const word = str(p, 'wordmark', k.project.name || 'Brand');
        const size = fitSize(word, k.px(120), k.px(56), slot.width, 1);
        logo = { ...textPart(k, 'Wordmark', word, { x: cx - Math.round(slot.width / 2), y: 0, width: slot.width }, { size, font: k.style.displayFont, align: 'center', tracking: -k.px(1), lineHeight: 1.1 }), motion: logoMotion };
        logo.box.y = cy - Math.round(logo.box.height / 2);
      }
      const reach = Math.min(k.W, k.H) - 2 * k.px(40);
      const ring = Math.min(Math.round(Math.max(logo.box.width, logo.box.height) * 1.3), reach - 2 * k.px(140));
      const ringBox = { x: cx - Math.round(ring / 2), y: cy - Math.round(ring / 2), width: ring, height: ring };
      const r1 = ring / 2 + k.px(30);
      const r2 = r1 + k.px(110);
      const burst = Math.round(2 * r2);
      const burstBox = { x: cx - Math.round(burst / 2), y: cy - Math.round(burst / 2), width: burst, height: burst };
      const parts: Part[] = [
        {
          type: 'path',
          name: 'Ring',
          box: ringBox,
          props: pathProps(circleNodes(ring, k.px(3)), true, k.style.accent, k.px(5)),
          motion: [{ preset: 'wipeOn', seconds: hit }],
          keys: [
            { track: 'scale', s: hit, value: 1, easing: 'easeOutCubic' },
            { track: 'scale', s: hit + 0.7, value: 1.45 },
            { track: 'opacity', s: hit + 0.1, value: 1, easing: 'easeIn' },
            { track: 'opacity', s: hit + 0.7, value: 0 },
          ],
        },
      ];
      const rays = 12;
      for (let i = 0; i < rays; i++) {
        const a = (i / rays) * Math.PI * 2 - Math.PI / 2;
        const c = burst / 2;
        parts.push({
          type: 'path',
          name: `Ray ${i + 1}`,
          box: burstBox,
          props: pathProps([{ x: c + r1 * Math.cos(a), y: c + r1 * Math.sin(a) }, { x: c + r2 * Math.cos(a), y: c + r2 * Math.sin(a) }], false, i % 2 ? k.style.accent2 : k.style.accent, k.px(6), { trimEnd: 0 }),
          start: hit,
          startFrames: Math.round(i / 3),
          keys: [
            { prop: 'props.trimEnd', s: 0, value: 0, easing: 'easeOutCubic' },
            { prop: 'props.trimEnd', s: 0.22, value: 1 },
            { prop: 'props.trimStart', s: 0.1, value: 0, easing: 'easeInOutCubic' },
            { prop: 'props.trimStart', s: 0.4, value: 1 },
          ],
        });
      }
      // The glow lands with the logo (never an empty glow waiting for its hero).
      parts.unshift(glowPart(k, 'Logo glow', logo.box, k.style.accent, { alpha: 0.5, spread: 0.9, seconds: 0.45 }));
      parts.push(logo);
      const tagline = str(p, 'tagline', 'Your week, in two minutes');
      const tw = Math.min(k.W - 2 * k.m, k.px(1200));
      const tag = textPart(k, 'Tagline', tagline, { x: Math.round((k.W - tw) / 2), y: logo.box.y + logo.box.height + k.px(56), width: tw }, { size: k.px(cta ? 40 : 36), weight: 500, color: cta ? k.style.text : k.style.muted, align: 'center', trackFrom: k.px(8) }, { start: hit + 0.2, motion: [{ preset: 'fadeIn', seconds: 0.6 }], keys: [{ prop: 'props.letterSpacing', s: 0, value: k.px(8), easing: k.enter }, { prop: 'props.letterSpacing', s: 1, value: 0 }] });
      parts.push(tag);
      if (cta) parts.push(...buttonParts(k, cta, { cx, y: tag.box.y + tag.box.height + k.px(40) }, { start: hit + 0.45 }));
      return { parts, push: { at: hit + 1, scale: 1.03, focus: { x: cx, y: cy } } };
    },
  },

  wordSwap: {
    id: 'wordSwap',
    label: 'Word swap',
    description: 'A lead line holds while the word under it rolls through wrong answers like a slot machine, each rising through a masked window, and lands on the last (`words`, one per line) in the accent; an underline draws under the answer and it hits.',
    seconds: 4.5,
    params: {
      lead: { type: 'text', doc: 'the line that stays (e.g. "Your weekly update, written")' },
      words: { type: 'text', doc: '2–5 options, one per line; the last is the answer' },
      kicker: { type: 'text', doc: 'small accent label above' },
    },
    design(p, k) {
      const x = k.portrait ? k.m : k.m + k.px(48);
      const width = k.W - 2 * x;
      const lead = str(p, 'lead', 'Your weekly update, written');
      const words = str(p, 'words', 'by hand\nat midnight\non Friday\nfor you').split('\n').map((w) => w.trim()).filter(Boolean).slice(0, 5);
      const leadSize = fitSize(lead, k.px(k.portrait ? 72 : 84), k.px(44), width, 2);
      const wordSize = Math.min(...words.map((w) => fitSize(w, k.px(k.portrait ? 150 : 190), k.px(64), width, 1)));
      const lineBox = Math.round(wordSize * 1.2);
      const kickerStyle = { ...eyebrow(k), tracking: k.px(5), lineHeight: 1.2 };
      const kicker = textPart(k, 'Kicker', str(p, 'kicker', 'THE NEW WAY'), { x, y: 0, width }, kickerStyle, { start: 0, motion: [{ preset: 'fadeIn', seconds: 0.4 }] });
      const leadPart = textPart(k, 'Lead', lead, { x, y: 0, width }, { size: leadSize, font: k.style.displayFont, lineHeight: 1.1, tracking: -Math.round(leadSize * 0.02) }, { start: 0.1, motion: [{ preset: 'riseIn', intensity: 0.5, seconds: 0.5 }] });
      const gap = k.px(28);
      const top = Math.round((k.H - (kicker.box.height + gap + leadPart.box.height + k.px(12) + lineBox)) / 2);
      kicker.box.y = top;
      leadPart.box.y = top + kicker.box.height + gap;
      const window: Box = { x, y: leadPart.box.y + leadPart.box.height + k.px(12), width, height: lineBox };
      const parts: Part[] = [kicker, leadPart, { type: 'shape', name: 'Word window', box: window, props: { shape: 'rect', fill: '#FFFFFF', stroke: 'none', strokeWidth: 0, cornerRadius: 0 }, start: 0.5 }];
      // Each wrong word dwells a beat shorter than the last, so the roll accelerates into the answer.
      let t = 0.6;
      words.forEach((w, i) => {
        const last = i === words.length - 1;
        const dwell = Math.max(0.22, 0.42 - i * 0.06);
        const travel = 0.16;
        const keys: TimedKey[] = [{ track: 'y', s: 0, value: lineBox, easing: k.enter }, { track: 'y', s: travel, value: 0 }];
        if (!last) keys.push({ track: 'y', s: travel + dwell, value: 0, easing: k.exit }, { track: 'y', s: travel * 2 + dwell, value: -lineBox });
        parts.push({ ...textPart(k, `Word ${i + 1}`, w, window, { size: wordSize, font: k.style.displayFont, color: last ? k.style.accent : k.style.muted, lineHeight: 1.1, tracking: -Math.round(wordSize * 0.03) }), box: window, start: t, maskBy: 'Word window', keys, ...(last ? { motion: [{ preset: 'holdHit', at: travel + 0.02, intensity: 0.5 }] } : {}) });
        if (last) {
          const lineW = Math.min(width, Math.round(w.length * wordSize * 0.47));
          parts.push({ type: 'path', name: 'Answer underline', box: { x, y: window.y + lineBox - k.px(4), width: lineW, height: k.px(10) }, props: pathProps([{ x: 0, y: k.px(5) }, { x: lineW, y: k.px(5) }], false, k.style.accent, k.px(8)), start: t + travel + 0.1, motion: [{ preset: 'wipeOn', seconds: 0.35 }] });
        }
        t += travel + dwell;
      });
      return { parts, push: { at: 0.4, scale: 1.03, focus: { x: x + width / 3, y: window.y } } };
    },
  },

  checklistStrike: {
    id: 'checklistStrike',
    label: 'Checklist strike',
    description: 'A list of chores lands line by line; a pen line strikes each through in turn while it dims, and the last item survives, ringed by a hand-drawn loop in the accent (`items`, one per line).',
    seconds: 5,
    params: {
      items: { type: 'text', doc: '3–5 items, one per line; the last one survives' },
      title: { type: 'text', doc: 'small label above the list' },
    },
    design(p, k) {
      const items = str(p, 'items', 'Chase status in six threads\nCopy notes into a doc\nRewrite it for leadership\nShip the work').split('\n').map((s) => s.trim()).filter(Boolean).slice(0, 5);
      const width = Math.min(k.W - 2 * k.m, k.px(1240));
      const x = Math.round((k.W - width) / 2);
      const size = Math.min(...items.map((s) => fitSize(s, k.px(k.portrait ? 64 : 72), k.px(40), width - k.px(60), 1)));
      const row = Math.round(size * 1.55);
      const title = textPart(k, 'Title', str(p, 'title', 'FRIDAY, BEFORE'), { x, y: 0, width }, eyebrow(k), { motion: [{ preset: 'fadeIn', seconds: 0.4 }] });
      const gap = k.px(32);
      const top = Math.round((k.H - (title.box.height + gap + items.length * row)) / 2);
      title.box.y = top;
      const parts: Part[] = [title];
      const strikeStart = 0.35 + (items.length * k.stagger * 2) / k.project.fps + 0.35;
      items.forEach((text, i) => {
        const y = top + title.box.height + gap + i * row;
        const last = i === items.length - 1;
        const textW = Math.min(width - k.px(60), Math.round(text.length * size * 0.5));
        const strikeAt = strikeStart + i * 0.32;
        parts.push({
          ...textPart(k, `Item ${i + 1}`, text, { x: x + k.px(30), y, width: width - k.px(60) }, { size, weight: last ? 700 : 600, color: k.style.text, lineHeight: 1.2 }),
          start: 0.35,
          startFrames: i * k.stagger * 2,
          motion: [{ preset: 'riseIn', intensity: 0.4, seconds: 0.45 }, ...(last ? [{ preset: 'holdHit' as PresetId, at: strikeAt - 0.35 + 0.15, intensity: 0.5 }] : [])],
          ...(last ? {} : { keys: [{ track: 'opacity' as const, s: strikeAt - 0.35, value: 1, easing: k.exit }, { track: 'opacity' as const, s: strikeAt - 0.35 + 0.25, value: 0.38 }] }),
        });
        if (!last) {
          parts.push({ type: 'path', name: `Strike ${i + 1}`, box: { x: x + k.px(20), y: y + Math.round(size * 0.62), width: textW + k.px(20), height: k.px(8) }, props: pathProps([{ x: 0, y: k.px(5) }, { x: textW + k.px(20), y: k.px(3) }], false, k.style.text, k.px(5)), start: strikeAt, motion: [{ preset: 'wipeOn', seconds: 0.22 }] });
        } else {
          const ringW = textW + k.px(80);
          const ringH = Math.round(size * 1.6);
          parts.push({ type: 'path', name: 'Survivor ring', box: { x: x - k.px(10), y: y - Math.round(size * 0.18), width: ringW, height: ringH }, rotation: -1.5, props: pathProps(roundedRectNodes(ringW, ringH, ringH / 2), true, k.style.accent, k.px(6)), start: strikeAt, motion: [{ preset: 'wipeOn', seconds: 0.5 }] });
        }
      });
      return { parts, push: { at: 0.6, scale: 1.03, focus: { x: k.W / 2, y: k.H / 2 } } };
    },
  },

  queryResults: {
    id: 'queryResults',
    label: 'Query results',
    description: 'A search field rises, a question types itself in, the field takes the hit of Enter, and answer rows cascade out of it, each a plate with a numbered title and a muted line (`results`, one per line as "Title: line"). A product demo without a screenshot.',
    seconds: 5.5,
    params: {
      query: { type: 'text', doc: 'what gets typed' },
      results: { type: 'text', doc: '2–4 rows, one per line as "Title: one line"' },
    },
    design(p, k) {
      const query = str(p, 'query', 'what did the platform team ship this week?');
      const rows = str(p, 'results', 'SSO is live: rolled out to every workspace\n12 bugs fixed: three of them customer-reported\nBilling starts Monday: pricing page is ready').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4).map((l) => {
        const i = l.indexOf(':');
        return i > 0 ? { title: l.slice(0, i).trim(), body: l.slice(i + 1).trim() } : { title: l, body: '' };
      });
      const width = Math.min(k.W - 2 * k.m, k.px(1280));
      const x = Math.round((k.W - width) / 2);
      const fieldH = k.px(104);
      const rowH = k.px(118);
      const rowGap = k.px(14);
      const total = fieldH + k.px(28) + rows.length * (rowH + rowGap) - rowGap;
      const top = Math.round((k.H - total) / 2);
      const typeSeconds = Math.min(1.4, 0.35 + query.length * 0.028);
      const enter = 0.45 + typeSeconds + 0.15;
      const field: Box = { x, y: top, width, height: fieldH };
      const icon = k.px(34);
      const parts: Part[] = [
        { type: 'shape', name: 'Field', box: field, props: { shape: 'rect', fill: k.style.surface, stroke: k.style.faint, strokeWidth: k.px(2), cornerRadius: Math.round(fieldH / 2) }, motion: [{ preset: 'riseIn', intensity: 0.5, seconds: 0.45 }, { preset: 'holdHit', at: enter, intensity: 0.4 }] },
        { type: 'path', name: 'Search lens', box: { x: x + k.px(38), y: top + Math.round((fieldH - icon) / 2), width: icon, height: icon }, props: pathProps(circleNodes(icon, k.px(6)), true, k.style.muted, k.px(4)), start: 0.15, motion: [{ preset: 'wipeOn', seconds: 0.35 }] },
        { ...textPart(k, 'Query', query, { x: x + k.px(96), y: top + Math.round((fieldH - k.px(44) * 1.3) / 2), width: width - k.px(140) }, { size: fitSize(query, k.px(44), k.px(30), width - k.px(140), 1), weight: 500, lineHeight: 1.25 }), start: 0.45, motion: [{ preset: 'typewriter', seconds: typeSeconds }] },
      ];
      rows.forEach((r, i) => {
        const y = top + fieldH + k.px(28) + i * (rowH + rowGap);
        const start = enter + 0.12;
        const timing = { start, startFrames: i * k.stagger * 2 };
        const pad = k.px(32);
        parts.push({ type: 'shape', name: `Row ${i + 1} plate`, box: { x, y, width, height: rowH }, props: { shape: 'rect', fill: k.style.surface, stroke: 'none', strokeWidth: 0, cornerRadius: k.px(18) }, ...timing, motion: [{ preset: 'riseIn', intensity: 0.4, seconds: 0.4 }] });
        parts.push({ ...textPart(k, `Row ${i + 1} number`, String(i + 1).padStart(2, '0'), { x: x + pad, y: y + k.px(26), width: k.px(60) }, { size: k.px(26), weight: 600, color: k.style.accent, font: k.style.monoFont }), ...timing, startFrames: timing.startFrames + FOLLOW, motion: [{ preset: 'fadeIn', seconds: 0.3 }] });
        parts.push({ ...textPart(k, `Row ${i + 1} title`, r.title, { x: x + pad + k.px(70), y: y + k.px(20), width: width - pad * 2 - k.px(70) }, { size: k.px(38), weight: 700, lineHeight: 1.15 }), ...timing, startFrames: timing.startFrames + FOLLOW, motion: [{ preset: 'riseIn', intensity: 0.3, seconds: 0.4 }] });
        if (r.body) parts.push({ ...textPart(k, `Row ${i + 1} line`, r.body, { x: x + pad + k.px(70), y: y + k.px(66), width: width - pad * 2 - k.px(70) }, { size: k.px(28), weight: 400, color: k.style.muted, lineHeight: 1.2 }), ...timing, startFrames: timing.startFrames + FOLLOW * 2, motion: [{ preset: 'fadeIn', seconds: 0.4 }] });
      });
      return { parts, push: { at: enter, scale: 1.035, focus: { x: k.W / 2, y: top + fieldH } } };
    },
  },

  splitReveal: {
    id: 'splitReveal',
    label: 'Split reveal',
    description: 'A headline lands whole, then its top and bottom halves part (each masked, moving in opposite directions) to open a gap where an accent plate pops with the reveal (`reveal`, e.g. the product name) and hits.',
    seconds: 4,
    params: {
      headline: { type: 'text', doc: '1–2 lines that split apart (two lines split between them)' },
      reveal: { type: 'text', doc: 'what the plate shows in the gap (default: the project name)' },
      kicker: { type: 'text', doc: 'small accent label above' },
    },
    design(p, k) {
      const width = Math.min(k.W - 2 * k.m, k.px(1500));
      const x = Math.round((k.W - width) / 2);
      const head = str(p, 'headline', 'Six standups.\nForty threads.').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 2).join('\n');
      const reveal = str(p, 'reveal', k.project.name || 'One page.');
      const lines = head.split('\n');
      const size = Math.min(...lines.map((l) => fitSize(l, k.px(k.portrait ? 120 : 150), k.px(56), width, 1)));
      const lineH = Math.round(size * 1.12);
      const headH = lineH * lines.length;
      const revealSize = fitSize(reveal, k.px(k.portrait ? 76 : 92), k.px(40), width - k.px(120), 1);
      const plateW = Math.min(width, Math.round(reveal.length * revealSize * 0.56) + k.px(120));
      const plateH = Math.round(revealSize * 1.6);
      const open = plateH + k.px(56);
      const top = Math.round(k.H / 2 - headH / 2);
      const split = 1.0;
      const travel = 0.45;
      const half = Math.round(headH / 2);
      const apart = Math.round(open / 2);
      const box: Box = { x, y: top, width, height: headH };
      const style = { size, font: k.style.displayFont, align: 'center' as const, lineHeight: 1.12, tracking: -Math.round(size * 0.025) };
      // Each half's mask travels with its text, so the cut edge stays sharp as they part.
      const keysFor = (to: number): TimedKey[] => [{ track: 'y', s: split, value: 0, easing: k.enter }, { track: 'y', s: split + travel, value: to }];
      const kicker = textPart(k, 'Kicker', str(p, 'kicker', 'ONE WEEK, TWO WAYS'), { x, y: 0, width }, { ...eyebrow(k), align: 'center' }, { start: 0, motion: [{ preset: 'fadeIn', seconds: 0.4 }], keys: [{ track: 'y', s: split + 0.1, value: 0, easing: k.enter }, { track: 'y', s: split + 0.1 + travel, value: -apart }] });
      kicker.box.y = top - kicker.box.height - k.px(28);
      const plate: Box = { x: Math.round((k.W - plateW) / 2), y: Math.round(k.H / 2 - plateH / 2), width: plateW, height: plateH };
      return {
        parts: [
          kicker,
          { type: 'shape', name: 'Top mask', box: { ...box, height: half }, props: { shape: 'rect', fill: '#FFFFFF', stroke: 'none', strokeWidth: 0, cornerRadius: 0 }, start: 0.1, keys: keysFor(-apart) },
          { type: 'shape', name: 'Bottom mask', box: { ...box, y: top + half, height: headH - half }, props: { shape: 'rect', fill: '#FFFFFF', stroke: 'none', strokeWidth: 0, cornerRadius: 0 }, start: 0.1, keys: keysFor(apart) },
          { ...textPart(k, 'Headline top', head, box, style), box, start: 0.1, maskBy: 'Top mask', motion: [{ preset: 'fadeIn', seconds: 0.35 }], keys: keysFor(-apart) },
          { ...textPart(k, 'Headline bottom', head, box, style), box, start: 0.1, maskBy: 'Bottom mask', motion: [{ preset: 'fadeIn', seconds: 0.35 }], keys: keysFor(apart) },
          { type: 'shape', name: 'Reveal plate', box: plate, props: { shape: 'rect', fill: k.style.accent, stroke: 'none', strokeWidth: 0, cornerRadius: k.px(16) }, start: split + 0.22, motion: [{ preset: 'popIn', intensity: 0.5, seconds: 0.4 }] },
          { ...textPart(k, 'Reveal', reveal, { x: plate.x, y: plate.y + Math.round((plateH - revealSize * 1.15) / 2), width: plateW }, { size: revealSize, font: k.style.displayFont, color: k.style.onAccent, align: 'center', lineHeight: 1.15, tracking: -k.px(1) }), start: split + 0.3, motion: [{ preset: 'popIn', intensity: 0.4, seconds: 0.35 }, { preset: 'holdHit', at: 0.3, intensity: 0.5 }] },
        ],
        push: { at: split + 0.5, scale: 1.03, focus: { x: k.W / 2, y: k.H / 2 } },
      };
    },
  },

  timelineScrub: {
    id: 'timelineScrub',
    label: 'Timeline scrub',
    description: 'A week laid out as a track with a dot per day draws on; a playhead sweeps it and each dot pops in the accent as it passes, a short result label rising above (`days`, one per line as "Day: result").',
    seconds: 5.5,
    params: {
      days: { type: 'text', doc: '3–7 stops, one per line as "Day: short result"' },
      title: { type: 'text', doc: 'headline above the track' },
    },
    design(p, k) {
      const days = str(p, 'days', 'Mon: Reads 214 threads\nTue: Drafts the update\nWed: Flags two blockers\nThu: Shares it in Slack\nFri: Update sent').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 7).map((l) => {
        const i = l.indexOf(':');
        return i > 0 ? { day: l.slice(0, i).trim(), result: l.slice(i + 1).trim() } : { day: l, result: '' };
      });
      const width = Math.min(k.W - 2 * k.m, k.px(1640));
      const x = Math.round((k.W - width) / 2);
      const n = days.length;
      // Labels sit centred on their stops, so the track is inset by half a label at each end.
      const gutter = k.px(24);
      const labelW = Math.max(k.px(100), Math.floor((width - (n - 1) * gutter) / n));
      const step = labelW + gutter;
      const trackX = x + Math.round(labelW / 2);
      const trackW = Math.max(1, Math.round(step * (n - 1)));
      const labelSize = Math.min(...days.map((d) => fitSize(d.result || ' ', k.px(k.portrait ? 34 : 44), k.px(24), labelW, 3)));
      const title = textPart(k, 'Title', str(p, 'title', 'Your week, already handled'), { x, y: 0, width }, { size: fitSize(str(p, 'title', 'Your week, already handled'), k.px(72), k.px(44), width, 2), font: k.style.displayFont, lineHeight: 1.1, tracking: -k.px(1) }, { start: 0, motion: [{ preset: 'riseIn', intensity: 0.5, seconds: 0.5 }] });
      const labelBlock = Math.round(labelSize * 1.25 * 3);
      const dot = k.px(26);
      const dayH = k.px(36);
      const total = title.box.height + k.px(56) + labelBlock + k.px(24) + dot + k.px(20) + dayH;
      const top = Math.round((k.H - total) / 2);
      title.box.y = top;
      const trackY = top + title.box.height + k.px(56) + labelBlock + k.px(24) + Math.round(dot / 2);
      const trackStart = 0.45;
      const sweepStart = trackStart + 0.55;
      const sweep = Math.min(2.6, 0.5 * n);
      const thick = k.px(4);
      const parts: Part[] = [
        title,
        { type: 'path', name: 'Track', box: { x: trackX, y: trackY - thick, width: trackW, height: thick * 2 }, props: pathProps([{ x: 0, y: thick }, { x: trackW, y: thick }], false, k.style.faint, thick), start: trackStart, motion: [{ preset: 'wipeOn', seconds: 0.5 }] },
        // The swept part of the track, filling behind the playhead.
        { type: 'path', name: 'Track fill', box: { x: trackX, y: trackY - thick, width: trackW, height: thick * 2 }, props: pathProps([{ x: 0, y: thick }, { x: trackW, y: thick }], false, k.style.accent, thick, { trimEnd: 0 }), start: sweepStart, keys: [{ prop: 'props.trimEnd', s: 0, value: 0, easing: 'easeInOutCubic' }, { prop: 'props.trimEnd', s: sweep, value: 1 }] },
      ];
      days.forEach((d, i) => {
        const cx = Math.round(n > 1 ? trackX + i * step : x + width / 2);
        // easeInOutCubic arrival time of the playhead at this stop.
        const f = n > 1 ? i / (n - 1) : 0.5;
        const pass = sweepStart + sweep * (f < 0.5 ? Math.cbrt(f / 4) : 1 - Math.cbrt((1 - f) / 4));
        const dotBox = { x: cx - Math.round(dot / 2), y: trackY - Math.round(dot / 2), width: dot, height: dot };
        parts.push({ type: 'shape', name: `${d.day} stop`, box: dotBox, props: { shape: 'ellipse', fill: k.style.background, stroke: k.style.faint, strokeWidth: k.px(3), cornerRadius: 0 }, start: trackStart, startFrames: i * k.stagger, motion: [{ preset: 'popIn', intensity: 0.4, seconds: 0.35 }] });
        parts.push({ type: 'shape', name: `${d.day} dot`, box: dotBox, props: { shape: 'ellipse', fill: k.style.accent, stroke: 'none', strokeWidth: 0, cornerRadius: 0 }, start: pass, motion: [{ preset: 'popIn', intensity: 0.8, seconds: 0.3 }] });
        parts.push({ ...textPart(k, `${d.day} label`, d.day.toUpperCase(), { x: cx - Math.round(labelW / 2), y: trackY + Math.round(dot / 2) + k.px(20), width: labelW }, { ...eyebrow(k, k.style.muted), align: 'center' }), start: trackStart, startFrames: i * k.stagger, motion: [{ preset: 'fadeIn', seconds: 0.4 }] });
        if (d.result) {
          const lab = textPart(k, `${d.day} result`, d.result, { x: cx - Math.round(labelW / 2), y: 0, width: labelW }, { size: labelSize, weight: 600, align: 'center', lineHeight: 1.25 }, { start: pass + 0.05, motion: [{ preset: 'riseIn', intensity: 0.4, seconds: 0.4 }] });
          lab.box.y = trackY - Math.round(dot / 2) - k.px(24) - lab.box.height;
          parts.push(lab);
        }
      });
      const headH = labelBlock + k.px(24) + dot + k.px(20);
      parts.push({ type: 'shape', name: 'Playhead', box: { x: trackX - k.px(2), y: trackY - Math.round(headH * 0.55), width: k.px(4), height: headH }, props: { shape: 'rect', fill: k.style.accent, stroke: 'none', strokeWidth: 0, cornerRadius: k.px(2) }, start: sweepStart, motion: [{ preset: 'fadeIn', seconds: 0.2 }], keys: [{ track: 'x', s: 0, value: 0, easing: 'easeInOutCubic' }, { track: 'x', s: sweep, value: trackW }] });
      return { parts, push: { at: sweepStart, scale: 1.03, focus: { x: k.W / 2, y: trackY } } };
    },
  },

  stampClose: {
    id: 'stampClose',
    label: 'Stamp close',
    description: 'End card: the name drops onto the frame like a stamp (1.3× to 1 in a few frames, then a hit) on a soft shadow, a shock ring spreads from the impact, and the web address slides out from under it (`url`), an optional line after.',
    seconds: 3.5,
    params: {
      wordmark: { type: 'text', doc: 'the name that stamps (default: the project name)' },
      url: { type: 'text', doc: 'web address that slides out beneath' },
      tagline: { type: 'text', doc: 'optional line under the address' },
    },
    design(p, k) {
      const word = str(p, 'wordmark', k.project.name || 'Brand');
      const width = Math.min(k.W - 2 * k.m, k.px(1400));
      const x = Math.round((k.W - width) / 2);
      const size = fitSize(word, k.px(k.portrait ? 150 : 180), k.px(64), width, 1);
      const nameH = Math.round(size * 1.15);
      const url = str(p, 'url', 'yourbrand.com');
      const urlSize = k.px(k.portrait ? 46 : 54);
      const urlH = Math.round(urlSize * 1.3);
      const tagline = str(p, 'tagline', '');
      const tagH = tagline ? Math.round(k.px(42) * 1.3) + k.px(20) : 0;
      const top = Math.round((k.H - (nameH + k.px(28) + urlH + tagH)) / 2);
      const nameBox: Box = { x, y: top, width, height: nameH };
      const impact = 0.2;
      const shadow = { x: 0, y: k.px(14), blur: k.px(28), color: rgba(k.style.text, 0.22) };
      const nameW = Math.min(width, Math.round(word.length * size * 0.56));
      const ring: Box = { x: Math.round((k.W - nameW) / 2) - k.px(40), y: top - k.px(24), width: nameW + k.px(80), height: nameH + k.px(48) };
      const urlWindow: Box = { x, y: top + nameH + k.px(28), width, height: urlH };
      const parts: Part[] = [
        { type: 'path', name: 'Shock ring', box: ring, props: pathProps(roundedRectNodes(ring.width, ring.height, k.px(24)), true, k.style.accent, k.px(4)), start: impact, keys: [{ track: 'opacity', s: 0, value: 0.9, easing: 'easeOutCubic' }, { track: 'opacity', s: 0.5, value: 0 }, { track: 'scale', s: 0, value: 1, easing: 'easeOutCubic' }, { track: 'scale', s: 0.5, value: 1.18 }] },
        {
          ...textPart(k, 'Name', word, nameBox, { size, font: k.style.displayFont, align: 'center', lineHeight: 1.15, tracking: -Math.round(size * 0.03) }),
          box: nameBox,
          effects: { dropShadow: shadow },
          // The stamp: it falls fast (accelerating) from 1.3× and stops dead on the impact frame, then hits.
          keys: [{ track: 'scale', s: 0, value: 1.3, easing: 'easeInCubic' }, { track: 'scale', s: impact, value: 1 }, { track: 'opacity', s: 0, value: 0, easing: 'easeOutCubic' }, { track: 'opacity', s: 0.08, value: 1 }],
          motion: [{ preset: 'holdHit', at: impact, intensity: 0.6 }],
        },
        { type: 'shape', name: 'Address window', box: urlWindow, props: { shape: 'rect', fill: '#FFFFFF', stroke: 'none', strokeWidth: 0, cornerRadius: 0 }, start: impact },
        { ...textPart(k, 'Address', url, urlWindow, { size: urlSize, weight: 500, color: k.style.muted, align: 'center', font: k.style.monoFont, lineHeight: 1.3 }), box: urlWindow, start: impact + 0.15, maskBy: 'Address window', keys: [{ track: 'y', s: 0, value: -urlH, easing: k.enter }, { track: 'y', s: 0.4, value: 0 }] },
      ];
      if (tagline) parts.push(textPart(k, 'Tagline', tagline, { x, y: urlWindow.y + urlH + k.px(20), width }, { size: k.px(42), weight: 500, align: 'center', lineHeight: 1.3 }, { start: impact + 0.5, motion: [{ preset: 'fadeIn', seconds: 0.5 }] }));
      return { parts, push: { at: impact + 0.4, scale: 1.03, focus: { x: k.W / 2, y: top + nameH / 2 } } };
    },
  },

  backdrop: {
    id: 'backdrop',
    label: 'Backdrop texture',
    description: 'A slow-moving background behind any scene, inserted under what is already there: `kind` lines (a scrolling column of document lines), grid (hairlines drifting diagonally) or glow (two accent glows breathing past each other); `side` right (default), left or full for the lines. Keeps a reading hold alive.',
    seconds: 6,
    params: {
      kind: { type: 'text', values: ['lines', 'grid', 'glow'], doc: 'the texture' },
      side: { type: 'text', values: ['right', 'left', 'full'], doc: 'where the lines column sits (default right; full in portrait)' },
    },
    design(p, k) {
      const kind = str(p, 'kind', 'lines');
      const side = str(p, 'side', k.portrait ? 'full' : 'right');
      const parts: Part[] = [];
      if (kind === 'glow') {
        const big = Math.round(Math.min(k.W, k.H) * 0.95);
        const small = Math.round(big * 0.6);
        const a = { x: Math.round(k.W * 0.58) - Math.round(big / 2), y: Math.round(k.H * 0.55) - Math.round(big / 2), width: big, height: big };
        const b = { x: Math.round(k.W * 0.22) - Math.round(small / 2), y: Math.round(k.H * 0.3) - Math.round(small / 2), width: small, height: small };
        const glow = (name: string, box: Box, colour: string, alpha: number, start: number): Part => ({
          type: 'shape',
          name,
          box,
          props: { shape: 'ellipse', fill: { type: 'radial', stops: [{ offset: 0, color: rgba(colour, alpha) }, { offset: 0.55, color: rgba(colour, alpha * 0.3) }, { offset: 1, color: rgba(colour, 0) }] }, stroke: 'none', strokeWidth: 0, cornerRadius: 0 },
          start,
          motion: [{ preset: 'fadeIn', seconds: 1 }],
        });
        parts.push(glow('Glow', a, k.style.accent, 0.32, 0), glow('Second glow', b, k.style.accent2, 0.2, 0.2));
        return { parts, behind: true, push: { at: 0, scale: 1.08, focus: { x: k.W * 0.5, y: k.H * 0.5 } }, drift: { x: -k.px(24), y: k.px(16) } };
      }
      if (kind === 'grid') {
        const pitch = k.px(120);
        const ink = rgba(k.style.text, 0.07);
        const cols = Math.ceil(k.W / pitch) + 1;
        const rows = Math.ceil(k.H / pitch) + 1;
        for (let i = 0; i < cols; i++) parts.push({ type: 'shape', name: `Column ${i + 1}`, box: { x: i * pitch, y: 0, width: k.px(1.5), height: k.H }, props: { shape: 'rect', fill: ink, stroke: 'none', strokeWidth: 0, cornerRadius: 0 }, startFrames: i, motion: [{ preset: 'fadeIn', seconds: 0.6 }] });
        for (let j = 0; j < rows; j++) parts.push({ type: 'shape', name: `Row ${j + 1}`, box: { x: 0, y: j * pitch, width: k.W, height: k.px(1.5) }, props: { shape: 'rect', fill: ink, stroke: 'none', strokeWidth: 0, cornerRadius: 0 }, startFrames: cols + j, motion: [{ preset: 'fadeIn', seconds: 0.6 }] });
        return { parts, behind: true, drift: { x: -Math.round(pitch * 0.25), y: -Math.round(pitch * 0.25) } };
      }
      // Lines: a column of document lines, like notes nobody read, typing on from the top and scrolling slowly up.
      const colW = side === 'full' ? k.W - 2 * k.m : Math.round(k.W * 0.3);
      const colX = side === 'full' ? k.m : side === 'left' ? k.m : k.W - k.m - colW;
      const pitch = k.px(40);
      const lineH = k.px(10);
      const rows = Math.floor((k.H - 2 * k.px(16)) / pitch);
      const top = Math.round((k.H - rows * pitch) / 2);
      for (let i = 0; i < rows; i++) {
        const paragraphEnd = noise(i, 1) < 0.22;
        const w = Math.round(colW * (paragraphEnd ? 0.3 + noise(i, 2) * 0.3 : 0.55 + noise(i, 3) * 0.45));
        const alpha = 0.05 + noise(i, 4) * 0.08;
        parts.push({ type: 'shape', name: `Line ${i + 1}`, box: { x: colX, y: top + i * pitch, width: w, height: lineH }, props: { shape: 'rect', fill: rgba(k.style.text, alpha), stroke: 'none', strokeWidth: 0, cornerRadius: Math.round(lineH / 2) }, startFrames: i, motion: [{ preset: 'fadeIn', seconds: 0.5 }] });
      }
      return { parts, behind: true, drift: { x: 0, y: -pitch } };
    },
  },
};

export const TEMPLATES: Record<TemplateId, TemplateDefinition> = Object.fromEntries(
  Object.values(DESIGNS).map(({ id, label, description, seconds, params }) => [id, { id, label, description, seconds, params }]),
) as Record<TemplateId, TemplateDefinition>;

export const TEMPLATE_IDS = Object.keys(DESIGNS) as TemplateId[];

/** `name (type): doc` for each of a template's parameters, common ones last. */
export function templateParamLines(id: TemplateId): string[] {
  return Object.entries({ ...TEMPLATES[id].params, ...COMMON_TEMPLATE_PARAMS }).map(([name, spec]) => {
    const type = spec.type === 'asset' ? `asset id: ${spec.kinds?.join('/') ?? 'any'}` : spec.values ? spec.values.join(' | ') : spec.type;
    return `${name} (${type}): ${spec.doc}`;
  });
}

/**
 * Why `params` cannot build template `id` in `project`, or null. Unknown
 * names, wrong types, enum values and asset ids are refused instead of
 * silently falling back to a default.
 */
export function templateParamError(id: TemplateId, params: Record<string, unknown>, project: Project): string | null {
  const def = TEMPLATES[id];
  if (!def) return `Unknown template "${id}". Templates: ${TEMPLATE_IDS.join(', ')}.`;
  const specs: Record<string, TemplateParamSpec> = { ...def.params, ...COMMON_TEMPLATE_PARAMS };
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    const spec = Object.prototype.hasOwnProperty.call(specs, name) ? specs[name] : undefined;
    if (!spec) return `${id} has no param "${name}". Its params: ${Object.keys(specs).join(', ')}.`;
    if (spec.type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) return `${id} param "${name}" must be a number, got ${JSON.stringify(value)}.`;
      continue;
    }
    if (typeof value !== 'string') return `${id} param "${name}" must be a string${spec.type === 'asset' ? ' (an asset id)' : ''}, got ${JSON.stringify(value)}.`;
    if (spec.values && !spec.values.includes(value)) return `${id} param "${name}" must be one of ${spec.values.join(', ')}, got "${value}".`;
    if (spec.type === 'asset') {
      const asset = Object.prototype.hasOwnProperty.call(project.assets, value) ? project.assets[value] : undefined;
      if (!asset) return `${id} param "${name}": asset ${value} is not in the project. Add it first (addAsset) or pick one of: ${Object.values(project.assets).filter((a) => spec.kinds?.includes(a.kind) ?? true).map((a) => `${a.id} "${a.name}" (${a.kind})`).join(', ') || 'none'}.`;
      if (spec.kinds && !spec.kinds.includes(asset.kind)) return `${id} param "${name}" needs an asset of kind ${spec.kinds.join(' or ')}; ${value} is ${asset.kind}.`;
      if (asset.reference) return `${id} param "${name}": ${value} is a reference asset, which is never placed in the video.`;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

/** Hold kept after the last arrival before a short scene starts compressing the motion. */
const MIN_HOLD_SECONDS = 0.8;

const PRESET_SECONDS = Object.fromEntries(Object.values(PRESETS).map((p) => [p.id, p.seconds])) as Record<PresetId, number>;

function union(boxes: Box[]): Box {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}

/**
 * Build a template for `ctx.sceneId`, starting `ctx.at` frames into the scene.
 * It lasts its designed length (or `params.seconds`: a longer hold, same
 * motion), or until the scene ends (timings compress). With a style pack,
 * part timings scale by its timingScale (inside that length). Refused for a
 * locked scene.
 */
export function buildTemplate(id: TemplateId, params: TemplateParams, ctx: TemplateContext): TemplateResult {
  const def = DESIGNS[id];
  const { project } = ctx;
  const scene = project.scenes.find((s) => s.id === ctx.sceneId);
  if (!scene) return { ok: false, code: 'NOT_FOUND', message: `Scene ${ctx.sceneId} not found.` };
  if (scene.locked) return { ok: false, code: 'LOCKED', message: `Scene "${scene.name}" is approved (locked). Unlock it to insert a ${def.label.toLowerCase()}.` };
  const at = Math.max(0, Math.round(ctx.at));
  // Inside a group: its chain's base offset (frame px) and scene start; the template ends when the group does.
  const host = { x: 0, y: 0, start: 0, end: scene.durationInFrames };
  if (ctx.parentId !== undefined) {
    const parent = scene.elements.find((e) => e.id === ctx.parentId);
    if (!parent || parent.type !== 'group') return { ok: false, code: 'NOT_FOUND', message: `${ctx.parentId} is not a group in scene "${scene.name}".` };
    const seen = new Set<string>();
    for (let e: Element | undefined = parent; e && !seen.has(e.id); e = scene.elements.find((x) => x.id === e!.parentId)) {
      seen.add(e.id);
      host.x += e.transform.x;
      host.y += e.transform.y;
      host.start += e.startFrame;
    }
    host.end = Math.min(host.end, host.start + parent.durationInFrames);
    if (at < host.start || at >= host.end) return { ok: false, code: 'INVALID', message: `Group "${parent.name}" plays from scene frame ${host.start} to ${host.end - 1}; start the template inside that range.` };
  }
  const designed = Math.max(1, Math.round(def.seconds * project.fps));
  const wanted = typeof params.seconds === 'number' && params.seconds > 0 ? Math.round(params.seconds * project.fps) : designed;
  const length = Math.min(wanted, host.end - at);
  if (length < 1) return { ok: false, code: 'INVALID', message: `Scene "${scene.name}" ends before frame ${at}.` };
  const style = projectStyle(project);
  const motion = style.motion;
  const timing = motion?.timingScale ?? 1;
  const u = Math.min(project.width, project.height) / 1080;
  const kit: Kit = {
    W: project.width,
    H: project.height,
    u,
    m: Math.round(96 * u),
    portrait: project.height > project.width * 1.05,
    style,
    project,
    px: (n) => Math.max(1, Math.round(n * u)),
    stagger: staggerFor(motion),
    enter: motion?.enter ?? 'easeOutCubic',
    exit: motion?.exit ?? 'easeInCubic',
  };
  const design = def.design(params, kit);
  // The choreography keeps its personality timing while it fits with a short
  // hold after the last arrival; only a scene too short for that compresses it.
  const arrived = Math.max(1, ...design.parts.map((part) => {
    const local = Math.max(0, ...(part.motion ?? []).map((mo) => (mo.at ?? 0) + (mo.seconds ?? PRESET_SECONDS[mo.preset])), ...(part.keys ?? []).map((k) => k.s));
    return ((part.start ?? 0) + local) * project.fps * timing + (part.startFrames ?? 0);
  }));
  const squeeze = Math.min(1, length / (arrived + Math.round(MIN_HOLD_SECONDS * project.fps)));
  /** Choreography seconds → frames: personality-scaled, squeezed into the scene. */
  const t = (seconds: number) => Math.round(seconds * project.fps * timing * squeeze);
  const makeId = ctx.newId ?? (() => newId('el'));
  const bounds = union(design.parts.map((part) => part.box));
  const groupId = makeId();
  const presetOptions = (mo: Motion, duration: number) => ({ at: t(mo.at ?? 0), duration, intensity: mo.intensity ?? 1, fps: project.fps, ...(motion ? { motion } : {}), ...(mo.overshoot !== undefined ? { overshoot: mo.overshoot } : {}) });

  const animate = (element: Element, part: Part) => {
    let el = (part.motion ?? []).reduce((acc, mo) => withPreset(acc, mo.preset, presetOptions(mo, Math.max(1, t(mo.seconds ?? PRESET_SECONDS[mo.preset])))), element);
    if (part.keys?.length) {
      const last = el.durationInFrames - 1;
      const keys = part.keys.map(({ s: seconds, ...k }) => ({ ...k, frame: Math.max(0, Math.min(last, t(seconds))) }) as PresetKey);
      el = withPlan(el, { keys });
    }
    return el;
  };

  const ids = new Map<string, string>();
  const children = design.parts.map((part): Element => {
    const startFrame = Math.min(t(part.start ?? 0) + Math.round((part.startFrames ?? 0) * squeeze), length - 1);
    const element: Element = {
      id: makeId(),
      type: part.type,
      name: part.name,
      startFrame,
      durationInFrames: length - startFrame,
      visible: true,
      transform: { x: Math.round(part.box.x - bounds.x), y: Math.round(part.box.y - bounds.y), width: Math.max(1, Math.round(part.box.width)), height: Math.max(1, Math.round(part.box.height)), rotation: part.rotation ?? 0, scale: 1, opacity: 1 },
      props: { ...structuredClone(COMPONENTS[part.type].defaultProps), ...part.props },
      tracks: [],
      parentId: groupId,
      ...(part.effects ? { effects: part.effects } : {}),
      ...(part.propTracks ? { propTracks: part.propTracks.map((tr) => ({ ...tr, keyframes: tr.keyframes.map((k) => ({ ...k, frame: Math.min(Math.round(k.frame * timing * squeeze), length - startFrame - 1) })) })) } : {}),
    };
    if (typeof element.props.typingDurationInFrames === 'number') {
      element.props.typingDurationInFrames = Math.max(0, Math.min(element.durationInFrames - 1, Math.round(element.props.typingDurationInFrames * squeeze)));
    }
    if (typeof element.props.revealDurationInFrames === 'number' && part.type === 'text' && element.props.reveal !== 'none') {
      element.props.revealDurationInFrames = Math.max(1, Math.min(300, Math.round(element.props.revealDurationInFrames * timing * squeeze)));
    }
    ids.set(part.name, element.id);
    return animate(element, part);
  });
  design.parts.forEach((part, i) => {
    const sourceId = part.maskBy ? ids.get(part.maskBy) : undefined;
    if (sourceId) children[i] = { ...children[i], mask: { sourceId, mode: part.maskMode ?? 'alpha' } };
  });

  let group: Element = {
    id: groupId,
    type: 'group',
    name: def.label,
    startFrame: at,
    durationInFrames: length,
    visible: true,
    transform: { x: Math.round(bounds.x), y: Math.round(bounds.y), width: Math.round(bounds.width), height: Math.round(bounds.height), rotation: 0, scale: 1, opacity: 1 },
    props: { clip: false },
    tracks: [],
  };
  // Group motion: exits end on the group's last frame.
  for (const mo of design.groupMotion ?? []) {
    const duration = Math.max(1, t(mo.seconds ?? PRESET_SECONDS[mo.preset]));
    group = withPreset(group, mo.preset, { ...presetOptions(mo, duration), at: Math.max(0, length - 1 - duration) });
  }
  if ((design.push || design.drift) && length > 2) {
    // Never dead: the group keeps moving until the cut. A push scales about
    // the group centre, offset so the focus point stays put; a drift is a
    // constant slide (linear is right for a slow, steady texture).
    const push = design.push;
    const drift = design.drift;
    const from = Math.min(length - 2, t(push?.at ?? drift?.at ?? 0));
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    const scale = push?.scale ?? 1;
    const start = push?.from ?? 1;
    const offset = (s: number) => (push ? { x: Math.round((push.focus.x - cx) * (1 - s)), y: Math.round((push.focus.y - cy) * (1 - s)) } : { x: 0, y: 0 });
    const dx = offset(scale).x + (drift?.x ?? 0);
    const dy = offset(scale).y + (drift?.y ?? 0);
    const ease: EasingSpec = push ? 'easeInOutCubic' : 'linear';
    group = withPlan(group, { keys: [
      ...(push ? [{ track: 'scale', frame: from, value: start, easing: ease }, { track: 'scale', frame: length - 1, value: scale }] as PresetKey[] : []),
      { track: 'x', frame: from, value: offset(start).x, easing: ease },
      { track: 'x', frame: length - 1, value: dx },
      { track: 'y', frame: from, value: offset(start).y, easing: ease },
      { track: 'y', frame: length - 1, value: dy },
    ] });
  }
  if (ctx.parentId !== undefined) {
    group = { ...group, parentId: ctx.parentId, startFrame: at - host.start, transform: { ...group.transform, x: group.transform.x - host.x, y: group.transform.y - host.y } };
  }
  const elements = [group, ...children];
  return {
    ok: true,
    group,
    elements,
    // A backdrop goes under what the scene already has: insert at the front of the paint order, in order.
    commands: elements.map((element, i): Command => ({ type: 'addElement', sceneId: scene.id, element, ...(design.behind ? { index: i } : {}) })),
    label: `Insert ${def.label.toLowerCase()}`,
  };
}
