// The New video Music step in the prompts and the skeleton: the chosen
// track becomes the bed, its beats reach the agent, and the build message
// points the agent at editor_get_beats.

import { describe, expect, it } from 'vitest';
import { buildScenesPrompt, buildSkeletonProject, musicFile, outlineRequestPrompt, parseOutline, type VideoBrief } from './outline';
import { validateProject } from './validate';

const base: VideoBrief = {
  brief: 'Launch video for Relay',
  audience: '',
  tone: '',
  targetSeconds: 12,
  width: 1920,
  height: 1080,
  fps: 30,
  backgroundColor: '#0B0F1A',
  brandColors: [],
  files: [
    { id: 'ast_first', kind: 'audio', name: 'first.mp3', src: 'assets/uploads/u_1.mp3', mimeType: 'audio/mpeg', durationSeconds: 30 },
    { id: 'ast_track', kind: 'audio', name: 'upbeat.wav', src: 'assets/uploads/u_2.wav', mimeType: 'audio/wav', durationSeconds: 20 },
  ],
};

// A 120 BPM track: a bar every 2 s from 0.25 s.
const tempo = { bpm: 120, confidence: 0.6, durationSeconds: 20, downbeatSeconds: [0.25, 2.25, 4.25, 6.25, 8.25, 10.25, 12.25, 14.25, 16.25, 18.25] };

const ids = { project: 'prj_new', scene: (i: number) => `scn_${i}`, audioClip: () => 'aud_bed' };

describe('music in the brief', () => {
  it('the chosen track (not the first audio file) becomes the music bed', () => {
    const brief = { ...base, music: { fileId: 'ast_track' } };
    expect(musicFile(brief)?.id).toBe('ast_track');
    expect(musicFile(base)?.id).toBe('ast_first');
    const r = parseOutline({ title: 'Relay', scenes: [{ name: 'A', purpose: 'a', durationSeconds: 4 }, { name: 'B', purpose: 'b', durationSeconds: 8 }] });
    if (!r.ok) throw new Error(r.message);
    const project = buildSkeletonProject(r.outline, brief, ids);
    expect(project.audio).toEqual([expect.objectContaining({ id: 'aud_bed', assetId: 'ast_track', startFrame: 0, durationInFrames: 360 })]);
    expect(Object.keys(project.assets)).toEqual(['ast_first', 'ast_track']);
    expect(validateProject(project).ok).toBe(true);
    const build = buildScenesPrompt(r.outline, brief, project);
    expect(build).toContain('A music bed already plays across the whole video ("Music bed", aud_bed)');
    expect(build).toContain('Call `editor_get_beats`');
    expect(build).toContain('{ "audio": "project" }');
  });

  it('acceptance: with a track and "cut on the beat", the outline request carries the tempo and the downbeats to land cuts on', () => {
    const prompt = outlineRequestPrompt({ ...base, music: { fileId: 'ast_track', snapToBeats: true, tempo } });
    expect(prompt).toContain('Music: "upbeat.wav" (20 s, ~120 BPM, a bar every 2 s); it becomes the music bed under the whole video.');
    expect(prompt).toContain('The user wants scene lengths snapped to the music.');
    // Downbeats up to 1.25 × the 12 s target.
    expect(prompt).toContain('(bar starts, seconds from the start): 0.25, 2.25, 4.25, 6.25, 8.25, 10.25, 12.25, 14.25.');
    expect(prompt).not.toContain('16.25');
  });

  it('without "cut on the beat" the downbeats are a suggestion; a weak pulse is flagged', () => {
    const prompt = outlineRequestPrompt({ ...base, music: { fileId: 'ast_track', tempo: { ...tempo, confidence: 0.1 } } });
    expect(prompt).toContain('~120 BPM (weak pulse)');
    expect(prompt).toContain('If it suits the story, put scene boundaries on the track');
    expect(prompt).not.toContain('snapped to the music');
  });

  it('a described mood without a track goes to the agent', () => {
    const prompt = outlineRequestPrompt({ ...base, files: [], music: { mood: 'upbeat, 120 bpm, no vocals' } });
    expect(prompt).toContain('Music mood: upbeat, 120 bpm, no vocals (no track chosen yet)');
    expect(prompt).toContain('what kind of track would fit the mood');
    expect(prompt).not.toContain('Music: "');
  });
});
