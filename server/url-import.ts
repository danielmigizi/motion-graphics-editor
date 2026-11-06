// Import a file from an https URL into public/assets/uploads/ (generated
// media: generators return signed https URLs). The download is streamed to disk
// with a size cap; the kind is sniffed from the bytes, never from the URL or
// the server's Content-Type. Images, SVG, audio and video are accepted.
//
// SSRF: every hop (the URL and each redirect, at most MAX_REDIRECTS) is
// checked BEFORE anything connects to it — https only, no credentials, and
// every address its host resolves to must be public — and the connection is
// pinned to the address that was checked, so a second DNS answer cannot
// rebind it to this machine or the private network.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createWriteStream } from 'node:fs';
import { mkdir, rename, unlink } from 'node:fs/promises';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { basename, join } from 'node:path';
import { Transform, type Readable, type Writable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import type { ImportUrlResponse } from '../src/core/generation';
import type { AssetKind } from '../src/core/types';
import { mediaTool } from './media-tools';
import { readAudioHeader, readImageHeader, svgDimensions } from './assets';

export const MAX_IMPORT_BYTES = 200 * 1024 * 1024;
/** Redirects followed (each one checked before it is requested). */
export const MAX_REDIRECTS = 5;
/** JPEG frame headers can follow a large EXIF block. */
const SNIFF_BYTES = 1024 * 1024;

export class ImportUrlError extends Error {}

export interface Sniffed {
  kind: AssetKind;
  ext: string;
  mimeType: string;
  width?: number;
  height?: number;
}

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

const v4Bytes = (ip: string): number[] | null => (isIP(ip) === 4 ? ip.split('.').map(Number) : null);

/** 16 bytes of an IPv6 address (with or without an embedded dotted quad); null when it is not one. */
export function ipv6Bytes(ip: string): number[] | null {
  if (isIP(ip) !== 6 || ip.includes('%')) return null;
  let s = ip.toLowerCase();
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (quad) s = `${s.slice(0, -quad[1].length)}0:0`;
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length === 2 ? [...head, ...Array<string>(8 - head.length - tail.length).fill('0'), ...tail] : head;
  if (groups.length !== 8) return null;
  const bytes = groups.flatMap((g) => {
    const n = parseInt(g, 16);
    return [(n >> 8) & 255, n & 255];
  });
  if (quad) bytes.splice(12, 4, ...quad[1].split('.').map(Number));
  return bytes;
}

const inPrefix = (bytes: number[], prefix: number[], bits: number): boolean => {
  for (let i = 0; i < bits; i++) {
    const byte = i >> 3;
    const mask = 0x80 >> (i & 7);
    if ((bytes[byte] & mask) !== ((prefix[byte] ?? 0) & mask)) return false;
  }
  return true;
};

/** Special-purpose IPv4 ranges (RFC 6890 and friends): this host, private, CGNAT, loopback, link-local, test nets, benchmarking, multicast, reserved, broadcast. */
const V4_BLOCKED: [number[], number][] = [
  [[0], 8], [[10], 8], [[100, 64], 10], [[127], 8], [[169, 254], 16], [[172, 16], 12], [[192, 0, 0], 24], [[192, 0, 2], 24],
  [[192, 88, 99], 24], [[192, 168], 16], [[198, 18], 15], [[198, 51, 100], 24], [[203, 0, 113], 24], [[224], 4], [[240], 4],
];

/** Inside global unicast 2000::/3: IETF special-purpose (incl. Teredo), documentation, 6to4. */
const V6_BLOCKED: [number[], number][] = [
  [[0x20, 0x01, 0x00, 0x00], 23], [[0x20, 0x01, 0x0d, 0xb8], 32], [[0x20, 0x02], 16], [[0x3f, 0xff], 20],
];

/** Is `ip` a public unicast address? Anything else (private, loopback, link-local, CGNAT, ULA, multicast, IPv4-mapped/NAT64 forms of those, not an address) is refused. */
export function isPublicAddress(ip: string): boolean {
  const v4 = v4Bytes(ip);
  if (v4) return !V4_BLOCKED.some(([p, bits]) => inPrefix(v4, p, bits));
  const b = ipv6Bytes(ip);
  if (!b) return false;
  // IPv4-mapped (::ffff:0:0/96) and the well-known NAT64 prefix (64:ff9b::/96) carry an IPv4 address.
  if (inPrefix(b, [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96) || inPrefix(b, [0, 0x64, 0xff, 0x9b], 96)) return isPublicAddress(b.slice(12).join('.'));
  // Only global unicast (2000::/3); that excludes ::, ::1, IPv4-compatible, discard, ULA, link-local, site-local and multicast.
  if (!inPrefix(b, [0x20], 3)) return false;
  return !V6_BLOCKED.some(([p, bits]) => inPrefix(b, p, bits));
}

const PRIVATE_MESSAGE = 'URLs pointing at this machine or a private network cannot be imported.';

/** Refuse anything but https to a public host name or address (checked before anything connects). */
export function checkImportUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ImportUrlError('url is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new ImportUrlError('Only https:// URLs can be imported.');
  if (url.username || url.password) throw new ImportUrlError('URLs with credentials cannot be imported.');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const local = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal');
  if (local || (isIP(host) !== 0 && !isPublicAddress(host))) throw new ImportUrlError(PRIVATE_MESSAGE);
  return url;
}

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Every address a host name resolves to. */
export type Lookup = (hostname: string) => Promise<ResolvedAddress[]>;

const systemLookup: Lookup = async (hostname) =>
  (await dnsLookup(hostname, { all: true, verbatim: true })).map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

/** The address to connect to for a checked URL: all of the host's addresses must be public. */
export async function resolvePublicAddress(url: URL, lookup: Lookup = systemLookup): Promise<ResolvedAddress> {
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const literal = isIP(host);
  if (literal) {
    if (!isPublicAddress(host)) throw new ImportUrlError(PRIVATE_MESSAGE);
    return { address: host, family: literal === 6 ? 6 : 4 };
  }
  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(host);
  } catch (e) {
    throw new ImportUrlError(`Could not download the file: ${host} could not be resolved (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (!addresses.length) throw new ImportUrlError(`Could not download the file: ${host} could not be resolved.`);
  if (addresses.some((a) => !isPublicAddress(a.address))) throw new ImportUrlError(PRIVATE_MESSAGE);
  return addresses[0];
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export interface DownloadResponse {
  status: number;
  headers: { location?: string; 'content-length'?: string; 'content-type'?: string };
  body: Readable;
}

/** One GET of `url`, connected to `address` (the host is never resolved again). */
export type Connect = (url: URL, address: ResolvedAddress, signal: AbortSignal) => Promise<DownloadResponse>;

/** A DNS lookup that always answers `address` (the one that was checked). */
export function pinnedLookup(address: ResolvedAddress): LookupFunction {
  return ((_hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    if (options?.all) callback(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  }) as unknown as LookupFunction;
}

/** The default Connect: https with TLS verified against the URL's host name, the socket pinned to `address`, no redirects, no pooled sockets. */
export function connectPinned(url: URL, address: ResolvedAddress, signal: AbortSignal, extra: RequestOptions = {}): Promise<DownloadResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, {
      ...extra,
      method: 'GET',
      agent: false,
      lookup: pinnedLookup(address),
      signal,
      headers: { accept: 'image/*, audio/*, video/*, */*', 'user-agent': 'motion-graphics-editor' },
    }, (res) => {
      const header = (k: string) => (typeof res.headers[k] === 'string' ? (res.headers[k] as string) : undefined);
      resolve({ status: res.statusCode ?? 0, headers: { location: header('location'), 'content-length': header('content-length'), 'content-type': header('content-type') }, body: res });
    });
    req.on('error', reject);
    req.end();
  });
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Connect to `url`, following redirects by hand: each destination is checked and resolved before it is requested. */
async function openDownload(start: URL, opts: ImportOptions, signal: AbortSignal): Promise<{ res: DownloadResponse; url: URL }> {
  const connect = opts.connect ?? connectPinned;
  const maxRedirects = opts.maxRedirects ?? MAX_REDIRECTS;
  let url = start;
  for (let hop = 0; ; hop++) {
    const address = await resolvePublicAddress(url, opts.lookup);
    let res: DownloadResponse;
    try {
      res = await connect(url, address, signal);
    } catch (e) {
      throw new ImportUrlError(`Could not download the file: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!REDIRECTS.has(res.status)) return { res, url };
    res.body.destroy();
    if (!res.headers.location) throw new ImportUrlError(`The download failed (HTTP ${res.status} without a Location).`);
    if (hop >= maxRedirects) throw new ImportUrlError(`The download redirected more than ${maxRedirects} times; it was not imported.`);
    let next: URL;
    try {
      next = new URL(res.headers.location, url);
    } catch {
      throw new ImportUrlError('The download redirected to an invalid URL.');
    }
    // A redirect must not leave https or reach a private host.
    url = checkImportUrl(next.href);
  }
}

const ascii = (b: Buffer, s: number, e: number) => b.toString('latin1', s, e);

/** Sniff the kind from the first bytes. MP4/WebM/QuickTime are video unless the ftyp brand says audio (ffprobe refines it later). */
export function sniffBytes(head: Buffer): Sniffed | null {
  if (head.length >= 12 && ascii(head, 4, 8) === 'ftyp') {
    const brand = ascii(head, 8, 12);
    if (/^M4[ABP] $/.test(brand)) return { kind: 'audio', ext: 'm4a', mimeType: 'audio/mp4' };
    if (brand === 'qt  ') return { kind: 'video', ext: 'mov', mimeType: 'video/quicktime' };
    return { kind: 'video', ext: 'mp4', mimeType: 'video/mp4' };
  }
  if (head.length >= 4 && head.readUInt32BE(0) === 0x1a45dfa3) return { kind: 'video', ext: 'webm', mimeType: 'video/webm' };
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    const jpeg = readImageHeader(head);
    return { kind: 'image', ext: 'jpg', mimeType: 'image/jpeg', ...('error' in jpeg ? {} : { width: jpeg.width, height: jpeg.height }) };
  }
  const image = readImageHeader(head);
  if (!('error' in image)) {
    const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' }[image.mimeType];
    if (ext) return { kind: ext === 'svg' ? 'svg' : 'image', ext, mimeType: image.mimeType, ...(image.width ? { width: image.width } : {}), ...(image.height ? { height: image.height } : {}) };
  }
  const audio = readAudioHeader(head);
  if (!('error' in audio)) {
    const ext = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/aac': 'aac', 'audio/mp4': 'm4a' }[audio.mimeType];
    if (ext) return { kind: 'audio', ext, mimeType: audio.mimeType };
  }
  return null;
}

