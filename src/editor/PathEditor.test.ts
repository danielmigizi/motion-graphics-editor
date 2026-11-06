// Path tools at the store level: every pen finish and node edit is one undo
// step, keys route through canvasKeyDown, locks are respected, and node
// editing ends when its path goes away.

import { beforeEach, describe, expect, it } from 'vitest';
import { evaluateElementWorld, transformPoint } from '../core/animation';
import { createDocState } from '../core/history';
import { element, project } from '../core/__fixtures__/schema2Project';
import type { Element, PathNode } from '../core/types';
import { canvasKeyDown } from './canvasControls';
import { removeKeyCommand, setKeyCommand } from './keyframes';
import { cubicPoint, segmentCubic } from './pathEdit';
import { deleteSelectedNodes, enterPathEdit, finishPen, fitPathBox, nextPathName, nudgeSelectedNodes } from './PathEditor';
import { useEditor } from './store';

const T = (x: number, y: number, width: number, height: number, rotation = 0, scale = 1) => ({ x, y, width, height, rotation, scale, opacity: 1 });
const curve: PathNode[] = [
  { x: 0, y: 100, out: { x: 50, y: -40 } },
  { x: 120, y: 60, in: { x: 80, y: 120 }, out: { x: 160, y: 0 } },
  { x: 200, y: 20 },
];

const elements = (): Element[] => [
  element('path1', 'path', { transform: T(100, 100, 200, 120), props: { ...element('x', 'path').props, nodes: curve } }),
  element('g', 'group', { props: { clip: false }, startFrame: 10, durationInFrames: 80, transform: T(500, 200, 300, 200, 30, 1.5) }),
  element('kid', 'shape', { parentId: 'g', transform: T(10, 20, 50, 50) }),
];

const st = () => useEditor.getState();
const scene = () => st().doc.project.scenes[0];
const el = (id: string) => scene().elements.find((e) => e.id === id)!;
const nodes = (id: string) => el(id).props.nodes as PathNode[];
const key = (k: string, mods: { meta?: boolean; shift?: boolean } = {}) =>
  ({ key: k, code: '', metaKey: !!mods.meta, ctrlKey: false, shiftKey: !!mods.shift, altKey: false, repeat: false, target: null, preventDefault() {} }) as unknown as KeyboardEvent;

/** World (composition) position of a box point of an element at the playhead. */
const worldPoint = (e: Element, p: { x: number; y: number }) => transformPoint(evaluateElementWorld(scene().elements, e, st().playhead).worldMatrix, p);

beforeEach(() => {
  st().loadDocument(createDocState(project(elements())), { kind: 'sample' });
  useEditor.setState({ editMode: 'layout', toasts: [] });
});

