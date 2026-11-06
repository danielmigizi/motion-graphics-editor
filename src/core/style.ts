// Style packs: a project-level brand kit — fonts, colour roles and a motion
// personality — that presets, templates and agents read (project.style).
// Four packs ship; any of them can be tuned into a custom motion personality.
// Pure data plus the one command that sets it (setStyle). AI patches may
// change it only with the target { style: "project" } (brand-kit proposals).

import { easingFn } from './animation';
import { FONT_FAMILIES, type FontFamily } from './components';
import { HOUSE_PACK_ID, PULSE_CRAFT } from './styleCraft';
import type { Command, CubicBezierEasing, EasingSpec, MotionPersonality, Project, StylePack } from './types';

export { HOUSE_PACK_ID, PULSE_CRAFT, DEFAULT_CRAFT, craftOf, craftLine } from './styleCraft';

const bez = (x1: number, y1: number, x2: number, y2: number): CubicBezierEasing => ({ type: 'cubicBezier', x1, y1, x2, y2 });

export type PersonalityId = Exclude<MotionPersonality['id'], 'custom'>;

/**
 * Named motion personalities. Curves are CSS cubic-bezier; `enter` shapes
 * arrivals (decelerating into place), `exit` departures (accelerating away).
 * Playful's curves overshoot by design (back-out ≈ 10 %). Percussive is the
 * house bar: 2–4 f pops, no curve overshoot (springs are explicit keys).
 */
export const MOTION_PERSONALITIES: Record<PersonalityId, MotionPersonality> = {
  snappy: { id: 'snappy', timingScale: 0.8, staggerFrames: 3, overshoot: 0.04, enter: bez(0.16, 1, 0.3, 1), exit: bez(0.7, 0, 0.84, 0) },
  smooth: { id: 'smooth', timingScale: 1, staggerFrames: 4, overshoot: 0, enter: bez(0.33, 1, 0.68, 1), exit: bez(0.32, 0, 0.67, 0) },
  playful: { id: 'playful', timingScale: 0.9, staggerFrames: 5, overshoot: 0.12, enter: bez(0.34, 1.56, 0.64, 1), exit: bez(0.36, 0, 0.66, -0.56) },
  premium: { id: 'premium', timingScale: 1.35, staggerFrames: 6, overshoot: 0, enter: bez(0.22, 1, 0.36, 1), exit: bez(0.64, 0, 0.78, 0) },
  editorial: { id: 'editorial', timingScale: 1.15, staggerFrames: 5, overshoot: 0.02, enter: bez(0.65, 0, 0.35, 1), exit: bez(0.65, 0, 0.35, 1) },
  percussive: { id: 'percussive', timingScale: 0.7, staggerFrames: 3, overshoot: 0.08, enter: bez(0.08, 1, 0.18, 1), exit: bez(0.75, 0, 0.9, 0) },
};

export const PERSONALITY_IDS = Object.keys(MOTION_PERSONALITIES) as PersonalityId[];

/** How each personality reads and where it belongs (menus, the guide). */
export const PERSONALITY_NOTES: Record<PersonalityId, { label: string; curve: string; feel: string }> = {
  snappy: { label: 'Snappy', curve: 'expo-out in / expo-in out', feel: 'fast attack, long soft landing; UI, SaaS, product demos' },
  smooth: { label: 'Smooth', curve: 'cubic-out in / cubic-in out', feel: 'neutral, never draws attention to itself; explainers' },
  playful: { label: 'Playful', curve: 'back-out in (≈10 % overshoot) / back-in out', feel: 'bouncy and warm; consumer, social, kids' },
  premium: { label: 'Premium', curve: 'quint-out in / quint-in out, 1.35× longer', feel: 'slow, weighty, confident; luxury, finance, brand films' },
  editorial: { label: 'Editorial', curve: 'cubic in-out both ways', feel: 'deliberate, typographic, generous holds; publishing, culture' },
  percussive: { label: 'Percussive', curve: 'expo-out in (2–4 f pops) / expo-in out', feel: 'fast pops, irregular stagger, constant drift, late cuts; the house launch bar' },
};

