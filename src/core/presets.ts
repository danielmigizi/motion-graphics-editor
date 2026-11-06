// Motion presets: reusable, EDITABLE motion. A preset is a pure recipe that
// becomes ordinary keyframes (setKeyframe / setPropertyKeyframe) or component
// props (text reveals), so after applying one the user edits plain keys —
// nothing preset-specific is stored in the document.
//
// Rules every preset follows:
// - Frames are element-local integers inside the element's lifetime.
// - A preset owns its window: existing keys of a property it writes that fall
//   strictly between its first and last key for that property are removed, so
//   re-applying a preset replaces the old motion instead of mixing with it.
//   Keys outside the window are kept (an entrance and an exit combine).
// - Arrive apart (applyStagger) is the exception for entrances: a layer
//   arrives once, so the staggered entrance replaces the layer's current
//   entrance (withoutEntrance) wherever the stagger moves it to.
// - The last key of each property keeps the easing of a key already at that
//   frame (it shapes the segment AFTER the preset, which the preset does not own).
// - Entrance presets on text switch its built-in reveal off: two entrances
//   stacked read as a mistake.
// - With a motion personality (the project's style.motion) every preset takes
//   its timing (timingScale), arrival/exit curves, overshoot and stagger from
//   it; without one they keep the editor defaults below.
//
// Principle presets (craft v1, see motionRules.ts) encode anticipation, give,
// squash, arcs, match cuts and beat hits. Arrive-apart staggers, follow-through
// and match-cut pairs act on several elements: applyStagger,
// followThroughCommands and matchCutCommands.

import { PRINCIPLES, scaledFrames, staggerFor, staggerOrder, type StaggerOrder } from './motionRules';
import { easingFrontLoaded, easingOvershoots } from './style';
import type { AnimatableProperty, Command, EasingSpec, Element, ElementType, MotionPersonality, Scene } from './types';

export type PresetKind = 'enter' | 'emphasis' | 'exit' | 'loop';

export type PresetId =
  | 'fadeIn'
  | 'riseIn'
  | 'slideInLeft'
  | 'slideInRight'
  | 'slideInTop'
  | 'slideInBottom'
  | 'popIn'
  | 'blurIn'
  | 'wipeOn'
  | 'typewriter'
  | 'charStagger'
  | 'wordStagger'
  | 'overshootSettle'
  | 'squashLand'
  | 'arcIn'
  | 'matchIn'
  | 'pulse'
  | 'holdHit'
  | 'floatLoop'
  | 'fadeOut'
  | 'sinkOut'
  | 'slideOutLeft'
  | 'slideOutRight'
  | 'popOut'
  | 'blurOut'
  | 'wipeOff'
  | 'anticipateGo'
  | 'matchOut'
  | 'snapPop'
  | 'springIn'
  | 'smear';

export interface PresetOptions {
  /** Element-local frame where the motion starts. */
  at: number;
  /** Length in frames. */
  duration: number;
  /** 1 = as designed; 0.25 (subtle) … 2 (strong). Scales distances, not timing. */
  intensity: number;
  /** Project frame rate (loops use it for their period). */
  fps: number;
  /** The project's motion personality (style.motion). Absent: editor defaults. */
  motion?: MotionPersonality;
  /** Overshoot-and-settle amount as a fraction (0.08 = 8 %); default the personality's. */
  overshoot?: number;
}

/** One key a preset writes, element-local. `easing` undefined = keep an existing key's easing (default easeInOut). */
export type PresetKey =
  | { track: AnimatableProperty; frame: number; value: number; easing?: EasingSpec }
  | { prop: string; frame: number; value: number | string; easing?: EasingSpec };

export interface PresetPlan {
  keys: PresetKey[];
  /** Component props set directly (text reveals). */
  props?: Record<string, unknown>;
}

export interface MotionPreset {
  id: PresetId;
  label: string;
  kind: PresetKind;
  /** One line for menus and the agent guide. */
  description: string;
  appliesTo: readonly ElementType[];
  /** Designed length in seconds at timingScale 1; 0 = the rest of the element (loops). */
  seconds: number;
  /** Text reveals always play from the element's first frame. */
  fromStart?: boolean;
  /** Encodes a motion principle (craft v1); menus list these together. */
  principle?: boolean;
  plan(element: Element, o: PresetOptions): PresetPlan;
}

const VISUAL: readonly ElementType[] = ['text', 'shape', 'logo', 'image', 'video', 'uiCard', 'chatBubble', 'path', 'group', 'instance'];
const TEXT: readonly ElementType[] = ['text'];
const PATH: readonly ElementType[] = ['path'];

const round = Math.round;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

type Target = { track: AnimatableProperty } | { prop: string };

/** Two keys: `from` at frame a (easing shapes the move), `to` at frame b (easing left to any existing key). */
function ramp(target: Target, from: number, to: number, a: number, b: number, easing: EasingSpec): PresetKey[] {
  return [
    { ...target, frame: a, value: from, easing },
    { ...target, frame: b, value: to },
  ] as PresetKey[];
}

/** Frame at `fraction` of the window, kept strictly after its start. */
const part = (o: PresetOptions, fraction: number) => o.at + Math.max(1, round(o.duration * fraction));
const end = (o: PresetOptions) => o.at + o.duration;

// Curves. Moves take the personality's own curve (playful moves overshoot,
// playful exits wind back first); values that must not pass their target —
// opacity, blur, trim, and moves that add their own overshoot keys — take
// the curve only when it stays inside 0..1.
const enter = (o: PresetOptions): EasingSpec => o.motion?.enter ?? 'easeOutCubic';
const exit = (o: PresetOptions): EasingSpec => o.motion?.exit ?? 'easeInCubic';
const calmEnter = (o: PresetOptions, fallback: EasingSpec = 'easeOutCubic'): EasingSpec => (o.motion && !easingOvershoots(o.motion.enter) ? o.motion.enter : fallback);
const calmExit = (o: PresetOptions, fallback: EasingSpec = 'easeInCubic'): EasingSpec => (o.motion && !easingOvershoots(o.motion.exit) ? o.motion.exit : fallback);
const fadeIn = (o: PresetOptions) => calmEnter(o, 'easeOut');
const fadeOut = (o: PresetOptions) => calmExit(o, 'easeIn');
/** Overshoot fraction for settle moves: the option, else the personality's, else 8 %; never below 2 %. */
const overshootOf = (o: PresetOptions) => clamp(o.overshoot ?? o.motion?.overshoot ?? 0.08, 0.02, 0.3);

