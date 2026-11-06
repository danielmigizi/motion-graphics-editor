// Inspector controls. Text-like inputs keep a local draft and commit ONE
// command on blur or Enter (Escape reverts); they never commit per keystroke.
// Numeric fields also scrub: drag the label (Shift ×10, Alt ×0.1) for a live
// preview and ONE command on release; ↑/↓ step the draft (Shift ×10).
//
// Filtering: Row / Section read FieldFilter (query tokens from the inspector's
// property search). A row whose label, key, section and aliases don't match
// renders nothing; CSS hides sections left empty (see .inspector[data-filtering]).
//
// Folding: a Section folds when a SectionFold is provided (the inspector does,
// remembering folds by title); everywhere else sections stay open. While
// filtering every section shows, so no match hides in a folded one.

import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Icon } from './icons';
import { FIELD_ALIASES, fieldMatches } from './inspectorSearch';

/** Query tokens of the inspector filter (empty = show everything). */
export const FieldFilter = createContext<readonly string[]>([]);
/** Full descriptor labels and control text shared by a field's nested controls. */
export const FieldAliases = createContext<readonly string[]>([]);
const SectionTitle = createContext('');

/** Folded section titles and how to toggle one; null = sections don't fold. */
export const SectionFold = createContext<{ folded: readonly string[]; toggle: (title: string) => void } | null>(null);

/** Whether a field passes the inspector filter. Call unconditionally (it is a hook). */
export function useFieldVisible(label: string, key?: string): boolean {
  const tokens = useContext(FieldFilter);
  const section = useContext(SectionTitle);
  const aliases = useContext(FieldAliases);
  return fieldMatches({ label, key, section, aliases: [...aliases, ...(key ? FIELD_ALIASES[key] ?? [] : [])] }, tokens);
}

export interface ScrubSpec {
  value: number;
  /** Value change per 2 px of drag. */
  step: number;
  min?: number;
  max?: number;
  integer?: boolean;
  disabled?: boolean;
  /** Live value while dragging; null when the drag ends or is cancelled. */
  onPreview?: (v: number | null) => void;
  onCommit: (v: number) => void;
}

const clampTo = (v: number, min?: number, max?: number) => Math.min(max ?? Infinity, Math.max(min ?? -Infinity, v));
const snapTo = (v: number, step: number, integer?: boolean) => (integer ? Math.round(v) : Math.round(Math.round(v / step) * step * 1e6) / 1e6);

/**
 * What the inspector is editing (document session, scene, element). A scrub or
 * slider drag belongs to the scope it started in: when the scope changes
 * mid-drag (another document opens, an agent selects another element), the
 * drag is cancelled and its preview cleared, so it never commits elsewhere.
 */
export const ScrubScope = createContext('');

/**
 * The scrub gesture without React: `getSpec` returns the field's current spec
 * and `getScope` its current ScrubScope. A drag commits only while the scope
 * it started in is still current.
 */
export function scrubController(getSpec: () => ScrubSpec | undefined, getScope: () => string) {
  let drag: { lastX: number; raw: number; value: number; moved: boolean; scope: string; clear?: (v: null) => void } | null = null;
  const cancel = () => {
    const d = drag;
    drag = null;
    if (d?.moved) d.clear?.(null);
  };
  /** The drag, if it is still in its starting scope; otherwise cancel it. */
  const current = () => {
    if (drag && drag.scope !== getScope()) cancel();
    return drag;
  };
  return {
    down(x: number) {
      const s = getSpec();
      if (!s || s.disabled) return;
      drag = { lastX: x, raw: s.value, value: s.value, moved: false, scope: getScope(), clear: s.onPreview };
    },
    move(x: number, mods: { shiftKey: boolean; altKey: boolean }) {
      const d = current();
      const s = getSpec();
      if (!d || !s) return;
      const dx = x - d.lastX;
      if (!d.moved && Math.abs(dx) < 3) return;
      d.moved = true;
      d.lastX = x;
      d.raw += (dx / 2) * s.step * (mods.shiftKey ? 10 : mods.altKey ? 0.1 : 1);
      d.raw = clampTo(d.raw, s.min, s.max);
      const v = clampTo(snapTo(d.raw, mods.altKey ? s.step / 10 : s.step, s.integer), s.min, s.max);
      if (v !== d.value) {
        d.value = v;
        s.onPreview?.(v);
      }
    },
    /** End the drag; true when it was a real drag in its own scope (the label click should be swallowed). */
    up(): boolean {
      const d = current();
      const s = getSpec();
      drag = null;
      if (!d?.moved || !s) return false;
      s.onPreview?.(null);
      if (d.value !== s.value) s.onCommit(d.value);
      return true;
    },
    cancel,
    /** Cancel a drag whose scope is gone (call when the scope changes). */
    syncScope() {
      current();
    },
  };
}

