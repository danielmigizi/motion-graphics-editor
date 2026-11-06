import { describe, expect, it } from 'vitest';
import { clipVolumeAt } from '../composition/AudioTrack';
import { duckUnder, envelopeAt, likelyVoiceClips } from './audioDucking';
import { analyzeBeats, sourceToProjectFrames } from './beats';
import { fixtureProject } from './__fixtures__/fixtureProject';
import { createDocState, execute } from './history';
import type { AudioClip, Project } from './types';
import { validateProject } from './validate';

const RATE = 22050;
const FPS = 30;

/**
 * A drum loop: a kick (low thump) on beats 1 and 3 of each bar, a hat
 * (short noise) on every beat, at `bpm`, over a quiet noise floor.
 */
function drumLoop(bpm: number, seconds: number, offset = 0.25): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  let seed = 11;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647 - 0.5;
  };
  for (let i = 0; i < out.length; i++) out[i] = rnd() * 0.01;
  const beat = 60 / bpm;
  for (let k = 0; offset + k * beat < seconds; k++) {
    const s0 = Math.round((offset + k * beat) * RATE);
    const kick = k % 4 === 0 || k % 4 === 2;
    for (let i = 0; i < RATE * 0.12 && s0 + i < out.length; i++) {
      const t = i / RATE;
      out[s0 + i] += (kick ? 0.8 * Math.sin(2 * Math.PI * 60 * t) * Math.exp(-t / 0.05) : 0) + rnd() * 0.35 * Math.exp(-t / 0.015);
    }
  }
  return out;
}

/**
 * The verifier's music bed: a 100 BPM click (accented 1.6 kHz + a 70 Hz thump
 * on each downbeat, 1 kHz on the other beats) over a sustained Am / F / C / G
 * pad that swells in over each bar. `padGain` 0.06 puts the pad's peak near
 * 0.23, as loud as the clicks; 0.025 is the quieter variant.
 */
function clickPadBed(padGain: number, seconds = 24): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  const beat = 60 / 100;
  const chords = [[220, 261.63, 329.63], [174.61, 220, 261.63], [261.63, 329.63, 392], [196, 246.94, 293.66]];
  for (let i = 0; i < out.length; i++) {
    const t = i / RATE;
    const b = Math.floor(t / beat);
    const tb = t - b * beat;
    const down = b % 4 === 0;
    const env = Math.exp(-tb * (down ? 38 : 55));
    const click = (down ? 0.55 : 0.32) * env * Math.sin(2 * Math.PI * (down ? 1600 : 1000) * tb) + (down ? 0.45 * Math.exp(-tb * 18) * Math.sin(2 * Math.PI * 70 * tb) : 0);
    const chord = chords[Math.floor(b / 4) % 4];
    const tbar = t - Math.floor(b / 4) * 4 * beat;
    const padEnv = Math.min(1, tbar / 0.25) * 0.9 + 0.1;
    let pad = 0;
    for (const f of chord) pad += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(2 * Math.PI * f * 2 * t + 0.4);
    out[i] = click + pad * padGain * padEnv;
  }
  return out;
}

