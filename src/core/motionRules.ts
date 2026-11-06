// Motion direction rules ("craft v2") as numbers. One source for the agent
// guide, the presets, the templates and the golden examples, so the advice an
// agent reads is the arithmetic the editor's own motion uses. Pure and
// deterministic; frame counts are at 30 fps unless a function takes `fps`.
//
// Covers timing, staggers, motion principles, staging, frames that stay alive
// during reading holds, compositions that use the frame, video-safe type
// minimums, pacing, the spotlight, palette and brand discipline.

import { parseColor } from './color';
import type { MotionPersonality, Project, Transform } from './types';

export const CRAFT_VERSION = 'craft v2';

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

export type MotionRole = 'micro' | 'small' | 'medium' | 'large' | 'hero';

/** Entrance length bands (frames at 30 fps) by how big and important the thing is. Exits run ≈ 0.75× as long. */
export const TIMING_BANDS: Record<MotionRole, { frames: readonly [number, number]; what: string }> = {
  micro: { frames: [6, 10], what: 'icons, chips, cursors, dots; up to 120 px' },
  small: { frames: [10, 16], what: 'labels, buttons, captions, list rows; up to 400 px' },
  medium: { frames: [14, 22], what: 'headlines, cards, images; up to half the frame' },
  large: { frames: [20, 30], what: 'screenshots, panels, full-width moves' },
  hero: { frames: [24, 40], what: 'logo stings, hero reveals, the one moment of the beat' },
};

export const EXIT_RATIO = 0.75;

/** Role from on-screen size (share of the frame's area), unless the caller knows better. */
export function motionRole(element: { transform: Pick<Transform, 'width' | 'height' | 'scale'> }, project: Pick<Project, 'width' | 'height'>): MotionRole {
  const { width, height, scale } = element.transform;
  const share = (width * height * scale * scale) / (project.width * project.height);
  const longest = Math.max(width, height) * scale * (1080 / Math.min(project.width, project.height));
  if (longest <= 120) return 'micro';
  if (longest <= 400 && share < 0.06) return 'small';
  if (share < 0.25) return 'medium';
  return 'large';
}

/** Words read per second on screen, and the fixed time to find the text. */
export const READING = { wordsPerSecond: 3.5, findSeconds: 0.5, minSeconds: 1.2 } as const;

/** Frames a text must hold, fully readable, before anything covers or removes it. */
export function readingFrames(text: string, fps: number): number {
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length; // "·", "—" are not words
  const seconds = Math.max(READING.minSeconds, words / READING.wordsPerSecond + READING.findSeconds);
  return Math.round(seconds * fps);
}

/** Scene length bands in seconds by purpose. */
export const SCENE_BANDS: Record<string, readonly [number, number]> = {
  hook: [1.5, 3],
  statement: [2.5, 4],
  feature: [4, 7],
  'walkthrough step': [4, 8],
  proof: [3, 5],
  outro: [3, 5],
};

/**
 * Story structure the directed brief and editor_critique share. Visual checks
 * always run; mapping checks run only when `project.story.beats` is present.
 */
export const STORY = {
  /** Hook must land inside this window (seconds from the start). */
  hookSeconds: [1.5, 2] as const,
  /** Below this average filled-scene length, too many ideas for the runtime. */
  minSceneSeconds: 2.5,
  /** Word-bearing text elements per second; above this with enough texts is dense. */
  maxTextPerSecond: 1.5,
  /** Final stretch (share of duration) that must carry the payoff. */
  payoffShare: 0.22,
  /** Interior unique-text-land gap (seconds) that reads as a dead middle. */
  deadMiddleSeconds: 8,
  /** Videos shorter than this skip the dead-middle gap check. */
  deadMiddleMinSeconds: 15,
  /** Filled scenes at or above this count can trip tooManyIdeas. */
  tooManyScenes: 5,
  /** Word-bearing texts at or above this count can trip textDensity. */
  tooManyTexts: 10,
} as const;

/**
 * Continuity from one scene to the next, and how motion behaves inside a
 * scene: what a cut samples, when two sides of a cut match, how long an
 * entrance or exit may run, the pause before a climax and what counts as an
 * idle loop. Numbers are at 30 fps unless a function takes `fps`.
 */