const SLIDE = 160;
const RISE = 48;
const BLUR = 24;

function slideIn(target: Target, distance: number): MotionPreset['plan'] {
  return (_el, o) => ({
    keys: [...ramp(target, distance * o.intensity, 0, o.at, end(o), enter(o)), ...ramp({ track: 'opacity' }, 0, 1, o.at, part(o, 0.5), fadeIn(o))],
  });
}

function slideOut(target: Target, distance: number): MotionPreset['plan'] {
  return (_el, o) => ({
    keys: [...ramp(target, 0, distance * o.intensity, o.at, end(o), exit(o)), ...ramp({ track: 'opacity' }, 1, 0, part(o, 0.5), end(o), fadeOut(o))],
  });
}

/** Characters a per-character reveal animates (whitespace excluded, like the renderer). */
const revealUnits = (text: unknown) => (typeof text === 'string' ? text.replace(/\s+/g, '').length : 0);

/** Scale of a pushed match-cut pair: out grows by this, in starts at its inverse. */
const MATCH_PUSH = 0.25;

export const PRESETS: Record<PresetId, MotionPreset> = {
  fadeIn: {
    id: 'fadeIn', label: 'Fade in', kind: 'enter', appliesTo: VISUAL, seconds: 0.5,
    description: 'Opacity 0 → 1, easing out.',
    plan: (_el, o) => ({ keys: ramp({ track: 'opacity' }, 0, 1, o.at, end(o), fadeIn(o)) }),
  },
  riseIn: {
    id: 'riseIn', label: 'Rise in', kind: 'enter', appliesTo: VISUAL, seconds: 0.6,
    description: 'Drifts up 48 px into place while fading in (the arrival curve).',
    plan: (_el, o) => ({ keys: [...ramp({ track: 'y' }, RISE * o.intensity, 0, o.at, end(o), enter(o)), ...ramp({ track: 'opacity' }, 0, 1, o.at, part(o, 0.6), fadeIn(o))] }),
  },
  slideInLeft: { id: 'slideInLeft', label: 'Slide in from left', kind: 'enter', appliesTo: VISUAL, seconds: 0.7, description: 'Slides 160 px in from the left while fading in.', plan: slideIn({ track: 'x' }, -SLIDE) },
  slideInRight: { id: 'slideInRight', label: 'Slide in from right', kind: 'enter', appliesTo: VISUAL, seconds: 0.7, description: 'Slides 160 px in from the right while fading in.', plan: slideIn({ track: 'x' }, SLIDE) },
  slideInTop: { id: 'slideInTop', label: 'Slide in from top', kind: 'enter', appliesTo: VISUAL, seconds: 0.7, description: 'Drops 120 px in from above while fading in.', plan: slideIn({ track: 'y' }, -120) },
  slideInBottom: { id: 'slideInBottom', label: 'Slide in from bottom', kind: 'enter', appliesTo: VISUAL, seconds: 0.7, description: 'Comes 120 px up from below while fading in.', plan: slideIn({ track: 'y' }, 120) },
  popIn: {
    id: 'popIn', label: 'Pop', kind: 'enter', appliesTo: VISUAL, seconds: 0.5,
    description: 'Scales up from 50% with a slight overshoot while fading in (back-out, or the style\'s overshoot).',
    plan: (_el, o) => {
      const from = Math.max(0.05, 1 - 0.5 * o.intensity);
      const fade = ramp({ track: 'opacity' }, 0, 1, o.at, part(o, 0.4), fadeIn(o));
      if (!o.motion) return { keys: [...ramp({ track: 'scale' }, from, 1, o.at, end(o), 'backOut'), ...fade] };
      const over = o.motion.overshoot * o.intensity;
      if (easingOvershoots(o.motion.enter) || over <= 0) return { keys: [...ramp({ track: 'scale' }, from, 1, o.at, end(o), o.motion.enter), ...fade] };
      return { keys: [
        { track: 'scale', frame: o.at, value: from, easing: calmEnter(o) },
        { track: 'scale', frame: part(o, 0.6), value: 1 + over, easing: 'easeInOut' },
        { track: 'scale', frame: end(o), value: 1 },
        ...fade,
      ] };
    },
  },
  blurIn: {
    id: 'blurIn', label: 'Blur in', kind: 'enter', appliesTo: VISUAL, seconds: 0.7,
    description: 'Comes into focus from a 24 px blur while fading in.',
    plan: (_el, o) => ({ keys: [...ramp({ prop: 'effects.blur' }, clamp(BLUR * o.intensity, 0, 200), 0, o.at, end(o), calmEnter(o)), ...ramp({ track: 'opacity' }, 0, 1, o.at, part(o, 0.6), fadeIn(o))] }),
  },
  wipeOn: {
    id: 'wipeOn', label: 'Wipe on', kind: 'enter', appliesTo: PATH, seconds: 1,
    description: 'Draws the stroke along the path (trimEnd 0 → 1).',
    plan: (_el, o) => ({ keys: ramp({ prop: 'props.trimEnd' }, 0, 1, o.at, end(o), calmEnter(o, 'easeInOutCubic')) }),
  },
  typewriter: {
    id: 'typewriter', label: 'Typewriter', kind: 'enter', appliesTo: TEXT, seconds: 1.5, fromStart: true,
    description: "Types the text out character by character (the text's built-in reveal).",
    plan: (_el, o) => ({ keys: [], props: { reveal: 'typewriter', revealDurationInFrames: clamp(o.duration, 1, 300) } }),
  },
  charStagger: {
    id: 'charStagger', label: 'Character stagger', kind: 'enter', appliesTo: TEXT, seconds: 1.2, fromStart: true,
    description: 'Each character fades up in turn, timed to fill the preset length.',
    plan: (el, o) => {
      const units = revealUnits(el.props.text);
      const unit = clamp(round(o.duration * 0.4), 4, 300);
      const stagger = units > 1 ? clamp(round((o.duration - unit) / (units - 1)), 1, 30) : 0;
      return { keys: [], props: { reveal: 'charFadeUp', revealDurationInFrames: unit, revealStagger: stagger, revealOrder: 'forward', revealEasing: 'easeOutCubic' } };
    },
  },
  wordStagger: {
    id: 'wordStagger', label: 'Word stagger', kind: 'enter', appliesTo: TEXT, seconds: 1, fromStart: true,
    description: 'Words rise in one after another.',
    plan: (_el, o) => ({ keys: [], props: { reveal: 'wordStagger', revealDurationInFrames: clamp(o.duration, 1, 300) } }),
  },
  overshootSettle: {
    id: 'overshootSettle', label: 'Overshoot and settle', kind: 'enter', appliesTo: VISUAL, seconds: 0.7, principle: true,
    description: 'Rises 40 px and scales up from 70%, passes its size by the overshoot (style, default 8%), swings back 30% of that, then settles.',
    plan: (_el, o) => {
      const over = Math.min(0.4, overshootOf(o) * o.intensity);
      return { keys: [
        { track: 'scale', frame: o.at, value: Math.max(0.05, 1 - 0.3 * o.intensity), easing: calmEnter(o) },
        { track: 'scale', frame: part(o, 0.55), value: 1 + over, easing: 'easeInOut' },
        { track: 'scale', frame: part(o, 0.8), value: 1 - over * 0.3, easing: 'easeInOut' },
        { track: 'scale', frame: end(o), value: 1 },
        ...ramp({ track: 'y' }, 40 * o.intensity, 0, o.at, part(o, 0.55), calmEnter(o)),
        ...ramp({ track: 'opacity' }, 0, 1, o.at, part(o, 0.35), fadeIn(o)),
      ] };
    },
  },
  squashLand: {
    id: 'squashLand', label: 'Squash on land', kind: 'enter', appliesTo: VISUAL, seconds: 0.8, principle: true,
    description: 'Falls 200 px (accelerating), lands at half time with a compression to 92% (base kept planted), rebounds and settles.',
    plan: (el, o) => {
      const h = el.transform.height * el.transform.scale;
      const land = part(o, 0.5);
      const beat = Math.max(1, round(o.duration * 0.12));
      const squash = Math.max(0.5, 1 - 0.08 * o.intensity);
      const rebound = 1 + Math.min(0.2, Math.max(0.02, o.motion?.overshoot ?? 0.03) * o.intensity);
      // Uniform scale shrinks around the centre; shift down so the base stays on the floor.
      const planted = (s: number) => round((h * (1 - s)) / 2);
      const f1 = Math.min(land + beat, end(o));
      const f2 = Math.min(land + 2 * beat, end(o));
      return { keys: [
        { track: 'y', frame: o.at, value: -200 * o.intensity, easing: 'easeInCubic' },
        { track: 'y', frame: land, value: 0, easing: 'easeOut' },
        { track: 'y', frame: f1, value: planted(squash), easing: 'easeInOut' },
        { track: 'y', frame: f2, value: planted(rebound), easing: 'easeInOut' },
        { track: 'y', frame: end(o), value: 0 },
        { track: 'scale', frame: o.at, value: 1, easing: 'linear' },
        { track: 'scale', frame: land, value: 1, easing: 'easeOut' },
        { track: 'scale', frame: f1, value: squash, easing: 'easeInOut' },
        { track: 'scale', frame: f2, value: rebound, easing: 'easeInOut' },
        { track: 'scale', frame: end(o), value: 1 },
        ...ramp({ track: 'opacity' }, 0, 1, o.at, part(o, 0.15), 'easeOut'),
      ] };
    },
  },
  arcIn: {
    id: 'arcIn', label: 'Arc in', kind: 'enter', appliesTo: VISUAL, seconds: 0.8, principle: true,
    description: 'Arrives along a curve from lower left: y eases out fast while x eases in-out, so the path bows instead of cutting straight.',
    plan: (_el, o) => {
      const rise = calmEnter(o, 'easeOutExpo');
      return { keys: [
        ...ramp({ track: 'x' }, -220 * o.intensity, 0, o.at, end(o), 'easeInOutCubic'),
        ...ramp({ track: 'y' }, 140 * o.intensity, 0, o.at, end(o), easingFrontLoaded(rise) ? rise : 'easeOutExpo'),
        ...ramp({ track: 'opacity' }, 0, 1, o.at, part(o, 0.4), fadeIn(o)),
      ] };
    },
  },
  matchIn: {
    id: 'matchIn', label: 'Match-cut in', kind: 'enter', appliesTo: VISUAL, seconds: 0.5, principle: true,
    description: 'Starts at 80% and decelerates to full size with no fade: the second half of a push through a cut (pair with Match-cut out).',
    plan: (_el, o) => ({ keys: ramp({ track: 'scale' }, 1 / (1 + MATCH_PUSH * o.intensity), 1, o.at, end(o), calmEnter(o)) }),
  },
  pulse: {
    id: 'pulse', label: 'Pulse', kind: 'emphasis', appliesTo: VISUAL, seconds: 0.6,
    description: 'One beat: scales up 10% and settles back.',
    plan: (_el, o) => {
      const mid = o.at + Math.max(1, round(o.duration / 2));
      const last = Math.max(mid + 1, end(o));
      return { keys: [
        { track: 'scale', frame: o.at, value: 1, easing: calmEnter(o, 'easeOut') },
        { track: 'scale', frame: mid, value: 1 + 0.1 * o.intensity, easing: 'easeInOut' },
        { track: 'scale', frame: last, value: 1 },
      ] };
    },
  },
  holdHit: {
    id: 'holdHit', label: 'Hold and hit', kind: 'emphasis', appliesTo: VISUAL, seconds: 0.4, principle: true,
    description: 'Holds still, then hits one frame in: snaps to 110% with a brightness flash and decays back. Start it one frame before the beat.',
    plan: (_el, o) => {
      const hit = o.at + 1;
      const last = Math.max(hit + 1, end(o));
      const decay = calmEnter(o, 'easeOutCubic');
      return { keys: [
        { track: 'scale', frame: o.at, value: 1, easing: 'hold' },
        { track: 'scale', frame: hit, value: 1 + 0.1 * o.intensity, easing: decay },
        { track: 'scale', frame: last, value: 1 },
        { prop: 'effects.brightness', frame: o.at, value: 1, easing: 'hold' },
        { prop: 'effects.brightness', frame: hit, value: clamp(1 + 0.35 * o.intensity, 0, 3), easing: decay },
        { prop: 'effects.brightness', frame: last, value: 1 },
      ] };
    },
  },
  floatLoop: {
    id: 'floatLoop', label: 'Float', kind: 'loop', appliesTo: VISUAL, seconds: 0,
    description: 'Bobs gently up and down (12 px, 2 s period) for the rest of its time on screen.',
    plan: (_el, o) => {
      const amp = 12 * o.intensity;
      const period = Math.max(8, round(o.fps * 2 * (o.motion?.timingScale ?? 1)));
      const last = end(o);
      const keys: PresetKey[] = [{ track: 'y', frame: o.at, value: 0, easing: 'easeOut' }];
      // Peaks a quarter period in, then every half period, alternating up and
      // down, while a quarter period is left to settle back to rest.
      const settle = round(period / 4);
      for (let k = 0; ; k++) {
        const f = o.at + round(period / 4 + (k * period) / 2);
        if (f > last - settle) break;
        keys.push({ track: 'y', frame: f, value: k % 2 === 0 ? -amp : amp, easing: 'easeInOut' });
      }
      if (keys.length === 1 && last - o.at >= 4) keys.push({ track: 'y', frame: o.at + round((last - o.at) / 2), value: -amp, easing: 'easeInOut' });
      keys.push({ track: 'y', frame: last, value: 0 });
      return { keys };
    },
  },
  fadeOut: {
    id: 'fadeOut', label: 'Fade out', kind: 'exit', appliesTo: VISUAL, seconds: 0.5,
    description: 'Opacity 1 → 0, easing in.',
    plan: (_el, o) => ({ keys: ramp({ track: 'opacity' }, 1, 0, o.at, end(o), fadeOut(o)) }),
  },
  sinkOut: {
    id: 'sinkOut', label: 'Sink out', kind: 'exit', appliesTo: VISUAL, seconds: 0.5,
    description: 'Drops 48 px while fading out (the exit curve).',
    plan: (_el, o) => ({ keys: [...ramp({ track: 'y' }, 0, RISE * o.intensity, o.at, end(o), exit(o)), ...ramp({ track: 'opacity' }, 1, 0, part(o, 0.4), end(o), fadeOut(o))] }),
  },
  slideOutLeft: { id: 'slideOutLeft', label: 'Slide out to left', kind: 'exit', appliesTo: VISUAL, seconds: 0.6, description: 'Slides 160 px off to the left while fading out.', plan: slideOut({ track: 'x' }, -SLIDE) },
  slideOutRight: { id: 'slideOutRight', label: 'Slide out to right', kind: 'exit', appliesTo: VISUAL, seconds: 0.6, description: 'Slides 160 px off to the right while fading out.', plan: slideOut({ track: 'x' }, SLIDE) },
  popOut: {
    id: 'popOut', label: 'Pop out', kind: 'exit', appliesTo: VISUAL, seconds: 0.4,
    description: 'Shrinks to 50% while fading out.',
    plan: (_el, o) => ({ keys: [...ramp({ track: 'scale' }, 1, Math.max(0.05, 1 - 0.5 * o.intensity), o.at, end(o), exit(o)), ...ramp({ track: 'opacity' }, 1, 0, part(o, 0.4), end(o), fadeOut(o))] }),
  },
  blurOut: {
    id: 'blurOut', label: 'Blur out', kind: 'exit', appliesTo: VISUAL, seconds: 0.6,
    description: 'Goes out of focus to a 24 px blur while fading out.',
    plan: (_el, o) => ({ keys: [...ramp({ prop: 'effects.blur' }, 0, clamp(BLUR * o.intensity, 0, 200), o.at, end(o), calmExit(o)), ...ramp({ track: 'opacity' }, 1, 0, part(o, 0.4), end(o), fadeOut(o))] }),
  },
  wipeOff: {
    id: 'wipeOff', label: 'Wipe off', kind: 'exit', appliesTo: PATH, seconds: 0.8,
    description: 'Erases the stroke from its start (trimStart 0 → 1).',
    plan: (_el, o) => ({ keys: ramp({ prop: 'props.trimStart' }, 0, 1, o.at, end(o), calmExit(o, 'easeInOutCubic')) }),
  },
  anticipateGo: {
    id: 'anticipateGo', label: 'Anticipate and go', kind: 'exit', appliesTo: VISUAL, seconds: 0.7, principle: true,
    description: 'Winds back 24 px and compresses to 96% for the first 30%, then launches 240 px off to the right, fading over the last 40%.',
    plan: (_el, o) => {
      const wind = part(o, 0.3);
      const go = calmExit(o);
      return { keys: [
        { track: 'x', frame: o.at, value: 0, easing: 'easeInOut' },
        { track: 'x', frame: wind, value: -24 * o.intensity, easing: go },
        { track: 'x', frame: end(o), value: 240 * o.intensity },
        { track: 'scale', frame: o.at, value: 1, easing: 'easeInOut' },
        { track: 'scale', frame: wind, value: 1 - 0.04 * o.intensity, easing: go },
        { track: 'scale', frame: end(o), value: 1 },
        ...ramp({ track: 'opacity' }, 1, 0, part(o, 0.6), end(o), fadeOut(o)),
      ] };
    },
  },
  matchOut: {
    id: 'matchOut', label: 'Match-cut out', kind: 'exit', appliesTo: VISUAL, seconds: 0.4, principle: true,
    description: 'Pushes in 25% on an accelerating curve and ends on the cut, no fade: the first half of a push through a cut (pair with Match-cut in).',
    plan: (_el, o) => ({ keys: ramp({ track: 'scale' }, 1, 1 + MATCH_PUSH * o.intensity, o.at, end(o), calmExit(o)) }),
  },
  // House-bar pops: 2–4 f scale/fade, no overshoot. Pulse timingScale 0.7 → ~3 f.
  snapPop: {
    id: 'snapPop', label: 'Snap pop', kind: 'enter', appliesTo: VISUAL, seconds: 0.14, principle: true,
    description: '2–4 frame scale-and-fade pop with no overshoot (Pulse house bar).',
    plan: (_el, o) => {
      const from = Math.max(0.2, 1 - 0.45 * o.intensity);
      return { keys: [
        ...ramp({ track: 'scale' }, from, 1, o.at, end(o), calmEnter(o, 'easeOutExpo')),
        ...ramp({ track: 'opacity' }, 0, 1, o.at, end(o), fadeIn(o)),
      ] };
    },
  },
  // 3× → 1 over ~10 f with a slight overshoot, then smear-clear.
  springIn: {
    id: 'springIn', label: 'Spring in', kind: 'enter', appliesTo: VISUAL, seconds: 0.48, principle: true,
    description: 'Springs from ~3× down to rest over ~10 frames with a short overshoot (Pulse house bar).',
    plan: (_el, o) => {
      const from = clamp(3 * o.intensity, 1.4, 4);
      const over = 1 + clamp(overshootOf(o), 0.02, 0.12);
      return { keys: [
        { track: 'scale', frame: o.at, value: from, easing: calmEnter(o, 'easeOutExpo') },
        { track: 'scale', frame: part(o, 0.75), value: over, easing: 'easeInOut' },
        { track: 'scale', frame: end(o), value: 1 },
        ...ramp({ track: 'opacity' }, 0, 1, o.at, part(o, 0.25), fadeIn(o)),
        { prop: 'effects.blur', frame: o.at, value: clamp(18 * o.intensity, 0, 40), easing: calmEnter(o, 'easeOut') },
        { prop: 'effects.blur', frame: part(o, 0.4), value: 0 },
      ] };
    },
  },
  smear: {
    id: 'smear', label: 'Smear', kind: 'emphasis', appliesTo: VISUAL, seconds: 0.14, principle: true,
    description: 'A 2–4 frame motion-blur spike that clears — use on a fast travel (Pulse house bar).',
    plan: (_el, o) => ({
      keys: [
        { prop: 'effects.blur', frame: o.at, value: 0, easing: 'easeOut' },
        { prop: 'effects.blur', frame: part(o, 0.35), value: clamp(18 * o.intensity, 4, 40), easing: calmEnter(o, 'easeOut') },
        { prop: 'effects.blur', frame: end(o), value: 0 },
      ],
    }),
  },
};

