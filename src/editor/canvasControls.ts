// Canvas controls shared by the stage, its toolbars and the global keyboard
// handler: view actions (zoom, fit, 100%) and the canvas shortcuts.
//
// Space is both play/pause and the hand tool. Over the stage, pressing Space
// arms the hand tool; releasing it without having dragged toggles playback,
// so a tap still plays. Everywhere else Space plays on key down as before.
//
// Path tools: P picks the pen, V the select tool. With the pen, Enter / Esc
// finish the open path and Backspace takes back a point; while a path's nodes
// are edited, Enter / Esc finish, Delete removes nodes, arrows nudge them, Tab
// cycles them and ⌘A selects them all.

import { create } from 'zustand';
import { FIT_VIEW, viewTransform, zoomAbout, zoomStep, type Size } from './canvasView';
import { cycleSelection, enterGroup, groupSelected, selectAllInScope, ungroupSelected } from './editActions';
import type { Point } from './geometry';
import { cycleNodes, deleteSelectedNodes, endPen, enterPathEdit, exitPathEdit, nudgeSelectedNodes, removeLastPenPoint, selectAllNodes, setCanvasTool } from './PathEditor';
import { togglePlayback } from './playback';
import { useEditor } from './store';

/** The stage's measured size: zoom actions anchor at its centre and the transport shows the zoom. */
export const useStageSize = create<Size>()(() => ({ width: 0, height: 0 }));
let pointerOverStage = false;
let spaceArmed = false;
let spacePanned = false;

/** The stage reports its measured size. */
export function registerStage(size: Size): void {
  useStageSize.setState(size);
}

export function setPointerOverStage(over: boolean): void {
  pointerOverStage = over;
}

/** A hand-tool drag happened: releasing Space must not toggle playback. */
export function notePan(): void {
  spacePanned = true;
}

export function releaseHandTool(): void {
  spaceArmed = false;
  useEditor.getState().setHandTool(false);
}

const compSize = (): Size => {
  const p = useEditor.getState().doc.project;
  return { width: p.width, height: p.height };
};

export function currentScale(): number {
  return viewTransform(useEditor.getState().view, useStageSize.getState(), compSize()).scale;
}

/** Zoom to `scale` about `anchor` (stage px; default: the stage centre). */
export function zoomTo(scale: number, anchor?: Point): void {
  const st = useEditor.getState();
  const stageSize = useStageSize.getState();
  st.setView(zoomAbout(st.view, stageSize, compSize(), scale, anchor ?? { x: stageSize.width / 2, y: stageSize.height / 2 }));
}

export const zoomBy = (dir: 1 | -1) => zoomTo(zoomStep(currentScale(), dir));
export const fitView = () => useEditor.getState().setView(FIT_VIEW);

/** Keyboard focus is on the page or the stage (not on a control that owns Tab/Enter). */
function onCanvas(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !el || el === document.body || !!el.closest?.('.stage');
}

/**
 * Canvas shortcuts. Returns true when the key was handled. The caller has
 * already skipped keys typed into fields.
 */
export function canvasKeyDown(e: KeyboardEvent): boolean {
  const st = useEditor.getState();
  const mod = e.metaKey || e.ctrlKey;
  if (!e.altKey) {
    if (mod && (e.key === '=' || e.key === '+')) return handled(e, () => zoomBy(1));
    if (mod && (e.key === '-' || e.key === '_')) return handled(e, () => zoomBy(-1));
    if (mod && !e.shiftKey && e.key === '0') return handled(e, () => zoomTo(1));
    if (!mod && e.shiftKey && e.code === 'Digit1') return handled(e, fitView);
    if (!mod && e.shiftKey && e.code === 'Digit0') return handled(e, () => zoomTo(1));
    if (!mod && e.key === ' ' && (pointerOverStage || spaceArmed)) {
      e.preventDefault();
      if (!spaceArmed) {
        spaceArmed = true;
        spacePanned = false;
        st.setHandTool(true);
      }
      return true;
    }
  }
  if (e.altKey) return false;
  if (pathKeyDown(e, mod)) return true;
  if (mod) {
    const k = e.key.toLowerCase();
    if (k === 'a') return handled(e, selectAllInScope);
    if (k === 'g') return handled(e, () => (e.shiftKey ? ungroupSelected() : groupSelected()));
    return false;
  }
  // Tab cycles only while something is selected, so Esc (clear) then Tab always leaves the canvas.
  if (e.key === 'Tab' && onCanvas(e.target) && st.selection.elementId) return handled(e, () => cycleSelection(e.shiftKey ? -1 : 1));
  if (e.key === 'Enter' && !e.shiftKey && onCanvas(e.target)) {
    // Nothing selected: start with the first element; a group: step inside it.
    if (!st.selection.elementId) return handled(e, () => cycleSelection(1));
    if (enterGroup() || enterPathEdit()) {
      e.preventDefault();
      return true;
    }
  }
  return false;
}

const ARROWS: Record<string, Point> = { ArrowLeft: { x: -1, y: 0 }, ArrowRight: { x: 1, y: 0 }, ArrowUp: { x: 0, y: -1 }, ArrowDown: { x: 0, y: 1 } };

/** Pen and node-editing keys (advanced editor, no Alt). */
function pathKeyDown(e: KeyboardEvent, mod: boolean): boolean {
  const st = useEditor.getState();
  if (st.tool === 'pen' && !mod) {
    if (e.key === 'Enter' || e.key === 'Escape') return handled(e, () => endPen(e.key === 'Escape'));
    if (e.key === 'Backspace' || e.key === 'Delete') return handled(e, removeLastPenPoint);
  }
  if (st.pathEdit) {
    if (mod) return e.key.toLowerCase() === 'a' ? handled(e, selectAllNodes) : false;
    if (e.key === 'Escape' || (e.key === 'Enter' && onCanvas(e.target))) return handled(e, exitPathEdit);
    if (e.key === 'Delete' || e.key === 'Backspace') return handled(e, deleteSelectedNodes);
    if (e.key === 'Tab' && onCanvas(e.target)) return handled(e, () => cycleNodes(e.shiftKey ? -1 : 1));
    const arrow = ARROWS[e.key];
    // Arrows move nodes, never the whole path, while its nodes are edited.
    if (arrow) return handled(e, () => nudgeSelectedNodes(arrow.x * (e.shiftKey ? 10 : 1), arrow.y * (e.shiftKey ? 10 : 1)));
  }
  if (mod || e.shiftKey) return false;
  if (e.key === 'p' || e.key === 'P') return handled(e, () => setCanvasTool('pen'));
  if (e.key === 'v' || e.key === 'V') return handled(e, () => setCanvasTool('select'));
  return false;
}

export function canvasKeyUp(e: KeyboardEvent): boolean {
  if (e.key !== ' ' || !spaceArmed) return false;
  releaseHandTool();
  if (!spacePanned) togglePlayback(e);
  return true;
}

function handled(e: KeyboardEvent, fn: () => unknown): true {
  e.preventDefault();
  fn();
  return true;
}