/** Pointer handlers that turn a label into a scrub handle. */
function useScrub(spec: ScrubSpec | undefined) {
  const scope = useContext(ScrubScope);
  const suppressClick = useRef(false);
  const latest = useRef({ spec, scope });
  latest.current = { spec, scope };
  const ctl = useRef<ReturnType<typeof scrubController> | null>(null);
  ctl.current ??= scrubController(() => latest.current.spec, () => latest.current.scope);
  const controller = ctl.current;
  const off = !spec || !!spec.disabled;
  useEffect(() => controller.syncScope(), [controller, scope]);
  // Disabled or removed mid-drag: no pointerup will reach us, so end it now.
  useEffect(() => {
    if (off) controller.cancel();
  }, [controller, off]);
  useEffect(() => () => controller.cancel(), [controller]);
  if (off) return {};
  return {
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      controller.down(e.clientX);
      e.currentTarget.setPointerCapture(e.pointerId);
    },
    onPointerMove: (e: React.PointerEvent<HTMLElement>) => controller.move(e.clientX, e),
    onPointerUp: () => {
      if (controller.up()) suppressClick.current = true;
    },
    onPointerCancel: () => controller.cancel(),
    onClick: (e: React.MouseEvent) => {
      // A drag ends with a click on the label; don't let it focus the input.
      if (suppressClick.current) e.preventDefault();
      suppressClick.current = false;
    },
  };
}

interface RowProps {
  label: string;
  htmlFor?: string;
  children: React.ReactNode;
  suffix?: React.ReactNode;
  /** Stable key for filtering and aliases (e.g. 'x', 'fontSize'). */
  searchKey?: string;
  /** Make the label a scrub handle for a numeric field. */
  scrub?: ScrubSpec;
  /** Tooltip on the label. */
  title?: string;
  /** Rendered before the label (e.g. a keyframe toggle). */
  lead?: React.ReactNode;
  /** Laid over the control's right edge, shown on hover (a reset button). */
  reset?: React.ReactNode;
  /** The label sits inside the field as a quiet prefix ("X 330 px"): two such fields share a row. */
  inline?: boolean;
}

export function Row({ label, htmlFor, children, suffix, searchKey, scrub, title, lead, reset, inline }: RowProps) {
  const visible = useFieldVisible(label, searchKey);
  const scrubHandlers = useScrub(scrub);
  if (!visible) return null;
  const scrubbable = !!scrub && !scrub.disabled;
  return (
    <div className={`row${inline ? ' inline' : ''}${lead ? ' has-lead' : ''}`} data-field={searchKey ?? label}>
      {lead}
      <label
        className={`row-label ${scrubbable ? 'scrub' : ''}`}
        htmlFor={htmlFor}
        title={title ?? (scrubbable ? `${label} — drag to scrub (Shift ×10, Alt ×0.1)` : undefined)}
        {...scrubHandlers}
      >
        {label}
      </label>
      <div className="row-control">
        {children}
        {reset !== undefined && <div className="row-reset">{reset}</div>}
      </div>
      {suffix !== undefined && <div className="row-suffix">{suffix}</div>}
    </div>
  );
}