export const SEAM = {
  /** Default direction of travel for ordinary cuts (towards screen-left). */
  current: 'left' as const,
  /** Sample window on each side of a cut (seconds). */
  sampleSeconds: 0.25,
  /** Min travel (px at 1080 / frame) to count as motion. */
  minSpeedPx: 0.45,
  /** Min |d(scale)| per frame to count as a Z move. */
  minScalePerFrame: 0.002,
  /** Speeds match if the faster/slower ratio stays under this. */
  speedRatioWarn: 2.5,
  /** Pause after a big move before its result lands (seconds). */
  stillnessSeconds: [0.3, 0.75] as const,
  /** Longest entrance for one element; a longer build uses several staggered elements. */
  maxEntrySeconds: 0.8,
  /** Exit length as a share of that element's own entry. */
  exitRatio: EXIT_RATIO,
  /** Direction changes on one track that make it a back-and-forth loop rather than a settle. */
  idleReversals: 3,
} as const;

// ---------------------------------------------------------------------------
// Overlap: arrive apart
// ---------------------------------------------------------------------------

/** Sibling arrival offsets: below 3 frames reads as one block, above 6 as separate events. */
export const STAGGER_FRAMES = { min: 3, max: 6, default: 4 } as const;
/** Parts of one thing (a card's title after its plate) follow by this much. */
export const FOLLOW_FRAMES = { min: 2, max: 4 } as const;

export type StaggerOrder = 'reading' | 'importance' | 'centerOut' | 'given';

interface Placed {
  transform: { x: number; y: number; width: number; height: number; scale: number };
}

/**
 * Sibling order for an arrive-apart stagger. reading: rows top to bottom, then
 * left to right (rows are ±24 px); importance: biggest first; centerOut:
 * nearest the group's centre first; given: as passed.
 */
export function staggerOrder<T extends Placed>(items: readonly T[], order: StaggerOrder): T[] {
  const list = items.slice();
  if (order === 'given' || list.length < 2) return list;
  const area = (e: T) => e.transform.width * e.transform.height * e.transform.scale * e.transform.scale;
  if (order === 'importance') return list.sort((a, b) => area(b) - area(a));
  if (order === 'reading') return list.sort((a, b) => (Math.abs(a.transform.y - b.transform.y) > 24 ? a.transform.y - b.transform.y : a.transform.x - b.transform.x));
  const left = Math.min(...list.map((e) => e.transform.x));
  const top = Math.min(...list.map((e) => e.transform.y));
  const right = Math.max(...list.map((e) => e.transform.x + e.transform.width));
  const bottom = Math.max(...list.map((e) => e.transform.y + e.transform.height));
  const cx = (left + right) / 2;
  const cy = (top + bottom) / 2;
  const dist = (e: T) => Math.hypot(e.transform.x + e.transform.width / 2 - cx, e.transform.y + e.transform.height / 2 - cy);
  return list.sort((a, b) => dist(a) - dist(b));
}

// ---------------------------------------------------------------------------
// Principles: anticipation, give, follow-through, beats
// ---------------------------------------------------------------------------

export const PRINCIPLES = {
  /** Wind-up before a move: share of the move's length, and distance as a share of the travel. */
  anticipation: { share: [0.2, 0.35], travel: [0.08, 0.15] },
  /** Overshoot past the mark (fraction of the travel or scale), then settle in 2 swings. */
  overshoot: { fraction: [0.03, 0.12], settleFrames: [6, 12] },
  /** Loose parts keep going 2–4 frames after the body stops and swing back. */
  followThrough: { lagFrames: [2, 4], amplitude: [0.06, 0.12] },
  /** Landing compression (uniform scale, base kept planted) and rebound. */
  squash: { scale: [0.88, 0.94], rebound: [1.02, 1.04], frames: [3, 5] },
  /** Hits land ON the beat frame: 1-frame attack, 6–12 frame decay. */
  hit: { attackFrames: 1, decayFrames: [6, 12], scale: [1.06, 1.14] },
} as const;

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/** Safe margins at 1080 px on the frame's short side; scale with it. */
export const SAFE_MARGIN = { min: 64, max: 96 } as const;

/**
 * Video-safe minimums at 1080 px on the short side (px): below these, type
 * reads on a monitor but not on a phone or a projector. Scale with the frame.
 */
