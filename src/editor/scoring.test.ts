// Phase C in the editor: the score plan and the narration lines follow the
// scenes (keeping what was written), a scored bed's cut alignment in words
// (against the bed where it plays), Place as bed / Snap cuts to downbeats /
// Place at scenes proposed through the review with the core helpers, Use
// this take and More like this on a narration line, the actions that open
// them, Balanced's reason, and the Models scoreboard in Settings › Generation.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocState } from '../core/history';
import { project as fixture } from '../core/__fixtures__/schema2Project';
import { DEFAULT_GENERATION_SETTINGS, type GeneratedOutputMeta, type GenerationJob, type GenerationScoreboard, type GenerationSettings, type ModelScore } from '../core/generationStudio';
import type { Asset, AudioClip, Command, Project } from '../core/types';
import { actionById, isEnabled } from './actions';
import { api } from './api';
import { draftProblem, jobPromptText, jobRowLabel, openGenerate, routeReason, sceneMusicLabel, submitDraft, takeSceneOf, toRequest, useGenerate, watchGenerationProject } from './generateStore';
import { ModelsView, scoreCells, suggestionKey } from './GenerationSettings';
import { useLayout } from './layout';
import { TAKE_BY, useProposals } from './proposals';
import { alignmentText, bedAction, currentCuts, lineFit, mergeScorePlan, narrationAction, narrationScenes, placedBed, proposeAction, snapAction, type Cut } from './scoring';
import { useEditor } from './store';
import { groupTakes, moreLikeThisSettings, planUseTake, takeAlreadyPlaced, takeChoices, takeUsage } from './takes';

vi.mock('./api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./api')>();
  return { ...mod, api: { ...mod.api, startGeneration: vi.fn() } };
});

const st = () => useEditor.getState();
const draft = () => useGenerate.getState().draft;
const run = (command: Command) => expect(st().run(command, 'Edit')).toBe(true);

const audio = (id: string, name: string, durationInFrames: number): Asset => ({ id, kind: 'audio', name, src: `assets/generated/${id}.mp3`, mimeType: 'audio/mpeg', durationInFrames });

/** 30 fps: Intro 4 s (0–119), Product 3 s (120–209), Outro 5 s (210–359); cuts at 120 and 210. A scored bed and two narration takes. */
function threeScenes(): Project {
  const p = fixture();
  const scene = { ...p.scenes[0], elements: [] };
  return {
    ...p,
    scenes: [
      { ...scene, id: 'intro', name: 'Intro', durationInFrames: 120 },
      { ...scene, id: 'product', name: 'Product', durationInFrames: 90 },
      { ...scene, id: 'outro', name: 'Outro', durationInFrames: 150 },
    ],
    assets: { bed: audio('bed', 'Scored bed', 360), n1: audio('n1', 'Narration 1', 60), n2: audio('n2', 'Narration 2', 90) },
    story: {
      idea: 'A bottle that keeps water cold',
      hook: 'Ice that never melts',
      payoff: 'Cold all day',
      beats: [
        { role: 'hook', summary: 'Ice clinks in a steel bottle.', sceneId: 'intro' },
        { role: 'payoff', summary: 'Still cold at sunset.', sceneId: 'outro' },
      ],
    },
  };
}

function open(p: Project = threeScenes()) {
  st().loadDocument(createDocState(p), { kind: 'sample' });
  useEditor.setState({ toasts: [] });
  useProposals.setState({ proposal: null, check: null, open: false, view: 'proposed', log: [], returnTo: null, replaced: null, autoApply: false });
}

function job(kind: GenerationJob['job'], outputs: Asset[], outputMeta: Record<string, GeneratedOutputMeta>, changes: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id: `gjob_${kind}`,
    projectId: 'p',
    job: kind,
    prompt: 'Warm synths',
    model: 'elevenlabs-music-2.5',
    modelLabel: 'ElevenLabs Music',
    endpoint: 'elevenlabs/music/v2.5',
    policy: 'quality',
    routeVersion: 'r1',
    overridden: false,
    settings: {},
    takes: 1,
    requestedBy: { origin: 'user' },
    status: 'done',
    createdAt: 1,
    estimate: { usd: 0.12, basis: '12 s × $0.60 per minute' },
    falRequestIds: [],
    outputs,
    delivered: true,
    ...changes,
    outputMeta,
  };
}

const cut = (sceneId: string, cutFrame: number, offset: number | null): Cut => ({ sceneId, cutFrame, nearestDownbeatFrame: offset === null ? null : cutFrame + offset, offsetFrames: offset });

const bedClip = (assetId = 'old', name = 'Old bed'): AudioClip => ({ id: 'aud_old', assetId, name, startFrame: 0, trimStartFrames: 0, durationInFrames: 360, volume: 0.6, fadeInFrames: 15, fadeOutFrames: 45 });

let stopWatching: () => void = () => undefined;

beforeEach(() => {
  open();
  stopWatching = watchGenerationProject();
  useLayout.setState({ rightOpen: true, rightTab: 'inspector', overlay: null });
});

afterEach(() => {
  stopWatching();
  vi.unstubAllGlobals();
});