/** ffprobe through the shared resolver (server/media-tools.ts). */
function ffprobe(): { bin: string; env?: NodeJS.ProcessEnv; cwd?: string } {
  const tool = mediaTool('ffprobe');
  return { bin: tool.cmd, env: tool.env, cwd: tool.cwd };
}

export interface MediaStreams {
  video?: { width: number; height: number; fps?: number };
  audio: boolean;
  durationSeconds?: number;
}

export function probeStreams(path: string): Promise<MediaStreams | null> {
  const { bin, env, cwd } = ffprobe();
  return new Promise((resolve) => {
    execFile(bin, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path], { maxBuffer: 10 * 1024 * 1024, env, cwd, timeout: 30000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const j = JSON.parse(stdout) as { streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; disposition?: { attached_pic?: number } }[]; format?: { duration?: string } };
        const v = j.streams?.find((s) => s.codec_type === 'video' && s.width && !s.disposition?.attached_pic);
        const [num, den] = (v?.avg_frame_rate ?? '').split('/').map(Number);
        const fps = num > 0 && den > 0 ? Math.round((num / den) * 1000) / 1000 : undefined;
        const dur = Number(j.format?.duration);
        resolve({
          ...(v ? { video: { width: v.width!, height: v.height!, ...(fps ? { fps } : {}) } } : {}),
          audio: !!j.streams?.some((s) => s.codec_type === 'audio'),
          ...(Number.isFinite(dur) && dur > 0 ? { durationSeconds: dur } : {}),
        });
      } catch {
        resolve(null);
      }
    });
  });
}

