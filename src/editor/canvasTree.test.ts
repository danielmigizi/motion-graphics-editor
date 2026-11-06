import { describe, expect, it } from 'vitest';
import { applyCommand } from '../core/commands';
import { element, project } from '../core/__fixtures__/schema2Project';
import type { Element } from '../core/types';
import { canvasSelection, enterTarget, hitTestElements, indexBeside, isCanvasLocked, layerDropCommands, layerRows, pickTarget, scopeOf, siblingStep, topMostSelected } from './canvasTree';
import { hitTestDeep } from './geometry';

// Paint order: a, g (with c1, c2 and nested h › leaf), b.
const tree = (): Element[] => [
  element('a'),
  element('g', 'group', { props: { clip: false } }),
  element('c1', 'shape', { parentId: 'g' }),
  element('h', 'group', { parentId: 'g', props: { clip: false } }),
  element('leaf', 'shape', { parentId: 'h' }),
  element('c2', 'shape', { parentId: 'g' }),
  element('b'),
];
const byId = (els: Element[], id: string) => els.find((e) => e.id === id)!;

describe('canvas gesture selection', () => {
  it('excludes locked elements and descendants of locked groups, without moving children twice', () => {
    const els = tree();
    byId(els, 'a').locked = true;
    byId(els, 'h').locked = true;
    expect(canvasSelection(els, ['a', 'leaf', 'b']).map((e) => e.id)).toEqual(['b']);
    expect(canvasSelection(els, ['g', 'c1', 'b']).map((e) => e.id)).toEqual(['g', 'b']);
  });

  it('a selected locked foreground leaves no gesture selection to intercept the unlocked hit underneath', () => {
    const els = [element('under'), element('over', 'shape', { locked: true })];
    expect(hitTestDeep(hitTestElements(els), 0, { x: 20, y: 30 })?.id).toBe('under');
    expect(canvasSelection(els, ['over'])).toEqual([]);
    expect(canvasSelection(els, ['under', 'over']).map((e) => e.id)).toEqual(['under']);
  });
});

describe('selection scope', () => {
  const els = tree();
  it('a click selects the top-level ancestor, or the child inside the current scope', () => {
    expect(pickTarget(els, byId(els, 'leaf'), null).id).toBe('g');
    expect(pickTarget(els, byId(els, 'leaf'), 'g').id).toBe('h');
    expect(pickTarget(els, byId(els, 'leaf'), 'h').id).toBe('leaf');
    expect(pickTarget(els, byId(els, 'b'), 'g').id).toBe('b'); // outside the scope: top level
  });

  it('double-click goes one level deeper than the selected element', () => {
    expect(enterTarget(els, byId(els, 'leaf'), 'g', null).id).toBe('h');
    expect(enterTarget(els, byId(els, 'leaf'), 'h', 'g').id).toBe('leaf');
    expect(enterTarget(els, byId(els, 'leaf'), null, null).id).toBe('g');
  });

  it('a click passes through a locked element, and through everything inside a locked group', () => {
    const hit = (locked: string[]) => {
      const els = tree().map((e) => (locked.includes(e.id) ? { ...e, locked: true } : e));
      return hitTestDeep(hitTestElements(els), 0, { x: 50, y: 50 })?.id ?? null;
    };
    expect(hit([])).toBe('b');
    expect(hit(['b'])).toBe('c2');
    expect(hit(['b', 'c2'])).toBe('c1'); // leaf, nested deeper, sits lower and right
    expect(hit(['b', 'g'])).toBe('a');
    expect(hit(['a', 'b', 'g'])).toBeNull();
    const els = tree();
    expect(hitTestElements(els)).toBe(els); // nothing locked: the same list
  });

  it('scope is the primary’s parent; descendants of selected groups drop out', () => {
    expect(scopeOf(els, 'c1')).toBe('g');
    expect(scopeOf(els, 'a')).toBeNull();
    expect(scopeOf(els, null)).toBeNull();
    expect(topMostSelected(els, ['leaf', 'g', 'b', 'c1']).map((e) => e.id)).toEqual(['g', 'b']);
  });
});