describe('the score plan follows the scenes', () => {
  it('opens Score the video on a section per scene, its direction from the story', () => {
    actionById('generate.scoreVideo')!.run();
    expect(useLayout.getState().rightTab).toBe('generate');
    expect(draft()).toMatchObject({ mode: 'music', job: 'music.scored' });
    expect(draft().settings.score?.map((s) => [s.sceneIds, s.seconds])).toEqual([
      [['intro'], 4],
      [['product'], 3],
      [['outro'], 5],
    ]);
    expect(draft().settings.score?.[0].styles).toEqual(['attention-grabbing intro']);
  });

  it('keeps edited styles for sections whose scenes are unchanged, and rebuilds the rest', () => {
    actionById('generate.scoreVideo')!.run();
    const score = draft().settings.score!;
    useGenerate.getState().setDraft({ settings: { score: score.map((s, i) => (i === 1 ? { ...s, styles: ['quiet', 'building'] } : s)) } });
    // Outro doubles: Product's direction stays, Outro's length follows.
    run({ type: 'updateScene', sceneId: 'outro', changes: { durationInFrames: 300 } });
    expect(draft().settings.score?.map((s) => [s.sceneIds.join(), s.seconds, s.styles])).toEqual([
      ['intro', 4, ['attention-grabbing intro']],
      ['product', 3, ['quiet', 'building']],
      ['outro', 10, ['full, triumphant']],
    ]);
    // Product shrinks under 3 s: it now shares a section with Outro, so its old direction no longer applies.
    run({ type: 'updateScene', sceneId: 'product', changes: { durationInFrames: 60 } });
    expect(draft().settings.score?.map((s) => s.sceneIds.join())).toEqual(['intro', 'product,outro']);
    expect(draft().settings.score?.[1].styles).not.toContain('quiet');
  });

  it('keys split sections apart, so one long scene keeps each part’s styles', () => {
    const part = { sceneIds: ['long'], seconds: 100, styles: ['a'] };
    expect(mergeScorePlan([part, { ...part, styles: ['b'] }], [{ ...part, styles: [] }, { ...part, styles: [] }]).map((s) => s.styles)).toEqual([['a'], ['b']]);
  });

  it('says the model’s limits before the server would refuse: a video over 600 s', () => {
    actionById('generate.scoreVideo')!.run();
    useGenerate.getState().setDraft({ prompt: 'Warm synths' });
    run({ type: 'updateScene', sceneId: 'outro', changes: { durationInFrames: 30 * 600 } });
    expect(draftProblem(draft())).toBe('The video is longer than 600 seconds.');
    run({ type: 'updateScene', sceneId: 'outro', changes: { durationInFrames: 150 } });
    expect(draftProblem(draft())).toBeNull();
    useGenerate.getState().setDraft({ prompt: '' });
  });

  it('needs a genre, and scenes to follow', () => {
    actionById('generate.scoreVideo')!.run();
    expect(draftProblem(draft())).toBe('Describe the genre and instruments first.');
    useGenerate.getState().setDraft({ prompt: 'Warm synths, light percussion' });
    expect(draftProblem(draft())).toBeNull();
    const req = toRequest(draft(), 'p');
    expect(req).toMatchObject({ job: 'music.scored', prompt: 'Warm synths, light percussion' });
    expect(req.settings?.score).toHaveLength(3);
    expect(req.settings).not.toHaveProperty('bpm');
  });
});

describe('narration, a line per scene', () => {
  it('prefills a line per scene from the story and sends only the lines with words', () => {
    actionById('generate.narrate')!.run();
    expect(draft()).toMatchObject({ mode: 'voice', job: 'voice.narration' });
    expect(draft().settings.lines).toEqual([
      { sceneId: 'intro', text: 'Ice clinks in a steel bottle.' },
      { sceneId: 'product', text: '' },
      { sceneId: 'outro', text: 'Still cold at sunset.' },
    ]);
    // No prompt box: the lines are the words; the request's prompt is a short label so records stay readable.
    expect(draftProblem(draft())).toBeNull();
    const req = toRequest(draft(), 'p');
    expect(req.prompt).toBe('Narration · 2 lines');
    expect(req.settings?.lines?.map((l) => l.sceneId)).toEqual(['intro', 'outro']);
    useGenerate.getState().setDraft({ settings: { lines: draft().settings.lines!.map((l) => ({ ...l, text: ' ' })) } });
    expect(draftProblem(draft())).toBe('Write a line for at least one scene.');
  });

  it('keeps written lines as scenes change: a new scene gets its own, a deleted one’s goes', () => {
    actionById('generate.narrate')!.run();
    useGenerate.getState().setDraft({ settings: { lines: draft().settings.lines!.map((l) => (l.sceneId === 'product' ? { ...l, text: 'One fill, all day.' } : l)) } });
    run({ type: 'removeScene', sceneId: 'intro' });
    expect(draft().settings.lines).toEqual([
      { sceneId: 'product', text: 'One fill, all day.' },
      { sceneId: 'outro', text: 'Still cold at sunset.' },
    ]);
  });

  it('a narration job row quotes its first line, every line in the tooltip', () => {
    const lines = [
      { sceneId: 'intro', text: 'Ice clinks in a steel bottle.' },
      { sceneId: 'outro', text: 'Still cold.' },
    ];
    expect(jobPromptText(job('voice.narration', [], {}, { prompt: 'Narration · 2 lines', settings: { lines } }))).toEqual({ text: '“Ice clinks in a steel bottle.” + 1 more', title: 'Ice clinks in a steel bottle.\nStill cold.' });
    expect(jobPromptText(job('music.bed', [], {}))).toEqual({ text: '“Warm synths”', title: 'Warm synths' });
  });

  it('says how long a line takes to say, and when it likely runs past its scene', () => {
    const p = st().doc.project;
    expect(lineFit(p, { sceneId: 'product', text: 'One fill, all day.' })).toMatchObject({ chars: 18, seconds: 1.2, sceneSeconds: 3, long: false });
    expect(lineFit(p, { sceneId: 'product', text: 'x'.repeat(60) })).toMatchObject({ seconds: 4, long: true });
  });
});

