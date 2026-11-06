// Asset uploads (public/assets/uploads/), kind sniffing, ffprobe metadata, existence checks.

import type { AssetProbeResponse } from '../src/core/api-contract';
import { execFile } from 'node:child_process';
import { mkdir, open, stat, writeFile } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { UploadAssetResponse } from '../src/core/api-contract';
import { mediaTool } from './media-tools';
import { probeVideo } from './video';

export interface KindInfo {
  /** Video uploads are streamed to disk (server/video.ts); the rest arrive as one buffer. */
  kind: UploadAssetResponse['kind'];
  ext: string;
  mimeType: string;
}

const BY_EXT: Record<string, KindInfo> = {
  png: { kind: 'image', ext: 'png', mimeType: 'image/png' },
  jpg: { kind: 'image', ext: 'jpg', mimeType: 'image/jpeg' },
  jpeg: { kind: 'image', ext: 'jpg', mimeType: 'image/jpeg' },
  webp: { kind: 'image', ext: 'webp', mimeType: 'image/webp' },
  gif: { kind: 'image', ext: 'gif', mimeType: 'image/gif' },
  svg: { kind: 'svg', ext: 'svg', mimeType: 'image/svg+xml' },
  wav: { kind: 'audio', ext: 'wav', mimeType: 'audio/wav' },
  mp3: { kind: 'audio', ext: 'mp3', mimeType: 'audio/mpeg' },
  m4a: { kind: 'audio', ext: 'm4a', mimeType: 'audio/mp4' },
  aac: { kind: 'audio', ext: 'aac', mimeType: 'audio/aac' },
  ogg: { kind: 'audio', ext: 'ogg', mimeType: 'audio/ogg' },
  mp4: { kind: 'video', ext: 'mp4', mimeType: 'video/mp4' },
  m4v: { kind: 'video', ext: 'mp4', mimeType: 'video/mp4' },
  webm: { kind: 'video', ext: 'webm', mimeType: 'video/webm' },
  mov: { kind: 'video', ext: 'mov', mimeType: 'video/quicktime' },
};

const BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
};

export const SUPPORTED_EXTENSIONS = Object.keys(BY_EXT);

/**
 * Decide the asset kind from the file extension first (most reliable for
 * uploads from a browser), falling back to the mime type. null = unsupported.
 */
export function sniffAssetKind(mimeType: string | undefined, filename: string | undefined): KindInfo | null {
  const ext = extname(filename ?? '').slice(1).toLowerCase();
  if (ext && BY_EXT[ext]) return BY_EXT[ext];
  const mime = (mimeType ?? '').split(';')[0].trim().toLowerCase();
  const fromMime = BY_MIME[mime];
  return fromMime ? BY_EXT[fromMime] : null;
}

/** Resolve an asset-root-relative src inside publicDir, or null if it escapes it. */
export function resolvePublicPath(publicDir: string, src: string): string | null {
  if (typeof src !== 'string' || src.length === 0 || src.includes('\0')) return null;
  if (/^(data:|blob:|https?:)/.test(src)) return null;
  const root = resolve(publicDir);
  const target = resolve(root, src.replace(/^\/+/, ''));
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;
  return target;
}

export async function assetExists(publicDir: string, src: string): Promise<boolean> {
  const p = resolvePublicPath(publicDir, src);
  if (!p) return false;
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

export { ffprobePath } from './media-tools';

export interface MediaInfo {
  width?: number;
  height?: number;
  durationSeconds?: number;
}

export function probeMedia(path: string): Promise<MediaInfo> {
  return new Promise((resolvePromise) => {
    const tool = mediaTool('ffprobe');
    execFile(
      tool.cmd,
      ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path],
      { maxBuffer: 10 * 1024 * 1024, cwd: tool.cwd, env: tool.env },
      (err, stdout) => {
        if (err) return resolvePromise({});
        try {
          const json = JSON.parse(stdout) as { streams?: { codec_type?: string; width?: number; height?: number; duration?: string }[]; format?: { duration?: string } };
          const video = json.streams?.find((s) => s.codec_type === 'video' && s.width);
          const audio = json.streams?.find((s) => s.codec_type === 'audio');
          const info: MediaInfo = {};
          if (video) {
            info.width = video.width;
            info.height = video.height;
          }
          const dur = Number(audio?.duration ?? json.format?.duration);
          if (audio && Number.isFinite(dur) && dur > 0) info.durationSeconds = dur;
          resolvePromise(info);
        } catch {
          resolvePromise({});
        }
      },
    );
  });
}

