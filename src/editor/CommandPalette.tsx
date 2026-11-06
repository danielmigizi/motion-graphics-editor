// The command palette (layout.ts overlay 'palette', ⌘K): every action in the
// registry (actions.ts), every scene and element by name, every setting, with
// shortcuts. Type to narrow (fuzzy, best first: palette.ts); empty, it
// lists recent picks first. Arrows and Enter or a click run an item; Escape or
// a click outside closes. Mounted once in App.

import { useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { COMPONENTS } from '../core/components';
import { formatTimecode, sceneStartFrames } from '../core/timing';
import type { Element, Project, Scene } from '../core/types';
import { ACTIONS, isEnabled, labelOf, MENUS, shortcutText } from './actions';
import { ancestorsOf } from './canvasTree';
import { paletteText, parseRecent, pushRecent, rankEntries, type PaletteEntry, type Ranked } from './palette';
import { Icon, type IconName } from './icons';
import { ELEMENT_ICON } from './InspectorColumn';
import { useLayout } from './layout';
import { useDialogFocus } from './overlayFocus';
import { openSettingsAt, SETTINGS_SECTIONS } from './SettingsDialog';
import { useEditor } from './store';

interface PaletteItem extends PaletteEntry {
  /** The heading it sits under while the query is empty. */
  group: string;
  /** The group's heading names the detail (the current scene's elements): shown only in results and Recent. */
  detailInGroup?: boolean;
  icon?: IconName;
  /** Right-aligned in mono: the shortcut, or a scene's start. */
  trail?: string;
  checked?: boolean;
  disabled?: boolean;
  run: () => void;
}

// Recent picks are a per-browser convenience, never in a document.
const RECENT_KEY = 'mge.palette.recent';

function readRecent(): string[] {
  try {
    return parseRecent(localStorage.getItem(RECENT_KEY));
  } catch {
    return [];
  }
}

function writeRecent(ids: string[]) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(ids));
  } catch {
    // Storage blocked: the list just doesn't carry over.
  }
}

const close = () => useLayout.getState().openOverlay(null);

function goToScene(sceneId: string) {
  const st = useEditor.getState();
  const i = st.doc.project.scenes.findIndex((s) => s.id === sceneId);
  if (i < 0) return;
  st.setPlaying(false);
  st.seek(sceneStartFrames(st.doc.project)[i]);
  st.select({ elementId: null, elementIds: [] });
}

/** Select `el`; when it isn't on screen at the playhead, go to its first frame first. */
function goToElement(scene: Scene, el: Element) {
  const st = useEditor.getState();
  const i = st.doc.project.scenes.findIndex((s) => s.id === scene.id);
  if (i < 0) return;
  // Element frames are parent-relative: its first frame in the scene adds its groups' starts.
  const from = sceneStartFrames(st.doc.project)[i] + [el, ...ancestorsOf(scene.elements, el)].reduce((n, e) => n + e.startFrame, 0);
  if (st.selection.sceneId !== scene.id || st.playhead < from || st.playhead >= from + el.durationInFrames) {
    st.setPlaying(false);
    st.seek(from);
  }
  st.selectElement(scene.id, el.id);
}

