// Focus for the shell's dialogs (Settings, the shortcuts sheet, Style) and
// the command palette: focus moves in when one opens and stays inside while
// it is open (Tab wraps; a field that blurs itself hands focus back to the
// dialog), and goes back where it was when it closes.

import { useLayoutEffect, type FocusEvent, type KeyboardEvent, type RefObject } from 'react';

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The controls Tab reaches inside `root`, in order (rendered ones only). */
function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.getClientRects().length > 0);
}

/**
 * While the component is mounted: focus `initial` (a selector inside `ref`),
 * else its first control, else `ref` itself; on unmount, focus whatever had it
 * before, if that is still on the page.
 */
export function useDialogFocus(ref: RefObject<HTMLElement | null>, initial?: string) {
  useLayoutEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const root = ref.current;
    if (root) {
      const target = (initial ? root.querySelector<HTMLElement>(initial) : null) ?? focusables(root)[0] ?? root;
      target.focus({ preventScroll: true });
    }
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
    // Once per opening: where focus starts is decided when it opens, not by later renders.
  }, []);
}

const TEXT_INPUTS = ['text', 'search', 'number', 'email', 'url', 'tel', 'password'];

/** A field Escape belongs to first (it reverts or leaves it): text, not a select, checkbox or button. */
export function isTextEntry(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  if (el.tagName === 'TEXTAREA' || el.isContentEditable) return true;
  return el.tagName === 'INPUT' && TEXT_INPUTS.includes((el as HTMLInputElement).type);
}

/**
 * In a dialog's onBlur (the root needs tabIndex -1): when focus drops to the
 * page (a field blurs itself on Enter or Escape), the dialog takes it back, so
 * its keys (Escape, Tab) keep reaching it rather than the editor's shortcuts.
 */
export function holdFocus(e: FocusEvent, root: HTMLElement | null) {
  if (e.relatedTarget || !root) return;
  requestAnimationFrame(() => {
    if (root.isConnected && (!document.activeElement || document.activeElement === document.body)) root.focus({ preventScroll: true });
  });
}

/** In a dialog's keydown: Tab and Shift-Tab wrap around inside `root` instead of leaving it. */
export function trapTab(e: KeyboardEvent, root: HTMLElement | null) {
  if (e.key !== 'Tab' || !root) return;
  const list = focusables(root);
  if (list.length === 0) {
    e.preventDefault();
    return;
  }
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || !root.contains(active))) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && (active === last || !root.contains(active))) {
    e.preventDefault();
    first.focus();
  }
}
