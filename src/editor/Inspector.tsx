// The Inspector tab's body (InspectorColumn.tsx draws its head, tabs and
// search). Property fields are generated from COMPONENTS[type].fields —
// nothing here is specific to one element type except the Group / Instance /
// Path extras. Three tabs (inspectorView.ts decides which shows):
// - Design: what the element is and looks like (identity, layout, its
//   properties, appearance), every animatable field with its key toggle.
// - Animate: time and motion (timing, built-in reveals, every animated
//   property with its base, keyframes and easing), or an empty state.
// - Scene: the scene and the project's audio; all that shows with nothing
//   selected.
// A search query shows the matching fields of Design and Animate together.
//
// Every animatable field (transform x/y/rotation/scale/opacity, component
// props marked `animatable`, effects) carries a key toggle — ◇ static,
// ◆ keyframe at the playhead, ◈ animated between keys — and follows the
// base-vs-animated routing in inspectorModel.ts: a static field edits its
// base; an animated field keys the value at the playhead.

import React, { useMemo, useState } from 'react';
import { EASING_NAMES } from '../core/animation';
import { COMPONENTS, componentFields, type FieldDescriptor } from '../core/components';
import { newId } from '../core/ids';
import { framesToSeconds, sceneStartFrame } from '../core/timing';
import type { AnimatableProperty, AudioClip, BlendMode, Element, ElementChanges, Paint, Project, Scene, TransitionType } from '../core/types';
import { DuckControl } from './AudioTools';
import { newAsset, uploadAsset } from './assets';
import { LOCKED_NOTICE, shortcutLabel } from './editActions';
import { CheckField, ColorField, CommitNumber, CommitText, ConfirmButton, FieldAliases, FieldFilter, NumberField, Row, ScrubScope, Section, SectionFold, SelectField, Slider, useFieldVisible } from './fields';
import { round2 } from './geometry';
import { Icon } from './icons';
import {
  baseEdit,
  baseValueOf,
  colorToHex,
  componentFromGroup,
  easingEdit,
  easingText,
  inLifetime,
  keyframesOf,
  keyState,
  localFrameOf,
  maskedBy,
  maskSources,
  previewElement,
  removeAnimation,
  removeKeyEdit,
  resetEdit,
  routeEdit,
  toggleKey,
  valueAt,
  type Edit,
  type EffectKey,
  type ElementTarget,
  type FieldRef,
  type KeyState,
} from './inspectorModel';
import { queryTokens } from './inspectorSearch';
import { useInspectorView, type InspectorTab } from './inspectorView';
import { PaintField } from './PaintField';
import { enterPathEdit } from './PathEditor';
import { useCurrentScene, useEditor } from './store';
import { replacementChanges } from './videoEdits';
import { VIDEO_SECTION_KEYS, VideoSection } from './VideoSection';

const secs = (frames: number, fps: number) => `${framesToSeconds(frames, fps).toFixed(2)} s`;
const framesTitle = (frames: number, fps: number) => `${frames} frames = ${secs(frames, fps)} at ${fps} fps`;
const runEdit = (edit: Edit | null) => (edit ? useEditor.getState().run(edit.command, edit.label) : false);

/** What the element half of the inspector draws: one tab, or every field that matches a search. */
type ElementView = 'design' | 'animate' | 'search';

export function Inspector({ tab, query }: { tab: InspectorTab; query: string }) {
  const scene = useCurrentScene();
  const elementId = useEditor((s) => s.selection.elementId);
  const docSession = useEditor((s) => s.docSession);
  const folded = useInspectorView((s) => s.folded);
  const toggleFold = useInspectorView((s) => s.toggleFold);
  const fold = useMemo(() => ({ folded, toggle: toggleFold }), [folded, toggleFold]);
  const element = scene?.elements.find((e) => e.id === elementId) ?? null;
  const tokens = useMemo(() => queryTokens(query), [query]);
  if (!scene) return <div className="empty">No scenes in this project.</div>;
  const view: ElementView | null = !element ? null : tokens.length ? 'search' : tab === 'scene' ? null : tab;
  // The tab bar (InspectorColumn.tsx) shows only for an element, and hides while a query is typed.
  const inTabs = !!element && !tokens.length;
  return (
    <div
      className="inspector"
      id="inspector-body"
      data-testid="inspector"
      data-view={view ?? 'scene'}
      role={inTabs ? 'tabpanel' : undefined}
      aria-labelledby={inTabs ? `inspector-tab-${tab}` : undefined}
      tabIndex={-1}
      data-filtering={tokens.length ? '' : undefined}
    >
      {scene.locked && <LockedNotice scene={scene} />}
      <SectionFold.Provider value={fold}>
        <FieldFilter.Provider value={tokens}>
          {/* A scrub that starts here never lands on another document, scene or element. */}
          <ScrubScope.Provider value={`${docSession}/${scene.id}/${element?.id ?? ''}`}>
            {element && view === 'search' ? (
              <>
                <div className="inspector-element-results"><ElementInspector scene={scene} element={element} view={view} /></div>
                <div className="inspector-scene-results"><SceneInspector scene={scene} /></div>
              </>
            ) : element && view ? <ElementInspector scene={scene} element={element} view={view} /> : <SceneInspector scene={scene} />}
          </ScrubScope.Provider>
        </FieldFilter.Provider>
      </SectionFold.Provider>
      {tokens.length > 0 && <p className="filter-empty">No properties match “{query.trim()}”.</p>}
    </div>
  );
}

