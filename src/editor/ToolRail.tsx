// The 44 px tool rail on the left of the stage, one letter each: Select (V),
// Hand (H) and Pen (P) pick how the canvas takes the pointer; Text (T), Shape
// (R) and Image (I) add that element to the current scene and go back to
// Select; Insert (every element, the templates and the motion presets,
// InsertMenu.tsx) and Audio (import a file or a built-in sound effect,
// SoundEffectsMenu.tsx) open beside the rail. App.tsx handles H, T, R and I;
// V and P live in canvasControls.ts.

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from 'react';
import { create } from 'zustand';
import { COMPONENTS } from '../core/components';
import type { ElementType } from '../core/types';
import { newAsset, uploadAsset } from './assets';
import { createElement } from './doc';
import { addElementOfType, guardLocked } from './editActions';
import { Icon, type IconName } from './icons';
import { ASKS_FOR_FILE, InsertMenu } from './InsertMenu';
import { setCanvasTool } from './PathEditor';
import { useProposals } from './proposals';
import { AudioMenu } from './SoundEffectsMenu';
import { useCurrentScene, useEditor } from './store';
import { insertVideoFromFile } from './VideoAssetRow';

export type RailTool = 'select' | 'hand' | 'pen';
export type RailPopover = 'insert' | 'audio';

/** The popover open beside the rail, one at a time. The menubar opens them too (Insert › More…, Insert › Audio…). */
export const useRail = create<{ popover: RailPopover | null }>(() => ({ popover: null }));

export function openRailPopover(popover: RailPopover | null): void {
  useRail.setState({ popover });
}

let unlatch: (() => void) | null = null;

/**
 * H and the rail's Hand latch the hand tool until H again or another tool.
 * Releasing Space and a window blur turn the hand off (canvasControls.ts);
 * while it is latched it comes straight back on, so Space still pans and a
 * tap still plays.
 */
export function setHandLatch(on: boolean): void {
  if (on === !!unlatch) return;
  if (on) {
    unlatch = useEditor.subscribe((s, prev) => {
      if (s.tool !== prev.tool) setHandLatch(false);
      else if (prev.handTool && !s.handTool) s.setHandTool(true);
    });
    useEditor.getState().setHandTool(true);
  } else {
    unlatch?.();
    unlatch = null;
    useEditor.getState().setHandTool(false);
  }
}

/** Select, Hand or Pen: from the rail, the letters and the Edit menu. Hand toggles; the Pen again goes back to Select. */
export function pickTool(tool: RailTool): void {
  if (tool === 'hand') return setHandLatch(!unlatch);
  setHandLatch(false);
  const current = useEditor.getState().tool;
  setCanvasTool(current === 'pen' && tool === 'pen' ? 'select' : tool);
}

const selectedScene = () => {
  const st = useEditor.getState();
  return st.doc.project.scenes.find((s) => s.id === st.selection.sceneId);
};

/**
 * An image or an SVG logo needs its file: pick one, upload it and place it in
 * the scene it was asked for, its box fitted to the picture. One undo step
 * (the asset and the element).
 */
export async function placeFromFile(type: 'image' | 'logo'): Promise<boolean> {
  const st = useEditor.getState();
  const scene = selectedScene();
  if (!scene || guardLocked(scene)) return false;
  // The upload must land in the document it started from.
  const session = st.docSession;
  const fields = await uploadAsset(type === 'logo' ? ['svg'] : ['image', 'svg']);
  if (!fields) return false;
  const now = useEditor.getState();
  if (now.docSession !== session) {
    now.toast({ tone: 'info', message: `“${fields.name}” was uploaded, but another project is open now, so it was not placed.` });
    return false;
  }
  const target = now.doc.project.scenes.find((s) => s.id === scene.id);
  if (!target || guardLocked(target)) return false;
  const asset = newAsset(fields);
  const element = createElement(now.doc.project, target, type);
  element.props = { ...element.props, assetId: asset.id };
  if (asset.width && asset.height) {
    const box = element.transform;
    const k = Math.min(box.width / asset.width, box.height / asset.height);
    const width = Math.round(asset.width * k);
    const height = Math.round(asset.height * k);
    element.transform = { ...box, width, height, x: Math.round(box.x + (box.width - width) / 2), y: Math.round(box.y + (box.height - height) / 2) };
  }
  const label = `Add ${COMPONENTS[type].label.toLowerCase()} “${asset.name}”`;
  if (!now.run({ type: 'batch', label, commands: [{ type: 'addAsset', asset }, { type: 'addElement', sceneId: target.id, element }] }, label)) return false;
  useEditor.getState().selectElement(target.id, element.id);
  return true;
}

