import { describe, expect, it } from 'vitest';
import { fixtureProject } from './__fixtures__/fixtureProject';
import { formatCreditsFile, projectAudioCredits } from './credits';
import { OPENVERSE_NOTICE } from './openverseLicense';
import type { Asset } from './types';

const ov = (): Asset => ({
  id: 'ast_ov_calm',
  kind: 'audio',
  name: 'Calm bed',
  src: 'assets/uploads/openverse/ov.mp3',
  mimeType: 'audio/mpeg',
  durationInFrames: 900,
  provenance: {
    source: 'openverse',
    provider: 'openverse',
    providerRefs: { openverseId: '11111111-1111-1111-1111-111111111111' },
    license: {
      spdxOrCc: 'by',
      version: '4.0',
      attribution: '"Calm bed" by Ada is licensed under CC BY 4.0.',
      creator: 'Ada',
      openverseId: '11111111-1111-1111-1111-111111111111',
      foreignLandingUrl: 'https://www.jamendo.com/track/1',
    },
  },
});

describe('project audio credits', () => {
  it('lists unique Openverse attributions from clips and notes the catalog', () => {
    const project = structuredClone(fixtureProject);
    const asset = ov();
    project.assets[asset.id] = asset;
    project.audio.push({
      id: 'aud_ov',
      assetId: asset.id,
      name: asset.name,
      startFrame: 0,
      trimStartFrames: 0,
      durationInFrames: 720,
      volume: 0.6,
      fadeInFrames: 15,
      fadeOutFrames: 45,
    });
    const credits = projectAudioCredits(project);
    expect(credits.lines).toEqual(['"Calm bed" by Ada is licensed under CC BY 4.0.']);
    expect(credits.madeWithOpenverse).toBe(true);
    expect(formatCreditsFile(credits)).toContain(OPENVERSE_NOTICE);
    expect(formatCreditsFile(credits)).toContain('Made with Openverse');
  });

  it('dedupes the same attribution used twice', () => {
    const project = structuredClone(fixtureProject);
    const asset = ov();
    project.assets[asset.id] = asset;
    project.audio.push(
      { id: 'aud_a', assetId: asset.id, name: 'A', startFrame: 0, trimStartFrames: 0, durationInFrames: 10, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 },
      { id: 'aud_b', assetId: asset.id, name: 'B', startFrame: 20, trimStartFrames: 0, durationInFrames: 10, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 },
    );
    expect(projectAudioCredits(project).lines).toHaveLength(1);
  });
});
