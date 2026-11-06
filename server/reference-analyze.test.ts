import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analyzeReference } from './reference-analyze';
import { mediaTool } from './media-tools';

let root: string;
let clip: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'mge-ref-'));
  clip = join(root, 'tiny.mp4');
  const tool = mediaTool('ffmpeg');
  // Two 0.5 s colour plates so scene-detect and contact sheets have something to measure.
  execFileSync(tool.cmd, [
    '-v', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=0x58ad80:s=64x48:r=10:d=0.5',
    '-f', 'lavfi', '-i', 'color=c=0x0a1528:s=64x48:r=10:d=0.5',
    '-f', 'lavfi', '-i', 'sine=f=440:d=1',
    '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
    '-map', '[v]', '-map', '2:a',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest',
    clip,
  ], { cwd: tool.cwd, env: tool.env });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('analyzeReference', () => {
  it('probes a tiny local video and writes cached artefacts', async () => {
    const first = await analyzeReference(root, { path: clip });
    expect(first.cached).toBe(false);
    expect(first.notice).toMatch(/absolute value/);
    expect(first.specs).toMatchObject({ width: 64, height: 48, hasAudio: true });
    expect(first.specs.durationSeconds).toBeGreaterThan(0.8);
    expect(first.shots.length).toBeGreaterThanOrEqual(1);
    expect(first.artifacts.some((a) => a.kind === 'contact-sheet')).toBe(true);
    expect(first.motion.energy.length).toBeGreaterThan(0);
    const second = await analyzeReference(root, { path: clip });
    expect(second.cached).toBe(true);
    expect(second.specs).toEqual(first.specs);
    expect(second.shots).toEqual(first.shots);
  });

  it('requires path or url, not both', async () => {
    await expect(analyzeReference(root, { path: clip, url: 'https://example.com/a.mp4' })).rejects.toThrow(/not both/);
    await expect(analyzeReference(root, {})).rejects.toThrow(/path/);
  });
});
