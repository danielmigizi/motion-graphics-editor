// Audio in AI patches: the project-audio target, scene-anchored clips,
// scope, locks, stale/reconcile, one revision per patch, and the review's
// words for audio changes.

import { describe, expect, it } from 'vitest';
import { fixtureProject } from './__fixtures__/fixtureProject';
import { createDocState, execute, undo } from './history';
import { applyPatch, checkPatch, touchIntersects } from './patch';
import { affectedRange, checkProposal, describeAudioChanges, describeProposal, targetName, type Proposal } from './proposal';
import { projectDurationInFrames, sceneStartFrames } from './timing';
import { PATCH_PROTOCOL, type AiPatch, type Command, type DocState } from './types';

const fresh = () => createDocState(structuredClone(fixtureProject));

function run(doc: DocState, command: Command): DocState {
  const r = execute(doc, command);
  if (!r.ok) throw new Error(r.error.message);
  return r.state;
}

const patchOf = (doc: DocState, targets: AiPatch['targets'], commands: Command[], summary = 'Audio edit'): AiPatch => ({
  protocol: PATCH_PROTOCOL,
  projectId: doc.project.id,
  baseRevision: doc.project.revision,
  summary,
  targets,
  commands,
});

const bedVolume = (volume: number): Command => ({ type: 'updateAudioClip', clipId: 'aud_music', changes: { volume } });
const whooshVolume = (volume: number): Command => ({ type: 'updateAudioClip', clipId: 'aud_whoosh', changes: { volume } });