function buildItems(project: Project, sceneId: string | null): PaletteItem[] {
  const menuLabel = new Map(MENUS.map((m) => [m.id, m.label]));
  const commands: PaletteItem[] = ACTIONS.filter((a) => a.id !== 'view.palette').map((a) => ({
    id: `action:${a.id}`,
    group: 'Commands',
    prefix: menuLabel.get(a.menu) ?? a.menu,
    label: labelOf(a),
    keywords: a.keywords,
    icon: a.icon,
    trail: a.shortcut && shortcutText(a.shortcut),
    checked: a.checked?.(),
    disabled: !isEnabled(a),
    run: a.run,
  }));
  const starts = sceneStartFrames(project);
  const scenes: PaletteItem[] = project.scenes.map((s, i) => ({
    id: `scene:${s.id}`,
    group: 'Scenes',
    prefix: 'Go to scene',
    label: s.name,
    keywords: [`scene ${i + 1}`],
    icon: 'frame',
    trail: formatTimecode(starts[i], project.fps),
    run: () => goToScene(s.id),
  }));
  // The current scene's elements first, then the other scenes' in order.
  const current = project.scenes.find((s) => s.id === sceneId);
  const elements: PaletteItem[] = [...(current ? [current] : []), ...project.scenes.filter((s) => s !== current)].flatMap((s) =>
    s.elements.map((el) => ({
      id: `element:${s.id}/${el.id}`,
      group: s === current ? `In “${s.name}”` : 'In other scenes',
      detailInGroup: s === current,
      prefix: 'Select',
      label: el.name,
      detail: s.name,
      keywords: [COMPONENTS[el.type]?.label ?? el.type],
      icon: ELEMENT_ICON[el.type],
      run: () => goToElement(s, el),
    })),
  );
  const settings: PaletteItem[] = SETTINGS_SECTIONS.map((s) => ({
    id: `setting:${s.id}`,
    group: 'Settings',
    prefix: 'Settings',
    label: s.label,
    keywords: s.keywords,
    icon: 'settings',
    run: () => openSettingsAt(s.id),
  }));
  return [...commands, ...scenes, ...elements, ...settings];
}

/** The rows under their headings: Recent, then the groups, while the query is empty; one list of results otherwise. */
function sectionsOf(rows: Ranked<PaletteItem>[], searching: boolean): { title: string | null; rows: { row: Ranked<PaletteItem>; n: number }[] }[] {
  if (searching) return [{ title: null, rows: rows.map((row, n) => ({ row, n })) }];
  const out: { title: string; rows: { row: Ranked<PaletteItem>; n: number }[] }[] = [];
  rows.forEach((row, n) => {
    const title = row.recent ? 'Recent' : row.entry.group;
    if (out[out.length - 1]?.title !== title) out.push({ title, rows: [] });
    out[out.length - 1].rows.push({ row, n });
  });
  return out;
}

/** `text[from, to)` with the matched characters marked. */
function marked(text: string, from: number, to: number, hits: Set<number>): ReactNode[] {
  const out: ReactNode[] = [];
  let run = '';
  let on = false;
  for (let i = from; i < to; i++) {
    const hit = hits.has(i);
    if (hit !== on && run) {
      out.push(on ? <mark key={i}>{run}</mark> : run);
      run = '';
    }
    on = hit;
    run += text[i];
  }
  if (run) out.push(on ? <mark key={to}>{run}</mark> : run);
  return out;
}

/** "Edit · Duplicate — Intro": the prefix and the scene quiet, the label plain, matches marked. */
function ItemText({ entry, positions, recent, searching }: Ranked<PaletteItem> & { searching: boolean }) {
  const text = paletteText(entry);
  const hits = new Set(positions);
  const labelAt = entry.prefix.length + 3;
  const labelEnd = labelAt + entry.label.length;
  return (
    <span className="palette-text">
      <span className="palette-prefix">{marked(text, 0, entry.prefix.length, hits)} · </span>
      <span className="palette-label">{marked(text, labelAt, labelEnd, hits)}</span>
      {entry.detail && (searching || recent || !entry.detailInGroup) && <span className="palette-detail"> — {marked(text, labelEnd + 3, text.length, hits)}</span>}
    </span>
  );
}

export function CommandPalette() {
  const open = useLayout((s) => s.overlay === 'palette');
  return open ? <Palette /> : null;
}