describe('beat analysis', () => {
  it.each([
    ['a pad as loud as the clicks', 0.06],
    ['a quieter pad', 0.025],
  ])('finds 100 BPM and bars every 72 frames in a click over %s (the pad does not set the tempo)', (_, gain) => {
    const a = analyzeBeats([clickPadBed(gain)], RATE, FPS);
    // The onsets are the clicks, every 18 frames.
    expect(a.onsets.slice(0, 8)).toEqual([0, 18, 36, 54, 72, 90, 108, 126]);
    expect(Math.abs(a.bpm! - 100)).toBeLessThanOrEqual(1);
    expect(a.confidence).toBeGreaterThan(0.5);
    expect(a.beats.length).toBeGreaterThanOrEqual(38);
    for (let i = 1; i < a.beats.length; i++) expect(Math.abs(a.beats[i] - a.beats[i - 1] - 18)).toBeLessThanOrEqual(1);
    expect(a.downbeats[0]).toBe(0);
    expect(a.downbeats.length).toBeGreaterThanOrEqual(9);
    for (let i = 1; i < a.downbeats.length; i++) expect(a.downbeats[i] - a.downbeats[i - 1]).toBe(72);
  });

  it('reports a low confidence for hits with no steady pulse, so agents fall back to onsets', () => {
    const out = new Float32Array(RATE * 12);
    let seed = 5;
    const rnd = () => {
      seed = (seed * 16807) % 2147483647;
      return seed / 2147483647;
    };
    for (let t = 0.2; t < 11.5; t += 0.15 + rnd() * 0.9) {
      const s0 = Math.round(t * RATE);
      for (let i = 0; i < RATE * 0.08 && s0 + i < out.length; i++) out[s0 + i] += (rnd() - 0.5) * 0.6 * Math.exp(-i / (RATE * 0.015));
    }
    const a = analyzeBeats([out], RATE, FPS);
    expect(a.onsets.length).toBeGreaterThan(10);
    expect(a.confidence).toBeLessThan(0.2);
  });


  it('finds the tempo, a steady grid and downbeats of a 120 BPM loop', () => {
    const a = analyzeBeats([drumLoop(120, 16)], RATE, FPS);
    expect(a.bpm).not.toBeNull();
    expect(Math.abs(a.bpm! - 120)).toBeLessThanOrEqual(2);
    expect(a.confidence).toBeGreaterThan(0.2);
    expect(a.durationInFrames).toBe(480);
    // Beats every 15 frames, starting on the first hit (0.25 s = frame 7.5).
    expect(a.beats.length).toBeGreaterThanOrEqual(28);
    for (let i = 1; i < a.beats.length; i++) expect(Math.abs(a.beats[i] - a.beats[i - 1] - 15)).toBeLessThanOrEqual(1);
    expect(Math.abs(a.beats[0] - 7.5)).toBeLessThanOrEqual(1.5);
    // Downbeats every 2 s (4 beats), on the kicks.
    for (let i = 1; i < a.downbeats.length; i++) expect(Math.abs(a.downbeats[i] - a.downbeats[i - 1] - 60)).toBeLessThanOrEqual(1);
    expect(a.downbeats.every((d) => a.beats.includes(d))).toBe(true);
    expect(a.onsets.length).toBeGreaterThanOrEqual(14); // at least the kicks
  });

  it('tracks a tempo that is not a whole number of frames per beat', () => {
    const a = analyzeBeats([drumLoop(128, 20)], RATE, FPS);
    expect(Math.abs(a.bpm! - 128)).toBeLessThanOrEqual(2);
    // 128 BPM = 14.06 frames per beat: the grid does not drift over 20 s.
    const last = a.beats[a.beats.length - 1];
    const expected = 7.5 + Math.round((last - 7.5) / (1800 / 128)) * (1800 / 128);
    expect(Math.abs(last - expected)).toBeLessThanOrEqual(1.5);
  });

  it('is deterministic and reports no tempo for silence or a steady tone', () => {
    const loop = drumLoop(100, 8);
    expect(analyzeBeats([loop], RATE, FPS)).toEqual(analyzeBeats([loop], RATE, FPS));
    const silence = analyzeBeats([new Float32Array(RATE * 4)], RATE, FPS);
    expect(silence).toMatchObject({ bpm: null, beats: [], downbeats: [], strong: [], onsets: [] });
    const tone = new Float32Array(RATE * 4);
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin(i / 7) * 0.4;
    expect(analyzeBeats([tone], RATE, FPS)).toMatchObject({ bpm: null, beats: [] });
  });

  it('marks the few strongest hits', () => {
    const loop = drumLoop(120, 8);
    // One big accent at 4.25 s.
    const s0 = Math.round(4.25 * RATE);
    for (let i = 0; i < RATE * 0.2; i++) loop[s0 + i] += Math.sin(i / 3) * 0.9 * Math.exp(-i / (RATE * 0.05));
    const a = analyzeBeats([loop], RATE, FPS);
    expect(a.strong.length).toBeGreaterThan(0);
    expect(a.strong.length).toBeLessThan(a.onsets.length);
    expect(a.strong.some((f) => Math.abs(f - 4.25 * FPS) <= 1)).toBe(true);
  });

  it('maps source frames onto the project timeline through a clip’s trim', () => {
    expect(sourceToProjectFrames([0, 15, 30, 45, 60], 100, 15, 40)).toEqual([100, 115, 130]);
  });
});

