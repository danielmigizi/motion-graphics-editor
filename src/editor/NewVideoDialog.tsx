// The create dialogs: the outline review expanded from its chat card into a
// wide dialog (for long outlines), and Size & frame rate. The brief itself is
// written in the chat (BriefComposer.tsx).
//
// CreateDialogs mounts them; both editor views render it once, next to their menus.

import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { closeCreateDialog, dialogKeyDown, useCreate } from './createFlow';
import { FormatDialog } from './FormatDialog';
import { Icon } from './icons';
import { OutlineFooter, OutlineReview } from './OutlineReview';

/** The pending outline in a wide dialog; closing it brings the chat card back. */
export function NewVideoDialog() {
  const hasOutline = useCreate((s) => !!s.outline && s.status === 'pending');
  // Approved, declined or replaced by nothing: there is nothing left to review.
  useEffect(() => {
    if (!hasOutline) closeCreateDialog();
  }, [hasOutline]);
  if (!hasOutline) return null;
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && closeCreateDialog()}>
      <div className="modal cv-dialog wide" role="dialog" aria-label="Review the outline" data-testid="outline-dialog" onKeyDown={dialogKeyDown}>
        <header className="modal-head">
          <h2>Review the outline</h2>
          <button className="icon-btn" onClick={closeCreateDialog} aria-label="Close" title="Back to the chat">
            <Icon name="close" />
          </button>
        </header>
        <OutlineReview />
        <OutlineFooter />
      </div>
    </div>
  );
}

/** The create dialogs; render once per editor view. */
export function CreateDialogs() {
  const dialog = useCreate((s) => s.dialog);
  useEffect(() => {
    if (!dialog) return;
    // Focus outside the dialog (keys inside it never reach the window).
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeCreateDialog();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [dialog]);
  const el = dialog === 'review' ? <NewVideoDialog /> : dialog === 'format' ? <FormatDialog /> : null;
  // On the body, so the stage header's stacking context cannot trap the backdrop under the stage.
  return el && createPortal(el, document.body);
}
