import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findOnPath, mediaTool } from './media-tools';

describe('media tools', () => {
  it('prefers an executable on PATH', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mge-tools-'));
    const fake = join(dir, 'ffprobe');
    await writeFile(fake, '#!/bin/sh\n');
    await chmod(fake, 0o755);
    expect(findOnPath('ffprobe', dir)).toBe(fake);
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves the installed ffmpeg and ffprobe', () => {
    for (const bin of ['ffmpeg', 'ffprobe'] as const) expect(mediaTool(bin).source).not.toBe('fallback');
  });
});
