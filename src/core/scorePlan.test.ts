import { describe, expect, it } from 'vitest';
import { fixtureProject } from './__fixtures__/fixtureProject';
import { applyCommand } from './commands';
import { envelopeAt } from './audioDucking';
import { buildScorePlan, planProblem, cutAlignment, narrationLines, placeBedCommands, placeNarrationCommands, snapCutsCommands } from './scorePlan';
import { sceneStartFrames } from './timing';
import type { Asset, Command, Project, StoryBeatRole } from './types';

function project(seconds = [4, 5, 6]): Project {
  return { ...structuredClone(fixtureProject), story: undefined, audio: [], scenes: seconds.map((seconds, i) => ({
    id: `s${i}`, name: `Scene ${i}`, durationInFrames: seconds * 30, locked: false,
    backgroundColor: '#000000', transitionIn: { type: 'none', durationInFrames: 0 }, elements: [],
  })) };
}
const audio = (id: string, durationInFrames = 3000): Asset => ({ id, kind: 'audio', name: id, src: `assets/${id}.mp3`, mimeType: 'audio/mpeg', durationInFrames });
function apply(p: Project, commands: Command[]): Project {
  const result = applyCommand(p, { type: 'batch', label: 'Place score', commands }, { source: 'ai' });
  if (!result.ok) throw new Error(result.error.message);
  return result.project;
}

describe('score and narration plans', () => {
  it('builds one named section per scene and maps every story role to musical direction', () => {
    const roles: StoryBeatRole[] = ['hook', 'setup', 'tension', 'turn', 'proof', 'payoff', 'cta', 'loop'];
    const p = project(roles.map(() => 4));
    p.story = { idea: 'story', hook: 'hook', payoff: 'payoff', beats: roles.map((role, i) => ({ role, summary: `Line ${i}`, sceneId: `s${i}` })) };
    const original = structuredClone(p);
    expect(buildScorePlan(p).map((section) => section.styles)).toEqual([
      ['attention-grabbing intro'], ['steady, establishing'], ['building tension'], ['shift, lift'], ['confident, driving'], ['full, triumphant'], ['resolving, clear ending'], ['loops back to the opening'],
    ]);
    expect(buildScorePlan(p)[0]).toEqual({ sceneIds: ['s0'], seconds: 4, styles: ['attention-grabbing intro'], label: 'Scene 0' });
    expect(narrationLines(p)).toEqual(roles.map((_, i) => ({ sceneId: `s${i}`, text: `Line ${i}` })));
    expect(p).toEqual(original);
  });
  it('merges short scenes into the next, the trailing short scene backward, and preserves duration', () => {
    const p = project([1, 1, 4, 2]);
    expect(buildScorePlan(p).map((section) => [section.sceneIds, section.seconds])).toEqual([[['s0', 's1', 's2', 's3'], 8]]);
    expect(buildScorePlan(project([4, 1, 4])).map((section) => [section.sceneIds, section.seconds])).toEqual([[['s0'], 4], [['s1', 's2'], 5]]);
    expect(buildScorePlan(project([1, 1, 1]))[0].seconds).toBe(3);
  });
  it('splits scenes over 120 seconds without leaving sections below 3 seconds', () => {
    for (const seconds of [120, 121, 241]) {
      const sections = buildScorePlan(project([seconds]));
      expect(sections).toHaveLength(Math.ceil(seconds / 120));
      expect(sections.reduce((sum, section) => sum + section.seconds, 0)).toBeCloseTo(seconds);
      expect(sections.every((section) => section.seconds >= 3 && section.seconds <= 120 && section.sceneIds[0] === 's0')).toBe(true);
    }
  });
  it('handles absent story, scene-name mappings, multiple summaries, empty and sub-three-second videos', () => {
    expect(buildScorePlan(project())[0].styles).toEqual([]);
    const p = project();
    p.story = { idea: '', hook: '', payoff: '', beats: [{ role: 'hook', summary: 'One.', sceneName: 'Scene 0' }, { role: 'proof', summary: 'Two.', sceneId: 's0' }, { role: 'cta', summary: 'Wrong id', sceneId: 'elsewhere', sceneName: 'Scene 0' }] };
    expect(narrationLines(p)).toEqual([{ sceneId: 's0', text: 'One. Two.' }, { sceneId: 's1', text: '' }, { sceneId: 's2', text: '' }]);
    expect(buildScorePlan(project([]))).toEqual([]);
    expect(narrationLines(project([]))).toEqual([]);
    expect(buildScorePlan(project([1]))[0].seconds).toBe(1);
  });
});

