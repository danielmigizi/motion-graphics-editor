// Editor view state: toasts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocState } from '../core/history';
import { sampleProject } from '../sample/sampleProject';
import { reconcileSelection, useEditor } from './store';

beforeEach(() => {
  vi.useFakeTimers();
  useEditor.setState({ toasts: [] });
});

afterEach(() => vi.useRealTimers());

describe('toast', () => {
  it('refreshes an identical message on screen instead of stacking it', () => {
    const { toast } = useEditor.getState();
    toast({ tone: 'info', message: 'Scene approved' });
    toast({ tone: 'info', message: 'Saved' });
    vi.advanceTimersByTime(3000);
    toast({ tone: 'info', message: 'Scene approved', hint: 'again' });
    expect(useEditor.getState().toasts.map((t) => `${t.message}${t.hint ? ` (${t.hint})` : ''}`)).toEqual(['Scene approved (again)', 'Saved']);

    // The first toast's timer no longer removes it; the refreshed one has its own.
    vi.advanceTimersByTime(1500);
    expect(useEditor.getState().toasts.map((t) => t.message)).toEqual(['Scene approved']);
    vi.advanceTimersByTime(3000);
    expect(useEditor.getState().toasts).toEqual([]);
  });

  it('stacks the same text in a different tone', () => {
    const { toast } = useEditor.getState();
    toast({ tone: 'info', message: 'Could not save' });
    toast({ tone: 'error', message: 'Could not save' });
    expect(useEditor.getState().toasts).toHaveLength(2);
  });
});

describe('selection', () => {
  const doc = () => useEditor.getState().doc;
  beforeEach(() => useEditor.getState().loadDocument(createDocState(sampleProject), { kind: 'sample' }));

  it('select, toggle and selectMany keep the primary inside elementIds', () => {
    const st = useEditor.getState();
    st.selectElement('scn_intro', 'el_intro_logo');
    expect(useEditor.getState().selection).toEqual({ sceneId: 'scn_intro', elementId: 'el_intro_logo', elementIds: ['el_intro_logo'] });
    st.toggleElement('scn_intro', 'el_intro_sub');
    expect(useEditor.getState().selection).toMatchObject({ elementId: 'el_intro_sub', elementIds: ['el_intro_logo', 'el_intro_sub'] });
    st.toggleElement('scn_intro', 'el_intro_sub');
    expect(useEditor.getState().selection).toMatchObject({ elementId: 'el_intro_logo', elementIds: ['el_intro_logo'] });
    st.selectMany('scn_intro', ['el_intro_glow', 'el_intro_logo', 'el_intro_glow']);
    expect(useEditor.getState().selection).toMatchObject({ elementId: 'el_intro_logo', elementIds: ['el_intro_glow', 'el_intro_logo'] });
    st.select({ elementId: null });
    expect(useEditor.getState().selection).toMatchObject({ elementId: null, elementIds: [] });
  });

  it('reconcile drops deleted ids, falls back to another selected primary, and keeps identity when unchanged', () => {
    const sel = { sceneId: 'scn_intro', elementId: 'el_intro_sub', elementIds: ['el_intro_logo', 'el_intro_sub'] };
    expect(reconcileSelection(doc(), 0, sel)).toBe(sel);
    const without = { ...doc(), project: { ...doc().project, scenes: doc().project.scenes.map((s) => (s.id === 'scn_intro' ? { ...s, elements: s.elements.filter((e) => e.id !== 'el_intro_sub') } : s)) } };
    expect(reconcileSelection(without, 0, sel)).toEqual({ sceneId: 'scn_intro', elementId: 'el_intro_logo', elementIds: ['el_intro_logo'] });
    // Another scene at the playhead clears the element selection.
    expect(reconcileSelection(doc(), 300, sel)).toEqual({ sceneId: 'scn_product', elementId: null, elementIds: [] });
  });
});

describe('pointer gestures', () => {
  it('count while live, end once, and turn stale when the document changes or another one opens', () => {
    const st = useEditor.getState();
    const g = st.beginGesture();
    expect(useEditor.getState().gestures).toBe(1);
    // View changes are not document changes.
    st.seek(5);
    st.setView({ ...useEditor.getState().view });
    expect(g.stale()).toBe(false);
    st.run({ type: 'updateProject', changes: { name: 'Renamed mid-drag' } }, 'rename');
    expect(g.stale()).toBe(true);
    g.end();
    g.end();
    expect(useEditor.getState().gestures).toBe(0);

    const h = useEditor.getState().beginGesture();
    useEditor.getState().loadDocument(useEditor.getState().doc, { kind: 'sample' });
    expect(h.stale()).toBe(true);
    h.end();
    expect(useEditor.getState().gestures).toBe(0);
  });
});

describe('initial document', () => {
  it('is a blank project of origin `new`, never the sample', async () => {
    vi.resetModules();
    const { useEditor: fresh } = await import('./store');
    const st = fresh.getState();
    expect(st.origin).toEqual({ kind: 'new' });
    expect(st.doc.project).toMatchObject({ id: 'prj_boot', name: 'Untitled video' });
    expect(st.doc.project.scenes.map((s) => [s.id, s.elements.length])).toEqual([['scn_boot', 0]]);
    expect(st.selection.sceneId).toBe('scn_boot');
    expect(st.cleanRevision).toBe(st.doc.project.revision);
  });
});

describe('sheets and the scene inspector', () => {
  it('close when another document opens', () => {
    useEditor.getState().setSheet('connect');
    useEditor.getState().setSceneInspectorOpen(true);
    useEditor.getState().loadDocument(createDocState(structuredClone(sampleProject)), { kind: 'sample' });
    expect(useEditor.getState().sheet).toBeNull();
    expect(useEditor.getState().sceneInspectorOpen).toBe(false);
  });
});
