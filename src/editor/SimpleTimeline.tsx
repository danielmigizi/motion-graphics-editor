// Scene strip: one white card per scene, as wide as the scene is long, under
// the stage's transport row. Owned by the stage lane; App.tsx mounts it.
//
// Each card shows a thumbnail (only once the scene has something in it), the
// name, the length and its state at the right, in quiet words: approved (it
// has content; the `built` key), proposed (the scene a pending proposal
// changes, outlined in the accent), next (still empty) or locked (the
// `approved` key), then the lock control. Click a card to go to its
// start, drag it to reorder, drag its right edge to change its length; the
// rail above the cards scrubs and holds the project markers (click one to go
// there; M adds one at the playhead). Right-click a card for the scene's
// menu (ContextMenu.tsx). "[" / "]" trim the selected layer to the playhead.
// Drags preview from local state and commit exactly one command on
// pointer-up (one undo step). Locked scenes cannot be edited here. The
// layers and the sound live in the full timeline (Timeline.tsx).
// Pure logic: simpleTimelineEdits.ts.

import { Thumbnail } from '../runtime';
import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { formatTimecode, projectDurationInFrames, sceneStartFrame, sceneStartFrames } from '../core/timing';
import type { Project, Scene } from '../core/types';
import { MainComposition } from '../composition/MainComposition';
import type { MainCompositionProps } from '../composition/types';
import { providerLabel, useChat } from './chat';
import { openSceneMenu } from './ContextMenu';
import { isTyping, LOCKED_NOTICE } from './editActions';
import { Icon } from './icons';
import { togglePlayback } from './playback';
import { useLayout } from './layout';
import { useProposals } from './proposals';
import { addMarkerAtPlayhead } from './Transport';
import { applyPreview, framesForPx, maxSceneLength, minSceneLength, previewCommand, sceneDropTarget, sceneLengthAt, SNAP_PX, trimToPlayhead, type EditPreview } from './simpleTimelineEdits';
import { useEditor } from './store';
import './timeline-simple.css';

/** Pixels the pointer must travel before a press becomes a drag. */
const DRAG_START_PX = 3;

type CSSVars = CSSProperties & Record<`--${string}`, string | number>;

const pct = (frames: number, of: number) => `${(frames / Math.max(1, of)) * 100}%`;

function lockedToast(scene: Scene) {
  useEditor.getState().toast({ tone: 'info', message: LOCKED_NOTICE, hint: `“${scene.name}” is locked. Click its lock in the scene strip to reopen it.` });
}

export type DragEnd = 'click' | 'drop' | 'cancel';

/**
 * Follow one pointer gesture on window: `onMove` gets the horizontal delta once
 * the pointer has travelled a few px (horizontally, or in any direction with
 * axis 'xy'); `onEnd` says whether it was a click, a finished drag, or
 * cancelled (pointercancel / Escape). Shared with the advanced timeline.
 */
export function followPointer(
  e: ReactPointerEvent,
  onMove: (dx: number, ev: PointerEvent) => void,
  onEnd: (end: DragEnd, ev: PointerEvent | null) => void,
  axis: 'x' | 'xy' = 'x',
) {
  const x0 = e.clientX;
  const y0 = e.clientY;
  let dragging = false;
  const move = (ev: PointerEvent) => {
    const travel = axis === 'x' ? Math.abs(ev.clientX - x0) : Math.hypot(ev.clientX - x0, ev.clientY - y0);
    if (!dragging && travel < DRAG_START_PX) return;
    dragging = true;
    onMove(ev.clientX - x0, ev);
  };
  const finish = (end: DragEnd, ev: PointerEvent | null) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', cancel);
    window.removeEventListener('keydown', key, true);
    onEnd(end, ev);
  };
  const up = (ev: PointerEvent) => finish(dragging ? 'drop' : 'click', ev);
  const cancel = () => finish('cancel', null);
  const key = (ev: KeyboardEvent) => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    finish('cancel', null);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointercancel', cancel);
  window.addEventListener('keydown', key, true);
}

