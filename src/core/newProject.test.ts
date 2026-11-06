import { describe, expect, it } from 'vitest';
import { applyOutline, blankProject, DEFAULT_FORMAT, formatOf, isUntouched, UNTITLED_NAME } from './newProject';
import { parseOutline, type Outline, type VideoBrief } from './outline';
import { projectDurationInFrames } from './timing';
import { validateProject } from './validate';

const ids = { project: 'prj_blank', scene: 'scn_1' };

function outline(): Outline {
  const r = parseOutline({
    title: 'Relay in 30 seconds',
    scenes: [
      { name: 'Hook', purpose: 'Name the pain', durationSeconds: 4 },
      { name: 'Product', purpose: 'Show the brief', durationSeconds: 12.5 },
      { name: 'Outro', purpose: 'Call to action', durationSeconds: 6 },
    ],
  });
  if (!r.ok) throw new Error(r.message);
  return r.outline;
}

const brief: VideoBrief = {
  brief: 'Launch video for Relay.',
  audience: '',
  tone: '',
  targetSeconds: 24,
  width: 1080,
  height: 1920,
  fps: 25,
  backgroundColor: '#101010',
  brandColors: [],
  files: [
    { id: 'ast_logo1', kind: 'svg', name: 'relay.svg', src: 'assets/uploads/u_1.svg', mimeType: 'image/svg+xml', width: 480, height: 140 },
    { id: 'ast_song', kind: 'audio', name: 'song.mp3', src: 'assets/uploads/u_2.mp3', mimeType: 'audio/mpeg', durationSeconds: 40 },
  ],
  logoId: 'ast_logo1',
};

describe('blank project', () => {
  it('is a valid, untouched project with one empty scene in the given format', () => {
    const p = blankProject(ids, { width: 1080, height: 1080, fps: 24, backgroundColor: '#FFFFFF' });
    expect(validateProject(p).ok).toBe(true);
    expect(p).toMatchObject({ id: 'prj_blank', name: UNTITLED_NAME, revision: 1, width: 1080, height: 1080, fps: 24, backgroundColor: '#FFFFFF' });
    expect(p.scenes).toHaveLength(1);
    expect(p.scenes[0]).toMatchObject({ id: 'scn_1', durationInFrames: 120, elements: [], backgroundColor: '#FFFFFF' });
    expect(isUntouched(p)).toBe(true);
    expect(formatOf(p)).toEqual({ width: 1080, height: 1080, fps: 24, backgroundColor: '#FFFFFF' });
  });

  it('defaults to landscape 1080p at 30 fps', () => {
    const p = blankProject(ids);
    expect(formatOf(p)).toEqual(DEFAULT_FORMAT);
    expect(p.scenes[0].durationInFrames).toBe(150);
  });

  it('counts an element, an asset, a clip or a marker as touched', () => {
    const p = blankProject(ids);
    expect(isUntouched({ ...p, assets: { a: { id: 'a', kind: 'image', name: 'x', src: 'assets/x.png', mimeType: 'image/png' } } })).toBe(false);
    expect(isUntouched({ ...p, markers: [{ id: 'm', frame: 0, label: 'x' }] })).toBe(false);
    expect(isUntouched({ ...p, scenes: [{ ...p.scenes[0], locked: true }] })).toBe(false);
    // A skeleton of named, timed scenes is work too, even with no element yet, even a single one.
    expect(isUntouched({ ...p, scenes: [p.scenes[0], { ...p.scenes[0], id: 'scn_2', name: 'Scene 2' }] })).toBe(false);
    expect(isUntouched({ ...p, scenes: [{ ...p.scenes[0], name: 'Only' }] })).toBe(false);
    // Renaming the project is not: it is still a place to start a video.
    expect(isUntouched({ ...p, name: 'My launch' })).toBe(true);
  });
});

describe('applying an outline to the open project', () => {
  it('keeps the id, takes the title and format, and lays out one empty scene per item with the music bed', () => {
    const open = { ...blankProject(ids), revision: 7 };
    const p = applyOutline(open, outline(), brief, { scene: (i) => `scn_o${i}`, audioClip: () => 'aud_bed' });
    expect(validateProject(p).ok).toBe(true);
    expect(p).toMatchObject({ id: 'prj_blank', revision: 7, name: 'Relay in 30 seconds', width: 1080, height: 1920, fps: 25, backgroundColor: '#101010' });
    // 4 s → 100, 16.5 s → 413 (cumulative rounding), 22.5 s → 563.
    expect(p.scenes.map((s) => [s.id, s.name, s.durationInFrames, s.elements.length])).toEqual([
      ['scn_o0', 'Hook', 100, 0],
      ['scn_o1', 'Product', 313, 0],
      ['scn_o2', 'Outro', 150, 0],
    ]);
    expect(projectDurationInFrames(p)).toBe(563);
    expect(Object.keys(p.assets).sort()).toEqual(['ast_logo1', 'ast_song']);
    expect(p.assets.ast_logo1.name).toBe('Logo (relay.svg)');
    expect(p.audio).toEqual([{ id: 'aud_bed', assetId: 'ast_song', name: 'Music bed', startFrame: 0, trimStartFrames: 0, durationInFrames: 563, volume: 0.6, fadeInFrames: 13, fadeOutFrames: 38 }]);
    expect(p.markers).toEqual([]);
  });

  it('keeps assets the project already had and adds no bed without a track', () => {
    const open = blankProject(ids);
    const existing = { id: 'ast_old', kind: 'image' as const, name: 'old.png', src: 'assets/uploads/old.png', mimeType: 'image/png' };
    const p = applyOutline({ ...open, assets: { ast_old: existing } }, outline(), { ...brief, files: [], logoId: undefined }, { scene: (i) => `scn_${i}`, audioClip: () => 'aud' });
    expect(p.assets).toEqual({ ast_old: existing });
    expect(p.audio).toEqual([]);
  });
});
