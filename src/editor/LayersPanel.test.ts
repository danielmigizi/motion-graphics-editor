import { describe, expect, it } from 'vitest';
import { element } from '../core/__fixtures__/schema2Project';
import type { Element } from '../core/types';
import { layerRows } from './canvasTree';
import { layerDropZone, layerKeyAction, revealSelected } from './LayersPanel';

// Paint order: a, g (with c1 and nested h › leaf), b. Rows: b, g, h, leaf, c1, a.
const tree = (): Element[] => [
  element('a'),
  element('g', 'group', { props: { clip: false } }),
  element('c1', 'shape', { parentId: 'g' }),
  element('h', 'group', { parentId: 'g', props: { clip: false } }),
  element('leaf', 'shape', { parentId: 'h' }),
  element('b'),
];

describe('layers panel: drop zones', () => {
  it('splits a layer in half, a closed group in thirds, and gives an open group its whole lower part', () => {
    const layer = { group: false, open: false };
    expect([0.1, 0.49, 0.51, 0.9].map((y) => layerDropZone(y, layer))).toEqual(['above', 'above', 'below', 'below']);
    const closed = { group: true, open: false };
    expect([0.1, 0.5, 0.9].map((y) => layerDropZone(y, closed))).toEqual(['above', 'into', 'below']);
    const open = { group: true, open: true };
    expect([0.1, 0.5, 0.9].map((y) => layerDropZone(y, open))).toEqual(['above', 'into', 'into']);
  });
});

describe('layers panel: keys', () => {
  const els = tree();
  const none = new Set<string>();
  const rows = layerRows(els, none);
  const key = (id: string, k: string, collapsed: ReadonlySet<string> = none) => layerKeyAction(layerRows(els, collapsed), collapsed, id, k);

  it('walks the visible rows, stopping at the ends', () => {
    expect(rows.map((r) => r.element.id)).toEqual(['b', 'g', 'h', 'leaf', 'c1', 'a']);
    expect(key('g', 'ArrowDown')).toEqual({ select: 'h' });
    expect(key('h', 'ArrowUp')).toEqual({ select: 'g' });
    expect(key('a', 'ArrowDown')).toBeNull();
    expect(key('b', 'ArrowUp')).toBeNull();
    expect(key('leaf', 'Home')).toEqual({ select: 'b' });
    expect(key('b', 'End')).toEqual({ select: 'a' });
    expect(key('g', 'ArrowDown', new Set(['g']))).toEqual({ select: 'a' }); // a closed group's layers are skipped
  });

  it('right opens a closed group, then steps into it; left closes an open group, then steps out to the parent', () => {
    expect(key('g', 'ArrowRight', new Set(['g']))).toEqual({ expand: 'g' });
    expect(key('g', 'ArrowRight')).toEqual({ select: 'h' });
    expect(key('g', 'ArrowLeft')).toEqual({ collapse: 'g' });
    expect(key('leaf', 'ArrowLeft')).toEqual({ select: 'h' });
    expect(key('g', 'ArrowLeft', new Set(['g']))).toBeNull(); // closed, top level: nowhere to go
    expect(key('c1', 'ArrowRight')).toBeNull(); // not a group
  });

  it('starts at the first row when the focused layer is gone', () => {
    expect(layerKeyAction(rows, none, 'gone', 'ArrowDown')).toEqual({ select: 'b' });
    expect(layerKeyAction([], none, 'gone', 'ArrowDown')).toBeNull();
  });
});

describe('layers panel: revealing the selection', () => {
  const els = tree();
  it('opens the collapsed groups around a selected layer and leaves the others', () => {
    expect([...revealSelected(els, new Set(['g', 'h']), ['leaf'])]).toEqual([]);
    expect([...revealSelected(els, new Set(['g', 'h']), ['c1'])]).toEqual(['h']);
  });

  it('returns the same set when nothing needs opening', () => {
    const collapsed = new Set(['h']);
    expect(revealSelected(els, collapsed, ['a', 'c1'])).toBe(collapsed);
    const empty = new Set<string>();
    expect(revealSelected(els, empty, ['leaf'])).toBe(empty);
  });
});
