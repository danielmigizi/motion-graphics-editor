// Curve editor (advanced timeline). Two views of the selected segment's track:
// - Easing: the segment (a key → the next key on its track) as a draggable
//   cubic-bezier with two handles, presets (every named easing incl. hold,
//   plus curve-only Bounce-ish / Anticipate), x1 y1 x2 y2 fields and a live
//   preview dot.
// - Value graph: the whole numeric track as value over time; drag a key up /
//   down to change its value, left / right to retime it (Shift locks the axis).
// Every gesture commits ONE command (or batch) on release, through the same
// commands as everything else. Math: keyframes.ts.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { easingFn, EASING_NAMES, evaluateKeyframes } from '../core/animation';
import type { CubicBezierEasing, EasingSpec, Element, Scene } from '../core/types';
import { guardLocked } from './editActions';
import { CommitNumber } from './fields';
import { Icon } from './icons';
import {
  animatedTracks,
  clampBezier,
  CURVE_PRESETS,
  curveOverflow,
  curvesAllowed,
  curveToPx,
  dragGraphKey,
  dragHandle,
  EASING_LABELS,
  easingLabel,
  graphRange,
  graphToPx,
  isTransformTrack,
  keyframesOf,
  removeKeyCommand,
  sameEasing,
  segmentAt,
  setKeyCommand,
  toBezier,
  type CurveBox,
  type GraphBox,
} from './keyframes';
import { followPointer } from './SimpleTimeline';
import { useEditor } from './store';

export type CurveMode = 'easing' | 'graph';

interface CurveEditorProps {
  scene: Scene;
  element: Element;
  sceneStart: number;
  track: string;
  /** Element frame of the segment's first key. */
  frame: number;
  mode: CurveMode;
  /** The timeline: the panel floats above its right end. */
  anchor: HTMLElement | null;
  onMode: (mode: CurveMode) => void;
  /** The segment's first key was retimed in the graph. */
  onFrame: (frame: number) => void;
  onClose: () => void;
}

/** Visible window of the easing box (handles may go to -2..3; outside this they pin to the edge). */
const BOX: CurveBox = { width: 196, height: 196, yMin: -0.6, yMax: 1.6 };
const PAD = 14;

const UNIT_HINT: Record<string, string> = { x: 'px offset', y: 'px offset', rotation: '° offset', scale: '× base scale', opacity: '× base opacity' };

export function CurveEditor(props: CurveEditorProps) {
  const { element, track, frame, mode, anchor, onMode, onClose } = props;
  const info = animatedTracks(element).find((t) => t.track === track);
  const seg = segmentAt(element, { track, frame });
  const pos = usePanelPosition(anchor);
  if (!info || !seg) return null;

  return createPortal(
    <div className="curve-pop" role="dialog" aria-label="Curve editor" data-testid="curve-editor" style={pos}>
      <header className="curve-head">
        <span className="curve-title">
          <span className="curve-track-name">{info.label}</span>
          <span className="curve-span tabular">
            {mode === 'easing' ? `f ${seg.from.frame} → ${seg.to.frame}` : `${keyframesOf(element, track).length} keys`}
          </span>
        </span>
        <div className="curve-tabs" role="tablist">
          <button role="tab" aria-selected={mode === 'easing'} className={mode === 'easing' ? 'on' : ''} data-testid="curve-tab-easing" onClick={() => onMode('easing')}>
            Easing
          </button>
          <button
            role="tab"
            aria-selected={mode === 'graph'}
            className={mode === 'graph' ? 'on' : ''}
            data-testid="curve-tab-graph"
            disabled={!info.numeric}
            title={info.numeric ? 'Value over time for the whole track' : 'Only numeric tracks have a value graph'}
            onClick={() => onMode('graph')}
          >
            Value graph
          </button>
        </div>
        <button className="icon-btn small" title="Close (Esc)" aria-label="Close curve editor" onClick={onClose}>
          <Icon name="close" size={14} />
        </button>
      </header>
      {mode === 'graph' && info.numeric ? <GraphPane {...props} /> : <EasingPane {...props} easing={seg.from.easing} />}
    </div>,
    document.body,
  );
}