/** Best-effort width/height from an SVG's attributes or viewBox (ffprobe cannot read SVG). */
export function svgDimensions(svg: string): { width?: number; height?: number } {
  const tag = /<svg\b[^>]*>/i.exec(svg)?.[0];
  if (!tag) return {};
  const num = (name: string) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*["']\\s*([0-9.]+)(px)?\\s*["']`, 'i').exec(tag);
    return m ? Number(m[1]) : undefined;
  };
  let width = num('width');
  let height = num('height');
  if (width === undefined || height === undefined) {
    const vb = /\bviewBox\s*=\s*["']\s*([-0-9.]+)[ ,]+([-0-9.]+)[ ,]+([0-9.]+)[ ,]+([0-9.]+)\s*["']/i.exec(tag);
    if (vb) {
      width ??= Number(vb[3]);
      height ??= Number(vb[4]);
    }
  }
  return { width, height };
}

// ---------------------------------------------------------------------------
// Probe: does the file exist, and can a browser decode it? Header parsing
// only (no new dependencies, no full decode): the format is sniffed from the
// bytes, not the extension, and the intrinsic size read from the header.
// ---------------------------------------------------------------------------


export type HeaderInfo = { mimeType: string; width?: number; height?: number } | { error: string };

const ascii = (buf: Buffer, start: number, end: number) => buf.toString('latin1', start, end);

function pngHeader(buf: Buffer): HeaderInfo {
  if (buf.length < 24 || ascii(buf, 12, 16) !== 'IHDR') return { error: 'PNG header is truncated or has no IHDR chunk' };
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return { error: 'PNG has a zero width or height' };
  return { mimeType: 'image/png', width, height };
}

function jpegHeader(buf: Buffer): HeaderInfo {
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) return { error: `JPEG marker expected at byte ${i}` };
    const marker = buf[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2; // standalone markers carry no length
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // end of image / start of scan before any frame header
    const length = buf.readUInt16BE(i + 2);
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > buf.length) break;
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      if (!width || !height) return { error: 'JPEG has a zero width or height' };
      return { mimeType: 'image/jpeg', width, height };
    }
    if (length < 2) return { error: 'JPEG segment length is invalid' };
    i += 2 + length;
  }
  return { error: 'JPEG has no frame header (SOF) — the file is truncated or corrupt' };
}

function gifHeader(buf: Buffer): HeaderInfo {
  if (buf.length < 10) return { error: 'GIF header is truncated' };
  const width = buf.readUInt16LE(6);
  const height = buf.readUInt16LE(8);
  if (!width || !height) return { error: 'GIF has a zero width or height' };
  return { mimeType: 'image/gif', width, height };
}

function webpHeader(buf: Buffer): HeaderInfo {
  const chunk = ascii(buf, 12, 16);
  // Bytes each chunk type needs to reach its size fields.
  const need = chunk === 'VP8L' ? 25 : 30;
  if (buf.length < need) return { error: 'WebP header is truncated' };
  if (chunk === 'VP8 ') {
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) return { error: 'WebP (lossy) frame start code is missing' };
    return { mimeType: 'image/webp', width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (buf[20] !== 0x2f) return { error: 'WebP (lossless) signature is missing' };
    const [b0, b1, b2, b3] = [buf[21], buf[22], buf[23], buf[24]];
    return { mimeType: 'image/webp', width: 1 + (((b1 & 0x3f) << 8) | b0), height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6)) };
  }
  if (chunk === 'VP8X') return { mimeType: 'image/webp', width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  return { error: `WebP chunk “${chunk.trim()}” is not VP8, VP8L or VP8X` };
}