describe('pen', () => {
  it('P picks the pen; a finished open path is one addElement at the playhead, selected, back to Select', () => {
    st().seek(20);
    canvasKeyDown(key('p'));
    expect(st().tool).toBe('pen');
    const before = st().doc.undoStack.length;
    st().setPenDraft({ sceneId: 's', parentId: null, nodes: [{ x: 110.3, y: 400.2 }, { x: 300, y: 350, out: { x: 340, y: 300 }, in: { x: 260, y: 400 } }, { x: 420.7, y: 380 }] });
    canvasKeyDown(key('Enter'));
    expect(st().doc.undoStack.length).toBe(before + 1);
    const added = scene().elements.at(-1)!;
    expect(st().doc.undoStack.at(-1)!.label).toBe(`Draw “${added.name}”`);
    expect(added).toMatchObject({ type: 'path', name: 'Path 2', startFrame: 20, durationInFrames: 80, visible: true });
    expect(added.parentId).toBeUndefined();
    expect(added.props).toMatchObject({ closed: false, fill: 'none', stroke: '#F8FAFC', strokeWidth: 8 });
    expect(added.transform.x).toBe(110);
    // Nodes land where they were drawn.
    const drawn = (added.props.nodes as PathNode[]).map((n) => worldPoint(added, n));
    expect(drawn[0].x).toBeCloseTo(110.3, 2);
    expect(drawn[2].x).toBeCloseTo(420.7, 2);
    expect(st().selection.elementId).toBe(added.id);
    expect(st().tool).toBe('select');
    expect(st().penDraft).toBeNull();
    st().undo();
    expect(scene().elements.some((e) => e.id === added.id)).toBe(false);
  });

  it('a closed path gets the shape default fill', () => {
    st().setTool('pen');
    st().setPenDraft({ sceneId: 's', parentId: null, nodes: [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 50, y: 80 }] });
    expect(finishPen(true)).toBe(true);
    expect(scene().elements.at(-1)!.props).toMatchObject({ closed: true, fill: '#3B82F6' });
  });

  it('inside a rotated, scaled group the path is a child in local coordinates, timed from the group', () => {
    st().seek(30);
    st().selectElement('s', 'kid'); // scope: the group
    st().setTool('pen');
    const drawn = [{ x: 600, y: 300 }, { x: 700, y: 360 }, { x: 640, y: 420 }];
    // The stage records the scope with the first point.
    st().setPenDraft({ sceneId: 's', parentId: 'g', nodes: drawn });
    expect(finishPen(true)).toBe(true);
    const added = scene().elements.at(-1)!;
    expect(added.parentId).toBe('g');
    expect(added.startFrame).toBe(20); // playhead 30, group starts at 10
    expect(added.durationInFrames).toBe(60); // to the end of the group (80)
    const world = (added.props.nodes as PathNode[]).map((n) => worldPoint(added, n));
    world.forEach((p, i) => {
      expect(p.x).toBeCloseTo(drawn[i].x, 1);
      expect(p.y).toBeCloseTo(drawn[i].y, 1);
    });
  });

  it('Esc drops a lone point, then leaves the pen; Backspace takes back a point', () => {
    st().setTool('pen');
    st().setPenDraft({ sceneId: 's', parentId: null, nodes: [{ x: 1, y: 1 }, { x: 50, y: 50 }] });
    canvasKeyDown(key('Backspace'));
    expect(st().penDraft!.nodes).toHaveLength(1);
    canvasKeyDown(key('Escape'));
    expect(st().penDraft).toBeNull();
    expect(st().tool).toBe('pen');
    canvasKeyDown(key('Escape'));
    expect(st().tool).toBe('select');
  });

  it('a locked scene refuses the path', () => {
    st().run({ type: 'setSceneLock', sceneId: 's', locked: true } as never, 'lock');
    const before = scene().elements.length;
    st().setPenDraft({ sceneId: 's', parentId: null, nodes: [{ x: 1, y: 1 }, { x: 50, y: 50 }] });
    expect(finishPen(false)).toBe(false);
    expect(scene().elements.length).toBe(before);
    expect(st().toasts.at(-1)?.message).toMatch(/locked/);
  });

  it('names count up past existing paths', () => {
    expect(nextPathName(scene().elements)).toBe('Path 2');
    expect(nextPathName([...scene().elements, { ...el('path1'), id: 'q', name: 'Path 2' }])).toBe('Path 3');
  });
});

