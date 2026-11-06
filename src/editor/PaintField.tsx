// Paint field: a fill or stroke as none / solid colour / linear / radial
// gradient. Every change commits ONE normalised Paint (see inspectorModel);
// dragging a stop previews live and commits once on release.

import React, { useRef, useState } from 'react';
import { paintToCss } from '../composition/svg';
import type { Paint } from '../core/types';
import { ColorField, CommitNumber, Row, useFieldVisible } from './fields';
import { Icon } from './icons';
import { addStop, convertPaint, moveStop, normalizePaint, paintKind, removeStop, setStop, type GradientPaint, type PaintKind } from './inspectorModel';

const KINDS: { kind: PaintKind; label: string }[] = [
  { kind: 'none', label: 'None' },
  { kind: 'solid', label: 'Solid colour' },
  { kind: 'linear', label: 'Linear gradient' },
  { kind: 'radial', label: 'Radial gradient' },
];

export interface PaintFieldProps {
  id: string;
  label: string;
  searchKey?: string;
  value: Paint;
  allowNone?: boolean;
  disabled?: boolean;
  /** Why only a solid colour is allowed right now (e.g. the colour is animated); null/undefined = every kind. */
  solidOnly?: string | null;
  /** Rendered before the label (keyframe toggle). */
  lead?: React.ReactNode;
  /** Laid over the control's right edge (reset button). */
  reset?: React.ReactNode;
  testId?: string;
  onPreview?: (paint: Paint | null) => void;
  onCommit: (paint: Paint) => void;
}

export function PaintField({ id, label, searchKey, value, allowNone, disabled, solidOnly, lead, reset, testId, onPreview, onCommit }: PaintFieldProps) {
  const visible = useFieldVisible(label, searchKey);
  const kind = paintKind(value);
  if (!visible) return null;
  const commit = (p: Paint) => onCommit(normalizePaint(p));
  const kinds = KINDS.filter((k) => k.kind !== 'none' || allowNone);

  const switcher = (
    <div className="paint-kinds" role="radiogroup" aria-label={`${label} type`}>
      {kinds.map((k) => {
        const blocked = k.kind !== 'solid' && !!solidOnly && kind !== k.kind;
        return (
          <button
            key={k.kind}
            type="button"
            role="radio"
            aria-checked={kind === k.kind}
            className={`paint-kind ${k.kind} ${kind === k.kind ? 'on' : ''}`}
            title={blocked ? `${k.label} — ${solidOnly}` : k.label}
            disabled={disabled || blocked}
            data-testid={testId ? `${testId}-kind-${k.kind}` : undefined}
            onClick={() => kind !== k.kind && commit(convertPaint(value, k.kind))}
          />
        );
      })}
    </div>
  );

  return (
    <div className="paint-field" data-field={searchKey ?? label} data-testid={testId}>
      <Row label={label} htmlFor={kind === 'solid' ? id : undefined} searchKey={searchKey} lead={lead} reset={reset}>
        {kind === 'solid' && typeof value === 'string' ? (
          <ColorField id={id} value={value} disabled={disabled} testId={testId ? `${testId}-color` : undefined} onCommit={commit} />
        ) : kind === 'none' ? (
          <span className="paint-none">No {label.toLowerCase()}</span>
        ) : (
          <span className="paint-preview" style={{ background: paintToCss(value) }} aria-hidden />
        )}
      </Row>
      <div className="paint-sub">
        {switcher}
        <span className="fine">{typeof value === 'string' ? KINDS.find((k) => k.kind === kind)?.label : `${KINDS.find((k) => k.kind === kind)?.label} · ${value.stops.length} stops`}</span>
      </div>
      {typeof value !== 'string' && <GradientEditor paint={value} disabled={disabled} testId={testId} onPreview={onPreview} onCommit={commit} />}
    </div>
  );
}