describe('cut alignment', () => {
  it('counts a cut within 2 frames of a downbeat as on it', () => {
    expect(alignmentText([cut('a', 10, 0), cut('b', 20, 2), cut('c', 30, -1), cut('d', 40, 3), cut('e', 50, null)])).toBe('3 of 5 cuts on a downbeat');
    expect(alignmentText([cut('a', 10, -2)])).toBe('The cut is on a downbeat');
    expect(alignmentText([cut('a', 10, 5)])).toBe('The cut is off the downbeat');
    expect(alignmentText([])).toBe('One scene, so no cuts to line up');
  });

  it('reads the analysis while the scenes are where they were, and measures again once they move', () => {
    const meta = { cuts: [cut('product', 120, 4), cut('outro', 210, 2)], bpm: 120 };
    const p = st().doc.project;
    expect(currentCuts(p, meta, 120)).toBe(meta.cuts);
    expect(currentCuts(p, {}, 120)).toBeNull();
    run({ type: 'updateScene', sceneId: 'intro', changes: { durationInFrames: 124 } });
    expect(currentCuts(st().doc.project, meta, 120)).toEqual([
      { sceneId: 'product', cutFrame: 124, nearestDownbeatFrame: 124, offsetFrames: 0 },
      { sceneId: 'outro', cutFrame: 214, nearestDownbeatFrame: 212, offsetFrames: -2 },
    ]);
  });

  // 120 BPM in 4 at 30 fps: a downbeat every 60 frames of the file.
  const grid = [0, 60, 120, 180, 240, 300, 360];

  it('measures again against the full downbeat grid, not only the beats nearest the old cuts', () => {
    // Analysed: Product's cut on 120, Outro's 30 frames before 240 (nearest kept: 180 and 120 only).
    const meta = { cuts: [cut('product', 120, 0), cut('outro', 210, -30)], downbeats: grid, bpm: 120 };
    // Product grows by 30 frames: Outro's cut lands on 240, a downbeat the nearest-only list never had.
    run({ type: 'updateScene', sceneId: 'product', changes: { durationInFrames: 120 } });
    expect(alignmentText(currentCuts(st().doc.project, meta, 120)!)).toBe('2 of 2 cuts on a downbeat');
    expect(alignmentText(currentCuts(st().doc.project, { cuts: meta.cuts }, 120)!)).toBe('1 of 2 cuts on a downbeat');
  });

  it('reads the downbeats where the bed plays: its start in the video and its in-point', () => {
    const meta = { cuts: [cut('product', 120, 0), cut('outro', 210, -30)], downbeats: grid, bpm: 120 };
    const p = st().doc.project;
    expect(alignmentText(currentCuts(p, meta, 120)!)).toBe('1 of 2 cuts on a downbeat');
    // Started 30 frames late: the downbeats play at 30, 90, 150, 210…: Outro's cut is on one, Product's is not.
    expect(currentCuts(p, meta, 120, { startFrame: 30, trimStartFrames: 0 })!.map((c) => c.offsetFrames)).toEqual([-30, 0]);
    // Trimmed by 30 frames from frame 0: the same beats, earlier in the file.
    expect(currentCuts(p, meta, 120, { startFrame: 0, trimStartFrames: 30 })!.map((c) => c.offsetFrames)).toEqual([-30, 0]);
  });
});