function useDraft(value: string) {
  const [draft, setDraft] = useState(value);
  const focused = useRef(false);
  /**
   * Set right before a key handler blurs the field after it already reverted
   * (Escape) or committed (Enter). The blur handler still sees the old draft in
   * its closure, so it must not commit again.
   */
  const skipBlurCommit = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(value);
  }, [value]);
  const onFocus = () => {
    focused.current = true;
    skipBlurCommit.current = false;
  };
  /** Returns whether the blur should commit the draft. */
  const onBlur = () => {
    focused.current = false;
    const skip = skipBlurCommit.current;
    skipBlurCommit.current = false;
    return !skip;
  };
  /** Blur without the blur handler committing. */
  const blurWithoutCommit = (el: HTMLElement) => {
    skipBlurCommit.current = true;
    el.blur();
    // If the element was not focused, no blur event fires; don't leak the flag.
    skipBlurCommit.current = false;
  };
  return { draft, setDraft, focused, onFocus, onBlur, blurWithoutCommit };
}

interface TextProps {
  id?: string;
  value: string;
  onCommit: (v: string) => void;
  disabled?: boolean;
  multiline?: boolean;
  maxLength?: number;
  testId?: string;
  placeholder?: string;
  className?: string;
  title?: string;
  tabIndex?: number;
}

export function CommitText({ id, value, onCommit, disabled, multiline, maxLength, testId, placeholder, className, title, tabIndex }: TextProps) {
  const { draft, setDraft, onFocus, onBlur, blurWithoutCommit } = useDraft(value);
  const commit = () => {
    if (draft !== value) onCommit(draft);
  };
  const common = {
    id,
    value: draft,
    disabled,
    maxLength,
    placeholder,
    title,
    tabIndex,
    className: `input ${className ?? ''}`,
    'data-testid': testId,
    onFocus,
    onBlur: () => {
      if (onBlur()) commit();
    },
    onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(e.target.value),
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        setDraft(value);
        blurWithoutCommit(e.target as HTMLElement);
      }
      if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        commit();
        blurWithoutCommit(e.target as HTMLElement);
      }
    },
  };
  return multiline ? <textarea rows={3} {...common} /> : <input type="text" {...common} />;
}

interface NumberProps {
  id?: string;
  value: number;
  onCommit: (v: number) => void;
  /** Live value while stepping with ↑/↓ (null when the edit ends). */
  onPreview?: (v: number | null) => void;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  disabled?: boolean;
  testId?: string;
  unit?: string;
  /** Tooltip, e.g. a frame count in seconds. */
  title?: string;
}

const fmt = (n: number) => String(Math.round(n * 1000) / 1000);

