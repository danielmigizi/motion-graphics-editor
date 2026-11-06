import { describe, expect, it } from 'vitest';
import { fixtureProject } from './__fixtures__/fixtureProject';
import { applyCommand } from './commands';
import { createDocState, execute, undo } from './history';
import { checkPatch } from './patch';
import { buildSkeletonProject, parseOutline, updateOutlineScene, type VideoBrief } from './outline';
import { applyStagger, PRESETS, presetAppliesTo, presetCommands, staggerPlan, defaultPresetOptions } from './presets';
import { buildTemplate } from './templates';
import { PATCH_PROTOCOL, type AiPatch, type Project } from './types';
import { element } from './__fixtures__/schema2Project';
import { trimVideoSpan } from './video';
import { COMPONENTS } from './components';
import { validateProject } from './validate';

const fresh = (): Project => structuredClone(fixtureProject);
const convert = (fps: number) => ({ type: 'changeFormat' as const, width: 1920, height: 1080, fps, conversion: { layout: 'none' as const, timing: 'keepSeconds' as const } });

describe('core regressions', () => {
  it('rejects a duplicate audio ID before an atomic batch can hide it', () => {
    const p = fresh();
    const clip = { ...p.audio[0], sceneId: 'scn_intro', startFrame: 0, durationInFrames: 30, fadeInFrames: 0, fadeOutFrames: 0 };
    const commands = [{ type: 'addAudioClip' as const, clip }, { type: 'removeAudioClip' as const, clipId: clip.id }];
    const patch: AiPatch = { protocol: PATCH_PROTOCOL, projectId: p.id, baseRevision: p.revision, summary: 'Scoped audio', targets: [{ sceneId: 'scn_intro' }], commands };
    expect(checkPatch(createDocState(p), patch).ok).toBe(false);
    expect(applyCommand(p, { type: 'batch', label: 'Duplicate', commands }, { source: 'user' })).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    expect(p.audio).toHaveLength(2);
  });

  it.each([24, 60])('rescales ducking envelope frames at %s fps', (fps) => {
    const p = fresh();
    p.audio[0].volumeEnvelope = [{ frame: 0, value: 1 }, { frame: 120, value: 0.25 }, { frame: 300, value: 0.25 }, { frame: 720, value: 1 }];
    const r = applyCommand(p, convert(fps), { source: 'user' });
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
    if (!r.ok) return;
    expect(r.project.audio[0].volumeEnvelope?.map((point) => point.frame)).toEqual([0, 120, 300, 720].map((f) => Math.round(f * fps / 30)));
    expect(validateProject(r.project).ok).toBe(true);
  });

  it('resolves rounded envelope collisions when converting to fewer frames', () => {
    const p = fresh();
    p.audio[0].volumeEnvelope = [{ frame: 0, value: 1 }, { frame: 1, value: 0.5 }, { frame: 2, value: 0.2 }, { frame: 720, value: 1 }];
    const r = applyCommand(p, convert(15), { source: 'user' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.audio[0].volumeEnvelope).toEqual([{ frame: 0, value: 1 }, { frame: 1, value: 0.2 }, { frame: 360, value: 1 }]);
  });

  it('marks a pending project-audio proposal stale after timing conversion', () => {
    const doc = createDocState(fresh());
    const patch: AiPatch = { protocol: PATCH_PROTOCOL, projectId: doc.project.id, baseRevision: doc.project.revision, summary: 'Two-second fade', targets: [{ audio: 'project' }], commands: [{ type: 'updateAudioClip', clipId: 'aud_music', changes: { fadeOutFrames: 60 } }] };
    const r = execute(doc, convert(60));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(checkPatch(r.state, patch, { reconcile: true })).toMatchObject({ ok: false, error: { code: 'STALE' } });
    expect(r.state.revisions.at(-1)?.touched).toEqual(expect.arrayContaining([{ kind: 'audio', clipId: 'aud_music' }]));
    expect(undo(r.state).project.audio).toEqual(doc.project.audio);
  });

  it('keeps precise outline durations through parsing, editing and cumulative frame rounding', () => {
    const parsed = parseOutline({ title: 'Beat cuts', scenes: Array.from({ length: 3 }, (_, i) => ({ name: `Beat ${i}`, purpose: '', durationSeconds: 124 / 30 })) });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const outline = updateOutlineScene(parsed.outline, 'ol_2', { durationSeconds: 124 / 30 });
    expect(outline.scenes.map((s) => s.durationSeconds)).toEqual([124 / 30, 124 / 30, 124 / 30]);
    const p = fresh();
    const brief: VideoBrief = { brief: '', audience: '', tone: '', targetSeconds: 12.4, width: p.width, height: p.height, fps: 30, backgroundColor: p.backgroundColor, brandColors: [], files: [] };
    const ids = { project: 'beat', scene: (i: number) => `s${i}`, audioClip: () => 'bed' };
    expect(buildSkeletonProject(outline, brief, ids).scenes.map((s) => s.durationInFrames)).toEqual([124, 124, 124]);
    const fractional = { ...outline, scenes: outline.scenes.map((s) => ({ ...s, durationSeconds: 4.15 })) };
    expect(buildSkeletonProject(fractional, brief, ids).scenes.map((s) => s.durationInFrames)).toEqual([125, 124, 125]);
  });

  it('clamps looping-video start trims to a valid source in-point', () => {
    const span = trimVideoSpan({ start: 0, dur: 180, trim: 0 }, { start: 90, dur: 90 }, 'start', 1, 60, true);
    expect(span).toEqual({ start: 59, dur: 121, trim: 59 });
    const p = fresh();
    p.assets.loop = { id: 'loop', kind: 'video', name: 'Loop', src: 'assets/loop.mp4', mimeType: 'video/mp4', durationInFrames: 60 };
    const v = element('looped', 'video', { startFrame: 0, durationInFrames: 180, props: { ...COMPONENTS.video.defaultProps, assetId: 'loop', loop: true } });
    p.scenes[0].elements = [v];
    expect(applyCommand(p, { type: 'updateElement', sceneId: p.scenes[0].id, elementId: v.id, changes: { startFrame: span.start, durationInFrames: span.dur, props: { trimStartFrames: span.trim } } }, { source: 'user' }).ok).toBe(true);
  });

  it('allows all general visual presets on video and validates their commands', () => {
    const p = fresh();
    p.assets.footage = { id: 'footage', kind: 'video', name: 'Footage', src: 'assets/footage.mp4', mimeType: 'video/mp4', durationInFrames: 120 };
    const v = element('video_footage', 'video', { durationInFrames: 120, props: { ...COMPONENTS.video.defaultProps, assetId: 'footage' } });
    p.scenes[0].elements = [v];
    for (const preset of Object.values(PRESETS).filter((preset) => preset.appliesTo.includes('shape'))) {
      expect(presetAppliesTo(preset, v), preset.id).toBe(true);
      const commands = presetCommands(p.scenes[0].id, v, preset.id, defaultPresetOptions(preset, v, { fps: p.fps }));
      expect(commands.length, preset.id).toBeGreaterThan(0);
      const r = applyCommand(p, { type: 'batch', label: 'Motion', commands }, { source: 'user' });
      expect(r.ok, r.ok ? preset.id : `${preset.id}: ${r.error.path}: ${r.error.message}`).toBe(true);
    }
  });

  it('preserves reading order and stagger with different layer start times', () => {
    const left = element('left', 'shape', { startFrame: 30, durationInFrames: 120 });
    const right = element('right', 'shape', { startFrame: 0, durationInFrames: 120, transform: { ...left.transform, x: 200 } });
    const plan = staggerPlan([right, left], 'riseIn', { fps: 30 });
    expect(plan.map(({ element, options }) => element.startFrame + options.at)).toEqual([30, 34]);
    const late = { ...left, startFrame: 100 };
    const short = { ...right, durationInFrames: 20 };
    expect(applyStagger([late, short], 'riseIn', { fps: 30, sceneId: 's' })).toEqual([]);
  });

  it.each(['statReveal', 'testimonial'] as const)('inserts %s into a 4K project as one valid batch', (id) => {
    const p = { ...fresh(), width: 3840, height: 2160 };
    let n = 0;
    const built = buildTemplate(id, {}, { sceneId: 'scn_product', at: 0, project: p, newId: () => `tpl${++n}` });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const r = execute(createDocState(p), { type: 'batch', label: built.label, commands: built.commands });
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
    if (r.ok) expect(r.state.undoStack).toHaveLength(1);
    for (const text of built.elements.filter((e) => e.type === 'text')) expect(Number(text.props.fontSize)).toBeLessThanOrEqual(400);
  });
});
