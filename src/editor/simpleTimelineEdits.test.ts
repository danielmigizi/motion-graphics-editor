import { describe, expect, it } from 'vitest';
import { applyCommand } from '../core/commands';
import { createDocState, execute, undo } from '../core/history';
import { COMPONENTS } from '../core/components';
import { duckUnder, envelopeAt } from '../core/audioDucking';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import type { Project } from '../core/types';
import {
  applyPreview,
  dragAudioSpan,
  dragElementSpan,
  elementSnapTargets,
  focusFrame,
  framesForPx,
  maxSceneLength,
  minSceneLength,
  packRows,
  previewCommand,
  pxToFrames,
  rulerStep,
  sceneDropTarget,
  sceneLengthAt,
  snapFrame,
  snapSpan,
  trimToPlayhead,
} from './simpleTimelineEdits';

// Fixture: 30 fps; scn_intro 210 f, scn_product 270 f, scn_outro 240 f (720 f total).
const project = (): Project => structuredClone(fixtureProject);
const scene = (p: Project, id: string) => p.scenes.find((s) => s.id === id)!;
const element = (p: Project, sceneId: string, id: string) => scene(p, sceneId).elements.find((e) => e.id === id)!;

describe('frames ↔ px', () => {
  it('converts at the fit-to-width scale', () => {
    expect(pxToFrames(100, 720, 1200)).toBe(60);
    expect(pxToFrames(-10, 720, 1200)).toBe(-6);
    expect(pxToFrames(50, 720, 0)).toBe(0);
    expect(framesForPx(6, 720, 1200)).toBeCloseTo(3.6);
  });

  it('picks ruler steps that keep labels apart', () => {
    expect(rulerStep(720, 30, 1200)).toBe(1); // 50 px per second
    expect(rulerStep(720, 30, 600)).toBe(2); // 25 px per second
    expect(rulerStep(30 * 600, 30, 1000)).toBe(30);
  });
});

describe('snapping', () => {
  it('snaps to the nearest target within the threshold only', () => {
    expect(snapFrame(52, [0, 50, 55], 4)).toEqual({ frame: 50, snap: 50 });
    expect(snapFrame(54, [0, 50, 55], 4)).toEqual({ frame: 55, snap: 55 });
    expect(snapFrame(40, [0, 50], 4)).toEqual({ frame: 40, snap: null });
  });

  it('snaps a moving span by whichever edge is closer', () => {
    expect(snapSpan(12, 30, [10, 100], 4)).toEqual({ frame: 10, snap: 10 });
    expect(snapSpan(68, 30, [0, 100], 4)).toEqual({ frame: 70, snap: 100 });
    expect(snapSpan(40, 30, [0, 200], 4)).toEqual({ frame: 40, snap: null });
  });

  it('collects scene edges, the playhead and other clips’ edges as targets', () => {
    const p = project();
    const t = elementSnapTargets(scene(p, 'scn_intro'), 'el_intro_sub', 100);
    expect(t).toEqual(expect.arrayContaining([0, 210, 100, 20, 210]));
    expect(t).not.toContain(60); // its own start
    expect(elementSnapTargets(scene(p, 'scn_intro'), 'el_intro_sub', 400)).not.toContain(400);
  });
});