function LockedNotice({ scene }: { scene: Scene }) {
  const run = useEditor((s) => s.run);
  return (
    <div className="notice locked" data-testid="locked-notice">
      <Icon name="lock" />
      <span>{LOCKED_NOTICE}</span>
      <button className="btn small" data-testid="unlock-scene" onClick={() => run({ type: 'setSceneLock', sceneId: scene.id, locked: false }, `Unlock “${scene.name}”`)}>
        Unlock
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Field context, units, animatable field
// ---------------------------------------------------------------------------

interface FieldCtx {
  t: ElementTarget;
  /** Element-relative frame at the playhead. */
  lf: number;
  /** Global frame of the element's frame 0 (for seeking to keys). */
  origin: number;
  disabled: boolean;
  fps: number;
}

/** How a number shows: unit suffix, display factor (0..1 → %), frames get a seconds tooltip. */
interface NumSpec {
  unit?: string;
  factor?: number;
  step: number;
  min?: number;
  max?: number;
  integer?: boolean;
  frames?: boolean;
}

const TRANSFORM_FIELDS: { property: AnimatableProperty; label: string; spec: NumSpec }[] = [
  { property: 'x', label: 'X', spec: { unit: 'px', step: 1 } },
  { property: 'y', label: 'Y', spec: { unit: 'px', step: 1 } },
  { property: 'rotation', label: 'Rotation', spec: { unit: '°', step: 1 } },
  { property: 'scale', label: 'Scale', spec: { unit: '%', factor: 100, step: 1, min: 0 } },
  { property: 'opacity', label: 'Opacity', spec: { unit: '%', factor: 100, step: 1, min: 0, max: 100 } },
];

const EFFECT_FIELDS: { key: EffectKey; label: string; spec: NumSpec }[] = [
  { key: 'blur', label: 'Blur', spec: { unit: 'px', step: 1, min: 0, max: 200 } },
  { key: 'brightness', label: 'Brightness', spec: { unit: '%', factor: 100, step: 1, min: 0, max: 300 } },
  { key: 'contrast', label: 'Contrast', spec: { unit: '%', factor: 100, step: 1, min: 0, max: 300 } },
  { key: 'saturate', label: 'Saturation', spec: { unit: '%', factor: 100, step: 1, min: 0, max: 300 } },
];

/** Units for component number props (components.ts carries ranges, not units). */
const PROP_UNITS: Record<string, Pick<NumSpec, 'unit' | 'factor' | 'frames'>> = {
  fontSize: { unit: 'px' },
  letterSpacing: { unit: 'px' },
  strokeWidth: { unit: 'px' },
  cornerRadius: { unit: 'px' },
  lineHeight: { unit: '×' },
  revealDurationInFrames: { unit: 'f', frames: true },
  revealStagger: { unit: 'f', frames: true },
  typingDurationInFrames: { unit: 'f', frames: true },
  timeOffset: { unit: 'f', frames: true },
  trimStart: { unit: '%', factor: 100 },
  trimEnd: { unit: '%', factor: 100 },
  trimOffset: { unit: '%', factor: 100 },
};

const TRIM_KEYS = new Set(['trimStart', 'trimEnd', 'trimOffset']);

/** Component props about time and motion: they live on the Animate tab (a text's reveal in its own section). */
const MOTION_PROPS: ReadonlySet<string> = new Set(['reveal', 'revealStagger', 'revealOrder', 'revealEasing', 'revealDurationInFrames', 'typing', 'typingDurationInFrames', 'buildIn', 'timeOffset']);
const isReveal = (f: FieldDescriptor) => f.key.startsWith('reveal');

/** Labels that fit the 88 px label column, where the section or the unit in the field says the rest. */
const SHORT_LABELS: Record<string, string> = {
  reveal: 'Style',
  revealStagger: 'Stagger',
  revealOrder: 'Order',
  revealEasing: 'Easing',
  revealDurationInFrames: 'Length',
  typing: 'Typing',
  typingDurationInFrames: 'Typing for',
};

/** What a check box says beside itself when its short label leaves something out. */
const CHECK_TEXT: Record<string, string> = { typing: 'Indicator first' };

/** "Tracking (px)" → "Tracking" (the unit sits in the field); "trimStart" → "Trim start". `short`: the label column's version. */
function fieldLabel(f: FieldDescriptor, short = true): string {
  if (short && SHORT_LABELS[f.key]) return SHORT_LABELS[f.key];
  if (f.label === f.key) return f.key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()).replace(/ ([A-Z])/g, (_, c: string) => ` ${c.toLowerCase()}`);
  return f.label.replace(/\s*\((px|°|%)\)$/, '');
}

function propSpec(f: Extract<FieldDescriptor, { kind: 'number' }>): NumSpec {
  const u = PROP_UNITS[f.key] ?? {};
  const k = u.factor ?? 1;
  return { ...u, step: f.step * k, min: f.min * k, max: f.max * k, integer: f.integer && k === 1 };
}

const fmtNum = (n: number) => String(Math.round(n * 100) / 100).replace('-', '−');

function formatValue(v: unknown, spec?: NumSpec): React.ReactNode {
  if (typeof v === 'number') return `${fmtNum(v * (spec?.factor ?? 1))}${spec?.unit ? (spec.unit === '%' || spec.unit === '°' ? spec.unit : ` ${spec.unit}`) : ''}`;
  if (typeof v === 'string') {
    const hex = colorToHex(v);
    if (hex) return <Swatch color={v} text={hex} />;
    return v;
  }
  if (typeof v === 'boolean') return v ? 'on' : 'off';
  return '—';
}

function Swatch({ color, text }: { color: string; text: string }) {
  return (
    <span className="mini-swatch">
      <i style={{ background: color }} />
      {text}
    </span>
  );
}

/** Keyframe values: transform tracks store offsets (+40 px) and factors (×1.2). */
function formatKeyValue(field: FieldRef, v: unknown, spec?: NumSpec): React.ReactNode {
  if (field.kind === 'transform' && typeof v === 'number') {
    if (field.property === 'scale' || field.property === 'opacity') return `×${fmtNum(v)}`;
    return `${v >= 0 ? '+' : ''}${fmtNum(v)}${field.property === 'rotation' ? '°' : ' px'}`;
  }
  return formatValue(v, spec);
}

const KEY_GLYPH_TITLE: Record<KeyState, string> = {
  none: 'Not animated — click to add a keyframe at the playhead',
  key: 'Keyframe at the playhead — click to remove it',
  animated: 'Animated — click to add a keyframe at the playhead',
};

function KeyToggle({ state, disabled, title, onClick, testId }: { state: KeyState; disabled: boolean; title: string; onClick: () => void; testId: string }) {
  return (
    <button type="button" className={`key-toggle ${state}`} disabled={disabled} title={title} aria-label={title} data-testid={testId} data-state={state} onClick={onClick}>
      <Icon name="diamond" size={12} />
    </button>
  );
}

interface ControlArgs {
  value: unknown;
  state: KeyState;
  lead: React.ReactNode;
  /** The reset button, laid over the control's right edge. */
  reset: React.ReactNode;
  disabled: boolean;
  /** Why the control is disabled, if it is. */
  title?: string;
  onPreview: (v: unknown | null) => void;
  onCommit: (v: unknown) => void;
}

interface AnimFieldProps {
  ctx: FieldCtx;
  field: FieldRef;
  label: string;
  searchKey: string;
  spec?: NumSpec;
  /** Why this field cannot be animated right now (e.g. a gradient paint); null = it can. */
  cannotAnimate?: string | null;
  control: (c: ControlArgs) => React.ReactNode;
  /** The Animate tab's version: the base / now line and the keyframe list (open) under the field. */
  detail?: boolean;
}

/**
 * An animatable field: key toggle, base-vs-animated routing and reset; with
 * `detail` (the Animate tab) also its base, keyframe list and Remove animation.
 */
function AnimField({ ctx, field, label, searchKey, spec, cannotAnimate, control, detail }: AnimFieldProps) {
  const visible = useFieldVisible(label, searchKey);
  const [open, setOpen] = useState(true);
  if (!visible) return null;
  const { t, lf, disabled } = ctx;
  const el = t.element;
  const state = keyState(el, field, lf);
  const inRange = inLifetime(el, lf);
  const frames = keyframesOf(el, field);
  const lockedOut = state !== 'none' && !inRange;
  const resetTo = resetEdit(t, field, lf, label.toLowerCase());
  const blockedKey = state === 'none' ? (cannotAnimate ?? null) : null;
  const value = state === 'none' ? baseValueOf(el, field) : valueAt(el, field, lf);
  const setTransient = useEditor.getState().setTransient;

  const lead = (
    <KeyToggle
      state={state}
      disabled={disabled || !inRange || !!blockedKey}
      title={blockedKey ?? (!inRange ? 'The playhead is outside this element — move it onto the element to key' : KEY_GLYPH_TITLE[state])}
      testId={`key-${searchKey}`}
      onClick={() => runEdit(toggleKey(t, field, lf, label.toLowerCase()))}
    />
  );
  const reset = (
    <button
      type="button"
      className="mini-btn icon-only reset-btn"
      disabled={disabled || !resetTo}
      title={resetTo ? resetTo.label : 'Already at its default'}
      aria-label={resetTo ? resetTo.label : `Reset ${label}`}
      data-testid={`reset-${searchKey}`}
      onClick={() => runEdit(resetTo)}
    >
      <Icon name="undo" size={12} />
    </button>
  );

  return (
    <div className={`anim-field ${state}`} data-field={searchKey}>
      {control({
        value,
        state,
        lead,
        reset,
        disabled: disabled || lockedOut,
        title: lockedOut ? 'Animated — move the playhead onto the element to key a new value' : undefined,
        onPreview: (v) => setTransient(v === null ? null : { sceneId: t.sceneId, element: previewElement(el, field, v, lf) }),
        onCommit: (v) => runEdit(routeEdit(t, field, v, lf, label.toLowerCase())),
      })}
      {detail && state !== 'none' && (
        <div className="anim-sub" data-testid={`anim-sub-${searchKey}`}>
          <span className="anim-base" title={field.kind === 'transform' ? 'Base layout value; the animation is applied on top of it' : 'Used when the animation is removed'}>
            Base{' '}
            {field.kind === 'transform' && spec ? (
              <CommitNumber
                value={round2(Number(baseValueOf(el, field)) * (spec.factor ?? 1))}
                step={spec.step}
                min={spec.min}
                max={spec.max}
                unit={spec.unit}
                disabled={disabled}
                testId={`base-${searchKey}`}
                onCommit={(v) => runEdit(baseEdit(t, field, v / (spec.factor ?? 1), `base ${label.toLowerCase()}`))}
              />
            ) : (
              formatValue(baseValueOf(el, field), spec)
            )}
          </span>
          <span className="anim-now">now {formatValue(valueAt(el, field, lf), spec)}</span>
          <button type="button" className="link anim-count" aria-expanded={open} data-testid={`keys-${searchKey}`} onClick={() => setOpen(!open)}>
            {frames.length} key{frames.length === 1 ? '' : 's'} <Icon name={open ? 'down' : 'right'} size={12} />
          </button>
        </div>
      )}
      {detail && state !== 'none' && open && <KeyframeList ctx={ctx} field={field} label={label} searchKey={searchKey} spec={spec} />}
    </div>
  );
}

function KeyframeList({ ctx, field, label, searchKey, spec }: { ctx: FieldCtx; field: FieldRef; label: string; searchKey: string; spec?: NumSpec }) {
  const { t, lf, disabled, origin } = ctx;
  const frames = keyframesOf(t.element, field);
  const name = label.toLowerCase();
  return (
    <div className="kf-panel">
      <ul className="kf-list">
        {frames.map((k, i) => {
          const last = i === frames.length - 1;
          const custom = typeof k.easing !== 'string';
          return (
            <li key={k.frame} className={k.frame === lf ? 'here' : ''}>
              <button type="button" className="link" title="Move the playhead to this keyframe" onClick={() => useEditor.getState().seek(origin + k.frame)}>
                f {k.frame}
              </button>
              <span className="kf-val">{formatKeyValue(field, k.value, spec)}</span>
              <select
                className="input select"
                value={custom ? 'custom' : String(k.easing)}
                disabled={disabled || last}
                title={last ? 'No segment after the last keyframe' : custom ? `Custom curve ${easingText(k.easing)} — pick a preset to replace it` : 'Easing into the next keyframe'}
                data-testid={`kf-easing-${searchKey}-${k.frame}`}
                onChange={(e) => e.target.value !== 'custom' && runEdit(easingEdit(t, field, k.frame, e.target.value as (typeof EASING_NAMES)[number], name))}
              >
                {custom && <option value="custom">Custom curve…</option>}
                {EASING_NAMES.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
              <button type="button" className="mini-btn icon-only" title="Remove this keyframe" disabled={disabled} onClick={() => runEdit(removeKeyEdit(t, field, k.frame, name))}>
                <Icon name="trash" size={12} />
              </button>
              {custom && !last && <span className="kf-curve">{easingText(k.easing)}</span>}
            </li>
          );
        })}
      </ul>
      <ConfirmButton
        label="Remove animation"
        confirmLabel={`Delete all ${frames.length} keys?`}
        disabled={disabled}
        testId={`remove-anim-${searchKey}`}
        title={`Delete every ${name} keyframe; the base value stays`}
        onConfirm={() => runEdit(removeAnimation(t, field, name))}
      />
    </div>
  );
}

/** Control renderer for a numeric animatable field; `inline` for one of a pair (X / Y). */
function numberControl(label: string, searchKey: string, spec: NumSpec, fps: number, inline?: boolean) {
  return (c: ControlArgs) => {
    const f = spec.factor ?? 1;
    const v = Number(c.value ?? spec.min ?? 0);
    return (
      <NumberField
        id={`f-${searchKey}`}
        label={label}
        searchKey={searchKey}
        inline={inline}
        lead={c.lead}
        reset={c.reset}
        testId={`inspector-field-${searchKey}`}
        value={round2(v * f)}
        min={spec.min}
        max={spec.max}
        step={spec.step}
        integer={spec.integer}
        unit={spec.unit}
        disabled={c.disabled}
        title={c.title ?? (spec.frames ? framesTitle(v, fps) : undefined)}
        onPreview={(x) => c.onPreview(x === null ? null : x / f)}
        onCommit={(x) => c.onCommit(x / f)}
      />
    );
  };
}

// ---------------------------------------------------------------------------
// Element
// ---------------------------------------------------------------------------

function ElementInspector({ scene, element, view }: { scene: Scene; element: Element; view: ElementView }) {
  const run = useEditor((s) => s.run);
  const project = useEditor((s) => s.doc.project);
  const playhead = useEditor((s) => s.playhead);
  const disabled = scene.locked;
  const update = (changes: ElementChanges, label: string) => run({ type: 'updateElement', sceneId: scene.id, elementId: element.id, changes }, label);
  const sceneStart = sceneStartFrame(project, scene.id);
  const frameInScene = playhead - sceneStart;
  const lf = localFrameOf(scene.elements, element, frameInScene);
  const ctx: FieldCtx = { t: { sceneId: scene.id, element }, lf, origin: playhead - lf, disabled, fps: project.fps };
  const parent = element.parentId ? scene.elements.find((e) => e.id === element.parentId) : undefined;
  const t = element.transform;
  const absStart = frameInScene - lf;

  const fields = componentFields(element.type, project.fps).filter((f) => element.type !== 'video' || !VIDEO_SECTION_KEYS.has(f.key));
  const designFields = fields.filter((f) => !MOTION_PROPS.has(f.key));
  const motionFields = fields.filter((f) => MOTION_PROPS.has(f.key));
  const propField = (f: FieldDescriptor) => <PropField key={f.key} field={f} ctx={ctx} scene={scene} project={project} />;
  const transformField = (f: (typeof TRANSFORM_FIELDS)[number], opts: { inline?: boolean; detail?: boolean } = {}) => (
    <AnimField key={f.property} ctx={ctx} field={{ kind: 'transform', property: f.property }} label={f.label} searchKey={f.property} spec={f.spec} detail={opts.detail} control={numberControl(f.label, f.property, f.spec, project.fps, opts.inline)} />
  );
  const effectField = (f: (typeof EFFECT_FIELDS)[number], detail?: boolean) => (
    <AnimField key={f.key} ctx={ctx} field={{ kind: 'effect', key: f.key }} label={f.label} searchKey={`effects.${f.key}`} spec={f.spec} detail={detail} control={numberControl(f.label, `effects.${f.key}`, f.spec, ctx.fps)} />
  );
  const playheadHint = <span className="hint-tag">{inLifetime(element, lf) ? `element frame ${lf}` : 'playhead outside element'}</span>;

  const elementSection = (
    <Section title="Element">
      <Row label="Name" htmlFor="f-name" searchKey="name">
        <CommitText id="f-name" testId="inspector-field-name" value={element.name} disabled={disabled} maxLength={80} onCommit={(v) => update({ name: v }, 'Rename element')} />
      </Row>
      <Row label="Visible" searchKey="visible">
        <CheckField testId="inspector-field-visible" checked={element.visible} disabled={disabled} onCommit={(v) => update({ visible: v }, v ? 'Show element' : 'Hide element')} />
      </Row>
      <div className="id-line" title="Element id">{element.id}</div>
    </Section>
  );

  // X / Y and W / H sit two to a row, the letter inside the field; the rest keep the label column.
  const layoutSection = (
    <Section
      title="Layout"
      testId="layout-section"
      actions={
        parent && (
          <span className="hint-tag" title="X and Y are relative to the group">
            in “{parent.name}”
          </span>
        )
      }
    >
      <div className="grid-2 pair">{TRANSFORM_FIELDS.slice(0, 2).map((f) => transformField(f, { inline: true }))}</div>
      <div className="grid-2 pair">
        <NumberField id="f-width" label="W" inline searchKey="width" testId="inspector-field-width" value={t.width} min={1} unit="px" disabled={disabled} onCommit={(v) => update({ transform: { width: v } }, 'Set width')} />
        <NumberField id="f-height" label="H" inline searchKey="height" testId="inspector-field-height" value={t.height} min={1} unit="px" disabled={disabled} onCommit={(v) => update({ transform: { height: v } }, 'Set height')} />
      </div>
      {TRANSFORM_FIELDS.slice(2).map((f) => transformField(f))}
    </Section>
  );

  const reveal = element.type === 'text' ? motionFields.filter(isReveal) : [];
  const timingSection = (
    <Section title="Timing" testId="timing-section">
      <div className="grid-2 pair">
        <NumberField
          id="f-start"
          label="Start"
          inline
          searchKey="startFrame"
          testId="inspector-field-startFrame"
          value={element.startFrame}
          integer
          min={0}
          max={parent ? undefined : scene.durationInFrames - 1}
          unit="f"
          title={framesTitle(element.startFrame, project.fps)}
          disabled={disabled}
          onCommit={(v) => update(parent ? { startFrame: v } : { startFrame: v, durationInFrames: Math.min(element.durationInFrames, scene.durationInFrames - v) }, 'Set start')}
        />
        <NumberField
          id="f-dur"
          label="Duration"
          inline
          searchKey="durationInFrames"
          testId="inspector-field-durationInFrames"
          value={element.durationInFrames}
          integer
          min={1}
          max={parent ? undefined : scene.durationInFrames - element.startFrame}
          unit="f"
          title={framesTitle(element.durationInFrames, project.fps)}
          disabled={disabled}
          onCommit={(v) => update({ durationInFrames: v }, 'Set duration')}
        />
      </div>
      <div className="sub-line">
        {secs(absStart, project.fps)} → {secs(absStart + element.durationInFrames, project.fps)} · {secs(element.durationInFrames, project.fps)} long{parent ? ' (start relative to the group)' : ''}
      </div>
      {motionFields.filter((f) => !reveal.includes(f)).map(propField)}
    </Section>
  );
  const revealSection = reveal.length > 0 && (
    <Section title="Reveal" testId="reveal-section">
      {reveal.map(propField)}
    </Section>
  );

  if (view === 'animate') {
    const animated = {
      transform: TRANSFORM_FIELDS.filter((f) => keyframesOf(element, { kind: 'transform', property: f.property }).length > 0),
      props: fields.filter((f) => f.animatable && keyframesOf(element, { kind: 'prop', key: f.key }).length > 0),
      effects: EFFECT_FIELDS.filter((f) => keyframesOf(element, { kind: 'effect', key: f.key }).length > 0),
    };
    const count = animated.transform.length + animated.props.length + animated.effects.length;
    return (
      <>
        {timingSection}
        {revealSection}
        <Section title="Keyframes" testId="keyframes-section" actions={playheadHint}>
          {count === 0 ? (
            <p className="insp-empty" data-testid="inspector-no-keys">
              No keyframes yet. In Animate mode, change a value to key it at the playhead.
            </p>
          ) : (
            <>
              {animated.transform.map((f) => transformField(f, { detail: true }))}
              {animated.props.map((f) => (
                <PropField key={f.key} field={f} ctx={ctx} scene={scene} project={project} detail />
              ))}
              {animated.effects.map((f) => effectField(f, true))}
              <p className="fine key-legend">
                <span className="key-glyph none" /> static · <span className="key-glyph key" /> key at the playhead · <span className="key-glyph animated" /> animated
              </p>
            </>
          )}
        </Section>
      </>
    );
  }

  // Design, or a search: a search also finds the Animate tab's fields (their keyframe lists stay on that tab).
  const motion = view === 'search' && (
    <>
      {timingSection}
      {revealSection}
    </>
  );

  if (element.type === 'text') {
    // The mockup's order for text: what it says and its colour; then the rest.
    const colour: FieldDescriptor[] = designFields.filter((f) => f.kind === 'color' || f.kind === 'paint');
    const text = designFields.filter((f) => !colour.includes(f));
    return (
      <>
        <Section title="Text" testId="props-section">
          {text.map(propField)}
        </Section>
        {colour.length > 0 && (
          <Section title="Colour" testId="colour-section">
            {colour.map(propField)}
          </Section>
        )}
        {elementSection}
        {layoutSection}
        <AppearanceSection ctx={ctx} scene={scene} element={element} />
        {motion}
      </>
    );
  }

  return (
    <>
      {elementSection}
      {layoutSection}

      {element.type === 'video' && <VideoSection scene={scene} element={element} localFrame={lf} />}

      <Section title="Properties" testId="props-section">
        {designFields.map(propField)}
        {element.type === 'group' && <GroupExtras scene={scene} group={element} />}
        {element.type === 'instance' && <InstanceInfo project={project} element={element} />}
      </Section>

      <AppearanceSection ctx={ctx} scene={scene} element={element} />
      {motion}
    </>
  );
}

/** One component prop; `detail` draws an animated one for the Animate tab (see AnimField). */
function PropField(props: { field: FieldDescriptor; ctx: FieldCtx; scene: Scene; project: Project; detail?: boolean }) {
  return (
    <FieldAliases.Provider value={[props.field.label, CHECK_TEXT[props.field.key] ?? '']}>
      <PropControl {...props} />
    </FieldAliases.Provider>
  );
}

function PropControl({ field, ctx, scene, project, detail }: { field: FieldDescriptor; ctx: FieldCtx; scene: Scene; project: Project; detail?: boolean }) {
  const { t, disabled } = ctx;
  const element = t.element;
  const raw = element.props[field.key];
  const id = `p-${field.key}`;
  // `inspector-text`: the element's text (the Text group's field), the id the agent-bridge check types into.
  const testId = field.key === 'text' && (field.kind === 'text' || field.kind === 'multiline') ? 'inspector-text' : `inspector-field-${field.key}`;
  const label = fieldLabel(field);
  // Undo labels keep the full name ("Set reveal order", not "Set order").
  const commitBase = (v: unknown) => runEdit(baseEdit(t, { kind: 'prop', key: field.key }, v, fieldLabel(field, false).toLowerCase()));
  const ref: FieldRef = { kind: 'prop', key: field.key };

  if (field.animatable && field.kind === 'number') {
    const spec = propSpec(field);
    if (TRIM_KEYS.has(field.key)) {
      return <AnimField ctx={ctx} field={ref} label={label} searchKey={field.key} spec={spec} detail={detail} control={sliderControl(label, field.key, spec)} />;
    }
    return <AnimField ctx={ctx} field={ref} label={label} searchKey={field.key} spec={spec} detail={detail} control={numberControl(label, field.key, spec, project.fps)} />;
  }
  if (field.animatable && field.kind === 'color') {
    return (
      <AnimField
        ctx={ctx}
        field={ref}
        label={label}
        searchKey={field.key}
        detail={detail}
        control={(c) => (
          <Row label={label} htmlFor={id} searchKey={field.key} lead={c.lead} reset={c.reset} title={c.title}>
            <ColorField id={id} testId={testId} value={colorToHex(String(c.value ?? '')) ?? String(c.value ?? '#000000')} allowNone={field.allowNone} disabled={c.disabled} onCommit={c.onCommit} />
          </Row>
        )}
      />
    );
  }
  if (field.kind === 'paint') {
    const isColour = typeof raw === 'string' && raw !== 'none';
    if (!field.animatable) {
      return <PaintField id={id} label={label} searchKey={field.key} value={(raw ?? 'none') as Paint} allowNone={field.allowNone} disabled={disabled} testId={testId} onPreview={paintPreview(t, field.key)} onCommit={commitBase} />;
    }
    return (
      <AnimField
        ctx={ctx}
        field={ref}
        label={label}
        searchKey={field.key}
        detail={detail}
        cannotAnimate={isColour ? null : 'Only a solid colour can be animated'}
        control={(c) => (
          <PaintField
            id={id}
            label={label}
            searchKey={field.key}
            value={(typeof c.value === 'string' ? (colorToHex(c.value) ?? c.value) : (c.value ?? 'none')) as Paint}
            allowNone={field.allowNone}
            disabled={c.disabled}
            solidOnly={c.state === 'none' ? null : 'an animated colour stays a solid colour; remove the animation first'}
            lead={c.lead}
            reset={c.reset}
            testId={testId}
            onPreview={(p) => c.onPreview(p)}
            onCommit={c.onCommit}
          />
        )}
      />
    );
  }

  switch (field.kind) {
    case 'text':
    case 'multiline':
      return (
        <Row label={label} htmlFor={id} searchKey={field.key}>
          <CommitText
            id={id}
            testId={testId}
            value={String(raw ?? '')}
            maxLength={field.maxLength}
            multiline={field.kind === 'multiline'}
            title={`Applies when you leave the field or press ${field.kind === 'multiline' ? shortcutLabel('Enter', ['mod']) : 'Enter'}`}
            disabled={disabled}
            onCommit={commitBase}
          />
        </Row>
      );
    case 'number': {
      const spec = propSpec(field);
      const f = spec.factor ?? 1;
      const v = Number(raw ?? field.min);
      return (
        <NumberField
          id={id}
          label={label}
          searchKey={field.key}
          testId={testId}
          value={round2(v * f)}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          integer={spec.integer}
          unit={spec.unit}
          title={spec.frames ? framesTitle(v, project.fps) : undefined}
          disabled={disabled}
          onPreview={(x) => useEditor.getState().setTransient(x === null ? null : { sceneId: t.sceneId, element: previewElement(element, ref, x / f, ctx.lf) })}
          onCommit={(x) => commitBase(x / f)}
        />
      );
    }
    case 'color':
      return (
        <Row label={label} htmlFor={id} searchKey={field.key}>
          <ColorField id={id} testId={testId} value={String(raw ?? '#000000')} allowNone={field.allowNone} disabled={disabled} onCommit={commitBase} />
        </Row>
      );
    case 'select':
      return (
        <Row label={label} htmlFor={id} searchKey={field.key}>
          <SelectField id={id} testId={testId} value={(raw ?? field.options[0]?.value) as string | number} options={field.options} disabled={disabled} onCommit={commitBase} />
        </Row>
      );
    case 'boolean':
      return (
        <Row label={label} searchKey={field.key}>
          <CheckField id={id} testId={testId} checked={Boolean(raw)} label={CHECK_TEXT[field.key]} disabled={disabled} onCommit={commitBase} />
        </Row>
      );
    case 'asset':
      return <AssetField field={field} element={element} scene={scene} project={project} disabled={disabled} />;
    case 'composition': {
      const comps = Object.values(project.compositions);
      return (
        <Row label="Component" htmlFor={id} searchKey={field.key}>
          <SelectField
            id={id}
            testId={testId}
            value={String(raw ?? '')}
            options={comps.length ? comps.map((c) => ({ value: c.id, label: `${c.name} · ${c.width}×${c.height}` })) : [{ value: '', label: 'No reusable components yet' }]}
            disabled={disabled || !comps.length}
            onCommit={commitBase}
          />
        </Row>
      );
    }
    case 'pathNodes': {
      const count = Array.isArray(raw) ? raw.length : 0;
      return (
        <Row label={label} searchKey={field.key}>
          <span className="path-nodes" data-testid={testId}>
            <strong>{count}</strong> node{count === 1 ? '' : 's'}{' '}
            <button type="button" className="mini-btn" data-testid="edit-path-nodes" disabled={disabled} title="Edit this path’s nodes on the canvas (Enter; Esc when done)" onClick={() => enterPathEdit()}>
              Edit nodes
            </button>
          </span>
        </Row>
      );
    }
  }
}

function paintPreview(t: ElementTarget, key: string) {
  return (p: Paint | null) => useEditor.getState().setTransient(p === null ? null : { sceneId: t.sceneId, element: { ...t.element, props: { ...t.element.props, [key]: p } } });
}

function sliderControl(label: string, searchKey: string, spec: NumSpec) {
  return (c: ControlArgs) => {
    const f = spec.factor ?? 1;
    const v = Number(c.value ?? 0);
    return (
      <Row label={label} searchKey={searchKey} lead={c.lead} reset={c.reset} title={c.title} htmlFor={`f-${searchKey}`}>
        <span className="slider-field">
          <Slider value={v} min={(spec.min ?? 0) / f} max={(spec.max ?? 100) / f} step={spec.step / f} disabled={c.disabled} ariaLabel={label} testId={`slider-${searchKey}`} onPreview={c.onPreview} onCommit={c.onCommit} />
          <CommitNumber id={`f-${searchKey}`} testId={`inspector-field-${searchKey}`} value={round2(v * f)} min={spec.min} max={spec.max} step={spec.step} unit={spec.unit} disabled={c.disabled} onCommit={(x) => c.onCommit(x / f)} />
        </span>
      </Row>
    );
  };
}

// ---------------------------------------------------------------------------
// Appearance: blend, effects, drop shadow, mask
// ---------------------------------------------------------------------------

const BLEND_MODES: { value: BlendMode; label: string }[] = (
  ['normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn', 'soft-light', 'hard-light', 'difference', 'exclusion'] as const
).map((value) => ({ value, label: value.replace('-', ' ').replace(/^./, (c) => c.toUpperCase()) }));

const DEFAULT_SHADOW = { x: 0, y: 12, blur: 32, color: '#00000080' };

function AppearanceSection({ ctx, scene, element }: { ctx: FieldCtx; scene: Scene; element: Element }) {
  const { disabled, t } = ctx;
  const run = useEditor((s) => s.run);
  const update = (changes: ElementChanges, label: string) => run({ type: 'updateElement', sceneId: scene.id, elementId: element.id, changes }, label);
  const shadow = element.effects?.dropShadow;
  const setShadow = (change: Partial<typeof DEFAULT_SHADOW>, label: string) => update({ effects: { dropShadow: { ...(shadow ?? DEFAULT_SHADOW), ...change } } }, label);
  const sources = maskSources(scene.elements, element);
  const usedAsMaskBy = maskedBy(scene.elements, element);
  const mask = element.mask;
  const blocked = usedAsMaskBy.length ? `Masks “${usedAsMaskBy.map((e) => e.name).join('”, “')}” — a mask source can’t be masked itself.` : null;

  return (
    <Section title="Appearance" testId="appearance-section">
      <Row label="Blend" htmlFor="a-blend" searchKey="blendMode">
        <SelectField id="a-blend" testId="inspector-field-blendMode" value={element.blendMode ?? 'normal'} options={BLEND_MODES} disabled={disabled} onCommit={(v) => update({ blendMode: v === 'normal' ? null : v }, 'Set blend mode')} />
      </Row>
      {EFFECT_FIELDS.map((f) => (
        <AnimField key={f.key} ctx={ctx} field={{ kind: 'effect', key: f.key }} label={f.label} searchKey={`effects.${f.key}`} spec={f.spec} control={numberControl(f.label, `effects.${f.key}`, f.spec, ctx.fps)} />
      ))}
      <Row label="Shadow" searchKey="effects.dropShadow">
        <CheckField
          testId="inspector-field-dropShadow"
          checked={!!shadow}
          label="Drop shadow"
          disabled={disabled}
          onCommit={(on) => update({ effects: { dropShadow: on ? DEFAULT_SHADOW : null } }, on ? 'Add drop shadow' : 'Remove drop shadow')}
        />
      </Row>
      {shadow && (
        <div className="shadow-group" data-field="effects.dropShadow">
          <div className="grid-2 pair">
            <NumberField label="X" inline searchKey="effects.dropShadow" testId="shadow-x" value={shadow.x} unit="px" disabled={disabled} onCommit={(x) => setShadow({ x }, 'Set shadow x')} />
            <NumberField label="Y" inline searchKey="effects.dropShadow" testId="shadow-y" value={shadow.y} unit="px" disabled={disabled} onCommit={(y) => setShadow({ y }, 'Set shadow y')} />
          </div>
          <NumberField label="Blur" searchKey="effects.dropShadow" testId="shadow-blur" value={shadow.blur} min={0} max={200} unit="px" disabled={disabled} onCommit={(blur) => setShadow({ blur }, 'Set shadow blur')} />
          <Row label="Colour" searchKey="effects.dropShadow">
            <ColorField testId="shadow-color" value={colorToHex(shadow.color) ?? shadow.color} disabled={disabled} onCommit={(color) => setShadow({ color }, 'Set shadow colour')} />
          </Row>
        </div>
      )}
      <Row
        label="Mask"
        htmlFor="a-mask"
        searchKey="mask"
        title={sources.length ? 'Show this element only inside (or outside) a shape or path in the same group; the mask itself stops painting' : 'No shape or path in the same group to mask with'}
      >
        <SelectField
          id="a-mask"
          testId="inspector-field-mask"
          value={mask?.sourceId ?? ''}
          disabled={disabled || !!blocked || (!mask && !sources.length)}
          options={[{ value: '', label: 'None' }, ...sources.map((s) => ({ value: s.id, label: `${s.name} (${COMPONENTS[s.type].label.toLowerCase()})` }))]}
          onCommit={(id) => update({ mask: id ? { sourceId: id, mode: mask?.mode ?? 'alpha' } : null }, id ? 'Set mask' : 'Remove mask')}
        />
      </Row>
      {mask && (
        <Row label="Mask mode" htmlFor="a-mask-mode" searchKey="mask">
          <SelectField
            id="a-mask-mode"
            testId="inspector-field-maskMode"
            value={mask.mode}
            disabled={disabled}
            options={[
              { value: 'alpha', label: 'Alpha — show inside' },
              { value: 'inverted', label: 'Inverted — show outside' },
            ]}
            onCommit={(mode) => update({ mask: { ...mask, mode } }, 'Set mask mode')}
          />
        </Row>
      )}
      {blocked && <p className="fine">{blocked}</p>}
      {t.element.type === 'group' && <p className="fine">Effects and blend apply to the whole group.</p>}
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Group / instance extras
// ---------------------------------------------------------------------------

function GroupExtras({ scene, group }: { scene: Scene; group: Element }) {
  const project = useEditor((s) => s.doc.project);
  const visible = useFieldVisible('Make reusable component', 'component');
  const children = scene.elements.filter((e) => e.parentId === group.id);
  const preview = useMemo(
    () => componentFromGroup(project, scene.id, group.id, { compositionId: 'cmp_preview', instanceId: 'el_preview', elementId: (id) => `${id}_c` }),
    [project, scene.id, group.id],
  );
  if (!visible) return null;
  const make = () => {
    const r = componentFromGroup(project, scene.id, group.id, {
      compositionId: newId('el').replace(/^el_/, 'cmp_'),
      instanceId: newId('el'),
      elementId: () => newId('el'),
    });
    if ('error' in r) return useEditor.getState().toast({ tone: 'error', message: r.error });
    if (useEditor.getState().run(r.command, r.label)) useEditor.getState().selectElement(scene.id, r.instanceId);
  };
  return (
    <div className="group-extras" data-field="component">
      <div className="sub-line">
        {children.length} direct child{children.length === 1 ? '' : 'ren'} · box {Math.round(group.transform.width)}×{Math.round(group.transform.height)} px
      </div>
      <button type="button" className="btn small" disabled={scene.locked || 'error' in preview} data-testid="make-component" title={'error' in preview ? preview.error : 'Turn this group into a reusable component and play it here as an instance (undo restores the group)'} onClick={make}>
        Make reusable component
      </button>
      {!('error' in preview) && preview.overhang && <p className="fine warn-text">Some children extend past the group box; the component clips to that box.</p>}
    </div>
  );
}

function InstanceInfo({ project, element }: { project: Project; element: Element }) {
  const visible = useFieldVisible('Component info', 'compositionId');
  const comp = project.compositions[String(element.props.compositionId ?? '')];
  if (!visible) return null;
  if (!comp) return <p className="fine warn-text">This instance points at a component that no longer exists.</p>;
  return (
    <div className="sub-line" data-field="compositionId">
      Plays “{comp.name}” · {comp.width}×{comp.height} px · {comp.durationInFrames} f ({secs(comp.durationInFrames, project.fps)}) · {comp.elements.length} element{comp.elements.length === 1 ? '' : 's'}
    </div>
  );
}

function AssetField({ field, element, scene, project, disabled }: { field: Extract<FieldDescriptor, { kind: 'asset' }>; element: Element; scene: Scene; project: Project; disabled: boolean }) {
  const run = useEditor((s) => s.run);
  const current = String(element.props[field.key] ?? '');
  const options = Object.values(project.assets).filter((a) => field.assetKinds.includes(a.kind) && (!a.reference || a.id === current));
  const known = project.assets[current];
  const [busy, setBusy] = useState(false);
  const visible = useFieldVisible(field.label, field.key);
  if (!visible) return null;

  const upload = async () => {
    setBusy(true);
    const fields = await uploadAsset(field.assetKinds);
    setBusy(false);
    if (!fields) return;
    const asset = newAsset(fields);
    run(
      {
        type: 'batch',
        label: `Upload ${asset.name}`,
        commands: [
          { type: 'addAsset', asset },
          { type: 'updateElement', sceneId: scene.id, elementId: element.id, changes: { props: { [field.key]: asset.id } } },
        ],
      },
      `Upload ${asset.name}`,
    );
  };
  const replace = async () => {
    if (!known) return;
    setBusy(true);
    const fields = await uploadAsset(field.assetKinds);
    setBusy(false);
    if (!fields) return;
    run({ type: 'replaceAsset', assetId: known.id, changes: replacementChanges(known, fields) }, `Replace file of ${known.name}`);
  };

  return (
    <div className="asset-field" data-field={field.key}>
      <Row label={field.label} htmlFor={`p-${field.key}`} searchKey={field.key}>
        <select
          id={`p-${field.key}`}
          className="input select"
          value={current}
          disabled={disabled}
          data-testid={`inspector-field-${field.key}`}
          onChange={(e) => run({ type: 'updateElement', sceneId: scene.id, elementId: element.id, changes: { props: { [field.key]: e.target.value } } }, `Set ${field.label.toLowerCase()}`)}
        >
          {!known && <option value={current}>{current ? `Missing: ${current}` : 'Choose a file…'}</option>}
          {options.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
      </Row>
      <div className="asset-actions">
        {known && <span className="asset-src" title={known.src}>{known.src}</span>}
        <button className="mini-btn" disabled={disabled || busy} onClick={upload} data-testid={`asset-upload-${field.key}`}>
          Upload…
        </button>
        <button className="mini-btn" disabled={disabled || busy || !known} onClick={replace} data-testid={`asset-replace-${field.key}`} title="Swap the file for this asset everywhere it is used">
          Replace…
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scene + project audio
// ---------------------------------------------------------------------------

const TRANSITIONS: { value: TransitionType; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'fade', label: 'Fade' },
  { value: 'slide', label: 'Slide' },
  { value: 'wipe', label: 'Wipe' },
  { value: 'zoom', label: 'Zoom' },
  { value: 'blur', label: 'Blur' },
];

function SceneInspector({ scene }: { scene: Scene }) {
  const run = useEditor((s) => s.run);
  const project = useEditor((s) => s.doc.project);
  const disabled = scene.locked;
  const update = (changes: Parameters<typeof sceneCmd>[1], label: string) => run(sceneCmd(scene.id, changes), label);
  return (
    <>
      <Section title="Scene" actions={<span className="hint-tag mono" title="Scene id">{scene.id}</span>}>
        <Row label="Name" htmlFor="s-name" searchKey="sceneName">
          <CommitText id="s-name" testId="inspector-field-sceneName" value={scene.name} disabled={disabled} maxLength={80} onCommit={(v) => update({ name: v }, 'Rename scene')} />
        </Row>
        <NumberField
          id="s-dur"
          label="Duration"
          searchKey="durationInFrames"
          testId="inspector-field-sceneDuration"
          value={scene.durationInFrames}
          integer
          min={1}
          max={project.fps * 600}
          unit="f"
          title={framesTitle(scene.durationInFrames, project.fps)}
          suffix={secs(scene.durationInFrames, project.fps)}
          disabled={disabled}
          onCommit={(v) => update({ durationInFrames: v }, 'Set scene duration')}
        />
        <Row label="Background" htmlFor="s-bg" searchKey="backgroundColor">
          <ColorField id="s-bg" testId="inspector-field-sceneBackground" value={scene.backgroundColor} disabled={disabled} onCommit={(v) => update({ backgroundColor: v }, 'Set scene background')} />
        </Row>
        {/* The entrance and its length share a row: the kind, then how many frames it takes. */}
        <Row label="Entrance" htmlFor="s-tr" searchKey="transition">
          <span className="split-field">
            <SelectField id="s-tr" testId="inspector-field-transitionType" value={scene.transitionIn.type} options={TRANSITIONS} disabled={disabled} onCommit={(v) => update({ transitionIn: { type: v } }, 'Set transition')} />
            <CommitNumber
              id="s-trf"
              testId="inspector-field-transitionFrames"
              value={scene.transitionIn.durationInFrames}
              integer
              min={0}
              max={scene.durationInFrames}
              unit="f"
              title={`Entrance length: ${framesTitle(scene.transitionIn.durationInFrames, project.fps)}`}
              disabled={disabled}
              onCommit={(v) => update({ transitionIn: { durationInFrames: v } }, 'Set transition length')}
            />
          </span>
        </Row>
        <Row label="Locked" searchKey="locked lock approved">
          <CheckField
            testId="inspector-field-sceneLocked"
            checked={scene.locked}
            label={scene.locked ? 'Nobody can change it' : 'Open to edits'}
            onCommit={(v) => run({ type: 'setSceneLock', sceneId: scene.id, locked: v }, `${v ? 'Lock' : 'Unlock'} “${scene.name}”`)}
          />
        </Row>
      </Section>
      <AudioSection scene={scene} />
    </>
  );
}

function sceneCmd(sceneId: string, changes: { name?: string; durationInFrames?: number; backgroundColor?: string; transitionIn?: { type?: TransitionType; durationInFrames?: number } }) {
  return { type: 'updateScene' as const, sceneId, changes };
}

function AudioSection({ scene }: { scene: Scene }) {
  const project = useEditor((s) => s.doc.project);
  const playhead = useEditor((s) => s.playhead);
  const run = useEditor((s) => s.run);
  const audioAssets = Object.values(project.assets).filter((a) => a.kind === 'audio' && !a.reference);
  const [pick, setPick] = useState('');
  const [busy, setBusy] = useState(false);
  const sceneStart = sceneStartFrame(project, scene.id);

  const addClip = (assetId: string) => {
    const asset = project.assets[assetId];
    if (!asset) return;
    const clip: AudioClip = {
      id: newId('aud'),
      assetId,
      name: asset.name,
      sceneId: scene.id,
      startFrame: Math.max(0, Math.min(playhead - sceneStart, scene.durationInFrames - 1)),
      trimStartFrames: 0,
      durationInFrames: asset.durationInFrames ?? project.fps,
      volume: 0.8,
      fadeInFrames: 0,
      fadeOutFrames: 0,
    };
    run({ type: 'addAudioClip', clip }, `Add sound effect “${asset.name}”`);
  };
  const uploadAndAdd = async () => {
    setBusy(true);
    const fields = await uploadAsset(['audio']);
    setBusy(false);
    if (!fields) return;
    const asset = newAsset(fields);
    const clip: AudioClip = {
      id: newId('aud'),
      assetId: asset.id,
      name: asset.name,
      sceneId: scene.id,
      startFrame: Math.max(0, Math.min(playhead - sceneStart, scene.durationInFrames - 1)),
      trimStartFrames: 0,
      durationInFrames: asset.durationInFrames ?? project.fps,
      volume: 0.8,
      fadeInFrames: 0,
      fadeOutFrames: 0,
    };
    run({ type: 'batch', label: `Add sound effect “${asset.name}”`, commands: [{ type: 'addAsset', asset }, { type: 'addAudioClip', clip }] });
  };

  return (
    <Section title="Project audio" testId="audio-section">
      {project.audio.length === 0 && <p className="fine">No audio clips.</p>}
      {project.audio.map((clip) => (
        <AudioClipEditor key={clip.id} clip={clip} />
      ))}
      <div className="add-sfx">
        <select className="input select" value={pick} onChange={(e) => setPick(e.target.value)} data-testid="sfx-asset">
          <option value="">Sound effect from asset…</option>
          {audioAssets.map((a) => (
            <option key={a.id} value={a.id}>
              {a.name}
            </option>
          ))}
        </select>
        <button className="mini-btn" disabled={!pick} data-testid="sfx-add" onClick={() => addClip(pick)}>
          Add to scene
        </button>
        <button className="mini-btn" disabled={busy} data-testid="sfx-upload" onClick={uploadAndAdd}>
          Upload…
        </button>
      </div>
      <p className="fine">Sound effects are anchored to “{scene.name}” at the playhead and move with the scene.</p>
    </Section>
  );
}

function AudioClipEditor({ clip }: { clip: AudioClip }) {
  const project = useEditor((s) => s.doc.project);
  const run = useEditor((s) => s.run);
  const anchor = clip.sceneId ? project.scenes.find((s) => s.id === clip.sceneId) : null;
  const asset = project.assets[clip.assetId];
  const upd = (changes: Partial<Omit<AudioClip, 'id'>>, label: string) => run({ type: 'updateAudioClip', clipId: clip.id, changes }, label);
  const num = (key: 'startFrame' | 'trimStartFrames' | 'durationInFrames' | 'fadeInFrames' | 'fadeOutFrames', label: string, min = 0) => (
    <NumberField
      label={label}
      inline
      searchKey={key}
      testId={`audio-${clip.id}-${key}`}
      value={clip[key]}
      integer
      min={min}
      unit="f"
      title={framesTitle(clip[key], project.fps)}
      onCommit={(v) => upd({ [key]: v }, `Set ${clip.name} ${label.toLowerCase()}`)}
    />
  );
  return (
    <div className="audio-clip" data-testid={`audio-clip-${clip.id}`}>
      <div className="audio-head">
        <strong>{clip.name}</strong>
        <span className="fine">
          {anchor ? `anchored to ${anchor.name}` : 'project timeline'} · {asset?.name ?? 'missing asset'}
        </span>
        <button className="mini-btn icon-only" title="Remove clip" onClick={() => run({ type: 'removeAudioClip', clipId: clip.id }, `Remove ${clip.name}`)}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      <NumberField
        label="Volume"
        searchKey="volume"
        testId={`audio-${clip.id}-volume`}
        value={Math.round(clip.volume * 100)}
        min={0}
        max={100}
        step={5}
        unit="%"
        onCommit={(v) => upd({ volume: v / 100 }, `Set ${clip.name} volume`)}
      />
      <div className="grid-2 pair">
        {num('startFrame', 'Start')}
        {num('durationInFrames', 'Duration', 1)}
        {num('fadeInFrames', 'Fade in')}
        {num('fadeOutFrames', 'Fade out')}
        {num('trimStartFrames', 'Trim')}
      </div>
      {!clip.sceneId && <DuckControl clip={clip} />}
    </div>
  );
}