describe('volume envelopes and ducking', () => {
  it('envelopeAt is linear between points and holds the ends', () => {
    const env = [{ frame: 10, value: 1 }, { frame: 20, value: 0.5 }, { frame: 30, value: 0.5 }];
    expect(envelopeAt(undefined, 5)).toBe(1);
    expect(envelopeAt([], 5)).toBe(1);
    expect(envelopeAt(env, 0)).toBe(1);
    expect(envelopeAt(env, 15)).toBeCloseTo(0.75);
    expect(envelopeAt(env, 25)).toBe(0.5);
    expect(envelopeAt(env, 99)).toBe(0.5);
  });

  it('clipVolumeAt multiplies volume, fades and the envelope', () => {
    const clip: AudioClip = { id: 'a', assetId: 'x', name: 'Bed', startFrame: 0, trimStartFrames: 0, durationInFrames: 100, volume: 0.8, fadeInFrames: 10, fadeOutFrames: 0, volumeEnvelope: [{ frame: 0, value: 1 }, { frame: 50, value: 0.5 }] };
    expect(clipVolumeAt(clip, 5)).toBeCloseTo(0.8 * 0.5 * 0.95);
    expect(clipVolumeAt(clip, 50)).toBeCloseTo(0.4);
    expect(clipVolumeAt(clip, 90)).toBeCloseTo(0.4);
  });

  const withVoice = (): Project => {
    const p = structuredClone(fixtureProject);
    p.assets.ast_vo = { id: 'ast_vo', kind: 'audio', name: 'Voice-over take 2', src: 'assets/vo.wav', mimeType: 'audio/wav', durationInFrames: 300 };
    p.audio.push(
      { id: 'aud_vo1', assetId: 'ast_vo', name: 'VO line 1', sceneId: 'scn_product', startFrame: 30, trimStartFrames: 0, durationInFrames: 90, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 },
      { id: 'aud_vo2', assetId: 'ast_vo', name: 'VO line 2', startFrame: 340, trimStartFrames: 90, durationInFrames: 60, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 },
      { id: 'aud_vo3', assetId: 'ast_vo', name: 'VO line 3', startFrame: 600, trimStartFrames: 150, durationInFrames: 60, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 },
    );
    return p;
  };

  it('finds voice-over clips by name, not the short sound effects', () => {
    expect(likelyVoiceClips(withVoice(), 'aud_music').map((c) => c.id)).toEqual(['aud_vo1', 'aud_vo2', 'aud_vo3']);
  });

  it('duckUnder dips the bed under each voice line as an editable, valid envelope (one undo step)', () => {
    const p = withVoice();
    const r = duckUnder(p, 'aud_music', ['aud_vo1', 'aud_vo2', 'aud_vo3'], { dropDb: 12, attackFrames: 6, releaseFrames: 12 });
    if (!r.ok) throw new Error(r.message);
    // VO1 plays at 210+30 = 240..330, VO2 at 340..400 (merged: the gap is under attack + release), VO3 at 600..660.
    expect(r.sections).toBe(2);
    const env = r.command.changes.volumeEnvelope!;
    expect(env).toEqual([
      { frame: 0, value: 1 },
      { frame: 234, value: 1 },
      { frame: 240, value: 0.251 },
      { frame: 400, value: 0.251 },
      { frame: 412, value: 1 },
      { frame: 594, value: 1 },
      { frame: 600, value: 0.251 },
      { frame: 660, value: 0.251 },
      { frame: 672, value: 1 },
      { frame: 720, value: 1 },
    ]);
    const doc = execute(createDocState(p), r.command);
    expect(doc.ok).toBe(true);
    if (doc.ok) {
      expect(validateProject(doc.state.project).ok).toBe(true);
      expect(doc.state.undoStack).toHaveLength(1);
      const bed = doc.state.project.audio.find((c) => c.id === 'aud_music')!;
      expect(clipVolumeAt(bed, 300)).toBeCloseTo(0.6 * 0.251);
      expect(clipVolumeAt(bed, 500)).toBeCloseTo(0.6);
    }
  });

  it('clips the envelope to the bed and refuses when no voice plays under it', () => {
    const p = withVoice();
    p.audio[0] = { ...p.audio[0], durationInFrames: 250 };
    const r = duckUnder(p, 'aud_music', ['aud_vo1'], { dropDb: 6, attackFrames: 6, releaseFrames: 12 });
    expect(r.ok && r.command.changes.volumeEnvelope).toEqual([
      { frame: 0, value: 1 },
      { frame: 234, value: 1 },
      { frame: 240, value: 0.501 },
      { frame: 250, value: 0.501 },
    ]);
    expect(duckUnder(p, 'aud_music', ['aud_vo3'])).toMatchObject({ ok: false });
    expect(duckUnder(p, 'aud_nope', ['aud_vo1'])).toMatchObject({ ok: false });
  });
});
