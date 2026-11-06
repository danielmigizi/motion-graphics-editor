// Canvas editing at the store level: every multi-element gesture is one undo
// step, keyboard paths (group / ungroup / select all / Tab / Enter / zoom /
// hand tool) and lock handling.

import { beforeEach, describe, expect, it } from 'vitest';
import { createDocState } from '../core/history';
import { element, project } from '../core/__fixtures__/schema2Project';
import type { Element } from '../core/types';
import { canvasKeyDown, canvasKeyUp, registerStage, setPointerOverStage } from './canvasControls';
import { canvasSelection } from './canvasTree';
import { viewTransform } from './canvasView';
import { arrangeSelected, commitEdits, deleteSelected, editCommands, editContext, keyAtPlayhead, localOf, nudgeSelected, offsetEdits, previewEdit, scaleSelectionEdits, selectParent, shortcutLabel } from './editActions';
import { parentInverse, worldCentre, worldOf } from './geometry';
import { useEditor } from './store';

const T = (x: number, y: number, width: number, height: number, rotation = 0) => ({ x, y, width, height, rotation, scale: 1, opacity: 1 });

const elements = (): Element[] => [
  element('a', 'shape', { transform: T(100, 100, 100, 100) }),
  element('b', 'shape', { transform: T(400, 300, 50, 50) }),
  element('c', 'shape', { transform: T(700, 200, 80, 40) }),
  element('g', 'group', { props: { clip: false }, transform: T(200, 300, 200, 200, 90) }),
  element('kid', 'shape', { parentId: 'g', transform: T(10, 20, 50, 50) }),
];

const st = () => useEditor.getState();
const scene = () => st().doc.project.scenes[0];
const el = (id: string) => scene().elements.find((e) => e.id === id)!;
const key = (k: string, mods: { meta?: boolean; shift?: boolean; code?: string; target?: unknown } = {}) =>
  ({ key: k, code: mods.code ?? '', metaKey: !!mods.meta, ctrlKey: false, shiftKey: !!mods.shift, altKey: false, repeat: false, target: mods.target ?? null, preventDefault() {} }) as unknown as KeyboardEvent;

beforeEach(() => {
  st().loadDocument(createDocState(project(elements())), { kind: 'sample' });
  useEditor.setState({ editMode: 'layout', toasts: [] });
});

