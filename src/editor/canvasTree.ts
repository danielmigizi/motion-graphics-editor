// Element hierarchy for the canvas and the layers list. Groups own children
// through Element.parentId; among siblings, paint order follows the flat
// scene.elements list (later = on top). The selection's scope is the primary
// element's parent: clicks select at that level, double-click goes one deeper.

import type { Command, Element } from '../core/types';

export function childrenOf(elements: readonly Element[], parentId: string | null): Element[] {
  return elements.filter((e) => (e.parentId ?? null) === parentId);
}

/** Ancestors, nearest first. */
export function ancestorsOf(elements: readonly Element[], el: Element): Element[] {
  const out: Element[] = [];
  const seen = new Set([el.id]);
  let id = el.parentId;
  while (id && !seen.has(id)) {
    const parent = elements.find((e) => e.id === id);
    if (!parent) break;
    out.push(parent);
    seen.add(id);
    id = parent.parentId;
  }
  return out;
}

export function isDescendantOf(elements: readonly Element[], el: Element, ancestorId: string): boolean {
  return ancestorsOf(elements, el).some((a) => a.id === ancestorId);
}

/** The group a selection lives in: the primary element's parent (null = scene top level). */
export function scopeOf(elements: readonly Element[], primaryId: string | null): string | null {
  return (primaryId && elements.find((e) => e.id === primaryId)?.parentId) || null;
}

/**
 * The elements as the canvas hit-tests them: a locked element counts as
 * hidden, so it and everything inside it let a click through to what is
 * beneath. The layers panel still selects them. Unlocked elements keep their
 * identity, so a hit is always one of `elements`.
 */
export function hitTestElements(elements: Element[]): Element[] {
  return elements.some((e) => e.locked) ? elements.map((e) => (e.locked ? { ...e, visible: false } : e)) : elements;
}

/** Locked itself or inside a locked group: the canvas neither picks nor moves it. */
export function isCanvasLocked(elements: readonly Element[], el: Element): boolean {
  return !!el.locked || ancestorsOf(elements, el).some((a) => a.locked);
}

/** Selected elements minus those whose ancestor is selected too (moving or deleting the ancestor covers them). */
export function topMostSelected(elements: readonly Element[], ids: readonly string[]): Element[] {
  const set = new Set(ids);
  return ids
    .map((id) => elements.find((e) => e.id === id))
    .filter((e): e is Element => !!e && !ancestorsOf(elements, e).some((a) => set.has(a.id)));
}

/** The selection that canvas gestures may change, excluding inherited locks. */
export function canvasSelection(elements: readonly Element[], ids: readonly string[]): Element[] {
  return topMostSelected(elements, ids).filter((el) => !isCanvasLocked(elements, el));
}

/**
 * What a click selects, given the deepest element under the pointer: its
 * ancestor directly inside the current scope when the scope contains it, else
 * its top-level ancestor (so a click on a group's child selects the group).
 */
export function pickTarget(elements: readonly Element[], hit: Element, scopeId: string | null): Element {
  const chain = [hit, ...ancestorsOf(elements, hit)];
  if (scopeId) {
    const i = chain.findIndex((e) => e.id === scopeId);
    if (i > 0) return chain[i - 1];
  }
  return chain[chain.length - 1];
}

/** Double-click: one level deeper than the selected element along the hit's chain (entering the group); otherwise a plain click. */
export function enterTarget(elements: readonly Element[], hit: Element, selectedId: string | null, scopeId: string | null): Element {
  const chain = [hit, ...ancestorsOf(elements, hit)];
  const i = selectedId ? chain.findIndex((e) => e.id === selectedId) : -1;
  return i > 0 ? chain[i - 1] : pickTarget(elements, hit, scopeId);
}

export interface LayerRow {
  element: Element;
  depth: number;
  hasChildren: boolean;
}

/** Layers list rows: top-most first at every level, each group's children indented under it (unless collapsed). */
export function layerRows(elements: readonly Element[], collapsed: ReadonlySet<string> = new Set()): LayerRow[] {
  const rows: LayerRow[] = [];
  const visit = (parentId: string | null, depth: number) => {
    const kids = childrenOf(elements, parentId);
    for (let i = kids.length - 1; i >= 0; i--) {
      const el = kids[i];
      const hasChildren = el.type === 'group' && elements.some((e) => e.parentId === el.id);
      rows.push({ element: el, depth, hasChildren });
      if (hasChildren && !collapsed.has(el.id)) visit(el.id, depth + 1);
    }
  };
  visit(null, 0);
  return rows;
}

/** The sibling just above (+1, painted later) or below (−1) an element, or null at the end of its level. */
export function siblingStep(elements: readonly Element[], el: Element, dir: 1 | -1): Element | null {
  const sibs = childrenOf(elements, el.parentId ?? null);
  return sibs[sibs.indexOf(el) + dir] ?? null;
}

/** moveElement toIndex that puts `el` directly above (painted after) or below (painted before) `target` in the flat list. */
export function indexBeside(elements: readonly Element[], el: Element, target: Element, where: 'above' | 'below'): number {
  const from = elements.indexOf(el);
  const t = elements.indexOf(target);
  if (where === 'above') return from < t ? t : t + 1;
  return from < t ? t - 1 : t;
}

export type LayerDropZone = 'above' | 'below' | 'into';

/**
 * Commands for dropping a dragged layer onto another row: above/below it
 * (re-parenting to the target's parent when that differs, keeping on-screen
 * placement) or into a group (on top of its children). Null when the drop is
 * not allowed (onto itself, into its own subtree, into a non-group).
 */
export function layerDropCommands(sceneId: string, elements: readonly Element[], draggedId: string, targetId: string, zone: LayerDropZone): Command[] | null {
  const dragged = elements.find((e) => e.id === draggedId);
  const target = elements.find((e) => e.id === targetId);
  if (!dragged || !target || dragged.id === target.id || isDescendantOf(elements, target, dragged.id)) return null;
  const parentId = zone === 'into' ? target.id : (target.parentId ?? null);
  if (zone === 'into' && target.type !== 'group') return null;
  const cmds: Command[] = [];
  if ((dragged.parentId ?? null) !== parentId) cmds.push({ type: 'setParent', sceneId, elementId: dragged.id, parentId, keepWorld: true });
  if (zone === 'into') {
    const kids = childrenOf(elements, target.id).filter((e) => e.id !== dragged.id);
    const anchor = kids[kids.length - 1] ?? target;
    cmds.push({ type: 'moveElement', sceneId, elementId: dragged.id, toIndex: indexBeside(elements, dragged, anchor, 'above') });
  } else {
    cmds.push({ type: 'moveElement', sceneId, elementId: dragged.id, toIndex: indexBeside(elements, dragged, target, zone) });
  }
  return cmds;
}
