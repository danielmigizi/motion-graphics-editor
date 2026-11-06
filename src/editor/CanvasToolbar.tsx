// Canvas controls in the transport row (Transport.tsx), right of the
// playback: only while something is selected, align, distribute and group
// (inline when the row has room, otherwise behind one Arrange button), or the
// node-editing actions while a path's nodes are edited; and the zoom
// controls. The tools themselves (Select, Hand, Pen) are on the rail
// (ToolRail.tsx).

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ALIGN_LABELS, type AlignMode, type DistributeAxis } from './arrange';
import { fitView, zoomBy, zoomTo } from './canvasControls';
import { zoomLabel } from './canvasView';
import { arrangeSelected, DISTRIBUTE_LABELS, groupSelected, ungroupSelected } from './editActions';
import { Icon, type IconName } from './icons';
import { enterPathEdit, exitPathEdit, fitPathBox } from './PathEditor';
import { useCurrentScene, useEditor } from './store';

const TOOL_ICON: Record<AlignMode | DistributeAxis | 'group' | 'ungroup' | 'nodes' | 'fitPath', IconName> = {
  left: 'alignStartV',
  centre: 'alignCenterV',
  right: 'alignEndV',
  top: 'alignStartH',
  middle: 'alignCenterH',
  bottom: 'alignEndH',
  horizontal: 'distributeH',
  vertical: 'distributeV',
  group: 'group',
  ungroup: 'ungroup',
  nodes: 'waypoints',
  fitPath: 'fit',
};

const ALIGN: AlignMode[] = ['left', 'centre', 'right', 'top', 'middle', 'bottom'];
const DISTRIBUTE: DistributeAxis[] = ['horizontal', 'vertical'];

/** Arrange (one or more elements selected) or node editing (a path's nodes), then a rule; nothing otherwise. `roomy`: arrange inline rather than behind a menu. */
export function CanvasToolbar({ roomy = true }: { roomy?: boolean }) {
  const scene = useCurrentScene();
  const ids = useEditor((s) => s.selection.elementIds);
  const current = useEditor((s) => s.tool);
  const editingNodes = useEditor((s) => !!s.pathEdit);
  const n = ids.length;
  const hasGroup = !!scene && scene.elements.some((e) => e.type === 'group' && ids.includes(e.id));
  const onePath = !!scene && n === 1 && scene.elements.find((e) => e.id === ids[0])?.type === 'path';
  const locked = !!scene?.locked;
  const tool = (key: string, title: string, glyph: keyof typeof TOOL_ICON, onClick: () => unknown, disabled = false) => (
    <button key={key} className="icon-btn small" title={title} aria-label={title} data-testid={`canvas-${key}`} disabled={disabled || locked} onClick={() => onClick()}>
      <Icon name={TOOL_ICON[glyph]} />
    </button>
  );
  const align = () => ALIGN.map((m) => tool(`align-${m}`, n === 1 ? `${ALIGN_LABELS[m]} to the canvas` : ALIGN_LABELS[m], m, () => arrangeSelected({ align: m })));
  const distribute = () => DISTRIBUTE.map((a) => tool(`distribute-${a}`, n < 3 ? `${DISTRIBUTE_LABELS[a]} (select 3 or more)` : DISTRIBUTE_LABELS[a], a, () => arrangeSelected({ distribute: a }), n < 3));
  const grouping = () => (
    <>
      {tool('group', 'Group selection (⌘G)', 'group', groupSelected)}
      {tool('ungroup', 'Ungroup (⇧⌘G)', 'ungroup', ungroupSelected, !hasGroup)}
    </>
  );
  const arranging = !!scene && n > 0 && current === 'select';
  if (!editingNodes && !arranging) return null;
  return (
    <>
      <div className="canvas-toolbar" role="toolbar" aria-label={editingNodes ? 'Path nodes' : 'Arrange'} data-testid="canvas-toolbar" onPointerDown={(e) => e.stopPropagation()}>
        {editingNodes ? (
          <>
            {tool('fit-path', 'Fit box to path (keeps the path in place)', 'fitPath', fitPathBox)}
            <button className="btn small canvas-tb-text" title="Stop editing nodes (Enter or Esc)" data-testid="canvas-path-done" onClick={exitPathEdit}>
              Done
            </button>
          </>
        ) : (
          <>
            {onePath && (
              <>
                {tool('edit-nodes', 'Edit nodes (Enter or double-click)', 'nodes', enterPathEdit)}
                <span className="canvas-tb-sep" aria-hidden />
              </>
            )}
            {roomy ? (
              <>
                {align()}
                <span className="canvas-tb-sep" aria-hidden />
                {distribute()}
                <span className="canvas-tb-sep" aria-hidden />
                {grouping()}
              </>
            ) : (
              <ArrangeMenu>
                <div className="arrange-row" role="group" aria-label="Align">
                  {align()}
                </div>
                <div className="arrange-row" role="group" aria-label="Distribute and group">
                  {distribute()}
                  <span className="canvas-tb-sep" aria-hidden />
                  {grouping()}
                </div>
              </ArrangeMenu>
            )}
          </>
        )}
      </div>
      <span className="transport-rule" aria-hidden />
    </>
  );
}

/** One button that opens the arrange tools above the row; stays open while you align, closes on a click elsewhere or Esc. */
function ArrangeMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);
  return (
    <div className="arrange" ref={ref}>
      <button className={`icon-btn small arrange-trigger ${open ? 'on' : ''}`} title="Arrange: align, distribute, group" aria-label="Arrange" aria-haspopup="true" aria-expanded={open} data-testid="canvas-arrange" onClick={() => setOpen(!open)}>
        <Icon name="alignCenterV" />
        <Icon name={open ? 'down' : 'up'} size={10} />
      </button>
      {open && (
        <div className="arrange-pop" role="group" aria-label="Arrange">
          {children}
        </div>
      )}
    </div>
  );
}

/** Zoom out / current zoom (click: 100%) / zoom in / fit. */
export function ZoomControls({ scale }: { scale: number }) {
  const fitted = useEditor((s) => s.view.zoom === 'fit');
  return (
    <div className="canvas-zoom" data-testid="canvas-zoom" onPointerDown={(e) => e.stopPropagation()}>
      <button className="icon-btn small" title="Zoom out (⌘−)" aria-label="Zoom out" data-testid="zoom-out" onClick={() => zoomBy(-1)}>
        <Icon name="minus" />
      </button>
      <button className="canvas-zoom-value" title="Zoom to 100% (⇧0)" data-testid="zoom-value" onClick={() => zoomTo(1)}>
        {zoomLabel(scale)}
      </button>
      <button className="icon-btn small" title="Zoom in (⌘=)" aria-label="Zoom in" data-testid="zoom-in" onClick={() => zoomBy(1)}>
        <Icon name="plus" />
      </button>
      <button className={`canvas-zoom-fit ${fitted ? 'on' : ''}`} title="Zoom to fit (⇧1)" aria-pressed={fitted} data-testid="zoom-fit" onClick={fitView}>
        Fit
      </button>
    </div>
  );
}