describe('multi-element gestures are one undo step', () => {
  it('a multi-move commits one batch; undo restores every element', () => {
    st().selectMany('s', ['a', 'b', 'c']);
    const before = st().doc.undoStack.length;
    const ctx = editContext()!;
    const edits = offsetEdits(ctx.scene.elements, ctx.frameInScene, ['a', 'b', 'c'].map((id) => ({ element: el(id), dx: 15, dy: -5 })), false, true);
    expect(commitEdits(ctx.scene, edits, 'Move 3 elements')).toBe(true);
    expect(st().doc.undoStack.length).toBe(before + 1);
    expect(st().doc.undoStack.at(-1)!.label).toBe('Move 3 elements');
    expect(['a', 'b', 'c'].map((id) => [el(id).transform.x, el(id).transform.y])).toEqual([[115, 95], [415, 295], [715, 195]]);
    st().undo();
    expect(['a', 'b', 'c'].map((id) => [el(id).transform.x, el(id).transform.y])).toEqual([[100, 100], [400, 300], [700, 200]]);
  });

  it('animate mode keys x/y at the playhead for each element instead of moving the base', () => {
    useEditor.setState({ editMode: 'animate' });
    st().seek(10);
    st().selectMany('s', ['a', 'b']);
    nudgeSelected(5, 0);
    expect(st().doc.undoStack.at(-1)!.label).toBe('Nudge 2 elements');
    for (const id of ['a', 'b']) {
      expect(el(id).transform.x).toBe(elements().find((e) => e.id === id)!.transform.x);
      expect(el(id).tracks).toEqual([{ property: 'x', keyframes: [{ frame: 10, value: 5, easing: 'easeInOut' }] }]);
    }
  });

  it('nudging a child of a rotated group moves it the way the arrow points on screen', () => {
    st().selectElement('s', 'kid');
    nudgeSelected(10, 0);
    // The group is turned 90°: screen-right is the group's local −y.
    expect(el('kid').transform).toMatchObject({ x: 10, y: 10 });
  });

  it('nudge and delete skip descendants of selected groups; delete is one batch', () => {
    st().selectMany('s', ['g', 'kid', 'a']);
    nudgeSelected(0, 3);
    expect(el('kid').transform.y).toBe(20); // moved with its group, not twice
    expect(el('g').transform.y).toBe(303);
    const before = st().doc.undoStack.length;
    expect(deleteSelected()).toBe(true);
    expect(scene().elements.map((e) => e.id)).toEqual(['b', 'c']);
    expect(st().doc.undoStack.length).toBe(before + 1);
    expect(st().selection.elementIds).toEqual([]);
  });

  it('align and distribute commit one step each', () => {
    st().selectMany('s', ['a', 'b', 'c']);
    expect(arrangeSelected({ align: 'top' })).toBe(true);
    expect(['a', 'b', 'c'].map((id) => el(id).transform.y)).toEqual([100, 100, 100]);
    expect(arrangeSelected({ distribute: 'horizontal' })).toBe(true);
    // a 100..200, c 700..780 stay; widths 230, span 680 → gap 225: b at 425
    expect(el('b').transform.x).toBe(425);
    expect(st().doc.undoStack.slice(-2).map((u) => u.label)).toEqual(['Align top edges', 'Distribute horizontal spacing']);
    // Already aligned: nothing to commit.
    expect(arrangeSelected({ align: 'top' })).toBe(false);
  });

  it('rotation edits: base in layout mode, a rotation key in animate mode', () => {
    const a = el('a');
    expect(previewEdit({ element: a, localFrame: 0, base: { rotation: 30 } }).transform.rotation).toBe(30);
    expect(editCommands('s', [{ element: a, localFrame: 12, keys: { rotation: 45 } }])).toEqual([{ type: 'setKeyframe', sceneId: 's', elementId: 'a', property: 'rotation', frame: 12, value: 45 }]);
    // Unchanged base values produce no command.
    expect(editCommands('s', [{ element: a, localFrame: 0, base: { rotation: 0, x: 100 } }])).toEqual([]);
  });

  it('a locked scene refuses canvas edits with a notice', () => {
    st().run({ type: 'setSceneLock', sceneId: 's', locked: true }, 'Lock');
    st().selectMany('s', ['a', 'b']);
    const rev = st().doc.project.revision;
    nudgeSelected(5, 5);
    expect(deleteSelected()).toBe(false);
    expect(st().doc.project.revision).toBe(rev);
    expect(st().toasts.at(-1)!.message).toMatch(/locked/);
  });
});