export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

export const PRESET_KIND_LABELS: Record<PresetKind, string> = { enter: 'Enter', emphasis: 'Emphasis', exit: 'Exit', loop: 'Loop' };

export function presetAppliesTo(preset: MotionPreset, element: Element): boolean {
  return preset.appliesTo.includes(element.type) && element.durationInFrames >= 2;
}

/** Last key in the element's first third: where its entrance has settled (0 without one). */
export function settledFrame(element: Element): number {
  const third = element.durationInFrames / 3;
  const frames = [...element.tracks, ...(element.propTracks ?? [])].flatMap((t) => t.keyframes.map((k) => k.frame)).filter((f) => f <= third);
  return frames.length ? Math.max(...frames) : 0;
}

/**
 * Where and how long a preset plays by default: entrances from the first
 * frame, exits ending on the last. Emphasis and loops start at `localFrame`
 * (the playhead) when it is inside the element; otherwise emphasis plays
 * mid-element and loops start once the entrance has settled, so neither
 * replaces the entrance's keys. A motion personality scales the length.
 */
export function defaultPresetOptions(preset: MotionPreset, element: Element, ctx: { fps: number; localFrame?: number; intensity?: number; motion?: MotionPersonality }): PresetOptions {
  const last = element.durationInFrames - 1;
  const designed = scaledFrames(preset.seconds, ctx.fps, ctx.motion);
  const inside = ctx.localFrame !== undefined && ctx.localFrame >= 0 && ctx.localFrame < last ? ctx.localFrame : undefined;
  let at = 0;
  let duration = designed;
  if (preset.kind === 'exit') at = Math.max(0, last - designed);
  else if (preset.kind === 'emphasis') at = inside ?? Math.max(settledFrame(element), round((last - designed) / 2));
  else if (preset.kind === 'loop') {
    at = inside ?? settledFrame(element);
    duration = last - at;
  }
  return normalizeOptions(preset, element, { at, duration, intensity: ctx.intensity ?? 1, fps: ctx.fps, ...(ctx.motion ? { motion: ctx.motion } : {}) });
}

