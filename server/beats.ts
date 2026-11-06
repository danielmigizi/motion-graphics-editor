// Beat analysis of audio assets for GET /api/assets/beats (the MCP tool
// editor_get_beats, the Assets panel's BPM, the New video brief): decode the
// file to mono 22.05 kHz PCM with ffmpeg, then run the shared detector
// in src/core/beats.ts. Results are cached per file (path + size + mtime) and
// frame rate.

import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { analyzeBeats, type BeatsResponse } from '../src/core/beats';
import { resolvePublicPath } from './assets';
import { mediaTool } from './media-tools';

export const BEATS_SAMPLE_RATE = 22050;

export type { BeatsResponse };

export class BeatsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** ffmpeg to decode with (server/media-tools.ts: MGE_FFMPEG, else PATH). */
export function ffmpegCommand(): { cmd: string; env: NodeJS.ProcessEnv; cwd?: string } {
  const tool = mediaTool('ffmpeg');
  return { cmd: tool.cmd, env: tool.env, cwd: tool.cwd };
}

/** The samples of a 16-bit PCM WAV stream (ffmpeg's piped header may carry no sizes: the data chunk runs to the end). */
export function wavSamples(buf: Buffer): Float32Array {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('ffmpeg did not return a WAV stream');
  let at = 12;
  while (at + 8 <= buf.length) {
    const tag = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (tag === 'data') {
      const data = buf.subarray(at + 8, size > 0 && size !== 0xffffffff ? Math.min(buf.length, at + 8 + size) : buf.length);
      const out = new Float32Array(Math.floor(data.length / 2));
      for (let i = 0; i < out.length; i++) out[i] = data.readInt16LE(i * 2) / 32768;
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('ffmpeg returned a WAV stream without audio data');
}

/**
 * Decode any audio file to mono PCM at `sampleRate`. 16-bit WAV through a
 * pipe, which every ffmpeg build can write.
 */
export function decodeMono(path: string, sampleRate = BEATS_SAMPLE_RATE): Promise<Float32Array> {
  const { cmd, env, cwd } = ffmpegCommand();
  return new Promise((resolvePromise, reject) => {
    const p = spawn(cmd, ['-v', 'error', '-i', path, '-vn', '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', '-f', 'wav', '-'], { env, cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let err = '';
    p.stdout.on('data', (d: Buffer) => chunks.push(d));
    p.stderr.on('data', (d: Buffer) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg could not decode the file: ${err.trim().split('\n').slice(-1)[0] ?? `exit ${code}`}`));
      try {
        resolvePromise(wavSamples(Buffer.concat(chunks)));
      } catch (e) {
        reject(e);
      }
    });
  });
}

const MAX_CACHE = 64;
const cache = new Map<string, Promise<BeatsResponse>>();

/** Beats of an asset-root-relative audio file at `fps` (cached). */
export async function beatsFor(publicDir: string, src: string, fps: number): Promise<BeatsResponse> {
  if (!Number.isInteger(fps) || fps < 1 || fps > 120) throw new BeatsError('fps must be an integer from 1 to 120.', 400);
  const path = resolvePublicPath(publicDir, src);
  if (!path) throw new BeatsError(`Invalid asset path "${src}".`, 400);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new BeatsError(`File public/${src} does not exist.`, 404);
  }
  if (!info.isFile()) throw new BeatsError(`public/${src} is not a file.`, 404);
  const key = `${fps}|${path}|${info.size}|${info.mtimeMs}`;
  let hit = cache.get(key);
  if (!hit) {
    hit = (async () => {
      let samples: Float32Array;
      try {
        samples = await decodeMono(path);
      } catch (e) {
        throw new BeatsError((e as Error).message, 422);
      }
      return { src, durationSeconds: samples.length / BEATS_SAMPLE_RATE, ...analyzeBeats([samples], BEATS_SAMPLE_RATE, fps) };
    })();
    cache.set(key, hit);
    // A failure is not cached; the oldest entry goes when the cache is full.
    hit.catch(() => cache.delete(key));
    if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value!);
  }
  return hit;
}