describe('keyboard paths', () => {
  it('⌘G groups the selection and selects the group; ⇧⌘G ungroups and selects the children', () => {
    st().selectMany('s', ['a', 'b']);
    const before = st().doc.undoStack.length;
    expect(canvasKeyDown(key('g', { meta: true }))).toBe(true);
    const group = el(st().selection.elementId!);
    expect(group).toMatchObject({ type: 'group', name: 'Group' });
    expect(['a', 'b'].map((id) => el(id).parentId)).toEqual([group.id, group.id]);
    expect(st().doc.undoStack.length).toBe(before + 1);
    expect(canvasKeyDown(key('g', { meta: true, shift: true }))).toBe(true);
    expect(scene().elements.some((e) => e.id === group.id)).toBe(false);
    expect(st().selection.elementIds.sort()).toEqual(['a', 'b']);
    expect(el('a').transform).toMatchObject({ x: 100, y: 100 });
  });

  it('⌘G refuses elements from different levels', () => {
    st().selectMany('s', ['a', 'kid']);
    canvasKeyDown(key('g', { meta: true }));
    expect(scene().elements.length).toBe(5);
    expect(st().toasts.at(-1)!.message).toMatch(/same level/);
  });

  it('⌘A selects every element at the selection’s level', () => {
    canvasKeyDown(key('a', { meta: true }));
    expect(st().selection.elementIds).toEqual(['a', 'b', 'c', 'g']);
    st().selectElement('s', 'kid');
    canvasKeyDown(key('a', { meta: true }));
    expect(st().selection.elementIds).toEqual(['kid']);
  });

  it('Enter starts at the first element; Tab cycles in paint order; Enter enters a group; Esc goes back up', () => {
    expect(canvasKeyDown(key('Tab'))).toBe(false); // nothing selected: Tab moves focus as usual
    canvasKeyDown(key('Enter'));
    expect(st().selection.elementId).toBe('a');
    canvasKeyDown(key('Tab', { shift: true }));
    expect(st().selection.elementId).toBe('g');
    canvasKeyDown(key('Tab'));
    expect(st().selection.elementId).toBe('a');
    st().selectElement('s', 'g');
    expect(canvasKeyDown(key('Enter'))).toBe(true);
    expect(st().selection.elementIds).toEqual(['kid']);
    expect(selectParent()).toBe(true);
    expect(st().selection.elementIds).toEqual(['g']);
    expect(selectParent()).toBe(false);
  });

  it('zoom keys: ⌘= zooms in, ⇧1 fits, ⌘0 is 100%', () => {
    registerStage({ width: 1032, height: 572 });
    const comp = { width: 1000, height: 600 };
    const fit = viewTransform(st().view, { width: 1032, height: 572 }, comp).scale;
    expect(canvasKeyDown(key('=', { meta: true }))).toBe(true);
    expect(st().view.zoom).toBeGreaterThan(fit);
    expect(canvasKeyDown(key('!', { shift: true, code: 'Digit1' }))).toBe(true);
    expect(st().view.zoom).toBe('fit');
    expect(canvasKeyDown(key('0', { meta: true }))).toBe(true);
    expect(st().view.zoom).toBe(1);
  });

  it('tooltips write shortcuts the platform’s way', () => {
    expect(shortcutLabel('T', ['shift', 'alt'], true)).toBe('⌥⇧T');
    expect(shortcutLabel('Z', ['shift', 'mod'], true)).toBe('⇧⌘Z');
    expect(shortcutLabel('T', ['shift', 'alt'], false)).toBe('Alt+Shift+T');
    expect(shortcutLabel('Z', ['shift', 'mod'], false)).toBe('Ctrl+Shift+Z');
    expect(shortcutLabel('M', [], false)).toBe('M');
  });

  it('Space over the stage holds the hand tool until released', () => {
    expect(canvasKeyDown(key(' '))).toBe(false); // not over the stage: playback key as before
    setPointerOverStage(true);
    expect(canvasKeyDown(key(' '))).toBe(true);
    expect(st().handTool).toBe(true);
    expect(canvasKeyUp(key(' '))).toBe(true);
    expect(st().handTool).toBe(false);
    setPointerOverStage(false);
  });
});

describe('local frames of grouped children', () => {
  // Outer group starts at 20, inner group at +10, the leaf at +5: at scene frame 50 the leaf is on its frame 15.
  const nested = (): Element[] => [
    element('outer', 'group', { props: { clip: false }, startFrame: 20, durationInFrames: 80 }),
    element('inner', 'group', { props: { clip: false }, parentId: 'outer', startFrame: 10, durationInFrames: 60 }),
    element('leaf', 'shape', { parentId: 'inner', startFrame: 5, durationInFrames: 40 }),
  ];

  beforeEach(() => {
    st().loadDocument(createDocState(project(nested())), { kind: 'sample' });
    useEditor.setState({ editMode: 'animate', toasts: [] });
    st().seek(50);
    st().selectElement('s', 'leaf');
  });

  it('subtracts every ancestor start (scene frame − ancestor starts − own start)', () => {
    expect(editContext()!.localFrame).toBe(50 - 20 - 10 - 5);
  });

  it('keys from the inspector and from the stage land on that frame', () => {
    expect(keyAtPlayhead('opacity')).toBe(true);
    nudgeSelected(4, 0);
    expect(el('leaf').tracks.map((t) => [t.property, t.keyframes.map((k) => k.frame)])).toEqual([
      ['opacity', [15]],
      ['x', [15]],
    ]);
  });
});