describe('layers tree', () => {
  it('lists top-most first at every level, indented, honouring collapse', () => {
    const rows = layerRows(tree());
    expect(rows.map((r) => `${'  '.repeat(r.depth)}${r.element.id}${r.hasChildren ? '+' : ''}`)).toEqual(['b', 'g+', '  c2', '  h+', '    leaf', '  c1', 'a']);
    expect(layerRows(tree(), new Set(['g'])).map((r) => r.element.id)).toEqual(['b', 'g', 'a']);
  });

  it('steps between siblings only', () => {
    const els = tree();
    expect(siblingStep(els, byId(els, 'c1'), 1)?.id).toBe('h');
    expect(siblingStep(els, byId(els, 'c2'), 1)).toBeNull();
    expect(siblingStep(els, byId(els, 'g'), -1)?.id).toBe('a');
  });

  it('indexBeside puts an element directly above/below a sibling, whichever side it starts', () => {
    const els = tree();
    const order = (to: number, id: string) => {
      const r = applyCommand(project(els), { type: 'moveElement', sceneId: 's', elementId: id, toIndex: to }, { source: 'user' });
      if (!r.ok) throw new Error(r.error.message);
      return r.project.scenes[0].elements.map((e) => e.id);
    };
    // c1 above c2 (paint after it)
    expect(order(indexBeside(els, byId(els, 'c1'), byId(els, 'c2'), 'above'), 'c1')).toEqual(['a', 'g', 'h', 'leaf', 'c2', 'c1', 'b']);
    // c2 below c1
    expect(order(indexBeside(els, byId(els, 'c2'), byId(els, 'c1'), 'below'), 'c2')).toEqual(['a', 'g', 'c2', 'c1', 'h', 'leaf', 'b']);
  });

  it('drop commands: reorder, re-parent beside, into a group; refuses cycles', () => {
    const els = tree();
    expect(layerDropCommands('s', els, 'b', 'a', 'below')).toEqual([{ type: 'moveElement', sceneId: 's', elementId: 'b', toIndex: 0 }]);
    const into = layerDropCommands('s', els, 'b', 'g', 'into')!;
    expect(into[0]).toEqual({ type: 'setParent', sceneId: 's', elementId: 'b', parentId: 'g', keepWorld: true });
    const r = applyCommand(project(els), { type: 'batch', label: 'drop', commands: into }, { source: 'user' });
    expect(r.ok && r.project.scenes[0].elements.map((e) => `${e.id}${e.parentId ? `<${e.parentId}` : ''}`)).toEqual(['a', 'g', 'c1<g', 'h<g', 'leaf<h', 'c2<g', 'b<g']);
    expect(layerDropCommands('s', els, 'leaf', 'b', 'above')![0]).toEqual({ type: 'setParent', sceneId: 's', elementId: 'leaf', parentId: null, keepWorld: true });
    expect(layerDropCommands('s', els, 'g', 'leaf', 'above')).toBeNull(); // into its own subtree
    expect(layerDropCommands('s', els, 'a', 'b', 'into')).toBeNull(); // not a group
    expect(layerDropCommands('s', els, 'a', 'a', 'above')).toBeNull();
  });
});

describe('isCanvasLocked', () => {
  it('is locked by its own flag or by a locked group around it', () => {
    const el = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: 'shape', name: id, startFrame: 0, durationInFrames: 10, visible: true, transform: { x: 0, y: 0, width: 1, height: 1, rotation: 0, scale: 1, opacity: 1 }, props: {}, tracks: [], ...extra }) as unknown as Element;
    const els = [el('g', { type: 'group', locked: true }), el('a', { parentId: 'g' }), el('b'), el('c', { locked: true })];
    expect(isCanvasLocked(els, els[1])).toBe(true);
    expect(isCanvasLocked(els, els[2])).toBe(false);
    expect(isCanvasLocked(els, els[3])).toBe(true);
  });
});
