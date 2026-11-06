// The transport row under the preview, one 40 px card on one line: on the
// left play and stepping, the loop toggle and the timecode; on the right,
// while something is selected, the arrange tools (or a path's node actions,
// CanvasToolbar.tsx), then the zoom and the Timeline toggle that opens the
// full timeline across the bottom. The tools and Insert are on the rail
// (ToolRail.tsx); the Layout / Animate switch is in the header
// (StageHeader.tsx), and the stage's own flag says when Animate is keying.

import { useEffect, useRef, useState } from 'react';
import { newId } from '../core/ids';
import { formatTimecode, projectDurationInFrames, sceneStartFrames } from '../core/timing';
import type { Marker } from '../core/types';
import { useStageSize } from './canvasControls';
import { CanvasToolbar, ZoomControls } from './CanvasToolbar';
import { viewTransform } from './canvasView';
import { Icon } from './icons';
import { togglePlayback } from './playback';
import { useEditor } from './store';
import { resolveWorkArea } from './timelineView';

export function jumpScene(direction: -1 | 1) {
  const { doc, playhead, seek } = useEditor.getState();
  const starts = sceneStartFrames(doc.project);
  if (direction < 0) {
    const prev = [...starts].reverse().find((s) => s < playhead);
    seek(prev ?? 0);
  } else {
    const next = starts.find((s) => s > playhead);
    if (next !== undefined) seek(next);
  }
}

export function stepFrame(delta: number) {
  const { playhead, seek, setPlaying } = useEditor.getState();
  setPlaying(false);
  seek(playhead + delta);
}

/** A new project marker (ids share the project id space; core's newId has no marker prefix). */
export function newMarker(frame: number, label: string): Marker {
  return { id: newId('el').replace(/^el_/, 'mk_'), frame, label };
}

/** M: drop a marker at the playhead (one undo step). A marker already there is left alone. */
export function addMarkerAtPlayhead(): Marker | null {
  const st = useEditor.getState();
  const { markers, fps } = st.doc.project;
  const existing = markers.find((m) => m.frame === st.playhead);
  if (existing) {
    st.toast({ tone: 'info', message: `“${existing.label}” is already at ${formatTimecode(st.playhead, fps)}` });
    return existing;
  }
  const marker = newMarker(st.playhead, `Marker ${markers.length + 1}`);
  return st.run({ type: 'setMarker', marker }, `Added marker at ${formatTimecode(st.playhead, fps)}`) ? marker : null;
}

/** Row width from which the arrange tools sit inline instead of behind one button (a window of about 1380 px with the right column open). */
const ROOMY_ARRANGE = 1000;

function useRowWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return { ref, width };
}

export function Transport() {
  const playhead = useEditor((s) => s.playhead);
  const playing = useEditor((s) => s.playing);
  const project = useEditor((s) => s.doc.project);
  const loop = useEditor((s) => s.loopWorkArea);
  const workArea = useEditor((s) => s.workArea);
  const view = useEditor((s) => s.view);
  const timelineOpen = useEditor((s) => s.timelineOpen);
  const stageSize = useStageSize();
  const row = useRowWidth();
  const total = projectDurationInFrames(project);
  const area = resolveWorkArea(workArea, total);
  const scale = viewTransform(view, stageSize, { width: project.width, height: project.height }).scale;

  return (
    <div className="transport" data-testid="transport" ref={row.ref}>
      <div className="transport-group">
        <button className="icon-btn play" title={playing ? 'Pause (Space)' : 'Play (Space)'} data-testid="play" aria-pressed={playing} onClick={(e) => togglePlayback(e)}>
          <Icon name={playing ? 'pause' : 'play'} size={14} />
        </button>
        <span className="transport-steps">
          <button className="icon-btn small" title="Previous scene" data-testid="prev-scene" onClick={() => jumpScene(-1)}>
            <Icon name="skipBack" size={14} />
          </button>
          <button className="icon-btn small" title="Previous frame ( , )" data-testid="step-back" onClick={() => stepFrame(-1)}>
            <Icon name="stepBack" size={14} />
          </button>
          <button className="icon-btn small" title="Next frame ( . )" data-testid="step-forward" onClick={() => stepFrame(1)}>
            <Icon name="stepForward" size={14} />
          </button>
          <button className="icon-btn small" title="Next scene" data-testid="next-scene" onClick={() => jumpScene(1)}>
            <Icon name="skipForward" size={14} />
          </button>
        </span>
        <button
          className={`icon-btn small loop-toggle ${loop ? 'on' : ''}`}
          title={`Loop work area ${formatTimecode(area.start, project.fps)} – ${formatTimecode(area.end - 1, project.fps)} (set in/out with B / N or the bar on the ruler)`}
          aria-label="Loop work area"
          aria-pressed={loop}
          data-testid="loop-work-area"
          onClick={() => useEditor.getState().setLoopWorkArea(!loop)}
        >
          <Icon name="loop" size={14} />
        </button>
      </div>
      <span className="transport-rule" aria-hidden />
      <div className="timecode" data-testid="timecode" title={`Frame ${playhead} of ${Math.max(0, total - 1)}`}>
        <span className="tc-now">{formatTimecode(playhead, project.fps)}</span>
        <span className="tc-total">/ {formatTimecode(total, project.fps)}</span>
        <span className="tc-frame" data-testid="frame-number">
          f {playhead} / {total - 1}
        </span>
      </div>
      <div className="transport-right">
        <CanvasToolbar roomy={row.width >= ROOMY_ARRANGE} />
        <ZoomControls scale={scale} />
        <button
          className={`btn small timeline-toggle ${timelineOpen ? 'on' : ''}`}
          data-testid="timeline-toggle"
          aria-pressed={timelineOpen}
          title={timelineOpen ? 'Hide the timeline' : 'Show the timeline: every layer, its keyframes and the sound'}
          onClick={() => useEditor.getState().setTimelineOpen(!timelineOpen)}
        >
          <Icon name="timeline" size={14} />
          <span className="timeline-toggle-label">Timeline</span>
        </button>
      </div>
    </div>
  );
}