/** Clamp a preset's window into the element's lifetime. duration 0 means the element is too short. */
export function normalizeOptions(preset: MotionPreset, element: Element, o: PresetOptions): PresetOptions {
  const last = element.durationInFrames - 1;
  const at = preset.fromStart ? 0 : clamp(round(o.at), 0, Math.max(0, last - 1));
  const duration = preset.fromStart ? clamp(round(o.duration), 1, 300) : clamp(round(o.duration), 0, last - at);
  return {
    at,
    duration,
    intensity: clamp(Number.isFinite(o.intensity) ? o.intensity : 1, 0.25, 2),
    fps: o.fps > 0 ? o.fps : 30,
    ...(o.motion ? { motion: o.motion } : {}),
    ...(o.overshoot !== undefined && Number.isFinite(o.overshoot) ? { overshoot: o.overshoot } : {}),
  };
}

const keyOf = (k: PresetKey) => ('track' in k ? `track:${k.track}` : `prop:${k.prop}`);

/** Keys grouped by property, integer frames, sorted, one key per frame (the later one wins). */
function groupKeys(keys: PresetKey[]): Map<string, PresetKey[]> {
  const groups = new Map<string, Map<number, PresetKey>>();
  for (const k of keys) {
    const frame = round(k.frame);
    const byFrame = groups.get(keyOf(k)) ?? new Map<number, PresetKey>();
    byFrame.set(frame, { ...k, frame });
    groups.set(keyOf(k), byFrame);
  }
  return new Map([...groups].map(([g, byFrame]) => [g, [...byFrame.values()].sort((a, b) => a.frame - b.frame)]));
}

