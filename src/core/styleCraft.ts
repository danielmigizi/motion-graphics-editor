// House craft tokens: frame-level numbers the Pulse pack (and critique)
// uses so a fast, percussive style is a bar, not an error. Frames at 30 fps.
// Pulse is built from short pops, an irregular stagger, cuts that land just
// after the beat and small, calm type.

import type { StyleCraft, StylePack } from './types';

/** Fallback when a pack has no `craft` — today's motionRules defaults. */
export const DEFAULT_CRAFT: StyleCraft = {
  popFrames: { min: 6, max: 16 },
  staggerFrames: { min: 3, max: 6 },
  landCadence: 4,
  typeCharsPerFrame: 0,
  trueHoldMaxFrames: 15,
  driftPxPerFrame: 0,
  cameraFrames: { min: 24, max: 40 },
  spring: { fromScale: 1.12, frames: 12 },
  beatOffsetFrames: 0,
  beatOffsetWindow: 1,
  smear: { blurPx: 0, frames: 0 },
  typeHeightShare: { min: 0.07, max: 0.14 },
  maxEmptyShare: 0.5,
  readingHoldOnKeyLines: false,
};

/**
 * Pulse house bar. Pops 2–4 f, stagger 1–4 f irregular, land every 5 f,
 * type 1 char/f, one true hold ~46–50 f, constant drift, camera 66–96 f
 * ease-in-out, spring 3×→1 over 10 f, smear ~4 f, cuts +3 f after the beat,
 * calm type 3–4 % of frame height, lots of air.
 */
export const PULSE_CRAFT: StyleCraft = {
  popFrames: { min: 2, max: 4 },
  staggerFrames: { min: 1, max: 4 },
  landCadence: 5,
  typeCharsPerFrame: 1,
  trueHoldMaxFrames: 50,
  // 0.2 px/frame at 320 wide ≈ 1.2 px/frame at 1920.
  driftPxPerFrame: 1.2,
  cameraFrames: { min: 66, max: 96 },
  spring: { fromScale: 3, frames: 10 },
  beatOffsetFrames: 3,
  beatOffsetWindow: 2,
  smear: { blurPx: 18, frames: 4 },
  typeHeightShare: { min: 0.03, max: 0.07 },
  maxEmptyShare: 0.85,
  readingHoldOnKeyLines: true,
};

/** The pack agents should copy unless the brief names another. */
export const HOUSE_PACK_ID = 'pulse' as const;

export function craftOf(style: StylePack | undefined): StyleCraft {
  if (style?.craft) return style.craft;
  if (style?.id === HOUSE_PACK_ID) return PULSE_CRAFT;
  return DEFAULT_CRAFT;
}

/** One line for the guide and directed brief. */
export function craftLine(craft: StyleCraft): string {
  const pop = `${craft.popFrames.min}–${craft.popFrames.max}`;
  const stag = `${craft.staggerFrames.min}–${craft.staggerFrames.max}`;
  const cam = `${craft.cameraFrames.min}–${craft.cameraFrames.max}`;
  const type = `${Math.round(craft.typeHeightShare.min * 100)}–${Math.round(craft.typeHeightShare.max * 100)}`;
  const smear = craft.smear.frames > 0 ? ` smear ${craft.smear.blurPx} px / ${craft.smear.frames} f.` : '';
  return `Pops ${pop} f, stagger ${stag} f, land every ${craft.landCadence} f, type ${craft.typeCharsPerFrame || 'n/a'} char/f, camera ${cam} f ease-in-out, spring ${craft.spring.fromScale}×→1 over ${craft.spring.frames} f, cuts +${craft.beatOffsetFrames} f after the beat, type ${type} % of frame height.${smear}`;
}

export function isHousePack(style: StylePack | undefined): boolean {
  return style?.id === HOUSE_PACK_ID;
}