export function CommitNumber({ id, value, onCommit, onPreview, min, max, step = 1, integer, disabled, testId, unit, title }: NumberProps) {
  const { draft, setDraft, onFocus, onBlur, blurWithoutCommit } = useDraft(fmt(value));
  const [bad, setBad] = useState(false);
  const stepped = useRef(false);
  const endPreview = () => {
    if (stepped.current) onPreview?.(null);
    stepped.current = false;
  };
  const commit = () => {
    endPreview();
    const n = Number(draft);
    if (draft.trim() === '' || !Number.isFinite(n)) {
      setBad(true);
      setDraft(fmt(value));
      setTimeout(() => setBad(false), 1200);
      return;
    }
    let v = integer ? Math.round(n) : n;
    if (min !== undefined) v = Math.max(min, v);
    if (max !== undefined) v = Math.min(max, v);
    setDraft(fmt(v));
    if (v !== value) onCommit(v);
  };
  return (
    <span className={`number-wrap ${bad ? 'is-bad' : ''}`} title={title}>
      <input
        id={id}
        className="input number"
        inputMode="decimal"
        value={draft}
        disabled={disabled}
        data-testid={testId}
        onFocus={onFocus}
        onBlur={() => {
          if (onBlur()) commit();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            blurWithoutCommit(e.target as HTMLInputElement);
          } else if (e.key === 'Escape') {
            endPreview();
            setDraft(fmt(value));
            blurWithoutCommit(e.target as HTMLInputElement);
          } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            const v = clampTo((Number(draft) || 0) + delta, min, max);
            const next = integer ? Math.round(v) : Math.round(v * 1000) / 1000;
            setDraft(fmt(next));
            if (onPreview) {
              stepped.current = true;
              onPreview(next);
            }
          }
        }}
      />
      {unit && <span className="unit">{unit}</span>}
    </span>
  );
}

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function ColorField({ id, value, onCommit, allowNone, disabled, testId }: { id?: string; value: string; onCommit: (v: string) => void; allowNone?: boolean; disabled?: boolean; testId?: string }) {
  const { draft, setDraft, onFocus, onBlur, blurWithoutCommit } = useDraft(value);
  const isNone = value === 'none';
  const swatch = HEX.test(value) ? (value.length === 4 ? `#${[...value.slice(1)].map((c) => c + c).join('')}` : value.slice(0, 7)) : '#000000';
  // React maps onChange to the 'input' event; commit once on the native 'change' (picker closed).
  const pickerRef = useRef<HTMLInputElement>(null);
  const latest = useRef({ value, onCommit });
  latest.current = { value, onCommit };
  useEffect(() => {
    const el = pickerRef.current;
    if (!el) return;
    const onChange = () => {
      const v = el.value.toUpperCase();
      if (v !== latest.current.value) latest.current.onCommit(v);
    };
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, []);
  const commit = () => {
    const v = draft.trim();
    if (v === value) return;
    if (HEX.test(v) || (allowNone && v === 'none')) onCommit(v.toUpperCase() === 'NONE' ? 'none' : v.toUpperCase());
    else setDraft(value);
  };
  return (
    <span className="color-field">
      <input
        type="color"
        className="swatch"
        value={swatch}
        disabled={disabled}
        aria-label="Pick colour"
        data-testid={testId ? `${testId}-picker` : undefined}
        ref={pickerRef}
        onChange={(e) => setDraft(e.target.value.toUpperCase())}
      />
      <input
        id={id}
        className={`input hex ${isNone ? 'is-none' : ''}`}
        value={draft}
        disabled={disabled}
        data-testid={testId}
        onFocus={onFocus}
        onBlur={() => {
          if (onBlur()) commit();
        }}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            setDraft(value);
            blurWithoutCommit(e.target as HTMLInputElement);
          }
        }}
      />
      {allowNone && (
        <button className="mini-btn" disabled={disabled || isNone} onClick={() => onCommit('none')} title="No colour">
          None
        </button>
      )}
    </span>
  );
}

