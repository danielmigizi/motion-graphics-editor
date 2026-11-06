// The Generate tab's store: delivering finished jobs into the open project
// (one undo step, the server told once, however the event and the fetch
// race; never re-added after Undo; never mid-drag), quotes and refusals that
// go stale with the status, and prefilling the draft.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocState } from '../core/history';
import { project } from '../core/__fixtures__/schema2Project';
import { DEFAULT_GENERATION_SETTINGS, type GenerationJob, type GenerationStatus } from '../core/generationStudio';
import type { Asset } from '../core/types';
import { api } from './api';
import type { Project } from '../core/types';
import {
  acrossCut,
  addMissingTakes,
  applyGenerationJob,
  BRIDGE_SECONDS,
  brokenCut,
  carriedOverNote,
  cutAfter,
  draftProblem,
  elapsedText,
  frameSourceLabel,
  frameWarning,
  GENERATE_MODES,
  JOB_LABELS,
  jobElapsedMs,
  jobsOf,
  missingTakes,
  nextKeyframeTime,
  openGenerate,
  parseGeneratePrefs,
  pickedFrame,
  quoteFresh,
  referenceLabels,
  refreshGenerationStatus,
  sceneEdgeFrame,
  statusStamp,
  submitDraft,
  syncGenerationJobs,
  toRequest,
  useGenerate,
  watchGenerationProject,
} from './generateStore';
import { useLayout } from './layout';
import { useEditor } from './store';

vi.mock('./api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('./api')>();
  return { ...mod, api: { ...mod.api, generationDelivered: vi.fn(), listGenerationJobs: vi.fn(), generationStatus: vi.fn(), startGeneration: vi.fn() } };
});

const st = () => useEditor.getState();
const flush = () => new Promise((r) => setTimeout(r, 0));

const take = (id: string): Asset => ({ id, kind: 'image', name: id, src: `assets/generated/${id}.png`, mimeType: 'image/png', width: 1024, height: 1024 });

function job(id: string, changes: Partial<GenerationJob> = {}): GenerationJob {
  return {
    id,
    projectId: 'p',
    job: 'image.generate',
    prompt: 'A red fox in snow',
    model: 'seedream-5-pro',
    modelLabel: 'Seedream 5.0 Pro',
    endpoint: 'fal-ai/seedream',
    policy: 'quality',
    routeVersion: 'r1',
    overridden: false,
    settings: {},
    takes: 2,
    requestedBy: { origin: 'user' },
    status: 'done',
    createdAt: 1,
    estimate: { usd: 0.135, basis: '2 × $0.0675 per image' },
    falRequestIds: [],
    outputs: [take(`${id}_a`), take(`${id}_b`)],
    delivered: false,
    ...changes,
  };
}

beforeEach(() => {
  st().loadDocument(createDocState(project()), { kind: 'sample' });
  useEditor.setState({ toasts: [] });
  useGenerate.setState({ jobs: [] });
  vi.mocked(api.generationDelivered).mockReset().mockImplementation(async (id) => ({ ...job(id), delivered: true }));
  vi.mocked(api.listGenerationJobs).mockReset();
  vi.mocked(api.generationStatus).mockReset().mockResolvedValue({ key: { configured: true }, settings: DEFAULT_GENERATION_SETTINGS, spendTodayUsd: 0, activeJobs: 0 });
});