/**
 * T, R, I, the rail and Insert › Elements: a new element in the current
 * scene, selected, with the Select tool. Image, SVG logo and Video ask for
 * their file first (true: the file dialog is open).
 */
export function addFromRail(type: ElementType): boolean {
  pickTool('select');
  if (!ASKS_FOR_FILE.includes(type)) return addElementOfType(type);
  if (!selectedScene()) return false;
  // Each checks the scene's lock before the dialog opens.
  void (type === 'video' ? insertVideoFromFile() : placeFromFile(type === 'logo' ? 'logo' : 'image'));
  return true;
}

const TOOLS: { id: RailTool; icon: IconName; label: string; key: string }[] = [
  { id: 'select', icon: 'pointer', label: 'Select', key: 'V' },
  { id: 'hand', icon: 'hand', label: 'Hand: drag to pan', key: 'H' },
  { id: 'pen', icon: 'pen', label: 'Pen: draw a path', key: 'P' },
];

const ADDS: { type: ElementType; icon: IconName; label: string; key: string }[] = [
  { type: 'text', icon: 'text', label: 'Text', key: 'T' },
  { type: 'shape', icon: 'shape', label: 'Shape', key: 'R' },
  { type: 'image', icon: 'image', label: 'Image', key: 'I' },
];

/** The least room a popover keeps to the window's bottom and the rail's top. */
const POP_MARGIN = 8;

/** A rail button that opens a popover to its right: level with the button, moved up when it would run off the window. Escape closes it and returns focus to the button. */
function RailMenu({ id, icon, label, title, disabled, children }: { id: RailPopover; icon: IconName; label: string; title: string; disabled: boolean; children: (close: () => void) => ReactNode }) {
  const open = useRail((s) => s.popover === id) && !disabled;
  const ref = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  const close = (refocus: boolean) => {
    openRailPopover(null);
    if (refocus) buttonRef.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && openRailPopover(null);
    window.addEventListener('pointerdown', away);
    // Focus moves in: the chosen tab, or the first thing that can be picked.
    const pop = popRef.current;
    (pop?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]') ?? pop?.querySelector<HTMLElement>('button:not(:disabled)'))?.focus({ preventScroll: true });
    return () => window.removeEventListener('pointerdown', away);
  }, [open]);

  // Placed after every change of size (a tab switch changes the height) and on a window resize.
  useLayoutEffect(() => {
    const pop = popRef.current;
    const anchor = ref.current;
    if (!open || !pop || !anchor) return;
    const place = () => {
      const top = anchor.getBoundingClientRect().top;
      const floor = (anchor.closest('.tool-rail')?.getBoundingClientRect().top ?? 0) + POP_MARGIN;
      pop.style.maxHeight = `${window.innerHeight - floor - POP_MARGIN}px`;
      const y = Math.max(floor, Math.min(top, window.innerHeight - POP_MARGIN - pop.offsetHeight));
      pop.style.top = `${Math.round(y - top)}px`;
    };
    place();
    const ro = new ResizeObserver(place);
    ro.observe(pop);
    window.addEventListener('resize', place);
    return () => {
      ro.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [open]);

  const onKey = (e: KeyboardEvent) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close(true);
      return;
    }
    // On the button itself, Up / Down still walk the rail.
    if (e.target === buttonRef.current) return;
    e.stopPropagation(); // editor shortcuts stay off while the popover has the keys
    const target = e.target as HTMLElement;
    const pop = popRef.current;
    if (!pop) return;
    // Left / Right walk the tabs (and pick the one reached); Up / Down / Home / End walk everything that can be picked.
    if (target.getAttribute('role') === 'tab' && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
      const tabs = [...pop.querySelectorAll<HTMLElement>('[role="tab"]')];
      const next = tabs[(tabs.indexOf(target) + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      e.preventDefault();
      next?.focus();
      next?.click();
      return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    // The chosen tab, then what its panel offers (the other tabs are a Left / Right away).
    const tab = pop.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    const items = [...(tab ? [tab] : []), ...pop.querySelectorAll<HTMLElement>('button:not(:disabled):not([role="tab"])')];
    if (!items.length) return;
    const at = items.indexOf(target);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : e.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length : at) - 1;
    e.preventDefault();
    items[next]?.focus();
  };

  return (
    <div
      className="rail-menu"
      ref={ref}
      onKeyDown={onKey}
      // Tabbing on past the popover closes it; a click on its own padding keeps it (the popover takes focus).
      onBlur={(e) => open && e.relatedTarget && !ref.current?.contains(e.relatedTarget as Node) && openRailPopover(null)}
    >
      <button
        ref={buttonRef}
        className="icon-btn rail-btn"
        data-testid={`rail-${id}`}
        title={title}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => openRailPopover(open ? null : id)}
      >
        <Icon name={icon} />
      </button>
      {open && (
        <div className="ins-pop" ref={popRef} role="dialog" aria-label={label} tabIndex={-1} data-testid={`rail-${id}-pop`}>
          {children(() => close(true))}
        </div>
      )}
    </div>
  );
}

