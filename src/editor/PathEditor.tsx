// Path tools on the canvas (advanced editor): node editing of one path
// element, and the pen drawing new paths. While either is active one layer
// over the stage overlay takes the pointer; Space / middle-button panning and
// wheel zoom still reach the stage. Nodes are drawn through the path's world
// matrix and the view transform, so they sit on the picture at any zoom and
// inside rotated or scaled groups. Geometry is pure (pathEdit.ts, penTool.ts);
// each gesture is one command — updateElement { props: { nodes } } or one
// addElement — previewed through the store's transient element while dragging.

import React, { useEffect, useRef, useState } from 'react';
import { invertMatrix, multiplyMatrices, transformPoint, type Matrix } from '../core/animation';
import { COMPONENTS } from '../core/components';
import { newId } from '../core/ids';
import { pathData, svgNumber } from '../core/path';
import { sceneStartFrame } from '../core/timing';
import type { Element, PathNode, Scene } from '../core/types';
import { scopeOf } from './canvasTree';
import { toComp, toStage, type Size, type ViewTransform } from './canvasView';
import { guardLocked, localOf } from './editActions';
import { cornersOf, inverseLinear, round2, vectorIn, worldOf, type Point } from './geometry';
import {
  cycleNode,
  deleteNodes,
  fitBoxToPath,
  hitPath,
  insertNode,
  isSmooth,
  mapNodes,
  moveHandle,
  moveNodes,
  nodesInBox,
  pullHandles,
  roundNodes,
  toggleSmooth,
  type Cubic,
  type HandleKey,
  type PathHit,
} from './pathEdit';
import { constrain45, penCanFinish, penDrag, penGeometry, penPress, penUndoPoint, rubberBand } from './penTool';
import type { Box } from './snap';
import { useEditor, type CanvasTool, type GestureHandle, type PenDraft } from './store';

/** Stage pixels round a node or handle that a press hits. */
const NODE_HIT = 7;
/** Stage pixels either side of the outline where a click adds a node. */
const SEGMENT_HIT = 6;
/** Stage pixels round the pen's first node that close the path. */
const CLOSE_HIT = 9;
/** Pointer travel (stage px) before a press becomes a drag. */
const DRAG_SLOP = 3;
const NODE_SIZE = 9;
const HANDLE_R = 3.5;

export const PEN_NOTE = 'Pen: click to add points, drag for a curve, click the first point to close, Enter to finish';

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const nodesOf = (el: Element): PathNode[] => (Array.isArray(el.props.nodes) ? (el.props.nodes as PathNode[]) : []);
const closedOf = (el: Element) => el.props.closed === true;
const stageMatrix = (t: ViewTransform): Matrix => [t.scale, 0, 0, t.scale, t.left, t.top];
const count = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