describe('job rows propose through the review', () => {
  const proposal = () => useProposals.getState();

  it('Place as bed: the take under the whole video, proposed as your generated take; nothing changes until Apply', () => {
    const before = st().doc;
    const a = bedAction(before.project, before.project.assets.bed);
    expect(a).toMatchObject({ label: 'Place as bed', why: null, summary: 'Place “Scored bed” as the music bed' });
    expect(a.commands).toEqual([{ type: 'addAudioClip', clip: expect.objectContaining({ assetId: 'bed', startFrame: 0, durationInFrames: 360 }) }]);
    expect(a.commands[0].type === 'addAudioClip' && a.commands[0].clip.sceneId).toBeUndefined();
    expect(proposeAction((p) => bedAction(p, p.assets.bed))).toBe(true);
    expect(proposal()).toMatchObject({ open: true, check: { status: 'ready' }, proposal: { agent: TAKE_BY, patch: { summary: a.summary, targets: [{ audio: 'project' }] } } });
    expect(st().doc).toBe(before);
    expect(proposal().apply().ok).toBe(true);
    expect(st().doc.project.audio.map((c) => c.assetId)).toEqual(['bed']);
    expect(bedAction(st().doc.project, st().doc.project.assets.bed).why).toBe('Already the music bed.');
  });

  it('Place as bed replaces the bed playing now', () => {
    open({ ...threeScenes(), assets: { ...threeScenes().assets, old: audio('old', 'Old bed', 360) }, audio: [bedClip()] });
    const p = st().doc.project;
    const a = bedAction(p, p.assets.bed);
    expect(a.summary).toBe('Use “Scored bed” as the music bed in place of “Old bed”');
    expect(a.commands.map((c) => c.type)).toEqual(['removeAudioClip', 'addAudioClip']);
    expect(proposeAction((q) => bedAction(q, q.assets.bed))).toBe(true);
    expect(proposal().apply().ok).toBe(true);
    expect(st().doc.project.audio.map((c) => c.assetId)).toEqual(['bed']);
  });

  it('Place as bed ducks the new bed under voice already placed, and says so', () => {
    const voice: AudioClip = { id: 'aud_vo', assetId: 'n1', name: 'Narration: Narration 1', sceneId: 'intro', startFrame: 6, trimStartFrames: 0, durationInFrames: 60, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 };
    open({ ...threeScenes(), assets: { ...threeScenes().assets, old: audio('old', 'Old bed', 360) }, audio: [bedClip(), voice] });
    const a = bedAction(st().doc.project, st().doc.project.assets.bed);
    expect(a.summary).toBe('Use “Scored bed” as the music bed in place of “Old bed”, ducked under the voice');
    expect(a.commands.map((c) => c.type)).toEqual(['removeAudioClip', 'addAudioClip', 'updateAudioClip']);
    expect(proposeAction((p) => bedAction(p, p.assets.bed))).toBe(true);
    expect(proposal().apply().ok).toBe(true);
    expect(st().doc.project.audio.find((c) => c.assetId === 'bed')?.volumeEnvelope?.length).toBeGreaterThan(1);
  });

  /** The scored take `bed` placed as the bed (its asset long enough for the video to grow a little). */
  const withBed = (clip: Partial<AudioClip> = {}) =>
    open({ ...threeScenes(), assets: { ...threeScenes().assets, bed: audio('bed', 'Scored bed', 420) }, audio: [{ ...bedClip('bed', 'Scored bed'), id: 'aud_bed', ...clip }] });

  it('Snap cuts waits until this take is the bed: another bed, or none, says to place it first', () => {
    const cuts = [cut('product', 120, 4)];
    expect(snapAction(st().doc.project, cuts, placedBed(st().doc.project, 'bed')?.id)).toMatchObject({ why: 'Place this take as the bed first.' });
    open({ ...threeScenes(), audio: [bedClip()] });
    expect(placedBed(st().doc.project, 'bed')).toBeUndefined();
    expect(snapAction(st().doc.project, cuts, placedBed(st().doc.project, 'bed')?.id).why).toBe('Place this take as the bed first.');
    withBed();
    expect(placedBed(st().doc.project, 'bed')?.id).toBe('aud_bed');
    expect(snapAction(st().doc.project, cuts, 'aud_bed').why).toBeNull();
  });

  it('Snap cuts says how many move and how far, moves them onto the downbeats with the bed following, and then has nothing left to do', () => {
    withBed();
    const cuts = [cut('product', 120, 4), cut('outro', 210, 2)];
    const a = snapAction(st().doc.project, cuts, 'aud_bed');
    expect(a).toMatchObject({ label: 'Snap 2 cuts to downbeats (up to 4 frames)', why: null, note: '2 cuts moved.' });
    expect(a.commands).toEqual([
      { type: 'updateScene', sceneId: 'intro', changes: { durationInFrames: 124 } },
      { type: 'updateScene', sceneId: 'product', changes: { durationInFrames: 88 } },
      // The video is 2 frames longer: the bed runs to its new end.
      { type: 'updateAudioClip', clipId: 'aud_bed', changes: expect.objectContaining({ durationInFrames: 362 }) },
    ]);
    expect(proposeAction((p) => snapAction(p, cuts, 'aud_bed'))).toBe(true);
    expect(proposal().proposal?.patch.targets).toEqual([{ sceneId: 'intro' }, { sceneId: 'product' }, { audio: 'project' }]);
    expect(proposal().apply().ok).toBe(true);
    const now = currentCuts(st().doc.project, { cuts }, null, placedBed(st().doc.project, 'bed'))!;
    expect(alignmentText(now)).toBe('2 of 2 cuts on a downbeat');
    expect(snapAction(st().doc.project, now, 'aud_bed')).toMatchObject({ label: 'Snap cuts to downbeats', why: 'Every cut is already on a downbeat.' });
  });

  it('Snap cuts counts a cut an earlier move carried onto its downbeat as already on the beat', () => {
    withBed();
    // Both cuts 3 frames early: lengthening Intro carries Outro's cut onto its downbeat too.
    const a = snapAction(st().doc.project, [cut('product', 120, 3), cut('outro', 210, 3)], 'aud_bed');
    expect(a).toMatchObject({ label: 'Snap 1 cut to a downbeat (3 frames)', note: '1 cut moved, 1 already on the beat.' });
    expect(a.commands.filter((c) => c.type === 'updateScene')).toEqual([{ type: 'updateScene', sceneId: 'intro', changes: { durationInFrames: 123 } }]);
  });

  it('Snap cuts is disabled with the reason: nothing near enough, or the scene before the cut is locked', () => {
    withBed();
    expect(snapAction(st().doc.project, [cut('product', 120, 9), cut('outro', 210, -12)], 'aud_bed').why).toBe('No cut is within 6 frames of a downbeat.');
    expect(snapAction(st().doc.project, [cut('product', 120, 1)], 'aud_bed')).toMatchObject({ label: 'Snap 1 cut to a downbeat (1 frame)', why: null });
    run({ type: 'setSceneLock', sceneId: 'intro', locked: true });
    expect(snapAction(st().doc.project, [cut('product', 120, 4), cut('outro', 210, 0)], 'aud_bed').why).toBe('“Intro” is locked, so its cut stays where it is.');
    // One locked, one free: the free one moves and the locked one is said.
    const partly = snapAction(st().doc.project, [cut('product', 120, 4), cut('outro', 210, 3)], 'aud_bed');
    expect(partly).toMatchObject({ label: 'Snap 1 cut to a downbeat (3 frames)', note: '1 cut moved. “Intro” is locked, so its cut stays where it is.' });
    expect(snapAction(st().doc.project, [], 'aud_bed')).toMatchObject({ why: 'One scene, so there are no cuts to move.' });
  });

  it('Place at scenes: each line’s take at its scene, the music ducked when there is a bed', () => {
    const narration = job('voice.narration', [audio('n1', 'Narration 1', 60), audio('n2', 'Narration 2', 90)], { n1: { sceneId: 'intro' }, n2: { sceneId: 'outro' } });
    const plain = narrationAction(st().doc.project, narration);
    expect(plain).toMatchObject({ label: 'Place at 2 scenes', why: null, ducked: false, summary: 'Place narration at 2 scenes' });
    expect(plain.commands.map((c) => c.type === 'addAudioClip' && [c.clip.assetId, c.clip.sceneId])).toEqual([
      ['n1', 'intro'],
      ['n2', 'outro'],
    ]);

    open({ ...threeScenes(), audio: [bedClip('bed', 'Scored bed')] });
    const ducked = narrationAction(st().doc.project, narration);
    expect(ducked).toMatchObject({ label: 'Place at 2 scenes with the music ducked', ducked: true, summary: 'Place narration at 2 scenes, with the music ducked under it' });
    expect(ducked.commands.at(-1)).toMatchObject({ type: 'updateAudioClip', clipId: 'aud_old' });
    expect(proposeAction((p) => narrationAction(p, narration))).toBe(true);
    expect(proposal().proposal?.patch.targets).toEqual([{ sceneId: 'intro' }, { sceneId: 'outro' }, { audio: 'project' }]);
    expect(proposal().apply().ok).toBe(true);
    expect(st().doc.project.audio.filter((c) => c.sceneId).map((c) => c.assetId)).toEqual(['n1', 'n2']);
    expect(narrationAction(st().doc.project, narration).why).toBe('Already placed at their scenes.');
  });

  it('Place at scenes leaves locked scenes out and says so; untagged takes offer nothing', () => {
    const narration = job('voice.narration', [audio('n1', 'Narration 1', 60), audio('n2', 'Narration 2', 90)], { n1: { sceneId: 'intro' }, n2: { sceneId: 'outro' } });
    run({ type: 'setSceneLock', sceneId: 'outro', locked: true });
    expect(narrationAction(st().doc.project, narration)).toMatchObject({ label: 'Place at 1 scene', note: '“Outro” is locked, so its line was left out.' });
    expect(narrationAction(st().doc.project, job('voice.narration', [audio('n1', 'Narration 1', 60)], {})).why).toBe('These takes don’t say which scene they belong to.');
  });

  it('Place at scenes replaces the narration already in those scenes, and names the lines cut off by their scene', () => {
    const earlier: AudioClip = { id: 'aud_n0', assetId: 'n0', name: 'Narration: First draft', sceneId: 'intro', startFrame: 6, trimStartFrames: 0, durationInFrames: 60, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 };
    // Narration 1 runs 200 frames, longer than Intro after the lead-in (114).
    open({ ...threeScenes(), assets: { ...threeScenes().assets, n0: audio('n0', 'First draft', 60), n1: audio('n1', 'Narration 1', 200) }, audio: [earlier] });
    const narration = job('voice.narration', [audio('n1', 'Narration 1', 200), audio('n2', 'Narration 2', 90)], { n1: { sceneId: 'intro' }, n2: { sceneId: 'outro' } });
    const a = narrationAction(st().doc.project, narration);
    expect(a.summary).toBe('Place narration at 2 scenes, in place of 1 earlier narration clip; cut off in Intro — shorten that line or lengthen the scene');
    expect(a.commands[0]).toEqual({ type: 'removeAudioClip', clipId: 'aud_n0' });
    expect(proposeAction((p) => narrationAction(p, narration))).toBe(true);
    expect(proposal().apply().ok).toBe(true);
    expect(st().doc.project.audio.map((c) => [c.assetId, c.sceneId])).toEqual([
      ['n1', 'intro'],
      ['n2', 'outro'],
    ]);
  });

  it('Place at scenes takes the take picked for each scene, the one in the video until another is picked', () => {
    const takes = [audio('n1', 'Narration 1', 60), audio('n1b', 'Narration 1 again', 50), audio('n2', 'Narration 2', 90)];
    open({ ...threeScenes(), assets: { ...threeScenes().assets, n1b: takes[1] } });
    const narration = job('voice.narration', takes, { n1: { sceneId: 'intro' }, n1b: { sceneId: 'intro' }, n2: { sceneId: 'outro' } });
    expect(narrationScenes(st().doc.project, narration).map((s) => [s.sceneId, s.takes.map((t) => t.id)])).toEqual([
      ['intro', ['n1', 'n1b']],
      ['outro', ['n2']],
    ]);
    const added = (a: ReturnType<typeof narrationAction>) => a.commands.flatMap((c) => (c.type === 'addAudioClip' ? [c.clip.assetId] : []));
    // Nothing placed: each scene's first take.
    expect(added(narrationAction(st().doc.project, narration))).toEqual(['n1', 'n2']);
    expect(added(narrationAction(st().doc.project, narration, { intro: 'n1b' }))).toEqual(['n1b', 'n2']);
    expect(proposeAction((p) => narrationAction(p, narration))).toBe(true);
    expect(proposal().apply().ok).toBe(true);
    // Placed: the takes in the video are the defaults, so there is nothing to do until another take is picked.
    expect(narrationAction(st().doc.project, narration).why).toBe('Already placed at their scenes.');
    const swap = narrationAction(st().doc.project, narration, { intro: 'n1b' });
    expect(swap).toMatchObject({ label: 'Place at 1 scene', summary: 'Place narration at 1 scene, in place of 1 earlier narration clip' });
    expect(added(swap)).toEqual(['n1b']);
  });
});