/** Skip XML prolog material only; an SVG buried in text/HTML is not an SVG document. */
function hasSvgRoot(buf: Buffer): boolean {
  let text = buf.toString('utf8').replace(/^\uFEFF/, '').trimStart();
  const declaration = /^<\?xml\s[^?]*\?>/.exec(text);
  if (declaration) text = text.slice(declaration[0].length).trimStart();
  let doctype = false;
  while (true) {
    const comment = /^<!--[\s\S]*?-->/.exec(text);
    if (comment) { text = text.slice(comment[0].length).trimStart(); continue; }
    const dtd = !doctype && /^<!DOCTYPE\s+(?:[^>\["']|"[^"]*"|'[^']*')*(?:\[(?:[^\]"']|"[^"]*"|'[^']*')*\]\s*)?>/.exec(text);
    if (dtd) { doctype = true; text = text.slice(dtd[0].length).trimStart(); continue; }
    return /^<svg(?:\s|\/?>)/.test(text);
  }
}

function svgHeader(buf: Buffer): HeaderInfo {
  const text = buf.toString('utf8');
  if (!hasSvgRoot(buf)) return { error: 'No <svg> root element — the file is not an SVG document' };
  const { width, height } = svgDimensions(text);
  return { mimeType: 'image/svg+xml', ...(width ? { width } : {}), ...(height ? { height } : {}) };
}

/** Sniff an image from its first bytes and read its intrinsic size. */
export function readImageHeader(buf: Buffer): HeaderInfo {
  if (buf.length >= 8 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) return pngHeader(buf);
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return jpegHeader(buf);
  if (buf.length >= 6 && /^GIF8[79]a$/.test(ascii(buf, 0, 6))) return gifHeader(buf);
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WEBP') return webpHeader(buf);
  const head = buf.toString('utf8', 0, Math.min(buf.length, 4096)).replace(/^﻿/, '').trimStart();
  if (head.startsWith('<')) return svgHeader(buf);
  return { error: buf.length === 0 ? 'The file is empty' : 'Not a PNG, JPEG, GIF, WebP or SVG file' };
}

/** Sniff an audio container from its first bytes (wav, mp3, ogg, m4a/aac). */
export function readAudioHeader(buf: Buffer): HeaderInfo {
  if (buf.length >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 12) === 'WAVE') return { mimeType: 'audio/wav' };
  if (buf.length >= 3 && ascii(buf, 0, 3) === 'ID3') return { mimeType: 'audio/mpeg' };
  if (buf.length >= 4 && ascii(buf, 0, 4) === 'OggS') return { mimeType: 'audio/ogg' };
  if (buf.length >= 8 && ascii(buf, 4, 8) === 'ftyp') return { mimeType: 'audio/mp4' };
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return { mimeType: 'audio/aac' };
  if (buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return { mimeType: 'audio/mpeg' };
  return { error: buf.length === 0 ? 'The file is empty' : 'Not a WAV, MP3, OGG or M4A/AAC file' };
}

/** Bytes read for header sniffing; JPEG frame headers can follow a large EXIF block. */
const PROBE_BYTES = 1024 * 1024;

export async function probeAsset(publicDir: string, src: string): Promise<AssetProbeResponse> {
  const path = resolvePublicPath(publicDir, src);
  if (!path) return { exists: false, decodable: false, error: 'Not a path inside public/' };
  let bytes: number;
  try {
    const st = await stat(path);
    if (!st.isFile()) return { exists: false, decodable: false, error: 'Not a file' };
    bytes = st.size;
  } catch {
    return { exists: false, decodable: false, error: `File not found: public/${src.replace(/^\/+/, '')}` };
  }
  const fh = await open(path, 'r');
  let head: Buffer;
  try {
    const buf = Buffer.alloc(Math.min(bytes, PROBE_BYTES));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    head = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  const kind = sniffAssetKind(undefined, path)?.kind;
  if (kind === 'video') {
    const v = await probeVideo(path);
    const mimeType = sniffAssetKind(undefined, path)!.mimeType;
    const meta = { mimeType, width: v.width, height: v.height, durationSeconds: v.durationSeconds, fps: v.fps, codec: v.codec, hasAudio: v.hasAudio };
    return v.decodable ? { exists: true, bytes, decodable: true, ...meta } : { exists: true, bytes, decodable: false, error: v.error, ...meta };
  }
  const info = kind === 'audio' ? readAudioHeader(head) : readImageHeader(head);
  if ('error' in info) return { exists: true, bytes, decodable: false, error: info.error };
  return { exists: true, bytes, decodable: true, ...info };
}

export class AssetError extends Error {}

export async function storeUpload(publicDir: string, filename: string | undefined, mimeType: string | undefined, body: Buffer): Promise<UploadAssetResponse> {
  const info = sniffAssetKind(mimeType, filename);
  if (!info) {
    throw new AssetError(
      `Unsupported file type "${filename ?? mimeType ?? 'unknown'}". Supported: ${SUPPORTED_EXTENSIONS.join(', ')}.`,
    );
  }
  if (info.kind === 'video') throw new AssetError('Video uploads are streamed; POST them to /api/assets with the video file name.');
  if (!body || body.length === 0) throw new AssetError('The uploaded file is empty.');
  if (info.kind === 'image' || info.kind === 'svg') {
    const header = readImageHeader(body);
    if ('error' in header || header.mimeType !== info.mimeType) throw new AssetError("The file's contents don't match its type.");
  }
  // Audio too: a key, a link or a browser's session file renamed .mp3 is not audio.
  if (info.kind === 'audio' && 'error' in readAudioHeader(body)) throw new AssetError("The file's contents don't match its type.");
  const dir = join(publicDir, 'assets', 'uploads');
  await mkdir(dir, { recursive: true });
  const name = `u_${randomBytes(6).toString('hex')}.${info.ext}`;
  const abs = join(dir, name);
  await writeFile(abs, body);

  const res: UploadAssetResponse = {
    src: `assets/uploads/${name}`,
    name: basename(filename ?? name),
    mimeType: info.mimeType,
    kind: info.kind,
  };
  if (info.kind === 'svg') {
    const dims = svgDimensions(body.toString('utf8'));
    if (dims.width) res.width = dims.width;
    if (dims.height) res.height = dims.height;
  } else {
    const media = await probeMedia(abs);
    if (info.kind === 'image') {
      if (media.width) res.width = media.width;
      if (media.height) res.height = media.height;
    } else if (media.durationSeconds !== undefined) {
      res.durationSeconds = media.durationSeconds;
    }
  }
  return res;
}
