// "Style…": pick the project's style pack (fonts, colour roles, motion
// personality), tune the motion, and see it move before applying. Applying is
// ONE command batch (setStyle, plus scene backgrounds when asked): one undo
// step. Presets, templates and agents read the result from project.style.
// Settings › Project shows the current pack (PackSwatch) and opens this.

import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { create } from 'zustand';
import { cssFontFamily } from '../composition/elements/shared';
import { applyStylePack, PERSONALITY_IDS, PERSONALITY_NOTES, shippedPack, STYLE_PACK_IDS, STYLE_PACK_NOTES, STYLE_PACKS, tuneMotion, withPersonality, type StylePackId } from '../core/style';
import type { EasingSpec, StylePack } from '../core/types';
import { isTyping } from './editActions';
import { CheckField, Slider } from './fields';
import { Icon } from './icons';
import { trapTab, useDialogFocus } from './overlayFocus';
import { useEditor } from './store';

export const useStylePanel = create<{ open: boolean }>(() => ({ open: false }));
export const openStylePanel = () => useStylePanel.setState({ open: true });
const close = () => useStylePanel.setState({ open: false });

/** CSS timing function for an easing (the preview runs on CSS animations). */
const NAMED: Record<string, string> = {
  linear: 'linear',
  easeIn: 'cubic-bezier(0.42, 0, 1, 1)',
  easeOut: 'cubic-bezier(0, 0, 0.58, 1)',
  easeInOut: 'cubic-bezier(0.42, 0, 0.58, 1)',
  backOut: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  easeInCubic: 'cubic-bezier(0.32, 0, 0.67, 0)',
  easeOutCubic: 'cubic-bezier(0.33, 1, 0.68, 1)',
  easeInOutCubic: 'cubic-bezier(0.65, 0, 0.35, 1)',
  easeOutExpo: 'cubic-bezier(0.16, 1, 0.3, 1)',
  easeInOutExpo: 'cubic-bezier(0.87, 0, 0.13, 1)',
  hold: 'steps(1, end)',
};
const cssEasing = (e: EasingSpec) => (typeof e === 'string' ? NAMED[e] : `cubic-bezier(${e.x1}, ${e.y1}, ${e.x2}, ${e.y2})`);

/** A tiny scene: a kicker, a headline and two lines arrive apart, then a chip settles with the pack's overshoot. */
function MotionPreview({ pack, take }: { pack: StylePack; take: number }) {
  const m = pack.motion;
  const base = 0.6 * m.timingScale;
  const step = m.staggerFrames / 30;
  const vars = (i: number, seconds = base): CSSProperties => ({ animationDuration: `${seconds}s`, animationDelay: `${0.15 + i * step}s`, animationTimingFunction: cssEasing(m.enter) });
  const c = pack.colors;
  return (
    <div className="sty-preview" style={{ background: c.background }} key={take} aria-hidden data-testid="style-preview">
      <span className="sty-kicker sty-rise" style={{ ...vars(0), color: c.accent, fontFamily: cssFontFamily(pack.fonts.mono ?? 'IBM Plex Mono') }}>
        NEW · {pack.name.toUpperCase()}
      </span>
      <span className="sty-headline sty-rise" style={{ ...vars(1, base * 1.2), color: c.text, fontFamily: cssFontFamily(pack.fonts.heading) }}>
        Ship the brief.
      </span>
      <span className="sty-line sty-rise" style={{ ...vars(2), background: c.muted }} />
      <span className="sty-line short sty-rise" style={{ ...vars(3), background: c.muted }} />
      <span className="sty-chip sty-pop" style={{ ...vars(5, base * 1.1), ['--sty-over' as string]: String(m.overshoot), background: c.accent }} />
      <span className="sty-card sty-rise" style={{ ...vars(4, base * 1.3), background: c.surface, borderColor: c.accent2 ?? c.accent }} />
    </div>
  );
}