describe('audio in AI patches', () => {
  it('acceptance: the uploaded track under the whole video, a 2 s fade-out, every scene cut on a beat — one revision, one undo', () => {
    // The user uploaded a 100 BPM track (a beat every 18 frames at 30 fps).
    let doc = run(fresh(), { type: 'addAsset', asset: { id: 'ast_track', kind: 'audio', name: 'Uploaded track', src: 'assets/uploads/u_track.mp3', mimeType: 'audio/mpeg', durationInFrames: 1800 } });
    const before = doc.project;
    // Beats from editor_get_beats: 0, 18, 36, … Scene cuts snapped to the nearest beat.
    const beat = 18;
    const lengths = [210, 270, 240].map((n) => Math.ceil(n / beat) * beat);
    const total = lengths.reduce((a, b) => a + b, 0);
    const patch = patchOf(
      doc,
      [{ audio: 'project' }, { sceneId: 'scn_intro' }, { sceneId: 'scn_product' }, { sceneId: 'scn_outro' }],
      [
        { type: 'removeAudioClip', clipId: 'aud_music' },
        { type: 'addAudioClip', clip: { id: 'aud_track', assetId: 'ast_track', name: 'Uploaded track', startFrame: 0, trimStartFrames: 0, durationInFrames: total, volume: 0.6, fadeInFrames: 0, fadeOutFrames: 60 } },
        { type: 'updateScene', sceneId: 'scn_intro', changes: { durationInFrames: lengths[0] } },
        { type: 'updateScene', sceneId: 'scn_product', changes: { durationInFrames: lengths[1] } },
        { type: 'updateScene', sceneId: 'scn_outro', changes: { durationInFrames: lengths[2] } },
      ],
      'Track under the whole video, cuts on beats',
    );
    const r = applyPatch(doc, patch, { actor: 'Claude Code' });
    if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
    doc = r.state;
    expect(doc.project.revision).toBe(before.revision + 1);
    expect(doc.undoStack).toHaveLength(2); // the upload + the patch
    expect(doc.revisions.at(-1)).toMatchObject({ source: 'ai', label: 'Claude Code: Track under the whole video, cuts on beats' });
    const track = doc.project.audio.find((c) => c.id === 'aud_track')!;
    expect(track.sceneId).toBeUndefined();
    expect(track.durationInFrames).toBe(projectDurationInFrames(doc.project));
    expect(track.fadeOutFrames).toBe(60);
    for (const start of sceneStartFrames(doc.project)) expect(start % beat).toBe(0);
    expect(doc.project.audio.some((c) => c.id === 'aud_music')).toBe(false);
    // The whoosh stays anchored to its scene.
    expect(doc.project.audio.find((c) => c.id === 'aud_whoosh')?.sceneId).toBe('scn_product');
    doc = undo(doc);
    expect(doc.project.audio).toEqual(before.audio);
    expect(doc.project.scenes.map((s) => s.durationInFrames)).toEqual(before.scenes.map((s) => s.durationInFrames));
  });

  it('project-level clips need the audio target; anchored clips need their scene target', () => {
    const doc = fresh();
    const outside = checkPatch(doc, patchOf(doc, [{ sceneId: 'scn_intro' }], [bedVolume(0.4)]));
    expect(outside).toMatchObject({ ok: false, error: { code: 'OUT_OF_SCOPE', path: 'commands[0]' } });
    if (!outside.ok) expect(outside.error.message).toContain('{ "audio": "project" }');
    expect(checkPatch(doc, patchOf(doc, [{ audio: 'project' }], [bedVolume(0.4)])).ok).toBe(true);

    // The whoosh is anchored to scn_product: the audio target does not cover it, an element target does not either.
    expect(checkPatch(doc, patchOf(doc, [{ audio: 'project' }], [whooshVolume(0.5)]))).toMatchObject({ ok: false, error: { code: 'OUT_OF_SCOPE' } });
    expect(checkPatch(doc, patchOf(doc, [{ sceneId: 'scn_product', elementId: 'el_product_card' }], [whooshVolume(0.5)]))).toMatchObject({ ok: false, error: { code: 'OUT_OF_SCOPE' } });
    expect(checkPatch(doc, patchOf(doc, [{ sceneId: 'scn_product' }], [whooshVolume(0.5)])).ok).toBe(true);

    // Adding: by where the new clip lives.
    const sfx: Command = { type: 'addAudioClip', clip: { id: 'aud_pop', assetId: 'ast_whoosh', name: 'Pop', sceneId: 'scn_intro', startFrame: 10, trimStartFrames: 0, durationInFrames: 20, volume: 0.8, fadeInFrames: 0, fadeOutFrames: 0 } };
    expect(checkPatch(doc, patchOf(doc, [{ audio: 'project' }], [sfx]))).toMatchObject({ ok: false, error: { code: 'OUT_OF_SCOPE' } });
    expect(checkPatch(doc, patchOf(doc, [{ sceneId: 'scn_intro' }], [sfx])).ok).toBe(true);
    // A clip added earlier in the same patch is in scope for later commands.
    expect(checkPatch(doc, patchOf(doc, [{ sceneId: 'scn_intro' }], [sfx, { type: 'updateAudioClip', clipId: 'aud_pop', changes: { volume: 0.5 } }])).ok).toBe(true);

    // Moving a clip from one scene to another needs both scenes.
    const move: Command = { type: 'updateAudioClip', clipId: 'aud_whoosh', changes: { sceneId: 'scn_outro' } };
    expect(checkPatch(doc, patchOf(doc, [{ sceneId: 'scn_product' }], [move]))).toMatchObject({ ok: false, error: { code: 'OUT_OF_SCOPE' } });
    const moved = checkPatch(doc, patchOf(doc, [{ sceneId: 'scn_product' }, { sceneId: 'scn_outro' }], [move]));
    expect(moved.ok && moved.project.audio.find((c) => c.id === 'aud_whoosh')?.sceneId).toBe('scn_outro');
  });

  it('a locked scene locks its sound effects (LOCKED); the music bed is not locked by it', () => {
    let doc = run(fresh(), { type: 'setSceneLock', sceneId: 'scn_product', locked: true });
    expect(applyPatch(doc, patchOf(doc, [{ sceneId: 'scn_product' }], [whooshVolume(0.2)]))).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    expect(applyPatch(doc, patchOf(doc, [{ sceneId: 'scn_product' }], [{ type: 'removeAudioClip', clipId: 'aud_whoosh' }]))).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    // Anchoring a new effect into the locked scene.
    const sfx: Command = { type: 'addAudioClip', clip: { id: 'aud_pop', assetId: 'ast_whoosh', name: 'Pop', sceneId: 'scn_product', startFrame: 0, trimStartFrames: 0, durationInFrames: 20, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 } };
    expect(applyPatch(doc, patchOf(doc, [{ sceneId: 'scn_product' }], [sfx]))).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    // The project music bed is still editable.
    const r = applyPatch(doc, patchOf(doc, [{ audio: 'project' }], [bedVolume(0.4)]));
    expect(r.ok).toBe(true);
    doc = r.ok ? r.state : doc;
    expect(doc.project.audio.find((c) => c.id === 'aud_music')?.volume).toBe(0.4);
  });

  it('stale audio patches are refused; reconcile goes through only when the audio it targets did not change', () => {
    const base = fresh();
    const bedPatch = patchOf(base, [{ audio: 'project' }], [bedVolume(0.4)]);
    const sfxPatch = patchOf(base, [{ sceneId: 'scn_product' }], [whooshVolume(0.5)]);

    // The user changes the music bed after the agent read r1.
    const bedEdited = run(base, bedVolume(0.5));
    expect(applyPatch(bedEdited, bedPatch)).toMatchObject({ ok: false, error: { code: 'STALE' } });
    const stale = checkPatch(bedEdited, bedPatch, { reconcile: true });
    expect(stale).toMatchObject({ ok: false, error: { code: 'STALE' }, conflicts: [{ audio: 'project' }] });
    // An edit to the bed does not touch the product scene's sound effect.
    expect(applyPatch(bedEdited, sfxPatch, { reconcile: true }).ok).toBe(true);

    // The user changes the anchored whoosh: the scene target conflicts, the audio target does not.
    const sfxEdited = run(base, whooshVolume(0.1));
    expect(checkPatch(sfxEdited, sfxPatch, { reconcile: true })).toMatchObject({ ok: false, error: { code: 'STALE' }, conflicts: [{ sceneId: 'scn_product' }] });
    expect(applyPatch(sfxEdited, bedPatch, { reconcile: true }).ok).toBe(true);
  });

  it('a clip moved between a scene and the project timeline conflicts with both', () => {
    const base = fresh();
    const sfxPatch = patchOf(base, [{ sceneId: 'scn_product' }], [{ type: 'updateScene', sceneId: 'scn_product', changes: { name: 'Product!' } }]);
    const bedPatch = patchOf(base, [{ audio: 'project' }], [bedVolume(0.3)]);
    // The whoosh leaves the product scene for the project timeline (absolute frame 210).
    const moved = run(base, { type: 'batch', label: 'Unanchor', commands: [{ type: 'removeAudioClip', clipId: 'aud_whoosh' }, { type: 'addAudioClip', clip: { ...fixtureProject.audio[1], sceneId: undefined, startFrame: 210 } }] });
    expect(checkPatch(moved, sfxPatch, { reconcile: true })).toMatchObject({ ok: false, error: { code: 'STALE' } });
    expect(checkPatch(moved, bedPatch, { reconcile: true })).toMatchObject({ ok: false, error: { code: 'STALE' } });
  });

  it('touchIntersects: audio touches by where the clip lives', () => {
    const scopes = (id: string) => new Set(id === 'aud_whoosh' ? ['scn_product'] : [null]);
    const whoosh = { kind: 'audio' as const, clipId: 'aud_whoosh' };
    const bed = { kind: 'audio' as const, clipId: 'aud_music' };
    expect(touchIntersects(bed, { audio: 'project' }, scopes)).toBe(true);
    expect(touchIntersects(bed, { sceneId: 'scn_product' }, scopes)).toBe(false);
    expect(touchIntersects(whoosh, { audio: 'project' }, scopes)).toBe(false);
    expect(touchIntersects(whoosh, { sceneId: 'scn_product' }, scopes)).toBe(true);
    expect(touchIntersects(whoosh, { sceneId: 'scn_product', elementId: 'el_product_card' }, scopes)).toBe(false);
    expect(touchIntersects(whoosh, { sceneId: 'scn_intro' }, scopes)).toBe(false);
    // Scene and element touches never hit the audio target.
    expect(touchIntersects({ kind: 'scene', sceneId: 'scn_intro' }, { audio: 'project' }, scopes)).toBe(false);
  });
});

