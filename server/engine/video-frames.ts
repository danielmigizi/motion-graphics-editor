// Frame-exact video for exports: ffmpeg decodes every frame of a video file
// once (no frame dropped or duplicated: fps_mode passthrough), numbered in
// presentation order, with each frame's presentation time from showinfo. The
// render page then shows, at source time t, the last frame starting at or
// before t — what a player shows — as a plain <img>. Cached per file content,
// so a re-export decodes nothing; and any format ffmpeg reads works, even
// ones Chrome cannot decode.

import { spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mediaTool } from '../media-tools';

export interface DecodedVideo {
  dir: string;
  ext: 'jpg' | 'png';
  /** Presentation time of frame i (file `${i + 1}.${ext}`), seconds, ascending. */
  pts: number[];
}

function run(bin: 'ffmpeg' | 'ffprobe', args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string }> {
  const tool = mediaTool(bin);
  return new Promise((resolve, reject) => {
    const proc = spawn(tool.cmd, args, { cwd: tool.cwd, env: tool.env, signal });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${bin} failed on ${args.at(-1)}: ${stderr.trim().split('\n').slice(-2).join(' | ')}`))));
  });
}

const pending = new Map<string, Promise<DecodedVideo>>();

/** Decode `input` (a path or URL) into `cacheDir/<key>/` once; later calls reuse it. */
export function decodeVideoFrames(input: string, cacheDir: string, key: string, signal?: AbortSignal): Promise<DecodedVideo> {
  const dir = join(cacheDir, key);
  let p = pending.get(dir);
  if (!p) {
    p = decode(input, dir, signal).finally(() => pending.delete(dir));
    pending.set(dir, p);
  }
  return p;
}

async function decode(input: string, dir: string, signal?: AbortSignal): Promise<DecodedVideo> {
  const cached = await readFile(join(dir, 'index.json'), 'utf8').then((t) => JSON.parse(t) as Omit<DecodedVideo, 'dir'>, () => null);
  if (cached) return { dir, ...cached };
  const probe = JSON.parse(
    (await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,pix_fmt,width,height,color_space,color_range:stream_tags=alpha_mode', '-of', 'json', input], signal)).stdout,
  ) as { streams?: { codec_name?: string; pix_fmt?: string; width?: number; height?: number; color_space?: string; color_range?: string; tags?: { alpha_mode?: string } }[] };
  const stream = probe.streams?.[0];
  if (!stream) throw new Error(`${input} has no video stream`);
  // VP8/VP9 keep alpha in a side channel only libvpx decodes; keep it in PNGs.
  const alpha = stream.tags?.alpha_mode === '1' || /a/.test((stream.pix_fmt ?? '').replace(/^gray/, ''));
  const decoder = alpha && stream.codec_name === 'vp9' ? ['-c:v', 'libvpx-vp9'] : alpha && stream.codec_name === 'vp8' ? ['-c:v', 'libvpx'] : [];
  const ext = alpha ? 'png' : 'jpg';
  // Convert the way Chrome's <video> does (the preview plays the file there):
  // the file's own matrix and range; an untagged file as BT.709 at HD sizes,
  // BT.601 below, limited range. Out: full-range BT.601 (JPEG) or RGB (PNG).
  const hd = (stream.width ?? 0) >= 1280 || (stream.height ?? 0) > 576;
  const tagged = stream.color_space && stream.color_space !== 'unknown' ? stream.color_space : hd ? 'bt709' : 'bt601';
  const matrix = /^(bt470bg|smpte170m|bt601)/.test(tagged) ? 'bt601' : /^bt2020/.test(tagged) ? 'bt2020' : 'bt709';
  const range = stream.color_range === 'pc' ? 'pc' : 'tv';
  const convert = `scale=in_color_matrix=${matrix}:in_range=${range}:out_color_matrix=bt601:out_range=pc${alpha ? ',format=rgba' : ',format=yuvj444p'}`;
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  try {
    const { stderr } = await run(
      'ffmpeg',
      ['-hide_banner', '-loglevel', 'info', ...decoder, '-i', input, '-map', '0:v:0', '-fps_mode', 'passthrough', '-vf', `${convert},showinfo`, ...(alpha ? [] : ['-q:v', '2']), '-y', join(tmp, `%d.${ext}`)],
      signal,
    );
    const pts = [...stderr.matchAll(/Parsed_showinfo.*?\bn:\s*\d+\s+pts:\s*-?\d+\s+pts_time:(-?[\d.]+)/g)].map((m) => Number(m[1]));
    if (pts.length === 0) throw new Error(`ffmpeg decoded no frames from ${input}`);
    // Presentation order is already ascending; guard against odd streams anyway.
    for (let i = 1; i < pts.length; i++) if (pts[i] < pts[i - 1]) pts[i] = pts[i - 1];
    await writeFile(join(tmp, 'index.json'), JSON.stringify({ ext, pts }));
    await rm(dir, { recursive: true, force: true });
    await rename(tmp, dir);
    return { dir, ext, pts };
  } catch (err) {
    await rm(tmp, { recursive: true, force: true });
    throw err;
  }
}