describe('cut alignment and snapping', () => {
  it('finds the closest downbeat in a bar, handles ties, unsorted input and missing tempo', () => {
    const p = project([4, 5, 6]);
    expect(cutAlignment(p, [274, 118, 124, NaN], 120)).toEqual([
      { sceneId: 's1', cutFrame: 120, nearestDownbeatFrame: 118, offsetFrames: -2 },
      { sceneId: 's2', cutFrame: 270, nearestDownbeatFrame: 274, offsetFrames: 4 },
    ]);
    expect(cutAlignment(p, [110, 130], null)[0].nearestDownbeatFrame).toBe(110);
    expect(cutAlignment(p, [180], null)[0].offsetFrames).toBe(60);
    expect(cutAlignment(p, [181], null)[0].nearestDownbeatFrame).toBeNull();
    expect(cutAlignment(p, [], 120).every((cut) => cut.offsetFrames === null)).toBe(true);
  });
  it('snaps successive cuts to absolute downbeats without accumulating drift', () => {
    const p = project();
    const cuts = cutAlignment(p, [124, 272], 120);
    const result = snapCutsCommands(p, cuts);
    expect(result).toMatchObject({ moved: 2, skipped: [] });
    expect(sceneStartFrames(apply(p, result.commands))).toEqual([0, 124, 272]);
    expect(result.commands).toEqual([
      { type: 'updateScene', sceneId: 's0', changes: { durationInFrames: 124 } },
      { type: 'updateScene', sceneId: 's1', changes: { durationInFrames: 148 } },
    ]);
    expect(p.scenes[0].durationInFrames).toBe(120);
  });
  it('skips locked preceding scenes, distant downbeats, unknown cuts and trims through content', () => {
    const p = project();
    p.scenes[0].locked = true;
    const cuts = cutAlignment(p, [124, 280], 120);
    const result = snapCutsCommands(p, [...cuts, { sceneId: 'missing', cutFrame: 0, nearestDownbeatFrame: 0, offsetFrames: 0 }]);
    expect(result.moved).toBe(0);
    expect(result.skipped.map((skip) => skip.why)).toEqual([expect.stringContaining('locked'), expect.stringContaining('maximum shift'), expect.stringContaining('no cut')]);
    p.scenes[0].locked = false;
    p.scenes[0].elements = [{ ...fixtureProject.scenes[0].elements[0], startFrame: 0, durationInFrames: 119 }];
    expect(snapCutsCommands(p, cutAlignment(p, [118], 120)).skipped[0].why).toContain('trim its contents');
    expect(snapCutsCommands(project(), cutAlignment(project(), [], null)).skipped).toHaveLength(2);
    expect(snapCutsCommands(project(), cutAlignment(project(), [120, 270], null)).moved).toBe(0);
  });
  it('supports a custom maximum and never shortens a scene below one frame', () => {
    const p = project();
    expect(snapCutsCommands(p, cutAlignment(p, [130, 280], 120), { maxShiftFrames: 10 }).moved).toBe(1);
    const tiny = project([1 / 30, 4]);
    expect(snapCutsCommands(tiny, cutAlignment(tiny, [0], 120)).moved).toBe(0);
  });
});