/**
 * followPointer for drags that commit document changes: registers the gesture
 * (the agent bridge waits for it) and turns a drop into a cancel when the
 * document changed underneath it, so a drag never overwrites a newer edit.
 */
function followEdit(e: ReactPointerEvent, onMove: (dx: number, ev: PointerEvent) => void, onEnd: (end: DragEnd, ev: PointerEvent | null) => void) {
  const gesture = useEditor.getState().beginGesture();
  followPointer(e, onMove, (end, ev) => {
    gesture.end();
    onEnd(end === 'drop' && gesture.stale() ? 'cancel' : end, ev);
  });
}

// ---------------------------------------------------------------------------
// The strip's own transport row (off under the stage, whose row drives the same playhead)
// ---------------------------------------------------------------------------

function StripTransport({ status }: { status: string }) {
  const playing = useEditor((s) => s.playing);
  const playhead = useEditor((s) => s.playhead);
  const fps = useEditor((s) => s.doc.project.fps);
  const total = useEditor((s) => projectDurationInFrames(s.doc.project));
  return (
    <div className="st-transport">
      <button className="icon-btn play" title="Play / pause (Space)" aria-label={playing ? 'Pause' : 'Play'} data-testid="play" onClick={(e) => togglePlayback(e)}>
        <Icon name={playing ? 'pause' : 'play'} size={14} />
      </button>
      <span className="st-time" data-testid="timecode">
        {formatTimecode(playhead, fps)} <span className="st-time-total">/ {formatTimecode(total, fps)}</span>
      </span>
      <button className="icon-btn small" title="Add a marker at the playhead (M)" data-testid="add-marker" onClick={() => addMarkerAtPlayhead()}>
        <Icon name="flag" size={12} />
      </button>
      <span className="st-status" data-testid="timeline-status">
        {status}
      </span>
    </div>
  );
}

function Playhead({ total }: { total: number }) {
  const playhead = useEditor((s) => s.playhead);
  return <div className="st-playhead" style={{ left: pct(playhead, total) }} aria-hidden />;
}

/** A scene's length as people say it: "4 s", "2.5 s". */
function seconds(frames: number, fps: number): string {
  const s = frames / fps;
  return `${Number.isInteger(s) ? s : s.toFixed(1)} s`;
}

// ---------------------------------------------------------------------------
// Scene card: thumbnail, name, length, state, approve (lock), right-edge length handle
// ---------------------------------------------------------------------------

/** One frame of the video, drawn live. Also the Generate tab's frame pickers (`className` sizes it there). */
export const SceneThumb = memo(function SceneThumb({ project, frame, className = 'st-thumb' }: { project: Project; frame: number; className?: string }) {
  const props = useMemo<MainCompositionProps>(() => ({ project, assetBaseUrl: '/' }), [project]);
  return (
    <span className={className} style={{ aspectRatio: `${project.width} / ${project.height}` }} aria-hidden>
      <Thumbnail
        component={MainComposition}
        inputProps={props}
        compositionWidth={project.width}
        compositionHeight={project.height}
        durationInFrames={Math.max(1, projectDurationInFrames(project))}
        fps={project.fps}
        frameToDisplay={frame}
        style={{ width: '100%', height: '100%' }}
      />
    </span>
  );
});

type SceneState = 'proposed' | 'approved' | 'built' | 'next' | 'empty';

