// "Size & frame rate…": change the project's width, height and fps with an
// explicit choice of how layout and timing adapt, and a plain-language
// preview of the consequence. One changeFormat command: one undo step. The
// same fields sit in a dialog (File › Size & frame rate…) and inline in Settings › Project
// (FormatForm).

import { useEffect, useMemo, useState } from 'react';
import { describeFormatChange, type FormatPreview } from '../core/format';
import { ASPECTS, aspectOf, FPS_CHOICES } from '../core/outline';
import type { FormatConversion } from '../core/types';
import { closeCreateDialog, dialogKeyDown } from './createFlow';
import { CommitNumber } from './fields';
import { Icon } from './icons';
import { useEditor } from './store';

const LAYOUTS: { id: FormatConversion['layout']; label: string; hint: string }[] = [
  { id: 'scale', label: 'Scale', hint: 'Positions follow the new frame; sizes scale evenly' },
  { id: 'fit', label: 'Fit', hint: 'Everything scales evenly and is centred' },
  { id: 'none', label: 'Keep pixels', hint: 'Every element stays exactly where it is' },
];

const TIMINGS: { id: FormatConversion['timing']; label: string; hint: string }[] = [
  { id: 'keepSeconds', label: 'Keep seconds', hint: 'Same length; keys move to the matching time' },
  { id: 'keepFrames', label: 'Keep frame numbers', hint: 'Same frames; the video plays faster or slower' },
];

function Choice<T extends string>({ name, options, value, onChange, testId }: { name: string; options: { id: T; label: string; hint: string }[]; value: T; onChange: (v: T) => void; testId: string }) {
  return (
    <div className="fmt-choices" role="radiogroup" aria-label={name}>
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={value === o.id} className={`fmt-choice ${value === o.id ? 'on' : ''}`} data-testid={`${testId}-${o.id}`} onClick={() => onChange(o.id)}>
          <span className="fmt-choice-label">{o.label}</span>
          <span className="fmt-choice-hint">{o.hint}</span>
        </button>
      ))}
    </div>
  );
}

/** The form's choices, started from the project's format; `apply` runs the one command. */
function useFormatDraft() {
  const project = useEditor((s) => s.doc.project);
  const [width, setWidth] = useState(project.width);
  const [height, setHeight] = useState(project.height);
  const [fps, setFps] = useState(project.fps);
  const [layout, setLayout] = useState<FormatConversion['layout']>('scale');
  const [timing, setTiming] = useState<FormatConversion['timing']>('keepSeconds');
  const preview = useMemo(() => describeFormatChange(project, { width, height, fps, conversion: { layout, timing } }), [project, width, height, fps, layout, timing]);
  const reset = () => {
    setWidth(project.width);
    setHeight(project.height);
    setFps(project.fps);
  };
  // The format changed underneath (an undo, an agent, Apply itself): start again from it.
  useEffect(reset, [project.width, project.height, project.fps]);
  const apply = () => useEditor.getState().run({ type: 'changeFormat', width, height, fps, conversion: { layout, timing } }, `Change format to ${width}×${height} · ${fps} fps`);
  return { project, width, setWidth, height, setHeight, fps, setFps, layout, setLayout, timing, setTiming, preview, reset, apply };
}

type FormatDraft = ReturnType<typeof useFormatDraft>;