function Palette() {
  const project = useEditor((s) => s.doc.project);
  const sceneId = useEditor((s) => s.selection.sceneId);
  // Labels and enabled rules read the selection ("Delete “Headline”"): follow it.
  useEditor((s) => s.selection);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [recent] = useState(readRecent);
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  useDialogFocus(ref, '.palette-input');

  const searching = !!query.trim();
  const rows = rankEntries(buildItems(project, sceneId), query, recent);
  const at = Math.min(active, Math.max(0, rows.length - 1));

  useLayoutEffect(() => {
    listRef.current?.querySelector(`#palette-opt-${at}`)?.scrollIntoView({ block: 'nearest' });
  }, [at, query]);

  const pick = (row: Ranked<PaletteItem> | undefined) => {
    if (!row || row.entry.disabled) return;
    writeRecent(pushRecent(recent, row.entry.id));
    // Close first, so focus is back where it was before the item moves it (a rename field, another dialog).
    flushSync(close);
    row.entry.run();
  };

  const onKeyDown = (e: KeyboardEvent) => {
    const go = (n: number) => {
      e.preventDefault();
      if (rows.length) setActive((n + rows.length) % rows.length);
    };
    switch (e.key) {
      case 'ArrowDown':
        go(at + 1);
        break;
      case 'ArrowUp':
        go(at - 1);
        break;
      case 'PageDown':
        go(Math.min(rows.length - 1, at + 8));
        break;
      case 'PageUp':
        go(Math.max(0, at - 8));
        break;
      case 'Enter':
        e.preventDefault();
        pick(rows[at]);
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'Tab':
        // Focus stays in the field; the list is reached with the arrows.
        e.preventDefault();
        break;
    }
    // Typing stays here; ⌘ shortcuts (⌘K again, ⌘,) still reach the shell.
    if (!(e.metaKey || e.ctrlKey)) e.stopPropagation();
  };

  const optionId = (n: number) => `palette-opt-${n}`;

  return (
    <div className="palette-layer" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div
        ref={ref}
        className="palette"
        role="dialog"
        aria-label="Command palette"
        data-testid="command-palette"
        onKeyDown={onKeyDown}
        // Focus stays in the field whatever is clicked, so typing and the arrows keep working.
        onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}
      >
        <div className="palette-field">
          <Icon name="search" />
          <input
            className="palette-input"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-autocomplete="list"
            aria-activedescendant={rows.length ? optionId(at) : undefined}
            aria-label="Search commands, scenes, elements and settings"
            placeholder="Search commands, scenes, elements and settings"
            spellCheck={false}
            autoComplete="off"
            value={query}
            data-testid="palette-input"
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
          />
        </div>
        <div ref={listRef} className="palette-list" id="palette-list" role="listbox" aria-label="Results">
          {rows.length === 0 && <div className="palette-empty">Nothing matches “{query.trim()}”</div>}
          {sectionsOf(rows, searching).map((section) => {
            const options = section.rows.map(({ row, n }) => (
              <div
                key={row.entry.id}
                id={optionId(n)}
                role="option"
                aria-selected={n === at}
                aria-disabled={row.entry.disabled || undefined}
                className={`palette-item ${n === at ? 'active' : ''}`}
                data-testid={`palette-item-${n}`}
                // Only a moving pointer takes the highlight, not a list scrolling under a still one.
                onPointerMove={() => n !== at && setActive(n)}
                onClick={() => pick(row)}
              >
                <span className="palette-icon">{row.entry.icon && <Icon name={row.entry.icon} size={14} />}</span>
                <ItemText {...row} searching={searching} />
                {row.entry.checked && <Icon name="check" size={14} className="palette-check" />}
                {row.entry.trail && <span className="palette-trail">{row.entry.trail}</span>}
              </div>
            ));
            if (!section.title) return options;
            const headingId = `palette-group-${section.title.replace(/\W+/g, '-')}`;
            return (
              <div key={section.title} role="group" aria-labelledby={headingId}>
                <div id={headingId} className="palette-group" role="presentation">
                  {section.title}
                </div>
                {options}
              </div>
            );
          })}
        </div>
        <footer className="palette-foot" aria-hidden>
          <span>
            <kbd className="kbd">↑</kbd>
            <kbd className="kbd">↓</kbd> to move
          </span>
          <span>
            <kbd className="kbd">↵</kbd> to run
          </span>
          <span>
            <kbd className="kbd">esc</kbd> to close
          </span>
        </footer>
      </div>
    </div>
  );
}