describe('dragging a clip', () => {
  const orig = { start: 60, dur: 100 };

  it('moves within the scene, clamped to its edges', () => {
    expect(dragElementSpan(orig, 'move', 25, 210, [], 0)).toEqual({ start: 85, dur: 100, snap: null });
    expect(dragElementSpan(orig, 'move', 500, 210, [], 0)).toEqual({ start: 110, dur: 100, snap: null });
    expect(dragElementSpan(orig, 'move', -500, 210, [], 0)).toEqual({ start: 0, dur: 100, snap: null });
  });

  it('trims the start without moving the end, keeping at least one frame', () => {
    expect(dragElementSpan(orig, 'start', 20, 210, [], 0)).toEqual({ start: 80, dur: 80, snap: null });
    expect(dragElementSpan(orig, 'start', 400, 210, [], 0)).toEqual({ start: 159, dur: 1, snap: null });
    expect(dragElementSpan(orig, 'start', -400, 210, [], 0)).toEqual({ start: 0, dur: 160, snap: null });
  });

  it('trims the end up to the scene end', () => {
    expect(dragElementSpan(orig, 'end', -30, 210, [], 0)).toEqual({ start: 60, dur: 70, snap: null });
    expect(dragElementSpan(orig, 'end', 400, 210, [], 0)).toEqual({ start: 60, dur: 150, snap: null });
    expect(dragElementSpan(orig, 'end', -400, 210, [], 0)).toEqual({ start: 60, dur: 1, snap: null });
  });

  it('snaps the dragged edge to a nearby target', () => {
    expect(dragElementSpan(orig, 'end', 18, 210, [180], 4)).toEqual({ start: 60, dur: 120, snap: 180 });
    expect(dragElementSpan(orig, 'start', -38, 210, [20], 4)).toEqual({ start: 20, dur: 140, snap: 20 });
    expect(dragElementSpan(orig, 'move', 48, 210, [210], 4)).toEqual({ start: 110, dur: 100, snap: 210 });
  });
});

describe('trim to playhead ([ and ])', () => {
  const p = project();
  const intro = scene(p, 'scn_intro');
  const sub = element(p, 'scn_intro', 'el_intro_sub'); // 60..210

  it('"[" moves the start to the playhead and keeps the end', () => {
    expect(trimToPlayhead(intro, 0, sub, 90, 'start')).toEqual({ ok: true, changes: { startFrame: 90, durationInFrames: 120 } });
    expect(trimToPlayhead(intro, 0, sub, 30, 'start')).toEqual({ ok: true, changes: { startFrame: 30, durationInFrames: 180 } });
  });

  it('"]" moves the end to the playhead', () => {
    expect(trimToPlayhead(intro, 0, sub, 150, 'end')).toEqual({ ok: true, changes: { durationInFrames: 90 } });
  });

  it('works with the scene’s global offset', () => {
    const product = scene(p, 'scn_product');
    const card = element(p, 'scn_product', 'el_product_card'); // 40..270
    expect(trimToPlayhead(product, 210, card, 210 + 100, 'start')).toEqual({ ok: true, changes: { startFrame: 100, durationInFrames: 170 } });
  });

  it('explains why it cannot trim', () => {
    expect(trimToPlayhead(intro, 0, sub, 300, 'end')).toMatchObject({ ok: false, reason: expect.stringContaining('Intro') });
    expect(trimToPlayhead(intro, 0, sub, 30, 'end')).toMatchObject({ ok: false, reason: expect.stringContaining('before the start') });
    expect(trimToPlayhead(intro, 0, sub, 210, 'start')).toMatchObject({ ok: false, reason: expect.stringContaining('after the end') });
    expect(trimToPlayhead(intro, 0, sub, 60, 'start')).toMatchObject({ ok: false });
  });

  it('focuses a frame inside the clip', () => {
    expect(focusFrame(210, element(p, 'scn_product', 'el_product_card'), 30)).toBe(210 + 40 + 30);
    expect(focusFrame(0, { ...sub, durationInFrames: 10 }, 30)).toBe(65);
  });
});

