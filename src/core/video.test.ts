import { describe, expect, it } from 'vitest';
import { element, project as baseProject } from './__fixtures__/schema2Project';
import { applyCommand } from './commands';
import { COMPONENTS } from './components';
import { createDocState, execute, undo } from './history';
import { checkPatch } from './patch';
import { PATCH_PROTOCOL } from './types';
import { audioClipStartFrame } from './timing';
import type { Asset, Element, Project } from './types';
import { validateProject } from './validate';
import { detachedAudioClip, retimeVideo, trimVideoSpan, videoMaxDuration, videoProps, videoSourceFrame } from './video';

const clip = (over: Partial<Asset> = {}): Asset => ({ id: 'ast_clip', kind: 'video', name: 'Recording', src: 'assets/uploads/u_rec.mp4', mimeType: 'video/mp4', width: 1920, height: 1080, durationInFrames: 300, fps: 30, hasAudio: true, ...over });
const video = (id = 'v', props: Record<string, unknown> = {}, over: Partial<Element> = {}): Element =>
  element(id, 'video', { durationInFrames: 100, props: { ...COMPONENTS.video.defaultProps, assetId: 'ast_clip', ...props }, ...over });

function project(elements: Element[], assets: Asset[] = [clip()]): Project {
  const p = baseProject(elements);
  p.scenes[0].durationInFrames = 200;
  p.scenes.push({ id: 's2', name: 'Second', durationInFrames: 60, backgroundColor: '#000', locked: false, transitionIn: { type: 'none', durationInFrames: 0 }, elements: [] });
  for (const a of assets) p.assets[a.id] = a;
  return p;
}

describe('video timing', () => {
  it('maps element frames to source frames: trim + local × rate, wrapping when looping', () => {
    expect(videoSourceFrame(30, 2, 0)).toBe(30);
    expect(videoSourceFrame(30, 2, 47)).toBe(124);
    expect(videoSourceFrame(7, 0.5, 15)).toBe(14.5);
    expect(videoSourceFrame(100, 1, 250, true, 300)).toBe(150); // 100 + (250 % 200)
    expect(videoSourceFrame(100, 1, 250, false, 300)).toBe(350);
  });

  it('bounds the element by the trimmed source ÷ speed unless it loops', () => {
    expect(videoMaxDuration(300, 0, 1, false)).toBe(300);
    expect(videoMaxDuration(300, 30, 2, false)).toBe(135);
    expect(videoMaxDuration(300, 0, 0.35, false)).toBe(857);
    expect(videoMaxDuration(300, 0, 1, true)).toBe(Infinity);
    expect(videoMaxDuration(undefined, 0, 1, false)).toBe(Infinity);
  });

  it('reads props with defaults and clamps speed', () => {
    expect(videoProps({ props: {} })).toMatchObject({ assetId: '', trimStartFrames: 0, playbackRate: 1, volume: 1, muted: false, loop: false, fit: 'cover' });
    expect(videoProps({ props: { playbackRate: 9, fit: 'contain' } })).toMatchObject({ playbackRate: 4, fit: 'contain' });
  });

  it('timeline start trims move the in-point with the edge (× speed) and stop at the file start', () => {
    const orig = { start: 20, dur: 60, trim: 30 };
    // Drag the start edge 10 frames right at 2×: in-point +20, end stays.
    expect(trimVideoSpan(orig, { start: 30, dur: 50 }, 'start', 2, 300, false)).toEqual({ start: 30, dur: 50, trim: 50 });
    // Drag left past the file start: in-point hits 0 after 15 frames at 2×.
    expect(trimVideoSpan(orig, { start: 0, dur: 80 }, 'start', 2, 300, false)).toEqual({ start: 5, dur: 75, trim: 0 });
    // End edge never runs past the source.
    expect(trimVideoSpan(orig, { start: 20, dur: 500 }, 'end', 2, 300, false)).toEqual({ start: 20, dur: 135, trim: 30 });
    expect(trimVideoSpan(orig, { start: 20, dur: 500 }, 'end', 2, 300, true).dur).toBe(500);
    // Moving keeps the in-point.
    expect(trimVideoSpan(orig, { start: 40, dur: 60 }, 'move', 2, 300, false)).toEqual({ start: 40, dur: 60, trim: 30 });
  });

  it('retiming shortens the element when the source no longer fills it', () => {
    const p = project([video('v', { trimStartFrames: 100 }, { durationInFrames: 180 })]);
    expect(retimeVideo(p.scenes[0].elements[0], 2, p.assets)).toEqual({ playbackRate: 2, durationInFrames: 100 });
    expect(retimeVideo(p.scenes[0].elements[0], 0.5, p.assets)).toEqual({ playbackRate: 0.5, durationInFrames: 180 });
  });
});