/** A pack at a glance: its plate, its heading face and three of its colours. */
export function PackSwatch({ pack }: { pack: StylePack | null }) {
  if (!pack) {
    return (
      <span className="sty-swatch" aria-hidden>
        <span className="sty-swatch-type">—</span>
      </span>
    );
  }
  return (
    <span className="sty-swatch" style={{ background: pack.colors.background }} aria-hidden>
      <span className="sty-swatch-type" style={{ color: pack.colors.text, fontFamily: cssFontFamily(pack.fonts.heading) }}>
        Aa
      </span>
      <span className="sty-swatch-dots">
        {[pack.colors.accent, pack.colors.accent2 ?? pack.colors.accent, pack.colors.surface].map((c, i) => (
          <span key={i} style={{ background: c }} />
        ))}
      </span>
    </span>
  );
}

export function StylePanel() {
  const open = useStylePanel((s) => s.open);
  return open ? <StyleDialog /> : null;
}

function StyleDialog() {
  const current = useEditor((s) => s.doc.project.style);
  const project = useEditor((s) => s.doc.project);
  const [draft, setDraft] = useState<StylePack | null>(current ?? null);
  const [backgrounds, setBackgrounds] = useState(false);
  const [take, setTake] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  // It can open over Settings: focus starts on the chosen pack and goes back on close.
  useDialogFocus(ref, '.sty-pack.on');
  const update = (next: StylePack | null) => {
    setDraft(next);
    setTake((t) => t + 1);
  };
  const base = shippedPack(draft ?? undefined);
  const changed = JSON.stringify(draft ?? null) !== JSON.stringify(current ?? null);
  const unlocked = useMemo(() => project.scenes.filter((s) => !s.locked).length, [project.scenes]);

  const apply = () => {
    const command = applyStylePack(project, draft, { backgrounds });
    if (command.type !== 'batch') return;
    if (useEditor.getState().run(command, command.label)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    e.stopPropagation(); // editor shortcuts stay off while the dialog is open
    if (e.key === 'Escape' && !isTyping(e.target)) close();
    trapTab(e, ref.current);
  };

  // On the body, so the stage header's stacking context cannot trap the backdrop under the stage.
  return createPortal(
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div ref={ref} className="modal cv-dialog wide sty-dialog" role="dialog" aria-label="Style" data-testid="style-panel" onKeyDown={onKey}>
        <header className="modal-head">
          <h2>Style</h2>
          <button className="icon-btn" onClick={close} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="cv-body">
          <p className="cv-intro">Fonts, colours and how things move. Templates, motion presets and your agent all follow it; nothing already on the timeline changes.</p>
          <section className="cv-field">
            <span className="cv-label">Pack</span>
            <div className="sty-packs" role="radiogroup" aria-label="Style pack">
              {STYLE_PACK_IDS.map((id: StylePackId) => {
                const pack = STYLE_PACKS[id];
                const on = draft?.id === id;
                return (
                  <button key={id} role="radio" aria-checked={on} className={`sty-pack ${on ? 'on' : ''}`} data-testid={`style-pack-${id}`} onClick={() => update(on ? draft : pack)}>
                    <PackSwatch pack={pack} />
                    <span className="sty-pack-name">{pack.name}</span>
                    <span className="sty-pack-note">{STYLE_PACK_NOTES[id]}</span>
                  </button>
                );
              })}
              <button role="radio" aria-checked={!draft} className={`sty-pack none ${!draft ? 'on' : ''}`} data-testid="style-pack-none" onClick={() => update(null)}>
                <PackSwatch pack={null} />
                <span className="sty-pack-name">No pack</span>
                <span className="sty-pack-note">Editor defaults; templates borrow the project’s own fonts and colours.</span>
              </button>
            </div>
          </section>
          {draft && (
            <>
              <section className="cv-field">
                <span className="cv-label">
                  Motion personality
                  <span className="cv-label-note">{draft.motion.id === 'custom' ? 'Custom (tuned)' : PERSONALITY_NOTES[draft.motion.id].feel}</span>
                </span>
                <div className="cv-chips" role="radiogroup" aria-label="Motion personality">
                  {PERSONALITY_IDS.map((id) => (
                    <button key={id} role="radio" aria-checked={draft.motion.id === id} className={`cv-chip ${draft.motion.id === id ? 'on' : ''}`} data-testid={`style-motion-${id}`} title={PERSONALITY_NOTES[id].curve} onClick={() => update(withPersonality(draft, id))}>
                      {PERSONALITY_NOTES[id].label}
                    </button>
                  ))}
                  {draft.motion.id === 'custom' && <span className="cv-chip on sty-custom">Custom</span>}
                </div>
              </section>
              <div className="sty-tune">
                <div className="sty-sliders">
                  <label className="sty-slider">
                    <span className="cv-label-inline">Timing</span>
                    <Slider ariaLabel="Timing scale" testId="style-timing" min={0.5} max={2} step={0.05} value={draft.motion.timingScale} onCommit={(v) => update(tuneMotion(draft, { timingScale: v }))} />
                    <span className="sty-value tabular">{draft.motion.timingScale.toFixed(2)}×</span>
                  </label>
                  <label className="sty-slider">
                    <span className="cv-label-inline">Stagger</span>
                    <Slider ariaLabel="Stagger frames" testId="style-stagger" min={0} max={12} step={1} value={draft.motion.staggerFrames} onCommit={(v) => update(tuneMotion(draft, { staggerFrames: v }))} />
                    <span className="sty-value tabular">{draft.motion.staggerFrames} f</span>
                  </label>
                  <label className="sty-slider">
                    <span className="cv-label-inline">Overshoot</span>
                    <Slider ariaLabel="Overshoot" testId="style-overshoot" min={0} max={0.3} step={0.01} value={draft.motion.overshoot} onCommit={(v) => update(tuneMotion(draft, { overshoot: Math.round(v * 100) / 100 }))} />
                    <span className="sty-value tabular">{Math.round(draft.motion.overshoot * 100)} %</span>
                  </label>
                  {base && draft.motion.id === 'custom' && (
                    <button className="btn small sty-reset" onClick={() => update({ ...draft, motion: base.motion })}>
                      Reset to {PERSONALITY_NOTES[base.motion.id as keyof typeof PERSONALITY_NOTES]?.label ?? 'pack'} motion
                    </button>
                  )}
                  <CheckField checked={backgrounds} onCommit={setBackgrounds} testId="style-backgrounds" label={`Also paint ${unlocked} unlocked scene${unlocked === 1 ? '' : 's'} with its background`} />
                </div>
                <div className="sty-preview-wrap">
                  <MotionPreview pack={draft} take={take} />
                  <button className="btn small sty-replay" data-testid="style-replay" onClick={() => setTake((t) => t + 1)}>
                    <Icon name="play" size={12} /> Replay
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
        <footer className="cv-foot">
          <span className="fine">One step — undo with ⌘Z.</span>
          <span className="cv-spacer" />
          <button className="btn" onClick={close}>
            Cancel
          </button>
          <button className="btn primary" data-testid="style-apply" disabled={!changed && !backgrounds} onClick={apply}>
            Apply
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}

/** Pack name for menus ("Snappy SaaS", or "No pack"). */
export function useStyleName(): string {
  return useEditor((s) => s.doc.project.style?.name ?? 'No pack');
}

/** Top-bar button that opens the dialog (and mounts it); its dot is the pack's accent. */
export function StyleButton() {
  const name = useStyleName();
  const accent = useEditor((s) => s.doc.project.style?.colors.accent);
  return (
    <>
      <button className="btn" data-testid="style-open" onClick={openStylePanel} title={`Style: ${name}. Fonts, colours and motion personality for templates, presets and your agent`}>
        <span className="sty-btn-dot" style={accent ? { background: accent } : undefined} aria-hidden /> Style
      </button>
      <StylePanel />
    </>
  );
}