describe('node editing', () => {
  beforeEach(() => {
    st().selectElement('s', 'path1');
    canvasKeyDown(key('Enter'));
  });

  it('Enter on a selected path enters node editing; Esc leaves', () => {
    expect(st().pathEdit).toEqual({ sceneId: 's', elementId: 'path1', nodes: [] });
    canvasKeyDown(key('Escape'));
    expect(st().pathEdit).toBeNull();
    expect(st().selection.elementId).toBe('path1');
  });

  it('Tab cycles nodes; arrows nudge the selected nodes as one undo step each', () => {
    canvasKeyDown(key('Tab'));
    canvasKeyDown(key('Tab'));
    expect(st().pathEdit!.nodes).toEqual([1]);
    const before = st().doc.undoStack.length;
    canvasKeyDown(key('ArrowRight', { shift: true }));
    expect(st().doc.undoStack.length).toBe(before + 1);
    expect(st().doc.undoStack.at(-1)!.label).toBe('Nudge node');
    expect(nodes('path1')[1]).toEqual({ x: 130, y: 60, in: { x: 90, y: 120 }, out: { x: 170, y: 0 } });
    expect(el('path1').transform.x).toBe(100); // the element itself stays put
    st().undo();
    expect(nodes('path1')).toEqual(curve);
    expect(st().pathEdit).not.toBeNull();
  });

  it('⌘A selects every node; Delete keeps at least two', () => {
    canvasKeyDown(key('a', { meta: true }));
    expect(st().pathEdit!.nodes).toEqual([0, 1, 2]);
    expect(deleteSelectedNodes()).toBe(false);
    expect(nodes('path1')).toHaveLength(3);
    st().setPathEdit({ ...st().pathEdit!, nodes: [1] });
    canvasKeyDown(key('Delete'));
    expect(nodes('path1')).toEqual([curve[0], curve[2]]);
    expect(st().doc.undoStack.at(-1)!.label).toBe('Delete node');
  });

  it('nudges follow the screen inside a rotated group', () => {
    st().run({ type: 'setParent', sceneId: 's', elementId: 'path1', parentId: 'g', keepWorld: true }, 'into group');
    st().seek(30);
    st().setPathEdit({ sceneId: 's', elementId: 'path1', nodes: [2] });
    const before = worldPoint(el('path1'), nodes('path1')[2]);
    expect(nudgeSelectedNodes(10, 0)).toBe(true);
    const after = worldPoint(el('path1'), nodes('path1')[2]);
    expect(after.x - before.x).toBeCloseTo(10, 1);
    expect(after.y - before.y).toBeCloseTo(0, 1);
  });

  it('Fit box to path is one undo step that keeps the curve where it is', () => {
    st().run({ type: 'updateElement', sceneId: 's', elementId: 'path1', changes: { transform: { rotation: 25, scale: 1.4 } } }, 'turn');
    const samples = () => [0, 1].flatMap((i) => [0, 0.3, 0.7, 1].map((t) => worldPoint(el('path1'), cubicPoint(segmentCubic(nodes('path1'), i), t))));
    const before = samples();
    const n = st().doc.undoStack.length;
    expect(fitPathBox()).toBe(true);
    expect(st().doc.undoStack.length).toBe(n + 1);
    expect(st().doc.undoStack.at(-1)!.label).toBe('Fit box to path');
    samples().forEach((p, i) => {
      expect(p.x).toBeCloseTo(before[i].x, 1);
      expect(p.y).toBeCloseTo(before[i].y, 1);
    });
    expect(fitPathBox()).toBe(false); // already fits
  });

  it('Fit box to path refuses while rotation or scale is animated (the pivot would move on other frames)', () => {
    const samples = () => [0, 1].flatMap((i) => [0, 0.5, 1].map((t) => worldPoint(el('path1'), cubicPoint(segmentCubic(nodes('path1'), i), t))));
    const at = (frame: number) => {
      st().seek(frame);
      return samples();
    };
    st().run(setKeyCommand('s', 'path1', 'rotation', 0, 0), 'key');
    st().run(setKeyCommand('s', 'path1', 'rotation', 50, 90), 'key');
    const before = [at(0), at(50)];
    st().seek(0);
    const n = st().doc.undoStack.length;
    fitPathBox();
    [at(0), at(50)].forEach((after, f) =>
      after.forEach((p, i) => {
        expect(p.x).toBeCloseTo(before[f][i].x, 1);
        expect(p.y).toBeCloseTo(before[f][i].y, 1);
      }),
    );
    expect(st().doc.undoStack.length).toBe(n);
    expect(st().toasts.at(-1)?.message).toMatch(/animated/);
    // A constant rotation track (one key) is still compensated exactly.
    st().run(removeKeyCommand('s', 'path1', 'rotation', 50), 'unkey');
    st().seek(0);
    expect(fitPathBox()).toBe(true);
  });

  it('ends when the path goes away (undo of its creation, delete)', () => {
    st().run({ type: 'removeElement', sceneId: 's', elementId: 'path1' }, 'gone');
    expect(st().pathEdit).toBeNull();
  });

  it('a locked scene refuses node editing', () => {
    canvasKeyDown(key('Escape'));
    st().run({ type: 'setSceneLock', sceneId: 's', locked: true } as never, 'lock');
    expect(enterPathEdit()).toBe(true); // handled, with the lock notice
    expect(st().pathEdit).toBeNull();
    expect(st().toasts.at(-1)?.message).toMatch(/locked/);
  });

  it('P switches to the pen and ends node editing', () => {
    canvasKeyDown(key('p'));
    expect(st().tool).toBe('pen');
    expect(st().pathEdit).toBeNull();
  });
});
