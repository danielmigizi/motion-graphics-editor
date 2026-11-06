// The right column's Layers tab: the current scene's element tree
// (canvasTree.ts), front-most on top, each group's layers indented under it
// and collapsible (remembered until the page reloads). A row is the type's
// icon and the name, then lock and eye toggles that show on hover or focus,
// and always while the layer is locked or hidden; each toggle is one undo
// step. Click selects (Shift or ⌘ adds, as on the canvas), double-click or
// Enter renames in place, Space shows or hides, the arrows walk the tree,
// dragging reorders or drops into a group (layerDropCommands), right-click
// opens the layer menu (ContextMenu.tsx). A locked layer lets canvas clicks
// through (Stage.tsx) but still selects here. In a locked scene rows only
// select.

import { useEffect, useState, type CSSProperties, type KeyboardEvent, type MouseEvent } from 'react';
import { create } from 'zustand';
import type { Element, ElementChanges } from '../core/types';
import { ancestorsOf, layerDropCommands, layerRows, type LayerDropZone, type LayerRow } from './canvasTree';
import { openContextMenu } from './ContextMenu';
import { guardLocked, LOCKED_NOTICE, runCommands } from './editActions';
import { CommitText } from './fields';
import { Icon } from './icons';
import { ELEMENT_ICON } from './InspectorColumn';
import { useCurrentScene, useEditor } from './store';

/** Collapsed groups: kept across tab switches and scenes until the page reloads. */
const useCollapsed = create<{ ids: ReadonlySet<string> }>(() => ({ ids: new Set() }));
const setCollapsed = (ids: ReadonlySet<string>) => useCollapsed.setState({ ids });

const rowId = (id: string) => `layer-${id}`;
const rowEl = (id: string) => document.getElementById(rowId(id));
const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
const TREE_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End']);

/**
 * Where a dragged layer lands on a row, from the pointer's height in it (0
 * top, 1 bottom). A group takes drops in its middle; an open group takes its
 * whole lower part, since its top-most layer shows right under it.
 */
export function layerDropZone(y: number, row: { group: boolean; open: boolean }): LayerDropZone {
  if (!row.group) return y < 0.5 ? 'above' : 'below';
  if (y < 0.3) return 'above';
  return row.open || y < 0.7 ? 'into' : 'below';
}

export type LayerKeyAction = { select: string } | { expand: string } | { collapse: string } | null;

/** What an arrow, Home or End does on a row (the tree pattern): walk the rows, open or close a group, step into it or out to its parent. */
export function layerKeyAction(rows: readonly LayerRow[], collapsed: ReadonlySet<string>, id: string, key: string): LayerKeyAction {
  const i = rows.findIndex((r) => r.element.id === id);
  if (i < 0) return rows.length ? { select: rows[0].element.id } : null;
  const row = rows[i];
  const open = row.hasChildren && !collapsed.has(id);
  switch (key) {
    case 'ArrowDown':
      return rows[i + 1] ? { select: rows[i + 1].element.id } : null;
    case 'ArrowUp':
      return rows[i - 1] ? { select: rows[i - 1].element.id } : null;
    case 'Home':
      return { select: rows[0].element.id };
    case 'End':
      return { select: rows[rows.length - 1].element.id };
    case 'ArrowRight':
      return !row.hasChildren ? null : open ? { select: rows[i + 1].element.id } : { expand: id };
    case 'ArrowLeft':
      return open ? { collapse: id } : row.element.parentId ? { select: row.element.parentId } : null;
  }
  return null;
}

/** The collapsed groups minus those holding a selected layer, so a selection made elsewhere shows in the tree; the same set when none hold one. */
export function revealSelected(elements: readonly Element[], collapsed: ReadonlySet<string>, ids: readonly string[]): ReadonlySet<string> {
  if (!collapsed.size) return collapsed;
  const opened = new Set<string>();
  for (const id of ids) {
    const el = elements.find((e) => e.id === id);
    if (el) for (const a of ancestorsOf(elements, el)) if (collapsed.has(a.id)) opened.add(a.id);
  }
  return opened.size ? new Set([...collapsed].filter((id) => !opened.has(id))) : collapsed;
}