export function ToolRail() {
  const tool = useEditor((s) => s.tool);
  const hand = useEditor((s) => s.handTool);
  const scene = useCurrentScene();
  // A proposal's review owns the stage: nothing to draw on or add to until it is decided.
  const reviewing = useProposals((s) => s.open && !!s.proposal);
  const locked = !!scene?.locked;
  const active = (id: RailTool) => (id === 'hand' ? hand : !hand && tool === id);
  useEffect(() => {
    if (reviewing) openRailPopover(null);
  }, [reviewing]);

  const toolTitle = (t: (typeof TOOLS)[number]) => (t.id === 'pen' && locked ? `Pen (${t.key}): this scene is approved; unlock it to draw` : `${t.label} (${t.key})`);

  // Up / Down move between the rail's buttons.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const target = e.target as HTMLElement;
    if (!target.classList.contains('rail-btn')) return;
    const buttons = [...e.currentTarget.querySelectorAll<HTMLElement>('.rail-btn:not(:disabled)')];
    const at = buttons.indexOf(target);
    e.preventDefault();
    e.stopPropagation();
    buttons[(at + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus();
  };

  return (
    <nav className="tool-rail" aria-label="Tools" data-testid="tool-rail" onKeyDown={onKey}>
      <div className="tool-rail-group" role="group" aria-label="Canvas tools">
        {TOOLS.map((t) => (
          <button
            key={t.id}
            className="icon-btn rail-btn"
            data-testid={`rail-${t.id}`}
            title={toolTitle(t)}
            aria-label={t.label}
            aria-keyshortcuts={t.key}
            aria-pressed={active(t.id)}
            disabled={reviewing}
            onClick={() => pickTool(t.id)}
          >
            <Icon name={t.icon} />
          </button>
        ))}
      </div>
      <span className="tool-rail-sep" aria-hidden />
      <div className="tool-rail-group" role="group" aria-label="Add to the scene">
        {ADDS.map((a) => (
          <button
            key={a.type}
            className="icon-btn rail-btn"
            data-testid={`rail-${a.type}`}
            title={scene ? `${a.label} (${a.key}): ${ASKS_FOR_FILE.includes(a.type) ? 'place a picture in' : 'add to'} “${scene.name}”` : `${a.label} (${a.key}): add a scene first`}
            aria-label={`Add ${a.label.toLowerCase()}`}
            aria-keyshortcuts={a.key}
            disabled={!scene || reviewing}
            onClick={() => addFromRail(a.type)}
          >
            <Icon name={a.icon} />
          </button>
        ))}
      </div>
      <span className="tool-rail-sep" aria-hidden />
      <div className="tool-rail-group" role="group" aria-label="Insert">
        <RailMenu id="insert" icon="insert" label="Insert" title="Insert: every element, templates and motion presets" disabled={reviewing}>
          {(close) => <InsertMenu onDone={close} onAdd={addFromRail} />}
        </RailMenu>
        <RailMenu id="audio" icon="audio" label="Audio" title="Audio: import a file or add a built-in sound effect" disabled={reviewing}>
          {(close) => <AudioMenu onDone={close} />}
        </RailMenu>
      </div>
    </nav>
  );
}
