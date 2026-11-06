import { describe, expect, it } from 'vitest';
import { computePeaks, detectOnsets, frameEnergy, peakColumns, peakFrames, PEAKS_PER_FRAME } from './waveform';

const FPS = 30;
const RATE = 48000;

/** A deterministic click track: quiet noise floor plus a decaying burst every `every` frames from `first`. */
function clickTrack(seconds: number, every: number, first = 0): Float32Array {
  const out = new Float32Array(seconds * RATE);
  const perFrame = RATE / FPS;
  let seed = 7;
  const noise = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647 - 0.5) * 0.02;
  };
  for (let i = 0; i < out.length; i++) out[i] = noise();
  for (let f = first; f * perFrame < out.length; f += every) {
    const s0 = Math.round(f * perFrame);
    for (let i = 0; i < perFrame * 4 && s0 + i < out.length; i++) out[s0 + i] += Math.sin(i / 6) * 0.9 * Math.exp(-i / (perFrame * 1.2));
  }
  return out;
}

describe('peaks', () => {
  it('buckets samples at 16 peaks per frame (2 per px at 8 px/frame), max across channels, normalised', () => {
    const a = new Float32Array(RATE); // 1 s
    const b = new Float32Array(RATE);
    a[50] = 0.25; // bucket 0: 48000 / (30 × 16) = 100 samples per peak
    b[RATE - 1] = -0.5;
    const p = computePeaks([a, b], RATE, FPS);
    expect(p.perFrame).toBe(PEAKS_PER_FRAME);
    expect(p.data.length).toBe(FPS * PEAKS_PER_FRAME);
    expect(peakFrames(p)).toBe(FPS);
    expect(p.max).toBe(0.5);
    expect(p.data[0]).toBeCloseTo(0.5); // 0.25 / 0.5
    expect(p.data[p.data.length - 1]).toBeCloseTo(1);
    expect(p.data[10]).toBe(0);
  });

  it('is deterministic', () => {
    const s = clickTrack(2, 15);
    expect(computePeaks([s], RATE, FPS).data).toEqual(computePeaks([s], RATE, FPS).data);
  });

  it('downsamples to columns by max, and past the end is silence', () => {
    const p = { perFrame: 4, data: Float32Array.from([0, 0.2, 0, 0, 0, 0, 0.9, 0, 0.1, 0.1, 0.1, 0.1]), max: 1 };
    // 3 frames into 3 columns: one frame (4 peaks) per column.
    expect(Array.from(peakColumns(p, 0, 3, 3))).toEqual([expect.closeTo(0.2), expect.closeTo(0.9), expect.closeTo(0.1)]);
    // 1 frame into 2 columns: 2 peaks each.
    expect(Array.from(peakColumns(p, 1, 2, 2))).toEqual([0, expect.closeTo(0.9)]);
    expect(Array.from(peakColumns(p, 3, 5, 2))).toEqual([0, 0]);
  });

  it('measures loudness per frame', () => {
    const p = { perFrame: 2, data: Float32Array.from([1, 1, 0, 0, 0.5, 0.5]), max: 1 };
    expect(Array.from(frameEnergy(p))).toEqual([1, 0, 0.5]);
  });
});

describe('onsets', () => {
  it('finds the hits of a synthetic click track', () => {
    const p = computePeaks([clickTrack(4, 15, 6)], RATE, FPS);
    const onsets = detectOnsets(p, FPS);
    const expected = [6, 21, 36, 51, 66, 81, 96, 111];
    expect(onsets.length).toBe(expected.length);
    onsets.forEach((f, i) => expect(Math.abs(f - expected[i])).toBeLessThanOrEqual(1));
  });

  it('keeps onsets apart and ignores a steady tone', () => {
    const tone = new Float32Array(2 * RATE);
    for (let i = 0; i < tone.length; i++) tone[i] = Math.sin(i / 20) * 0.5;
    const onsets = detectOnsets(computePeaks([tone], RATE, FPS), FPS);
    // Only the start of the tone counts as an onset.
    expect(onsets).toEqual([0]);
    const fast = detectOnsets(computePeaks([clickTrack(2, 3)], RATE, FPS), FPS, { minGapFrames: 6 });
    for (let i = 1; i < fast.length; i++) expect(fast[i] - fast[i - 1]).toBeGreaterThanOrEqual(6);
  });

  it('does not mistake a sustained pad’s loudness wobble for beats', () => {
    // A tone whose level drifts ±10 % a few times a second.
    const pad = new Float32Array(4 * RATE);
    for (let i = 0; i < pad.length; i++) pad[i] = Math.sin(i / 15) * 0.5 * (1 + 0.1 * Math.sin((i / RATE) * 2 * Math.PI * 3.3));
    expect(detectOnsets(computePeaks([pad], RATE, FPS), FPS)).toEqual([0]);
  });

  it('returns nothing for silence', () => {
    expect(detectOnsets(computePeaks([new Float32Array(RATE)], RATE, FPS), FPS)).toEqual([]);
  });
});