export type StylePackId = 'paper' | 'pulse' | 'snappy-saas' | 'calm-premium' | 'playful-consumer' | 'editorial';

export const STYLE_PACKS: Record<StylePackId, StylePack> = {
  // The default of a new blank video: the editor's own light plate, cobalt and green, neutral type and motion.
  paper: {
    id: 'paper',
    name: 'Paper',
    fonts: { heading: 'Inter', body: 'Inter', mono: 'IBM Plex Mono' },
    colors: { background: '#F7F6F2', surface: '#FFFFFF', text: '#15171C', muted: '#555B68', accent: '#2447E5', accent2: '#1E8A4C' },
    motion: MOTION_PERSONALITIES.smooth,
  },
  // House bar: cream plate, ink type, mint + teal. Craft from the measured
  // launch-video pass — not a brand kit. Agents copy this unless the brief
  // names another pack.
  [HOUSE_PACK_ID]: {
    id: HOUSE_PACK_ID,
    name: 'Pulse',
    fonts: { heading: 'Space Grotesk', body: 'Inter', mono: 'IBM Plex Mono' },
    colors: { background: '#F5F2EC', surface: '#FFFFFF', text: '#423F38', muted: '#6B675E', accent: '#58AD80', accent2: '#1FB0BF' },
    motion: MOTION_PERSONALITIES.percussive,
    craft: PULSE_CRAFT,
  },
  'snappy-saas': {
    id: 'snappy-saas',
    name: 'Snappy SaaS',
    fonts: { heading: 'Inter', body: 'Inter', mono: 'IBM Plex Mono' },
    colors: { background: '#0B0D17', surface: '#161A2E', text: '#F5F7FF', muted: '#9BA3C4', accent: '#6C7BFF', accent2: '#2DD4BF' },
    motion: MOTION_PERSONALITIES.snappy,
  },
  'calm-premium': {
    id: 'calm-premium',
    name: 'Calm Premium',
    fonts: { heading: 'Fraunces', body: 'Inter', mono: 'IBM Plex Mono' },
    colors: { background: '#0F0E0C', surface: '#1C1A17', text: '#F3EEE6', muted: '#A69F94', accent: '#D4B483', accent2: '#8FA38A' },
    motion: MOTION_PERSONALITIES.premium,
  },
  'playful-consumer': {
    id: 'playful-consumer',
    name: 'Playful Consumer',
    fonts: { heading: 'Space Grotesk', body: 'Inter', mono: 'IBM Plex Mono' },
    colors: { background: '#FFF4E8', surface: '#FFFFFF', text: '#1D1533', muted: '#6E6680', accent: '#FF5A36', accent2: '#7C5CFF' },
    motion: MOTION_PERSONALITIES.playful,
  },
  editorial: {
    id: 'editorial',
    name: 'Editorial',
    fonts: { heading: 'Fraunces', body: 'Inter', mono: 'IBM Plex Mono' },
    colors: { background: '#F3EFE6', surface: '#E8E2D5', text: '#16140F', muted: '#5F5A50', accent: '#D23A1E', accent2: '#1F3B8F' },
    motion: MOTION_PERSONALITIES.editorial,
  },
};

export const STYLE_PACK_IDS = Object.keys(STYLE_PACKS) as StylePackId[];

