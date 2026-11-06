// The export's sound: every declared <Audio> (project clips) and every
// unmuted video's soundtrack, decoded by ffmpeg to 48 kHz stereo float and
// mixed here sample by sample with each sound's per-frame gain (linear
// between frames, the same curve the Player ramps through) without
// normalising. Written as a float WAV for the final mux.

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import type { FrameMedia, PlannedAudio } from '../../src/render/protocol';
import { mediaTool } from '../media-tools';

export const SAMPLE_RATE = 48_000;

/** A run of consecutive frames in which one video plays its source continuously. */
export interface VideoSegment {
  src: string;
  /** First project frame. */
  from: number;
  /** Source time (seconds) at `from`. */
  sourceStart: number;
  playbackRate: number;
  volumes: number[];
}

/** Join per-frame video reports into continuous segments (a jump in source time, e.g. a loop, starts a new one). */
export function videoSegments(frames: Map<number, FrameMedia>, fps: number): VideoSegment[] {
  const open = new Map<string, VideoSegment & { lastFrame: number; lastTime: number }>();
  const done: VideoSegment[] = [];
  const close = (key: string) => {
    const s = open.get(key);
    if (!s) return;
    open.delete(key);
    done.push({ src: s.src, from: s.from, sourceStart: s.sourceStart, playbackRate: s.playbackRate, volumes: s.volumes });
  };
  for (const frame of [...frames.keys()].sort((a, b) => a - b)) {
    const seen = new Set<string>();
    for (const v of frames.get(frame)!.videos) {
      seen.add(v.key);
      const s = open.get(v.key);
      const continues = s && s.lastFrame === frame - 1 && s.src === v.src && s.playbackRate === v.playbackRate && Math.abs(v.time - (s.lastTime + v.playbackRate / fps)) < 0.5 / fps;
      if (s && continues) {
        s.volumes.push(v.volume);
        s.lastFrame = frame;
        s.lastTime = v.time;
        continue;
      }
      close(v.key);
      open.set(v.key, { src: v.src, from: frame, sourceStart: v.time, playbackRate: v.playbackRate, volumes: [v.volume], lastFrame: frame, lastTime: v.time });
    }
    for (const key of [...open.keys()]) if (!seen.has(key)) close(key);
  }
  for (const key of [...open.keys()]) close(key);
  return done.filter((s) => s.volumes.some((v) => v > 0));
}

/** Speed changes resample (the pitch moves with the speed), as the preview's <video> does. */
function speed(rate: number): string[] {
  if (Math.abs(rate - 1) < 1e-6) return [];
  return ['-af', `aresample=${SAMPLE_RATE},asetrate=${SAMPLE_RATE}*${rate},aresample=${SAMPLE_RATE}`];
}

/** Interleaved stereo float samples of `src` from `start` seconds, `seconds` of output long at `rate`. Silence when the file has no sound. */
function decode(src: string, start: number, seconds: number, rate: number, signal?: AbortSignal): Promise<Float32Array> {
  const tool = mediaTool('ffmpeg');
  const args = ['-hide_banner', '-loglevel', 'error', '-ss', start.toFixed(6), '-t', (seconds * rate + 0.05).toFixed(6), '-i', src, '-vn', ...speed(rate), '-ac', '2', '-ar', String(SAMPLE_RATE), '-f', 'f32le', 'pipe:1'];
  return new Promise((resolve, reject) => {
    const proc = spawn(tool.cmd, args, { cwd: tool.cwd, env: tool.env, signal });
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0 && /does not contain any stream|matches no streams|Output file #0 does not contain/i.test(stderr)) return resolve(new Float32Array(0));
      if (code !== 0) return reject(new Error(`Could not decode audio from ${src}: ${stderr.trim().split('\n').pop()}`));
      const buf = Buffer.concat(chunks);
      resolve(new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));
    });
  });
}

interface Sound {
  src: string;
  from: number;
  frames: number;
  sourceStart: number;
  rate: number;
  volumes: number[];
}

/**
 * Mix everything into `out` (float WAV). `totalFrames` project frames long;
 * `resolve` turns a page URL into what ffmpeg should read.
 */
export async function mixAudio(args: { planned: PlannedAudio[]; videos: VideoSegment[]; fps: number; totalFrames: number; out: string; resolve?: (src: string) => string; signal?: AbortSignal }): Promise<void> {
  const { fps, totalFrames, out, signal } = args;
  const resolve = args.resolve ?? ((s: string) => s);
  const total = Math.ceil((totalFrames / fps) * SAMPLE_RATE);
  const mix = new Float32Array(total * 2);
  const sounds: Sound[] = [
    ...args.planned.map((p) => ({ src: p.src, from: p.from, frames: p.durationInFrames, sourceStart: p.trimBefore / fps, rate: 1, volumes: p.volumes })),
    ...args.videos.map((v) => ({ src: v.src, from: v.from, frames: v.volumes.length, sourceStart: v.sourceStart, rate: v.playbackRate, volumes: v.volumes })),
  ].filter((s) => s.frames > 0 && s.from < totalFrames && s.volumes.some((v) => v > 0));
  // Decode a few at a time.
  const decoded = new Array<Float32Array>(sounds.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, sounds.length) }, async () => {
      while (next < sounds.length) {
        const i = next++;
        const s = sounds[i];
        decoded[i] = await decode(resolve(s.src), Math.max(0, s.sourceStart), s.frames / fps, s.rate, signal);
      }
    }),
  );
  sounds.forEach((s, i) => {
    const pcm = decoded[i];
    const start = Math.round((s.from / fps) * SAMPLE_RATE);
    const length = Math.min(pcm.length / 2, Math.round((s.frames / fps) * SAMPLE_RATE), total - start);
    const perFrame = SAMPLE_RATE / fps;
    for (let n = Math.max(0, -start); n < length; n++) {
      const pos = n / perFrame;
      const f = Math.floor(pos);
      const a = s.volumes[Math.min(f, s.volumes.length - 1)] ?? 0;
      const b = s.volumes[Math.min(f + 1, s.volumes.length - 1)] ?? a;
      const g = a + (b - a) * (pos - f);
      if (g === 0) continue;
      const o = (start + n) * 2;
      mix[o] += pcm[n * 2] * g;
      mix[o + 1] += pcm[n * 2 + 1] * g;
    }
  });
  await writeFile(out, wav(mix));
}

/** IEEE-float stereo WAV. */
function wav(samples: Float32Array): Buffer {
  const data = Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20);
  h.writeUInt16LE(2, 22);
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(SAMPLE_RATE * 8, 28);
  h.writeUInt16LE(8, 32);
  h.writeUInt16LE(32, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