describe('delivering takes', () => {
  it('adds every take in one undo step and tells the server once, though the event and the fetch race', async () => {
    const j = job('gjob_race');
    vi.mocked(api.listGenerationJobs).mockResolvedValue([j]);
    const steps = st().doc.undoStack.length;
    applyGenerationJob(j);
    await syncGenerationJobs();
    applyGenerationJob(j);
    await flush();
    expect(Object.keys(st().doc.project.assets)).toEqual(['gjob_race_a', 'gjob_race_b']);
    expect(st().doc.undoStack.length).toBe(steps + 1);
    expect(api.generationDelivered).toHaveBeenCalledTimes(1);
    expect(api.generationDelivered).toHaveBeenCalledWith('gjob_race');
    expect(st().toasts.map((t) => t.message)).toEqual(['2 takes ready in Assets › Generated']);
    expect(useGenerate.getState().jobs.map((x) => [x.id, x.delivered])).toEqual([['gjob_race', true]]);
    st().undo();
    expect(st().doc.project.assets).toEqual({});
  });

  it('skips jobs for another project, unfinished jobs and jobs already delivered', async () => {
    applyGenerationJob(job('gjob_elsewhere', { projectId: 'other' }));
    applyGenerationJob(job('gjob_running', { status: 'running', outputs: [] }));
    applyGenerationJob(job('gjob_done_before', { delivered: true }));
    await flush();
    expect(st().doc.project.assets).toEqual({});
    expect(api.generationDelivered).not.toHaveBeenCalled();
    // Still in the queue: the tab lists the open project's.
    expect(useGenerate.getState().jobs).toHaveLength(3);
  });

  it('adds only the takes the project lacks', async () => {
    const p = project();
    st().loadDocument(createDocState({ ...p, assets: { gjob_part_a: take('gjob_part_a') } }), { kind: 'sample' });
    applyGenerationJob(job('gjob_part'));
    await flush();
    expect(Object.keys(st().doc.project.assets)).toEqual(['gjob_part_a', 'gjob_part_b']);
    expect(st().doc.undoStack.at(-1)?.label).toBe('Add 1 generated take');
    expect(st().toasts.map((t) => t.message)).toEqual(['1 take ready in Assets › Generated']);
    expect(api.generationDelivered).toHaveBeenCalledWith('gjob_part');
  });

  it('tells the server again after a failed report, without adding anything twice', async () => {
    vi.mocked(api.generationDelivered).mockRejectedValueOnce(new Error('down'));
    const j = job('gjob_retry');
    vi.mocked(api.listGenerationJobs).mockResolvedValue([j]);
    applyGenerationJob(j);
    await flush();
    const steps = st().doc.undoStack.length;
    await syncGenerationJobs();
    expect(st().doc.undoStack.length).toBe(steps);
    expect(Object.keys(st().doc.project.assets)).toHaveLength(2);
    expect(api.generationDelivered).toHaveBeenCalledTimes(2);
  });

  it('never adds undone takes back: after a failed report, a sync retries only the report', async () => {
    vi.mocked(api.generationDelivered).mockRejectedValueOnce(new Error('down'));
    const j = job('gjob_undo');
    vi.mocked(api.listGenerationJobs).mockResolvedValue([j]);
    applyGenerationJob(j);
    await flush();
    expect(Object.keys(st().doc.project.assets)).toHaveLength(2);
    st().undo();
    expect(st().doc.project.assets).toEqual({});
    // The server still lists the job as undelivered.
    await syncGenerationJobs();
    await flush();
    expect(st().doc.project.assets).toEqual({});
    expect(st().doc.redoStack.at(-1)?.label).toBe('Add 2 generated takes');
    expect(api.generationDelivered).toHaveBeenCalledTimes(2);
    // Redo is an ordinary redo.
    st().redo();
    expect(Object.keys(st().doc.project.assets)).toEqual(['gjob_undo_a', 'gjob_undo_b']);
  });

  it('waits for a drag to end before adding takes', async () => {
    const drag = st().beginGesture();
    applyGenerationJob(job('gjob_drag'));
    await flush();
    expect(st().doc.project.assets).toEqual({});
    expect(api.generationDelivered).not.toHaveBeenCalled();
    drag.end();
    await flush();
    expect(Object.keys(st().doc.project.assets)).toEqual(['gjob_drag_a', 'gjob_drag_b']);
    expect(api.generationDelivered).toHaveBeenCalledWith('gjob_drag');
  });
});

