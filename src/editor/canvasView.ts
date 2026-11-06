// Stage navigation: zoom and pan of the canvas. The view is editor state
// (store.view), never part of the document or history. One ViewTransform maps
// composition pixels to stage pixels; the Player and the overlay are both
// placed with it, so hit-testing and handles agree with the picture at every
// zoom.

import type { Point } from './geometry';

export const ZOOM_MIN = 0.1;
export const ZOOM_MAX = 8;
/** Space kept round the picture when it is fitted to the stage. */
export const FIT_MARGIN = 16;
/** Stage pixels of the picture that panning always leaves in view. */
const KEEP_VISIBLE = 64;
/** Zoom stops for the buttons and ⌘= / ⌘−. */
export const ZOOM_STEPS = [0.1, 0.125, 0.25, 1 / 3, 0.5, 2 / 3, 1, 1.5, 2, 3, 4, 6, 8];

export interface StageView {
  /** 'fit' follows the stage size; a number is a fixed scale (1 = 100%). */
  zoom: number | 'fit';
  /** Offset of the picture centre from the stage centre, in stage pixels (ignored when fitted). */
  panX: number;
  panY: number;
}

export const FIT_VIEW: StageView = { zoom: 'fit', panX: 0, panY: 0 };

export interface Size {
  width: number;
  height: number;
}

/** Composition → stage pixels: stage = (left, top) + comp × scale. */
export interface ViewTransform {
  scale: number;
  left: number;
  top: number;
}

export const clampZoom = (z: number) => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

export function fitScale(stage: Size, comp: Size): number {
  if (stage.width <= 0 || stage.height <= 0) return 0.3; // not measured yet
  return Math.max(0.02, Math.min((stage.width - 2 * FIT_MARGIN) / comp.width, (stage.height - 2 * FIT_MARGIN) / comp.height));
}

export function viewTransform(view: StageView, stage: Size, comp: Size): ViewTransform {
  const fitted = view.zoom === 'fit';
  const scale = fitted ? fitScale(stage, comp) : (view.zoom as number);
  return {
    scale,
    left: (stage.width - comp.width * scale) / 2 + (fitted ? 0 : view.panX),
    top: (stage.height - comp.height * scale) / 2 + (fitted ? 0 : view.panY),
  };
}

export const toComp = (t: ViewTransform, p: Point): Point => ({ x: (p.x - t.left) / t.scale, y: (p.y - t.top) / t.scale });
export const toStage = (t: ViewTransform, p: Point): Point => ({ x: t.left + p.x * t.scale, y: t.top + p.y * t.scale });

/** Keep at least a strip of the picture on the stage so it can't be panned out of reach. */
export function clampPan(view: StageView, stage: Size, comp: Size): StageView {
  if (view.zoom === 'fit') return view;
  const s = view.zoom;
  const clampAxis = (pan: number, stageLen: number, compLen: number) => {
    const len = compLen * s;
    const keep = Math.min(KEEP_VISIBLE, len, stageLen);
    const base = (stageLen - len) / 2;
    // left edge of the picture: base + pan ∈ [keep − len, stageLen − keep]
    return Math.min(stageLen - keep - base, Math.max(keep - len - base, pan));
  };
  return { zoom: s, panX: clampAxis(view.panX, stage.width, comp.width), panY: clampAxis(view.panY, stage.height, comp.height) };
}

/** Zoom to `scale`, keeping the composition point under `anchor` (stage px) where it is. */
export function zoomAbout(view: StageView, stage: Size, comp: Size, scale: number, anchor: Point): StageView {
  const t = viewTransform(view, stage, comp);
  const next = clampZoom(scale);
  const c = toComp(t, anchor);
  const left = anchor.x - c.x * next;
  const top = anchor.y - c.y * next;
  return clampPan({ zoom: next, panX: left - (stage.width - comp.width * next) / 2, panY: top - (stage.height - comp.height * next) / 2 }, stage, comp);
}

/** Move the picture by (dx, dy) stage pixels. A fitted view becomes a fixed one at the same scale. */
export function panBy(view: StageView, stage: Size, comp: Size, dx: number, dy: number): StageView {
  const t = viewTransform(view, stage, comp);
  const fitted = view.zoom === 'fit';
  return clampPan({ zoom: t.scale, panX: (fitted ? 0 : view.panX) + dx, panY: (fitted ? 0 : view.panY) + dy }, stage, comp);
}

/** The next zoom stop above (dir 1) or below (dir −1) the current scale. */
export function zoomStep(scale: number, dir: 1 | -1): number {
  if (dir > 0) return ZOOM_STEPS.find((z) => z > scale * 1.001) ?? ZOOM_MAX;
  return [...ZOOM_STEPS].reverse().find((z) => z < scale * 0.999) ?? ZOOM_MIN;
}

/** Scale factor for one wheel event with ⌘/Ctrl held (also trackpad pinch). */
export function wheelZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * 16 : deltaMode === 2 ? deltaY * 400 : deltaY;
  return Math.exp(Math.max(-0.25, Math.min(0.25, -px * 0.01)));
}

export const zoomLabel = (scale: number) => `${Math.round(scale * 100)}%`;