function safeInvert(m: Matrix): Matrix | null {
  try {
    return invertMatrix(m);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Actions (keyboard, toolbar, the layer below)
// ---------------------------------------------------------------------------

interface PathTarget {
  scene: Scene;
  element: Element;
  nodes: PathNode[];
  closed: boolean;
  frameInScene: number;
}

/** The path being node-edited, from the committed document. */
function pathTarget(): PathTarget | null {
  const st = useEditor.getState();
  const pe = st.pathEdit;
  if (!pe) return null;
  const scene = st.doc.project.scenes.find((s) => s.id === pe.sceneId);
  const element = scene?.elements.find((e) => e.id === pe.elementId);
  if (!scene || !element || element.type !== 'path') return null;
  return { scene, element, nodes: nodesOf(element), closed: closedOf(element), frameInScene: st.playhead - sceneStartFrame(st.doc.project, scene.id) };
}

/** One undo step replacing the path's nodes (tidied to 0.01 px); optionally selects nodes afterwards. */
function commitNodes(target: PathTarget, nodes: PathNode[], label: string, select?: number[]): boolean {
  if (guardLocked(target.scene)) return false;
  const st = useEditor.getState();
  if (!st.run({ type: 'updateElement', sceneId: target.scene.id, elementId: target.element.id, changes: { props: { nodes: roundNodes(nodes) } } }, label)) return false;
  const pe = useEditor.getState().pathEdit;
  if (select && pe) useEditor.getState().setPathEdit({ ...pe, nodes: select });
  return true;
}

const selectNodes = (nodes: number[]) => {
  const st = useEditor.getState();
  if (st.pathEdit) st.setPathEdit({ ...st.pathEdit, nodes });
};

/** Enter, double-click or the toolbar on a selected path: edit its nodes. */
export function enterPathEdit(): boolean {
  const st = useEditor.getState();
  const scene = st.doc.project.scenes.find((s) => s.id === st.selection.sceneId);
  const el = scene?.elements.find((e) => e.id === st.selection.elementId);
  if (!scene || !el || el.type !== 'path') return false;
  if (guardLocked(scene)) return true;
  if (st.selection.elementIds.length > 1) st.selectElement(scene.id, el.id);
  st.setTool('select');
  st.setPathEdit({ sceneId: scene.id, elementId: el.id, nodes: [] });
  return true;
}

export const exitPathEdit = () => useEditor.getState().setPathEdit(null);

export function selectAllNodes(): void {
  const target = pathTarget();
  if (target) selectNodes(target.nodes.map((_, i) => i));
}

/** Tab / Shift+Tab: the next or previous node. */
export function cycleNodes(dir: 1 | -1): void {
  const target = pathTarget();
  const pe = useEditor.getState().pathEdit;
  if (!target || !pe) return;
  const i = cycleNode(pe.nodes, target.nodes.length, dir);
  if (i >= 0) selectNodes([i]);
}

export function deleteSelectedNodes(): boolean {
  const target = pathTarget();
  const sel = useEditor.getState().pathEdit?.nodes ?? [];
  if (!target || !sel.length) return false;
  const next = deleteNodes(target.nodes, sel);
  if (!next) {
    useEditor.getState().toast({ tone: 'info', message: 'A path keeps at least two nodes.', hint: 'To remove the whole path, press Enter to stop editing nodes, then Delete.' });
    return false;
  }
  return commitNodes(target, next, sel.length === 1 ? 'Delete node' : `Delete ${sel.length} nodes`, []);
}

/** Arrows: move the selected nodes by (dx, dy) on screen, whatever the path's rotation or scale. */
export function nudgeSelectedNodes(dx: number, dy: number): boolean {
  const target = pathTarget();
  const sel = useEditor.getState().pathEdit?.nodes ?? [];
  if (!target || !sel.length) return false;
  const w = worldOf(target.scene.elements, target.element, target.frameInScene);
  const d = vectorIn(inverseLinear(w.worldMatrix), { x: dx, y: dy });
  return commitNodes(target, moveNodes(target.nodes, sel, d), `Nudge ${count(sel.length, 'node', 'nodes')}`);
}

/** Toolbar: shrink or grow the box to the drawn curve, re-basing the nodes so nothing moves on screen. */
export function fitPathBox(): boolean {
  const target = pathTarget();
  if (!target || guardLocked(target.scene)) return false;
  const { element, scene } = target;
  // Rotation and scale act round the box centre: moving the centre is only
  // compensated for one rotation/scale, so an animated one would swing the
  // path on every other frame.
  const animated = element.tracks.find((tr) => (tr.property === 'rotation' || tr.property === 'scale') && new Set(tr.keyframes.map((k) => k.value)).size > 1);
  if (animated) {
    useEditor.getState().toast({
      tone: 'info',
      message: `Can’t fit the box while ${animated.property} is animated.`,
      hint: 'Fitting moves the centre it turns and scales round, which would shift the path on other frames.',
    });
    return false;
  }
  const ev = localOf(scene.elements, element, target.frameInScene);
  const fit = fitBoxToPath(target.nodes, target.closed, { ...element.transform, rotation: ev.rotation, scale: ev.scale });
  const tr = element.transform;
  const transform = { x: round2(fit.x), y: round2(fit.y), width: round2(fit.width), height: round2(fit.height) };
  const same = (a: number, b: number) => Math.abs(a - b) < 0.01;
  if (same(transform.x, tr.x) && same(transform.y, tr.y) && same(transform.width, tr.width) && same(transform.height, tr.height)) {
    useEditor.getState().toast({ tone: 'info', message: 'The box already fits the path.' });
    return false;
  }
  return useEditor.getState().run({ type: 'updateElement', sceneId: scene.id, elementId: element.id, changes: { transform, props: { nodes: roundNodes(fit.nodes) } } }, 'Fit box to path');
}

/** Next free "Path N" name in the scene. */
export function nextPathName(elements: readonly Element[]): string {
  const names = new Set(elements.map((e) => e.name));
  let n = elements.filter((e) => e.type === 'path').length + 1;
  while (names.has(`Path ${n}`)) n++;
  return `Path ${n}`;
}

/**
 * The element a finished pen path becomes: nodes mapped from composition
 * pixels into the parent group's space (top level when the group is gone),
 * box round the curve, default path props (closed shapes also get the shape
 * component's default fill), starting at the playhead and lasting to the end
 * of its parent. Null when the parent is scaled to nothing.
 */
export function penElement(scene: Scene, draft: PenDraft, frameInScene: number, closed: boolean): Element | null {
  const parent = draft.parentId ? (scene.elements.find((e) => e.id === draft.parentId && e.type === 'group') ?? null) : null;
  const pw = parent ? worldOf(scene.elements, parent, frameInScene) : null;
  const inv = pw ? safeInvert(pw.worldMatrix) : IDENTITY;
  if (!inv) return null;
  const geo = penGeometry(mapNodes(draft.nodes, inv), closed);
  const span = parent ? parent.durationInFrames : scene.durationInFrames;
  const startFrame = Math.max(0, Math.min(span - 1, Math.round(pw ? pw.localFrame : frameInScene)));
  return {
    id: newId('el'),
    type: 'path',
    name: nextPathName(scene.elements),
    startFrame,
    durationInFrames: Math.max(1, span - startFrame),
    visible: true,
    transform: { x: geo.x, y: geo.y, width: geo.width, height: geo.height, rotation: 0, scale: 1, opacity: 1 },
    props: { ...structuredClone(COMPONENTS.path.defaultProps), nodes: geo.nodes, closed, ...(closed ? { fill: COMPONENTS.shape.defaultProps.fill } : {}) },
    tracks: [],
    ...(parent ? { parentId: parent.id } : {}),
  };
}

/** Add the pen's path as one new element and select it (back to the Select tool). False when there's nothing to add. */
export function finishPen(closed: boolean): boolean {
  const st = useEditor.getState();
  const draft = st.penDraft;
  if (!draft) return false;
  st.setPenDraft(null);
  if (!penCanFinish(draft.nodes)) return false;
  const scene = st.doc.project.scenes.find((s) => s.id === draft.sceneId);
  if (!scene || guardLocked(scene)) return false;
  const element = penElement(scene, draft, st.playhead - sceneStartFrame(st.doc.project, scene.id), closed);
  if (!element) {
    st.toast({ tone: 'info', message: 'Can’t draw inside a group scaled to zero.' });
    return false;
  }
  if (!st.run({ type: 'addElement', sceneId: scene.id, element }, `Draw “${element.name}”`)) return false;
  const after = useEditor.getState();
  after.setTool('select');
  after.selectElement(scene.id, element.id);
  return true;
}

/** Enter / Esc with the pen: finish an open path of two or more nodes, else drop the stray point; Esc with nothing drawn returns to Select. */
export function endPen(escape: boolean): void {
  const st = useEditor.getState();
  const n = st.penDraft?.nodes.length ?? 0;
  if (n >= 2) finishPen(false);
  else if (n) st.setPenDraft(null);
  else if (escape) st.setTool('select');
}

/** Backspace with the pen: take back the last point. */
export function removeLastPenPoint(): void {
  const st = useEditor.getState();
  const d = st.penDraft;
  if (!d) return;
  const nodes = penUndoPoint(d.nodes);
  st.setPenDraft(nodes.length ? { ...d, nodes } : null);
}

/** V / P and the toolbar. Leaving the pen finishes its open path (two or more nodes). */
export function setCanvasTool(tool: CanvasTool): void {
  const st = useEditor.getState();
  if (st.tool === tool) return;
  if (st.tool === 'pen' && (st.penDraft?.nodes.length ?? 0) >= 2) finishPen(false);
  useEditor.getState().setTool(tool);
}

// ---------------------------------------------------------------------------
// The layer
// ---------------------------------------------------------------------------

interface NodeGestureBase {
  sceneId: string;
  element: Element;
  docSession: string;
  revision: number;
  startStage: Point;
  /** Stage → box pixels, and back, at the start of the gesture. */
  inv: Matrix;
  toScreen: Matrix;
  nodes: PathNode[];
  moved: boolean;
  edited: PathNode[] | null;
}

type Gesture =
  | (NodeGestureBase & { kind: 'nodes'; indices: number[]; clickOnly: number | null })
  | (NodeGestureBase & { kind: 'handle'; index: number; key: HandleKey })
  | (NodeGestureBase & { kind: 'pull'; index: number })
  | (NodeGestureBase & { kind: 'insert'; inserted: PathNode[]; index: number })
  | (NodeGestureBase & { kind: 'marquee'; keep: number[]; screen: Point[] })
  | { kind: 'pen'; startStage: Point; index: number; closing: boolean; nodes: PathNode[]; moved: boolean };

function gestureLabel(g: Gesture): string {
  switch (g.kind) {
    case 'nodes':
      return g.indices.length === 1 ? 'Move node' : `Move ${g.indices.length} nodes`;
    case 'handle':
      return 'Move handle';
    case 'pull':
      return 'Pull handles';
    case 'insert':
      return 'Add node';
    default:
      return '';
  }
}

function stale(g: NodeGestureBase): boolean {
  const st = useEditor.getState();
  return st.docSession !== g.docSession || st.doc.project.revision !== g.revision || st.pathEdit?.elementId !== g.element.id;
}

const fmt = (p: Point) => `${svgNumber(p.x, 2)} ${svgNumber(p.y, 2)}`;
const cubicD = (c: Cubic) => `M${fmt(c[0])} C${fmt(c[1])} ${fmt(c[2])} ${fmt(c[3])}`;

export interface PathEditorProps {
  t: ViewTransform;
  size: Size;
  /** The committed scene. */
  scene: Scene;
  /** The scene's elements as displayed (with any transient preview). */
  els: Element[];
  frameInScene: number;
}

export function PathEditor({ t, size, scene, els, frameInScene }: PathEditorProps) {
  const tool = useEditor((s) => s.tool);
  const pathEdit = useEditor((s) => s.pathEdit);
  const draft = useEditor((s) => s.penDraft);
  const primaryId = useEditor((s) => s.selection.elementId);
  const layerRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<Gesture | null>(null);
  /** The live gesture's registration with the store (the agent bridge waits for it). */
  const registered = useRef<GestureHandle | null>(null);
  const [pointer, setPointer] = useState<{ p: Point; shift: boolean } | null>(null);
  const [hover, setHover] = useState<PathHit | null>(null);
  const [marquee, setMarquee] = useState<Box | null>(null);

  // Node editing ends when its path stops being the selection or the scene changes; a draft never outlives its scene.
  useEffect(() => {
    const st = useEditor.getState();
    if (pathEdit && (pathEdit.sceneId !== scene.id || primaryId !== pathEdit.elementId)) st.setPathEdit(null);
    if (draft && draft.sceneId !== scene.id) st.setPenDraft(null);
  }, [pathEdit, draft, scene.id, primaryId]);

  const edited = tool === 'select' && pathEdit && pathEdit.sceneId === scene.id ? (els.find((e) => e.id === pathEdit.elementId && e.type === 'path') ?? null) : null;
  const editW = edited ? worldOf(els, edited, frameInScene) : null;
  const toScreen = editW ? multiplyMatrices(stageMatrix(t), editW.worldMatrix) : null;
  const fromScreen = toScreen ? safeInvert(toScreen) : null;
  const screenNodes = edited && toScreen ? mapNodes(nodesOf(edited), toScreen) : [];
  const closed = edited ? closedOf(edited) : false;
  const selected = pathEdit?.nodes ?? [];
  const draftNodes = tool === 'pen' && draft && draft.sceneId === scene.id ? mapNodes(draft.nodes, stageMatrix(t)) : null;

  const stagePt = (e: { clientX: number; clientY: number }): Point => {
    const r = layerRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const preview = (g: NodeGestureBase, nodes: PathNode[]) => useEditor.getState().setTransient({ sceneId: g.sceneId, element: { ...g.element, props: { ...g.element.props, nodes } } });

  const begin = (e: React.PointerEvent, g: Gesture) => {
    gesture.current = g;
    registered.current?.end();
    registered.current = useEditor.getState().beginGesture();
    layerRef.current?.setPointerCapture(e.pointerId);
  };

  /** The gesture is over (released, cancelled or abandoned). */
  const release = () => {
    gesture.current = null;
    registered.current?.end();
    registered.current = null;
  };

  const cancel = (e: React.PointerEvent) => {
    release();
    layerRef.current?.releasePointerCapture?.(e.pointerId);
    setMarquee(null);
    useEditor.getState().setTransient(null);
  };

  // Node editing ended mid-drag (Esc, Enter, P, another selection) or the layer
  // goes away: drop the gesture and its uncommitted preview, which would
  // otherwise stay on the stage (and keep the agent bridge waiting).
  const abandon = useRef(() => {});
  abandon.current = () => {
    const g = gesture.current;
    if (!g) return;
    release();
    setMarquee(null);
    if (g.kind !== 'pen' && g.kind !== 'marquee') useEditor.getState().setTransient(null);
  };
  useEffect(() => {
    const g = gesture.current;
    if (g && g.kind !== 'pen' && (tool !== 'select' || pathEdit?.elementId !== g.element.id)) abandon.current();
  }, [tool, pathEdit]);
  useEffect(() => () => abandon.current(), []);

  const penDown = (e: React.PointerEvent, sp: Point) => {
    const st = useEditor.getState();
    if (guardLocked(scene)) return;
    const d: PenDraft = st.penDraft && st.penDraft.sceneId === scene.id ? st.penDraft : { sceneId: scene.id, parentId: scopeOf(scene.elements, st.selection.elementId), nodes: [] };
    const r = penPress(d.nodes, toComp(t, sp), { tolerance: CLOSE_HIT / t.scale, constrain: e.shiftKey });
    st.setPenDraft({ ...d, nodes: r.nodes });
    begin(e, { kind: 'pen', startStage: sp, index: r.index, closing: r.action === 'close', nodes: r.nodes, moved: false });
  };

  const nodeDown = (e: React.PointerEvent, sp: Point) => {
    const st = useEditor.getState();
    const pe = st.pathEdit;
    const committed = pe ? scene.elements.find((x) => x.id === pe.elementId) : undefined;
    if (!pe || !committed || !toScreen || !fromScreen) return;
    const base: NodeGestureBase = {
      sceneId: scene.id,
      element: committed,
      docSession: st.docSession,
      revision: st.doc.project.revision,
      startStage: sp,
      inv: fromScreen,
      toScreen,
      nodes: nodesOf(committed),
      moved: false,
      edited: null,
    };
    const hit = hitPath(screenNodes, closed, sp, pe.nodes, NODE_HIT, SEGMENT_HIT);
    if (!hit) {
      if (!e.shiftKey) selectNodes([]);
      return begin(e, { ...base, kind: 'marquee', keep: e.shiftKey ? pe.nodes : [], screen: screenNodes });
    }
    if (hit.kind === 'handle') return begin(e, { ...base, kind: 'handle', index: hit.index, key: hit.key });
    if (hit.kind === 'segment') {
      if (guardLocked(scene)) return;
      const ins = insertNode(base.nodes, hit.segment, hit.t);
      selectNodes([ins.index]);
      preview(base, ins.nodes);
      return begin(e, { ...base, kind: 'insert', inserted: ins.nodes, index: ins.index });
    }
    const i = hit.index;
    if (e.altKey) {
      selectNodes([i]);
      return begin(e, { ...base, kind: 'pull', index: i });
    }
    if (e.shiftKey) {
      const had = pe.nodes.includes(i);
      const next = had ? pe.nodes.filter((n) => n !== i) : [...pe.nodes, i];
      selectNodes(next);
      if (!had) begin(e, { ...base, kind: 'nodes', indices: next, clickOnly: null });
      return;
    }
    if (!pe.nodes.includes(i)) {
      selectNodes([i]);
      return begin(e, { ...base, kind: 'nodes', indices: [i], clickOnly: null });
    }
    begin(e, { ...base, kind: 'nodes', indices: pe.nodes, clickOnly: pe.nodes.length > 1 ? i : null });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    // Middle button and the hand tool pan: let the stage have them.
    if (e.button !== 0 || useEditor.getState().handTool) return;
    e.stopPropagation();
    e.preventDefault();
    (layerRef.current?.closest('.stage-overlay') as HTMLElement | null)?.focus({ preventScroll: true });
    const sp = stagePt(e);
    if (tool === 'pen') penDown(e, sp);
    else if (edited) nodeDown(e, sp);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const sp = stagePt(e);
    const g = gesture.current;
    if (!g) {
      e.stopPropagation();
      setPointer({ p: sp, shift: e.shiftKey });
      setHover(edited && !useEditor.getState().handTool ? hitPath(screenNodes, closed, sp, selected, NODE_HIT, SEGMENT_HIT) : null);
      return;
    }
    e.stopPropagation();
    if (!g.moved) {
      if (Math.hypot(sp.x - g.startStage.x, sp.y - g.startStage.y) < DRAG_SLOP) return;
      g.moved = true;
      if (g.kind !== 'pen' && g.kind !== 'marquee' && guardLocked(scene)) return cancel(e);
    }
    if (g.kind === 'pen') {
      setPointer({ p: sp, shift: e.shiftKey });
      const d = useEditor.getState().penDraft;
      if (d) useEditor.getState().setPenDraft({ ...d, nodes: penDrag(g.nodes, g.index, toComp(t, sp), { constrain: e.shiftKey }) });
      return;
    }
    if (g.kind === 'marquee') {
      const box = { left: Math.min(g.startStage.x, sp.x), top: Math.min(g.startStage.y, sp.y), right: Math.max(g.startStage.x, sp.x), bottom: Math.max(g.startStage.y, sp.y) };
      setMarquee(box);
      selectNodes([...new Set([...g.keep, ...nodesInBox(g.screen, box)])]);
      return;
    }
    if (stale(g)) return cancel(e);
    const local = (p: Point) => transformPoint(g.inv, p);
    const startLocal = local(g.startStage);
    const roundPt = (p: Point) => ({ x: round2(p.x), y: round2(p.y) });
    // Shift keeps a node drag horizontal or vertical on screen.
    const dragged = () => {
      const d = { x: sp.x - g.startStage.x, y: sp.y - g.startStage.y };
      if (e.shiftKey) {
        if (Math.abs(d.x) >= Math.abs(d.y)) d.y = 0;
        else d.x = 0;
      }
      const to = local({ x: g.startStage.x + d.x, y: g.startStage.y + d.y });
      return { x: round2(to.x - startLocal.x), y: round2(to.y - startLocal.y) };
    };
    // Shift keeps a handle on 45° steps round its node, on screen.
    const handleAt = (index: number) => roundPt(local(e.shiftKey ? constrain45(transformPoint(g.toScreen, g.nodes[index]), sp) : sp));
    switch (g.kind) {
      case 'nodes':
        g.edited = moveNodes(g.nodes, g.indices, dragged());
        break;
      case 'handle':
        g.edited = moveHandle(g.nodes, g.index, g.key, handleAt(g.index), e.altKey);
        break;
      case 'pull':
        g.edited = pullHandles(g.nodes, g.index, handleAt(g.index));
        break;
      case 'insert':
        g.edited = moveNodes(g.inserted, [g.index], dragged());
        break;
    }
    if (g.edited) preview(g, g.edited);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    release();
    layerRef.current?.releasePointerCapture?.(e.pointerId);
    setMarquee(null);
    if (!g) return;
    e.stopPropagation();
    if (g.kind === 'pen') {
      if (g.closing) finishPen(true);
      return;
    }
    if (g.kind === 'marquee') return;
    if (g.kind === 'nodes' && !g.moved) {
      if (g.clickOnly !== null) selectNodes([g.clickOnly]);
      return;
    }
    if (g.kind !== 'insert' && !g.moved) return;
    const target = pathTarget();
    const nodes = g.kind === 'insert' && !g.edited ? g.inserted : g.edited;
    if (!target || !nodes || stale(g) || !commitNodes(target, nodes, gestureLabel(g), g.kind === 'insert' ? [g.index] : undefined)) useEditor.getState().setTransient(null);
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (useEditor.getState().handTool) return;
    if (tool === 'pen') {
      if (penCanFinish(useEditor.getState().penDraft?.nodes ?? [])) finishPen(false);
      return;
    }
    const target = pathTarget();
    if (!edited || !target) return;
    const hit = hitPath(screenNodes, closed, stagePt(e), [], NODE_HIT, SEGMENT_HIT);
    if (hit?.kind === 'node') {
      const smooth = isSmooth(target.nodes[hit.index]);
      commitNodes(target, toggleSmooth(target.nodes, hit.index, target.closed), smooth ? 'Make node a corner' : 'Make node smooth', [hit.index]);
    } else if (!hit) exitPathEdit();
  };

  const pts = (q: readonly Point[]) => q.map((p) => `${svgNumber(p.x, 2)},${svgNumber(p.y, 2)}`).join(' ');
  const square = (p: Point, key: string, className: string, testId?: string) => (
    <rect key={key} className={className} data-testid={testId} x={p.x - NODE_SIZE / 2} y={p.y - NODE_SIZE / 2} width={NODE_SIZE} height={NODE_SIZE} />
  );
  const handles = (nodes: PathNode[], indices: readonly number[], prefix: string) =>
    indices.flatMap((i) => {
      const n = nodes[i];
      if (!n) return [];
      return (['in', 'out'] as const).flatMap((key) => {
        const h = n[key];
        if (!h) return [];
        return [
          <line key={`${prefix}l${i}${key}`} className="path-handle-line" x1={n.x} y1={n.y} x2={h.x} y2={h.y} />,
          <circle key={`${prefix}h${i}${key}`} className="path-handle" data-testid={`${prefix}handle-${i}-${key}`} cx={h.x} cy={h.y} r={HANDLE_R} />,
        ];
      });
    });

  const penDragging = gesture.current?.kind === 'pen' && gesture.current.moved;
  const band = draftNodes && pointer && !penDragging ? rubberBand(draftNodes, pointer.p, { tolerance: CLOSE_HIT, constrain: pointer.shift }) : null;
  const hoverKind = hover?.kind ?? null;

  return (
    <div
      ref={layerRef}
      className={`path-layer ${tool === 'pen' ? 'is-pen' : ''}`}
      data-hover={hoverKind ?? undefined}
      data-testid="path-layer"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={cancel}
      onPointerLeave={() => {
        if (gesture.current) return;
        setPointer(null);
        setHover(null);
      }}
      onDoubleClick={onDoubleClick}
    >
      <svg className="stage-marks path-marks" width={size.width} height={size.height} aria-hidden>
        {editW && edited && (
          <g data-testid="path-nodes" data-element-id={edited.id}>
            <polygon className="mark-scope" points={pts(cornersOf(editW).map((p) => toStage(t, p)))} />
            <path className="path-outline" data-testid="path-outline" d={pathData(screenNodes, closed)} />
            {handles(screenNodes, selected, 'path-')}
            {hover?.kind === 'segment' && <circle className="path-insert" cx={hover.point.x} cy={hover.point.y} r={HANDLE_R + 0.5} />}
            {screenNodes.map((n, i) =>
              square(n, `n${i}`, `path-node ${selected.includes(i) ? 'selected' : ''} ${hover?.kind === 'node' && hover.index === i ? 'hover' : ''}`, `path-node-${i}`),
            )}
          </g>
        )}
        {draftNodes && (
          <g data-testid="pen-draft">
            {draftNodes.length > 1 && <path className="path-outline" d={pathData(draftNodes, false)} />}
            {band && <path className="path-rubber" data-testid="pen-rubber-band" d={cubicD(band.cubic)} />}
            {handles(draftNodes, draftNodes.length ? [draftNodes.length - 1] : [], 'pen-')}
            {band?.closing && <circle className="path-close-target" data-testid="pen-close-target" cx={draftNodes[0].x} cy={draftNodes[0].y} r={CLOSE_HIT} />}
            {draftNodes.map((n, i) => square(n, `d${i}`, `path-node ${i === draftNodes.length - 1 ? 'selected' : ''}`, `pen-node-${i}`))}
          </g>
        )}
        {marquee && <polygon className="mark-marquee" data-testid="node-marquee" points={pts([
          { x: marquee.left, y: marquee.top },
          { x: marquee.right, y: marquee.top },
          { x: marquee.right, y: marquee.bottom },
          { x: marquee.left, y: marquee.bottom },
        ])} />}
      </svg>
    </div>
  );
}

/** The stage's live note for the path tools (empty otherwise, so screen readers hear each change). */
export function PathToolNote() {
  const tool = useEditor((s) => s.tool);
  const draftCount = useEditor((s) => s.penDraft?.nodes.length ?? 0);
  const pathEdit = useEditor((s) => s.pathEdit);
  const edited = useEditor((s) => (s.pathEdit ? s.doc.project.scenes.find((x) => x.id === s.pathEdit!.sceneId)?.elements.find((e) => e.id === s.pathEdit!.elementId) : undefined));
  let text = '';
  if (tool === 'pen') {
    text = draftCount ? `Pen: ${count(draftCount, '1 point', 'points')} · click the first point to close · Enter or double-click to finish · Backspace removes the last point` : PEN_NOTE;
  } else if (pathEdit && edited) {
    const n = nodesOf(edited).length;
    const sel = pathEdit.nodes;
    const which = sel.length === 1 ? `node ${sel[0] + 1} of ${n}` : sel.length ? `${sel.length} of ${n} nodes` : `${n} nodes`;
    text = `Editing “${edited.name}”: ${which} · drag nodes or handles (Alt breaks a smooth pair) · click the outline to add · double-click toggles smooth · Tab cycles · Enter to finish`;
  }
  return (
    <div className="stage-note stage-tool-note" role="status" aria-live="polite" data-testid="path-tool-note">
      {text}
    </div>
  );
}
