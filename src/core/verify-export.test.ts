import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkAudio } from '../../scripts/verify-export';
import { project } from './__fixtures__/schema2Project';

// PCM fixture: a loud constant tone with a precisely known frame onset.
async function tone(path: string, onset: number, amplitude = 0.5) {
  const samplesPerFrame = 1600;
  const count = samplesPerFrame * 100;
  const wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24); wav.writeUInt32LE(96000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
  for (let i = onset * samplesPerFrame; i < count; i++) wav.writeInt16LE(Math.round(amplitude * 32767 * Math.sin(2 * Math.PI * 1000 * i / 48000)), 44 + i * 2);
  await writeFile(path, wav);
}

describe('export audio onset verification', () => {
  it.each([55, 60, 65])('measures a clip starting at frame %s against expected frame 60', async (onset) => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-onset-'));
    try {
      const source = join(dir, 'source.wav');
      const output = join(dir, 'output.wav');
      await tone(source, 0); await tone(output, onset);
      const p = project([]);
      p.assets.sound = { id: 'sound', name: 'Sound', kind: 'audio', mimeType: 'audio/wav', src: source, durationInFrames: 100 };
      p.audio = [{ id: 'clip_sound', name: 'Sound', assetId: 'sound', startFrame: 60, trimStartFrames: 0, durationInFrames: 40, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 }];
      const [result] = await checkAudio(output, p, async () => true, (src) => src);
      expect(result.skipped).not.toBe(true);
      expect(result.measuredFrame).toBe(onset);
      expect(result.deltaFrames).toBe(onset - 60);
      expect(result.pass).toBe(onset === 60);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('expected source masking', () => {
  it.each([true, false])('only skips masked audio when the other source is known (known=%s)', async (known) => {
    const dir = await mkdtemp(join(tmpdir(), 'verify-mask-'));
    try {
      const source = join(dir, 'source.wav');
      const output = join(dir, 'output.wav');
      await tone(source, 0); await tone(output, known ? 0 : 55);
      const p = project([]);
      p.assets.sound = { id: 'sound', name: 'Sound', kind: 'audio', mimeType: 'audio/wav', src: source, durationInFrames: 100 };
      p.assets.bed = { ...p.assets.sound, id: 'bed', src: known ? source : join(dir, 'missing.wav') };
      p.audio = [
        { id: 'clip_sound', name: 'Sound', assetId: 'sound', startFrame: 60, trimStartFrames: 0, durationInFrames: 40, volume: 0.05, fadeInFrames: 0, fadeOutFrames: 0 },
        { id: 'clip_bed', name: 'Bed', assetId: 'bed', startFrame: 0, trimStartFrames: 0, durationInFrames: 100, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 },
      ];
      const [result] = await checkAudio(output, p, async (src) => src === source, (src) => src);
      if (known) {
        expect(result.skipped).toBe(true);
        expect(result.note).toContain('other expected sources');
      } else {
        expect(result.skipped).not.toBe(true);
        expect(result.measuredFrame).toBe(55);
        expect(result.pass).toBe(false);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