describe('Use this take on a narration line', () => {
  const line = (id: string, name: string, sceneId: string, durationInFrames = 60): Asset => ({
    ...audio(id, name, durationInFrames),
    provenance: { source: 'generated', provider: 'fal', requestId: 'gjob_n', createdAt: 1, providerRefs: { job: 'voice.narration', sceneId } },
  });
  const voice = (id: string, assetId: string, sceneId: string): AudioClip => ({ id, assetId, name: `Narration: ${assetId}`, sceneId, startFrame: 6, trimStartFrames: 0, durationInFrames: 50, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 });
  const lines = { n1: line('n1', 'Intro take 1', 'intro'), n1b: line('n1b', 'Intro take 2', 'intro'), n2: line('n2', 'Outro take 1', 'outro') };
  const group = (p: Project) => groupTakes(p).find((g) => g.key === 'gjob_n')!;

  it('switches only the clip in its own scene, never another scene’s line', () => {
    open({ ...threeScenes(), assets: { ...threeScenes().assets, ...lines }, audio: [voice('aud_i', 'n1', 'intro'), voice('aud_o', 'n2', 'outro')] });
    const p = st().doc.project;
    const plan = planUseTake(p, group(p), 'n1b', 'outro');
    expect(plan.kind).toBe('patch');
    if (plan.kind !== 'patch') return;
    expect(plan.patch.commands).toEqual([{ type: 'updateAudioClip', clipId: 'aud_i', changes: expect.objectContaining({ assetId: 'n1b' }) }]);
    expect(plan.patch.targets).toEqual([{ sceneId: 'intro' }]);
  });

  it('counts as already placed against its own line’s takes only', () => {
    open({ ...threeScenes(), assets: { ...threeScenes().assets, ...lines }, audio: [voice('aud_i', 'n1', 'intro'), voice('aud_o', 'n2', 'outro')] });
    const p = st().doc.project;
    const usage = takeUsage(p);
    // Outro's only take is in the video; Intro's other line playing does not make it switchable.
    expect(takeAlreadyPlaced(takeChoices(group(p), p.assets.n2), 'n2', usage)).toBe(true);
    expect(takeAlreadyPlaced(group(p), 'n2', usage)).toBe(false);
    expect(planUseTake(p, group(p), 'n2', 'intro')).toMatchObject({ kind: 'none', message: expect.stringContaining('the take of this line the video uses') });
  });

  it('places a line not yet in the video in its own scene, whatever is selected, after the lead-in', () => {
    open({ ...threeScenes(), assets: { ...threeScenes().assets, ...lines } });
    const p = st().doc.project;
    const plan = planUseTake(p, group(p), 'n2', 'intro');
    expect(plan).toMatchObject({ kind: 'patch', summary: 'Place narration “Outro take 1” in “Outro”' });
    if (plan.kind !== 'patch') return;
    expect(plan.patch.commands).toEqual([{ type: 'addAudioClip', clip: expect.objectContaining({ assetId: 'n2', sceneId: 'outro', startFrame: 6 }) }]);
  });

  it('More like this asks for that line only, two takes, and keeps to it as the scenes change', () => {
    const settings = { lines: [{ sceneId: 'intro', text: 'Ice clinks.' }, { sceneId: 'outro', text: 'Still cold at sunset.' }] };
    const scoped = moreLikeThisSettings(settings, lines.n2);
    expect(scoped).toEqual({ settings: { lines: [{ sceneId: 'outro', text: 'Still cold at sunset.' }] }, forScene: 'outro' });
    expect(moreLikeThisSettings(settings, audio('x', 'Plain', 10))).toEqual({ settings });
    openGenerate({ job: 'voice.narration', prompt: '', takes: 2, regenerateOf: 'gjob_n', ...scoped }, true);
    expect(draft()).toMatchObject({ job: 'voice.narration', takes: 2, forScene: 'outro', settings: { lines: [{ sceneId: 'outro', text: 'Still cold at sunset.' }] } });
    run({ type: 'updateScene', sceneId: 'intro', changes: { durationInFrames: 150 } });
    expect(draft().settings.lines).toEqual([{ sceneId: 'outro', text: 'Still cold at sunset.' }]);
    expect(toRequest(draft(), 'p').prompt).toBe('Narration · 1 line');
  });
});