describe('audio changes in the review', () => {
  const proposal = (patch: AiPatch): Proposal => ({ id: 'p', projectId: patch.projectId, docSession: 's', patch, agent: 'Codex', source: 'mcp', reconcile: true, createdAt: 0 });

  it('names the change in words', () => {
    const doc = fresh();
    const patch = patchOf(doc, [{ audio: 'project' }], [{ type: 'updateAudioClip', clipId: 'aud_music', changes: { volume: 0.4, fadeOutFrames: 60 } }]);
    const c = checkProposal(doc, proposal(patch));
    if (c.status !== 'ready') throw new Error('not ready');
    expect(describeAudioChanges(doc.project, c.candidate)).toEqual([{ clipId: 'aud_music', name: 'Music bed', frame: 0, text: 'Music bed: volume 60% → 40%, fade-out 1.5 s → 2 s' }]);
    expect(describeProposal(c.diff, c.candidate).headline).toBe('2 changes to “Music bed”');
    // The whole bed is audible change: the affected range is the clip's span.
    expect(affectedRange(doc.project, c.candidate, c.touched)).toEqual({ start: 0, end: 719 });
  });

  it('describes added, removed, moved and ducked clips', () => {
    const p = fixtureProject;
    const after = {
      ...p,
      audio: [
        { ...p.audio[0], fadeInFrames: 0, volumeEnvelope: [{ frame: 0, value: 1 }, { frame: 30, value: 0.25 }, { frame: 90, value: 0.25 }, { frame: 102, value: 1 }] },
        { id: 'aud_pop', assetId: 'ast_whoosh', name: 'Pop', sceneId: 'scn_intro', startFrame: 15, trimStartFrames: 0, durationInFrames: 10, volume: 0.8, fadeInFrames: 0, fadeOutFrames: 0 },
      ],
    };
    expect(describeAudioChanges(p, after).map((a) => a.text)).toEqual([
      'Music bed: no fade-in, ducks to 25% (-12 dB)',
      'Pop: added in “Intro” at 0:00:15, volume 80%',
      'Whoosh: removed',
    ]);
    // A sound effect that only rides along with its retimed scene is listed last, as such.
    const retimed = { ...p, scenes: p.scenes.map((sc) => (sc.id === 'scn_intro' ? { ...sc, durationInFrames: 216 } : sc)) };
    expect(describeAudioChanges(p, retimed).map((a) => a.text)).toEqual(['Whoosh: moves with “Product”, 0:07:00 → 0:07:06']);
    const sfxRange = affectedRange(p, after, [{ kind: 'audio', clipId: 'aud_pop' }]);
    expect(sfxRange).toEqual({ start: 15, end: 24 });
  });

  it('names the project-audio target for stale notices', () => {
    expect(targetName(fixtureProject, { audio: 'project' })).toBe('the project audio (“Music bed”)');
    expect(targetName(fixtureProject, { sceneId: 'scn_intro' })).toBe('scene “Intro”');
    expect(targetName(fixtureProject, { style: 'project' })).toBe('the project style');
  });
});

describe('detachVideoAudio in AI patches', () => {
  it('needs a scene target and is refused as out of scope with only an element target', () => {
    const state = createDocState(structuredClone(fixtureProject));
    const scene = state.project.scenes[0];
    const el = scene.elements[0];
    const patch: AiPatch = {
      protocol: PATCH_PROTOCOL,
      projectId: state.project.id,
      baseRevision: state.project.revision,
      summary: 'Detach the soundtrack',
      targets: [{ sceneId: scene.id, elementId: el.id }],
      commands: [{ type: 'detachVideoAudio', sceneId: scene.id, elementId: el.id, clipId: 'aud_detached' }],
    };
    const r = checkPatch(state, patch);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OUT_OF_SCOPE');
    // With the scene target the scope check passes (the command itself then judges the element).
    const r2 = checkPatch(state, { ...patch, targets: [{ sceneId: scene.id }] });
    if (!r2.ok) expect(r2.error.code).not.toBe('OUT_OF_SCOPE');
  });
});