describe('quotes and refusals follow the status', () => {
  const status = (changes: Partial<GenerationStatus> = {}): GenerationStatus => ({ key: { configured: true }, settings: DEFAULT_GENERATION_SETTINGS, spendTodayUsd: 0, activeJobs: 0, ...changes });

  it('a changed budget or spend makes the quote stale and clears the last refusal', async () => {
    vi.mocked(api.generationStatus).mockResolvedValue(status({ settings: { ...DEFAULT_GENERATION_SETTINGS, dailyBudgetUsd: 0 } }));
    await refreshGenerationStatus();
    const quote = { route: { model: 'm', modelLabel: 'M', endpoint: 'e', reason: 'quality default', overridden: false, dropped: [] }, estimate: { usd: 0.5, basis: '1 × $0.50' }, spendTodayUsd: 0, budgetUsd: 0, overBudget: true, needsConfirm: false };
    const { draft } = useGenerate.getState();
    useGenerate.setState({ quote, quoteFor: draft, quoteStamp: statusStamp(useGenerate.getState().status), submitError: 'Over your $0.00 daily budget.' });
    expect(quoteFresh()).toBe(true);

    // The same status again changes nothing.
    await refreshGenerationStatus();
    expect(quoteFresh()).toBe(true);
    expect(useGenerate.getState().submitError).toBe('Over your $0.00 daily budget.');

    // The budget raised in Settings.
    vi.mocked(api.generationStatus).mockResolvedValue(status());
    await refreshGenerationStatus();
    expect(quoteFresh()).toBe(false);
    expect(useGenerate.getState().submitError).toBeNull();

    // Spend moved by a job.
    useGenerate.setState({ quoteStamp: statusStamp(useGenerate.getState().status), submitError: 'Refused.' });
    vi.mocked(api.generationStatus).mockResolvedValue(status({ spendTodayUsd: 0.5 }));
    await refreshGenerationStatus();
    expect(quoteFresh()).toBe(false);
    expect(useGenerate.getState().submitError).toBeNull();
  });
});

describe('the draft', () => {
  it('openGenerate shows the Generate tab and merges the prefill', () => {
    useLayout.setState({ rightOpen: false, rightTab: 'inspector' });
    openGenerate({ mode: 'image' });
    expect(useLayout.getState()).toMatchObject({ rightOpen: true, rightTab: 'generate' });
    // A new job brings its defaults: the video's 1000×600 frame is nearest 16:9.
    expect(useGenerate.getState().draft).toMatchObject({ mode: 'image', job: 'image.generate', model: null, settings: { aspectRatio: '16:9', resolution: '1k' } });

    openGenerate({ prompt: 'More foxes', regenerateOf: 'gjob_1', takes: 9 });
    expect(useGenerate.getState().draft).toMatchObject({ mode: 'image', job: 'image.generate', prompt: 'More foxes', regenerateOf: 'gjob_1', takes: 4 });

    openGenerate({ job: 'music.bed' });
    const d = useGenerate.getState().draft;
    expect(d).toMatchObject({ mode: 'music', job: 'music.bed', settings: { durationSeconds: 3, instrumental: true } });
    expect(d.regenerateOf).toBeUndefined();
  });

  it('a fresh prefill (More like this) carries exactly the request, nothing left from the draft before', () => {
    openGenerate({ job: 'video.reference', settings: { referenceAssetIds: ['ast_1'], start: { assetId: 'ast_1' }, durationSeconds: 12 } });
    openGenerate({ job: 'video.reference', model: 'kling-o3', settings: { referenceAssetIds: ['ast_2'] }, regenerateOf: 'gjob_9' }, true);
    const d = useGenerate.getState().draft;
    expect(d).toMatchObject({ mode: 'video', job: 'video.reference', model: 'kling-o3', regenerateOf: 'gjob_9', settings: { referenceAssetIds: ['ast_2'], durationSeconds: 3 } });
    expect(d.settings.start).toBeUndefined();
  });

  it('says what an edit or a composite still needs', () => {
    openGenerate({ job: 'image.edit', prompt: 'Make the sky orange', settings: { referenceAssetIds: [] } });
    expect(draftProblem(useGenerate.getState().draft)).toBe('Pick the image to edit.');
    openGenerate({ job: 'image.composite', settings: { referenceAssetIds: ['ast_1'] } });
    expect(draftProblem(useGenerate.getState().draft)).toBe('Pick at least one more image to combine.');
    useGenerate.getState().setDraft({ settings: { referenceAssetIds: ['ast_1', 'ast_2'] } });
    expect(draftProblem(useGenerate.getState().draft)).toBeNull();
  });
});