export function SelectField<T extends string | number>({ id, value, options, onCommit, disabled, testId }: { id?: string; value: T; options: readonly { value: T; label: string }[]; onCommit: (v: T) => void; disabled?: boolean; testId?: string }) {
  return (
    <select
      id={id}
      className="input select"
      value={String(value)}
      disabled={disabled}
      data-testid={testId}
      onChange={(e) => {
        const opt = options.find((o) => String(o.value) === e.target.value);
        if (opt && opt.value !== value) onCommit(opt.value);
      }}
    >
      {!options.some((o) => o.value === value) && <option value={String(value)}>{String(value)}</option>}
      {options.map((o) => (
        <option key={String(o.value)} value={String(o.value)}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function CheckField({ id, checked, onCommit, disabled, testId, label }: { id?: string; checked: boolean; onCommit: (v: boolean) => void; disabled?: boolean; testId?: string; label?: string }) {
  return (
    <label className="check">
      <input id={id} type="checkbox" checked={checked} disabled={disabled} data-testid={testId} onChange={(e) => onCommit(e.target.checked)} />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Section({ title, children, actions, testId }: { title: string; children: React.ReactNode; actions?: React.ReactNode; testId?: string }) {
  const fold = useContext(SectionFold);
  const filtering = useContext(FieldFilter).length > 0;
  const foldable = !!fold && !filtering;
  const folded = foldable && fold.folded.includes(title);
  return (
    <section className={`section${folded ? ' is-folded' : ''}`} data-testid={testId}>
      <header className="section-head">
        {foldable ? (
          <h3>
            <button type="button" className="section-fold" aria-expanded={!folded} data-testid={testId ? `${testId}-fold` : undefined} onClick={() => fold.toggle(title)}>
              <Icon name="down" size={12} />
              {title}
            </button>
          </h3>
        ) : (
          <h3>{title}</h3>
        )}
        {actions && <div className="section-actions">{actions}</div>}
      </header>
      {!folded && (
        <SectionTitle.Provider value={title}>
          <div className="section-body">{children}</div>
        </SectionTitle.Provider>
      )}
    </section>
  );
}

/** Row + CommitNumber with a scrubbable label; the input follows the scrub live. */
export function NumberField({
  label,
  searchKey,
  title,
  lead,
  suffix,
  reset,
  inline,
  onPreview,
  ...num
}: Omit<NumberProps, 'onPreview'> & { label: string; searchKey?: string; lead?: React.ReactNode; suffix?: React.ReactNode; reset?: React.ReactNode; inline?: boolean; onPreview?: (v: number | null) => void }) {
  const [live, setLive] = useState<number | null>(null);
  const preview = (v: number | null) => {
    setLive(v);
    onPreview?.(v);
  };
  return (
    <Row
      label={label}
      htmlFor={num.id}
      searchKey={searchKey}
      lead={lead}
      suffix={suffix}
      reset={reset}
      inline={inline}
      scrub={{ value: num.value, step: num.step ?? 1, min: num.min, max: num.max, integer: num.integer, disabled: num.disabled, onPreview: preview, onCommit: num.onCommit }}
    >
      <CommitNumber {...num} title={title} value={live ?? num.value} onPreview={onPreview} />
    </Row>
  );
}

/** Range slider: live preview while dragging, ONE commit on release (native 'change'). */
export function Slider({
  value,
  min,
  max,
  step,
  disabled,
  testId,
  ariaLabel,
  onPreview,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  testId?: string;
  ariaLabel: string;
  onPreview?: (v: number | null) => void;
  onCommit: (v: number) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [live, setLive] = useState<number | null>(null);
  const scope = useContext(ScrubScope);
  const latest = useRef({ value, onPreview, onCommit, scope });
  latest.current = { value, onPreview, onCommit, scope };
  /** The scope a drag started in, and how to clear its preview (see ScrubScope). */
  const drag = useRef<{ scope: string; clear?: (v: null) => void; previewed?: boolean } | null>(null);
  const begin = () => {
    drag.current ??= { scope: latest.current.scope, clear: latest.current.onPreview };
    return drag.current.scope === latest.current.scope;
  };
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onChange = () => {
      const v = Number(el.value);
      const d = drag.current;
      drag.current = null;
      setLive(null);
      // Cancelled when the scope changed mid-drag: its preview is already cleared.
      if (d && d.scope !== latest.current.scope) return;
      latest.current.onPreview?.(null);
      if (v !== latest.current.value) latest.current.onCommit(v);
    };
    el.addEventListener('change', onChange);
    return () => el.removeEventListener('change', onChange);
  }, []);
  useEffect(() => {
    const d = drag.current;
    if (!d || d.scope === scope || !d.previewed) return;
    d.previewed = false;
    setLive(null);
    d.clear?.(null);
  }, [scope]);
  const shown = live ?? value;
  return (
    <input
      ref={ref}
      type="range"
      className="slider"
      min={min}
      max={max}
      step={step}
      value={shown}
      disabled={disabled}
      aria-label={ariaLabel}
      data-testid={testId}
      style={{ '--fill': `${((shown - min) / (max - min || 1)) * 100}%` } as React.CSSProperties}
      onPointerDown={() => {
        drag.current = null;
        begin();
      }}
      onChange={(e) => {
        if (!begin()) return;
        const v = Number(e.target.value);
        drag.current!.previewed = true;
        setLive(v);
        onPreview?.(v);
      }}
    />
  );
}

/**
 * Destructive action that needs two clicks: the first arms it (the label
 * changes to `confirmLabel`), the second runs it. Disarms after 4 s or on blur.
 */
export function ConfirmButton({ label, confirmLabel, onConfirm, disabled, testId, title }: { label: string; confirmLabel: string; onConfirm: () => void; disabled?: boolean; testId?: string; title?: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);
  return (
    <button
      type="button"
      className={`mini-btn ${armed ? 'armed' : ''}`}
      disabled={disabled}
      data-testid={testId}
      title={armed ? 'Click again to confirm' : title}
      onBlur={() => setArmed(false)}
      onClick={() => {
        if (!armed) return setArmed(true);
        setArmed(false);
        onConfirm();
      }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}