/** The plan for this element, or null when the preset does not fit it. */
export function planPreset(presetId: PresetId, element: Element, options: PresetOptions): PresetPlan | null {
  const preset = PRESETS[presetId];
  if (!presetAppliesTo(preset, element)) return null;
  const o = normalizeOptions(preset, element, options);
  if (o.duration < 1) return null;
  const plan = preset.plan(element, o);
  const props = { ...plan.props };
  if (preset.kind === 'enter' && !preset.fromStart && element.type === 'text' && element.props.reveal !== 'none') props.reveal = 'none';
  return { keys: plan.keys, ...(Object.keys(props).length ? { props } : {}) };
}

/** Keys clamped into the element's lifetime (multi-element plans compute frames from a shared clock). */
function insideLifetime(element: Element, plan: PresetPlan): PresetPlan {
  const last = Math.max(0, element.durationInFrames - 1);
  return { ...plan, keys: plan.keys.map((k) => ({ ...k, frame: clamp(round(k.frame), 0, last) })) };
}

/**
 * Commands that write a plan onto an element in a scene: removals of keys the
 * plan's windows replace, then its keys and props. Shared by every preset API.
 */
export function planCommands(sceneId: string, element: Element, plan: PresetPlan): Command[] {
  const ids = { sceneId, elementId: element.id };
  const commands: Command[] = [];
  for (const keys of groupKeys(plan.keys).values()) {
    const lo = keys[0].frame;
    const hi = keys[keys.length - 1].frame;
    const first = keys[0];
    if ('track' in first) {
      const existing = element.tracks.find((t) => t.property === first.track)?.keyframes ?? [];
      for (const k of existing) if (k.frame > lo && k.frame < hi && !keys.some((p) => p.frame === k.frame)) commands.push({ type: 'removeKeyframe', ...ids, property: first.track, frame: k.frame });
      for (const k of keys as Extract<PresetKey, { track: AnimatableProperty }>[]) commands.push({ type: 'setKeyframe', ...ids, property: k.track, frame: k.frame, value: k.value, ...(k.easing ? { easing: k.easing } : {}) });
    } else {
      const existing = element.propTracks?.find((t) => t.key === first.prop)?.keyframes ?? [];
      for (const k of existing) if (k.frame > lo && k.frame < hi && !keys.some((p) => p.frame === k.frame)) commands.push({ type: 'removePropertyKeyframe', ...ids, key: first.prop, frame: k.frame });
      for (const k of keys as Extract<PresetKey, { prop: string }>[]) commands.push({ type: 'setPropertyKeyframe', ...ids, key: k.prop, frame: k.frame, value: k.value, ...(k.easing ? { easing: k.easing } : {}) });
    }
  }
  if (plan.props) commands.push({ type: 'updateElement', ...ids, changes: { props: plan.props } });
  return commands;
}