describe('scene length', () => {
  it('cannot go below the last element’s end, and names it', () => {
    const p = project();
    const s = scene(p, 'scn_product');
    s.elements[0].durationInFrames = 200;
    const m = minSceneLength(s);
    expect(m.frames).toBe(270);
    expect(m.blocker?.id).toBe('el_product_image');
    expect(minSceneLength({ ...s, elements: [] })).toEqual({ frames: 1, blocker: null });
  });

  // The first scene of the fixture (210 of 720 frames) on a 1200 px timeline: 0.6 frames per px.
  const base = { total: 720, sceneDuration: 210, width: 1200, min: 120, max: 2000, fps: 30, threshold: 0 };

  it('moves the edge with the pointer at the scale the drag started with', () => {
    expect(sceneLengthAt({ ...base, dx: 0 }).frames).toBe(210);
    expect(sceneLengthAt({ ...base, dx: 200 }).frames).toBe(330);
    expect(sceneLengthAt({ ...base, dx: -100 }).frames).toBe(150);
  });

  it('clamps to the minimum (and says so) and the maximum', () => {
    expect(sceneLengthAt({ ...base, dx: -340 })).toEqual({ frames: 120, clamped: true });
    expect(sceneLengthAt({ ...base, dx: 5000 })).toEqual({ frames: 2000, clamped: false });
  });

  it('snaps to whole seconds and to the minimum', () => {
    expect(sceneLengthAt({ ...base, dx: 210, threshold: 12 }).frames).toBe(330);
    expect(sceneLengthAt({ ...base, min: 125, dx: -140, threshold: 6 }).frames).toBe(125);
  });

  it('resizes the last scene smoothly in both directions', () => {
    // 300-frame project whose last scene is 150 frames, 600 px wide: 0.5 frames per px.
    const last = { total: 300, sceneDuration: 150, width: 600, min: 60, max: maxSceneLength(150, 300, 30), fps: 30, threshold: 0 };
    expect([-20, -10, -4, -1, 0, 1, 4, 10, 20].map((dx) => sceneLengthAt({ ...last, dx }).frames)).toEqual([140, 145, 148, 150, 150, 151, 152, 155, 160]);
    expect(sceneLengthAt({ ...last, dx: -400 })).toEqual({ frames: 60, clamped: true });
    expect(sceneLengthAt({ ...last, dx: 2000 }).frames).toBe(450);
  });

  it('resizes the only scene of a project smoothly in both directions', () => {
    const only = { total: 300, sceneDuration: 300, width: 600, min: 30, max: maxSceneLength(300, 300, 30), fps: 30, threshold: 0 };
    expect([-60, -6, 6, 60].map((dx) => sceneLengthAt({ ...only, dx }).frames)).toEqual([270, 297, 303, 330]);
  });
});

describe('scene reorder', () => {
  const starts = [0, 210, 480];
  const durs = [210, 270, 240];

  it('drops after every scene whose midpoint is passed', () => {
    expect(sceneDropTarget(700, starts, durs, 0)).toEqual({ slot: 3, toIndex: 2 });
    expect(sceneDropTarget(400, starts, durs, 0)).toEqual({ slot: 2, toIndex: 1 });
    expect(sceneDropTarget(50, starts, durs, 2)).toEqual({ slot: 0, toIndex: 0 });
    expect(sceneDropTarget(300, starts, durs, 1)).toEqual({ slot: 1, toIndex: 1 });
  });
});

describe('audio', () => {
  const p = project();
  const music = p.audio.find((c) => c.id === 'aud_music')!; // 0..720, fades 15/45, source 720
  const whoosh = p.audio.find((c) => c.id === 'aud_whoosh')!; // scn_product +0, 20 f

  it('trims the left edge and advances trimStartFrames', () => {
    expect(dragAudioSpan({ clip: music, base: 0, total: 720, sourceFrames: 720, mode: 'start', df: 30, targets: [], threshold: 0 })).toEqual({
      startFrame: 30,
      trimStartFrames: 30,
      durationInFrames: 690,
      snap: null,
    });
  });

  it('cannot reveal audio before the source starts or past its end', () => {
    expect(dragAudioSpan({ clip: music, base: 0, total: 720, sourceFrames: 720, mode: 'start', df: -30, targets: [], threshold: 0 }).startFrame).toBe(0);
    const trimmed = { ...music, startFrame: 30, trimStartFrames: 30, durationInFrames: 600 };
    expect(dragAudioSpan({ clip: trimmed, base: 0, total: 720, sourceFrames: 720, mode: 'end', df: 500, targets: [], threshold: 0 }).durationInFrames).toBe(690);
  });

  it('never gets shorter than its fades', () => {
    expect(dragAudioSpan({ clip: music, base: 0, total: 720, mode: 'end', df: -9999, targets: [], threshold: 0 }).durationInFrames).toBe(45);
  });

  it('moves an anchored clip within the project, never before its scene', () => {
    expect(dragAudioSpan({ clip: whoosh, base: 210, total: 720, mode: 'move', df: -500, targets: [], threshold: 0 }).startFrame).toBe(0);
    expect(dragAudioSpan({ clip: whoosh, base: 210, total: 720, mode: 'move', df: 9999, targets: [], threshold: 0 }).startFrame).toBe(720 - 20 - 210);
    expect(dragAudioSpan({ clip: whoosh, base: 210, total: 720, mode: 'move', df: 47, targets: [260], threshold: 4 })).toMatchObject({ startFrame: 50, snap: 260 });
  });

  it('packs overlapping clips into rows', () => {
    const { rows, count } = packRows([
      { id: 'a', start: 0, end: 720 },
      { id: 'b', start: 210, end: 230 },
      { id: 'c', start: 225, end: 260 },
      { id: 'd', start: 260, end: 300 },
    ]);
    expect(count).toBe(3);
    expect([rows.get('a'), rows.get('b'), rows.get('c'), rows.get('d')]).toEqual([0, 1, 2, 1]);
  });
});

