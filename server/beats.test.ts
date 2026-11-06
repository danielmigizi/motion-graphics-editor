// The beats endpoint's decoder and cache (real ffmpeg), and the shipped
// sound-effect files.

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SFX, SFX_IDS, sfxSrc } from '../src/core/sfx';
import { beatsFor, BeatsError } from './beats';
import { synthesise, wav, SFX_RATE } from '../scripts/make-sfx';

let root: string;

/** A 120 BPM click track (a beat every 0.5 s from 0.25 s), 48 kHz mono WAV. */
function clickTrack(seconds: number): Buffer {
  const out = new Float32Array(seconds * SFX_RATE);
  for (let k = 0; 0.25 + k * 0.5 < seconds; k++) {
    const s0 = Math.round((0.25 + k * 0.5) * SFX_RATE);
    for (let i = 0; i < SFX_RATE * 0.05; i++) out[s0 + i] += Math.sin(i / 4) * (k % 4 === 0 ? 0.9 : 0.5) * Math.exp(-i / (SFX_RATE * 0.01));
  }
  return wav(out);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mge-beats-'));
  await mkdir(join(root, 'assets'), { recursive: true });
  await writeFile(join(root, 'assets', 'clicks.wav'), clickTrack(12));
  await writeFile(join(root, 'assets', 'broken.wav'), Buffer.from('not audio'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('beatsFor', () => {
  it('decodes with ffmpeg and finds the tempo and grid in frames at the requested rate', async () => {
    const r = await beatsFor(root, 'assets/clicks.wav', 30);
    expect(r.src).toBe('assets/clicks.wav');
    expect(r.durationSeconds).toBeCloseTo(12, 1);
    expect(r.durationInFrames).toBe(360);
    expect(Math.abs(r.bpm! - 120)).toBeLessThanOrEqual(2);
    for (let i = 1; i < r.beats.length; i++) expect(Math.abs(r.beats[i] - r.beats[i - 1] - 15)).toBeLessThanOrEqual(1);
    // Cached per file and fps; another fps is another analysis.
    expect(await beatsFor(root, 'assets/clicks.wav', 30)).toBe(r);
    const at60 = await beatsFor(root, 'assets/clicks.wav', 60);
    expect(at60.fps).toBe(60);
    expect(Math.abs(at60.beats[1] - at60.beats[0] - 30)).toBeLessThanOrEqual(1);
  });

  it('refuses bad paths, missing files and undecodable files', async () => {
    await expect(beatsFor(root, '../etc/passwd', 30)).rejects.toMatchObject({ status: 400 });
    await expect(beatsFor(root, 'assets/nope.wav', 30)).rejects.toMatchObject({ status: 404 });
    await expect(beatsFor(root, 'assets/broken.wav', 30)).rejects.toBeInstanceOf(BeatsError);
    await expect(beatsFor(root, 'assets/clicks.wav', 0)).rejects.toMatchObject({ status: 400 });
  });

  it('analyses the shipped music bed', async () => {
    const r = await beatsFor(join(process.cwd(), 'public'), 'assets/music-bed.wav', 30);
    expect(r.durationInFrames).toBeGreaterThan(0);
    expect(r.onsets.length).toBeGreaterThan(0);
  });
});

describe('built-in sound effects', () => {
  it('ship as 48 kHz mono WAVs of the listed length, normalised without clipping, matching the generator', async () => {
    for (const id of SFX_IDS) {
      const buf = await readFile(join(process.cwd(), 'public', sfxSrc(id)));
      expect(buf.toString('ascii', 0, 4), id).toBe('RIFF');
      expect(buf.readUInt16LE(22), `${id} channels`).toBe(1);
      expect(buf.readUInt32LE(24), `${id} rate`).toBe(48000);
      const samples = (buf.length - 44) / 2;
      expect(samples / 48000, `${id} length`).toBeCloseTo(SFX[id].seconds, 2);
      let peak = 0;
      for (let i = 44; i < buf.length; i += 2) peak = Math.max(peak, Math.abs(buf.readInt16LE(i)) / 32768);
      expect(peak, `${id} peak`).toBeGreaterThan(0.85);
      expect(peak, `${id} peak`).toBeLessThan(0.9);
      // Deterministic: regenerating gives the same bytes.
      expect(wav(synthesise(id)).equals(buf), `${id} is what scripts/make-sfx.ts makes`).toBe(true);
    }
    expect(await readFile(join(process.cwd(), 'public', 'assets', 'sfx', 'LICENSE.txt'), 'utf8')).toContain('CC0');
  });
});