/** The same result as running planCommands, on an element object that is not in a document yet. */
export function withPlan(element: Element, plan: PresetPlan): Element {
  let next: Element = { ...element, tracks: element.tracks.slice(), props: { ...element.props, ...plan.props } };
  const merge = <K extends { frame: number; easing: EasingSpec }>(existing: K[], keys: PresetKey[], make: (k: PresetKey, easing: EasingSpec) => K): K[] => {
    const lo = keys[0].frame;
    const hi = keys[keys.length - 1].frame;
    // Same as the commands: keys strictly inside the window go, keys at a planned frame are replaced.
    const kept = existing.filter((k) => !((k.frame > lo && k.frame < hi) || keys.some((p) => p.frame === k.frame)));
    const added = keys.map((k) => make(k, k.easing ?? existing.find((e) => e.frame === k.frame)?.easing ?? 'easeInOut'));
    return [...kept, ...added].sort((a, b) => a.frame - b.frame);
  };
  for (const keys of groupKeys(plan.keys).values()) {
    const first = keys[0];
    if ('track' in first) {
      const i = next.tracks.findIndex((t) => t.property === first.track);
      const keyframes = merge(i < 0 ? [] : next.tracks[i].keyframes, keys, (k, easing) => ({ frame: k.frame, value: k.value as number, easing }));
      const track = { property: first.track, keyframes };
      if (i < 0) next.tracks.push(track);
      else next.tracks[i] = track;
    } else {
      const tracks = (next.propTracks ?? []).slice();
      const i = tracks.findIndex((t) => t.key === first.prop);
      const keyframes = merge(i < 0 ? [] : tracks[i].keyframes, keys, (k, easing) => ({ frame: k.frame, value: k.value, easing }));
      if (i < 0) tracks.push({ key: first.prop, keyframes });
      else tracks[i] = { key: first.prop, keyframes };
      next = { ...next, propTracks: tracks };
    }
  }
  return next;
}

/**
 * Commands that apply a preset to an element in a scene: removals of keys the
 * preset's windows replace, then the preset's keys and props. Wrap them in one
 * batch (one undo step). Empty when the preset does not fit the element.
 */
export function presetCommands(sceneId: string, element: Element, presetId: PresetId, options: PresetOptions): Command[] {
  const plan = planPreset(presetId, element, options);
  return plan ? planCommands(sceneId, element, plan) : [];
}

/**
 * The same result as running presetCommands, applied to an element object
 * that is not in a document yet (templates build their elements this way).
 */
export function withPreset(element: Element, presetId: PresetId, options: PresetOptions): Element {
  const plan = planPreset(presetId, element, options);
  return plan ? withPlan(element, plan) : element;
}

// ---------------------------------------------------------------------------
// Several elements: arrive apart, follow-through, match-cut pairs
// ---------------------------------------------------------------------------

export interface StaggerOptions {
  fps: number;
  /** Frame (on the elements' shared parent clock) the first one starts; default the earliest feasible start in the chosen order. */
  at?: number;
  /** Frames between arrivals; default the personality's staggerFrames (4 without one). */
  stagger?: number;
  /** Who goes first; default reading order. */
  order?: StaggerOrder;
  intensity?: number;
  motion?: MotionPersonality;
  /** Frames each element's preset lasts; default its designed length (personality-scaled). */
  duration?: number;
  /** Every element of the scene, to put elements of different groups on one clock. */
  within?: readonly Element[];
}

/** Start frame on the scene clock (group starts add up). */
function sceneStart(element: Element, within: readonly Element[] | undefined): number {
  let start = element.startFrame;
  const seen = new Set([element.id]);
  for (let parent = within?.find((e) => e.id === element.parentId); parent && !seen.has(parent.id); parent = within?.find((e) => e.id === parent!.parentId)) {
    seen.add(parent.id);
    start += parent.startFrame;
  }
  return start;
}

/**
 * Arrive apart: one preset on several siblings, each starting `stagger` frames
 * after the previous in the chosen order (exits leave in that order, the last
 * on its own last frame). Text reveals that always play from the first frame
 * are not offset. Returns the elements the preset fits, in order, with options.
 */
export function staggerPlan(elements: readonly Element[], presetId: PresetId, opts: StaggerOptions): { element: Element; options: PresetOptions }[] {
  const preset = PRESETS[presetId];
  const fit = staggerOrder(elements.filter((e) => presetAppliesTo(preset, e)), opts.order ?? 'reading');
  if (!fit.length) return [];
  const step = Math.max(0, round(opts.stagger ?? staggerFor(opts.motion)));
  const starts = fit.map((e) => sceneStart(e, opts.within));
  let base = opts.at ?? Math.min(...starts);
  if (preset.kind !== 'exit' && !preset.fromStart) {
    const earliest = Math.max(...starts.map((start, i) => start - i * step));
    const latest = Math.min(...fit.map((element, i) => starts[i] + element.durationInFrames - 2 - i * step));
    // Every arrival needs at least one frame for motion. Never clamp each
    // layer independently: that can reverse the requested reading order.
    if (earliest > latest) return [];
    base = clamp(base, earliest, latest);
  }
  return fit.map((element, i) => {
    const defaults = defaultPresetOptions(preset, element, { fps: opts.fps, intensity: opts.intensity, motion: opts.motion });
    const duration = opts.duration ?? defaults.duration;
    const at = preset.kind === 'exit'
      ? element.durationInFrames - 1 - duration - (fit.length - 1 - i) * step
      : base + i * step - starts[i];
    return { element, options: normalizeOptions(preset, element, { ...defaults, at: Math.max(0, at), duration }) };
  });
}