export function LayersPanel() {
  const scene = useCurrentScene();
  const selectedIds = useEditor((s) => s.selection.elementIds);
  const primaryId = useEditor((s) => s.selection.elementId);
  const run = useEditor((s) => s.run);
  const collapsed = useCollapsed((s) => s.ids);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; zone: LayerDropZone } | null>(null);

  // A selection made on the canvas, the timeline or by the agent opens the groups around it and scrolls to it.
  useEffect(() => {
    const st = useEditor.getState();
    const els = st.doc.project.scenes.find((s) => s.id === st.selection.sceneId)?.elements ?? [];
    const ids = useCollapsed.getState().ids;
    const next = revealSelected(els, ids, selectedIds);
    if (next !== ids) setCollapsed(next);
    const primary = st.selection.elementId;
    if (!primary) return;
    const raf = requestAnimationFrame(() => rowEl(primary)?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(raf);
  }, [selectedIds]);

  useEffect(() => {
    if (!renaming) return;
    const input = document.getElementById(`layer-rename-${renaming}`) as HTMLInputElement | null;
    input?.focus();
    input?.select();
  }, [renaming]);

  if (!scene) return <div className="empty">No scenes in this project.</div>;
  const elements = scene.elements;
  const readOnly = scene.locked;
  const rows = layerRows(elements, collapsed);
  const selected = new Set(selectedIds);
  const focusId = rows.some((r) => r.element.id === primaryId) ? primaryId : (rows[0]?.element.id ?? null);

  const update = (el: Element, changes: ElementChanges, label: string) => !guardLocked(scene) && run({ type: 'updateElement', sceneId: scene.id, elementId: el.id, changes }, label);
  const toggleVisible = (el: Element) => update(el, { visible: !el.visible }, `${el.visible ? 'Hide' : 'Show'} “${el.name}”`);
  const toggleLocked = (el: Element) => update(el, { locked: !el.locked }, `${el.locked ? 'Unlock' : 'Lock'} “${el.name}”`);
  // A clicked toggle hands the keyboard back to its row, so Space next toggles the row rather than pressing the button again and playing.
  const onToggle = (e: MouseEvent, el: Element, toggle: (el: Element) => void) => {
    e.stopPropagation();
    toggle(el);
    rowEl(el.id)?.focus();
  };
  const toggleCollapsed = (id: string) => {
    const next = new Set(collapsed);
    if (!next.delete(id)) next.add(id);
    setCollapsed(next);
  };
  const startRename = (el: Element) => !guardLocked(scene) && setRenaming(el.id);
  const selectRow = (el: Element, add: boolean) => {
    const st = useEditor.getState();
    if (add) st.toggleElement(scene.id, el.id);
    else st.selectElement(scene.id, el.id);
  };
  // Right-click convention: the row is selected first (unless already in the selection), then the menu acts on the selection.
  const openMenu = (e: MouseEvent | globalThis.MouseEvent, el: Element) => {
    if (!selected.has(el.id)) useEditor.getState().selectElement(scene.id, el.id);
    openContextMenu(e, 'layer');
  };
  const endDrag = () => {
    setDragId(null);
    setDrop(null);
  };
  const commitDrop = () => {
    const dragged = elements.find((x) => x.id === dragId);
    const target = drop && elements.find((x) => x.id === drop.id);
    const cmds = dragged && target && drop ? layerDropCommands(scene.id, elements, dragged.id, target.id, drop.zone) : null;
    if (dragged && target && drop && cmds && !guardLocked(scene)) {
      if (runCommands(cmds, drop.zone === 'into' ? `Move “${dragged.name}” into “${target.name}”` : `Reorder “${dragged.name}”`) && drop.zone === 'into' && collapsed.has(target.id)) toggleCollapsed(target.id);
    }
    endDrag();
  };

  const onRowKey = (e: KeyboardEvent<HTMLLIElement>, el: Element) => {
    // Keys typed while renaming, and chords, belong to someone else.
    if (e.target !== e.currentTarget || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Enter' || e.key === 'F2') startRename(el);
    else if (e.key === ' ') toggleVisible(el);
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const r = e.currentTarget.getBoundingClientRect();
      openMenu(new globalThis.MouseEvent('contextmenu', { clientX: r.left + 32, clientY: r.bottom }), el);
    } else if (TREE_KEYS.has(e.key)) {
      // Swallowed even at the ends of the list, so an arrow never nudges the selection on the canvas instead.
      const act = layerKeyAction(rows, collapsed, el.id, e.key);
      if (act && 'select' in act) {
        const st = useEditor.getState();
        if (e.shiftKey) st.selectMany(scene.id, [...st.selection.elementIds, act.select], act.select);
        else st.selectElement(scene.id, act.select);
        rowEl(act.select)?.focus();
      } else if (act) toggleCollapsed('expand' in act ? act.expand : act.collapse);
    } else return;
    e.preventDefault();
    e.stopPropagation();
  };

  return (
    <div className="layers-panel" data-testid="layers-panel">
      <div className={`layers-scene ${readOnly ? 'is-locked' : ''}`} data-testid="layers-scene" onClick={() => useEditor.getState().select({ elementId: null, elementIds: [] })}>
        <Icon name="frame" size={14} className="layer-icon" />
        <span className="layers-scene-name" title={scene.name}>
          {scene.name}
        </span>
        <span className="layers-count tabular" title={`${elements.length} layers`}>
          {elements.length}
        </span>
        <span className="layer-toggles">
          <button
            type="button"
            className={`icon-btn small layer-toggle ${readOnly ? 'on' : ''}`}
            aria-label={readOnly ? `Unlock scene “${scene.name}”` : `Lock scene “${scene.name}”`}
            aria-pressed={readOnly}
            title={readOnly ? 'Unlock scene' : 'Lock scene'}
            data-testid="layers-scene-lock"
            onClick={(e) => {
              e.stopPropagation();
              run({ type: 'setSceneLock', sceneId: scene.id, locked: !readOnly }, `${readOnly ? 'Unlock' : 'Lock'} “${scene.name}”`);
            }}
          >
            <Icon name={readOnly ? 'lock' : 'unlock'} size={14} />
          </button>
        </span>
      </div>
      {readOnly && (
        <p className="layers-note" data-testid="layers-locked-note">
          <Icon name="lock" size={12} />
          <span>{LOCKED_NOTICE}. You can still select layers here.</span>
        </p>
      )}
      <div className="panel-scroll">
        {rows.length === 0 ? (
          <p className="fine layers-empty">No layers in this scene yet. Add one from the tool rail or the Insert menu.</p>
        ) : (
          <ol className={`layer-tree ${readOnly ? 'read-only' : ''}`} role="tree" aria-label={`Layers of ${scene.name}`} aria-multiselectable onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setDrop(null)}>
            {rows.map((row) => {
              const { element: el, depth, hasChildren } = row;
              const open = hasChildren && !collapsed.has(el.id);
              const isSelected = selected.has(el.id);
              const hiddenAbove = ancestorsOf(elements, el).some((a) => !a.visible);
              const cls = ['layer-item', isSelected && 'selected', (!el.visible || hiddenAbove) && 'is-hidden', dragId === el.id && 'dragging', drop?.id === el.id && `drop-${drop.zone}`].filter(Boolean).join(' ');
              return (
                <li
                  key={el.id}
                  id={rowId(el.id)}
                  role="treeitem"
                  aria-level={depth + 1}
                  aria-selected={isSelected}
                  aria-expanded={hasChildren ? open : undefined}
                  tabIndex={el.id === focusId ? 0 : -1}
                  className={cls}
                  style={{ '--depth': depth } as CSSProperties}
                  data-testid={`layer-row-${el.id}`}
                  draggable={!readOnly && renaming !== el.id}
                  onClick={(e) => selectRow(el, e.shiftKey || e.metaKey || e.ctrlKey)}
                  onDoubleClick={() => startRename(el)}
                  onContextMenu={(e) => openMenu(e, el)}
                  onKeyDown={(e) => onRowKey(e, el)}
                  onDragStart={(e) => {
                    setDragId(el.id);
                    if (!isSelected) useEditor.getState().selectElement(scene.id, el.id);
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', el.name);
                  }}
                  onDragEnd={endDrag}
                  onDragOver={(e) => {
                    if (!dragId) return;
                    const r = e.currentTarget.getBoundingClientRect();
                    const zone = layerDropZone((e.clientY - r.top) / r.height, { group: el.type === 'group', open });
                    if (!layerDropCommands(scene.id, elements, dragId, el.id, zone)) {
                      if (drop) setDrop(null);
                      return;
                    }
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    if (drop?.id !== el.id || drop.zone !== zone) setDrop({ id: el.id, zone });
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    commitDrop();
                  }}
                >
                  {hasChildren ? (
                    <button
                      type="button"
                      tabIndex={-1}
                      className={`layer-caret ${open ? '' : 'collapsed'}`}
                      aria-label={open ? `Collapse “${el.name}”` : `Expand “${el.name}”`}
                      data-testid={`layer-caret-${el.id}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleCollapsed(el.id);
                      }}
                      onDoubleClick={stop}
                    >
                      <Icon name="down" size={12} />
                    </button>
                  ) : (
                    <span className="layer-caret-space" aria-hidden />
                  )}
                  <Icon name={ELEMENT_ICON[el.type]} size={14} className="layer-icon" />
                  {renaming === el.id ? (
                    <span
                      className="layer-name"
                      onClick={stop}
                      onDoubleClick={stop}
                      onBlur={() => setRenaming(null)}
                      onKeyDown={(e) => {
                        // Enter or Escape ends the rename (CommitText); keep the keyboard on the row.
                        if (e.key !== 'Enter' && e.key !== 'Escape') return;
                        e.stopPropagation();
                        rowEl(el.id)?.focus();
                      }}
                    >
                      <CommitText
                        id={`layer-rename-${el.id}`}
                        value={el.name}
                        maxLength={80}
                        testId={`layer-rename-${el.id}`}
                        className="layer-rename"
                        onCommit={(v) => v.trim() && update(el, { name: v.trim() }, `Rename “${el.name}”`)}
                      />
                    </span>
                  ) : (
                    <span className="layer-name" title={el.name}>
                      {el.name}
                    </span>
                  )}
                  <span className="layer-toggles">
                    <button
                      type="button"
                      tabIndex={-1}
                      className={`icon-btn small layer-toggle ${el.locked ? 'on' : ''}`}
                      aria-label={el.locked ? `Unlock “${el.name}”` : `Lock “${el.name}”`}
                      aria-pressed={!!el.locked}
                      title={el.locked ? 'Unlock: clicks on the canvas select it again' : 'Lock: clicks on the canvas pass through it'}
                      disabled={readOnly}
                      data-testid={`layer-lock-${el.id}`}
                      onClick={(e) => onToggle(e, el, toggleLocked)}
                      onDoubleClick={stop}
                    >
                      <Icon name={el.locked ? 'lock' : 'unlock'} size={14} />
                    </button>
                    <button
                      type="button"
                      tabIndex={-1}
                      className={`icon-btn small layer-toggle ${el.visible ? '' : 'on'}`}
                      aria-label={el.visible ? `Hide “${el.name}”` : `Show “${el.name}”`}
                      aria-pressed={!el.visible}
                      title={el.visible ? 'Hide (Space)' : 'Show (Space)'}
                      disabled={readOnly}
                      data-testid={`layer-eye-${el.id}`}
                      onClick={(e) => onToggle(e, el, toggleVisible)}
                      onDoubleClick={stop}
                    >
                      <Icon name={el.visible ? 'eye' : 'eyeOff'} size={14} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}
