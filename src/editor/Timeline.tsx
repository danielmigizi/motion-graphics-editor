// Advanced timeline: the precision editor's view of time.
//
// The whole project on one zoomable scale (fit project → 8 px per frame) in a
// horizontally scrolling track area:
// - an adaptive ruler (click / drag seeks to the exact frame; Shift snaps to
//   markers), the work area bar (in / out, B / N; loops when "Loop work area"
//   is on), and project markers (M adds, drag moves, double-click renames,
//   × deletes);
// - scene blocks in their scene colours, then each scene as a raised group
//   row over its layers: a type icon and lock / hidden marks on each track
//   header, and a bar filled with the type's clip colour (move / trim,
//   snapping; a locked layer's bar only selects);
// - every animated track of the selected element with its keys: click,
//   Shift-click and marquee select; drag to retime (snaps to frames, the
//   playhead and markers); ⌘C / ⌘V / Delete; double-click a segment for the
//   curve editor (CurveEditor.tsx);
// - music and sound-effect lanes with waveforms, move / trim, fade handles at
//   the top corners, a volume line, and "Mark beats".
// Right-click a scene, a layer, its bar or a key for its menu (ContextMenu.tsx).
// Zoom and scroll are view state and never touch the document. Every edit
// commits ONE command or batch on release (one undo step). Pure math lives
// in timelineView.ts, keyframes.ts, waveform.ts and simpleTimelineEdits.ts.