describe('preview → one command', () => {
  it('previews without touching the original and commits a valid labelled command', () => {
    const p = project();
    const preview = { kind: 'element', sceneId: 'scn_intro', elementId: 'el_intro_sub', mode: 'start', start: 90, dur: 120 } as const;
    const view = applyPreview(p, preview);
    expect(element(view, 'scn_intro', 'el_intro_sub')).toMatchObject({ startFrame: 90, durationInFrames: 120 });
    expect(element(p, 'scn_intro', 'el_intro_sub')).toMatchObject({ startFrame: 60, durationInFrames: 150 });
    expect(view.scenes[1]).toBe(p.scenes[1]);

    const c = previewCommand(p, preview)!;
    expect(c.label).toBe('Trimmed “Subhead”');
    expect(c.command).toEqual({ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_sub', changes: { startFrame: 90, durationInFrames: 120 } });
    expect(applyCommand(p, c.command, { source: 'user' }).ok).toBe(true);
  });

  it('labels moves, audio trims and scene lengths; nothing for a no-op', () => {
    const p = project();
    expect(previewCommand(p, { kind: 'element', sceneId: 'scn_intro', elementId: 'el_intro_sub', mode: 'move', start: 50, dur: 150 })?.label).toBe('Moved “Subhead”');
    expect(previewCommand(p, { kind: 'element', sceneId: 'scn_intro', elementId: 'el_intro_sub', mode: 'move', start: 60, dur: 150 })).toBeNull();

    const audio = previewCommand(p, { kind: 'audio', clipId: 'aud_music', mode: 'start', span: { startFrame: 30, trimStartFrames: 30, durationInFrames: 690 } })!;
    expect(audio).toEqual({ command: { type: 'updateAudioClip', clipId: 'aud_music', changes: { startFrame: 30, trimStartFrames: 30, durationInFrames: 690 } }, label: 'Trimmed “Music bed”' });
    expect(applyCommand(p, audio.command, { source: 'user' }).ok).toBe(true);

    const len = previewCommand(p, { kind: 'sceneLength', sceneId: 'scn_intro', durationInFrames: 240 })!;
    expect(len.label).toBe('Changed “Intro” length');
    expect(applyCommand(p, len.command, { source: 'user' }).ok).toBe(true);
    expect(applyPreview(p, { kind: 'sceneLength', sceneId: 'scn_intro', durationInFrames: 240 }).scenes[0].durationInFrames).toBe(240);
  });
});

describe('envelope trims', () => {
  it.each(['start', 'end'] as const)('crops and rebases an envelope on a %s trim in the same undoable command', (mode) => {
    const p = project();
    const clip = p.audio[0];
    clip.durationInFrames = 90;
    clip.fadeInFrames = 0;
    clip.fadeOutFrames = 0;
    clip.volumeEnvelope = [{ frame: 0, value: 1 }, { frame: 90, value: 0.1 }];
    const span = dragAudioSpan({ clip, base: 0, total: 720, mode, df: mode === 'start' ? 30 : -30, targets: [], threshold: 0 });
    const preview = { kind: 'audio' as const, clipId: clip.id, mode, span };
    const pending = applyPreview(p, preview).audio[0];
    const result = previewCommand(p, preview)!;
    const r = applyCommand(p, result.command, { source: 'user' });
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
    if (!r.ok) return;
    expect(pending.volumeEnvelope).toEqual(r.project.audio[0].volumeEnvelope);
    expect(r.project.audio[0].volumeEnvelope?.map((p) => p.frame)).toEqual([0, 60]);
    expect(r.project.audio[0].volumeEnvelope?.[0].value).toBeCloseTo(mode === 'start' ? 0.7 : 1);
    expect(r.project.audio[0].volumeEnvelope?.[1].value).toBeCloseTo(mode === 'start' ? 0.1 : 0.4);
  });
});


describe('detached and ducked audio trims', () => {
  it('trims animated detached video audio and restores its curve with one undo', () => {
    const p = project();
    p.assets.ast_video = { id: 'ast_video', kind: 'video', name: 'Video', src: 'assets/test.mp4', mimeType: 'video/mp4', durationInFrames: 90, hasAudio: true };
    const video = { ...p.scenes[0].elements[0], id: 'el_video', type: 'video' as const, startFrame: 0, durationInFrames: 90, props: { ...COMPONENTS.video.defaultProps, assetId: 'ast_video' }, tracks: [], propTracks: [{ key: 'props.volume', keyframes: [{ frame: 0, value: 1, easing: 'linear' as const }, { frame: 89, value: 0.1, easing: 'linear' as const }] }] };
    p.scenes[0].elements = [video];
    const detached = execute(createDocState(p), { type: 'detachVideoAudio', sceneId: p.scenes[0].id, elementId: video.id, clipId: 'aud_detached' });
    expect(detached.ok).toBe(true);
    if (!detached.ok) return;
    const clip = detached.state.project.audio.find((c) => c.id === 'aud_detached')!;
    const span = dragAudioSpan({ clip, base: 0, total: 720, mode: 'end', df: -30, targets: [], threshold: 0 });
    const edit = previewCommand(detached.state.project, { kind: 'audio', clipId: clip.id, mode: 'end', span })!;
    const trimmed = execute(detached.state, edit.command);
    expect(trimmed.ok, trimmed.ok ? '' : trimmed.error.message).toBe(true);
    if (!trimmed.ok) return;
    const after = trimmed.state.project.audio.find((c) => c.id === clip.id)!;
    expect(after.durationInFrames).toBe(60);
    expect(after.volumeEnvelope?.at(-1)?.frame).toBe(60);
    expect(after.volumeEnvelope?.at(-1)?.value).toBeCloseTo(envelopeAt(clip.volumeEnvelope, 60));
    expect(trimmed.state.undoStack.length).toBe(detached.state.undoStack.length + 1);
    expect(undo(trimmed.state).project.audio).toEqual(detached.state.project.audio);
  });

  it('preserves every retained gain sample when trimming a ducking curve from both ends', () => {
    const p = project();
    const duck = duckUnder(p, 'aud_music', ['aud_whoosh']);
    expect(duck.ok).toBe(true);
    if (!duck.ok) return;
    const applied = applyCommand(p, duck.command, { source: 'user' });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    const before = applied.project.audio[0];
    const span = { startFrame: 215, trimStartFrames: 215, durationInFrames: 60 };
    const edit = previewCommand(applied.project, { kind: 'audio', clipId: before.id, mode: 'start', span })!;
    const trimmed = applyCommand(applied.project, edit.command, { source: 'user' });
    expect(trimmed.ok, trimmed.ok ? '' : trimmed.error.message).toBe(true);
    if (!trimmed.ok) return;
    for (let f = 0; f <= 60; f++) expect(envelopeAt(trimmed.project.audio[0].volumeEnvelope, f)).toBeCloseTo(envelopeAt(before.volumeEnvelope, f + 215));
  });
});
