import { describe, expect, it } from 'vitest';
import { fixtureProject } from './__fixtures__/fixtureProject';
import { openverseAssetFromImport, openverseAssetId, openverseClipCommands } from './openverseClip';
import { validateProject } from './validate';
import { applyCommand } from './commands';

const work = {
  id: '8624ba61-57f1-4f98-8a85-ece206c319cf',
  title: 'Wish You Were Here',
  creator: 'Ada',
  durationSeconds: 24,
  license: 'cc0',
  attribution: '"Wish You Were Here" by Ada is licensed under CC0.',
  tags: ['ambient'],
  url: 'https://example.com/a.mp3',
  foreignLandingUrl: 'https://www.jamendo.com/track/1',
};

describe('Openverse clip commands', () => {
  it('adds a music bed with fades covering the video', () => {
    const project = structuredClone(fixtureProject);
    const asset = openverseAssetFromImport(work, {
      src: 'assets/uploads/openverse/8624ba61-57f1-4f98-8a85-ece206c319cf.mp3',
      name: work.title,
      mimeType: 'audio/mpeg',
      kind: 'audio',
      bytes: 12,
      durationSeconds: 24,
    }, project.fps);
    expect(asset.id).toBe(openverseAssetId(work.id));
    expect(asset.provenance?.source).toBe('openverse');
    expect(asset.provenance?.license?.openverseId).toBe(work.id);
    const commands = openverseClipCommands(project, asset, { clipId: 'aud_ov_bed', role: 'music', startFrame: 0 });
    expect(commands[0]).toMatchObject({ type: 'addAsset', asset: { id: asset.id } });
    expect(commands[1]).toMatchObject({
      type: 'addAudioClip',
      clip: { id: 'aud_ov_bed', startFrame: 0, volume: 0.6, fadeInFrames: 15, fadeOutFrames: 45 },
    });
    expect((commands[1] as { clip: { sceneId?: string } }).clip.sceneId).toBeUndefined();
    let doc = project;
    for (const c of commands) {
      const r = applyCommand(doc, c, { source: 'ai' });
      if (!r.ok) throw new Error(r.error.message);
      doc = r.project;
    }
    expect(validateProject(doc).ok).toBe(true);
    expect(doc.audio.some((c) => c.id === 'aud_ov_bed' && !c.sceneId)).toBe(true);
  });

  it('anchors SFX to a scene without fades', () => {
    const project = structuredClone(fixtureProject);
    const asset = openverseAssetFromImport(work, {
      src: 'assets/uploads/openverse/8624ba61-57f1-4f98-8a85-ece206c319cf.mp3',
      name: 'Whoosh',
      mimeType: 'audio/mpeg',
      kind: 'audio',
      bytes: 4,
      durationSeconds: 0.7,
    }, project.fps);
    const commands = openverseClipCommands(project, asset, { clipId: 'aud_ov_sfx', role: 'sfx', sceneId: 'scn_intro', startFrame: 12 });
    expect(commands[1]).toMatchObject({
      type: 'addAudioClip',
      clip: { sceneId: 'scn_intro', startFrame: 12, fadeInFrames: 0, fadeOutFrames: 0 },
    });
  });
});