function GradientEditor({ paint, disabled, testId, onPreview, onCommit }: { paint: GradientPaint; disabled?: boolean; testId?: string; onPreview?: (p: Paint | null) => void; onCommit: (p: Paint) => void }) {
  const [selected, setSelected] = useState(0);
  const [live, setLive] = useState<GradientPaint | null>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ index: number; moved: boolean } | null>(null);
  const shown = live ?? paint;
  const sel = Math.min(selected, shown.stops.length - 1);
  // The stop bar always shows the stops left → right, whatever the angle.
  const bar = paintToCss({ type: 'linear', angle: 90, stops: shown.stops });

  const offsetAt = (clientX: number) => {
    const r = barRef.current!.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / r.width));
  };
  const preview = (p: GradientPaint | null) => {
    setLive(p);
    onPreview?.(p);
  };

  return (
    <div className="gradient-editor">
      <div
        ref={barRef}
        className="grad-bar"
        title="Click to add a stop; drag a stop to move it"
        data-testid={testId ? `${testId}-bar` : undefined}
        onPointerDown={(e) => {
          if (disabled || e.button !== 0 || e.target !== barRef.current) return;
          const r = addStop(paint, offsetAt(e.clientX));
          setSelected(r.index);
          onCommit(r.paint);
        }}
      >
        <span className="grad-fill" style={{ background: bar }} />
        {shown.stops.map((s, i) => (
          <button
            key={i}
            type="button"
            className={`grad-stop ${i === sel ? 'on' : ''}`}
            style={{ left: `${s.offset * 100}%`, '--stop': s.color } as React.CSSProperties}
            disabled={disabled}
            aria-label={`Stop ${i + 1} at ${Math.round(s.offset * 100)}%`}
            data-testid={testId ? `${testId}-stop-${i}` : undefined}
            onPointerDown={(e) => {
              if (e.button !== 0) return;
              e.stopPropagation();
              setSelected(i);
              drag.current = { index: i, moved: false };
              e.currentTarget.setPointerCapture(e.pointerId);
            }}
            onPointerMove={(e) => {
              const d = drag.current;
              if (!d) return;
              d.moved = true;
              const r = moveStop(paint, d.index, offsetAt(e.clientX));
              setSelected(r.index);
              preview(r.paint);
            }}
            onPointerUp={(e) => {
              const d = drag.current;
              drag.current = null;
              if (!d?.moved) return;
              const r = moveStop(paint, d.index, offsetAt(e.clientX));
              preview(null);
              setSelected(r.index);
              onCommit(r.paint);
            }}
            onPointerCancel={() => {
              drag.current = null;
              preview(null);
            }}
          />
        ))}
      </div>
      <div className="grad-meta">
        {paint.type === 'linear' ? (
          <label className="grad-angle">
            <span>Angle</span>
            <CommitNumber value={paint.angle} step={15} min={-360} max={720} unit="°" disabled={disabled} testId={testId ? `${testId}-angle` : undefined} onCommit={(angle) => onCommit({ ...paint, angle })} />
          </label>
        ) : (
          <span className="fine">Radial — fills the box from the centre out</span>
        )}
        <button
          type="button"
          className="mini-btn"
          disabled={disabled}
          data-testid={testId ? `${testId}-add-stop` : undefined}
          onClick={() => {
            const r = addStop(paint);
            setSelected(r.index);
            onCommit(r.paint);
          }}
        >
          + Stop
        </button>
      </div>
      <ul className="grad-stops">
        {paint.stops.map((s, i) => (
          <li key={i} className={i === sel ? 'on' : ''} onFocus={() => setSelected(i)}>
            <ColorField value={s.color} disabled={disabled} testId={testId ? `${testId}-stop-${i}-color` : undefined} onCommit={(color) => onCommit(setStop(paint, i, { color }))} />
            <CommitNumber
              value={Math.round(s.offset * 1000) / 10}
              min={0}
              max={100}
              step={1}
              unit="%"
              disabled={disabled}
              testId={testId ? `${testId}-stop-${i}-offset` : undefined}
              onCommit={(pct) => {
                const r = moveStop(paint, i, pct / 100);
                setSelected(r.index);
                onCommit(r.paint);
              }}
            />
            <button
              type="button"
              className="mini-btn icon-only"
              title={paint.stops.length <= 2 ? 'A gradient needs at least two stops' : 'Remove stop'}
              disabled={disabled || paint.stops.length <= 2}
              data-testid={testId ? `${testId}-stop-${i}-remove` : undefined}
              onClick={() => onCommit(removeStop(paint, i))}
            >
              <Icon name="trash" size={13} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