describe('selection scale scales elements, not boxes', () => {
  // Selection bounds (100,100)–(800,400); dragging the bottom-right handle to double it anchors at (100,100).
  const scaled = (): Element[] => [
    element('title', 'text', { transform: T(100, 100, 400, 100) }),
    element('swoosh', 'path', { transform: T(600, 300, 200, 100) }),
    element('g', 'group', { props: { clip: false }, transform: T(500, 100, 100, 100, 90) }),
    element('kid', 'shape', { parentId: 'g', transform: T(10, 20, 40, 40) }),
  ];
  const itemOf = (all: Element[], e: Element) => ({ element: e, ev: localOf(all, e, 0), world: worldOf(all, e, 0), inv: parentInverse(all, e, 0) });

  beforeEach(() => {
    st().loadDocument(createDocState(project(scaled())), { kind: 'sample' });
    useEditor.setState({ editMode: 'layout', toasts: [] });
  });

  it('text and path keep their box, double their scale and move their centre about the anchor', () => {
    const all = scene().elements;
    const edits = scaleSelectionEdits(['title', 'swoosh'].map((id) => itemOf(all, el(id))), { x: 100, y: 100 }, 2);
    // title centre (300,150) → (500,200); swoosh centre (700,350) → (1300,600).
    expect(edits.map((e) => e.base)).toEqual([
      { scale: 2, x: 300, y: 150 },
      { scale: 2, x: 1200, y: 550 },
    ]);
    expect(commitEdits(scene(), edits, 'Scale 2 elements')).toBe(true);
    expect(st().doc.undoStack.at(-1)!.label).toBe('Scale 2 elements');
    for (const [id, w, h, cx, cy] of [['title', 400, 100, 500, 200], ['swoosh', 200, 100, 1300, 600]] as const) {
      const after = el(id);
      expect([after.transform.width, after.transform.height, after.transform.scale]).toEqual([w, h, 2]);
      expect(worldCentre(worldOf(scene().elements, after, 0))).toEqual({ x: cx, y: cy });
    }
    // Content is untouched: the text's size and the path's nodes stay as they were.
    expect(el('title').props).toEqual(scaled()[0].props);
    expect(el('swoosh').props).toEqual(scaled()[1].props);
    st().undo();
    expect(el('title').transform).toEqual(T(100, 100, 400, 100));
    expect(el('swoosh').transform).toEqual(T(600, 300, 200, 100));
  });

  it('scaling a mixed selection leaves locked elements and children of locked groups unchanged', () => {
    st().run({ type: 'updateElement', sceneId: 's', elementId: 'title', changes: { locked: true } });
    st().run({ type: 'updateElement', sceneId: 's', elementId: 'g', changes: { locked: true } });
    const all = scene().elements;
    const before = structuredClone(all);
    const items = canvasSelection(all, ['title', 'swoosh', 'kid']).map((e) => itemOf(all, e));
    const edits = scaleSelectionEdits(items, { x: 100, y: 100 }, 2);
    expect(commitEdits(scene(), edits, 'Scale selection')).toBe(true);
    expect(el('swoosh').transform.scale).toBe(2);
    for (const id of ['title', 'g', 'kid']) expect(el(id)).toEqual(before.find((e) => e.id === id));
  });

  it('a child of a rotated group moves its centre in the group’s space', () => {
    const all = scene().elements;
    const kid = itemOf(all, el('kid'));
    const before = worldCentre(kid.world);
    const anchor = { x: 100, y: 100 };
    const [edit] = scaleSelectionEdits([kid], anchor, 1.5);
    expect(edit.base!.scale).toBe(1.5);
    const moved = worldCentre(worldOf(all.map((e) => (e.id === 'kid' ? previewEdit(edit) : e)), previewEdit(edit), 0));
    expect(moved.x).toBeCloseTo(anchor.x + (before.x - anchor.x) * 1.5, 1);
    expect(moved.y).toBeCloseTo(anchor.y + (before.y - anchor.y) * 1.5, 1);
    expect([previewEdit(edit).transform.width, previewEdit(edit).transform.height]).toEqual([40, 40]);
  });
});
