// The menubar behind the project title: File, Edit, Scene, Insert, View and
// Help, read from the action registry (actions.ts), each item with its
// shortcut. StageHeader mounts it where the title was.
//
// A click on the title opens the list of menus; each opens its submenu to the
// right on hover or →. Pressing and releasing Alt alone opens it with File
// highlighted. Double-click the title to rename the project. The keyboard
// works throughout: arrows, Enter, Escape, the first letter of an item, and
// focus goes back to the title when the menu closes.
//
// An open menu (this one or a right-click menu, ContextMenu.tsx) takes the
// keyboard through one window listener installed when this module loads, so
// it runs before any surface's own (the timeline listens in the capture phase
// for M, B, Delete, Escape…): no editor shortcut fires while a menu is open.

import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { actionsIn, isEnabled, labelOf, MENUS, shortcutText, type ActionMenu, type EditorAction } from './actions';
import { isTyping, shortcutLabel } from './editActions';
import { CommitText } from './fields';
import { Icon } from './icons';
import { useLayout } from './layout';
import { hasModalSurface } from './modalSurface';
import { useEditor } from './store';
import { useTheme } from './theme';

// ---------------------------------------------------------------------------
// The keyboard while a menu is open, and Alt on its own
// ---------------------------------------------------------------------------

/** The open menu's key handler; true when it used the key. */
type MenuKeys = (e: KeyboardEvent) => boolean;
let menuKeys: MenuKeys | null = null;
/** Alt went down and nothing else has happened since. */
let altAlone = false;

/** Give the keyboard to an open menu (null: closed). */
export function useMenuKeys(handler: MenuKeys | null): void {
  const ref = useRef(handler);
  ref.current = handler;
  const active = !!handler;
  useEffect(() => {
    if (!active) return;
    const keys: MenuKeys = (e) => ref.current?.(e) ?? false;
    menuKeys = keys;
    return () => {
      if (menuKeys === keys) menuKeys = null;
    };
  }, [active]);
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== 'Alt') altAlone = false;
  else if (!e.repeat) altAlone = !e.ctrlKey && !e.metaKey && !e.shiftKey;
  if (!menuKeys) return;
  // A key the menu uses does only that; any other still reaches the browser, never the editor.
  if (menuKeys(e)) e.preventDefault();
  e.stopImmediatePropagation();
}

function onKeyUp(e: KeyboardEvent) {
  if (e.key !== 'Alt' || !altAlone) return;
  altAlone = false;
  const open = useMenubar.getState().open;
  // Another menu has the keyboard, or Alt was for a field (⌥ types accents on a Mac).
  if ((menuKeys && !open) || isTyping(e.target) || hasModalSurface()) return;
  e.preventDefault();
  if (open) closeMenubar(true);
  else openMenubar();
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('pointerdown', () => (altAlone = false), true);
  window.addEventListener('blur', () => (altAlone = false));
}

export const itemsIn = (el: Element | null | undefined) => Array.from(el?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? []);

/**
 * Arrow keys, Home / End and an item's first letter move the focus through
 * `items`; Enter and Space activate the focused one. True when used.
 */
