import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { probeAsset, readAudioHeader, readImageHeader, resolvePublicPath, sniffAssetKind, storeUpload, svgDimensions } from './assets';

describe('sniffAssetKind', () => {
  it('maps extensions to kinds', () => {
    expect(sniffAssetKind(undefined, 'a.png')?.kind).toBe('image');
    expect(sniffAssetKind(undefined, 'a.JPG')).toMatchObject({ kind: 'image', ext: 'jpg', mimeType: 'image/jpeg' });
    expect(sniffAssetKind(undefined, 'a.jpeg')?.ext).toBe('jpg');
    expect(sniffAssetKind(undefined, 'a.webp')?.kind).toBe('image');
    expect(sniffAssetKind(undefined, 'a.gif')?.kind).toBe('image');
    expect(sniffAssetKind(undefined, 'logo.svg')).toMatchObject({ kind: 'svg', mimeType: 'image/svg+xml' });
    for (const ext of ['wav', 'mp3', 'm4a', 'aac', 'ogg']) expect(sniffAssetKind(undefined, `s.${ext}`)?.kind, ext).toBe('audio');
  });
  it('falls back to the mime type when the extension is missing or unknown', () => {
    expect(sniffAssetKind('image/png', 'blob')?.kind).toBe('image');
    expect(sniffAssetKind('audio/mpeg; charset=binary', undefined)?.ext).toBe('mp3');
    expect(sniffAssetKind('image/svg+xml', 'x.bin')?.kind).toBe('svg');
  });
  it('rejects unsupported types', () => {
    expect(sniffAssetKind('video/x-msvideo', 'clip.avi')).toBeNull();
    expect(sniffAssetKind('application/pdf', 'doc.pdf')).toBeNull();
    expect(sniffAssetKind(undefined, undefined)).toBeNull();
  });
});

describe('resolvePublicPath', () => {
  it('keeps paths inside public/', () => {
    expect(resolvePublicPath('/srv/public', 'assets/logo.svg')).toBe('/srv/public/assets/logo.svg');
    expect(resolvePublicPath('/srv/public', '/assets/logo.svg')).toBe('/srv/public/assets/logo.svg');
  });
  it('rejects escapes and non-local srcs', () => {
    expect(resolvePublicPath('/srv/public', '../secret')).toBeNull();
    expect(resolvePublicPath('/srv/public', 'assets/../../secret')).toBeNull();
    expect(resolvePublicPath('/srv/public', '')).toBeNull();
    expect(resolvePublicPath('/srv/public', 'https://x/y.png')).toBeNull();
  });
});

describe('svgDimensions', () => {
  it('reads width/height or viewBox', () => {
    expect(svgDimensions('<svg width="480" height="140px"></svg>')).toEqual({ width: 480, height: 140 });
    expect(svgDimensions('<svg viewBox="0 0 200 100"></svg>')).toEqual({ width: 200, height: 100 });
  });
});

// ---------------------------------------------------------------------------
// Header fixtures, built byte by byte
// ---------------------------------------------------------------------------

const u16be = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const u16le = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const u32be = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const u24le = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));

const png = (w: number, h: number) => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32be(13), ...ascii('IHDR'), ...u32be(w), ...u32be(h), 8, 6, 0, 0, 0, 0, 0, 0, 0]);
const jpeg = (w: number, h: number) =>
  Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, ...u16be(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, // APP0
    0xff, 0xff, // fill byte
    0xff, 0xdb, ...u16be(4), 0, 0, // DQT (stub)
    0xff, 0xc2, ...u16be(17), 8, ...u16be(h), ...u16be(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1, // SOF2 (progressive)
    0xff, 0xd9,
  ]);
const gif = (w: number, h: number) => Buffer.from([...ascii('GIF89a'), ...u16le(w), ...u16le(h), 0xf7, 0, 0]);
const riff = (chunk: string, body: number[]) => Buffer.from([...ascii('RIFF'), ...u32be(0), ...ascii('WEBP'), ...ascii(chunk), ...u32be(body.length).reverse(), ...body, 0, 0, 0, 0]);
const webpLossy = (w: number, h: number) => riff('VP8 ', [0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...u16le(w), ...u16le(h)]);
const webpLossless = (w: number, h: number) => {
  const bits = (w - 1) | ((h - 1) << 14);
  return riff('VP8L', [0x2f, bits & 0xff, (bits >> 8) & 0xff, (bits >> 16) & 0xff, (bits >>> 24) & 0xff]);
};
const webpExtended = (w: number, h: number) => riff('VP8X', [0x10, 0, 0, 0, ...u24le(w - 1), ...u24le(h - 1)]);