describe('narration and scored-bed placement', () => {
  it('anchors and trims narration, then ducks the bed under existing and new voice', () => {
    let p = project();
    const bed = audio('bed'), voice = audio('voice', 200), short = audio('short', 20), existing = audio('existing');
    p.assets = Object.fromEntries([bed, voice, short, existing].map((asset) => [asset.id, asset]));
    p = apply(p, placeBedCommands(p, bed));
    p.audio.push({ id: 'old-voice', assetId: 'existing', name: 'Voice', sceneId: 's0', startFrame: 20, durationInFrames: 20, trimStartFrames: 0, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 });
    const original = structuredClone(p);
    const result = placeNarrationCommands(p, [{ asset: voice, sceneId: 's1' }, { asset: short, sceneId: 's2' }]);
    expect(result.ducked).toBe(true);
    expect(result.commands).toHaveLength(3);
    expect(result.commands[0]).toMatchObject({ type: 'addAudioClip', clip: { sceneId: 's1', startFrame: 6, durationInFrames: 144 } });
    expect(result.commands[1]).toMatchObject({ type: 'addAudioClip', clip: { sceneId: 's2', startFrame: 6, durationInFrames: 20 } });
    const placed = apply(p, result.commands);
    for (const frame of [30, 130, 280]) expect(envelopeAt(placed.audio[0].volumeEnvelope, frame)).toBeCloseTo(0.251);
    expect(envelopeAt(placed.audio[0].volumeEnvelope, 80)).toBe(1);
    expect(p).toEqual(original);
    expect(placeNarrationCommands(p, [{ asset: voice, sceneId: 's1' }])).toEqual(placeNarrationCommands(p, [{ asset: voice, sceneId: 's1' }]));
  });
  it('supports custom lead-ins, no bed, repeated takes and collision-free clip ids', () => {
    const p = project(), asset = audio('take', 30);
    const result = placeNarrationCommands(p, [{ asset, sceneId: 's0' }, { asset, sceneId: 's0' }], { leadInFrames: 0 });
    expect(result.ducked).toBe(false);
    expect(result.commands).toMatchObject([{ clip: { startFrame: 0, durationInFrames: 30 } }, { clip: { startFrame: 0, durationInFrames: 30 } }]);
    const ids = result.commands.map((command) => command.type === 'addAudioClip' && command.clip.id);
    expect(new Set(ids).size).toBe(2);
    expect(placeNarrationCommands(p, []).commands).toEqual([]);
  });
  it('rejects missing or locked narration scenes, invalid lead-ins and scenes with no room', () => {
    const p = project(), asset = audio('voice');
    expect(() => placeNarrationCommands(p, [{ asset, sceneId: 'missing' }])).toThrow('not found');
    p.scenes[0].locked = true;
    expect(() => placeNarrationCommands(p, [{ asset, sceneId: 's0' }])).toThrow('locked');
    expect(() => placeNarrationCommands(p, [], { leadInFrames: -1 })).toThrow('leadInFrames');
    expect(() => placeNarrationCommands(project([0.1]), [{ asset, sceneId: 's0' }])).toThrow('no room');
  });
  it('places a project bed at zero, fits the video or short source, and avoids existing ids', () => {
    const p = project(), bed = audio('bed');
    p.assets.bed = bed;
    const command = placeBedCommands(p, bed)[0];
    expect(command).toMatchObject({ type: 'addAudioClip', clip: { startFrame: 0, durationInFrames: 450 } });
    if (command.type !== 'addAudioClip') throw new Error('Expected a bed clip');
    expect(command.clip).not.toHaveProperty('sceneId');
    const placed = apply(p, [command]);
    expect(placeBedCommands(placed, bed)[0]).not.toEqual(command);
    expect(placeBedCommands(p, audio('short', 60))[0]).toMatchObject({ clip: { durationInFrames: 60, fadeOutFrames: 45 } });
    expect(() => placeBedCommands(project([]), bed)).toThrow('non-empty');
  });
});

