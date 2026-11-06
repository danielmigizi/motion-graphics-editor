// One resolver for ffmpeg / ffprobe, shared by every probe, transcode and
// export.
//
// Order: MGE_FFMPEG / MGE_FFPROBE, then the binary on PATH (or Homebrew /
// /usr/local). Exports need a full build (libx264, libvpx-vp9, prores_ks).
// Resolved once per process.

import { accessSync, constants, existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export type MediaBin = 'ffmpeg' | 'ffprobe';

export interface MediaTool {
  /** Executable path (or bare name as a last resort). */
  cmd: string;
  /** Working directory to spawn in. */
  cwd?: string;
  env: NodeJS.ProcessEnv;
  source: 'env' | 'path' | 'fallback';
}

const isExecutable = (p: string) => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** First executable `bin` on PATH (plus the usual Homebrew / local prefixes). */
export function findOnPath(bin: MediaBin, pathEnv = process.env.PATH ?? ''): string | null {
  const exe = process.platform === 'win32' ? `${bin}.exe` : bin;
  const dirs = [...pathEnv.split(delimiter).filter(Boolean), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs) {
    const p = join(dir, exe);
    if (existsSync(p) && isExecutable(p)) return p;
  }
  return null;
}

const cache = new Map<MediaBin, MediaTool>();

export function mediaTool(bin: MediaBin): MediaTool {
  const hit = cache.get(bin);
  if (hit) return hit;
  let tool: MediaTool;
  const override = process.env[bin === 'ffmpeg' ? 'MGE_FFMPEG' : 'MGE_FFPROBE'];
  const onPath = override ? null : findOnPath(bin);
  if (override) tool = { cmd: override, env: process.env, source: 'env' };
  else if (onPath) tool = { cmd: onPath, env: process.env, source: 'path' };
  else tool = { cmd: bin, env: process.env, source: 'fallback' };
  cache.set(bin, tool);
  return tool;
}

/** ffprobe executable path (kept for callers that only need the path). */
export const ffprobePath = () => mediaTool('ffprobe').cmd;