describe('readImageHeader', () => {
  it('reads PNG, JPEG (with fill bytes and a progressive SOF), GIF and every WebP flavour', () => {
    expect(readImageHeader(png(640, 480))).toEqual({ mimeType: 'image/png', width: 640, height: 480 });
    expect(readImageHeader(jpeg(400, 300))).toEqual({ mimeType: 'image/jpeg', width: 400, height: 300 });
    expect(readImageHeader(gif(32, 16))).toEqual({ mimeType: 'image/gif', width: 32, height: 16 });
    expect(readImageHeader(webpLossy(320, 200))).toEqual({ mimeType: 'image/webp', width: 320, height: 200 });
    expect(readImageHeader(webpLossless(100, 50))).toEqual({ mimeType: 'image/webp', width: 100, height: 50 });
    expect(readImageHeader(webpExtended(4000, 3000))).toEqual({ mimeType: 'image/webp', width: 4000, height: 3000 });
  });

  it('reads SVG size from width/height or the viewBox, after an XML prolog / BOM', () => {
    expect(readImageHeader(Buffer.from('\uFEFF<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 60"></svg>'))).toEqual({ mimeType: 'image/svg+xml', width: 120, height: 60 });
    expect(readImageHeader(Buffer.from('<svg width="10" height="20"/>'))).toEqual({ mimeType: 'image/svg+xml', width: 10, height: 20 });
    // No intrinsic size: still decodable (browsers use 300×150), size unknown.
    expect(readImageHeader(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'))).toEqual({ mimeType: 'image/svg+xml' });
  });

  it('explains files it cannot decode', () => {
    expect(readImageHeader(Buffer.alloc(0))).toEqual({ error: 'The file is empty' });
    expect(readImageHeader(Buffer.from('not really a png at all'))).toEqual({ error: 'Not a PNG, JPEG, GIF, WebP or SVG file' });
    expect(readImageHeader(Buffer.from('<html><body/></html>'))).toHaveProperty('error');
    expect(readImageHeader(png(640, 480).subarray(0, 20))).toHaveProperty('error');
    expect(readImageHeader(png(0, 480))).toHaveProperty('error');
    expect(readImageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xd9]))).toEqual({ error: expect.stringMatching(/no frame header/) });
    expect(readImageHeader(riff('ABCD', [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]))).toHaveProperty('error');
  });
});

describe('readAudioHeader', () => {
  it('recognises wav, mp3, ogg and mp4/aac containers', () => {
    expect(readAudioHeader(Buffer.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]))).toEqual({ mimeType: 'audio/wav' });
    expect(readAudioHeader(Buffer.from(ascii('ID3\x04')))).toEqual({ mimeType: 'audio/mpeg' });
    expect(readAudioHeader(Buffer.from([0xff, 0xfb, 0x90, 0x00]))).toEqual({ mimeType: 'audio/mpeg' });
    expect(readAudioHeader(Buffer.from(ascii('OggS\0')))).toEqual({ mimeType: 'audio/ogg' });
    expect(readAudioHeader(Buffer.from([0, 0, 0, 0x20, ...ascii('ftypM4A ')]))).toEqual({ mimeType: 'audio/mp4' });
    expect(readAudioHeader(Buffer.from([0xff, 0xf1, 0x50, 0x80]))).toEqual({ mimeType: 'audio/aac' });
    expect(readAudioHeader(Buffer.from('hello'))).toHaveProperty('error');
  });
});

describe('probeAsset', () => {
  it('reports existence, size, sniffed type and decodability; never leaves public/', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mge-probe-'));
    try {
      await mkdir(join(dir, 'assets'), { recursive: true });
      await writeFile(join(dir, 'assets', 'ok.png'), png(64, 32));
      await writeFile(join(dir, 'assets', 'really-a-jpeg.png'), jpeg(10, 20));
      await writeFile(join(dir, 'assets', 'broken.png'), Buffer.from('garbage bytes'));
      await writeFile(join(dir, 'assets', 'beep.wav'), Buffer.from([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WAVE')]));
      expect(await probeAsset(dir, 'assets/ok.png')).toEqual({ exists: true, bytes: png(64, 32).length, decodable: true, mimeType: 'image/png', width: 64, height: 32 });
      expect(await probeAsset(dir, 'assets/really-a-jpeg.png')).toMatchObject({ decodable: true, mimeType: 'image/jpeg', width: 10, height: 20 });
      expect(await probeAsset(dir, 'assets/broken.png')).toMatchObject({ exists: true, bytes: 13, decodable: false, error: expect.any(String) });
      expect(await probeAsset(dir, 'assets/beep.wav')).toMatchObject({ exists: true, decodable: true, mimeType: 'audio/wav' });
      expect(await probeAsset(dir, 'assets/nope.png')).toEqual({ exists: false, decodable: false, error: 'File not found: public/assets/nope.png' });
      expect(await probeAsset(dir, 'assets')).toMatchObject({ exists: false, decodable: false });
      expect(await probeAsset(dir, '../etc/passwd')).toMatchObject({ exists: false, decodable: false, error: 'Not a path inside public/' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('upload contents must match the claimed image kind', () => {
  it('refuses text and mismatched formats before storing them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mge-upload-types-'));
    try {
      for (const ext of ['png', 'jpg', 'webp', 'gif', 'svg', 'mp3', 'wav', 'm4a', 'aac', 'ogg']) {
        await expect(storeUpload(dir, `fake.${ext}`, undefined, Buffer.from('plain text'))).rejects.toThrow("The file's contents don't match its type.");
      }
      for (const [name, bytes] of [['fake.png', jpeg(10, 20)], ['fake.jpg', png(10, 20)],
        ['fake.webp', gif(10, 20)], ['fake.gif', png(10, 20)], ['fake.svg', png(10, 20)]] as const) {
        await expect(storeUpload(dir, name, undefined, bytes)).rejects.toThrow("The file's contents don't match its type.");
      }
      for (const text of ['<html><svg/></html>', 'prefix <svg/>', '<!-- <svg/> -->plain text', '<svgish/>']) {
        await expect(storeUpload(dir, 'fake.svg', undefined, Buffer.from(text))).rejects.toThrow("The file's contents don't match its type.");
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('accepts an SVG root after a BOM, XML declaration, comments and doctype', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mge-upload-svg-'));
    try {
      const xml = '\uFEFF<?xml version="1.0"?>\n<!-- logo -->\n<!DOCTYPE svg [<!ENTITY title "Logo">]>\n<!-- start --><svg width="10" height="20"/>';
      expect(await storeUpload(dir, 'logo.svg', undefined, Buffer.from(xml))).toMatchObject({ kind: 'svg', width: 10, height: 20 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
