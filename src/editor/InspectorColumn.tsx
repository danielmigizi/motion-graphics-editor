// The right column's Inspector tab: a head naming what is inspected (the
// selected element, or the current scene when nothing is selected, so the tab
// is never empty) with its kind, an editable name, a search button and, for
// an element, a deselect control; under it, for an element, the Design /
// Animate / Scene tabs (inspectorView.ts); then Inspector.tsx in its own
// scroll. Escape deselects too (App.tsx).
//
// The property search lives in the head row: ⌘F (with focus in the inspector
// or on the stage) or the search button swaps the name for the search field;
// Escape clears and hides it and puts focus back. Elsewhere ⌘F stays the
// browser's find.

import { useEffect, useRef, type KeyboardEvent } from 'react';
import { COMPONENTS } from '../core/components';
import type { ElementType } from '../core/types';
import { shortcutLabel } from './editActions';
import { CommitText } from './fields';
import { Icon, type IconName } from './icons';
import { Inspector } from './Inspector';
import { queryTokens } from './inspectorSearch';
import { findOpensSearch, INSPECTOR_TABS, shownTab, useInspectorView } from './inspectorView';
import { useCurrentScene, useEditor } from './store';

export function closeInspector() {
  const st = useEditor.getState();
  if (st.selection.elementId) st.select({ elementId: null });
  st.setSceneInspectorOpen(false);
}

/** Shared icons for each kind of element. */
export const ELEMENT_ICON: Record<ElementType, IconName> = {
  text: 'text',
  shape: 'shape',
  path: 'spline',
  group: 'group',
  instance: 'component',
  logo: 'star',
  image: 'image',
  uiCard: 'frame',
  chatBubble: 'messageCircle',
  video: 'video',
};

function KindGlyph({ kind }: { kind: ElementType | 'scene' }) {
  return <Icon name={kind === 'scene' ? 'frame' : ELEMENT_ICON[kind]} size={14} />;
}

const FIND = shortcutLabel('F', ['mod']);