describe('actions', () => {
  it('Generate music for this scene: a bed as long as the scene, placed in it when used; enabled only on a scene', () => {
    const a = actionById('generate.scoreScene')!;
    expect(a).toMatchObject({ label: 'Generate music for this scene…', menu: 'scene', group: 'generate', contexts: ['scene'] });
    st().selectElement('product', null);
    expect(isEnabled(a)).toBe(true);
    a.run();
    expect(draft()).toMatchObject({ mode: 'music', job: 'music.bed', forScene: 'product', settings: { durationSeconds: 3, instrumental: true } });
    // Generate music… is for the whole video again.
    actionById('generate.music')!.run();
    expect(draft().forScene).toBeUndefined();
    useEditor.setState((s) => ({ selection: { ...s.selection, sceneId: 'gone' } }));
    expect(isEnabled(a)).toBe(false);
    expect(a.whyDisabled?.()).toBe('Go to a scene first');
  });

  it('remembers the scene a request’s music was for, so Use this take puts it there', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    st().selectElement('outro', null);
    actionById('generate.scoreScene')!.run();
    useGenerate.getState().setDraft({ prompt: 'Soft piano' });
    useGenerate.setState({ submitting: false });
    vi.mocked(api.startGeneration).mockResolvedValue({ job: job('music.bed', [], {}, { id: 'gjob_scene', status: 'queued', delivered: false }) });
    expect(await submitDraft()).toMatchObject({ id: 'gjob_scene' });
    expect(vi.mocked(api.startGeneration).mock.calls[0][0].settings).toEqual({ durationSeconds: 5, instrumental: true });
    expect(takeSceneOf('gjob_scene')).toBe('outro');
    // Its job row (and the job choice while asking) says which scene, not "the whole video".
    expect(jobRowLabel(job('music.bed', [], {}, { id: 'gjob_scene' }), st().doc.project, 'Music bed for the whole video')).toBe('Music for Outro');
    expect(jobRowLabel(job('music.bed', [], {}, { id: 'gjob_other' }), st().doc.project, 'Music bed for the whole video')).toBe('Music bed for the whole video');
    expect(sceneMusicLabel('Outro')).toBe('Music for Outro');
    // More like this asks again for the same scene.
    openGenerate({ job: 'music.bed', prompt: 'Soft piano', regenerateOf: 'gjob_scene' }, true);
    expect(draft().forScene).toBe('outro');
  });

  it('Score the video and Write narration sit with the other Generate items in Insert', () => {
    for (const id of ['generate.scoreVideo', 'generate.narrate']) expect(actionById(id)).toMatchObject({ menu: 'insert', group: 'generate' });
    expect(actionById('generate.scoreVideo')!.label).toBe('Score the video to its cuts…');
    expect(actionById('generate.narrate')!.label).toBe('Write narration for each scene…');
  });
});

