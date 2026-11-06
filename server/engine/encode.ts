// ffmpeg for the native exporter: one encoder per chunk reading captured
// frames on stdin, then a final step that joins the chunks (stream copy, or a
// palette pass for GIF) and muxes the mixed audio.
//
// Defaults: H.264 CRF 18 yuv420p, VP9 CRF 28, ProRes 4444 with alpha
// (yuva444p10le), GIF through one palettegen/paletteuse pass, no colour-space
// tags. x264 runs its "faster" preset with medium's 40-frame lookahead: plain
// "faster" lets quality pulse on held frames (B-frames 0.990 vs 0.997 against
// the lossless picture); with the lookahead holds match medium, a little faster.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { mediaTool } from '../media-tools';

export type EngineCodec = 'h264' | 'vp9' | 'prores' | 'gif';

export interface EncodeSpec {
  codec: EngineCodec;
  /** Output frame rate (fps / everyNthFrame). */
  fps: number;
  crf?: number;
  /** x264 preset (default 'faster'). */
  preset?: string;
}

/** Captured frame format: PNG keeps alpha (ProRes) and is lossless for GIF; JPEG is fastest. */
export const frameFormat = (codec: EngineCodec): 'png' | 'jpeg' => (codec === 'prores' || codec === 'gif' ? 'png' : 'jpeg');
export const chunkExtension = (codec: EngineCodec): string => (codec === 'h264' ? 'mp4' : codec === 'vp9' ? 'webm' : codec === 'prores' ? 'mov' : 'mkv');

/**
 * Chrome's JPEGs are full range; convert to limited range and leave the colour
 * space untagged (ffmpeg 7 would otherwise carry the
 * JPEG's full range and BT.601 tag through).
 */
const LIMITED = ['-vf', 'scale=out_range=tv,setparams=range=tv:colorspace=unknown:color_primaries=unknown:color_trc=unknown', '-color_range', 'tv'];

function chunkCodecArgs(spec: EncodeSpec): string[] {
  switch (spec.codec) {
    case 'h264':
      return [...LIMITED, '-c:v', 'libx264', '-crf', String(spec.crf ?? 18), '-preset', spec.preset ?? 'faster', '-x264-params', 'rc-lookahead=40', '-pix_fmt', 'yuv420p', '-video_track_timescale', '90000'];
    case 'vp9':
      return [...LIMITED, '-c:v', 'libvpx-vp9', '-crf', String(spec.crf ?? 28), '-b:v', '0', '-pix_fmt', 'yuv420p', '-row-mt', '1'];
    case 'prores':
      return ['-c:v', 'prores_ks', '-profile:v', '4444', '-pix_fmt', 'yuva444p10le', '-video_track_timescale', '90000'];
    case 'gif':
      // Lossless intermediate; the palette pass happens once over the joined chunks.
      return ['-c:v', 'ffv1', '-pix_fmt', 'bgra'];
  }
}

export interface FfmpegProcess {
  proc: ChildProcessWithoutNullStreams;
  /** Write one encoded frame image, honouring back-pressure. */
  write(frame: Buffer): Promise<void>;
  /** Close stdin and wait for a clean exit. */
  finish(): Promise<void>;
  kill(): void;
}

export function runFfmpeg(args: string[], signal?: AbortSignal): FfmpegProcess {
  const tool = mediaTool('ffmpeg');
  const proc = spawn(tool.cmd, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: tool.cwd, env: tool.env, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.on('data', (d: Buffer) => {
    stderr = (stderr + d.toString()).slice(-4000);
  });
  proc.stdout.resume();
  const exited = new Promise<void>((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code, sig) => (code === 0 ? resolve() : reject(new Error(`ffmpeg ${sig ? `was killed (${sig})` : `exited with ${code}`}: ${stderr.trim().split('\n').slice(-3).join(' | ') || args.join(' ')}`))));
  });
  exited.catch(() => undefined);
  proc.stdin.on('error', () => undefined);
  const kill = () => {
    if (proc.exitCode === null) proc.kill('SIGKILL');
  };
  signal?.addEventListener('abort', kill, { once: true });
  return {
    proc,
    write: (frame) =>
      new Promise<void>((resolve, reject) => {
        if (proc.exitCode !== null) return reject(new Error(`ffmpeg stopped early: ${stderr.trim()}`));
        if (proc.stdin.write(frame)) resolve();
        else proc.stdin.once('drain', resolve);
      }),
    finish: async () => {
      proc.stdin.end();
      try {
        await exited;
      } finally {
        signal?.removeEventListener('abort', kill);
      }
    },
    kill,
  };
}

/** An encoder for one chunk: frames in on stdin, `out` when finished. */
export function chunkEncoder(spec: EncodeSpec, out: string, signal?: AbortSignal): FfmpegProcess {
  const input = ['-f', 'image2pipe', '-framerate', String(spec.fps), '-c:v', frameFormat(spec.codec) === 'png' ? 'png' : 'mjpeg', '-i', '-'];
  return runFfmpeg([...input, ...chunkCodecArgs(spec), '-an', out], signal);
}

export async function runToEnd(args: string[], signal?: AbortSignal): Promise<void> {
  const p = runFfmpeg(args, signal);
  await p.finish();
}

/** Join chunks into the delivery file, muxing `audio` (a WAV) when given. */
export async function assemble(args: { codec: EngineCodec; chunks: string[]; listPath: string; audio: string | null; out: string; signal?: AbortSignal }): Promise<void> {
  const { codec, chunks, listPath, audio, out, signal } = args;
  await writeFile(listPath, chunks.map((c) => `file '${c.replace(/'/g, "'\\''")}'`).join('\n') + '\n');
  const input = ['-f', 'concat', '-safe', '0', '-i', listPath];
  if (codec === 'gif') {
    await runToEnd([...input, '-filter_complex', 'split[v],palettegen,[v]paletteuse', '-loop', '0', out], signal);
    return;
  }
  const audioIn = audio ? ['-i', audio] : [];
  const audioOut = !audio ? ['-an'] : codec === 'h264' ? ['-c:a', 'aac', '-b:a', '320k'] : codec === 'vp9' ? ['-c:a', 'libopus', '-b:a', '128k'] : ['-c:a', 'pcm_s16le'];
  await runToEnd([...input, ...audioIn, '-map', '0:v', ...(audio ? ['-map', '1:a'] : []), '-c:v', 'copy', ...audioOut, out], signal);
}