export const TYPE_MIN = {
  /** Labels in mixed case: roles, card numbers, captions on a plate. */
  label: 24,
  /**
   * Tracked caps: eyebrows, kickers, step badges, panel labels. Caps read by
   * their cap height (≈ 0.7 em) and tracking thins them, so a 26 px eyebrow
   * reads as 18 px type; 32 px keeps the caps ≈ 22 px tall.
   */
  trackedCaps: 32,
  /** Body copy and sublines. */
  body: 32,
  /** Callouts, chips, pills. */
  callout: 26,
  /** A button's label. */
  ctaLabel: 30,
  /** WCAG contrast for anything meant to be read (no mid-grey punchlines). */
  contrast: 4.5,
} as const;

/** Type sizes at 1080 px on the short side (px) and line lengths (characters). */
export const TYPE_SCALE = {
  hero: [120, 180],
  headline: [84, 128],
  title: [56, 80],
  body: [32, 44],
  caption: [24, 30],
  maxLineChars: { headline: 24, body: 52 },
  minBodyPx: TYPE_MIN.body,
} as const;

/**
 * WCAG contrast ratio (1–21) of `fg` painted over `layers` (top first; each
 * translucent layer is composited over the next, the last one taken as
 * opaque). Null when a colour does not parse (a gradient, a typo).
 */
export function contrastRatio(fg: string, ...layers: string[]): number | null {
  const stack = [fg, ...layers].map(parseColor);
  if (!layers.length || stack.some((c) => !c)) return null;
  const over = (top: number[], below: number[]) => top.slice(0, 3).map((v, i) => v * top[3] + below[i] * (1 - top[3]));
  const flat = (from: number) => stack.slice(from, -1).reduceRight<number[]>((below, top) => over(top!, below), stack.at(-1)!.slice(0, 3));
  const luminance = (rgb: number[]) => {
    const [r, g, b] = rgb.map((v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const a = luminance(flat(0));
  const b = luminance(flat(1));
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

export const safeMargin = (project: Pick<Project, 'width' | 'height'>, level: 'min' | 'max' = 'max') => Math.round(SAFE_MARGIN[level] * (Math.min(project.width, project.height) / 1080));

/**
 * Never dead: no frame holds fully still for longer than `maxStillSeconds`.
 * While the hero holds for its reading time, something secondary keeps
 * moving around it: a slow push, a drift, a background texture, a draw-on,
 * typing, counting or staggered chips. Numbers are the designed ranges.
 */
export const LIVENESS = {
  maxStillSeconds: 0.5,
  /** Slow push or scale over a hold, as a fraction of 1. */
  push: [0.02, 0.05],
  /** Drift over a hold (px at 1080). One-way travel is purposeful; a looping sine is filler. */
  driftPx: [10, 30],
  /** Something new lands this often (seconds) in a content scene. */
  newBeatSeconds: [0.5, 1.0],
} as const;

/**
 * Use the frame: heroes are big, screenshots fill most of the width, and
 * empty space is a decision, not a default.
 */
export const FRAME_USE = {
  /** Headline cap height as a share of the frame height, for a hero statement. */
  heroCapHeightShare: 0.07,
  /** Product screenshots: share of the frame width. */
  screenshotWidthShare: [0.6, 0.8],
  /** At most this share of a content scene's frame visually empty. */
  maxEmptyShare: 0.5,
} as const;

/** Spotlight: dim everything but the stat, frame it in the palette's accent. */
export const SPOTLIGHT = { dimTo: [0.4, 0.6] } as const;

/** Hero headline size (px) for a cap height of `share` × the frame's short side; cap height ≈ 0.72 em. */
export const heroSizeFor = (project: Pick<Project, 'width' | 'height'>, share: number = FRAME_USE.heroCapHeightShare) => Math.round((share * Math.min(project.width, project.height)) / 0.72);

// ---------------------------------------------------------------------------
// Personality arithmetic
// ---------------------------------------------------------------------------

/** Frames for a designed length in seconds, scaled by the personality's timing. */
export function scaledFrames(seconds: number, fps: number, motion?: Pick<MotionPersonality, 'timingScale'>): number {
  return Math.max(1, Math.round(seconds * fps * (motion?.timingScale ?? 1)));
}

/** Frames between sibling arrivals for a personality (editor default 4). */
export const staggerFor = (motion?: Pick<MotionPersonality, 'staggerFrames'>) => Math.round(motion?.staggerFrames ?? STAGGER_FRAMES.default);
