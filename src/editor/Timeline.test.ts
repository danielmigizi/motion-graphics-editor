// Advanced timeline actions at the store level: key deletion yields to the
// path tools, and "Mark beats" only applies decoded audio to the document,
// frame rate and file it was decoded for.

import { beforeEach, describe, expect, it } from 'vitest';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import { element, project } from '../core/__fixtures__/schema2Project';
import { createDocState } from '../core/history';
import type { PathNode } from '../core/types';
import { canvasKeyDown } from './canvasControls';
import { setKeyCommand } from './keyframes';
import { enterPathEdit, setCanvasTool } from './PathEditor';
import { useEditor } from './store';
import { deleteSelectedKeys, markBeats } from './Timeline';
import type { Peaks } from './waveform';

const st = () => useEditor.getState();
const key = (k: string) => ({ key: k, code: '', metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, target: null, preventDefault() {} }) as unknown as KeyboardEvent;

describe('Delete with the path tools active', () => {
  const nodes: PathNode[] = [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 0 }];
  const path = () => st().doc.project.scenes[0].elements.find((e) => e.id === 'p1')!;

  beforeEach(() => {
    st().loadDocument(createDocState(project([element('p1', 'path', { props: { ...element('x', 'path').props, nodes } })])), { kind: 'sample' });
    useEditor.setState({ toasts: [] });
    st().run(setKeyCommand('s', 'p1', 'rotation', 0, 0), 'key');
    st().run(setKeyCommand('s', 'p1', 'rotation', 40, 30), 'key');
    st().selectElement('s', 'p1');
    st().selectKeyframes([{ track: 'rotation', frame: 40 }]);
  });

  it('entering node editing clears the key selection; Delete then removes the node, not a key', () => {
    expect(enterPathEdit()).toBe(true);
    expect(st().selectedKeyframes).toEqual([]);
    // Keys picked on the timeline while editing nodes still leave Delete to the nodes.
    st().selectKeyframes([{ track: 'rotation', frame: 40 }]);
    st().setPathEdit({ ...st().pathEdit!, nodes: [1] });
    expect(deleteSelectedKeys()).toBe(false);
    expect(canvasKeyDown(key('Delete'))).toBe(true);
    expect(path().tracks[0].keyframes).toHaveLength(2);
    expect(path().props.nodes).toEqual([nodes[0], nodes[2]]);
  });

  it('the pen clears the key selection and keeps Backspace for its points', () => {
    setCanvasTool('pen');
    expect(st().selectedKeyframes).toEqual([]);
    st().selectKeyframes([{ track: 'rotation', frame: 40 }]);
    expect(deleteSelectedKeys()).toBe(false);
    expect(path().tracks[0].keyframes).toHaveLength(2);
  });

  it('without the path tools Delete removes the selected keys', () => {
    expect(deleteSelectedKeys()).toBe(true);
    expect(path().tracks[0].keyframes.map((k) => k.frame)).toEqual([0]);
  });
});

describe('Mark beats', () => {
  /** One peak per frame at whatever fps it was decoded for: silence with a hit at frame `at` (default 60: 2 s at 30 fps). */
  const peaks = (at = 60): Peaks => {
    const data = new Float32Array(200);
    data.fill(1, at, at + 4);
    return { perFrame: 1, data, max: 1 };
  };
  /** A decode that resolves when the test says so, recording the fps it was asked for. */
  const deferredLoad = () => {
    let resolve!: (p: Peaks | null) => void;
    const asked: number[] = [];
    const load = (_url: string, fps: number) => {
      asked.push(fps);
      return new Promise<Peaks | null>((r) => (resolve = r));
    };
    return { load, asked, resolve: (p: Peaks | null) => resolve(p) };
  };
  const beats = () => st().doc.project.markers.filter((m) => /^Beat /.test(m.label));

  beforeEach(() => {
    st().loadDocument(createDocState(structuredClone(fixtureProject)), { kind: 'server', id: fixtureProject.id });
    useEditor.setState({ toasts: [] });
  });

  it('marks the hit at its frame', async () => {
    const d = deferredLoad();
    const run = markBeats('aud_music', d.load);
    d.resolve(peaks());
    await run;
    expect(beats().map((m) => [m.frame, m.label])).toEqual([[60, 'Beat 1']]);
  });

  it('drops peaks decoded at another frame rate', async () => {
    const d = deferredLoad();
    const run = markBeats('aud_music', d.load);
    st().run({ type: 'changeFormat', width: 1920, height: 1080, fps: 60, conversion: { layout: 'none', timing: 'keepSeconds' } }, '60 fps');
    d.resolve(peaks());
    await run;
    expect(d.asked).toEqual([30]);
    // Applied at 60 fps the 30-fps index would land on frame 60 (1 s) instead of 120 (2 s).
    expect(beats()).toEqual([]);
    expect(st().toasts.at(-1)?.message).toMatch(/changed while listening/);
  });

  it('drops peaks of a replaced audio file', async () => {
    const d = deferredLoad();
    const run = markBeats('aud_music', d.load);
    expect(st().run({ type: 'updateAudioClip', clipId: 'aud_music', changes: { assetId: 'ast_whoosh' } }, 'swap')).toBe(true);
    // A hit inside the (shorter) new clip, so only the source check can drop it.
    d.resolve(peaks(6));
    await run;
    expect(beats()).toEqual([]);
  });

  it('never writes into a document opened meanwhile, even one with the same clip', async () => {
    const d = deferredLoad();
    const run = markBeats('aud_music', d.load);
    st().loadDocument(createDocState(structuredClone(fixtureProject)), { kind: 'server', id: fixtureProject.id });
    d.resolve(peaks());
    await run;
    expect(beats()).toEqual([]);
    expect(st().toasts.filter((t) => /beat|decode|listening/i.test(t.message))).toEqual([]);
  });
});