/** Size, frame rate, the layout and timing choices a change needs, and its preview. */
function FormatFields({ draft, idlePreview = true }: { draft: FormatDraft; idlePreview?: boolean }) {
  const { project, width, setWidth, height, setHeight, fps, setFps, layout, setLayout, timing, setTiming, preview } = draft;
  const fpsOptions = [...new Set([...FPS_CHOICES, project.fps])].sort((a, b) => a - b);
  const aspect = aspectOf(width, height);
  return (
    <>
      <section className="cv-field">
        <span className="cv-label">Size</span>
        <div className="cv-chips" role="radiogroup" aria-label="Size">
          {ASPECTS.map((a) => (
            <button
              key={a.id}
              role="radio"
              aria-checked={aspect === a.id}
              className={`cv-chip ${aspect === a.id ? 'on' : ''}`}
              data-testid={`format-size-${a.id}`}
              onClick={() => {
                setWidth(a.width);
                setHeight(a.height);
              }}
            >
              <span className="cv-aspect" style={{ aspectRatio: `${a.width} / ${a.height}` }} aria-hidden />
              <span>
                {a.label} <span className="cv-chip-meta">{a.id}</span>
              </span>
            </button>
          ))}
        </div>
        <div className="fmt-size">
          <CommitNumber value={width} min={16} max={8192} integer unit="px" testId="format-width" onCommit={setWidth} />
          <span className="fmt-times" aria-hidden>×</span>
          <CommitNumber value={height} min={16} max={8192} integer unit="px" testId="format-height" onCommit={setHeight} />
          {!aspect && <span className="fine">Custom</span>}
        </div>
      </section>
      <section className="cv-field">
        <span className="cv-label">Frame rate</span>
        <div className="cv-chips" role="radiogroup" aria-label="Frame rate">
          {fpsOptions.map((f) => (
            <button key={f} role="radio" aria-checked={fps === f} className={`cv-chip ${fps === f ? 'on' : ''}`} data-testid={`format-fps-${f}`} onClick={() => setFps(f)}>
              {f} fps
            </button>
          ))}
        </div>
      </section>
      {preview.sizeChanged && (
        <section className="cv-field">
          <span className="cv-label">Layout</span>
          <Choice name="Layout" options={LAYOUTS} value={layout} onChange={setLayout} testId="format-layout" />
        </section>
      )}
      {preview.fpsChanged && (
        <section className="cv-field">
          <span className="cv-label">Timing</span>
          <Choice name="Timing" options={TIMINGS} value={timing} onChange={setTiming} testId="format-timing" />
        </section>
      )}
      {(preview.changed || idlePreview) && <Preview preview={preview} />}
    </>
  );
}

function Preview({ preview }: { preview: FormatPreview }) {
  return (
    <>
      <section className={`fmt-preview ${preview.changed ? '' : 'idle'}`} data-testid="format-preview" aria-live="polite">
        <div className="fmt-summary tabular">{preview.summary}</div>
        {preview.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
      </section>
      {preview.blocked && (
        <div className="notice warn fmt-blocked" data-testid="format-blocked">
          {preview.blocked}
        </div>
      )}
    </>
  );
}

export function FormatDialog() {
  const draft = useFormatDraft();
  const { preview } = draft;
  const apply = () => {
    if (draft.apply()) closeCreateDialog();
  };

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && closeCreateDialog()}>
      <div className="modal fmt-dialog" role="dialog" aria-label="Size and frame rate" data-testid="format-dialog" onKeyDown={dialogKeyDown}>
        <header className="modal-head">
          <h2>Size &amp; frame rate</h2>
          <button className="icon-btn" onClick={closeCreateDialog} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="cv-body">
          <FormatFields draft={draft} />
        </div>
        <footer className="cv-foot">
          <span className="fine">One step — undo with ⌘Z.</span>
          <span className="cv-spacer" />
          <button className="btn" onClick={closeCreateDialog}>
            Cancel
          </button>
          <button className="btn primary" data-testid="format-apply" disabled={!preview.changed || !!preview.blocked} onClick={apply}>
            Apply
          </button>
        </footer>
      </div>
    </div>
  );
}

/** Settings › Project: the same fields inline; the preview and Apply appear once something differs. */
export function FormatForm() {
  const draft = useFormatDraft();
  const { preview } = draft;
  return (
    <div className="fmt-form" data-testid="format-form">
      <FormatFields draft={draft} idlePreview={false} />
      {preview.changed && (
        <div className="fmt-form-foot">
          <span className="fine">One step — undo with ⌘Z.</span>
          <span className="cv-spacer" />
          <button className="btn" data-testid="format-revert" onClick={draft.reset}>
            Revert
          </button>
          <button className="btn primary" data-testid="format-apply" disabled={!!preview.blocked} onClick={draft.apply}>
            Apply
          </button>
        </div>
      )}
    </div>
  );
}