function SceneStateLabel({ state, reviewing }: { state: SceneState; reviewing: boolean }) {
  if (state === 'proposed' && !reviewing) {
    return (
      <button
        className="st-state proposed"
        data-testid="scene-state"
        title="Review the proposal for this scene"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => useProposals.getState().openReview()}
      >
        <span className="st-dot" aria-hidden />
        <span className="st-state-text">Proposed · review</span>
      </button>
    );
  }
  // The keys are older than the words: `built` (has content) reads "Approved", `approved` (locked) reads "Locked".
  const label = { proposed: 'Proposed · in review', approved: 'Locked', built: 'Approved', next: 'Next', empty: 'Empty' }[state];
  return (
    <span className={`st-state ${state}`} data-testid="scene-state">
      {state === 'proposed' && <span className="st-dot" aria-hidden />}
      {state === 'built' && <Icon name="check" size={13} />}
      {state === 'approved' && <Icon name="lock" size={13} />}
      <span className="st-state-text">{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// The strip
// ---------------------------------------------------------------------------

interface SceneMove {
  sceneId: string;
  slot: number;
  toIndex: number;
}

/** Scenes a pending, applicable proposal changes. */
function useProposedScenes(): Set<string> {
  const check = useProposals((s) => (s.proposal ? s.check : null));
  return useMemo(() => {
    const ids = new Set<string>();
    if (check?.status !== 'ready') return ids;
    for (const t of check.touched) if (t.kind === 'scene' || t.kind === 'element') ids.add(t.sceneId);
    for (const c of check.diff) if (c.sceneId) ids.add(c.sceneId);
    return ids;
  }, [check]);
}

/** `transport`: render the strip's own play / timecode row (off under the stage, whose transport row drives the same playhead). */
export function SimpleTimeline({ transport = true }: { transport?: boolean } = {}) {
  const project = useEditor((s) => s.doc.project);
  const selSceneId = useEditor((s) => s.selection.sceneId);
  const laneRef = useRef<HTMLDivElement>(null);
  const agent = useChat((s) => providerLabel(s.providers, s.provider));
  const reviewing = useProposals((s) => s.open && !!s.proposal);
  const proposed = useProposedScenes();

  // Live drag state (never in the document until pointer-up).
  const [preview, setPreview] = useState<EditPreview | null>(null);
  const [blocker, setBlocker] = useState<string | null>(null);
  const [sceneMove, setSceneMove] = useState<SceneMove | null>(null);
  /** The project length a scene-length drag started with: the scale holds until release. */
  const [fixedTotal, setFixedTotal] = useState<number | null>(null);

  const view = useMemo(() => applyPreview(project, preview), [project, preview]);
  const total = fixedTotal ?? Math.max(1, projectDurationInFrames(view));
  const starts = sceneStartFrames(view);
  const fps = project.fps;

  const clearDrag = () => {
    setPreview(null);
    setBlocker(null);
    setSceneMove(null);
    setFixedTotal(null);
  };

  const commit = (p: EditPreview | null) => {
    clearDrag();
    if (!p) return;
    const st = useEditor.getState();
    const c = previewCommand(st.doc.project, p);
    if (c) st.run(c.command, c.label);
  };

  /** Geometry captured at the start of a gesture (the scale is fixed while dragging). */
  const lane = () => {
    const r = laneRef.current!.getBoundingClientRect();
    const t = Math.max(1, projectDurationInFrames(useEditor.getState().doc.project));
    return { left: r.left, width: r.width, total: t, threshold: framesForPx(SNAP_PX, t, r.width) };
  };

  // "[" and "]": trim the selected layer's start / end to the playhead. "M": add a marker.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target) || useEditor.getState().sheet || useLayout.getState().overlay) return;
      if ((e.key === 'm' || e.key === 'M') && !useProposals.getState().open) {
        e.preventDefault();
        addMarkerAtPlayhead();
        return;
      }
      if (e.key !== '[' && e.key !== ']') return;
      const st = useEditor.getState();
      const p = st.doc.project;
      const scene = p.scenes.find((s) => s.id === st.selection.sceneId);
      const el = scene?.elements.find((x) => x.id === st.selection.elementId);
      if (!scene || !el) return;
      e.preventDefault();
      if (scene.locked) return lockedToast(scene);
      const r = trimToPlayhead(scene, sceneStartFrame(p, scene.id), el, st.playhead, e.key === '[' ? 'start' : 'end');
      if (!r.ok) return st.toast({ tone: 'info', message: r.reason });
      st.run({ type: 'updateElement', sceneId: scene.id, elementId: el.id, changes: r.changes }, `Trimmed “${el.name}”`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- gestures -------------------------------------------------------------

  const scrub = (e: ReactPointerEvent) => {
    if (e.button !== 0) return;
    const { left, width: w, total: t } = lane();
    const st = useEditor.getState();
    const seekTo = (x: number) => st.seek(Math.max(0, Math.min(t - 1, Math.round(((x - left) / w) * t))));
    st.setPlaying(false);
    seekTo(e.clientX);
    const move = (ev: PointerEvent) => seekTo(ev.clientX);
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  const beginSceneLength = (e: ReactPointerEvent, scene: Scene) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    if (scene.locked) return lockedToast(scene);
    const g = lane();
    const min = minSceneLength(scene);
    const max = maxSceneLength(scene.durationInFrames, g.total, fps);
    let last: EditPreview | null = null;
    followEdit(
      e,
      (dx) => {
        const r = sceneLengthAt({ total: g.total, sceneDuration: scene.durationInFrames, dx, width: g.width, min: min.frames, max, fps, threshold: g.threshold });
        last = { kind: 'sceneLength', sceneId: scene.id, durationInFrames: r.frames };
        setFixedTotal(g.total);
        setPreview(last);
        setBlocker(r.clamped && min.blocker ? min.blocker.id : null);
      },
      (end) => commit(end === 'drop' ? last : null),
    );
  };

  const beginSceneCard = (e: ReactPointerEvent, scene: Scene, index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const g = lane();
    const s0 = sceneStartFrames(project);
    const durs = project.scenes.map((s) => s.durationInFrames);
    let last: SceneMove | null = null;
    followEdit(
      e,
      (_dx, ev) => {
        const t = sceneDropTarget(((ev.clientX - g.left) / g.width) * g.total, s0, durs, index);
        last = { sceneId: scene.id, ...t };
        setSceneMove(last);
      },
      (end) => {
        clearDrag();
        const st = useEditor.getState();
        if (end === 'click') {
          st.setPlaying(false);
          st.seek(s0[index]);
        } else if (end === 'drop' && last && last.toIndex !== index) {
          st.run({ type: 'moveScene', sceneId: scene.id, toIndex: last.toIndex }, `Moved scene “${scene.name}”`);
        }
      },
    );
  };

  const toggleApproval = (scene: Scene) =>
    useEditor.getState().run({ type: 'setSceneLock', sceneId: scene.id, locked: !scene.locked }, scene.locked ? `Unlocked “${scene.name}”` : `Locked “${scene.name}”`);

  // --- layout ---------------------------------------------------------------

  const firstEmpty = view.scenes.findIndex((s) => s.elements.length === 0);
  const status = stripStatus(view, preview, sceneMove, blocker);

  return (
    <div className="st-root" data-testid="simple-timeline">
      {transport && !reviewing && <StripTransport status={status ?? 'Click a scene to go there · drag it to reorder · drag its right edge to change its length'} />}
      <div className={`st-lanes ${preview || sceneMove ? 'dragging' : ''}`} ref={laneRef} onPointerDown={scrub}>
        <div className="st-rail" data-testid="scrubber" title="Drag to scrub">
          {view.markers.map((m) => (
            <button
              key={m.id}
              className="st-marker"
              style={{ left: pct(m.frame, total), ...(m.color ? { '--marker-color': m.color } : {}) } as CSSVars}
              title={`${m.label} · ${formatTimecode(m.frame, fps)}. Click to go there.`}
              aria-label={`Go to marker “${m.label}”`}
              data-testid={`marker-${m.id}`}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                const st = useEditor.getState();
                st.setPlaying(false);
                st.seek(m.frame);
              }}
            />
          ))}
        </div>
        <div className="st-scenes" data-testid="scene-strip">
          {view.scenes.map((s, i) => {
            const committed = project.scenes.find((c) => c.id === s.id) ?? s;
            const lengthDrag = preview?.kind === 'sceneLength' && preview.sceneId === s.id;
            const filled = s.elements.length > 0;
            const state: SceneState = proposed.has(s.id) ? 'proposed' : s.locked ? 'approved' : filled ? 'built' : i === firstEmpty ? 'next' : 'empty';
            const classes = ['st-scene', selSceneId === s.id && 'current', s.locked && 'approved', state === 'proposed' && 'proposed', !filled && 'blank', sceneMove?.sceneId === s.id && 'moving'];
            return (
              <div
                key={s.id}
                className={classes.filter(Boolean).join(' ')}
                style={{ left: pct(starts[i], total), width: pct(s.durationInFrames, total) }}
                data-testid={`scene-card-${s.id}`}
                data-state={state}
                title={`${s.name} · ${seconds(s.durationInFrames, fps)}${s.locked ? ' · locked' : ''}. Click to go there, drag to reorder.`}
                onPointerDown={(e) => beginSceneCard(e, s, i)}
                onContextMenu={(e) => openSceneMenu(e, s.id)}
              >
                <div className="st-card">
                  {filled && <SceneThumb project={project} frame={sceneStartFrame(project, s.id) + Math.floor(committed.durationInFrames * 0.6)} />}
                  <span className="st-scene-name">{s.name}</span>
                  <span className={`st-scene-len ${lengthDrag && blocker ? 'warn' : ''}`}>{seconds(s.durationInFrames, fps)}</span>
                  <SceneStateLabel state={state} reviewing={reviewing} />
                  <button
                    className={`st-approve ${s.locked ? 'on' : ''}`}
                    title={s.locked ? `Locked: nobody (you or ${agent}) can change this scene. Click to unlock.` : `Lock this scene (${agent} will leave it alone)`}
                    aria-label={s.locked ? `Unlock “${s.name}”` : `Lock “${s.name}”`}
                    aria-pressed={s.locked}
                    data-testid={`approve-${s.id}`}
                    onPointerDown={(e) => e.stopPropagation()}
                    onClick={() => toggleApproval(s)}
                  >
                    <Icon name={s.locked ? 'lock' : 'unlock'} size={13} />
                  </button>
                </div>
                {!s.locked && (
                  <span
                    className={`st-scene-edge ${lengthDrag ? 'active' : ''} ${lengthDrag && blocker ? 'blocked' : ''}`}
                    title={`Drag to change “${s.name}” length`}
                    data-testid={`scene-edge-${s.id}`}
                    onPointerDown={(e) => beginSceneLength(e, s)}
                  />
                )}
              </div>
            );
          })}
          {sceneMove && <div className="st-drop" style={{ left: pct(sceneMove.slot < starts.length ? starts[sceneMove.slot] : total, total) }} />}
        </div>
        <Playhead total={total} />
      </div>
      {status && (
        <div className={`st-live ${blocker ? 'warn' : ''}`} role="status" data-testid="strip-status">
          {status}
        </div>
      )}
    </div>
  );
}

/** What a drag is doing, or why it stopped; null while nothing is being dragged. */
function stripStatus(project: Project, preview: EditPreview | null, sceneMove: SceneMove | null, blocker: string | null): string | null {
  const fps = project.fps;
  if (sceneMove) {
    const s = project.scenes.find((x) => x.id === sceneMove.sceneId);
    return `Move “${s?.name}” to position ${sceneMove.toIndex + 1}`;
  }
  if (preview?.kind === 'sceneLength') {
    const s = project.scenes.find((x) => x.id === preview.sceneId);
    const b = blocker ? s?.elements.find((e) => e.id === blocker) : undefined;
    if (b) return `“${s?.name}” can’t be shorter than ${seconds(preview.durationInFrames, fps)}: “${b.name}” ends there. Trim it first.`;
    return `“${s?.name}” · ${seconds(preview.durationInFrames, fps)}`;
  }
  return null;
}