/** Three scenes at 30 fps: Intro 8 s (frames 0–239), Product 1.5 s (240–284), Outro 40 s (285–1484); a picture and two clips. */
function threeScenes(): Project {
  const p = project();
  const scene = p.scenes[0];
  return {
    ...p,
    scenes: [
      { ...scene, id: 'intro', name: 'Intro', durationInFrames: 240 },
      { ...scene, id: 'product', name: 'Product', durationInFrames: 45 },
      { ...scene, id: 'outro', name: 'Outro', durationInFrames: 1200 },
    ],
    assets: {
      pic: { id: 'pic', kind: 'image', name: 'Bottle', src: 'assets/bottle.png', mimeType: 'image/png' },
      clip1: { id: 'clip1', kind: 'video', name: 'Pour', src: 'assets/pour.mp4', mimeType: 'video/mp4', durationInFrames: 240 },
      clip2: { id: 'clip2', kind: 'video', name: 'Spin', src: 'assets/spin.mp4', mimeType: 'video/mp4', durationInFrames: 240 },
    },
  };
}

const draft = () => useGenerate.getState().draft;

describe('video', () => {
  beforeEach(() => {
    st().loadDocument(createDocState(threeScenes()), { kind: 'sample' });
    useGenerate.getState().setDraft({ job: 'music.bed', prompt: 'A slow push in on the bottle' });
  });

  it('is the fifth mode, with its six jobs and their plain names', () => {
    expect(GENERATE_MODES.map((m) => m.label)).toEqual(['Music', 'Voice-over', 'Sound effect', 'Image', 'Video']);
    expect(jobsOf('video')).toEqual(['video.generate', 'video.animate', 'video.between', 'video.keyframes', 'video.reference', 'video.long']);
    expect(jobsOf('video').map((j) => JOB_LABELS[j])).toEqual([
      'A clip from text',
      'Animate this image',
      'Between two frames (across a cut)',
      'Through pinned keyframes',
      'Keep a subject consistent across shots',
      'Longer clip, or from a document or web page',
    ]);
    useGenerate.getState().setDraft({ mode: 'video' });
    expect(draft()).toMatchObject({ mode: 'video', job: 'video.generate', settings: { aspectRatio: '16:9', videoResolution: '1080p' } });
  });

  it('takes its length from the selected scene, in whole seconds within 2–30 s', () => {
    st().selectElement('intro', null);
    openGenerate({ job: 'video.generate' }, true);
    expect(draft().settings.durationSeconds).toBe(8);
    st().selectElement('product', null);
    openGenerate({ job: 'video.generate' }, true);
    expect(draft().settings.durationSeconds).toBe(2);
    st().selectElement('outro', null);
    openGenerate({ job: 'video.generate' }, true);
    expect(draft().settings.durationSeconds).toBe(30);
  });

  it('between prefills across the cut after the selected scene: its last frame to the next scene’s first, as a 5 s bridge', () => {
    st().selectElement('intro', null);
    openGenerate({ job: 'video.between' }, true);
    const s = draft().settings;
    // A transition is a bridge clip, not the 8 s scene.
    expect(s).toMatchObject({ start: { projectFrame: 239 }, end: { projectFrame: 240 }, durationSeconds: BRIDGE_SECONDS });
    expect(BRIDGE_SECONDS).toBe(5);
    const p = st().doc.project;
    expect([frameSourceLabel(s.start!, p), frameSourceLabel(s.end!, p)]).toEqual(['End of Intro', 'Start of Product']);
    expect(acrossCut(p, s.start, s.end)).toMatchObject({ from: { name: 'Intro' }, to: { name: 'Product' } });
    expect(draftProblem(draft())).toBeNull();
    // Where the frames came from stays in the editor.
    expect(toRequest(draft(), 'p').settings).toMatchObject({ start: { projectFrame: 239 }, end: { projectFrame: 240 } });
    expect(toRequest(draft(), 'p').settings?.start).toEqual({ projectFrame: 239 });
    expect(toRequest(draft(), 'p').settings?.end).toEqual({ projectFrame: 240 });
  });

  it('keyframes start as a 5 s bridge too; a clip from text or an image keeps the scene’s length', () => {
    st().selectElement('intro', null);
    openGenerate({ job: 'video.keyframes' }, true);
    expect(draft().settings.durationSeconds).toBe(5);
    openGenerate({ job: 'video.animate' }, true);
    expect(draft().settings.durationSeconds).toBe(8);
    openGenerate({ job: 'video.reference' }, true);
    expect(draft().settings.durationSeconds).toBe(8);
  });

  it('between after the last scene: the first frame only, and it says the last is missing', () => {
    st().selectElement('outro', null);
    openGenerate({ job: 'video.between' }, true);
    const s = draft().settings;
    expect(s.start).toMatchObject({ projectFrame: 1484 });
    expect(s.end).toBeUndefined();
    expect(frameSourceLabel(s.start!, st().doc.project)).toBe('End of Outro');
    expect(acrossCut(st().doc.project, s.start, s.end)).toBeNull();
    expect(draftProblem(draft())).toBe('Pick the last frame.');
  });

  it('names frames inside a scene and images by name', () => {
    const p = st().doc.project;
    expect(frameSourceLabel({ projectFrame: 75 }, p)).toBe('Intro at 2.5 s');
    expect(frameSourceLabel({ assetId: 'pic' }, p)).toBe('Bottle');
    expect(frameSourceLabel({ assetId: 'gone' }, p)).toBe('An image no longer in the project');
  });

  it('animate needs its image; the selected image fills it', () => {
    openGenerate({ job: 'video.animate' }, true);
    expect(draftProblem(draft())).toBe('Pick the image to animate.');
    useGenerate.getState().setDraft({ settings: { start: { assetId: 'pic' } } });
    expect(draftProblem(draft())).toBeNull();
  });

  it('keyframes: at least 3, at most 10, inside the clip, at different times, sent in time order', () => {
    st().selectElement('intro', null);
    openGenerate({ job: 'video.keyframes', settings: { durationSeconds: 8 } }, true);
    expect(draft().settings.keyframes).toEqual([]);
    expect(draftProblem(draft())).toBe('Pin at least 3 frames (0 so far).');
    // New pins go to the start, the end, then the middle of the widest gap.
    expect([nextKeyframeTime([], 8), nextKeyframeTime([0], 8), nextKeyframeTime([0, 8], 8), nextKeyframeTime([0, 4, 8], 8), nextKeyframeTime([0, 2, 4, 8], 8)]).toEqual([0, 8, 4, 2, 6]);
    const at = (atSeconds: number, projectFrame = 0) => ({ frame: { projectFrame }, atSeconds });
    useGenerate.getState().setDraft({ settings: { keyframes: [at(0), at(8, 239)] } });
    expect(draftProblem(draft())).toBe('Pin at least 3 frames (2 so far).');
    useGenerate.getState().setDraft({ settings: { keyframes: [at(8, 239), at(0), at(4, 120)] } });
    expect(draftProblem(draft())).toBeNull();
    expect(toRequest(draft(), 'p').settings?.keyframes?.map((k) => k.atSeconds)).toEqual([0, 4, 8]);
    // Sent bare: the frame only, not where it came from.
    expect(toRequest(draft(), 'p').settings?.keyframes?.map((k) => k.frame)).toEqual([{ projectFrame: 0 }, { projectFrame: 120 }, { projectFrame: 239 }]);
    useGenerate.getState().setDraft({ settings: { keyframes: [at(0), at(4), at(9.5)] } });
    expect(draftProblem(draft())).toBe('A frame is pinned at 9.5 s, past the end of the 8 s clip.');
    useGenerate.getState().setDraft({ settings: { keyframes: [at(0), at(4), at(4)] } });
    expect(draftProblem(draft())).toBe('Two frames are pinned at the same time.');
    useGenerate.getState().setDraft({ settings: { keyframes: Array.from({ length: 11 }, (_, i) => at(i * 0.5)) } });
    expect(draftProblem(draft())).toBe('Pin at most 10 frames.');
  });

  it('reference: at least one image or clip, within 9 images, 3 clips and 15 s of video', () => {
    openGenerate({ job: 'video.reference' }, true);
    expect(draftProblem(draft())).toBe('Pick at least one image or clip of the subject.');
    useGenerate.getState().setDraft({ settings: { referenceAssetIds: ['pic', 'clip1'] } });
    expect(draftProblem(draft())).toBeNull();
    // Two 8 s clips: 16 s.
    useGenerate.getState().setDraft({ settings: { referenceAssetIds: ['pic', 'clip1', 'clip2'] } });
    expect(draftProblem(draft())).toBe('The clips run 16 s; 15 s of video at most in total.');
  });

  it('long: the link is optional, https only, and an empty one is left out of the request', () => {
    openGenerate({ job: 'video.long' }, true);
    expect(draftProblem(draft())).toBeNull();
    useGenerate.getState().setDraft({ settings: { webUrl: '' } });
    expect(toRequest(draft(), 'p').settings).not.toHaveProperty('webUrl');
    useGenerate.getState().setDraft({ settings: { webUrl: 'http://example.com' } });
    expect(draftProblem(draft())).toBe('The link must be a full https:// address.');
    useGenerate.getState().setDraft({ settings: { webUrl: 'https://example.com/product' } });
    expect(draftProblem(draft())).toBeNull();
    expect(toRequest(draft(), 'p').settings).toMatchObject({ webUrl: 'https://example.com/product' });
  });
});

