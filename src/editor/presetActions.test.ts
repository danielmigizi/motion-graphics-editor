// Presets and templates as editor actions, against the real store.

import { beforeEach, describe, expect, it } from 'vitest';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import { createDocState } from '../core/history';
import { sceneStartFrame } from '../core/timing';
import { STYLE_PACKS } from '../core/style';
import { applyPreset, arriveApart, followThrough, insertTemplate } from './presetActions';
import { useEditor } from './store';

const project = () => useEditor.getState().doc.project;
const element = (id: string) => project().scenes.flatMap((s) => s.elements).find((e) => e.id === id)!;

beforeEach(() => {
  useEditor.getState().loadDocument(createDocState(structuredClone(fixtureProject)), { kind: 'server', id: fixtureProject.id });
  useEditor.setState({ toasts: [] });
});

describe('applyPreset', () => {
  it('is one undo step of ordinary keys', () => {
    const before = project();
    expect(applyPreset('scn_product', 'el_product_card', 'popIn')).toBe(true);
    const st = useEditor.getState();
    expect(st.doc.undoStack).toHaveLength(1);
    expect(st.doc.undoStack[0].label).toBe('Pop on “Weekly brief card”');
    expect(element('el_product_card').tracks.find((t) => t.property === 'scale')?.keyframes.map((k) => [k.frame, k.value])).toEqual([[0, 0.5], [15, 1]]);
    st.undo();
    expect(project().scenes).toEqual(before.scenes); // (undo is a new revision)
  });

  it('starts emphasis at the playhead and exits at the end', () => {
    const start = sceneStartFrame(project(), 'scn_product');
    useEditor.getState().seek(start + 40 + 50); // 50 frames into the card
    expect(applyPreset('scn_product', 'el_product_card', 'pulse', { intensity: 2 })).toBe(true);
    expect(element('el_product_card').tracks.find((t) => t.property === 'scale')?.keyframes.map((k) => [k.frame, k.value])).toEqual([[50, 1], [59, 1.2], [68, 1]]);
    expect(applyPreset('scn_product', 'el_product_card', 'fadeOut')).toBe(true);
    const opacity = element('el_product_card').tracks.find((t) => t.property === 'opacity')!.keyframes;
    expect(opacity.at(-1)).toMatchObject({ frame: 229, value: 0 });
    expect(opacity[0]).toMatchObject({ frame: 0, value: 0 }); // the existing fade-in is kept
  });

  it('respects locks and element types', () => {
    useEditor.getState().run({ type: 'setSceneLock', sceneId: 'scn_intro', locked: true });
    const before = project();
    expect(applyPreset('scn_intro', 'el_intro_headline', 'riseIn')).toBe(false);
    expect(applyPreset('scn_product', 'el_product_headline', 'wipeOn')).toBe(false);
    expect(project()).toBe(before);
    expect(useEditor.getState().toasts.map((t) => t.message)).toEqual(['Scene locked — unlock to edit', 'Wipe on doesn’t apply to “Headline”.']);
  });
});

describe('insertTemplate', () => {
  it('inserts a selected group at the playhead as one undo step', () => {
    const start = sceneStartFrame(project(), 'scn_product');
    useEditor.getState().seek(start + 60);
    const count = project().scenes[1].elements.length;
    expect(insertTemplate('lowerThird', { name: 'Maya Chen' })).toBe(true);
    const st = useEditor.getState();
    expect(st.doc.undoStack).toHaveLength(1);
    const scene = project().scenes[1];
    expect(scene.elements).toHaveLength(count + 5);
    const group = scene.elements.find((e) => e.id === st.selection.elementId)!;
    expect(group).toMatchObject({ type: 'group', name: 'Lower third', startFrame: 60 });
    expect(scene.elements.find((e) => e.parentId === group.id && e.name === 'Name')?.props.text).toBe('Maya Chen');
    st.undo();
    expect(project().scenes[1].elements).toHaveLength(count);
  });

  it('starts early enough to play out near the end of a scene, and refuses locked scenes', () => {
    useEditor.getState().seek(sceneStartFrame(project(), 'scn_outro') + 235);
    expect(insertTemplate('titleCard')).toBe(true);
    expect(project().scenes[2].elements.at(-4)).toMatchObject({ type: 'group', startFrame: 120, durationInFrames: 120 });
    useEditor.getState().run({ type: 'setSceneLock', sceneId: 'scn_outro', locked: true });
    expect(insertTemplate('titleCard')).toBe(false);
  });
});

describe('style-aware motion', () => {
  it('applyPreset retimes and re-eases with the project style', () => {
    useEditor.getState().run({ type: 'setStyle', style: STYLE_PACKS['calm-premium'] });
    expect(applyPreset('scn_product', 'el_product_card', 'riseIn')).toBe(true);
    const y = element('el_product_card').tracks.find((t) => t.property === 'y')!.keyframes;
    expect(y.map((k) => k.frame)).toEqual([0, 24]); // 0.6 s × 1.35
    expect(y[0].easing).toEqual(STYLE_PACKS['calm-premium'].motion.enter);
  });

  it('arrive apart staggers a multi-selection in one undo step', () => {
    useEditor.getState().run({ type: 'setStyle', style: STYLE_PACKS['snappy-saas'] });
    const scene = project().scenes[1];
    const ids = scene.elements.filter((e) => !e.parentId).slice(0, 3).map((e) => e.id);
    useEditor.getState().selectMany(scene.id, ids);
    const undo = useEditor.getState().doc.undoStack.length;
    expect(arriveApart()).toBe(true);
    expect(useEditor.getState().doc.undoStack).toHaveLength(undo + 1);
    expect(useEditor.getState().doc.undoStack.at(-1)!.label).toBe('Arrive apart · 3 layers');
    const firstKeys = ids.map((id) => scene.elements.find((e) => e.id === id)!.startFrame + element(id).tracks.find((t) => t.property === 'y')!.keyframes[0].frame).sort((a, b) => a - b);
    expect(firstKeys[2] - firstKeys[0]).toBeGreaterThanOrEqual(3); // arrivals spread by the stagger
    useEditor.getState().selectElement(scene.id, ids[0]);
    expect(arriveApart()).toBe(false);
    expect(useEditor.getState().toasts.at(-1)?.message).toBe('Arrive apart needs two or more layers.');
  });

  it('arrive apart on layers that already arrive replaces their entrance (the card does not fade in twice)', () => {
    const scene = project().scenes[1];
    useEditor.getState().selectMany(scene.id, ['el_product_card', 'el_product_chat_user', 'el_product_chat_ai']);
    expect(arriveApart()).toBe(true);
    for (const id of ['el_product_card', 'el_product_chat_user', 'el_product_chat_ai']) {
      expect(element(id).tracks.find((t) => t.property === 'opacity')!.keyframes.map((k) => k.value), id).toEqual([0, 1]);
    }
  });

  it('follow-through needs a group with layers', () => {
    const scene = project().scenes[1];
    const ids = scene.elements.filter((e) => !e.parentId).slice(0, 2).map((e) => e.id);
    useEditor.getState().run({ type: 'groupElements', sceneId: scene.id, elementIds: ids, group: { id: 'el_ft_group', name: 'Cards' } });
    expect(followThrough(scene.id, 'el_ft_group')).toBe(true);
    expect(useEditor.getState().doc.undoStack.at(-1)!.label).toBe('Follow-through on “Cards”');
    expect(followThrough(scene.id, ids[0])).toBe(false);
  });
});