export function InspectorColumn() {
  const scene = useCurrentScene();
  const elementId = useEditor((s) => s.selection.elementId);
  const count = useEditor((s) => s.selection.elementIds.length);
  const editMode = useEditor((s) => s.editMode);
  const run = useEditor((s) => s.run);
  const { tab, searching, query, pickTab, followMode, followSelection, openSearch, setQuery, closeSearch } = useInspectorView();
  const element = scene?.elements.find((e) => e.id === elementId) ?? null;
  const name = element ? element.name : (scene?.name ?? 'Scene');
  const crumb = element ? `${COMPONENTS[element.type].label} in ${scene?.name ?? 'scene'}${count > 1 ? ` · ${count} selected` : ''}` : 'Scene settings';
  const shown = shownTab(tab, !!element);
  const filtering = queryTokens(query).length > 0;
  const searchRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** Where focus was when the search opened; Escape puts it back. */
  const returnFocus = useRef<HTMLElement | null>(null);

  // The header's Layout / Animate switch and a new selection move the tab (inspectorView.ts).
  useEffect(() => {
    followMode(editMode);
  }, [editMode, followMode]);
  useEffect(() => {
    followSelection(elementId, useEditor.getState().editMode);
  }, [elementId, followSelection]);
  // Another tab is other content: start it at the top (another element on the same tab keeps the place).
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [shown]);

  const showSearch = () => {
    const active = document.activeElement;
    if (!useInspectorView.getState().searching) returnFocus.current = active instanceof HTMLElement && active !== document.body ? active : null;
    openSearch();
    // Already open: take focus back to it and select the query.
    searchRef.current?.focus();
    searchRef.current?.select();
  };
  const hideSearch = () => {
    closeSearch();
    const back = returnFocus.current;
    returnFocus.current = null;
    if (back?.isConnected) back.focus();
    else document.getElementById('inspector-body')?.focus();
  };

  // ⌘F: the property search when focus is here or on the stage; the browser's find anywhere else.
  const showSearchRef = useRef(showSearch);
  showSearchRef.current = showSearch;
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || !(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'f') return;
      if (!findOpensSearch(e.target as Element | null, !!document.querySelector('[role="dialog"], [role="alertdialog"]'))) return;
      e.preventDefault();
      showSearchRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const rename = (v: string) => {
    const next = v.trim();
    if (!scene || !next) return;
    if (element) run({ type: 'updateElement', sceneId: scene.id, elementId: element.id, changes: { name: next } }, 'Rename element');
    else run({ type: 'updateScene', sceneId: scene.id, changes: { name: next } }, 'Rename scene');
  };

  // Arrows, Home and End move along the tabs and choose them (the tablist pattern).
  const onTabKey = (e: KeyboardEvent) => {
    const i = INSPECTOR_TABS.findIndex((t) => t.id === shown);
    const n = INSPECTOR_TABS.length;
    const next = ({ ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 } as Record<string, number>)[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    pickTab(INSPECTOR_TABS[next].id);
    document.getElementById(`inspector-tab-${INSPECTOR_TABS[next].id}`)?.focus();
  };

  return (
    <div className="inspector-pane" data-testid="inspector-column">
      <div className={`inspector-head${searching ? ' is-searching' : ''}`}>
        <span className="inspector-kind" title={element ? COMPONENTS[element.type].label : 'Scene'}>
          <KindGlyph kind={element ? element.type : 'scene'} />
        </span>
        {/* While searching the name is out of sight but still focusable: Rename (actions.ts) focuses it, which closes the search. */}
        <div className="inspector-title" onFocus={searching ? closeSearch : undefined}>
          <CommitText
            key={element?.id ?? scene?.id ?? ''}
            className="inspector-name"
            testId="inspector-name"
            value={name}
            maxLength={80}
            tabIndex={searching ? -1 : undefined}
            disabled={!scene || scene.locked}
            onCommit={rename}
          />
          <span className="inspector-crumb">{crumb}</span>
        </div>
        {searching && (
          <label className="insp-search">
            <Icon name="search" size={14} />
            <input
              ref={searchRef}
              type="search"
              className="input"
              placeholder="Find a property"
              aria-label="Find a property"
              autoFocus
              value={query}
              data-testid="inspector-filter"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== 'Escape') return;
                e.preventDefault();
                hideSearch();
              }}
            />
          </label>
        )}
        <div className="inspector-tools">
          {searching ? (
            <button type="button" className="icon-btn small" aria-label="Close search" title="Close search (Esc)" data-testid="inspector-search-close" onClick={hideSearch}>
              <Icon name="close" size={12} />
            </button>
          ) : (
            <>
              <button type="button" className="icon-btn small" aria-label="Find a property" title={`Find a property (${FIND})`} data-testid="inspector-search" onClick={showSearch}>
                <Icon name="search" size={14} />
              </button>
              {element && (
                <button type="button" className="icon-btn small" aria-label="Deselect" title="Deselect (Esc)" data-testid="inspector-close" onClick={closeInspector}>
                  <Icon name="close" size={12} />
                </button>
              )}
            </>
          )}
        </div>
      </div>
      {/* A query searches Design and Animate together (Inspector.tsx), so the tabs step aside while it has words. */}
      {element && !filtering && (
        <div className="insp-tabs" role="tablist" aria-label="Inspector" data-testid="inspector-tabs" onKeyDown={onTabKey}>
          {INSPECTOR_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              role="tab"
              id={`inspector-tab-${t.id}`}
              className="insp-tab"
              aria-selected={t.id === shown}
              aria-controls="inspector-body"
              tabIndex={t.id === shown ? 0 : -1}
              data-testid={`inspector-tab-${t.id}`}
              onClick={() => pickTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
      )}
      <div className="panel-scroll" ref={scrollRef}>
        <Inspector tab={shown} query={query} />
      </div>
    </div>
  );
}