describe('Settings › Generation › Models', () => {
  const row = (changes: Partial<ModelScore>): ModelScore => ({
    job: 'image.generate',
    model: 'seedream-5-pro',
    modelLabel: 'Seedream 5.0 Pro',
    runs: 24,
    takes: 48,
    useRate: 0.5,
    keepRate: 0.61,
    thumbsUp: 6,
    thumbsDown: 1,
    matchRate: 0.9,
    costPerKept: 0.11,
    p50Seconds: 14,
    failureRate: 0.04,
    smallSample: false,
    overrides: 0,
    ...changes,
  });
  const board = (changes: Partial<GenerationScoreboard> = {}): GenerationScoreboard => ({
    rows: [row({}), row({ model: 'gpt-image-2.5-flare', modelLabel: 'GPT Image 2.5', runs: 6, smallSample: true, costPerKept: null, matchRate: null, p50Seconds: 75 })],
    suggestions: [{ job: 'image.generate', from: 'gpt-image-2.5-flare', to: 'seedream-5-pro', kind: 'cheaper', reason: 'Seedream 5.0 Pro keeps 61% of takes (default 63%) at $0.11 per kept image instead of $0.82.' }],
    overrides: {},
    threshold: 20,
    ...changes,
  });
  const routes = { routeVersion: 'r1', policy: 'quality' as const, jobs: [{ job: 'image.generate' as const, media: 'image' as const, label: 'A still image', hint: '', models: [], defaults: { quality: 'gpt-image-2.5-flare', balanced: 'seedream-5-pro', draft: 'seedream-5-pro' } }] };
  const html = (b: GenerationScoreboard, dismissed: string[] = []) =>
    renderToStaticMarkup(createElement(ModelsView, { board: b, routes, policy: 'quality', dismissed, busy: null, error: null, onSetDefault: () => undefined, onDismiss: () => undefined }));

  it('says what fills it in before anything has run', () => {
    expect(html(board({ rows: [], suggestions: [] }))).toContain('No generations yet. As you generate and use takes, this fills in.');
  });

  it('prints each model’s numbers and greys a small sample', () => {
    expect(scoreCells(row({}))).toEqual({ runs: '24', used: '50%', kept: '61%', thumbs: '6 / 1', matched: '90%', perKept: '$0.11', time: '14 s', failed: '4%' });
    expect(scoreCells(row({ costPerKept: null, matchRate: null, p50Seconds: 75 }))).toMatchObject({ perKept: '—', matched: '—', time: '1:15' });
    const out = html(board());
    expect(out).toContain('A still image');
    expect(out).toMatch(/<tr class="small"[^>]*data-testid="generation-board-row-image.generate-gpt-image-2.5-flare"/);
    expect(out).toContain('fewer than 20 runs');
    expect(out).not.toMatch(/<tr class="small"[^>]*seedream/);
    // The route's current default is marked.
    expect(out).toMatch(/GPT Image 2.5<\/span><span class="gen-board-tag">default<\/span>/);
  });

  it('shows a suggestion with Make default and Dismiss, and the policy note even with no cards; a dismissed one goes', () => {
    const out = html(board());
    expect(out).toContain('Seedream 5.0 Pro keeps 61% of takes (default 63%) at $0.11 per kept image instead of $0.82.');
    expect(out).toContain('Make default');
    expect(out).toContain('Dismiss');
    expect(out).toContain('Balanced follows suggestions automatically; Quality first only after you accept one.');
    expect(suggestionKey({ job: 'image.generate', to: 'seedream-5-pro' })).toBe('image.generate:seedream-5-pro');
    const gone = html(board(), [suggestionKey({ job: 'image.generate', to: 'seedream-5-pro' })]);
    expect(gone).not.toContain('Make default');
    expect(gone).toContain('Balanced follows suggestions automatically; Quality first only after you accept one.');
    expect(html(board({ rows: [], suggestions: [] }))).toContain('Balanced follows suggestions automatically');
  });

  it('Dismiss is saved on the server, so Balanced stops following it', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(board({ suggestions: [] })), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await api.dismissSuggestion('image.generate', 'seedream-5-pro')).toMatchObject({ suggestions: [] });
    expect(fetchMock).toHaveBeenCalledWith('/api/generation/suggestions/dismiss', expect.objectContaining({ method: 'POST', body: JSON.stringify({ job: 'image.generate', model: 'seedream-5-pro' }) }));
  });

  it('Balanced says why before a prompt is priced: the open suggestion it follows, never a dismissed one', () => {
    const models = { ...routes, policy: 'quality' as const };
    const base = { draft: { ...draft(), job: 'image.generate' as const, model: null }, models, quote: null, quoteFor: null };
    const status = (changes: Partial<GenerationSettings> = {}) => ({ key: { configured: true }, spendTodayUsd: 0, activeJobs: 0, settings: { ...DEFAULT_GENERATION_SETTINGS, ...changes } });
    expect(routeReason({ ...base, status: status(), scoreboard: board() }, 'balanced')).toBe('Balanced: Seedream 5.0 Pro keeps 61% of takes (default 63%) at $0.11 per kept image instead of $0.82.');
    expect(routeReason({ ...base, status: status(), scoreboard: board() }, 'quality')).toBeNull();
    expect(routeReason({ ...base, status: status({ dismissedSuggestions: ['image.generate:seedream-5-pro'] }), scoreboard: board() }, 'balanced')).toBeNull();
    // Accepted: the model row already says "your default".
    expect(routeReason({ ...base, status: status({ routeOverrides: { 'image.generate': 'seedream-5-pro' } }), scoreboard: board() }, 'balanced')).toBeNull();
    // Nothing measured yet: Balanced is Quality.
    const same = { ...models, jobs: [{ ...models.jobs[0], defaults: { quality: 'gpt-image-2.5-flare', balanced: 'gpt-image-2.5-flare', draft: 'seedream-5-pro' } }] };
    expect(routeReason({ ...base, models: same, status: status(), scoreboard: board({ suggestions: [] }) }, 'balanced')).toBe('Balanced: no open suggestion for this job, so the quality default');
  });

  it('marks your own default and offers to reset it to the route’s', () => {
    const out = html(board({ suggestions: [], overrides: { 'image.generate': 'seedream-5-pro' } }));
    expect(out).toMatch(/Seedream 5.0 Pro<\/span><span class="gen-board-tag mine">your default<\/span>/);
    expect(out).toContain('Reset to the route’s default');
  });
});
