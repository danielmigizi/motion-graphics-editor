// editor_get_beats source resolution (pure): detached video audio is a valid source.

import { describe, expect, it } from 'vitest';
import { fixtureProject } from '../src/core/__fixtures__/fixtureProject';
import type { Project } from '../src/core/types';
import { pickBeatsSource } from './tools';

/** The fixture with a video (with sound) whose audio was detached into a project-level clip, and the music bed removed. */
function withDetachedVideo(hasAudio?: boolean): Project {
  const p = structuredClone(fixtureProject) as Project;
  p.assets.ast_clip = { id: 'ast_clip', kind: 'video', name: 'clip.mp4', src: 'assets/uploads/u_clip.mp4', mimeType: 'video/mp4', durationInFrames: 300, ...(hasAudio === undefined ? {} : { hasAudio }) };
  p.audio = [
    { id: 'aud_detached', assetId: 'ast_clip', name: 'clip.mp4 audio', startFrame: 0, trimStartFrames: 0, durationInFrames: 300, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 },
    ...p.audio.filter((c) => c.id !== 'aud_music'),
  ];
  return p;
}

describe('pickBeatsSource', () => {
  it('accepts a detached video clip, a video asset with sound, and a video music bed', () => {
    const p = withDetachedVideo(true);
    expect(pickBeatsSource(p, { clipId: 'aud_detached' })).toMatchObject({ clip: { id: 'aud_detached' }, asset: { id: 'ast_clip' } });
    expect(pickBeatsSource(p, { assetId: 'ast_clip' })).toMatchObject({ clip: null, asset: { id: 'ast_clip' } });
    expect(pickBeatsSource(p, {})).toMatchObject({ clip: { id: 'aud_detached' }, asset: { id: 'ast_clip' } });
    // Sound unknown (older probe): let the decoder decide.
    expect(pickBeatsSource(withDetachedVideo(), { clipId: 'aud_detached' })).toMatchObject({ asset: { id: 'ast_clip' } });
  });

  it('still refuses silent videos and pictures', () => {
    const p = withDetachedVideo(false);
    expect(pickBeatsSource(p, { assetId: 'ast_clip' })).toMatchObject({ error: expect.stringContaining('not an audio asset') });
    expect(pickBeatsSource(p, { assetId: 'ast_logo' })).toMatchObject({ error: expect.stringContaining('not an audio asset') });
    expect(pickBeatsSource(fixtureProject, { clipId: 'aud_music' })).toMatchObject({ asset: { id: 'ast_music' } });
  });
});
