// Right-click menus on the canvas, scene cards, layers, clips and keyframes:
// the registry's actions (actions.ts) whose `contexts` include what was
// clicked. A surface selects its target first, then calls openContextMenu
// (openSceneMenu and openElementMenu do both); the actions act on the
// selection. One menu at a time, mounted once in App, at the pointer and kept
// on screen, with the menubar's rows and keys (Menubar.tsx). Escape, a press
// outside, a scroll or an action closes it.

import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react';
import { create } from 'zustand';
import { sceneStartFrame } from '../core/timing';
import { actionsFor, type ContextKind, type EditorAction } from './actions';
import { ActionItems, itemsIn, listKeys, useMenuKeys } from './Menubar';
import { useEditor } from './store';

interface ContextMenuState {
  open: { kind: ContextKind; x: number; y: number } | null;
}

export const useContextMenu = create<ContextMenuState>(() => ({ open: null }));

export function openContextMenu(e: ReactMouseEvent | MouseEvent, kind: ContextKind): void {
  e.preventDefault();
  e.stopPropagation();
  useContextMenu.setState({ open: { kind, x: e.clientX, y: e.clientY } });
}

export function closeContextMenu(): void {
  useContextMenu.setState({ open: null });
}

/** A scene card or row: go to the scene unless it is the current one, then its menu. */
export function openSceneMenu(e: ReactMouseEvent, sceneId: string): void {
  const st = useEditor.getState();
  // Actions use the selection: keep playback from advancing it behind the menu.
  st.setPlaying(false);
  if (st.selection.sceneId !== sceneId) {
    st.seek(sceneStartFrame(st.doc.project, sceneId));
  }
  openContextMenu(e, 'scene');
}

/** An element's bar, row or layer: select it unless it is already in the selection, then its menu. */
export function openElementMenu(e: ReactMouseEvent, sceneId: string, elementId: string, kind: 'element' | 'layer' | 'clip'): void {
  const st = useEditor.getState();
  if (st.selection.sceneId !== sceneId || !st.selection.elementIds.includes(elementId)) st.selectElement(sceneId, elementId);
  openContextMenu(e, kind);
}

const EDGE = 8;

export function ContextMenuHost() {
  const open = useContextMenu((s) => s.open);
  if (!open || !actionsFor(open.kind).length) return null;
  // A new right-click is a new menu, with its own place and its own focus to give back.
  return <ContextMenu key={`${open.kind}:${open.x}:${open.y}`} {...open} />;
}

function ContextMenu({ kind, x, y }: { kind: ContextKind; x: number; y: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState({ left: x, top: y });
  const [returnTo] = useState(() => document.activeElement as HTMLElement | null);
  const actions = actionsFor(kind);

  const close = (refocus: boolean) => {
    closeContextMenu();
    if (refocus) returnTo?.focus?.({ preventScroll: true });
  };
  const run = (a: EditorAction) => {
    close(true);
    a.run();
  };

  // At the pointer, flipped to its left or moved up when it would leave the window; then it takes the keyboard.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPlace({
      left: x + width > window.innerWidth - EDGE ? Math.max(EDGE, x - width) : x,
      top: Math.max(EDGE, Math.min(y, window.innerHeight - EDGE - height)),
    });
    el.focus({ preventScroll: true });
  }, []);

  // A press or a scroll (the wheel; a scrollbar is a press) anywhere else closes it. Scrolls the editor makes
  // itself don't: the timeline follows the playhead a right-click on a scene has just moved.
  useEffect(() => {
    const inside = (t: EventTarget | null) => !!ref.current?.contains(t as Node);
    const outside = (e: Event) => !inside(e.target) && close(false);
    const away = () => close(false);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('wheel', outside, { capture: true, passive: true });
    window.addEventListener('resize', away);
    window.addEventListener('blur', away);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('wheel', outside, true);
      window.removeEventListener('resize', away);
      window.removeEventListener('blur', away);
    };
  }, []);

  useMenuKeys((e) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      close(true);
      return true;
    }
    return listKeys(e, itemsIn(ref.current));
  });

  return (
    <div
      ref={ref}
      className="menu-pop context-menu"
      role="menu"
      aria-label="Actions"
      tabIndex={-1}
      style={place}
      data-testid="context-menu"
      data-kind={kind}
      onContextMenu={(e) => e.preventDefault()}
    >
      <ActionItems actions={actions} testPrefix="context-" onRun={run} />
    </div>
  );
}
