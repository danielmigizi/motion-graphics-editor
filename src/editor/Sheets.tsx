// The one panel still opened through store.sheet: Connect agents (Help ›
// Connect agents), a centred dialog as tall as its list and no wider than
// --sheet-w. Export is a popover from the header's Export button
// (ExportPopover.tsx); Assets and History are right-column tabs
// (RightColumn.tsx) and the queued requests live in Settings › Editor.
// Escape, the × or the backdrop closes it, and the focus goes back where it
// was.

import { useRef, type FocusEvent, type KeyboardEvent, type ReactNode } from 'react';
import { ConnectAgents } from './ConnectAgents';
import { Icon } from './icons';
import { holdFocus, trapTab, useDialogFocus } from './overlayFocus';
import { useEditor, type Sheet as SheetId } from './store';

const close = () => useEditor.getState().setSheet(null);

/** `initial`: a selector for the control that takes the focus when it opens (else its first one). */
function Dialog({ id, title, initial, children }: { id: SheetId; title: string; initial?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, initial);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    trapTab(e, ref.current);
    // Keys stay in the dialog, except ⌘ shortcuts: undo, redo, save, the palette.
    if (!(e.metaKey || e.ctrlKey)) e.stopPropagation();
  };
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={ref}
        className={`modal sheet-dialog ${id}-dialog`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`sheet-${id}-title`}
        tabIndex={-1}
        data-testid={`sheet-${id}`}
        onKeyDown={onKeyDown}
        onBlur={(e: FocusEvent) => holdFocus(e, ref.current)}
      >
        <header className="modal-head">
          <h2 id={`sheet-${id}-title`}>{title}</h2>
          <button className="icon-btn" onClick={close} aria-label="Close" title="Close (Esc)" data-testid="sheet-close">
            <Icon name="close" />
          </button>
        </header>
        <div className="sheet-dialog-body">{children}</div>
      </div>
    </div>
  );
}

export function Sheets() {
  const sheet = useEditor((s) => s.sheet);
  return sheet === 'connect' ? (
    // Check again rather than the ×, so Enter doesn't close what was just opened.
    <Dialog id="connect" title="Connect agents" initial="[data-testid='connect-check-again']">
      <ConnectAgents />
    </Dialog>
  ) : null;
}