it('merges the shortest adjacent sections to thirty and explains plan limits', () => {
  const p = project([8, 3, 3, ...Array(28).fill(4)]);
  const plan = buildScorePlan(p);
  expect(plan).toHaveLength(30);
  expect(plan[1]).toMatchObject({ sceneIds: ['s1', 's2'], seconds: 6 });
  expect(plan.reduce((sum, s) => sum + s.seconds, 0)).toBe(126);
  expect(planProblem(plan)).toBeNull();
  expect(planProblem(buildScorePlan(project([601])))).toContain('600 seconds');
  expect(planProblem(buildScorePlan(project([600])))).toBeNull();
  expect(planProblem(buildScorePlan(project([2])))).toContain('at least 3');
  expect(planProblem([])).toContain('1 and 30');
  expect(planProblem(Array(31).fill({ seconds: 3, sceneIds: [], styles: [] }))).toContain('1 and 30');
  expect(planProblem([{ seconds: 121, sceneIds: [], styles: [] }])).toContain('3 and 120');
});
it('translates the full downbeat grid by the placed bed start and source trim', () => {
  const p = project([4, 4, 4]);
  expect(cutAlignment(p, [0, 60, 120, 180, 240, 300], 120, { startFrame: 30, trimStartFrames: 32 }).map((cut) => cut.nearestDownbeatFrame)).toEqual([118, 238]);
  p.scenes[0].durationInFrames += 58;
  expect(cutAlignment(p, [0, 60, 120, 180, 240, 300], 120).map((cut) => cut.offsetFrames)).toEqual([2, 2]);
});
it('limits displacement from original cuts and computes duration adjustments separately', () => {
  const p = project([4, 4, 4]);
  const distant = snapCutsCommands(p, cutAlignment(p, [126, 252], 120));
  expect(distant).toMatchObject({ moved: 1, aligned: 0, skipped: [{ sceneId: 's2', why: expect.stringContaining('maximum shift') }] });
  expect(sceneStartFrames(apply(p, distant.commands))).toEqual([0, 126, 246]);
  const reverse = snapCutsCommands(p, cutAlignment(p, [126, 234], 120));
  expect(reverse).toMatchObject({ moved: 2, aligned: 0, skipped: [] });
  expect(sceneStartFrames(apply(p, reverse.commands))).toEqual([0, 126, 234]);
  const aligned = snapCutsCommands(p, cutAlignment(p, [126, 246], 120));
  expect(aligned).toMatchObject({ moved: 1, aligned: 1, skipped: [] });
  expect(snapCutsCommands(p, cutAlignment(p, [120, 240], 120))).toMatchObject({ moved: 0, aligned: 2 });
});
it('skips a shortening that would leave a project marker past the new end', () => {
  const p = project([4, 4, 4]);
  p.markers = [{ id: 'end-marker', frame: 359, label: 'End' }];
  const result = snapCutsCommands(p, cutAlignment(p, [120, 238], 120));
  expect(result).toMatchObject({ moved: 0, aligned: 1, skipped: [{ sceneId: 's2', why: expect.stringContaining('marker') }] });
  expect(apply(p, result.commands)).toEqual(p);
});
it.each([-2, 4])('resizes end-aligned elements with the scene by %i frames in a valid batch', (offset) => {
  const p = project([4, 4]);
  p.scenes[0].elements = [{ ...structuredClone(fixtureProject.scenes[0].elements[0]), startFrame: 0, durationInFrames: 120, tracks: [] }];
  const result = snapCutsCommands(p, cutAlignment(p, [120 + offset], 120));
  expect(result.moved).toBe(1);
  const placed = apply(p, result.commands);
  expect(placed.scenes[0].durationInFrames).toBe(120 + offset);
  expect(placed.scenes[0].elements[0].durationInFrames).toBe(120 + offset);
});
it.each([-6, 6])('refits the bed and re-ducks it under shifted narration for a %i-frame snap', (offset) => {
  let p = project([4, 4, 4]);
  const bed = audio('bed'), voice = audio('voice', 30);
  p.assets = { bed, voice };
  p = apply(p, placeBedCommands(p, bed));
  p = apply(p, placeNarrationCommands(p, [{ asset: voice, sceneId: 's1' }]).commands);
  const original = structuredClone(p);
  const result = snapCutsCommands(p, cutAlignment(p, [120 + offset, 240 + offset], 120), { bedClipId: p.audio[0].id });
  expect(result).toMatchObject({ moved: 1, aligned: 1 });
  const placed = apply(p, result.commands);
  const fitted = placed.audio[0];
  expect(fitted.durationInFrames).toBe(360 + offset);
  expect(fitted.volumeEnvelope?.at(-1)?.frame).toBe(360 + offset);
  expect(fitted.volumeEnvelope).toContainEqual({ frame: 126 + offset, value: 0.251 });
  expect(fitted.fadeOutFrames).toBe(45);
  expect(p).toEqual(original);
});
it('crops bed fades and extends or trims an envelope when no voice overlaps', () => {
  for (const offset of [-6, 6]) {
    let p = project([4, 4]);
    const bed = audio('bed'); p.assets = { bed };
    p = apply(p, placeBedCommands(p, bed));
    p.audio[0].fadeOutFrames = 240;
    p.audio[0].volumeEnvelope = [{ frame: 0, value: 1 }, { frame: 240, value: 0.5 }];
    const result = snapCutsCommands(p, cutAlignment(p, [120 + offset], 120), { bedClipId: p.audio[0].id });
    const fitted = apply(p, result.commands).audio[0];
    expect(fitted.durationInFrames).toBe(240 + offset);
    expect(fitted.fadeOutFrames).toBe(Math.min(240, 240 + offset));
    expect(fitted.volumeEnvelope?.at(-1)?.frame).toBe(240 + offset);
  }
});
it('replaces a bed and ducks the new one under narration already in the project', () => {
  let p = project();
  const old = audio('old'), bed = audio('bed'), voice = audio('voice', 30);
  p.assets = { old, bed, voice };
  p = apply(p, placeBedCommands(p, old));
  p = apply(p, placeNarrationCommands(p, [{ asset: voice, sceneId: 's1' }]).commands);
  const oldId = p.audio[0].id;
  const commands = placeBedCommands(p, bed, { replaceClipId: oldId });
  expect(commands[0]).toEqual({ type: 'removeAudioClip', clipId: oldId });
  const placed = apply(p, commands);
  expect(placed.audio.some((clip) => clip.id === oldId)).toBe(false);
  expect(envelopeAt(placed.audio.find((clip) => clip.assetId === 'bed')!.volumeEnvelope, 130)).toBe(0.251);
});
it('removes earlier narration by provenance or name only in target scenes and reports trimmed takes', () => {
  let p = project();
  const old = audio('old', 30), next = audio('next', 300);
  p.assets = { old, next };
  p = apply(p, placeNarrationCommands(p, [{ asset: old, sceneId: 's0' }, { asset: old, sceneId: 's1' }, { asset: old, sceneId: 's2' }]).commands);
  p.audio[0].name = 'Custom';
  p.assets.old = { ...old, provenance: { source: 'generated', providerRefs: { job: 'voice.narration' } } } as Asset;
  const unaffected = p.audio[2].id;
  const result = placeNarrationCommands(p, [{ asset: next, sceneId: 's0' }, { asset: next, sceneId: 's1' }]);
  expect(result.trimmed).toEqual(['s0', 's1']);
  expect(result.commands.slice(0, 2).map((command) => command.type)).toEqual(['removeAudioClip', 'removeAudioClip']);
  const placed = apply(p, result.commands);
  expect(placed.audio).toHaveLength(3);
  expect(placed.audio.find((clip) => clip.id === unaffected)?.sceneId).toBe('s2');
});