/** Fixed position above the anchor's top-right corner, following window resizes. */
function usePanelPosition(anchor: HTMLElement | null) {
  const [pos, setPos] = useState<{ right: number; bottom: number }>({ right: 16, bottom: 260 });
  useLayoutEffect(() => {
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      setPos({ right: Math.max(8, window.innerWidth - r.right + 12), bottom: Math.max(8, window.innerHeight - r.top + 8) });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [anchor]);
  return pos;
}

function commit(scene: Scene, label: string, commands: ReturnType<typeof setKeyCommand>[]): boolean {
  if (!commands.length || guardLocked(scene)) return false;
  const st = useEditor.getState();
  return commands.length === 1 ? st.run(commands[0], label) : st.run({ type: 'batch', label, commands }, label);
}

// ---------------------------------------------------------------------------
// Easing
// ---------------------------------------------------------------------------

function EasingPane({ scene, element, track, frame, easing }: CurveEditorProps & { easing: EasingSpec }) {
  const [draft, setDraft] = useState<CubicBezierEasing | null>(null);
  const shown: EasingSpec = draft ?? easing;
  const curve = toBezier(shown);
  const allowCurves = curvesAllowed(track);
  const label = animatedTracks(element).find((t) => t.track === track)?.label ?? track;
  const value = segmentAt(element, { track, frame })!.from.value;

  const write = (spec: EasingSpec) => {
    if (sameEasing(spec, easing)) return;
    commit(scene, `${label} easing: ${easingLabel(spec)}`, [setKeyCommand(scene.id, element.id, track, frame, value, spec)]);
  };

  const beginHandle = (e: ReactPointerEvent<SVGCircleElement>, handle: 1 | 2) => {
    if (e.button !== 0 || !curve || !allowCurves) return;
    e.preventDefault();
    e.stopPropagation();
    const svg = (e.currentTarget.ownerSVGElement as SVGSVGElement).getBoundingClientRect();
    let last: CubicBezierEasing | null = null;
    // write() is this render's: it keys the value and easing captured now, so a document changed mid-drag drops the drag.
    const gesture = useEditor.getState().beginGesture();
    followPointer(
      e,
      (_dx, ev) => {
        last = dragHandle(curve, handle, ev.clientX - svg.left - PAD, ev.clientY - svg.top - PAD, BOX);
        setDraft(last);
      },
      (end) => {
        gesture.end();
        setDraft(null);
        if (end === 'drop' && last && !gesture.stale()) write(last);
      },
      'xy',
    );
  };

  const setNumber = (key: 'x1' | 'y1' | 'x2' | 'y2', v: number) => curve && write(clampBezier({ ...curve, [key]: v }));
  const fn = easingFn(shown);
  const path = useMemo(() => curvePath(fn, BOX), [fn]);
  const t = usePreviewClock();
  const v = fn(t);
  const dot = curveToPx(BOX, t, v);

  return (
    <div className="curve-body">
      <div className="curve-left">
        <svg className="curve-box" width={BOX.width + 2 * PAD} height={BOX.height + 2 * PAD} data-testid="curve-box">
          <g transform={`translate(${PAD} ${PAD})`}>
            <rect className="curve-bg" x={0} y={curveToPx(BOX, 0, 1).py} width={BOX.width} height={curveToPx(BOX, 0, 0).py - curveToPx(BOX, 0, 1).py} />
            {[0.25, 0.5, 0.75].map((gx) => (
              <line key={gx} className="curve-grid" x1={gx * BOX.width} x2={gx * BOX.width} y1={0} y2={BOX.height} />
            ))}
            {[0, 1].map((gy) => (
              <line key={gy} className="curve-axis" x1={0} x2={BOX.width} y1={curveToPx(BOX, 0, gy).py} y2={curveToPx(BOX, 0, gy).py} />
            ))}
            <line className="curve-linear" x1={0} y1={curveToPx(BOX, 0, 0).py} x2={BOX.width} y2={curveToPx(BOX, 1, 1).py} />
            {curve && allowCurves && <Handles curve={curve} onBegin={beginHandle} />}
            <path className="curve-line" d={path} />
            <circle className="curve-dot-on" cx={dot.px} cy={Math.max(0, Math.min(BOX.height, dot.py))} r={3.5} />
          </g>
        </svg>
        <div className="curve-preview" aria-hidden title="Live preview: the value moving from this key to the next">
          <span className="curve-preview-mark" style={{ left: `${previewX(0)}%` }} />
          <span className="curve-preview-mark" style={{ left: `${previewX(1)}%` }} />
          <span className="curve-preview-dot" style={{ left: `${previewX(v)}%` }} />
        </div>
        <div className="curve-nums">
          {(['x1', 'y1', 'x2', 'y2'] as const).map((k) => (
            <label key={k} className="curve-num">
              <span>{k}</span>
              <CommitNumber
                value={curve ? curve[k] : 0}
                min={k.startsWith('x') ? 0 : -2}
                max={k.startsWith('x') ? 1 : 3}
                step={0.01}
                disabled={!curve || !allowCurves}
                testId={`curve-${k}`}
                onCommit={(n) => setNumber(k, n)}
              />
            </label>
          ))}
        </div>
      </div>
      <div className="curve-side">
        <div className="curve-current" data-testid="curve-current">
          {easingLabel(shown)}
        </div>
        <div className="curve-presets">
          {EASING_NAMES.map((name) => (
            <PresetButton key={name} spec={name} label={EASING_LABELS[name]} active={sameEasing(shown, name)} onPick={() => write(name)} />
          ))}
          {CURVE_PRESETS.map((p) => (
            <PresetButton
              key={p.id}
              spec={p.curve}
              label={p.label}
              active={sameEasing(shown, p.curve)}
              disabled={!allowCurves}
              title={allowCurves ? undefined : 'Custom curves are not available on transform tracks yet'}
              onPick={() => write(p.curve)}
            />
          ))}
        </div>
        <p className="curve-note">
          {shown === 'hold'
            ? 'Hold: the value stays put, then jumps at the next key.'
            : !allowCurves
              ? 'Transform tracks take the named presets. Custom curves work on component and effect tracks.'
              : 'Drag the handles for a custom curve. Above or below the box overshoots.'}
        </p>
      </div>
    </div>
  );
}

function Handles({ curve, onBegin }: { curve: CubicBezierEasing; onBegin: (e: ReactPointerEvent<SVGCircleElement>, handle: 1 | 2) => void }) {
  const ends = [curveToPx(BOX, 0, 0), curveToPx(BOX, 1, 1)];
  return (
    <>
      {([1, 2] as const).map((h) => {
        const x = h === 1 ? curve.x1 : curve.x2;
        const y = h === 1 ? curve.y1 : curve.y2;
        const over = curveOverflow(BOX, y);
        const p = curveToPx(BOX, x, Math.max(BOX.yMin, Math.min(BOX.yMax, y)));
        const from = ends[h - 1];
        return (
          <g key={h} className={`curve-handle ${over ? 'over' : ''}`}>
            <line className="curve-arm" x1={from.px} y1={from.py} x2={p.px} y2={p.py} />
            {over !== 0 && (
              // Pinned to the edge of the visible window: say where it really is.
              <text className="curve-overflow-label" x={p.px + (p.px > BOX.width - 48 ? -10 : 10)} y={p.py + (over > 0 ? 14 : -8)} textAnchor={p.px > BOX.width - 48 ? 'end' : 'start'}>
                {`${over > 0 ? '↑' : '↓'} ${y.toFixed(2)}`}
              </text>
            )}
            <circle className="curve-knob" cx={p.px} cy={p.py} r={6} data-testid={`curve-handle-${h}`} onPointerDown={(e) => onBegin(e, h)}>
              <title>{`Handle ${h}: (${x}, ${y}). Drag to shape the curve.`}</title>
            </circle>
          </g>
        );
      })}
    </>
  );
}

function PresetButton({ spec, label, active, disabled, title, onPick }: { spec: EasingSpec; label: string; active: boolean; disabled?: boolean; title?: string; onPick: () => void }) {
  const glyph = useMemo(() => curvePath(easingFn(spec), { width: 22, height: 14, yMin: -0.5, yMax: 1.5 }, 24), [spec]);
  return (
    <button className={`curve-preset ${active ? 'on' : ''}`} disabled={disabled} title={title ?? label} aria-pressed={active} data-testid={`curve-preset-${label}`} onClick={onPick}>
      <svg width={22} height={14} aria-hidden>
        <path d={glyph} />
      </svg>
      <span>{label}</span>
    </button>
  );
}

/** SVG path of an easing function across a box. */
function curvePath(fn: (t: number) => number, box: CurveBox, steps = 96): string {
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // The step of 'hold' happens at t = 1: draw it as a vertical edge.
    const p = curveToPx(box, t, fn(i === steps ? 1 : Math.min(t, 1 - 1e-6)));
    d += `${i ? 'L' : 'M'}${p.px.toFixed(2)} ${p.py.toFixed(2)}`;
  }
  const end = curveToPx(box, 1, fn(1));
  return `${d}L${end.px.toFixed(2)} ${end.py.toFixed(2)}`;
}