export interface ImportOptions {
  maxBytes?: number;
  probe?: (path: string) => Promise<MediaStreams | null>;
  signal?: AbortSignal;
  timeoutMs?: number;
  /** Resolves host names (tests pass a fake; default: the system resolver, every address). */
  lookup?: Lookup;
  /** Opens one pinned GET (tests pass a fake; default: connectPinned). */
  connect?: Connect;
  maxRedirects?: number;
  /** Opens the partial file (tests inject write failures; default: fs.createWriteStream). */
  openFile?: (path: string) => Writable;
  /** Moves the finished partial file into place (tests inject failures; default: fs.rename). */
  renameFile?: (from: string, to: string) => Promise<void>;
}

/** A display name from the URL's last path segment (query and signature dropped). */
function nameFromUrl(url: URL, ext: string): string {
  const raw = basename(url.pathname);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // A malformed escape ("%E0%A4%A"): the raw segment, cleaned below.
  }
  const last = decoded.replace(/[^\w .()-]+/g, '').slice(0, 60);
  if (!last || /^[0-9a-f-]{20,}$/i.test(last)) return `generated.${ext}`;
  return /\.[a-z0-9]{2,4}$/i.test(last) ? last : `${last}.${ext}`;
}

export interface FetchedBytes {
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
}