/** One line per pack for menus and the guide. */
export const STYLE_PACK_NOTES: Record<StylePackId, string> = {
  paper: 'Inter on a light paper plate, cobalt + green accents, smooth motion. The default of a new video; neutral, swap it for a stronger pack when the brief has a voice.',
  pulse: 'Space Grotesk on cream, mint + teal, percussive pops (2–4 f) and late cuts. The house quality bar for agent launch videos.',
  'snappy-saas': 'Inter on deep navy, indigo + teal accents, snappy motion. Product launches, UI demos.',
  'calm-premium': 'Fraunces headlines on warm black, champagne accent, premium (slow) motion. Brand films, finance.',
  'playful-consumer': 'Space Grotesk on cream, tangerine + violet, playful overshoot. Consumer apps, social.',
  editorial: 'Fraunces on paper, ink + vermilion, editorial in-out motion. Kinetic type, stories, quotes.',
};

/** The project's motion personality, when it has a style pack. */
export const motionOf = (project: Pick<Project, 'style'>): MotionPersonality | undefined => project.style?.motion;

/** A bundled font for a role, or the fallback (packs may name fonts the renderer does not ship). */
export function bundledFont(name: string | undefined, fallback: FontFamily): FontFamily {
  return (FONT_FAMILIES as readonly string[]).includes(name ?? '') ? (name as FontFamily) : fallback;
}

/** Does a curve leave the 0..1 range (overshoot or anticipation built in)? */
export function easingOvershoots(spec: EasingSpec): boolean {
  if (typeof spec === 'string') return spec === 'backOut';
  return spec.y1 < 0 || spec.y1 > 1 || spec.y2 < 0 || spec.y2 > 1;
}

/** Is a curve front-loaded (most of the change early, like ease-out)? */
export function easingFrontLoaded(spec: EasingSpec): boolean {
  return easingFn(spec)(0.25) >= 0.4;
}

/** Same pack with motion tuned; the personality becomes 'custom' once it differs from its named one. */
export function tuneMotion(pack: StylePack, changes: Partial<Omit<MotionPersonality, 'id'>>): StylePack {
  const next = { ...pack.motion, ...changes };
  const named = PERSONALITY_IDS.map((id) => MOTION_PERSONALITIES[id]).find((m) => sameMotion(m, next));
  return { ...pack, motion: named ?? { ...next, id: 'custom' } };
}

/** Swap in a named personality, keeping fonts and colours. */
export const withPersonality = (pack: StylePack, id: PersonalityId): StylePack => ({ ...pack, motion: MOTION_PERSONALITIES[id] });

function sameMotion(a: Omit<MotionPersonality, 'id'>, b: Omit<MotionPersonality, 'id'>): boolean {
  const curve = (x: EasingSpec, y: EasingSpec) => JSON.stringify(x) === JSON.stringify(y);
  return a.timingScale === b.timingScale && a.staggerFrames === b.staggerFrames && a.overshoot === b.overshoot && curve(a.enter, b.enter) && curve(a.exit, b.exit);
}

/** The shipped pack this style came from (by id), if any. */
export const shippedPack = (style: StylePack | undefined): StylePack | undefined => (style && style.id in STYLE_PACKS ? STYLE_PACKS[style.id as StylePackId] : undefined);

export interface ApplyStyleOptions {
  /** Also paint the project and every unlocked scene with the pack's background colour. */
  backgrounds?: boolean;
}

/**
 * Commands that give the project a style pack (null clears it) — run them as
 * ONE batch. With `backgrounds`, the project and unlocked scenes take the
 * pack's background colour too; locked (approved) scenes are left alone.
 */
export function applyStylePack(project: Project, pack: StylePack | null, options: ApplyStyleOptions = {}): Command {
  const commands: Command[] = [{ type: 'setStyle', style: pack }];
  if (pack && options.backgrounds) {
    commands.push({ type: 'updateProject', changes: { backgroundColor: pack.colors.background } });
    for (const scene of project.scenes) if (!scene.locked && scene.backgroundColor !== pack.colors.background) commands.push({ type: 'updateScene', sceneId: scene.id, changes: { backgroundColor: pack.colors.background } });
  }
  return { type: 'batch', label: pack ? `Style: ${pack.name}` : 'Clear style', commands };
}
