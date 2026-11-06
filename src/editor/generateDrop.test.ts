// Images and clips dropped on the Generate composer: each job takes them its
// own way, and a job that takes none moves to the nearest one that does.

import { describe, expect, it } from 'vitest';
import { project as fixture } from '../core/__fixtures__/schema2Project';
import type { Asset, Project } from '../core/types';
import { dropPlan, spreadKeyframes } from './generateDrop';
import type { GenerateDraft } from './generateStore';

const img = (id: string): Asset => ({ id, kind: 'image', name: id, src: `assets/${id}.png`, mimeType: 'image/png', width: 1500, height: 1000 });
const clip = (id: string): Asset => ({ id, kind: 'video', name: id, src: `assets/${id}.mp4`, mimeType: 'video/mp4', durationInFrames: 120 });
const song = (id: string): Asset => ({ id, kind: 'audio', name: id, src: `assets/${id}.mp3`, mimeType: 'audio/mpeg' });

const project: Project = { ...fixture(), assets: Object.fromEntries([img('a'), img('b'), img('c'), clip('v'), song('s')].map((x) => [x.id, x])) };

const draft = (changes: Partial<GenerateDraft>): GenerateDraft => ({ mode: 'video', job: 'video.generate', prompt: 'A slow push in', model: null, policy: null, settings: {}, takes: 1, ...changes });

const patch = (d: GenerateDraft, ids: string[]) => {
  const r = dropPlan(d, ids, project);
  if ('refused' in r) throw new Error(r.refused);
  return r.patch;
};

describe('dropping on a video job', () => {
  it('animates one image dropped on text to video', () => {
    expect(patch(draft({}), ['a'])).toEqual({ job: 'video.animate', settings: { start: { assetId: 'a' } } });
  });

  it('bridges two frames: a second image on an animated one becomes the last frame', () => {
    expect(patch(draft({ job: 'video.animate', settings: { start: { assetId: 'a' } } }), ['b'])).toEqual({ job: 'video.between', settings: { start: { assetId: 'a' }, end: { assetId: 'b' } } });
    expect(patch(draft({}), ['a', 'b'])).toEqual({ job: 'video.between', settings: { start: { assetId: 'a' }, end: { assetId: 'b' } } });
  });

  it('fills the empty slot of a transition and keeps a frame picked from the video', () => {
    const edge = { projectFrame: 89 };
    expect(patch(draft({ job: 'video.between', settings: { start: edge } }), ['a'])).toEqual({ job: 'video.between', settings: { start: edge, end: { assetId: 'a' } } });
    expect(patch(draft({ job: 'video.between', settings: { end: edge } }), ['a'])).toEqual({ job: 'video.between', settings: { start: { assetId: 'a' }, end: edge } });
    expect(patch(draft({ job: 'video.between', settings: {} }), ['a'])).toEqual({ settings: { start: { assetId: 'a' } } });
  });

  it('pins three or more frames as keyframes, spread over the bridge', () => {
    expect(patch(draft({}), ['a', 'b', 'c'])).toEqual({ job: 'video.keyframes', settings: { keyframes: spreadKeyframes([{ assetId: 'a' }, { assetId: 'b' }, { assetId: 'c' }], 5) } });
    expect(spreadKeyframes([{ assetId: 'a' }, { assetId: 'b' }, { assetId: 'c' }], 5).map((k) => k.atSeconds)).toEqual([0, 2.5, 5]);
  });

  it('adds to keyframes in the widest gap', () => {
    const keyframes = [
      { frame: { assetId: 'a' }, atSeconds: 0 },
      { frame: { assetId: 'b' }, atSeconds: 5 },
    ];
    expect(patch(draft({ job: 'video.keyframes', settings: { durationSeconds: 5, keyframes } }), ['c'])).toEqual({ settings: { keyframes: [keyframes[0], { frame: { assetId: 'c' }, atSeconds: 2.5 }, keyframes[1]] } });
  });

  it('keeps a subject: a clip leads to consistent subject, which collects pictures and clips once each', () => {
    expect(patch(draft({}), ['v'])).toEqual({ job: 'video.reference', settings: { referenceAssetIds: ['v'] } });
    expect(patch(draft({ job: 'video.reference', settings: { referenceAssetIds: ['a'] } }), ['a', 'v'])).toEqual({ job: 'video.reference', settings: { referenceAssetIds: ['a', 'v'] } });
  });
});

describe('dropping on an image job', () => {
  it('edits one image and combines more', () => {
    expect(patch(draft({ mode: 'image', job: 'image.generate' }), ['a'])).toEqual({ job: 'image.edit', settings: { referenceAssetIds: ['a'] } });
    expect(patch(draft({ mode: 'image', job: 'image.edit', settings: { referenceAssetIds: ['a'] } }), ['b'])).toEqual({ job: 'image.composite', settings: { referenceAssetIds: ['a', 'b'] } });
    expect(patch(draft({ mode: 'image', job: 'image.composite', settings: { referenceAssetIds: ['a', 'b'] } }), ['c', 'a'])).toEqual({ job: 'image.composite', settings: { referenceAssetIds: ['a', 'b', 'c'] } });
  });

  it('refuses clips, sound, and anything on a sound job', () => {
    expect(dropPlan(draft({ mode: 'image', job: 'image.generate' }), ['v'], project)).toEqual({ refused: expect.stringContaining('not clips') });
    expect(dropPlan(draft({}), ['s'], project)).toEqual({ refused: expect.stringContaining('Only images and video clips') });
    expect(dropPlan(draft({ mode: 'music', job: 'music.bed' }), ['a'], project)).toEqual({ refused: expect.stringContaining('Switch to one of those') });
  });
});
