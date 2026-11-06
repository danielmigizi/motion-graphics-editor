// The right column: a tab bar (Inspector, Layers, Assets, History, Generate;
// ⌥1–⌥5 in actions.ts) ending in a control that hides the column, then the
// chosen tab's panel in its own scroll. The tab is layout.ts state, remembered
// per browser. Selecting an element switches to the Inspector unless Layers is
// showing, where the selection shows in the tree, or Generate, where it can be
// the image to edit. Generate widens the column (styles.css, .right-column.wide)
// and its tab is a mark until chosen, so five tabs fit the narrow column.
// Media dragged onto a tab and held there opens it, so an asset can go from
// Assets to the Generate composer in one drag. The shell (App.tsx) places the
// column and decides when it shows; only the chosen tab is mounted. The larger
// view of a hovered thumbnail (Peek.tsx) is drawn from here.

import { useEffect, useRef, type ComponentType, type KeyboardEvent } from 'react';
import { carriesMedia } from './assetDrag';
import { AssetsPanel } from './AssetsPanel';
import { shortcutLabel } from './editActions';
import { GenerateTab } from './GenerateTab';
import { HistoryPanel } from './HistoryPanel';
import { Icon } from './icons';
import { InspectorColumn } from './InspectorColumn';
import { LayersPanel } from './LayersPanel';
import { PeekHost } from './Peek';
import { RIGHT_TABS, useLayout, type RightTab } from './layout';
import { useEditor } from './store';

const PANELS: Record<RightTab, ComponentType> = {
  inspector: InspectorColumn,
  layers: LayersPanel,
  assets: AssetsPanel,
  history: HistoryPanel,
  generate: GenerateTab,
};

/** Tabs that keep the column when the selection changes. */
const KEEPS_SELECTION: RightTab[] = ['inspector', 'layers', 'generate'];

/** A new selection (canvas, timeline, agent) shows in the Inspector, unless the column is on Layers or Generate, or hidden. */
function useInspectOnSelect() {
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        const id = s.selection.elementId;
        if (!id || id === prev.selection.elementId) return;
        const { rightOpen, rightTab, setRightTab } = useLayout.getState();
        if (rightOpen && !KEEPS_SELECTION.includes(rightTab)) setRightTab('inspector');
      }),
    [],
  );
}

/** How long dragged media rests on a tab before it opens. */
const SPRING_MS = 450;

export function RightColumn() {
  const tab = useLayout((s) => s.rightTab);
  const setTab = useLayout((s) => s.setRightTab);
  const setOpen = useLayout((s) => s.setRightOpen);
  useInspectOnSelect();
  const Panel = PANELS[tab];
  const spring = useRef<{ id: RightTab; timer: ReturnType<typeof setTimeout> } | null>(null);
  const cancelSpring = () => {
    if (spring.current) clearTimeout(spring.current.timer);
    spring.current = null;
  };
  useEffect(() => cancelSpring, []);

  // Arrows, Home and End move along the tabs and choose them (the tablist pattern); other keys go on to the editor.
  const onTabKey = (e: KeyboardEvent) => {
    const i = RIGHT_TABS.findIndex((t) => t.id === tab);
    const n = RIGHT_TABS.length;
    const next = ({ ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 } as Record<string, number>)[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    setTab(RIGHT_TABS[next].id);
    document.getElementById(`right-tab-${RIGHT_TABS[next].id}`)?.focus();
  };

  return (
    <aside className={`stage-inspector right-column${tab === 'generate' ? ' wide' : ''}`} aria-label="Inspector, layers, assets, history and generate" data-testid="right-column">
      <div className="right-tabs">
        <div className="right-tablist" role="tablist" aria-label="Panels" onKeyDown={onTabKey}>
          {RIGHT_TABS.map((t, i) => {
            // Generate is a sparkle until chosen; chosen, the column is wide enough for its name.
            const mark = t.id === 'generate';
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                id={`right-tab-${t.id}`}
                className={`right-tab${mark ? ' mark' : ''}`}
                aria-selected={t.id === tab}
                aria-controls="right-panel"
                aria-label={mark ? t.label : undefined}
                tabIndex={t.id === tab ? 0 : -1}
                title={`${t.label} (${shortcutLabel(String(i + 1), ['alt'])})`}
                data-testid={`right-tab-${t.id}`}
                onClick={() => setTab(t.id)}
                onDragEnter={(e) => {
                  if (!carriesMedia(e.dataTransfer) || t.id === tab || spring.current?.id === t.id) return;
                  cancelSpring();
                  const timer = setTimeout(() => {
                    spring.current = null;
                    setTab(t.id);
                  }, SPRING_MS);
                  spring.current = { id: t.id, timer };
                }}
                onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && cancelSpring()}
                onDrop={cancelSpring}
              >
                {mark && <Icon name="sparkles" size={14} />}
                {(!mark || t.id === tab) && t.label}
              </button>
            );
          })}
        </div>
        <button type="button" className="icon-btn small" aria-label="Hide panel" title="Hide panel" data-testid="right-hide" onClick={() => setOpen(false)}>
          <Icon name="panelRight" size={14} />
        </button>
      </div>
      <div className="right-panel" role="tabpanel" id="right-panel" aria-labelledby={`right-tab-${tab}`} data-testid={`right-panel-${tab}`}>
        <Panel />
      </div>
      <PeekHost />
    </aside>
  );
}
