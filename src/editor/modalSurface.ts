import { useCreate } from './createFlow';
import { useCutPicker } from './firstCut';
import { useLayout } from './layout';
import { useProposals } from './proposals';
import { useEditor } from './store';
import { useStylePanel } from './StylePanel';

/** Modal surfaces own the keyboard, even before they mount. */
export function hasModalSurface(): boolean {
  const st = useEditor.getState();
  return !!(useLayout.getState().overlay || st.sheet || st.openDialog || useCreate.getState().dialog || useStylePanel.getState().open || useCutPicker.getState().browse || useProposals.getState().open ||
    (typeof document !== 'undefined' && document.querySelector('[role="dialog"][aria-modal="true"]')));
}