/**
 * The element without its current entrance, so a staggered entrance replaces
 * it instead of stacking a second arrival on top (fade in, fade out, fade in).
 *
 * The rule: the entrance is every key from the element's first key up to
 * `settledFrame` (the last key in its first third), and only counts when it
 * moves something (a property with two or more keys there). For a property
 * the new preset writes, all of those keys go: the preset's keys are its only
 * arrival, and the value holds the preset's first key until it starts. For
 * any other property the entrance's last key stays (the pose it settles in,
 * held from the start) and the keys before it go. Later keys (emphasis,
 * exits) are untouched. No entrance: the element is returned as is.
 */
export function withoutEntrance(element: Element, plan: PresetPlan): Element {
  const settled = settledFrame(element);
  const tracks = [...element.tracks.map((t) => t.keyframes), ...(element.propTracks ?? []).map((t) => t.keyframes)];
  if (!tracks.some((keys) => keys.filter((k) => k.frame <= settled).length >= 2)) return element;
  const written = new Set(plan.keys.map(keyOf));
  const strip = <K extends { frame: number }>(keys: K[], writes: boolean): K[] => {
    const inside = keys.filter((k) => k.frame <= settled);
    if (!inside.length) return keys;
    const pose = inside[inside.length - 1];
    return keys.filter((k) => k.frame > settled || (!writes && k === pose));
  };
  const nextTracks = element.tracks
    .map((t) => ({ ...t, keyframes: strip(t.keyframes, written.has(`track:${t.property}`)) }))
    .filter((t) => t.keyframes.length);
  const nextProps = element.propTracks
    ?.map((t) => ({ ...t, keyframes: strip(t.keyframes, written.has(`prop:${t.key}`)) }))
    .filter((t) => t.keyframes.length);
  return { ...element, tracks: nextTracks, ...(nextProps ? { propTracks: nextProps } : {}) };
}

/** Commands that turn `element` into `cleared` (a copy with some keys removed). */
function removalCommands(sceneId: string, element: Element, cleared: Element): Command[] {
  const ids = { sceneId, elementId: element.id };
  const commands: Command[] = [];
  for (const t of element.tracks) {
    const kept = cleared.tracks.find((c) => c.property === t.property)?.keyframes ?? [];
    for (const k of t.keyframes) if (!kept.some((c) => c.frame === k.frame)) commands.push({ type: 'removeKeyframe', ...ids, property: t.property, frame: k.frame });
  }
  for (const t of element.propTracks ?? []) {
    const kept = cleared.propTracks?.find((c) => c.key === t.key)?.keyframes ?? [];
    for (const k of t.keyframes) if (!kept.some((c) => c.frame === k.frame)) commands.push({ type: 'removePropertyKeyframe', ...ids, key: t.key, frame: k.frame });
  }
  return commands;
}

/** An entrance preset replaces the element's current entrance; other kinds keep every key outside their window. */
const replacesEntrance = (preset: MotionPreset) => preset.kind === 'enter' && !preset.fromStart;

/** Layers an arrive-apart stagger acts on: the multi-selection, else the selected group's direct children. */
export function staggerTargets(scene: Scene, selection: { elementId: string | null; elementIds: readonly string[] }): Element[] {
  if (selection.elementIds.length >= 2) return scene.elements.filter((e) => selection.elementIds.includes(e.id));
  const one = scene.elements.find((e) => e.id === selection.elementId);
  return one?.type === 'group' ? scene.elements.filter((e) => e.parentId === one.id) : [];
}

/**
 * applyStagger as commands for one scene (run them as ONE batch). Each layer
 * arrives once: a staggered entrance replaces the layer's current entrance
 * (see withoutEntrance) instead of adding a second one.
 */
export function applyStagger(elements: readonly Element[], presetId: PresetId, opts: StaggerOptions & { sceneId: string }): Command[] {
  const preset = PRESETS[presetId];
  return staggerPlan(elements, presetId, opts).flatMap(({ element, options }) => {
    const plan = planPreset(presetId, element, options);
    if (!plan) return [];
    const cleared = replacesEntrance(preset) ? withoutEntrance(element, plan) : element;
    return [...removalCommands(opts.sceneId, element, cleared), ...planCommands(opts.sceneId, cleared, plan)];
  });
}

/** applyStagger on elements not in a document yet; returns every element, in the order given. */
export function withStagger(elements: readonly Element[], presetId: PresetId, opts: StaggerOptions): Element[] {
  const preset = PRESETS[presetId];
  const planned = new Map(
    staggerPlan(elements, presetId, opts).map(({ element, options }) => {
      const plan = planPreset(presetId, element, options);
      if (!plan) return [element.id, element] as const;
      return [element.id, withPlan(replacesEntrance(preset) ? withoutEntrance(element, plan) : element, plan)] as const;
    }),
  );
  return elements.map((e) => planned.get(e.id) ?? e);
}

export type FollowFrom = 'left' | 'right' | 'top' | 'bottom';

export interface FollowThroughOptions {
  fps: number;
  /** Group-local frame the move starts (default 0). */
  at?: number;
  /** Frames the group travels (default 0.7 s, personality-scaled). */
  duration?: number;
  /** Side the group comes in from (default left). */
  from?: FollowFrom;
  intensity?: number;
  motion?: MotionPersonality;
}

/**
 * Follow-through: the group slides in 200 px and stops; its children trail
 * behind while it moves, carry on past the stop (each 2 frames after the one
 * before, swinging a little more), then settle. Children are additive x/y
 * offsets on top of the group's move, so the plain keys stay editable.
 */