export function listKeys(e: KeyboardEvent, items: HTMLElement[]): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const i = items.indexOf(document.activeElement as HTMLElement);
  const go = (j: number) => {
    items[(j + items.length) % items.length]?.focus();
    return true;
  };
  switch (e.key) {
    case 'ArrowDown':
      return go(i < 0 ? 0 : i + 1);
    case 'ArrowUp':
      return go(i < 0 ? items.length - 1 : i - 1);
    case 'Home':
      return go(0);
    case 'End':
      return go(items.length - 1);
    case 'Enter':
    case ' ':
      items[i]?.click();
      return true;
  }
  if (e.key.length === 1 && e.key.trim()) {
    const ch = e.key.toLowerCase();
    [...items.slice(i + 1), ...items.slice(0, i + 1)].find((el) => (el.dataset.label ?? '').toLowerCase().startsWith(ch))?.focus();
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Rows: the same in the menubar's submenus and the right-click menus
// ---------------------------------------------------------------------------

/** Re-render as anything an item's label, enabled or checked state reads changes (only mounted while open). */
function useRegistryState() {
  useEditor((s) => s);
  useLayout((s) => s);
  useTheme((s) => s.choice);
}

/** One row per action, a rule between groups. A disabled row stays reachable and says why in its tooltip. */
export function ActionItems({ actions, testPrefix, onRun }: { actions: EditorAction[]; testPrefix: string; onRun: (a: EditorAction) => void }) {
  useRegistryState();
  const rows: ReactNode[] = [];
  actions.forEach((a, i) => {
    if (i > 0 && a.group !== actions[i - 1].group) rows.push(<div key={`rule-${a.id}`} className="menu-rule" role="separator" />);
    const enabled = isEnabled(a);
    const checked = a.checked?.();
    const label = labelOf(a);
    rows.push(
      <button
        key={a.id}
        type="button"
        className="menu-item"
        role={a.checked ? 'menuitemcheckbox' : 'menuitem'}
        aria-checked={a.checked ? !!checked : undefined}
        aria-disabled={enabled ? undefined : true}
        tabIndex={-1}
        title={enabled ? undefined : a.whyDisabled?.()}
        data-label={label}
        data-testid={`${testPrefix}${a.id}`}
        onPointerEnter={(e) => e.currentTarget.focus({ preventScroll: true })}
        onClick={() => enabled && onRun(a)}
      >
        <span className="menu-item-icon" aria-hidden>
          {a.checked ? checked && <Icon name="check" size={14} /> : a.icon && <Icon name={a.icon} size={14} />}
        </span>
        <span className="menu-item-label">{label}</span>
        {a.shortcut && <kbd className="menu-item-key">{shortcutText(a.shortcut)}</kbd>}
      </button>,
    );
  });
  return <>{rows}</>;
}

// ---------------------------------------------------------------------------
// The menubar
// ---------------------------------------------------------------------------

interface MenubarState {
  open: boolean;
  /** The menu whose submenu is out. */
  sub: ActionMenu | null;
  /** Where the keyboard lands: a menu's row, or (into) the first item of its submenu. Null: the list itself (a pointer click). */
  focus: { menu: ActionMenu; into: boolean } | null;
  /** Bumped whenever the focus should land again. */
  seq: number;
}

export const useMenubar = create<MenubarState>(() => ({ open: false, sub: null, focus: null, seq: 0 }));

/** Open the menubar on `menu`'s submenu with its first item focused, or with File highlighted. */
export function openMenubar(menu?: ActionMenu): void {
  useMenubar.setState((s) => ({ open: true, sub: menu ?? null, focus: { menu: menu ?? 'file', into: !!menu }, seq: s.seq + 1 }));
}

let titleButton: HTMLButtonElement | null = null;

function closeMenubar(refocus: boolean) {
  useMenubar.setState({ open: false, sub: null, focus: null });
  if (refocus) titleButton?.focus({ preventScroll: true });
}

/** The rail's Insert button opens this very menu, so the Insert submenu leaves that action out. */
const listed = (menu: ActionMenu) => actionsIn(menu).filter((a) => a.id !== 'insert.more');

/** Another row's submenu waits this long before replacing the open one, so the pointer can cross rows on its way in. */
const SWITCH_MS = 140;

const ALT = shortcutLabel('', ['alt']).replace(/\+$/, '');

export function Menubar() {
  const name = useEditor((s) => s.doc.project.name);
  const { open, sub, focus, seq } = useMenubar();
  const [renaming, setRenaming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const subRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLButtonElement>(null);
  const switchTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    titleButton = titleRef.current;
  });

  const setSub = (menu: ActionMenu | null) => {
    window.clearTimeout(switchTimer.current);
    useMenubar.setState({ sub: menu });
  };
  const rowOf = (menu: ActionMenu) => popRef.current?.querySelector<HTMLElement>(`[data-menu="${menu}"]`) ?? null;

  // Land the keyboard where the opener asked.
  useEffect(() => {
    if (!open) return;
    if (!focus) popRef.current?.focus({ preventScroll: true });
    else if (!focus.into) rowOf(focus.menu)?.focus({ preventScroll: true });
    else itemsIn(subRef.current)[0]?.focus({ preventScroll: true });
  }, [open, seq]);

  // A press outside, or the window losing focus or resizing, closes it.
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => !rootRef.current?.contains(e.target as Node) && closeMenubar(false);
    const away = () => closeMenubar(false);
    window.addEventListener('pointerdown', outside, true);
    window.addEventListener('blur', away);
    window.addEventListener('resize', away);
    return () => {
      window.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('blur', away);
      window.removeEventListener('resize', away);
      window.clearTimeout(switchTimer.current);
    };
  }, [open]);

  // The submenu's first item lines up with its row; a long one moves up as far as it takes to stay on screen.
  useLayoutEffect(() => {
    const el = subRef.current;
    const pop = popRef.current;
    const row = sub ? rowOf(sub) : null;
    if (!el || !pop || !row) return;
    const popTop = pop.getBoundingClientRect().top;
    const room = window.innerHeight - 8 - popTop;
    // Both lists have a 4 px padding and no border: the first item sits 4 px below the submenu's top.
    el.style.top = `${Math.max(8 - popTop, Math.min(row.offsetTop - 4, room - el.offsetHeight))}px`;
  }, [sub, open]);

  const run = (a: EditorAction) => {
    closeMenubar(true);
    a.run();
  };

  useMenuKeys(
    open
      ? (e) => {
          if (e.key === 'Tab') {
            closeMenubar(true);
            return true;
          }
          if (subRef.current?.contains(document.activeElement)) {
            if (e.key === 'Escape' || e.key === 'ArrowLeft') {
              const row = sub ? rowOf(sub) : null;
              setSub(null);
              row?.focus();
              return true;
            }
            return e.key === 'ArrowRight' || listKeys(e, itemsIn(subRef.current));
          }
          const rows = MENUS.map((m) => rowOf(m.id)).filter((el): el is HTMLElement => !!el);
          const menu = rows.find((el) => el === document.activeElement)?.dataset.menu as ActionMenu | undefined;
          if (e.key === 'Escape') {
            closeMenubar(true);
            return true;
          }
          if (menu && (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ')) {
            setSub(menu);
            useMenubar.setState((s) => ({ focus: { menu, into: true }, seq: s.seq + 1 }));
            return true;
          }
          if (e.key === 'ArrowLeft') return true;
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') setSub(null);
          return listKeys(e, rows);
        }
      : null,
  );

  const onTitleClick = (e: ReactMouseEvent) => {
    // The second click of a double-click leaves the menu as the first one left it.
    if (e.detail > 1) return;
    if (open) closeMenubar(false);
    // A keyboard click (Enter, Space) highlights File; a pointer click highlights nothing.
    else if (e.detail === 0) openMenubar();
    else useMenubar.setState((s) => ({ open: true, sub: null, focus: null, seq: s.seq + 1 }));
  };

  const endRename = (e: FocusEvent) => {
    setRenaming(false);
    // Enter or Escape let go of the field (nothing else took the focus): back to the title.
    if (!e.relatedTarget) requestAnimationFrame(() => titleRef.current?.focus({ preventScroll: true }));
  };

  return (
    <div className="menubar" ref={rootRef} data-testid="menubar">
      {renaming ? (
        <Rename name={name} onDone={endRename} />
      ) : (
        <button
          ref={titleRef}
          type="button"
          className={`menubar-title ${open ? 'open' : ''}`}
          aria-haspopup="menu"
          aria-expanded={open}
          title={`Menu (${ALT}). Double-click to rename the project.`}
          data-testid="menubar-title"
          onClick={onTitleClick}
          onDoubleClick={() => {
            closeMenubar(false);
            setRenaming(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && !open) {
              e.preventDefault();
              openMenubar();
            }
          }}
        >
          <span className="menubar-name">{name}</span>
          <Icon name="down" size={14} className="menubar-caret" />
        </button>
      )}
      {open && (
        <div className="menu-pop menubar-pop" ref={popRef} role="menubar" aria-orientation="vertical" aria-label="Menu" tabIndex={-1}>
          {MENUS.map((m) => (
            <div key={m.id} role="none">
              <button
                type="button"
                className={`menu-item ${sub === m.id ? 'active' : ''}`}
                role="menuitem"
                aria-haspopup="menu"
                aria-expanded={sub === m.id}
                tabIndex={-1}
                data-menu={m.id}
                data-label={m.label}
                data-testid={`menu-${m.id}`}
                onPointerEnter={(e) => {
                  e.currentTarget.focus({ preventScroll: true });
                  window.clearTimeout(switchTimer.current);
                  if (!sub) setSub(m.id);
                  else if (sub !== m.id) switchTimer.current = window.setTimeout(() => useMenubar.setState({ sub: m.id }), SWITCH_MS);
                }}
                onClick={() => setSub(m.id)}
              >
                <span className="menu-item-label">{m.label}</span>
                <Icon name="right" size={14} className="menu-item-sub" />
              </button>
              {sub === m.id && (
                <div className="menu-pop menubar-sub" ref={subRef} role="menu" aria-label={m.label} data-testid={`menu-${m.id}-items`} onPointerEnter={() => window.clearTimeout(switchTimer.current)}>
                  <ActionItems actions={listed(m.id)} testPrefix="menu-" onRun={run} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The title as a field: Enter or leaving it renames the project, Escape keeps the old name. */
function Rename({ name, onDone }: { name: string; onDone: (e: FocusEvent) => void }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const input = ref.current?.querySelector('input');
    input?.focus();
    input?.select();
  }, []);
  return (
    <span className="menubar-rename" ref={ref} onBlur={onDone}>
      <CommitText
        className="menubar-rename-input"
        value={name}
        testId="project-name"
        maxLength={80}
        onCommit={(v) => v.trim() && useEditor.getState().run({ type: 'updateProject', changes: { name: v.trim() } }, 'Renamed the project')}
      />
    </span>
  );
}