/** https GET with the same SSRF checks as importFromUrl, buffered in memory (HTML/CSS/small logos). */
export async function downloadBytes(rawUrl: string, opts: ImportOptions = {}): Promise<FetchedBytes> {
  const url = checkImportUrl(rawUrl);
  const maxBytes = opts.maxBytes ?? MAX_IMPORT_BYTES;
  const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 30_000), ...(opts.signal ? [opts.signal] : [])]);
  const { res, url: final } = await openDownload(url, opts, signal);
  const tooBig = (declared?: number) => new ImportUrlError(declared !== undefined
    ? `The file is ${(declared / 1024 / 1024).toFixed(0)} MB; the limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`
    : `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  if (res.status < 200 || res.status >= 300) {
    res.body.destroy();
    throw new ImportUrlError(`The download failed (HTTP ${res.status}).`);
  }
  const declared = Number(res.headers['content-length']);
  if (res.headers['content-length'] !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    res.body.destroy();
    throw tooBig(declared);
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of res.body) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buf.length;
      if (bytes > maxBytes) {
        res.body.destroy();
        throw tooBig();
      }
      chunks.push(buf);
    }
  } catch (e) {
    res.body.destroy();
    if (e instanceof ImportUrlError) throw e;
    throw new ImportUrlError(`The download was interrupted: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!bytes) throw new ImportUrlError('The downloaded file is empty.');
  return { finalUrl: final.href, status: res.status, contentType: res.headers['content-type'] ?? '', body: Buffer.concat(chunks) };
}