/** Preview track spans values -0.25..1.25 so overshoot stays visible. */
const previewX = (v: number) => Math.max(0, Math.min(100, ((v + 0.25) / 1.5) * 100));

/** 0..1 over a second, then a short rest at the end; still (mid-way) when reduced motion is preferred. */
function usePreviewClock(): number {
  const [t, setT] = useState(0.5);
  useEffect(() => {
    if (typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      const phase = ((now - t0) % 1500) / 1000;
      setT(Math.min(1, phase));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);
  return t;
}

// ---------------------------------------------------------------------------
// Value graph
// ---------------------------------------------------------------------------

const G = { width: 404, height: 176, left: 48, top: 10, bottom: 20, right: 12 };

interface GraphDrag {
  index: number;
  frame: number;
  value: number;
}

function GraphPane({ scene, element, sceneStart, track, frame: segFrame, onFrame }: CurveEditorProps) {
  const playhead = useEditor((s) => s.playhead);
  const [drag, setDrag] = useState<GraphDrag | null>(null);
  const keys = keyframesOf(element, track) as { frame: number; value: number; easing: EasingSpec }[];
  const range = useMemo(() => graphRange(keys), [keys]);
  // While dragging, the graph keeps the scale it started with.
  const frozen = useRef<GraphBox | null>(null);
  const box: GraphBox = frozen.current ?? { ...range, width: G.width, height: G.height };
  const shown = drag ? keys.map((k, i) => (i === drag.index ? { ...k, frame: drag.frame, value: drag.value } : k)).sort((a, b) => a.frame - b.frame) : keys;
  const label = animatedTracks(element).find((t) => t.track === track)?.label ?? track;

  let d = '';
  const step = Math.max(1, (box.frameMax - box.frameMin) / box.width);
  for (let f = box.frameMin; f <= box.frameMax + 1e-9; f += step) {
    const p = graphToPx(box, f, evaluateKeyframes(shown, f, 0));
    d += `${d ? 'L' : 'M'}${p.px.toFixed(1)} ${p.py.toFixed(1)}`;
  }
  const local = playhead - sceneStart - element.startFrame;

  const begin = (e: ReactPointerEvent<SVGCircleElement>, index: number) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (scene.locked) return void guardLocked(scene);
    const k = keys[index];
    const fixed = { ...box };
    frozen.current = fixed;
    const neighbours = { prev: index > 0 ? keys[index - 1].frame : null, next: index < keys.length - 1 ? keys[index + 1].frame : null };
    const y0 = e.clientY;
    let last: GraphDrag | null = null;
    const gesture = useEditor.getState().beginGesture();
    followPointer(
      e,
      (dx, ev) => {
        const r = dragGraphKey(element.type, track, k, dx, ev.clientY - y0, fixed, neighbours, ev.shiftKey);
        last = { index, ...r };
        setDrag(last);
      },
      (end) => {
        gesture.end();
        frozen.current = null;
        setDrag(null);
        if (end !== 'drop' || !last || gesture.stale() || (last.frame === k.frame && last.value === k.value)) return;
        const cmds = last.frame === k.frame ? [] : [removeKeyCommand(scene.id, element.id, track, k.frame)];
        cmds.push(setKeyCommand(scene.id, element.id, track, last.frame, last.value, k.easing));
        if (commit(scene, `Edited ${label} key`, cmds) && k.frame === segFrame && last.frame !== k.frame) onFrame(last.frame);
        if (last.frame !== k.frame) useEditor.getState().selectKeyframes([{ track, frame: last.frame }]);
      },
      'xy',
    );
  };

  const yTicks = niceTicks(box.valueMin, box.valueMax, 4);
  return (
    <div className="curve-graph">
      <svg className="graph-box" width={G.left + G.width + G.right} height={G.top + G.height + G.bottom} data-testid="value-graph">
        <defs>
          <clipPath id="graph-plot">
            <rect x={0} y={0} width={box.width} height={box.height} />
          </clipPath>
        </defs>
        <g transform={`translate(${G.left} ${G.top})`}>
          <rect className="curve-bg" x={0} y={0} width={box.width} height={box.height} />
          {yTicks.map((v) => {
            const y = graphToPx(box, box.frameMin, v).py;
            return (
              <g key={v}>
                <line className={v === 0 ? 'curve-axis' : 'curve-grid'} x1={0} x2={box.width} y1={y} y2={y} />
                <text className="graph-label" x={-6} y={y + 3} textAnchor="end">
                  {fmtValue(v)}
                </text>
              </g>
            );
          })}
          {[box.frameMin, box.frameMax].map((f, i) => (
            <text key={i} className="graph-label" x={graphToPx(box, f, 0).px} y={box.height + 14} textAnchor={i ? 'end' : 'start'}>
              f {Math.round(f)}
            </text>
          ))}
          {local >= box.frameMin && local <= box.frameMax && <line className="graph-playhead" x1={graphToPx(box, local, 0).px} x2={graphToPx(box, local, 0).px} y1={0} y2={box.height} />}
          <path className="curve-line" d={d} clipPath="url(#graph-plot)" />
          {keys.map((k, i) => {
            const at = drag?.index === i ? drag : k;
            // A value dragged past the frozen range pins to the edge; the readout below has the number.
            const p = graphToPx(box, at.frame, Math.max(box.valueMin, Math.min(box.valueMax, at.value)));
            return (
              <circle
                key={k.frame}
                className={`graph-key ${k.frame === segFrame ? 'seg' : ''} ${drag?.index === i ? 'dragging' : ''}`}
                cx={p.px}
                cy={p.py}
                r={5}
                data-testid={`graph-key-${k.frame}`}
                onPointerDown={(e) => begin(e, i)}
              >
                <title>{`Frame ${k.frame} · ${fmtValue(k.value)}`}</title>
              </circle>
            );
          })}
        </g>
      </svg>
      <p className="curve-note">
        {drag ? (
          <span className="tabular">
            f {drag.frame} · {fmtValue(drag.value)}
          </span>
        ) : (
          <>
            {isTransformTrack(track) ? `${label} (${UNIT_HINT[track]}). ` : ''}Drag a key up/down to change its value, left/right to retime it. Shift locks the axis.
          </>
        )}
      </p>
    </div>
  );
}

const fmtValue = (v: number) => (Number.isInteger(v) ? String(v) : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : String(Math.round(v * 100) / 100));

/** About `count` round value ticks across [lo, hi]. */
function niceTicks(lo: number, hi: number, count: number): number[] {
  const raw = (hi - lo) / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.round(v / step) * step);
  return out;
}