import React, { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { videoPreviewSrc } from '../composition/previewProxies';
import { COMPONENTS } from '../core/components';
import { audioClipStartFrame, formatTimecode, projectDurationInFrames, resolveAssetUrl, sceneStartFrame, sceneStartFrames } from '../core/timing';
import type { AudioClip, Command, Element, Marker, Scene } from '../core/types';
import { ancestorsOf, isCanvasLocked } from './canvasTree';
import { openContextMenu, openElementMenu, openSceneMenu } from './ContextMenu';
import { CurveEditor, type CurveMode } from './CurveEditor';
import { guardLocked, ownsTimelineKeys, shortcutLabel } from './editActions';
import { CommitText } from './fields';
import { Icon } from './icons';
import { ELEMENT_ICON } from './InspectorColumn';
import {
  allKeyFrames,
  animatedTracks,
  clampRetime,
  copyKeys,
  deleteKeys,
  easingLabel,
  hasKey,
  keyframesOf,
  liveKeys,
  pasteKeys,
  retimeKeys,
  toggleKey,
  type KeyClipboard,
  type KeyRef,
  type TrackInfo,
} from './keyframes';
import { useLayout } from './layout';
import { useProposals } from './proposals';
import { followPointer } from './SimpleTimeline';
import { audioSpanChanges, clamp, dragAudioSpan, dragElementSpan, packRows, snapFrame, SNAP_PX, type EdgeMode } from './simpleTimelineEdits';
import { useCurrentScene, useEditor } from './store';
import {
  clampPxPerFrame,
  CLIP_COLOR,
  contentWidth,
  dragWorkArea,
  fitPxPerFrame,
  fitRange,
  frameAtX,
  frameX,
  resolveWorkArea,
  revealFrame,
  rulerTicks,
  sceneAccent,
  setWorkAreaEdge,
  stepTo,
  tickFrames,
  tickLabel,
  TRACK_PAD_PX,
  ZOOM_SLIDER_MAX,
  ZOOM_STEP,
  zoomAbout,
  zoomAtSliderPos,
  zoomPercent,
  zoomSliderPos,
  type TimelineView,
  type WorkArea,
} from './timelineView';
import { addMarkerAtPlayhead, newMarker } from './Transport';
import { ClipWaveform, detectOnsets, loadPeaks } from './waveform';
import { trimVideoSpan, videoProps } from '../core/video';
import { sourceRangeLabel, VideoBarWave } from './VideoTimeline';

/** Width of the sticky label column (the track headers: icon, name, state). */
const LABEL_W = 200;
/** Track-header indents: a layer's icon one step in from its scene's (which follows the caret), 12 px more per group level; its key rows under its name. */
const LAYER_INDENT = 44;
const DEPTH_INDENT = 12;
const NAME_INDENT = LAYER_INDENT + 20;
/** Height of one audio clip row (matches .tl-audio rows in styles.css). */
const AUDIO_ROW = 46;
/** Inset of the volume line inside an audio clip (px), so 0 % and 100 % stay grabbable. */
const ENV_PAD = 5;
/** Beats are capped per run so a noisy file cannot flood the ruler. */
const MAX_BEATS = 200;
/** Timeline height (drag its top edge): a view preference, kept per browser. */
const HEIGHT_KEY = 'mge.timelineHeight';
const HEIGHT_MIN = 170;

function applyTimelineHeight(px: number) {
  document.documentElement.style.setProperty('--tl-height', `${Math.round(px)}px`);
}

type CSSVars = CSSProperties & Record<`--${string}`, string | number>;
type AudioMode = EdgeMode | 'fadeIn' | 'fadeOut' | 'volume';

/** Keys copied with ⌘C (session only; pasted onto the selected element with ⌘V). */
let keyClipboard: KeyClipboard | null = null;

export const hasCopiedKeys = () => keyClipboard !== null;

/** Scene-relative start of an element: its own start plus its parent groups' starts. */
function sceneRelStart(scene: Scene, el: Element): number {
  let frame = el.startFrame;
  let parent = el.parentId;
  for (let guard = 0; parent && guard < 64; guard++) {
    const p = scene.elements.find((e) => e.id === parent);
    if (!p) break;
    frame += p.startFrame;
    parent = p.parentId;
  }
  return frame;
}

function depthOf(scene: Scene, el: Element): number {
  let depth = 0;
  let parent = el.parentId;
  for (; parent && depth < 16; depth++) parent = scene.elements.find((e) => e.id === parent)?.parentId;
  return depth;
}

/** Where the selection's keys live: the selected element and its absolute start frame. */
function keyContext() {
  const st = useEditor.getState();
  const project = st.doc.project;
  const scene = project.scenes.find((s) => s.id === st.selection.sceneId);
  const element = scene?.elements.find((e) => e.id === st.selection.elementId);
  if (!scene || !element) return null;
  return { st, project, scene, element, base: sceneStartFrame(project, scene.id) + sceneRelStart(scene, element) };
}

/** The segment the curve editor opens on: the first selected key's (or the one ending there), else the first segment. */
function curveTarget(element: Element, keys: readonly KeyRef[]): KeyRef | null {
  const eased = animatedTracks(element).filter((t) => t.eased && t.keyframes.length > 1);
  for (const k of keys) {
    const ks = eased.find((t) => t.track === k.track)?.keyframes;
    const i = ks ? ks.findIndex((x) => x.frame === k.frame) : -1;
    if (!ks || i < 0) continue;
    if (i < ks.length - 1) return k;
    return { track: k.track, frame: ks[i - 1].frame };
  }
  return eased.length ? { track: eased[0].track, frame: eased[0].keyframes[0].frame } : null;
}

/** The mounted timeline's curve editor, for the keyframe right-click menu (actions.ts); null while the timeline is closed. */
let curveOpener: ((target: KeyRef) => void) | null = null;

/** The segment the curve editor opens on for the selected keys, as the Curve… button would. */
function selectedCurveTarget(): KeyRef | null {
  const ctx = keyContext();
  return ctx ? curveTarget(ctx.element, liveKeys(ctx.element, ctx.st.selectedKeyframes)) : null;
}

export const canOpenCurveEditor = () => !!curveOpener && !!selectedCurveTarget();

export function openCurveEditor(): boolean {
  const target = selectedCurveTarget();
  if (!curveOpener || !target) return false;
  curveOpener(target);
  return true;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

// ---------------------------------------------------------------------------
// Keyboard (advanced timeline keys; capture phase so they win over App's handler
// only when they apply)
// ---------------------------------------------------------------------------

function jumpKey(dir: -1 | 1) {
  const ctx = keyContext();
  const st = useEditor.getState();
  const frames = ctx ? allKeyFrames(ctx.element).map((f) => ctx.base + f) : st.doc.project.markers.map((m) => m.frame);
  const to = stepTo(frames, st.playhead, dir);
  if (to === null) return;
  st.setPlaying(false);
  st.seek(to);
  // Land with the keys at that frame selected, so Delete / ⌘C work from the keyboard.
  if (ctx) st.selectKeyframes(animatedTracks(ctx.element).flatMap((t) => t.keyframes.filter((k) => ctx.base + k.frame === to).map((k) => ({ track: t.track, frame: k.frame }))));
}

export function copySelectedKeys(): boolean {
  const ctx = keyContext();
  if (!ctx) return false;
  const clip = copyKeys(ctx.element, ctx.st.selectedKeyframes);
  if (!clip) return false;
  keyClipboard = clip;
  ctx.st.toast({ tone: 'info', message: `Copied ${plural(clip.entries.length, 'key')}`, hint: 'Move the playhead and press ⌘V to paste onto the selected element.' });
  return true;
}

export function pasteKeysAtPlayhead(): boolean {
  const ctx = keyContext();
  if (!ctx || !keyClipboard) return false;
  const { st, scene, element } = ctx;
  if (guardLocked(scene)) return true;
  const at = st.playhead - ctx.base;
  if (at < 0 || at >= element.durationInFrames) {
    st.toast({ tone: 'info', message: `Move the playhead inside “${element.name}” to paste keys.` });
    return true;
  }
  const r = pasteKeys(scene.id, element, keyClipboard, at);
  if (!r.commands.length) {
    st.toast({ tone: 'info', message: `“${element.name}” has none of the copied properties.` });
    return true;
  }
  const label = `Pasted ${plural(r.keys.length, 'key')} on “${element.name}”`;
  if (st.run({ type: 'batch', label, commands: r.commands }, label)) st.selectKeyframes(r.keys);
  if (r.skipped) st.toast({ tone: 'info', message: `${plural(r.skipped, 'key')} skipped`, hint: `“${element.name}” cannot take those properties or values.` });
  return true;
}

/** Delete / Backspace on selected keys. Not while the pen draws or nodes are edited: those keys are theirs then (canvasKeyDown). */
export function deleteSelectedKeys(): boolean {
  const st = useEditor.getState();
  if (st.tool === 'pen' || st.pathEdit) return false;
  const ctx = keyContext();
  if (!ctx) return false;
  const cmds = deleteKeys(ctx.scene.id, ctx.element, ctx.st.selectedKeyframes);
  if (!cmds.length) return false;
  if (guardLocked(ctx.scene)) return true;
  const label = `Deleted ${plural(cmds.length, 'key')} on “${ctx.element.name}”`;
  if (ctx.st.run({ type: 'batch', label, commands: cmds }, label)) ctx.st.selectKeyframes([]);
  return true;
}

/**
 * "Mark beats": decode the clip's audio, then add a marker on every onset
 * inside the clip (one undo step). Decoding is async, so the result applies
 * only to the document session it started in, at the frame rate its peaks
 * were computed for, from the same audio file; otherwise it is dropped.
 */
export async function markBeats(clipId: string, load: typeof loadPeaks = loadPeaks): Promise<void> {
  const st0 = useEditor.getState();
  const before = st0.doc.project;
  const clip0 = before.audio.find((c) => c.id === clipId);
  const asset0 = clip0 ? before.assets[clip0.assetId] : undefined;
  if (!clip0 || !asset0) return;
  const { docSession } = st0;
  const { fps } = before;
  const { src } = asset0;
  const peaks = await load(resolveAssetUrl('/', src), fps);
  const st = useEditor.getState();
  // Another document (even one with the same clip ids): nothing of this run applies.
  if (st.docSession !== docSession) return;
  const p = st.doc.project;
  const clip = p.audio.find((c) => c.id === clipId);
  if (!clip) return;
  // Peaks index frames at `fps`, of `src`.
  if (p.fps !== fps || clip.assetId !== clip0.assetId || p.assets[clip.assetId]?.src !== src) {
    st.toast({ tone: 'info', message: `“${clip.name}” changed while listening for beats`, hint: 'The frame rate or the clip’s audio file changed. Run Mark beats again.' });
    return;
  }
  if (!peaks) {
    st.toast({ tone: 'error', message: `Couldn’t decode “${clip.name}”`, hint: 'Check the file in Assets; WAV, MP3, OGG and AAC decode in the browser.' });
    return;
  }
  const start = audioClipStartFrame(p, clip);
  const end = projectDurationInFrames(p);
  const existing = p.markers.map((m) => m.frame);
  const frames = detectOnsets(peaks, fps)
    .filter((f) => f >= clip.trimStartFrames && f < clip.trimStartFrames + clip.durationInFrames)
    .map((f) => start + f - clip.trimStartFrames)
    .filter((f) => f >= 0 && f < end && !existing.some((m) => Math.abs(m - f) <= 1))
    .slice(0, MAX_BEATS);
  if (!frames.length) {
    st.toast({ tone: 'info', message: `No new beats found in “${clip.name}”` });
    return;
  }
  // Number on from earlier runs so labels stay unique.
  const prior = p.markers.filter((m) => /^Beat \d+$/.test(m.label)).length;
  const commands: Command[] = frames.map((f, i) => ({ type: 'setMarker', marker: newMarker(f, `Beat ${prior + i + 1}`) }));
  const label = `Marked ${plural(frames.length, 'beat')} in “${clip.name}”`;
  st.run({ type: 'batch', label, commands }, label);
}

export function setWorkAreaAtPlayhead(edge: 'start' | 'end') {
  const st = useEditor.getState();
  const total = projectDurationInFrames(st.doc.project);
  st.setWorkArea(setWorkAreaEdge(resolveWorkArea(st.workArea, total), edge, st.playhead, total));
}

// ---------------------------------------------------------------------------
// The timeline
// ---------------------------------------------------------------------------

interface CurveState {
  elementId: string;
  track: string;
  frame: number;
  mode: CurveMode;
}

export function Timeline() {
  const project = useEditor((s) => s.doc.project);
  const selElementId = useEditor((s) => s.selection.elementId);
  const selectedKeys = useEditor((s) => s.selectedKeyframes);
  const storedWorkArea = useEditor((s) => s.workArea);
  const scene = useCurrentScene();
  const total = Math.max(1, projectDurationInFrames(project));
  const fps = project.fps;
  const starts = sceneStartFrames(project);
  const sceneStart = scene ? sceneStartFrame(project, scene.id) : 0;
  const selectedEl = scene?.elements.find((e) => e.id === selElementId) ?? null;

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const [viewW, setViewW] = useState(900);
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const fit = fitPxPerFrame(total, viewW);
  const ppf = zoom === 'fit' ? fit : clampPxPerFrame(zoom, fit);
  const contentW = contentWidth(total, ppf);
  const x = (f: number) => frameX(f, ppf);
  const pendingScroll = useRef<number | null>(null);
  const [scrollWin, setScrollWin] = useState(0);
  const geo = useRef({ ppf, fit, total, viewW });
  geo.current = { ppf, fit, total, viewW };

  // Gesture previews (never in the document until release).
  const [barDrag, setBarDrag] = useState<{ elementId: string; start: number; dur: number; trim?: number } | null>(null);
  const [keyDelta, setKeyDelta] = useState<number | null>(null);
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [markerDrag, setMarkerDrag] = useState<{ id: string; frame: number } | null>(null);
  const [audioPreview, setAudioPreview] = useState<{ clipId: string; changes: Partial<AudioClip>; readout: string } | null>(null);
  const [snapAt, setSnapAt] = useState<number | null>(null);
  // Local selection of timeline-only things.
  const [selectedMarker, setSelectedMarker] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [selectedClip, setSelectedClip] = useState<string | null>(null);
  const [curve, setCurve] = useState<CurveState | null>(null);
  const [beatsBusy, setBeatsBusy] = useState(false);
  // The current scene is disclosed into its layers unless the user folded it.
  const [collapsed, setCollapsed] = useState<string | null>(null);
  const expanded = !!scene && collapsed !== scene.id;

  const keys = selectedEl ? liveKeys(selectedEl, selectedKeys) : [];
  const curveOpen = curve && selectedEl?.id === curve.elementId && keyframesOf(selectedEl, curve.track).some((k) => k.frame === curve.frame) ? curve : null;
  const curveFor = selectedEl ? curveTarget(selectedEl, keys) : null;
  const workArea = resolveWorkArea(storedWorkArea, total);

  // --- view: size, zoom, scroll ---------------------------------------------

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewW(Math.max(200, el.clientWidth - LABEL_W)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /** Scroll position in coarse steps: re-renders only when the visible window moves noticeably. */
  const quantum = Math.max(160, Math.round(viewW / 3));
  const syncScrollWin = () => {
    const el = scrollRef.current;
    if (el) setScrollWin(Math.floor(el.scrollLeft / quantum) * quantum);
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && pendingScroll.current !== null) {
      el.scrollLeft = pendingScroll.current;
      pendingScroll.current = null;
    }
    syncScrollWin();
  }, [ppf, contentW]);

  const applyView = (v: TimelineView) => {
    const g = geo.current;
    pendingScroll.current = v.scrollPx;
    setZoom(Math.abs(v.pxPerFrame - g.fit) < 1e-6 ? 'fit' : v.pxPerFrame);
    if (Math.abs(v.pxPerFrame - g.ppf) < 1e-9 && scrollRef.current) {
      scrollRef.current.scrollLeft = v.scrollPx;
      pendingScroll.current = null;
    }
  };

  /** Zoom about a viewport x (default: the playhead when visible, else the middle). */
  const zoomBy = (factor: number, anchorPx?: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const g = geo.current;
    let a = anchorPx;
    if (a === undefined) {
      const px = frameX(useEditor.getState().playhead, g.ppf) - el.scrollLeft;
      a = px >= 0 && px <= g.viewW ? px : g.viewW / 2;
    }
    applyView(zoomAbout({ pxPerFrame: g.ppf, scrollPx: el.scrollLeft }, factor, a, g.fit, g.total, g.viewW));
  };
  const zoomRef = useRef(zoomBy);
  zoomRef.current = zoomBy;

  const fitProject = () => applyView({ pxPerFrame: geo.current.fit, scrollPx: 0 });
  const fitScene = (s: Scene | null = scene) => {
    if (!s) return;
    const g = geo.current;
    const a = sceneStartFrame(useEditor.getState().doc.project, s.id);
    applyView(fitRange(a, a + s.durationInFrames, g.viewW, g.fit, g.total));
  };

  // Restore the preferred height.
  useEffect(() => {
    try {
      const saved = Number(localStorage.getItem(HEIGHT_KEY));
      if (saved >= HEIGHT_MIN) applyTimelineHeight(Math.min(saved, window.innerHeight * 0.7));
    } catch {
      // Preference only.
    }
  }, []);

  const beginResize = (e: ReactPointerEvent) => {
    if (e.button !== 0 || !rootRef.current) return;
    e.preventDefault();
    const h0 = rootRef.current.getBoundingClientRect().height;
    let h = h0;
    followPointer(
      e,
      (_dx, ev) => {
        h = clamp(h0 - (ev.clientY - e.clientY), HEIGHT_MIN, window.innerHeight * 0.7);
        applyTimelineHeight(h);
      },
      (end) => {
        if (end === 'cancel') return applyTimelineHeight(h0);
        try {
          localStorage.setItem(HEIGHT_KEY, String(Math.round(h)));
        } catch {
          // Preference only.
        }
      },
      'xy',
    );
  };

  // ⌘/Ctrl + wheel (and trackpad pinch) zooms about the pointer. Native listener: React's wheel listener is passive.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const anchor = e.clientX - el.getBoundingClientRect().left - LABEL_W;
      zoomRef.current(Math.exp(-e.deltaY * 0.0025), Math.max(0, anchor));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Keep the playhead in view (pages like an NLE during playback and stepping).
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        const el = scrollRef.current;
        if (!el || s.playhead === prev.playhead) return;
        const g = geo.current;
        const next = revealFrame({ pxPerFrame: g.ppf, scrollPx: el.scrollLeft }, s.playhead, g.viewW, g.total);
        if (Math.abs(next - el.scrollLeft) > 0.5) el.scrollLeft = next;
      }),
    [],
  );

  const curveRef = useRef(curveOpen);
  curveRef.current = curveOpen;

  // Timeline keys. Capture phase, and only stopped when the timeline handles them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (ownsTimelineKeys(e.target) || useProposals.getState().open || useEditor.getState().sheet || useLayout.getState().overlay) return;
      const st = useEditor.getState();
      const mod = e.metaKey || e.ctrlKey;
      const take = () => {
        e.preventDefault();
        e.stopPropagation();
      };
      const k = e.key;
      if (mod && !e.altKey) {
        if (k.toLowerCase() === 'c' && st.selectedKeyframes.length && copySelectedKeys()) take();
        else if (k.toLowerCase() === 'v' && keyClipboard && st.selection.elementId && pasteKeysAtPlayhead()) take();
        return;
      }
      if (e.altKey && (k === 'ArrowLeft' || k === 'ArrowRight')) {
        take();
        jumpKey(k === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (e.altKey) return;
      switch (k) {
        case 'Home':
        case 'End':
          take();
          st.setPlaying(false);
          st.seek(k === 'Home' ? 0 : projectDurationInFrames(st.doc.project) - 1);
          return;
        case 'm':
        case 'M':
          take();
          setSelectedMarker(addMarkerAtPlayhead()?.id ?? null);
          return;
        case 'b':
        case 'B':
        case 'n':
        case 'N':
          take();
          setWorkAreaAtPlayhead(k.toLowerCase() === 'b' ? 'start' : 'end');
          return;
        case 'Delete':
        case 'Backspace':
          if (st.selectedKeyframes.length && deleteSelectedKeys()) take();
          return;
        case 'Escape':
          if (curveRef.current) {
            take();
            setCurve(null);
          } else if (st.selectedKeyframes.length) {
            take();
            st.selectKeyframes([]);
          }
          return;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // --- pointer helpers ---------------------------------------------------------

  /** Client x of frame 0's content origin (the scrolled track area's left edge). */
  const originX = () => {
    const el = scrollRef.current!;
    return el.getBoundingClientRect().left + LABEL_W - el.scrollLeft;
  };
  const frameAtClient = (clientX: number) => frameAtX(clientX - originX(), geo.current.ppf, geo.current.total);
  const snapPx = () => SNAP_PX / geo.current.ppf;

  // Ruler: seek to the exact frame under the pointer; Shift snaps to markers.
  const scrub = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const st = useEditor.getState();
    st.setPlaying(false);
    setSelectedMarker(null);
    const marks = st.doc.project.markers.map((m) => m.frame);
    const seekAt = (clientX: number, shift: boolean) => {
      const f = frameAtClient(clientX);
      const s = shift ? snapFrame(f, marks, snapPx()) : { frame: f, snap: null };
      setSnapAt(s.snap);
      useEditor.getState().seek(s.frame);
    };
    seekAt(e.clientX, e.shiftKey);
    const move = (ev: PointerEvent) => seekAt(ev.clientX, ev.shiftKey);
    const up = () => {
      setSnapAt(null);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  // --- work area -------------------------------------------------------------

  const beginWorkArea = (e: ReactPointerEvent, mode: 'start' | 'end' | 'move') => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const st = useEditor.getState();
    const orig = resolveWorkArea(st.workArea, geo.current.total);
    const targets = [st.playhead, ...st.doc.project.markers.map((m) => m.frame), ...sceneStartFrames(st.doc.project)];
    followPointer(
      e,
      (dx) => {
        const g = geo.current;
        const df = Math.round(dx / g.ppf);
        let a: WorkArea = dragWorkArea(orig, mode, df, g.total);
        let snap: number | null = null;
        if (mode !== 'move') {
          const edge = mode === 'start' ? a.start : a.end;
          const s = snapFrame(edge, targets, snapPx());
          if (s.snap !== null) {
            a = dragWorkArea(orig, mode, df + s.frame - edge, g.total);
            snap = s.snap;
          }
        }
        setSnapAt(snap);
        useEditor.getState().setWorkArea(a);
      },
      () => setSnapAt(null),
    );
  };

  // --- markers ---------------------------------------------------------------

  const beginMarker = (e: ReactPointerEvent, m: Marker) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setSelectedMarker(m.id);
    const st = useEditor.getState();
    const targets = [st.playhead, ...sceneStartFrames(st.doc.project)];
    let last = m.frame;
    const gesture = st.beginGesture();
    followPointer(
      e,
      (dx) => {
        const g = geo.current;
        const s = snapFrame(clamp(m.frame + Math.round(dx / g.ppf), 0, g.total - 1), targets, snapPx());
        last = s.frame;
        setMarkerDrag({ id: m.id, frame: last });
        setSnapAt(s.snap);
      },
      (end) => {
        gesture.end();
        setMarkerDrag(null);
        setSnapAt(null);
        const now = useEditor.getState();
        if (end === 'click') {
          now.setPlaying(false);
          now.seek(m.frame);
        } else if (end === 'drop' && last !== m.frame && !gesture.stale()) {
          now.run({ type: 'setMarker', marker: { ...m, frame: last } }, `Moved marker “${m.label}”`);
        }
      },
    );
  };

  const deleteMarker = (m: Marker) => {
    setSelectedMarker(null);
    useEditor.getState().run({ type: 'removeMarker', markerId: m.id }, `Deleted marker “${m.label}”`);
  };

  const renameMarker = (m: Marker, label: string) => {
    const next = label.trim();
    if (next && next !== m.label) useEditor.getState().run({ type: 'setMarker', marker: { ...m, label: next } }, `Renamed marker to “${next}”`);
  };

  // --- element bars ----------------------------------------------------------

  const beginBar = (e: ReactPointerEvent, el: Element, mode: EdgeMode) => {
    if (e.button !== 0 || !scene) return;
    e.stopPropagation();
    e.preventDefault();
    const st = useEditor.getState();
    if (st.selection.elementId !== el.id) st.selectElement(scene.id, el.id);
    if (scene.locked) {
      followPointer(e, () => undefined, (end) => end === 'drop' && guardLocked(scene));
      return;
    }
    // A locked layer (or one inside a locked group) only selects here, as on the canvas.
    if (isCanvasLocked(scene.elements, el)) {
      followPointer(
        e,
        () => undefined,
        (end) => end === 'drop' && st.toast({ tone: 'info', message: `“${el.name}” is locked`, hint: el.locked ? 'Unlock it in Layers or from its right-click menu to move or trim it.' : 'Its group is locked. Unlock the group in Layers to move or trim it.' }),
      );
      return;
    }
    // Children of groups are timed inside their group: offset the snap targets, no scene-end limit.
    const offset = sceneRelStart(scene, el) - el.startFrame;
    const limit = el.parentId ? Infinity : scene.durationInFrames;
    const targets = [0, scene.durationInFrames, st.playhead - sceneStart, ...scene.elements.filter((o) => o.id !== el.id).flatMap((o) => [sceneRelStart(scene, o), sceneRelStart(scene, o) + o.durationInFrames])].map((t) => t - offset);
    let last: { start: number; dur: number; trim?: number } | null = null;
    // Video bars trim their source: the start edge moves the in-point (× speed), the end edge stops at the file's end.
    const video = el.type === 'video' ? videoProps(el) : null;
    const videoLength = video ? st.doc.project.assets[video.assetId]?.durationInFrames : undefined;
    const gesture = st.beginGesture();
    followPointer(
      e,
      (dx) => {
        const g = geo.current;
        const span = dragElementSpan({ start: el.startFrame, dur: el.durationInFrames }, mode, Math.round(dx / g.ppf), limit, targets, snapPx());
        const v = video ? trimVideoSpan({ start: el.startFrame, dur: el.durationInFrames, trim: video.trimStartFrames }, span, mode, video.playbackRate, videoLength, video.loop) : null;
        const r = v ? { ...v, snap: v.start === span.start && v.dur === span.dur ? span.snap : null } : span;
        last = r;
        setBarDrag({ elementId: el.id, start: r.start, dur: r.dur, ...(v ? { trim: v.trim } : {}) });
        setSnapAt(r.snap === null ? null : sceneStart + offset + r.snap);
      },
      (end) => {
        gesture.end();
        setBarDrag(null);
        setSnapAt(null);
        // A document changed mid-drag (agent patch, undo, reopen) keeps its change: this drag was built on the old one.
        if (end !== 'drop' || !last || gesture.stale()) return;
        const changes: { startFrame?: number; durationInFrames?: number; props?: Record<string, unknown> } = {};
        if (last.start !== el.startFrame) changes.startFrame = last.start;
        if (last.dur !== el.durationInFrames) changes.durationInFrames = last.dur;
        if (video && last.trim !== undefined && last.trim !== video.trimStartFrames) changes.props = { trimStartFrames: last.trim };
        if (!Object.keys(changes).length) return;
        useEditor.getState().run({ type: 'updateElement', sceneId: scene.id, elementId: el.id, changes }, mode === 'move' ? `Moved “${el.name}” in time` : `Trimmed “${el.name}”`);
      },
    );
  };

  // --- keys ------------------------------------------------------------------

  const beginKey = (e: ReactPointerEvent, track: string, frame: number) => {
    if (e.button !== 0 || !scene || !selectedEl) return;
    e.stopPropagation();
    e.preventDefault();
    const st = useEditor.getState();
    const ref = { track, frame };
    const current = liveKeys(selectedEl, st.selectedKeyframes);
    let sel: KeyRef[] = current;
    if (e.shiftKey) {
      sel = toggleKey(current, ref);
      st.selectKeyframes(sel);
      if (!hasKey(sel, ref)) return;
    } else if (!hasKey(current, ref)) {
      sel = [ref];
      st.selectKeyframes(sel);
    }
    const el = selectedEl;
    const base = sceneStart + sceneRelStart(scene, el);
    const targets = [st.playhead - base, ...st.doc.project.markers.map((m) => m.frame - base)];
    let delta = 0;
    const gesture = st.beginGesture();
    followPointer(
      e,
      (dx) => {
        if (scene.locked) return;
        const s = snapFrame(frame + Math.round(dx / geo.current.ppf), targets, snapPx());
        delta = clampRetime(el, sel, s.frame - frame);
        setKeyDelta(delta);
        setSnapAt(s.snap !== null && s.frame - frame === delta ? base + s.snap : null);
      },
      (end) => {
        gesture.end();
        setKeyDelta(null);
        setSnapAt(null);
        const now = useEditor.getState();
        if (end === 'click') {
          if (!e.shiftKey) {
            now.setPlaying(false);
            now.seek(base + frame);
          }
          return;
        }
        if (end !== 'drop' || gesture.stale()) return;
        if (guardLocked(scene) || !delta) return;
        const r = retimeKeys(scene.id, el, sel, delta);
        if (!r.commands.length) return;
        const label = sel.length === 1 ? `Moved ${animatedTracks(el).find((t) => t.track === track)?.label ?? track} key` : `Moved ${sel.length} keys`;
        if (now.run({ type: 'batch', label, commands: r.commands }, label)) now.selectKeyframes(r.keys);
      },
    );
  };

  const beginMarquee = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const grid = gridRef.current;
    if (!grid) return;
    e.preventDefault();
    const r0 = grid.getBoundingClientRect();
    const x0 = e.clientX - r0.left;
    const y0 = e.clientY - r0.top;
    const additive = e.shiftKey;
    const before = useEditor.getState().selectedKeyframes;
    followPointer(
      e,
      (_dx, ev) => {
        const r = grid.getBoundingClientRect();
        setMarquee({ x0, y0, x1: ev.clientX - r.left, y1: ev.clientY - r.top });
      },
      (end, ev) => {
        setMarquee(null);
        const st = useEditor.getState();
        if (end === 'click') {
          if (!additive) st.selectKeyframes([]);
          return;
        }
        if (end !== 'drop' || !ev) return;
        const r = grid.getBoundingClientRect();
        const [l, rr] = [Math.min(x0, ev.clientX - r.left), Math.max(x0, ev.clientX - r.left)];
        const [t, b] = [Math.min(y0, ev.clientY - r.top), Math.max(y0, ev.clientY - r.top)];
        const hits: KeyRef[] = [];
        grid.querySelectorAll<HTMLElement>('[data-key]').forEach((d) => {
          const box = d.getBoundingClientRect();
          const cx = box.left + box.width / 2 - r.left;
          const cy = box.top + box.height / 2 - r.top;
          if (cx < l || cx > rr || cy < t || cy > b) return;
          const [track, frame] = (d.dataset.key ?? '').split('|');
          hits.push({ track, frame: Number(frame) });
        });
        st.selectKeyframes(additive ? [...before, ...hits.filter((h) => !hasKey(before, h))] : hits);
      },
      'xy',
    );
  };

  const openCurve = (target: KeyRef | null, mode?: CurveMode) => {
    if (!target || !selectedEl) return;
    setCurve({ elementId: selectedEl.id, track: target.track, frame: target.frame, mode: mode ?? curve?.mode ?? 'easing' });
  };
  const openCurveRef = useRef(openCurve);
  openCurveRef.current = openCurve;
  useEffect(() => {
    curveOpener = (target) => openCurveRef.current(target);
    return () => {
      curveOpener = null;
    };
  }, []);

  // --- audio -----------------------------------------------------------------

  const beginAudio = (e: ReactPointerEvent, clip: AudioClip, mode: AudioMode) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    setSelectedClip(clip.id);
    const st = useEditor.getState();
    const p = st.doc.project;
    const anchor = clip.sceneId ? p.scenes.find((s) => s.id === clip.sceneId) : undefined;
    if (anchor?.locked) {
      followPointer(e, () => undefined, (end) => end === 'drop' && guardLocked(anchor));
      return;
    }
    const box = (e.currentTarget as HTMLElement).closest('.tl-aclip') as HTMLElement | null;
    const height = box?.clientHeight ?? AUDIO_ROW - 6;
    const base = anchor ? sceneStartFrame(p, anchor.id) : 0;
    const targets = [...sceneStartFrames(p), projectDurationInFrames(p), st.playhead, ...p.markers.map((m) => m.frame)];
    const y0 = e.clientY;
    let last: Partial<AudioClip> | null = null;
    const gesture = st.beginGesture();
    followPointer(
      e,
      (dx, ev) => {
        const g = geo.current;
        const df = Math.round(dx / g.ppf);
        let readout = '';
        let snap: number | null = null;
        if (mode === 'fadeIn' || mode === 'fadeOut') {
          const v = mode === 'fadeIn' ? clamp(clip.fadeInFrames + df, 0, clip.durationInFrames - clip.fadeOutFrames) : clamp(clip.fadeOutFrames - df, 0, clip.durationInFrames - clip.fadeInFrames);
          last = mode === 'fadeIn' ? { fadeInFrames: v } : { fadeOutFrames: v };
          readout = `Fade ${mode === 'fadeIn' ? 'in' : 'out'} ${v} f · ${(v / fps).toFixed(2)} s`;
        } else if (mode === 'volume') {
          const v = clamp(Math.round((clip.volume - (ev.clientY - y0) / Math.max(1, height - 2 * ENV_PAD)) * 100) / 100, 0, 1);
          last = { volume: v };
          readout = `Volume ${Math.round(v * 100)} %`;
        } else {
          const r = dragAudioSpan({ clip, base, total: g.total, sourceFrames: p.assets[clip.assetId]?.durationInFrames, mode, df, targets, threshold: snapPx() });
          const { snap: s, ...span } = r;
          snap = s;
          last = audioSpanChanges(clip, span);
          readout = `${formatTimecode(base + span.startFrame, fps)} · ${(span.durationInFrames / fps).toFixed(2)} s`;
        }
        setSnapAt(snap);
        setAudioPreview({ clipId: clip.id, changes: last, readout });
      },
      (end) => {
        gesture.end();
        setAudioPreview(null);
        setSnapAt(null);
        if (end !== 'drop' || !last || gesture.stale()) return;
        const changes: Partial<AudioClip> = {};
        for (const [k, v] of Object.entries(last) as [keyof AudioClip, AudioClip[keyof AudioClip]][]) if (clip[k] !== v) (changes as Record<string, unknown>)[k] = v;
        if (!Object.keys(changes).length) return;
        const what = { move: 'Moved', start: 'Trimmed', end: 'Trimmed', fadeIn: 'Fade in on', fadeOut: 'Fade out on', volume: 'Volume of' }[mode];
        useEditor.getState().run({ type: 'updateAudioClip', clipId: clip.id, changes }, `${what} “${clip.name}”`);
      },
      mode === 'volume' ? 'xy' : 'x',
    );
  };

  // Stable for the memoised clip views.
  const beginAudioRef = useRef(beginAudio);
  beginAudioRef.current = beginAudio;
  const onBeginAudio = useCallback((e: ReactPointerEvent, clip: AudioClip, mode: AudioMode) => beginAudioRef.current(e, clip, mode), []);

  const runMarkBeats = async () => {
    if (!selectedClip) return;
    setBeatsBusy(true);
    try {
      await markBeats(selectedClip);
    } finally {
      setBeatsBusy(false);
    }
  };

  // --- render ----------------------------------------------------------------

  const ticks = rulerTicks(ppf, fps);
  const winStart = scrollWin - viewW;
  const winEnd = scrollWin + 2 * viewW;
  const f0 = Math.max(0, Math.floor((winStart - TRACK_PAD_PX) / ppf));
  const f1 = Math.min(total, Math.ceil((winEnd - TRACK_PAD_PX) / ppf));
  const tracks = selectedEl ? animatedTracks(selectedEl) : [];
  // What a drag in progress is doing, shown where it is always visible.
  const readout =
    audioPreview?.readout ??
    (keyDelta !== null ? `Retime ${plural(keys.length, 'key')} by ${keyDelta > 0 ? '+' : ''}${keyDelta} f` : null) ??
    (markerDrag ? `Marker at ${formatTimecode(markerDrag.frame, fps)} (f ${markerDrag.frame})` : null) ??
    (barDrag ? `${selectedEl?.name ?? 'Element'} · f ${barDrag.start}–${barDrag.start + barDrag.dur} (${(barDrag.dur / fps).toFixed(2)} s)` : null);

  const zoomPos = zoomSliderPos(ppf, fit);

  return (
    <div className="timeline" data-testid="timeline" ref={rootRef}>
      <div className="tl-resize" title="Drag to resize the timeline" aria-hidden onPointerDown={beginResize} />
      <div className="tl-head">
        <b className="tl-head-title">Timeline</b>
        {scene && (
          <span className="tl-head-sub" data-testid="timeline-summary">
            {scene.name}
            {expanded ? ' expanded' : ''} · {plural(scene.elements.length, 'layer')}
          </span>
        )}
        <div className="tl-tool-group">
          <button className="mini-btn tl-with-glyph" title="Add a marker at the playhead (M)" data-testid="timeline-add-marker" onClick={() => setSelectedMarker(addMarkerAtPlayhead()?.id ?? null)}>
            <Icon name="flag" size={12} /> Marker
          </button>
          <button
            className="mini-btn"
            title={selectedClip ? 'Add a marker on every beat (sharp rise in loudness) of the selected audio clip' : 'Select an audio clip first'}
            disabled={!selectedClip || !project.audio.some((c) => c.id === selectedClip) || beatsBusy}
            data-testid="timeline-mark-beats"
            onClick={() => void runMarkBeats()}
          >
            {beatsBusy ? 'Listening…' : 'Mark beats'}
          </button>
        </div>
        <span className="tl-tool-sep" />
        <div className="tl-tool-group">
          <button
            className={`mini-btn ${curveOpen ? 'on' : ''}`}
            title={curveFor ? 'Curve editor for the selected segment (or double-click a segment)' : 'Select a key on a track with two or more keys'}
            disabled={!curveFor}
            data-testid="timeline-curve"
            onClick={() => (curveOpen ? setCurve(null) : openCurve(curveFor))}
          >
            Curve…
          </button>
        </div>
        {/* A drag's live readout, or how many keys are selected; the shortcuts live in the controls' tooltips. */}
        <span className={`tl-hint ${readout ? 'live' : ''}`} data-testid="timeline-hint">
          {readout ?? (keys.length ? `${plural(keys.length, 'key')} selected` : '')}
        </span>
        <div className="tl-tool-group">
          <button className={`mini-btn ${zoom === 'fit' ? 'on' : ''}`} title="Show the whole project" data-testid="timeline-fit-project" onClick={fitProject}>
            Fit project
          </button>
          <button className="mini-btn" title="Zoom to the current scene (or double-click a scene block)" disabled={!scene} data-testid="timeline-fit-scene" onClick={() => fitScene()}>
            Fit scene
          </button>
        </div>
        <span className="tl-tool-sep" />
        {/* Zoom: − / + step it, the slider runs from "Fit project" to 8 px per frame, the readout is in percent of fit. */}
        <div className="tl-tool-group tl-zoom-group" role="group" aria-label="Zoom">
          <button className="icon-btn small" title="Zoom out" aria-label="Zoom out" data-testid="timeline-zoom-out" onClick={() => zoomBy(1 / ZOOM_STEP)}>
            <Icon name="minus" size={14} />
          </button>
          <input
            className="slider tl-zoom"
            type="range"
            min={0}
            max={ZOOM_SLIDER_MAX}
            value={zoomPos}
            style={{ '--fill': `${(zoomPos / ZOOM_SLIDER_MAX) * 100}%` } as CSSVars}
            aria-label="Timeline zoom"
            aria-valuetext={`${zoomPercent(ppf, fit)} %`}
            title="Zoom (⌘ / Ctrl + scroll over the timeline)"
            data-testid="timeline-zoom"
            onChange={(e) => zoomBy(zoomAtSliderPos(Number(e.target.value), fit) / ppf)}
          />
          <button className="icon-btn small" title="Zoom in" aria-label="Zoom in" data-testid="timeline-zoom-in" onClick={() => zoomBy(ZOOM_STEP)}>
            <Icon name="plus" size={14} />
          </button>
          <span className="tl-zoom-readout" title="Zoom: 100 % shows the whole project" data-testid="timeline-zoom-readout">
            {zoomPercent(ppf, fit)}%
          </span>
        </div>
        <span className="tl-tool-sep" />
        <span className="tl-head-time">
          <Timecode fps={fps} />
        </span>
        <button className="icon-btn small" title="Collapse the timeline" aria-label="Collapse the timeline" data-testid="timeline-collapse" onClick={() => useEditor.getState().setTimelineOpen(false)}>
          <Icon name="down" size={14} />
        </button>
      </div>

      <div className="tl-scroll" ref={scrollRef} onScroll={syncScrollWin}>
        <div className="tl-grid" ref={gridRef} style={{ gridTemplateColumns: `${LABEL_W}px ${contentW}px` }}>
          {/* Ruler: work area, ticks, markers, playhead handle */}
          <div className="tl-label tl-corner" />
          <div className="tl-track tl-ruler" data-testid="timeline-scrubber" title="Click or drag to seek (Home / End for the ends); Shift-scrub snaps to markers" onPointerDown={scrub}>
            <div
              className={`tl-workarea ${storedWorkArea ? 'set' : ''}`}
              style={{ left: x(workArea.start), width: Math.max(4, x(workArea.end) - x(workArea.start)) }}
              title={`Work area ${formatTimecode(workArea.start, fps)} – ${formatTimecode(workArea.end - 1, fps)}. Set in (B) / out (N) at the playhead, or drag the ends; drag the bar to move it; double-click to reset.`}
              data-testid="timeline-work-area"
              onPointerDown={(e) => beginWorkArea(e, 'move')}
              onDoubleClick={() => useEditor.getState().setWorkArea(null)}
            >
              <span className="tl-wa-grip start" data-testid="timeline-work-in" onPointerDown={(e) => beginWorkArea(e, 'start')} />
              <span className="tl-wa-grip end" data-testid="timeline-work-out" onPointerDown={(e) => beginWorkArea(e, 'end')} />
            </div>
            {tickFrames(f0, f1, ticks.minor).map((f) => (
              <span key={f} className={`tl-tick ${f % ticks.major === 0 ? 'major' : ''}`} style={{ left: x(f) }}>
                {f % ticks.major === 0 && <span className="tl-tick-label">{tickLabel(f, fps)}</span>}
              </span>
            ))}
            {project.markers.map((m, i) => {
              const at = markerDrag?.id === m.id ? markerDrag.frame : m.frame;
              const selected = selectedMarker === m.id;
              // Crowded markers show just their flag (the label is in the tooltip) unless selected.
              const next = project.markers[i + 1];
              const compact = !selected && !!next && (next.frame - m.frame) * ppf < 72;
              return (
                <div
                  key={m.id}
                  className={`tl-marker ${selected ? 'selected' : ''} ${compact ? 'compact' : ''}`}
                  style={{ left: x(at), ...(m.color ? { '--marker-color': m.color } : {}) } as CSSVars}
                  data-testid={`timeline-marker-${m.id}`}
                >
                  {renaming === m.id ? (
                    <MarkerRename marker={m} onCommit={(v) => renameMarker(m, v)} onDone={() => setRenaming(null)} />
                  ) : (
                    <span
                      className="tl-marker-flag"
                      title={`${m.label} · ${formatTimecode(m.frame, fps)}. Click to go there, drag to move, double-click to rename.`}
                      onPointerDown={(e) => beginMarker(e, m)}
                      onDoubleClick={() => setRenaming(m.id)}
                    >
                      <Icon name="flag" size={12} />
                      <span className="tl-marker-label">{m.label}</span>
                    </span>
                  )}
                  {selected && renaming !== m.id && (
                    <button className="tl-marker-del" title={`Delete marker “${m.label}”`} aria-label={`Delete marker “${m.label}”`} data-testid={`timeline-marker-delete-${m.id}`} onPointerDown={(e) => e.stopPropagation()} onClick={() => deleteMarker(m)}>
                      <Icon name="close" size={10} />
                    </button>
                  )}
                </div>
              );
            })}
            <PlayheadHandle ppf={ppf} />
          </div>

          {/* Scenes: raised rows, each block edged in its scene colour */}
          <div className="tl-label group">
            <span className="tl-caret-space" aria-hidden />
            <Icon name="film" size={14} className="tl-type-icon" />
            <span className="tl-label-text">Scenes</span>
          </div>
          <div className="tl-track tl-scenes">
            {project.scenes.map((s, i) => (
              <button
                key={s.id}
                className={`tl-scene ${s.id === scene?.id ? 'active' : ''} ${s.locked ? 'locked' : ''}`}
                style={{ left: x(starts[i]), width: Math.max(2, s.durationInFrames * ppf - 1), '--scene-accent': sceneAccent(i) } as CSSVars}
                data-testid={`timeline-scene-${s.id}`}
                title={`${s.name} — ${s.durationInFrames} f${s.locked ? ' (approved)' : ''}. Click to go there, double-click to zoom to it.`}
                onClick={() => useEditor.getState().seek(starts[i])}
                onDoubleClick={() => fitScene(s)}
                onContextMenu={(e) => openSceneMenu(e, s.id)}
              >
                {s.locked && <Icon name="lock" size={12} />}
                <span>{s.name}</span>
              </button>
            ))}
          </div>

          {/* Each scene as a group: the current one disclosed into its layers (front first), the rest folded to "n layers" */}
          {project.scenes.map((s, i) => {
            const open = s.id === scene?.id && expanded;
            const toggle = () => (s.id === scene?.id ? setCollapsed(expanded ? s.id : null) : useEditor.getState().seek(starts[i]));
            return (
              <React.Fragment key={s.id}>
                <div
                  className={`tl-label group ${s.id === scene?.id ? 'current' : ''}`}
                  style={{ '--scene-accent': sceneAccent(i) } as CSSVars}
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                  data-testid={`timeline-group-${s.id}`}
                  title={open ? `Fold “${s.name}”` : `Show the layers of “${s.name}”`}
                  onClick={toggle}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), toggle())}
                  onContextMenu={(e) => openSceneMenu(e, s.id)}
                >
                  <span className={`tl-caret ${open ? 'open' : ''}`} aria-hidden>
                    <Icon name="right" size={10} />
                  </span>
                  <Icon name="frame" size={14} className="tl-type-icon" />
                  <span className="tl-label-text">{s.name}</span>
                  {s.locked && (
                    <span className="tl-row-state" role="img" aria-label="Locked" title="Locked scene">
                      <Icon name="lock" size={12} />
                    </span>
                  )}
                </div>
                <div className="tl-track tl-group-track">
                  {!open && (
                    <button
                      className="tl-group-bar"
                      style={{ left: x(starts[i]), width: Math.max(2, s.durationInFrames * ppf - 1), '--scene-accent': sceneAccent(i) } as CSSVars}
                      title={`${s.name}: ${plural(s.elements.length, 'layer')}. Click to show them.`}
                      onClick={toggle}
                      onDoubleClick={() => fitScene(s)}
                      onContextMenu={(e) => openSceneMenu(e, s.id)}
                    >
                      {plural(s.elements.length, 'layer')}
                    </button>
                  )}
                </div>
                {open &&
                  [...s.elements].reverse().map((el) => {
                    const preview = barDrag?.elementId === el.id ? barDrag : null;
                    const offset = sceneRelStart(s, el) - el.startFrame;
                    const start = preview ? preview.start : el.startFrame;
                    const dur = preview ? preview.dur : el.durationInFrames;
                    const active = el.id === selElementId;
                    const keyFrames = allKeyFrames(el);
                    const animated = keyFrames.length > 0;
                    const at = sceneStart + offset + start;
                    const depth = depthOf(s, el);
                    // Hidden or locked by itself or by a group around it, as the canvas sees it.
                    const hidden = !el.visible || ancestorsOf(s.elements, el).some((a) => !a.visible);
                    const elLocked = isCanvasLocked(s.elements, el);
                    const kind = COMPONENTS[el.type].label;
                    return (
                      <React.Fragment key={el.id}>
                        <div
                          className={`tl-label el ${active ? 'active' : ''} ${hidden ? 'is-hidden' : ''}`}
                          style={{ paddingLeft: LAYER_INDENT + depth * DEPTH_INDENT }}
                          title={[`${kind}: ${el.name}`, animated && 'animated', hidden && 'hidden', elLocked && 'locked'].filter(Boolean).join(' · ')}
                          data-testid={`timeline-layer-${el.id}`}
                          onClick={() => useEditor.getState().selectElement(s.id, el.id)}
                          onContextMenu={(e) => openElementMenu(e, s.id, el.id, 'layer')}
                        >
                          <Icon name={ELEMENT_ICON[el.type]} size={14} className="tl-type-icon" />
                          <span className="tl-label-text">{el.name}</span>
                          {(animated || hidden || elLocked) && (
                            <span className="tl-row-state">
                              {animated && <span className="tl-anim-mark" role="img" aria-label="Animated" />}
                              {hidden && (
                                <span role="img" aria-label="Hidden" data-testid={`timeline-layer-hidden-${el.id}`}>
                                  <Icon name="eyeOff" size={12} />
                                </span>
                              )}
                              {elLocked && (
                                <span role="img" aria-label="Locked" data-testid={`timeline-layer-locked-${el.id}`}>
                                  <Icon name="lock" size={12} />
                                </span>
                              )}
                            </span>
                          )}
                        </div>
                        <div className="tl-track tl-el-track">
                          <div className="tl-scene-range" style={{ left: x(sceneStart), width: s.durationInFrames * ppf }} />
                          <div
                            className={`tl-bar ${active ? 'active' : ''} ${hidden ? 'hidden' : ''} ${s.locked ? 'locked' : ''} ${elLocked ? 'el-locked' : ''}`}
                            data-testid={`timeline-bar-${el.id}`}
                            title={elLocked ? `“${el.name}” is locked: it selects but does not move or trim` : undefined}
                            style={{ left: x(at), width: Math.max(3, dur * ppf), '--type': CLIP_COLOR[el.type] } as CSSVars}
                            onPointerDown={(e) => beginBar(e, el, 'move')}
                            onContextMenu={(e) => openElementMenu(e, s.id, el.id, 'clip')}
                          >
                            {el.type === 'video' && project.assets[String(el.props.assetId)] && (
                              <VideoBarWave
                                asset={project.assets[String(el.props.assetId)]}
                                fps={fps}
                                trim={preview?.trim ?? videoProps(el).trimStartFrames}
                                rate={videoProps(el).playbackRate}
                                dur={dur}
                                left={x(at)}
                                ppf={ppf}
                                winStart={winStart}
                                winEnd={winEnd}
                                gain={videoProps(el).muted ? 0.2 : videoProps(el).volume}
                              />
                            )}
                            {/* A locked layer has no trim handles; its bar only selects. */}
                            {elLocked ? (
                              <Icon name="lock" size={10} className="tl-bar-lock" />
                            ) : (
                              <span className="tl-trim start" data-testid={`timeline-trim-start-${el.id}`} onPointerDown={(e) => beginBar(e, el, 'start')} />
                            )}
                            <span className="tl-bar-label">
                              {preview ? `${start}–${start + dur} f` : el.name}
                              {el.type === 'video' && <span className="tl-bar-src"> · {sourceRangeLabel(preview?.trim ?? videoProps(el).trimStartFrames, dur, videoProps(el).playbackRate, fps)}</span>}
                            </span>
                            {!elLocked && <span className="tl-trim end" data-testid={`timeline-trim-end-${el.id}`} onPointerDown={(e) => beginBar(e, el, 'end')} />}
                          </div>
                          {/* Where its keys sit, on the bar's lower edge; the selected layer's keys are edited in its key rows below. */}
                          {animated && !active && keyFrames.map((k) => <span key={k} className="tl-bar-key" style={{ left: x(at + k) }} aria-hidden />)}
                        </div>
                        {/* Animated tracks of the selected element, right under its layer */}
                        {active && (
                          <KeyRows
                            element={el}
                            tracks={tracks}
                            indent={NAME_INDENT + depth * DEPTH_INDENT}
                            base={sceneStart + sceneRelStart(s, el)}
                            ppf={ppf}
                            keys={keys}
                            delta={keyDelta}
                            curve={curveOpen}
                            onBeginKey={beginKey}
                            onBeginMarquee={beginMarquee}
                            onOpenCurve={(track, frame) => openCurve({ track, frame })}
                          />
                        )}
                      </React.Fragment>
                    );
                  })}
              </React.Fragment>
            );
          })}

          {/* Audio: music bed (absolute) and scene-anchored sound effects */}
          {(['music', 'sfx'] as const).map((lane) => {
            const clips = project.audio.filter((c) => (lane === 'sfx') === !!c.sceneId);
            const shown = clips.map((c) => (audioPreview?.clipId === c.id ? { ...c, ...audioPreview.changes } : c));
            const startsOf = shown.map((c) => audioClipStartFrame(project, c));
            const rows = packRows(shown.map((c, i) => ({ id: c.id, start: startsOf[i], end: startsOf[i] + c.durationInFrames })));
            return (
              <React.Fragment key={lane}>
                <div className="tl-label audio" style={{ height: Math.max(1, rows.count) * AUDIO_ROW }}>
                  <span className="tl-caret-space" aria-hidden />
                  <Icon name={lane === 'music' ? 'music' : 'audio'} size={14} className="tl-type-icon" />
                  <span className="tl-label-text">{lane === 'music' ? 'Music' : 'SFX'}</span>
                </div>
                <div className="tl-track tl-audio" style={{ height: Math.max(1, rows.count) * AUDIO_ROW }} data-testid={`timeline-audio-${lane}`}>
                  {shown.map((c, i) => {
                    const anchorIndex = c.sceneId ? project.scenes.findIndex((s) => s.id === c.sceneId) : -1;
                    return (
                      <AudioClipView
                        key={c.id}
                        clip={c}
                        lane={lane}
                        url={project.assets[c.assetId] ? resolveAssetUrl('/', videoPreviewSrc(project.assets[c.assetId], false)) : null}
                        fps={fps}
                        left={x(startsOf[i])}
                        ppf={ppf}
                        row={rows.rows.get(c.id) ?? 0}
                        accent={anchorIndex >= 0 ? sceneAccent(anchorIndex) : 'var(--ok)'}
                        locked={anchorIndex >= 0 && project.scenes[anchorIndex].locked}
                        selected={selectedClip === c.id}
                        winStart={winStart}
                        winEnd={winEnd}
                        onBegin={onBeginAudio}
                      />
                    );
                  })}
                </div>
              </React.Fragment>
            );
          })}

          {/* Lines across every row */}
          <div className="tl-overlay" style={{ left: LABEL_W, width: contentW }} aria-hidden>
            {storedWorkArea && (
              <>
                <div className="tl-wa-veil" style={{ left: 0, width: x(workArea.start) }} />
                <div className="tl-wa-veil" style={{ left: x(workArea.end), right: 0 }} />
              </>
            )}
            <div className="tl-end" style={{ left: x(total) }} />
            {project.markers.map((m) => (
              <div key={m.id} className="tl-marker-line" style={{ left: x(markerDrag?.id === m.id ? markerDrag.frame : m.frame), ...(m.color ? { '--marker-color': m.color } : {}) } as CSSVars} />
            ))}
            {snapAt !== null && <div className="tl-snap" style={{ left: x(snapAt) }} />}
            <PlayheadLine ppf={ppf} />
          </div>
          {marquee && (
            <div
              className="tl-marquee"
              style={{ left: Math.min(marquee.x0, marquee.x1), top: Math.min(marquee.y0, marquee.y1), width: Math.abs(marquee.x1 - marquee.x0), height: Math.abs(marquee.y1 - marquee.y0) }}
            />
          )}
        </div>
      </div>

      {curveOpen && selectedEl && scene && (
        <CurveEditor
          scene={scene}
          element={selectedEl}
          sceneStart={sceneStart + sceneRelStart(scene, selectedEl) - selectedEl.startFrame}
          track={curveOpen.track}
          frame={curveOpen.frame}
          mode={curveOpen.mode}
          anchor={rootRef.current}
          onMode={(mode) => setCurve({ ...curveOpen, mode })}
          onFrame={(frame) => setCurve({ ...curveOpen, frame })}
          onClose={() => setCurve(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function Timecode({ fps }: { fps: number }) {
  const playhead = useEditor((s) => s.playhead);
  return (
    <span className="tabular" title={`Frame ${playhead}`}>
      {formatTimecode(playhead, fps)}
    </span>
  );
}

function PlayheadHandle({ ppf }: { ppf: number }) {
  const playhead = useEditor((s) => s.playhead);
  return <div className="tl-playhead-handle" style={{ left: frameX(playhead, ppf) }} />;
}

function PlayheadLine({ ppf }: { ppf: number }) {
  const playhead = useEditor((s) => s.playhead);
  return <div className="tl-playhead" style={{ left: frameX(playhead, ppf) }} />;
}

function MarkerRename({ marker, onCommit, onDone }: { marker: Marker; onCommit: (label: string) => void; onDone: () => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const input = ref.current?.querySelector('input');
    input?.focus();
    input?.select();
  }, []);
  return (
    <span className="tl-marker-rename" ref={ref} onBlur={onDone} onPointerDown={(e) => e.stopPropagation()}>
      <CommitText value={marker.label} maxLength={60} testId={`timeline-marker-rename-${marker.id}`} onCommit={onCommit} />
    </span>
  );
}

interface KeyRowsProps {
  element: Element;
  tracks: TrackInfo[];
  /** Left padding of the track headers: under the layer's name. */
  indent: number;
  /** Absolute frame of the element's frame 0. */
  base: number;
  ppf: number;
  keys: KeyRef[];
  /** Live retime of the selected keys, while dragging. */
  delta: number | null;
  curve: CurveState | null;
  onBeginKey: (e: ReactPointerEvent, track: string, frame: number) => void;
  onBeginMarquee: (e: ReactPointerEvent) => void;
  onOpenCurve: (track: string, frame: number) => void;
}

function KeyRows({ element, tracks, indent, base, ppf, keys, delta, curve, onBeginKey, onBeginMarquee, onOpenCurve }: KeyRowsProps) {
  const x = (f: number) => frameX(base + f, ppf);
  if (!tracks.length)
    return (
      <>
        <div className="tl-label kf" style={{ paddingLeft: indent }}>
          Keys
        </div>
        <div className="tl-track tl-kf" title={`Key a property of “${element.name}” in Animate mode (A) to animate it`}>
          <span className="tl-empty">No keys</span>
        </div>
      </>
    );
  return (
    <>
      {tracks.map((t) => {
        const at = (k: { frame: number }) => (delta !== null && hasKey(keys, { track: t.track, frame: k.frame }) ? k.frame + delta : k.frame);
        const ks = t.keyframes;
        return (
          <React.Fragment key={t.track}>
            <div className="tl-label kf" style={{ paddingLeft: indent }} title={`${t.label}: ${plural(ks.length, 'key')}${t.eased ? '' : ' (holds between keys)'}. Previous / next key (${shortcutLabel('←', ['alt'])} / ${shortcutLabel('→', ['alt'])})`}>
              <span className="tl-kf-mark" aria-hidden />
              <span className="tl-label-text">{t.label}</span>
              <span className="tl-kf-count">{ks.length}</span>
            </div>
            <div className="tl-track tl-kf" data-track={t.track} onPointerDown={onBeginMarquee}>
              {ks.slice(0, -1).map((k, i) => {
                const a = at(k);
                const b = at(ks[i + 1]);
                const spec = k.easing;
                const open = curve?.track === t.track && curve.frame === k.frame;
                return (
                  <span
                    key={`s${k.frame}`}
                    className={`tl-seg ${spec === 'hold' ? 'hold' : ''} ${typeof spec === 'string' ? '' : 'custom'} ${open ? 'open' : ''}`}
                    style={{ left: Math.min(x(a), x(b)), width: Math.abs(x(b) - x(a)) }}
                    title={`${easingLabel(spec)}${t.eased ? ' · double-click for the curve editor' : ''}`}
                    data-testid={`segment-${t.track}-${k.frame}`}
                    onDoubleClick={() => t.eased && onOpenCurve(t.track, k.frame)}
                  />
                );
              })}
              {ks.map((k) => {
                const selected = hasKey(keys, { track: t.track, frame: k.frame });
                return (
                  <button
                    key={k.frame}
                    type="button"
                    tabIndex={-1}
                    className={`tl-diamond ${selected ? 'selected' : ''} ${k.easing === 'hold' ? 'hold' : ''}`}
                    style={{ left: x(at(k)) }}
                    title={`${t.label} = ${typeof k.value === 'number' ? Math.round(k.value * 1000) / 1000 : String(k.value)} at element frame ${k.frame} · ${easingLabel(k.easing)}. Shift-click adds; drag to retime · ${shortcutLabel('C', ['mod'])} / ${shortcutLabel('V', ['mod'])} · Delete · Esc`}
                    data-testid={`keyframe-${t.track}-${k.frame}`}
                    data-key={`${t.track}|${k.frame}`}
                    onPointerDown={(e) => onBeginKey(e, t.track, k.frame)}
                    onDoubleClick={() => t.eased && ks.length > 1 && onOpenCurve(t.track, k === ks[ks.length - 1] ? ks[ks.length - 2].frame : k.frame)}
                    onContextMenu={(e) => {
                      // A key outside the selection becomes the selection, as a click would.
                      if (!selected) useEditor.getState().selectKeyframes([{ track: t.track, frame: k.frame }]);
                      openContextMenu(e, 'keyframe');
                    }}
                  />
                );
              })}
            </div>
          </React.Fragment>
        );
      })}
    </>
  );
}

interface AudioClipViewProps {
  clip: AudioClip;
  lane: 'music' | 'sfx';
  url: string | null;
  fps: number;
  /** Content x of the clip's start. */
  left: number;
  ppf: number;
  row: number;
  accent: string;
  locked: boolean;
  selected: boolean;
  /** Visible content-x window (with overscan): the waveform draws only this slice. */
  winStart: number;
  winEnd: number;
  onBegin: (e: ReactPointerEvent, clip: AudioClip, mode: AudioMode) => void;
}

const AudioClipView = memo(function AudioClipView({ clip, lane, url, fps, left, ppf, row, accent, locked, selected, winStart, winEnd, onBegin }: AudioClipViewProps) {
  const w = Math.max(3, clip.durationInFrames * ppf);
  const h = AUDIO_ROW - 6;
  const visA = clamp((winStart - left) / ppf, 0, clip.durationInFrames);
  const visB = clamp((winEnd - left) / ppf, 0, clip.durationInFrames);
  const fin = clip.fadeInFrames * ppf;
  const fout = clip.fadeOutFrames * ppf;
  const volY = ENV_PAD + (1 - clip.volume) * (h - 2 * ENV_PAD);
  const sec = (f: number) => `${(f / fps).toFixed(2)} s`;
  return (
    <div
      className={`tl-aclip ${lane} ${selected ? 'selected' : ''} ${locked ? 'locked' : ''}`}
      style={{ left, width: w, top: row * AUDIO_ROW + 3, height: h, '--type': accent } as CSSVars}
      title={`${clip.name} · ${sec(clip.durationInFrames)} · volume ${Math.round(clip.volume * 100)} % · fades ${clip.fadeInFrames} / ${clip.fadeOutFrames} f${locked ? ' · in an approved scene' : ''}`}
      data-testid={`timeline-audio-${clip.id}`}
      onPointerDown={(e) => onBegin(e, clip, 'move')}
    >
      {visB > visA && <ClipWaveform className="tl-wave" url={url} fps={fps} clip={clip} from={visA} to={visB} style={{ left: visA * ppf, width: (visB - visA) * ppf }} />}
      <svg className="tl-env" width={w} height={h} aria-hidden>
        <polygon className="tl-env-fill" points={`0,${h} ${fin},${volY} ${w - fout},${volY} ${w},${h}`} />
        <polyline className="tl-env-line" points={`0,${h} ${fin},${volY} ${w - fout},${volY} ${w},${h}`} />
      </svg>
      <span className="tl-aclip-name">{clip.name}</span>
      {!locked && (
        <>
          <span className="tl-vol" style={{ top: volY - 4, left: fin, width: Math.max(0, w - fin - fout) }} title={`Volume ${Math.round(clip.volume * 100)} % · drag up or down`} data-testid={`timeline-volume-${clip.id}`} onPointerDown={(e) => onBegin(e, clip, 'volume')} />
          <span className="tl-atrim start" data-testid={`timeline-audio-trim-start-${clip.id}`} onPointerDown={(e) => onBegin(e, clip, 'start')} />
          <span className="tl-atrim end" data-testid={`timeline-audio-trim-end-${clip.id}`} onPointerDown={(e) => onBegin(e, clip, 'end')} />
          <span className="tl-fade in" style={{ left: fin }} title={`Fade in ${clip.fadeInFrames} f (${sec(clip.fadeInFrames)}) · drag`} data-testid={`timeline-fade-in-${clip.id}`} onPointerDown={(e) => onBegin(e, clip, 'fadeIn')} />
          <span className="tl-fade out" style={{ left: w - fout }} title={`Fade out ${clip.fadeOutFrames} f (${sec(clip.fadeOutFrames)}) · drag`} data-testid={`timeline-fade-out-${clip.id}`} onPointerDown={(e) => onBegin(e, clip, 'fadeOut')} />
        </>
      )}
    </div>
  );
});
