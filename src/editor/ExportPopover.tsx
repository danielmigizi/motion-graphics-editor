// The header's Export button and the popover under it (ExportPanel.tsx holds
// what is inside). The button is always mounted with the header and keeps the
// render job (useExportJob), so a running export keeps polling with the
// popover closed; meanwhile the chevron on the button turns into a ring that
// fills with the render's progress, and a render that finished or failed
// while the popover was closed leaves a check or a warning there until it is
// opened. Escape, a press outside or tabbing past it closes the popover;
// Escape puts the focus back on the button.

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { create } from 'zustand';
import { ExportPanel, isRendering, useExportJob } from './ExportPanel';
import { Icon } from './icons';

/** Whether the Export popover is open. The registry can open it too (`openExport()`). */
export const useExportPopover = create<{ open: boolean }>(() => ({ open: false }));

export function openExport(open = true): void {
  useExportPopover.setState({ open });
}

/** The render's progress where the chevron was: a ring in the button's ink, filled clockwise from the top. */
function ProgressRing({ pct }: { pct: number }) {
  return (
    <svg className="export-ring" width={14} height={14} viewBox="0 0 16 16" aria-hidden data-testid="export-progress">
      <circle className="export-ring-track" cx={8} cy={8} r={6} />
      {/* A sliver from the start, so a queued render already reads as under way. */}
      <circle className="export-ring-fill" cx={8} cy={8} r={6} pathLength={100} strokeDasharray={`${Math.max(pct, 4)} 100`} />
    </svg>
  );
}

export function ExportMenu() {
  const open = useExportPopover((s) => s.open);
  const job = useExportJob();
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  /** Opened with a click (not Enter, Space or the registry): focus waits on the popover instead of ringing the preset. */
  const byPointer = useRef(false);
  const shown = job.shown;
  const running = isRendering(shown);

  // What the popover last showed. A render that ends while it is closed differs from that: the button marks it.
  const key = shown ? `${shown.id} ${shown.status}` : '';
  const [seen, setSeen] = useState(key);
  useEffect(() => {
    if (open) setSeen(key);
  }, [open, key]);
  const ended = !open && key !== seen ? shown?.status : undefined;
  const mark = ended === 'done' ? 'done' : ended === 'failed' || ended === 'interrupted' ? 'failed' : null;

  const close = (refocus: boolean) => {
    openExport(false);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && openExport(false);
    window.addEventListener('pointerdown', away);
    // Focus moves in: from the keyboard to the preset; after a click, or while a render holds the preset, to the popover itself (Cancel is no default). Tab goes on from there.
    const pop = popRef.current;
    ((byPointer.current ? null : pop?.querySelector<HTMLElement>('select:not(:disabled)')) ?? pop)?.focus({ preventScroll: true });
    byPointer.current = false;
    return () => window.removeEventListener('pointerdown', away);
  }, [open]);

  // A control that goes away under the focus (Export video once its render starts, Cancel once it ends) hands it to the popover, so Escape and Tab still reach it.
  useEffect(() => {
    const pop = popRef.current;
    if (open && pop && (!document.activeElement || document.activeElement === document.body)) pop.focus({ preventScroll: true });
  });

  const onKey = (e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    // In the popover, Space, the arrows and letters are its own (they are editor shortcuts too); ⌘ ones still reach the editor.
    if (e.target !== buttonRef.current && !(e.metaKey || e.ctrlKey)) e.stopPropagation();
  };

  const state = running ? `rendering ${job.pct}%` : mark === 'done' ? 'render ready' : mark === 'failed' ? 'render failed' : null;
  const title = running
    ? `Rendering: ${job.pct}%. You can keep editing meanwhile.`
    : mark === 'done'
      ? 'The render is ready to download'
      : mark === 'failed'
        ? 'The render failed. Open Export to retry it.'
        : 'Export a video, a still or a thumbnail';

  return (
    <div
      className="export-menu"
      ref={ref}
      onKeyDown={onKey}
      // Tabbing on past the popover closes it; a click on its own padding keeps it (the popover takes focus).
      onBlur={(e) => open && e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node) && openExport(false)}
    >
      <button
        ref={buttonRef}
        className="btn primary export-btn"
        data-testid="export-mp4"
        data-state={running ? 'rendering' : (mark ?? undefined)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={state ? `Export, ${state}` : undefined}
        title={title}
        onClick={(e) => {
          // A click from the keyboard (Enter, Space) has no detail.
          byPointer.current = e.detail > 0;
          openExport(!open);
        }}
      >
        Export
        {running ? <ProgressRing pct={job.pct} /> : <Icon name={mark === 'done' ? 'check' : mark === 'failed' ? 'warning' : 'down'} size={14} />}
      </button>
      {open && (
        <div className="export-pop" ref={popRef} role="dialog" aria-label="Export" tabIndex={-1} data-testid="export-pop">
          <ExportPanel job={job} />
        </div>
      )}
    </div>
  );
}