describe('frames that follow the video', () => {
  let stopWatching: () => void = () => undefined;
  beforeEach(() => {
    // Empty scenes: the fixture's shared element ids would fail every edit's validation.
    const p = threeScenes();
    st().loadDocument(createDocState({ ...p, scenes: p.scenes.map((s) => ({ ...s, elements: [] })) }), { kind: 'sample' });
    stopWatching = watchGenerationProject();
    st().selectElement('intro', null);
    openGenerate({ job: 'video.between', prompt: 'The bottle turns into the logo' }, true);
  });
  afterEach(() => stopWatching());

  const frames = () => [draft().settings.start, draft().settings.end].map((f) => (f && 'projectFrame' in f ? f.projectFrame : null));
  const run = (command: Parameters<ReturnType<typeof st>['run']>[0]) => expect(st().run(command, 'Edit')).toBe(true);

  it('ends on the next scene’s first fully visible frame when it has an entrance transition', () => {
    run({ type: 'updateScene', sceneId: 'product', changes: { transitionIn: { type: 'fade', durationInFrames: 12 } } });
    const p = st().doc.project;
    expect(cutAfter(p, 'intro')).toMatchObject({ end: 239, start: 252, entrance: 'fade' });
    // The draft already followed: its end was "the start of Product".
    expect(frames()).toEqual([239, 252]);
    expect(frameSourceLabel(draft().settings.end!, p)).toBe('Start of Product (after its fade)');
    expect(acrossCut(p, draft().settings.start, draft().settings.end)).toMatchObject({ from: { name: 'Intro' }, to: { name: 'Product' } });
    // A fresh prefill starts there too; frame 0 of the scene still reads as its start.
    openGenerate({ job: 'video.between' }, true);
    expect(frames()).toEqual([239, 252]);
    expect(frameSourceLabel({ projectFrame: 240 }, p)).toBe('Start of Product');
  });

  it('re-derives both frames when a scene’s length changes, and when scenes move', () => {
    run({ type: 'updateScene', sceneId: 'intro', changes: { durationInFrames: 300 } });
    expect(frames()).toEqual([299, 300]);
    expect(acrossCut(st().doc.project, draft().settings.start, draft().settings.end)).not.toBeNull();
    // Product moves to the end: each frame follows its own scene, and the tab says the cut is gone.
    run({ type: 'moveScene', sceneId: 'product', toIndex: 2 });
    expect(frames()).toEqual([299, 1500]);
    expect(acrossCut(st().doc.project, draft().settings.start, draft().settings.end)).toBeNull();
    expect(brokenCut(st().doc.project, draft().settings.start, draft().settings.end)).toBe('“Product” no longer comes right after “Intro”.');
  });

  it('clears a frame whose scene was deleted and says what is missing until another is picked', () => {
    run({ type: 'removeScene', sceneId: 'product' });
    expect(draft().settings.start).toMatchObject({ projectFrame: 239 });
    expect(draft().settings.end).toBeUndefined();
    expect(draft().lostFrames).toEqual({ end: 'The start of “Product”, which was deleted' });
    expect(draftProblem(draft())).toBe('Pick the last frame.');
    useGenerate.getState().setDraft({ settings: { end: sceneEdgeFrame(st().doc.project, st().doc.project.scenes[1], 'start') } });
    expect(draft().lostFrames).toBeUndefined();
    expect(frames()).toEqual([239, 240]);
  });

  it('keyframes from a deleted scene are removed and said; edges of the others follow', () => {
    const p = st().doc.project;
    openGenerate({ job: 'video.keyframes', settings: { keyframes: [0, 2.5, 5].map((atSeconds, i) => ({ atSeconds, frame: sceneEdgeFrame(p, p.scenes[i], 'end') })) } }, true);
    run({ type: 'removeScene', sceneId: 'product' });
    expect(draft().settings.keyframes?.map((k) => ('projectFrame' in k.frame ? k.frame.projectFrame : null))).toEqual([239, 1439]);
    expect(draft().lostFrames?.keyframes).toBe('Removed a pinned frame: The end of “Product”, which was deleted.');
  });

  it('a frame picked at a time stays put, and warns once it lies in another scene', () => {
    const p = st().doc.project;
    useGenerate.getState().setDraft({ settings: { start: pickedFrame(p, 200) } });
    expect(frameWarning(draft().settings.start, st().doc.project)).toBeNull();
    // Intro shrinks to 6 s: frame 200 now lies in Product (180–224).
    run({ type: 'updateScene', sceneId: 'intro', changes: { durationInFrames: 180 } });
    expect(draft().settings.start).toMatchObject({ projectFrame: 200 });
    expect(frameWarning(draft().settings.start, st().doc.project)).toBe('Picked in “Intro”; scenes have changed and this time is now in “Product”.');
  });

  it('More like this re-derives the frames the request was sent with', async () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) });
    try {
      useGenerate.setState({ submitting: false });
      vi.mocked(api.startGeneration).mockResolvedValue({ job: job('gjob_bridge', { job: 'video.between', status: 'queued', outputs: [] }) });
      expect(await submitDraft()).toMatchObject({ id: 'gjob_bridge' });
      // What the server stored with the takes: bare frames.
      const sent = vi.mocked(api.startGeneration).mock.calls[0][0].settings!;
      expect([sent.start, sent.end]).toEqual([{ projectFrame: 239 }, { projectFrame: 240 }]);
      // Intro grows by 2 s; the take's request still says 239 → 240.
      run({ type: 'updateScene', sceneId: 'intro', changes: { durationInFrames: 300 } });
      openGenerate({ job: 'video.between', settings: sent, regenerateOf: 'gjob_bridge', takes: 2 }, true);
      expect(frames()).toEqual([299, 300]);
      expect(draft().regenerateOf).toBe('gjob_bridge');
      // And the tab opens on Video › Between next time.
      expect(parseGeneratePrefs(store.get('mge.generate')).job).toBe('video.between');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('references and remembered choices', () => {
  it('numbers references as the model sees them: images and clips apart, in the order chosen', () => {
    const p = threeScenes();
    p.assets.pic2 = { ...p.assets.pic, id: 'pic2', name: 'Label' };
    expect([...referenceLabels(['pic', 'clip1', 'pic2', 'gone'], p)]).toEqual([
      ['pic', 'Image 1'],
      ['clip1', 'Video 1'],
      ['pic2', 'Image 2'],
    ]);
  });

  it('remembers a valid job only; anything else starts on Music', () => {
    expect(parseGeneratePrefs(JSON.stringify({ job: 'video.keyframes' })).job).toBe('video.keyframes');
    expect(parseGeneratePrefs(JSON.stringify({ job: 'video.teleport' })).job).toBe('music.bed');
    expect(parseGeneratePrefs('not json').job).toBe('music.bed');
    expect(parseGeneratePrefs(null)).toEqual({ job: 'music.bed', origins: {}, scenes: {} });
    // The scene a request's music was for: names only.
    expect(parseGeneratePrefs(JSON.stringify({ scenes: { gjob_1: 'intro', gjob_2: 4 } })).scenes).toEqual({ gjob_1: 'intro' });
  });
});

describe('takes not in the open document', () => {
  it('offers the takes of a done job delivered into a document since replaced, and adds them in one undo step only when asked', async () => {
    const j = job('gjob_recovered');
    applyGenerationJob(j);
    await flush();
    expect(Object.keys(st().doc.project.assets)).toHaveLength(2);
    expect(missingTakes(useGenerate.getState().jobs[0], st().doc.project, st().docSession)).toEqual([]);

    // "Recover r5": the same project, reopened from before the takes arrived.
    st().loadDocument(createDocState(project()), { kind: 'server', id: 'p' });
    const delivered = useGenerate.getState().jobs[0];
    expect(delivered.delivered).toBe(true);
    vi.mocked(api.listGenerationJobs).mockResolvedValue([delivered]);
    await syncGenerationJobs();
    // Nothing comes back by itself …
    expect(st().doc.project.assets).toEqual({});
    expect(missingTakes(delivered, st().doc.project, st().docSession).map((a) => a.id)).toEqual(['gjob_recovered_a', 'gjob_recovered_b']);

    // … the row's "Add takes" does it, as one undo step.
    const steps = st().doc.undoStack.length;
    await addMissingTakes(delivered);
    expect(Object.keys(st().doc.project.assets)).toEqual(['gjob_recovered_a', 'gjob_recovered_b']);
    expect(st().doc.undoStack.length).toBe(steps + 1);
    expect(missingTakes(delivered, st().doc.project, st().docSession)).toEqual([]);
    // Undo is respected: a sync does not add them again.
    st().undo();
    await syncGenerationJobs();
    expect(st().doc.project.assets).toEqual({});
  });

  it('offers nothing while the job’s own delivery is still to come', () => {
    expect(missingTakes(job('gjob_new'), st().doc.project, st().docSession)).toEqual([]);
    expect(missingTakes(job('gjob_running', { status: 'running', delivered: true }), st().doc.project, st().docSession)).toEqual([]);
    expect(missingTakes(job('gjob_other', { projectId: 'other', delivered: true }), st().doc.project, st().docSession)).toEqual([]);
  });
});

describe('jobs across a reload', () => {
  it('measures elapsed time from the server’s timestamps, not from when the page loaded', () => {
    const now = 1_000_000;
    const running = job('gjob_old', { status: 'running', createdAt: now - 95_000, startedAt: now - 90_000, outputs: [] });
    expect(elapsedText(jobElapsedMs(running, now))).toBe('1:30');
    // Queued (not started yet): from when it was asked for.
    expect(elapsedText(jobElapsedMs(job('gjob_q', { status: 'queued', createdAt: now - 8_000, outputs: [] }), now))).toBe('8 s');
    // Finished: fixed at its own end.
    expect(elapsedText(jobElapsedMs(job('gjob_d', { createdAt: now - 60_000, startedAt: now - 50_000, finishedAt: now - 38_000 }), now))).toBe('12 s');
  });

  it('says when a still-active job began before this page opened; the server’s own note wins', () => {
    const opened = 500_000;
    expect(carriedOverNote(job('gjob_a', { status: 'running', createdAt: opened - 1 }), opened)).toBe('Started before this page opened');
    expect(carriedOverNote(job('gjob_b', { status: 'running', createdAt: opened + 1 }), opened)).toBeNull();
    expect(carriedOverNote(job('gjob_c', { status: 'done', createdAt: opened - 1 }), opened)).toBeNull();
    expect(carriedOverNote(job('gjob_d', { status: 'running', createdAt: opened - 1, note: 'Resumed after a restart' }), opened)).toBeNull();
  });

  it('a job synced after a reload keeps its server timestamps', async () => {
    const before = job('gjob_resumed', { status: 'running', createdAt: 1_000, startedAt: 2_000, outputs: [], note: 'Resumed after a restart' });
    vi.mocked(api.listGenerationJobs).mockResolvedValue([before]);
    await syncGenerationJobs();
    expect(useGenerate.getState().jobs.find((j) => j.id === 'gjob_resumed')).toMatchObject({ status: 'running', createdAt: 1_000, startedAt: 2_000, note: 'Resumed after a restart' });
  });
});