describe('video validation', () => {
  it('accepts a video inside its bounds and rejects running past the trimmed source', () => {
    expect(validateProject(project([video('v', { trimStartFrames: 100, playbackRate: 2 })])).ok).toBe(true);
    const r = validateProject(project([video('v', { trimStartFrames: 100, playbackRate: 2 }, { durationInFrames: 101 })]));
    expect(r).toMatchObject({ ok: false, error: { path: 'scenes[0].elements[0].durationInFrames' } });
    if (!r.ok) expect(r.error.message).toContain('has only 100 frames left');
    expect(validateProject(project([video('v', { trimStartFrames: 100, playbackRate: 2, loop: true }, { durationInFrames: 190 })])).ok).toBe(true);
  });

  it('rejects an in-point past the end, a non-video file, and an out-of-range speed', () => {
    expect(validateProject(project([video('v', { trimStartFrames: 300 }, { durationInFrames: 1 })]))).toMatchObject({ ok: false, error: { path: 'scenes[0].elements[0].props.trimStartFrames' } });
    expect(validateProject(project([video('v', { playbackRate: 5 })]))).toMatchObject({ ok: false, error: { path: 'scenes[0].elements[0].props.playbackRate' } });
    const img: Asset = { id: 'ast_img', kind: 'image', name: 'Shot', src: 'assets/shot.png', mimeType: 'image/png' };
    expect(validateProject(project([video('v', { assetId: 'ast_img' })], [clip(), img]))).toMatchObject({ ok: false, error: { path: 'scenes[0].elements[0].props.assetId' } });
  });

  it('lets an audio clip play a video file with sound, but not one without', () => {
    const p = project([]);
    p.audio.push({ id: 'aud_v', assetId: 'ast_clip', name: 'Video sound', sceneId: 's', startFrame: 0, trimStartFrames: 0, durationInFrames: 60, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 });
    expect(validateProject(p).ok).toBe(true);
    p.assets.ast_clip = clip({ hasAudio: false });
    expect(validateProject(p)).toMatchObject({ ok: false, error: { path: 'audio[0].assetId' } });
  });

  it('volume is animatable; changeFormat rescales the in-point and keeps the bound', () => {
    const v = video('v', { trimStartFrames: 30 }, { durationInFrames: 200, propTracks: [{ key: 'props.volume', keyframes: [{ frame: 0, value: 0, easing: 'linear' }, { frame: 30, value: 1, easing: 'linear' }] }] });
    const p = project([v]);
    expect(validateProject(p).ok).toBe(true);
    const r = applyCommand(p, { type: 'changeFormat', width: 1000, height: 600, fps: 24, conversion: { layout: 'none', timing: 'keepSeconds' } }, { source: 'user' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const el = r.project.scenes[0].elements[0];
    expect(el.props.trimStartFrames).toBe(24);
    expect(r.project.assets.ast_clip.durationInFrames).toBe(240);
    expect(el.durationInFrames).toBeLessThanOrEqual(videoMaxDuration(240, 24, 1, false));
  });
});

describe('detachVideoAudio', () => {
  const detach = { type: 'detachVideoAudio' as const, sceneId: 's', elementId: 'v', clipId: 'aud_det' };

  it('makes a scene-anchored clip with the same source, in-point and timing, mutes the element, one undo step', () => {
    const p = project([video('v', { trimStartFrames: 45, volume: 0.6 }, { startFrame: 12, durationInFrames: 90 })]);
    const state = createDocState(p);
    const r = execute(state, detach, 'user', 'Detach audio');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const after = r.state.project;
    expect(after.audio.at(-1)).toEqual({ id: 'aud_det', assetId: 'ast_clip', name: 'v audio', sceneId: 's', startFrame: 12, trimStartFrames: 45, durationInFrames: 90, volume: 0.6, fadeInFrames: 0, fadeOutFrames: 0 });
    expect(after.scenes[0].elements[0].props.muted).toBe(true);
    expect(r.state.undoStack).toHaveLength(1);
    // Undo restores the attached state.
    const back = undo(r.state).project;
    expect(back.audio).toEqual(p.audio);
    expect(back.scenes[0].elements[0].props.muted).toBe(false);
  });

  it('moving the video by 10 frames afterwards leaves the detached audio where it was; reordering scenes carries it', () => {
    const p = project([video('v', {}, { startFrame: 12, durationInFrames: 90 })]);
    const d = applyCommand(p, detach, { source: 'user' });
    if (!d.ok) throw new Error(d.error.message);
    const moved = applyCommand(d.project, { type: 'updateElement', sceneId: 's', elementId: 'v', changes: { startFrame: 22 } }, { source: 'user' });
    if (!moved.ok) throw new Error(moved.error.message);
    const c = moved.project.audio.find((a) => a.id === 'aud_det')!;
    expect(c.startFrame).toBe(12);
    expect(audioClipStartFrame(moved.project, c)).toBe(12);
    const reordered = applyCommand(moved.project, { type: 'moveScene', sceneId: 's', toIndex: 1 }, { source: 'user' });
    if (!reordered.ok) throw new Error(reordered.error.message);
    expect(audioClipStartFrame(reordered.project, c)).toBe(60 + 12);
  });

  it('inside a group: uses the scene-relative start and only the part the group lets play', () => {
    const group = element('g', 'group', { startFrame: 20, durationInFrames: 50 });
    // The group (50 frames) clips the end of the 100-frame video.
    const v = video('v', { trimStartFrames: 10 }, { parentId: 'g', startFrame: 0, durationInFrames: 100 });
    const p = project([group, v]);
    expect(validateProject(p).ok).toBe(true);
    const r = detachedAudioClip(p, p.scenes[0], v, 'aud_g');
    expect(r).toMatchObject({ ok: true, clip: { startFrame: 20, trimStartFrames: 10, durationInFrames: 50 } });
  });

  it('turns an animated volume into the clip envelope', () => {
    const v = video('v', {}, { durationInFrames: 60, propTracks: [{ key: 'props.volume', keyframes: [{ frame: 0, value: 0, easing: 'linear' }, { frame: 30, value: 1, easing: 'linear' }] }] });
    const p = project([v]);
    const r = applyCommand(p, detach, { source: 'user' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const c = r.project.audio.at(-1)!;
    expect(c.volume).toBe(1);
    expect(c.volumeEnvelope).toEqual([{ frame: 0, value: 0 }, { frame: 30, value: 1 }, { frame: 60, value: 1 }]);
  });

  it.each([
    ['a sped-up video', video('v', { playbackRate: 2 }), 'Speed to 1×'],
    ['a looping video longer than one pass', video('v', { loop: true, trimStartFrames: 250 }, { durationInFrames: 100 }), 'Loop off'],
  ])('refuses %s with a hint', (_name, el, hint) => {
    const r = applyCommand(project([el]), detach, { source: 'user' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.hint).toContain(hint);
  });

  it('refuses a muted video, so the same soundtrack is never detached twice', () => {
    const once = applyCommand(project([video()]), detach, { source: 'user' });
    if (!once.ok) throw new Error(once.error.message);
    expect(applyCommand(once.project, { ...detach, clipId: 'aud_again' }, { source: 'user' })).toMatchObject({ ok: false, error: { hint: 'Unmute it first to detach its soundtrack.' } });
  });

  it('refuses a silent video, a non-video element and a locked scene', () => {
    expect(applyCommand(project([video()], [clip({ hasAudio: false })]), detach, { source: 'user' })).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    expect(applyCommand(project([element('v')]), detach, { source: 'user' })).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'elementId' } });
    const locked = project([video()]);
    locked.scenes[0].locked = true;
    expect(applyCommand(locked, detach, { source: 'user' })).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
  });
});

describe('agents', () => {
  it('may change video props in a patch scoped to the element, and the guide documents the element', async () => {
    const p = project([video('v', {}, { durationInFrames: 200 })]);
    const state = createDocState(p);
    const patch = {
      protocol: PATCH_PROTOCOL, projectId: p.id, baseRevision: p.revision, summary: 'Trim to the dashboard, 2×',
      targets: [{ sceneId: 's', elementId: 'v' }],
      commands: [{ type: 'updateElement' as const, sceneId: 's', elementId: 'v', changes: { durationInFrames: 60, props: { trimStartFrames: 150, playbackRate: 2, volume: 0.5 } } }],
    };
    expect(checkPatch(state, patch).ok).toBe(true);
    // Out of its source: refused with the bound in the message.
    const tooLong = { ...patch, commands: [{ ...patch.commands[0], changes: { durationInFrames: 100, props: { trimStartFrames: 150, playbackRate: 2 } } }] };
    const r = checkPatch(state, tooLong);
    expect(r.ok).toBe(false);
    const { buildAuthoringGuide } = await import('./guide');
    const guide = buildAuthoringGuide();
    expect(guide).toContain('## Video elements');
    expect(guide).toContain('### `video` — Video');
  });
});