export function followThroughPlan(group: Element, children: readonly Element[], opts: FollowThroughOptions): { element: Element; plan: PresetPlan }[] {
  if (group.type !== 'group' || group.durationInFrames < 2) return [];
  const intensity = clamp(opts.intensity ?? 1, 0.25, 2);
  const o: PresetOptions = { at: 0, duration: 1, intensity, fps: opts.fps, ...(opts.motion ? { motion: opts.motion } : {}) };
  const last = group.durationInFrames - 1;
  const at = clamp(round(opts.at ?? 0), 0, Math.max(0, last - 1));
  const travel = clamp(round(opts.duration ?? scaledFrames(0.7, opts.fps, opts.motion)), 1, last - at);
  const stop = at + travel;
  const from = opts.from ?? 'left';
  const axis: AnimatableProperty = from === 'left' || from === 'right' ? 'x' : 'y';
  const sign = from === 'left' || from === 'top' ? -1 : 1;
  const distance = 200 * intensity;
  const plans: { element: Element; plan: PresetPlan }[] = [{
    element: group,
    plan: { keys: [...ramp({ track: axis }, sign * distance, 0, at, stop, calmEnter(o)), ...ramp({ track: 'opacity' }, 0, 1, at, at + Math.max(1, round(travel * 0.35)), fadeIn(o))] },
  }];
  const [lagMin, lagMax] = PRINCIPLES.followThrough.lagFrames;
  const swing = Math.max(PRINCIPLES.followThrough.amplitude[0], opts.motion?.overshoot ?? 0.08);
  const settle = scaledFrames(0.3, opts.fps, opts.motion);
  staggerOrder(children.filter((c) => c.parentId === group.id && c.durationInFrames >= 2), 'reading').forEach((child, i) => {
    const delay = Math.min(lagMax * 2, lagMin * i);
    const passFrame = stop + delay;
    if (child.startFrame >= passFrame) return; // arrives after the move: nothing to carry
    const local = (f: number) => f - child.startFrame;
    const lag = distance * 0.1 * (1 + 0.2 * i);
    const over = distance * swing * (1 + 0.25 * i);
    plans.push({
      element: child,
      plan: insideLifetime(child, { keys: [
        { track: axis, frame: Math.max(0, local(at)), value: sign * lag, easing: 'easeInOut' },
        { track: axis, frame: local(passFrame), value: -sign * over, easing: 'easeInOut' },
        { track: axis, frame: local(passFrame + settle), value: 0 },
      ] }),
    });
  });
  return plans;
}

export function followThroughCommands(sceneId: string, group: Element, children: readonly Element[], opts: FollowThroughOptions): Command[] {
  return followThroughPlan(group, children, opts).flatMap(({ element, plan }) => planCommands(sceneId, element, plan));
}

/** followThrough on elements not in a document yet; returns every element given, group first. */
export function withFollowThrough(group: Element, children: readonly Element[], opts: FollowThroughOptions): Element[] {
  const planned = new Map(followThroughPlan(group, children, opts).map(({ element, plan }) => [element.id, withPlan(element, plan)]));
  return [group, ...children].map((e) => planned.get(e.id) ?? e);
}

export interface MatchCutEnd {
  sceneId: string;
  /** A top-level element: the outgoing one must end on its scene's last frame, the incoming one start on the first. */
  element: Element;
}

const isColour = (v: unknown): v is string => typeof v === 'string' && v !== 'none';

/**
 * A match cut that keeps the thread: the outgoing element accelerates halfway
 * to the incoming one's box (centre and size meet in the middle; colour
 * blends to the incoming colour), the incoming one starts exactly there and
 * decelerates into place. Same geometry and speed on both sides of the cut;
 * the incoming scene's transition becomes a hard cut. Empty when either
 * element is inside a group.
 */
export function matchCutCommands(out: MatchCutEnd, into: MatchCutEnd, opts: { fps: number; motion?: MotionPersonality; outFrames?: number; inFrames?: number }): Command[] {
  const a = out.element;
  const b = into.element;
  if (a.parentId || b.parentId || a.durationInFrames < 2 || b.durationInFrames < 2) return [];
  const o: PresetOptions = { at: 0, duration: 1, intensity: 1, fps: opts.fps, ...(opts.motion ? { motion: opts.motion } : {}) };
  const centre = (e: Element) => ({ x: e.transform.x + e.transform.width / 2, y: e.transform.y + e.transform.height / 2 });
  const size = (e: Element) => Math.sqrt(e.transform.width * e.transform.height) * e.transform.scale;
  const ca = centre(a);
  const cb = centre(b);
  const mid = { x: (ca.x + cb.x) / 2, y: (ca.y + cb.y) / 2, size: Math.sqrt(size(a) * size(b)) };
  const outLen = clamp(round(opts.outFrames ?? scaledFrames(0.4, opts.fps, opts.motion)), 1, a.durationInFrames - 1);
  const inLen = clamp(round(opts.inFrames ?? scaledFrames(0.5, opts.fps, opts.motion)), 1, b.durationInFrames - 1);
  const aLast = a.durationInFrames - 1;
  const aStart = aLast - outLen;
  const go = calmExit(o);
  const land = calmEnter(o);
  const outKeys: PresetKey[] = [
    ...ramp({ track: 'x' }, 0, round(mid.x - ca.x), aStart, aLast, go),
    ...ramp({ track: 'y' }, 0, round(mid.y - ca.y), aStart, aLast, go),
    ...ramp({ track: 'scale' }, 1, mid.size / size(a), aStart, aLast, go),
  ];
  const colourKey = a.type === 'text' ? 'color' : a.type === 'shape' ? 'fill' : null;
  const target = b.type === 'text' ? b.props.color : b.type === 'shape' ? b.props.fill : undefined;
  if (colourKey && isColour(a.props[colourKey]) && isColour(target) && a.props[colourKey] !== target) {
    const key = `props.${colourKey}`;
    outKeys.push({ prop: key, frame: aStart, value: a.props[colourKey] as string, easing: go }, { prop: key, frame: aLast, value: target });
  }
  const inKeys: PresetKey[] = [
    ...ramp({ track: 'x' }, round(mid.x - cb.x), 0, 0, inLen, land),
    ...ramp({ track: 'y' }, round(mid.y - cb.y), 0, 0, inLen, land),
    ...ramp({ track: 'scale' }, mid.size / size(b), 1, 0, inLen, land),
  ];
  return [
    ...planCommands(out.sceneId, a, { keys: outKeys }),
    ...planCommands(into.sceneId, b, { keys: inKeys, ...(b.type === 'text' && b.props.reveal !== 'none' ? { props: { reveal: 'none' } } : {}) }),
    { type: 'updateScene', sceneId: into.sceneId, changes: { transitionIn: { type: 'none', durationInFrames: 0 } } },
  ];
}
