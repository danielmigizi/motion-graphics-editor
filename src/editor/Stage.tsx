// Centre stage: the controlled <Player> (src/runtime/Player.tsx) plus the selection overlay.
// One view transform (zoom / pan, canvasView.ts) places the picture; the
// overlay draws in stage pixels through the same transform and reads world
// geometry (evaluateElementWorld), so outlines, handles and hit-testing match
// the rendered picture at every zoom, including children of rotated groups.
// Right-click opens the element's or the canvas's menu (ContextMenu.tsx).

import React, { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { transformPoint, type WorldElement } from '../core/animation';
import { projectDurationInFrames, sceneStartFrame } from '../core/timing';
import type { Element } from '../core/types';
import { MainComposition } from '../composition/MainComposition';
import type { MainCompositionProps } from '../composition/types';
import { notePan, registerStage, releaseHandTool, setPointerOverStage } from './canvasControls';
import { openContextMenu } from './ContextMenu';
import { ancestorsOf, canvasSelection, childrenOf, enterTarget, hitTestElements, isCanvasLocked, pickTarget, scopeOf } from './canvasTree';
import { panBy, toComp, toStage, viewTransform, wheelZoomFactor, zoomAbout, type StageView } from './canvasView';
import { commitEdits, guardLocked, localFrameInRange, localOf, modeStatus, offsetEdits, previewEdit, scaleSelectionEdits, type GeometryEdit, type GestureItem } from './editActions';
import {
  angleOf,
  boxQuad,
  containsWorld,
  cornersOf,
  hitTestDeep,
  normalizeAngle,
  parentInverse,
  pointsBounds,
  polygonsIntersect,
  rotate,
  rotationFor,
  round2,
  withTransient,
  worldCentre,
  worldOf,
  type Point,
} from './geometry';
import { enterPathEdit, PathEditor, PathToolNote } from './PathEditor';
import { Player, type PlayerRef } from '../runtime';
import { registerPlayer } from './playback';
import { workAreaLoopProps } from './timelineView';
import { ProposalPill } from './ProposalReview';
import { useProposals } from './proposals';
import { boxUnion, offsetBox, snapMove, SNAP_PX, type Box, type Guide } from './snap';
import { useCurrentScene, useEditor, type EditMode } from './store';

const HANDLES: { hx: -1 | 0 | 1; hy: -1 | 0 | 1 }[] = [
  { hx: -1, hy: -1 },
  { hx: 0, hy: -1 },
  { hx: 1, hy: -1 },
  { hx: 1, hy: 0 },
  { hx: 1, hy: 1 },
  { hx: 0, hy: 1 },
  { hx: -1, hy: 1 },
  { hx: -1, hy: 0 },
];

/** Stage pixels from the top edge to the rotation handle. */
const ROTATE_OFFSET = 22;
/** Pointer travel (stage px) before a press becomes a drag. */
const DRAG_SLOP = 3;
const NO_ELEMENTS: Element[] = [];

/** A committed element as a gesture sees it at its start. */
type Item = GestureItem;

interface GestureBase {
  sceneId: string;
  docSession: string;
  revision: number;
  editMode: EditMode;
  selectionKey: string;
  startStage: Point;
  start: Point;
  moved: boolean;
  edits: GeometryEdit[];
}

type Gesture = GestureBase &
  (
    | { kind: 'move'; items: Item[]; box: Box; targets: Box[]; clickId: string | null }
    | { kind: 'resize'; item: Item; hx: number; hy: number }
    | { kind: 'scale'; item: Item }
    | { kind: 'rotate'; item: Item; last: number; swept: number }
    | { kind: 'scaleSelection'; items: Item[]; anchor: Point; handle: Point; hx: number; hy: number }
    | { kind: 'marquee'; scope: string | null; base: string[] }
    | { kind: 'pan'; view: StageView }
  );

/**
 * A gesture is only valid against the document state it started from. If the
 * document changed underneath it (undo/redo via keyboard, another document
 * opened, an AI patch applied), the selection changed, or the edit mode
 * flipped, committing would apply stale geometry to the new state.
 */
function gestureIsStale(g: GestureBase): boolean {
  const st = useEditor.getState();
  return (
    st.docSession !== g.docSession ||
    st.doc.project.revision !== g.revision ||
    st.selection.sceneId !== g.sceneId ||
    st.selection.elementIds.join(',') !== g.selectionKey ||
    st.editMode !== g.editMode
  );
}

function gestureLabel(g: Gesture): string {
  const animate = g.editMode === 'animate';
  switch (g.kind) {
    case 'move':
      return animate ? 'Key position' : g.items.length === 1 ? 'Move element' : `Move ${g.items.length} elements`;
    case 'resize':
      return 'Resize element';
    case 'scale':
      return animate ? 'Key scale' : `Scale “${g.item.element.name}”`;
    case 'rotate':
      return animate ? 'Key rotation' : 'Rotate element';
    case 'scaleSelection':
      return `Scale ${g.items.length} elements`;
    default:
      return '';
  }
}

/** Resize cursor for a handle, from its direction out of the element centre. */
function cursorFor(from: Point, to: Point): string {
  const a = (((angleOf(from, to) % 180) + 180) % 180);
  return a < 22.5 || a >= 157.5 ? 'ew-resize' : a < 67.5 ? 'nwse-resize' : a < 112.5 ? 'ns-resize' : 'nesw-resize';
}

const inside = (b: Box, p: Point) => p.x >= b.left && p.x <= b.right && p.y >= b.top && p.y <= b.bottom;

export function Stage() {
  const project = useEditor((s) => s.doc.project);
  const transient = useEditor((s) => s.transient);
  const playhead = useEditor((s) => s.playhead);
  const seekNonce = useEditor((s) => s.seekNonce);
  const playing = useEditor((s) => s.playing);
  const editMode = useEditor((s) => s.editMode);
  const selection = useEditor((s) => s.selection);
  const view = useEditor((s) => s.view);
  const handTool = useEditor((s) => s.handTool);
  const tool = useEditor((s) => s.tool);
  const pathEdit = useEditor((s) => s.pathEdit);
  const workArea = useEditor((s) => s.workArea);
  const loopWorkArea = useEditor((s) => s.loopWorkArea);
  const scene = useCurrentScene();
  // Pen or node editing: PathEditor's layer takes the pointer and the selection handles step aside.
  const pathTool = tool === 'pen' || !!pathEdit;

  const display = useMemo(() => withTransient(project, transient), [project, transient]);
  const inputProps = useMemo<MainCompositionProps>(() => ({ project: display, assetBaseUrl: '/', editorMode: true }), [display]);

  const playerRef = useRef<PlayerRef>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [guides, setGuides] = useState<Guide[]>([]);
  const [marquee, setMarquee] = useState<Box | null>(null);
  const [panning, setPanning] = useState(false);
  const gesture = useRef<Gesture | null>(null);
  /** True while the store's playhead is being pushed into the Player (seekTo). */
  const seeking = useRef(false);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize({ width: entry.contentRect.width, height: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => registerStage(size), [size]);

  // Hand tool: never left armed when the window loses focus or the stage goes away.
  useEffect(() => {
    window.addEventListener('blur', releaseHandTool);
    return () => {
      window.removeEventListener('blur', releaseHandTool);
      setPointerOverStage(false);
      releaseHandTool();
    };
  }, []);

  // ⌘/Ctrl + wheel (and trackpad pinch) zooms about the pointer; plain wheel pans a zoomed view.
  // Native listener: React's wheel handler is passive and can't stop the page zooming.
  useEffect(() => {
    const el = overlayRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const st = useEditor.getState();
      const r = wrapRef.current!.getBoundingClientRect();
      const stage = { width: r.width, height: r.height };
      const comp = { width: st.doc.project.width, height: st.doc.project.height };
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const s = viewTransform(st.view, stage, comp).scale;
        st.setView(zoomAbout(st.view, stage, comp, s * wheelZoomFactor(e.deltaY, e.deltaMode), { x: e.clientX - r.left, y: e.clientY - r.top }));
      } else if (st.view.zoom !== 'fit') {
        e.preventDefault();
        st.setView(panBy(st.view, stage, comp, -e.deltaX, -e.deltaY));
      }
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Player → store
  useEffect(() => {
    const p = playerRef.current;
    registerPlayer(p);
    if (!p) return;
    const { syncPlayhead, setPlaying } = useEditor.getState();
    // While paused the store owns the playhead (seek → seekTo). Late frameupdate
    // events from earlier seeks would otherwise overwrite rapid frame steps.
    const onFrame = (e: { detail: { frame: number } }) => {
      if (p.isPlaying()) syncPlayhead(e.detail.frame);
    };
    const onPlay = () => setPlaying(true);
    // A store seek (seekTo below) pauses a playing Player first: the store
    // already holds the target frame, so the old frame must not be synced back.
    const onPause = () => {
      if (!seeking.current) syncPlayhead(p.getCurrentFrame());
      setPlaying(false);
    };
    // Only playback running off the end stops there, on the last frame; a
    // store seek to the last frame (End key, scrubbing) is not the end of playback.
    const onEnded = () => {
      if (seeking.current) return;
      const st = useEditor.getState();
      setPlaying(false);
      st.seek(projectDurationInFrames(st.doc.project) - 1);
    };
    p.addEventListener('frameupdate', onFrame);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    p.addEventListener('ended', onEnded);
    return () => {
      p.removeEventListener('frameupdate', onFrame);
      p.removeEventListener('play', onPlay);
      p.removeEventListener('pause', onPause);
      p.removeEventListener('ended', onEnded);
      registerPlayer(null);
    };
  }, []);

  // Store → player
  // The proposal review registers its own player while it is open (the review
  // plays under Space); the stage takes playback back when the review closes.
  const reviewing = useProposals((s) => s.open && !!s.proposal);
  useEffect(() => {
    if (!reviewing) registerPlayer(playerRef.current);
  }, [reviewing]);

  useEffect(() => {
    const p = playerRef.current;
    if (!p || p.getCurrentFrame() === useEditor.getState().playhead) return;
    seeking.current = true;
    try {
      p.seekTo(useEditor.getState().playhead);
    } finally {
      seeking.current = false;
    }
  }, [seekNonce]);
  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    // Starting playback happens in togglePlayback (user gesture); the store only pauses here.
    if (!playing && p.isPlaying()) p.pause();
  }, [playing]);

  const W = project.width;
  const H = project.height;
  const comp = { width: W, height: H };
  const t = viewTransform(view, size, comp);
  const sceneStart = scene ? sceneStartFrame(display, scene.id) : 0;
  const frameInScene = playhead - sceneStart;
  const displayScene = scene ? (display.scenes.find((s) => s.id === scene.id) ?? null) : null;
  const els = displayScene?.elements ?? NO_ELEMENTS;
  const world = (el: Element) => worldOf(els, el, frameInScene);

  const selectedIds = scene && selection.sceneId === scene.id ? selection.elementIds : [];
  const selWorlds = selectedIds.flatMap((id) => {
    const el = els.find((e) => e.id === id);
    return el ? [{ el, w: world(el) }] : [];
  });
  const primary = selWorlds.find((x) => x.el.id === selection.elementId) ?? null;
  const activeSel = selWorlds.filter((x) => x.w.active);
  const movableIds = new Set(canvasSelection(els, selectedIds).map((el) => el.id));
  const movableSel = activeSel.filter((x) => movableIds.has(x.el.id));
  const selBounds = movableSel.length > 1 ? boxUnion(movableSel.map((x) => pointsBounds(cornersOf(x.w)))) : null;
  const hovered = hoverId && !pathTool && !selectedIds.includes(hoverId) ? els.find((e) => e.id === hoverId) : undefined;
  const hoverW = hovered ? world(hovered) : null;

  const scr = (p: Point) => toStage(t, p);
  const pts = (q: readonly Point[]) =>
    q
      .map((p) => {
        const s = scr(p);
        return `${round2(s.x)},${round2(s.y)}`;
      })
      .join(' ');

  // -------------------------------------------------------------------------
  // Gestures
  // -------------------------------------------------------------------------

  const stagePt = (e: { clientX: number; clientY: number }): Point => {
    const r = wrapRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const gestureBase = (sp: Point): GestureBase => {
    const st = useEditor.getState();
    return {
      sceneId: scene!.id,
      docSession: st.docSession,
      revision: st.doc.project.revision,
      editMode: st.editMode,
      selectionKey: st.selection.elementIds.join(','),
      startStage: sp,
      start: toComp(t, sp),
      moved: false,
      edits: [],
    };
  };

  const itemOf = (el: Element): Item => {
    const all = scene!.elements;
    return { element: el, ev: localOf(all, el, frameInScene), world: worldOf(all, el, frameInScene), inv: parentInverse(all, el, frameInScene) };
  };

  const start = (e: React.PointerEvent, g: Gesture) => {
    gesture.current = g;
    overlayRef.current?.setPointerCapture(e.pointerId);
  };

  const clear = () => {
    setGuides([]);
    setMarquee(null);
    setPanning(false);
  };

  const cancel = (e: React.PointerEvent) => {
    gesture.current = null;
    overlayRef.current?.releasePointerCapture?.(e.pointerId);
    clear();
    useEditor.getState().setTransient(null);
  };

  const beginMove = (e: React.PointerEvent, sp: Point, clickId: string | null) => {
    if (!scene) return;
    const st = useEditor.getState();
    const animate = st.editMode === 'animate';
    const items = canvasSelection(scene.elements, st.selection.elementIds)
      .map(itemOf)
      .filter((i) => !animate || localFrameInRange(i.element, i.ev.localFrame));
    if (!items.length) return;
    const moving = new Set(items.map((i) => i.element.id));
    // Snap to the canvas and to the other elements at the same level.
    const siblings = childrenOf(scene.elements, scopeOf(scene.elements, st.selection.elementId)).filter((el) => !moving.has(el.id));
    const targets = [
      { left: 0, top: 0, right: W, bottom: H },
      ...siblings.map((el) => worldOf(scene.elements, el, frameInScene)).filter((w) => w.active).map((w) => pointsBounds(cornersOf(w))),
    ];
    const box = boxUnion(items.map((i) => pointsBounds(cornersOf(i.world))));
    start(e, { ...gestureBase(sp), kind: 'move', items, box, targets, clickId });
  };

  const beginMarquee = (e: React.PointerEvent, sp: Point, base: string[]) => {
    const st = useEditor.getState();
    start(e, { ...gestureBase(sp), kind: 'marquee', scope: scopeOf(els, st.selection.elementId), base });
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!scene || !displayScene) return;
    const sp = stagePt(e);
    const st = useEditor.getState();
    if (e.button === 1 || (e.button === 0 && st.handTool)) {
      e.preventDefault();
      setPanning(true);
      start(e, { ...gestureBase(sp), kind: 'pan', view: st.view });
      return;
    }
    if (e.button !== 0) return;
    // No text selection or native drag (Shift-click would start one and cancel the gesture).
    e.preventDefault();
    // Keyboard shortcuts (Tab, Enter, arrows) follow the canvas once it is clicked.
    overlayRef.current?.focus({ preventScroll: true });
    const pt = toComp(t, sp);
    const sel = selection.sceneId === scene.id ? selection.elementIds : [];
    const hit = hitTestDeep(hitTestElements(els), frameInScene, pt);
    const target = hit ? pickTarget(els, hit, scopeOf(els, st.selection.elementId)) : null;
    if (e.shiftKey) {
      if (!target) return beginMarquee(e, sp, sel);
      st.toggleElement(scene.id, target.id);
      if (useEditor.getState().selection.elementIds.includes(target.id)) beginMove(e, sp, null);
      return;
    }
    // A press on the selection drags it; a click there without dragging selects what is on top.
    if (movableSel.some((x) => containsWorld(x.w, pt)) || (selBounds && inside(selBounds, pt))) {
      const reselect = target && !(sel.length === 1 && sel[0] === target.id) ? target.id : null;
      return beginMove(e, sp, reselect);
    }
    if (target) {
      st.selectElement(scene.id, target.id);
      return beginMove(e, sp, null);
    }
    st.selectElement(scene.id, null);
    beginMarquee(e, sp, []);
  };

  const beginHandle = (e: React.PointerEvent, kind: 'resize' | 'scale' | 'rotate', hx = 0, hy = 0) => {
    if (e.button !== 0 || !scene) return;
    e.stopPropagation();
    const committed = scene.elements.find((x) => x.id === selection.elementId);
    if (!committed || isCanvasLocked(scene.elements, committed)) return;
    const item = itemOf(committed);
    if (editMode === 'animate' && !localFrameInRange(committed, item.ev.localFrame)) return;
    const b = gestureBase(stagePt(e));
    if (kind === 'rotate') start(e, { ...b, kind, item, last: angleOf(worldCentre(item.world), b.start), swept: 0 });
    else if (kind === 'scale') start(e, { ...b, kind, item });
    else start(e, { ...b, kind, item, hx, hy });
  };

  const beginScaleSelection = (e: React.PointerEvent, hx: number, hy: number) => {
    if (e.button !== 0 || !scene || !selBounds) return;
    e.stopPropagation();
    const pick = (h: number, lo: number, hi: number) => (h < 0 ? lo : h > 0 ? hi : (lo + hi) / 2);
    const items = canvasSelection(scene.elements, selection.elementIds).map(itemOf);
    if (!items.length) return;
    start(e, {
      ...gestureBase(stagePt(e)),
      kind: 'scaleSelection',
      items,
      hx,
      hy,
      handle: { x: pick(hx, selBounds.left, selBounds.right), y: pick(hy, selBounds.top, selBounds.bottom) },
      anchor: { x: pick(-hx, selBounds.left, selBounds.right), y: pick(-hy, selBounds.top, selBounds.bottom) },
    });
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gesture.current;
    const sp = stagePt(e);
    if (!g) {
      if (!displayScene || useEditor.getState().handTool) return;
      const hit = hitTestDeep(hitTestElements(els), frameInScene, toComp(t, sp));
      setHoverId(hit ? pickTarget(els, hit, scopeOf(els, useEditor.getState().selection.elementId)).id : null);
      return;
    }
    if (g.kind === 'pan') {
      notePan();
      useEditor.getState().setView(panBy(g.view, size, comp, sp.x - g.startStage.x, sp.y - g.startStage.y));
      return;
    }
    if (!g.moved) {
      if (Math.hypot(sp.x - g.startStage.x, sp.y - g.startStage.y) < DRAG_SLOP) return;
      g.moved = true;
      if (g.kind !== 'marquee' && scene && guardLocked(scene)) return cancel(e);
    }
    if (g.kind !== 'marquee' && gestureIsStale(g)) return cancel(e);
    const pt = toComp(t, sp);
    const animate = g.editMode === 'animate';
    switch (g.kind) {
      case 'marquee': {
        const box = { left: Math.min(g.start.x, pt.x), top: Math.min(g.start.y, pt.y), right: Math.max(g.start.x, pt.x), bottom: Math.max(g.start.y, pt.y) };
        setMarquee(box);
        const quad = boxQuad(box);
        const hits = childrenOf(els, g.scope)
          .filter((el) => {
            const w = world(el);
            return w.active && !el.locked && polygonsIntersect(cornersOf(w), quad);
          })
          .map((el) => el.id);
        useEditor.getState().selectMany(g.sceneId, [...g.base, ...hits]);
        return;
      }
      case 'move': {
        let dx = pt.x - g.start.x;
        let dy = pt.y - g.start.y;
        // Shift keeps the drag horizontal or vertical.
        const lockX = e.shiftKey && Math.abs(dy) > Math.abs(dx);
        const lockY = e.shiftKey && !lockX;
        if (lockX) dx = 0;
        if (lockY) dy = 0;
        let lines: Guide[] = [];
        // ⌘/Ctrl held: no snapping.
        if (!(e.metaKey || e.ctrlKey)) {
          const s = snapMove(offsetBox(g.box, dx, dy), g.targets, SNAP_PX / t.scale);
          if (!lockX) dx += s.dx;
          if (!lockY) dy += s.dy;
          lines = s.guides.filter((gd) => (gd.axis === 'x' ? !lockX : !lockY));
        }
        setGuides(lines);
        g.edits = offsetEdits(scene!.elements, frameInScene, g.items.map((i) => ({ element: i.element, dx, dy })), animate, true);
        break;
      }
      case 'resize': {
        const { element: el, ev, inv } = g.item;
        const base = el.transform;
        // Work in the parent's space, where the element's own values live.
        const a = transformPoint(inv, g.start);
        const b = transformPoint(inv, pt);
        const s = ev.scale || 1;
        const local = rotate({ x: b.x - a.x, y: b.y - a.y }, -ev.rotation);
        let w = Math.max(1, base.width + (g.hx * local.x) / s);
        let h = Math.max(1, base.height + (g.hy * local.y) / s);
        if (e.shiftKey) {
          const ratio = base.width / base.height;
          if (g.hx && g.hy) {
            const k = Math.max(w / base.width, h / base.height);
            w = base.width * k;
            h = base.height * k;
          } else if (g.hx) h = w / ratio;
          else w = h * ratio;
        }
        w = Math.round(w);
        h = Math.round(h);
        // Keep the opposite edge fixed on screen: shift the centre along the element axes.
        const shift = rotate({ x: (g.hx * (w - base.width) * s) / 2, y: (g.hy * (h - base.height) * s) / 2 }, ev.rotation);
        const r = el.parentId ? round2 : Math.round;
        const cx = ev.x + ev.width / 2 + shift.x;
        const cy = ev.y + ev.height / 2 + shift.y;
        g.edits = [{ element: el, localFrame: ev.localFrame, base: { width: w, height: h, x: r(cx - w / 2 - (ev.x - base.x)), y: r(cy - h / 2 - (ev.y - base.y)) } }];
        break;
      }
      case 'scale': {
        // Uniform scale about the centre, from the pointer's distance to it.
        const { element: el, ev, world: w } = g.item;
        const c = worldCentre(w);
        const d0 = Math.hypot(g.start.x - c.x, g.start.y - c.y) || 1;
        const fs = round2(Math.max(0.01, ev.scale * (Math.hypot(pt.x - c.x, pt.y - c.y) / d0)));
        g.edits = [
          animate
            ? { element: el, localFrame: ev.localFrame, keys: { scale: fs } }
            : { element: el, localFrame: ev.localFrame, base: { scale: ev.scale ? round2((el.transform.scale * fs) / ev.scale) : el.transform.scale } },
        ];
        break;
      }
      case 'rotate': {
        const { element: el, ev, world: w } = g.item;
        const a = angleOf(worldCentre(w), pt);
        g.swept += normalizeAngle(a - g.last);
        g.last = a;
        const r = rotationFor(ev.rotation, g.swept, e.shiftKey);
        g.edits = [
          animate
            ? { element: el, localFrame: ev.localFrame, keys: { rotation: r } }
            : { element: el, localFrame: ev.localFrame, base: { rotation: round2(el.transform.rotation + r - ev.rotation) } },
        ];
        break;
      }
      case 'scaleSelection': {
        // One factor for the whole selection, anchored at the opposite handle.
        const v0 = { x: g.handle.x - g.anchor.x, y: g.handle.y - g.anchor.y };
        const v1 = { x: pt.x - g.anchor.x, y: pt.y - g.anchor.y };
        const raw = g.hx && g.hy ? (v1.x * v0.x + v1.y * v0.y) / (v0.x * v0.x + v0.y * v0.y || 1) : g.hx ? v1.x / (v0.x || 1) : v1.y / (v0.y || 1);
        const k = Math.max(0.02, raw);
        g.edits = scaleSelectionEdits(g.items, g.anchor, k);
        break;
      }
    }
    const previews = g.edits.map(previewEdit);
    if (previews.length) useEditor.getState().setTransient({ sceneId: g.sceneId, element: previews[0], others: previews.slice(1) });
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const g = gesture.current;
    gesture.current = null;
    overlayRef.current?.releasePointerCapture?.(e.pointerId);
    clear();
    const st = useEditor.getState();
    if (!g || g.kind === 'pan' || g.kind === 'marquee') return;
    if (!g.moved) {
      if (g.kind === 'move' && g.clickId && scene) st.selectElement(scene.id, g.clickId);
      return;
    }
    if (!scene || gestureIsStale(g) || !commitEdits(scene, g.edits, gestureLabel(g))) st.setTransient(null);
  };

  // Right-click: an element not yet selected becomes the selection (a press on the selection keeps it), then its menu; empty canvas, the canvas's.
  const onContextMenu = (e: React.MouseEvent) => {
    const st = useEditor.getState();
    const pt = toComp(t, stagePt(e));
    const hit = scene && !pathTool ? hitTestDeep(hitTestElements(els), frameInScene, pt) : null;
    const target = hit ? pickTarget(els, hit, scopeOf(els, st.selection.elementId)) : null;
    const onSelection = activeSel.some((x) => containsWorld(x.w, pt)) || (!!selBounds && inside(selBounds, pt));
    if (scene && target && !onSelection && !selectedIds.includes(target.id)) st.selectElement(scene.id, target.id);
    openContextMenu(e, target || onSelection ? 'element' : 'canvas');
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (!scene || useEditor.getState().handTool) return;
    const hit = hitTestDeep(hitTestElements(els), frameInScene, toComp(t, stagePt(e)));
    if (!hit) return;
    const st = useEditor.getState();
    const next = enterTarget(els, hit, st.selection.elementId, scopeOf(els, st.selection.elementId));
    if (next.id !== st.selection.elementId) st.selectElement(scene.id, next.id);
    // Double-clicking the selected path edits its nodes.
    else if (next.type === 'path') enterPathEdit();
  };

  // -------------------------------------------------------------------------
  // Overlay
  // -------------------------------------------------------------------------

  const single = selectedIds.length === 1 && primary?.w.active ? primary : null;
  const editable = !!scene && !scene.locked && !pathTool;
  const scaleOnly = !!single && (editMode === 'animate' || single.el.type === 'group');
  const handleAt = (w: WorldElement, hx: number, hy: number) => scr(transformPoint(w.worldMatrix, { x: ((hx + 1) / 2) * w.width, y: ((hy + 1) / 2) * w.height }));
  const singleCentre = single ? scr(worldCentre(single.w)) : null;
  const topMid = single ? handleAt(single.w, 0, -1) : null;
  const up = single ? rotate({ x: 0, y: -1 }, single.w.rotation) : null;
  const rotHandle = topMid && up ? { x: topMid.x + up.x * ROTATE_OFFSET, y: topMid.y + up.y * ROTATE_OFFSET } : null;
  const crumbs = primary ? ancestorsOf(els, primary.el).reverse() : [];
  // Inside a group, its outline stays faintly visible as context.
  const scopeEl = crumbs[crumbs.length - 1];
  const scopeW = scopeEl ? world(scopeEl) : null;

  return (
    <div className={`stage ${editMode === 'animate' ? 'is-animate' : ''}`} ref={wrapRef} onPointerEnter={() => setPointerOverStage(true)} onPointerLeave={() => setPointerOverStage(false)}>
      <div className="stage-viewport">
        <div className="stage-frame" style={{ left: t.left, top: t.top, width: W * t.scale, height: H * t.scale }}>
          <Player
            ref={playerRef}
            component={MainComposition}
            inputProps={inputProps}
            durationInFrames={Math.max(1, projectDurationInFrames(display))}
            {...workAreaLoopProps(workArea, projectDurationInFrames(display), loopWorkArea)}
            moveToBeginningWhenEnded={false}
            fps={display.fps}
            compositionWidth={W}
            compositionHeight={H}
            style={{ width: W * t.scale, height: H * t.scale }}
            clickToPlay={false}
          />
        </div>
        <div
          ref={overlayRef}
          className={`stage-overlay ${handTool ? 'hand' : ''} ${panning ? 'panning' : ''}`}
          data-testid="stage-overlay"
          tabIndex={0}
          aria-label="Canvas. Click to select, Shift-click to add, drag to move. Enter selects the first element, steps into a group or edits a path’s nodes; Tab and Shift+Tab cycle; arrows nudge; P draws with the pen, V selects; Esc steps out, then clears so Tab leaves the canvas."

          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={cancel}
          onPointerLeave={() => !gesture.current && setHoverId(null)}
          onDoubleClick={onDoubleClick}
          onContextMenu={onContextMenu}
          onAuxClick={(e) => e.button === 1 && e.preventDefault()}
        >
          <svg className="stage-marks" width={size.width} height={size.height} aria-hidden>
            {scopeW?.active && <polygon className="mark-scope" data-testid="scope-outline" points={pts(cornersOf(scopeW))} />}
            {hoverW?.active && <polygon className="mark-hover" points={pts(cornersOf(hoverW))} />}
            {activeSel.filter(({ el }) => el.id !== pathEdit?.elementId).map(({ el, w }) => (
              <polygon
                key={el.id}
                className={`mark-selected ${el.id === selection.elementId ? 'primary' : ''}`}
                data-testid={el.id === selection.elementId ? 'selection-box' : 'selection-member'}
                data-element-id={el.id}
                points={pts(cornersOf(w))}
              />
            ))}
            {selBounds && <polygon className="mark-bounds" data-testid="selection-bounds" points={pts(boxQuad(selBounds))} />}
            {single && editable && topMid && rotHandle && <line className="mark-stem" x1={topMid.x} y1={topMid.y} x2={rotHandle.x} y2={rotHandle.y} />}
            {guides.map((g, i) => {
              const a = scr(g.axis === 'x' ? { x: g.at, y: g.from } : { x: g.from, y: g.at });
              const b = scr(g.axis === 'x' ? { x: g.at, y: g.to } : { x: g.to, y: g.at });
              return <line key={i} className="mark-guide" data-testid="snap-guide" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />;
            })}
            {marquee && <polygon className="mark-marquee" data-testid="marquee" points={pts(boxQuad(marquee))} />}
          </svg>
          {single &&
            editable &&
            singleCentre &&
            HANDLES.map((h) => {
              const p = handleAt(single.w, h.hx, h.hy);
              return (
                <div
                  key={`${h.hx},${h.hy}`}
                  className="handle"
                  data-testid={`handle-${h.hx}_${h.hy}`}
                  title={scaleOnly ? (editMode === 'animate' ? 'Drag to key scale' : 'Drag to scale the group') : 'Drag to resize (Shift keeps proportions)'}
                  style={{ left: p.x, top: p.y, transform: `translate(-50%, -50%) rotate(${single.w.rotation}deg)`, cursor: cursorFor(singleCentre, p) }}
                  onPointerDown={(e) => beginHandle(e, scaleOnly ? 'scale' : 'resize', h.hx, h.hy)}
                />
              );
            })}
          {single && editable && rotHandle && (
            <div
              className="handle rotate-handle"
              data-testid="handle-rotate"
              title={editMode === 'animate' ? 'Drag to key rotation (Shift: 15° steps)' : 'Drag to rotate (Shift: 15° steps)'}
              style={{ left: rotHandle.x, top: rotHandle.y }}
              onPointerDown={(e) => beginHandle(e, 'rotate')}
            />
          )}
          {selBounds &&
            editable &&
            editMode === 'layout' &&
            HANDLES.map((h) => {
              const p = scr({ x: h.hx < 0 ? selBounds.left : h.hx > 0 ? selBounds.right : (selBounds.left + selBounds.right) / 2, y: h.hy < 0 ? selBounds.top : h.hy > 0 ? selBounds.bottom : (selBounds.top + selBounds.bottom) / 2 });
              const c = scr({ x: (selBounds.left + selBounds.right) / 2, y: (selBounds.top + selBounds.bottom) / 2 });
              return (
                <div
                  key={`b${h.hx},${h.hy}`}
                  className="handle"
                  data-testid={`bounds-handle-${h.hx}_${h.hy}`}
                  title="Drag to scale the selection"
                  style={{ left: p.x, top: p.y, cursor: cursorFor(c, p) }}
                  onPointerDown={(e) => beginScaleSelection(e, h.hx, h.hy)}
                />
              );
            })}
          {pathTool && scene && <PathEditor t={t} size={size} scene={scene} els={els} frameInScene={frameInScene} />}
        </div>
      </div>
      {crumbs.length > 0 && scene && (
        <nav className="stage-crumbs" aria-label="Group path" data-testid="stage-crumbs">
          <button onClick={() => useEditor.getState().selectElement(scene.id, null)} title="Back to the scene’s top level">
            {scene.name}
          </button>
          {crumbs.map((g) => (
            <Fragment key={g.id}>
              <span className="stage-crumbs-sep" aria-hidden>
                ›
              </span>
              <button onClick={() => useEditor.getState().selectElement(scene.id, g.id)} title={`Select “${g.name}”`}>
                {g.name}
              </button>
            </Fragment>
          ))}
          <span className="stage-crumbs-hint">{pathEdit ? 'Esc: done editing nodes' : 'Esc goes up'}</span>
        </nav>
      )}
      {primary && !primary.w.active && !pathTool && <div className="stage-note">“{primary.el.name}” is not on screen at this frame</div>}
      <PathToolNote />
      {editMode === 'animate' && <div className="stage-mode-flag">{modeStatus('animate', playhead, project.fps)}</div>}
      <ProposalPill />
    </div>
  );
}