/** Download `rawUrl` into publicDir/assets/uploads/. */
export async function importFromUrl(publicDir: string, rawUrl: string, name: string | undefined, opts: ImportOptions = {}): Promise<ImportUrlResponse> {
  const url = checkImportUrl(rawUrl);
  const maxBytes = opts.maxBytes ?? MAX_IMPORT_BYTES;
  const signal = AbortSignal.any([AbortSignal.timeout(opts.timeoutMs ?? 300000), ...(opts.signal ? [opts.signal] : [])]);
  const { res } = await openDownload(url, opts, signal);
  const tooBig = (declared?: number) => new ImportUrlError(declared !== undefined
    ? `The file is ${(declared / 1024 / 1024).toFixed(0)} MB; the limit is ${Math.round(maxBytes / 1024 / 1024)} MB.`
    : `The file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB; it was not imported.`);
  if (res.status < 200 || res.status >= 300) {
    res.body.destroy();
    throw new ImportUrlError(`The download failed (HTTP ${res.status}). Signed URLs expire; fetch a fresh one and try again.`);
  }
  const declared = Number(res.headers['content-length']);
  if (res.headers['content-length'] !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    res.body.destroy();
    throw tooBig(declared);
  }

  const dir = join(publicDir, 'assets', 'uploads');
  await mkdir(dir, { recursive: true }).catch((e: unknown) => {
    res.body.destroy();
    throw e;
  });
  const id = randomBytes(6).toString('hex');
  const part = join(dir, `.u_${id}.part`);
  let bytes = 0;
  const head: Buffer[] = [];
  let headBytes = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > maxBytes) return cb(tooBig());
      if (headBytes < SNIFF_BYTES) {
        head.push(Buffer.from(chunk));
        headBytes += chunk.length;
      }
      cb(null, chunk);
    },
  });
  // pipeline listens for errors on every stream from the start (an asynchronous
  // write failure such as ENOSPC rejects here instead of crashing the server),
  // and on any failure destroys them all: the download is cancelled.
  const out = (opts.openFile ?? createWriteStream)(part);
  try {
    await pipeline(res.body, counter, out, { signal });
  } catch (e) {
    // Wait for the file to be let go of (it may still be opening), then remove it.
    out.destroy();
    await finished(out).catch(() => undefined);
    await unlink(part).catch(() => undefined);
    if (e instanceof ImportUrlError) throw e;
    throw new ImportUrlError(`The download was interrupted: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (bytes === 0) {
    await unlink(part).catch(() => undefined);
    throw new ImportUrlError('The downloaded file is empty.');
  }
  const first = Buffer.concat(head);
  let sniffed = sniffBytes(first);
  if (!sniffed) {
    await unlink(part).catch(() => undefined);
    throw new ImportUrlError('The downloaded file is not a supported image, SVG, audio or video file.');
  }
  // Probing and the final rename can fail too (ffprobe crash, ENOSPC, EACCES): the partial file never outlives a failed import.
  let media: MediaStreams | null;
  let file: string;
  let displayName: string;
  try {
    media = sniffed.kind === 'svg' ? null : await (opts.probe ?? probeStreams)(part);
    // An MP4/WebM without a picture is audio.
    if (sniffed.kind === 'video' && media && !media.video && media.audio) sniffed = { kind: 'audio', ext: sniffed.ext === 'webm' ? 'webm' : 'm4a', mimeType: sniffed.ext === 'webm' ? 'audio/webm' : 'audio/mp4' };
    file = `u_${id}.${sniffed.ext}`;
    // Named before the file moves into uploads: nothing after the rename can fail the import.
    displayName = name?.trim() || nameFromUrl(url, sniffed.ext);
    await (opts.renameFile ?? rename)(part, join(dir, file));
  } catch (e) {
    await unlink(part).catch(() => undefined);
    throw new ImportUrlError(`The downloaded file could not be saved: ${e instanceof Error ? e.message : String(e)}`);
  }
  const result: ImportUrlResponse = { src: `assets/uploads/${file}`, name: displayName, mimeType: sniffed.mimeType, kind: sniffed.kind, bytes };
  if (sniffed.kind === 'svg') {
    const dims = svgDimensions(first.toString('utf8'));
    if (dims.width) result.width = dims.width;
    if (dims.height) result.height = dims.height;
  } else if (sniffed.kind === 'image') {
    const w = sniffed.width ?? media?.video?.width;
    const h = sniffed.height ?? media?.video?.height;
    if (w) result.width = w;
    if (h) result.height = h;
  } else if (sniffed.kind === 'video') {
    if (media?.video) {
      result.width = media.video.width;
      result.height = media.video.height;
      if (media.video.fps) result.fps = media.video.fps;
    }
    if (media) result.hasAudio = media.audio;
    if (media?.durationSeconds) result.durationSeconds = media.durationSeconds;
  } else if (media?.durationSeconds) {
    result.durationSeconds = media.durationSeconds;
  }
  return result;
}
