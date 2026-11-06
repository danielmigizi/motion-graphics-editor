// Importing generated media from an https URL: https only, no private hosts
// (by name, by literal address or by any resolved address, on every redirect
// hop, checked before connecting, connection pinned to the checked address),
// size cap (declared and streamed), kind sniffed from the bytes, and write
// failures that reject instead of crashing the server.

import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { checkImportUrl, connectPinned, downloadBytes, importFromUrl, isPublicAddress, pinnedLookup, resolvePublicAddress, sniffBytes, type Connect, type DownloadResponse, type Lookup, type MediaStreams } from './url-import';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="180"><rect width="320" height="180"/></svg>');
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(64)]);
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypM4A '), Buffer.alloc(64)]);

const PUBLIC_IP = '93.184.216.34';

/** A body served in chunks; `cancelled()` is true when it was destroyed before the end. */
function bodyOf(content: Buffer, chunk = 16, endless = false): Readable & { cancelled: () => boolean } {
  let i = 0;
  const r = new Readable({
    read() {
      if (!endless && i >= content.length) return void this.push(null);
      this.push(endless ? content : content.subarray(i, i + chunk));
      i += endless ? content.length : chunk;
    },
  });
  return Object.assign(r, { cancelled: () => r.destroyed && (endless || i < content.length) });
}

interface Served { status?: number; body?: Buffer; location?: string; contentLength?: number | null; chunk?: number; endless?: boolean }

/**
 * Fake DNS + pinned connections. `serve(url)` answers each request; `addresses`
 * maps host names to what they resolve to (default: one public address).
 */
function fakeNet(serve: (url: string) => Served, addresses: Record<string, string[]> = {}) {
  const calls: { url: string; address: string }[] = [];
  const lookups: string[] = [];
  const bodies: ReturnType<typeof bodyOf>[] = [];
  const lookup: Lookup = async (host) => {
    lookups.push(host);
    return (addresses[host] ?? [PUBLIC_IP]).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
  const connect: Connect = async (url, address) => {
    calls.push({ url: url.href, address: address.address });
    const s = serve(url.href);
    const content = s.body ?? Buffer.alloc(0);
    const body = bodyOf(content, s.chunk, s.endless);
    bodies.push(body);
    const headers: DownloadResponse['headers'] = {};
    if (s.location) headers.location = s.location;
    if (s.contentLength !== null && !s.endless) headers['content-length'] = String(s.contentLength ?? content.length);
    return { status: s.status ?? 200, headers, body };
  };
  return { lookup, connect, calls, lookups, bodies };
}

/** Any URL answers `body`. */
const serving = (body: Buffer, s: Omit<Served, 'body'> = {}) => fakeNet(() => ({ ...s, body }));

const probeAs = (m: MediaStreams | null) => async () => m;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'mge-url-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));
const uploads = () => readdir(join(dir, 'assets', 'uploads')).catch(() => [] as string[]);

describe('URL and address checks', () => {
  it('accepts https to public hosts only', () => {
    expect(checkImportUrl('https://example-deployment-123.eu-west-1.convex.cloud/api/storage/abc').hostname).toBe('example-deployment-123.eu-west-1.convex.cloud');
    for (const bad of [
      'http://example.com/a.png', 'file:///etc/passwd', 'ftp://example.com/a', 'https://localhost/a.png', 'https://127.0.0.1/a', 'https://10.0.0.2/a',
      'https://192.168.1.5/a', 'https://172.20.0.1/a', 'https://169.254.169.254/latest', 'https://[::1]/a', 'https://user:pw@example.com/a', 'not a url',
      // Literal forms the URL parser normalises, IPv4-mapped / NAT64 IPv6, ULA, link-local, CGNAT, multicast.
      'https://2130706433/a', 'https://0x7f.1/a', 'https://[::ffff:127.0.0.1]/a', 'https://[::ffff:a00:1]/a', 'https://[64:ff9b::a9fe:a9fe]/a',
      'https://[fd12::1]/a', 'https://[fe80::1]/a', 'https://100.64.0.1/a', 'https://224.0.0.1/a', 'https://0.0.0.0/a',
    ]) {
      expect(() => checkImportUrl(bad), bad).toThrow();
    }
    expect(checkImportUrl('https://8.8.8.8/a').hostname).toBe('8.8.8.8');
    expect(checkImportUrl('https://[2606:4700::1111]/a').hostname).toBe('[2606:4700::1111]');
  });

  it('classifies addresses: only public unicast passes', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '1.1.1.1', '2606:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '172.15.255.255', '172.32.0.1', '100.63.255.255']) {
      expect(isPublicAddress(ip), ip).toBe(true);
    }
    for (const ip of [
      '127.0.0.1', '127.255.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0',
      '192.0.0.8', '192.0.2.1', '198.18.0.1', '198.51.100.1', '203.0.113.9', '224.0.0.251', '239.255.255.250', '240.0.0.1', '255.255.255.255',
      '::', '::1', '::127.0.0.1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:10.0.0.1', '::ffff:169.254.169.254', '64:ff9b::7f00:1', '64:ff9b:1::1',
      'fc00::1', 'fd00:ec2::254', 'fe80::1', 'fec0::1', 'ff02::1', '100::1', '2001::1', '2001:db8::1', '2002:7f00:1::1', 'fe80::1%eth0', 'example.com', '',
    ]) {
      expect(isPublicAddress(ip), ip).toBe(false);
    }
  });

  it('refuses a host name when any of its addresses is private', async () => {
    const lookup = (map: Record<string, string[]>): Lookup => async (h) => (map[h] ?? []).map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
    await expect(resolvePublicAddress(new URL('https://cdn.example.com/a'), lookup({ 'cdn.example.com': [PUBLIC_IP] }))).resolves.toEqual({ address: PUBLIC_IP, family: 4 });
    for (const bad of [['127.0.0.1'], ['10.0.0.5'], [PUBLIC_IP, '192.168.1.1'], ['::1'], ['::ffff:127.0.0.1'], ['fd00::5']]) {
      await expect(resolvePublicAddress(new URL('https://rebind.example.com/a'), lookup({ 'rebind.example.com': bad })), bad.join()).rejects.toThrow(/private network/);
    }
    await expect(resolvePublicAddress(new URL('https://nx.example.com/a'), lookup({}))).rejects.toThrow(/could not be resolved/);
  });
});

describe('sniffing', () => {
  it('reads the kind from bytes', () => {
    expect(sniffBytes(PNG)).toMatchObject({ kind: 'image', ext: 'png', width: 1, height: 1 });
    expect(sniffBytes(MP3)).toMatchObject({ kind: 'audio', ext: 'mp3' });
    expect(sniffBytes(SVG)).toMatchObject({ kind: 'svg', ext: 'svg', width: 320, height: 180 });
    expect(sniffBytes(MP4)).toMatchObject({ kind: 'video', ext: 'mp4' });
    expect(sniffBytes(M4A)).toMatchObject({ kind: 'audio', ext: 'm4a' });
    expect(sniffBytes(Buffer.from('<html><body>signed url expired</body></html>'))).toBeNull();
    expect(sniffBytes(Buffer.from('%PDF-1.7'))).toBeNull();
  });
});

describe('downloadBytes', () => {
  it('buffers a public https body with the final URL', async () => {
    const html = Buffer.from('<!doctype html><title>Hi</title>');
    const n = serving(html);
    const r = await downloadBytes('https://cdn.example.com/page', { ...n, timeoutMs: 2000 });
    expect(r).toMatchObject({ finalUrl: 'https://cdn.example.com/page', status: 200 });
    expect(r.body.toString()).toContain('<title>Hi</title>');
  });
});

describe('importFromUrl', () => {
  it('streams an image into uploads, trusting the bytes over the URL, pinned to the resolved address', async () => {
    const n = serving(PNG);
    const r = await importFromUrl(dir, 'https://cdn.example.com/media/take-1.mp3?sig=abc', undefined, { ...n, probe: probeAs(null) });
    expect(r).toMatchObject({ kind: 'image', mimeType: 'image/png', width: 1, height: 1, bytes: PNG.length, name: 'take-1.mp3' });
    expect(r.src).toMatch(/^assets\/uploads\/u_[0-9a-f]{12}\.png$/);
    expect(await readFile(join(dir, r.src))).toEqual(PNG);
    expect(await uploads()).toEqual([r.src.split('/').pop()]);
    expect(n.calls).toEqual([{ url: 'https://cdn.example.com/media/take-1.mp3?sig=abc', address: PUBLIC_IP }]);
  });

  it('uses the given name, and a generic one for opaque storage ids', async () => {
    expect((await importFromUrl(dir, 'https://x.convex.cloud/api/storage/d139c4bc-cf6f-4a9b-8fef-8d5dd4b35529', 'Hero take', { ...serving(PNG), probe: probeAs(null) })).name).toBe('Hero take');
    expect((await importFromUrl(dir, 'https://x.convex.cloud/api/storage/d139c4bc-cf6f-4a9b-8fef-8d5dd4b35529', undefined, { ...serving(PNG), probe: probeAs(null) })).name).toBe('generated.png');
  });

  it('imports video with its size, fps, duration and sound, and audio-only MP4 as audio', async () => {
    const v = await importFromUrl(dir, 'https://cdn.example.com/b-roll.mp4', undefined, { ...serving(MP4), probe: probeAs({ video: { width: 1280, height: 720, fps: 24 }, audio: false, durationSeconds: 5 }) });
    expect(v).toMatchObject({ kind: 'video', mimeType: 'video/mp4', width: 1280, height: 720, fps: 24, durationSeconds: 5, hasAudio: false });
    const a = await importFromUrl(dir, 'https://cdn.example.com/vo.mp4', undefined, { ...serving(MP4), probe: probeAs({ audio: true, durationSeconds: 3.5 }) });
    expect(a).toMatchObject({ kind: 'audio', mimeType: 'audio/mp4', durationSeconds: 3.5 });
    expect(a.src).toMatch(/\.m4a$/);
    const mp3 = await importFromUrl(dir, 'https://cdn.example.com/vo', undefined, { ...serving(MP3), probe: probeAs({ audio: true, durationSeconds: 2 }) });
    expect(mp3).toMatchObject({ kind: 'audio', mimeType: 'audio/mpeg', durationSeconds: 2 });
  });

  it('refuses files over the cap, declared or streamed, cancels the download and leaves nothing behind', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(4096)]);
    const declared = serving(big);
    await expect(importFromUrl(dir, 'https://cdn.example.com/a.png', undefined, { ...declared, maxBytes: 1024 })).rejects.toThrow(/limit is/);
    expect(declared.bodies[0].cancelled()).toBe(true);
    // An endless body without Content-Length: only cancelling it ends the download.
    const streamed = serving(PNG, { endless: true });
    await expect(importFromUrl(dir, 'https://cdn.example.com/a.png', undefined, { ...streamed, maxBytes: 1024 })).rejects.toThrow(/larger than/);
    expect(streamed.bodies[0].cancelled()).toBe(true);
    expect(await uploads()).toEqual([]);
  });

  it('refuses unsupported bytes, HTTP errors, empty bodies and plain http (without resolving or connecting)', async () => {
    await expect(importFromUrl(dir, 'https://cdn.example.com/a.png', undefined, serving(Buffer.from('<html>expired</html>')))).rejects.toThrow(/not a supported/);
    await expect(importFromUrl(dir, 'https://cdn.example.com/a.png', undefined, serving(PNG, { status: 403 }))).rejects.toThrow(/HTTP 403/);
    await expect(importFromUrl(dir, 'https://cdn.example.com/a.png', undefined, serving(Buffer.alloc(0)))).rejects.toThrow(/empty/);
    const never = serving(PNG);
    await expect(importFromUrl(dir, 'http://cdn.example.com/a.png', undefined, never)).rejects.toThrow(/https/);
    expect(never.calls).toEqual([]);
    expect(never.lookups).toEqual([]);
    expect(await uploads()).toEqual([]);
  });

  it('refuses a host that resolves to a private address before connecting (DNS)', async () => {
    const n = fakeNet(() => ({ body: PNG }), { 'internal.example.com': ['10.0.0.7'], 'mixed.example.com': [PUBLIC_IP, '127.0.0.1'] });
    await expect(importFromUrl(dir, 'https://internal.example.com/a.png', undefined, n)).rejects.toThrow(/private network/);
    await expect(importFromUrl(dir, 'https://mixed.example.com/a.png', undefined, n)).rejects.toThrow(/private network/);
    expect(n.calls).toEqual([]);
  });

  it('checks every redirect before following it: no request ever reaches a private or non-https destination', async () => {
    for (const location of ['http://127.0.0.1:5318/api/projects', 'https://127.0.0.1:5318/x', 'https://[::ffff:127.0.0.1]/x', 'https://internal.example.com/x', 'http://cdn.example.com/a.png', 'https://u:p@cdn.example.com/a.png']) {
      const n = fakeNet((url) => (url === 'https://cdn.example.com/a.png' ? { status: 302, location } : { body: PNG }), { 'internal.example.com': ['169.254.169.254'] });
      await expect(importFromUrl(dir, 'https://cdn.example.com/a.png', undefined, n), location).rejects.toThrow(/private network|https|credentials/);
      expect(n.calls.map((c) => c.url), location).toEqual(['https://cdn.example.com/a.png']);
      expect(n.bodies[0].destroyed).toBe(true);
    }
    expect(await uploads()).toEqual([]);
  });

  it('follows public redirects (relative ones too), each pinned to its own checked address, at most 5', async () => {
    const routes: Record<string, Served> = {
      'https://cdn.example.com/a.png': { status: 301, location: 'https://media.example.net/v1/a.png' },
      'https://media.example.net/v1/a.png': { status: 307, location: '../signed/a.png?sig=1' },
      'https://media.example.net/signed/a.png?sig=1': { body: PNG },
    };
    const n = fakeNet((url) => routes[url] ?? { status: 404 }, { 'media.example.net': ['8.8.4.4'] });
    const r = await importFromUrl(dir, 'https://cdn.example.com/a.png', undefined, { ...n, probe: probeAs(null) });
    expect(r).toMatchObject({ kind: 'image', name: 'a.png' });
    expect(n.calls).toEqual([
      { url: 'https://cdn.example.com/a.png', address: PUBLIC_IP },
      { url: 'https://media.example.net/v1/a.png', address: '8.8.4.4' },
      { url: 'https://media.example.net/signed/a.png?sig=1', address: '8.8.4.4' },
    ]);
    let hop = 0;
    const loop = fakeNet(() => ({ status: 302, location: `/r${++hop}` }));
    await expect(importFromUrl(dir, 'https://cdn.example.com/r0', undefined, loop)).rejects.toThrow(/redirected more than 5 times/);
    expect(loop.calls).toHaveLength(6);
  });

  it('a failing disk write rejects (no uncaught exception), cancels the download and removes the partial file', async () => {
    const full = serving(PNG, { endless: true });
    await expect(importFromUrl(dir, 'https://cdn.example.com/a.png', undefined, { ...full, openFile: () => new Writable({ write(_chunk, _encoding, done) { done(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })); } }) })).rejects.toThrow(/interrupted: .*ENOSPC/);
    expect(full.bodies[0].cancelled()).toBe(true);
    const failOpen = serving(PNG, { endless: true });
    await expect(importFromUrl(dir, 'https://cdn.example.com/a.png', undefined, { ...failOpen, openFile: () => createWriteStream(join(dir, 'no', 'such', 'dir', 'x.part')) })).rejects.toThrow(/interrupted: .*ENOENT/);
    expect(failOpen.bodies[0].cancelled()).toBe(true);
    expect(await uploads()).toEqual([]);
  });

  // A malformed percent-escape in the URL's file name never fails the import or leaves a file behind.
  it('names a file whose URL segment does not decode from the raw segment', async () => {
    const r = await importFromUrl(dir, 'https://cdn.example.com/take%E0%A4%A.png', undefined, { ...serving(PNG), probe: probeAs(null) });
    expect(r.name).toBe('takeE0A4A.png');
    expect(await uploads()).toEqual([r.src.split('/').pop()]);
    expect((await importFromUrl(dir, 'https://cdn.example.com/hero%20take.png', undefined, { ...serving(PNG), probe: probeAs(null) })).name).toBe('hero take.png');
  });

  // A failure after the download (probing, the final rename) removes the partial file too.
  it('a failing final rename or probe rejects and removes the partial file', async () => {
    const enospc = Object.assign(new Error('ENOSPC: no space left on device, rename'), { code: 'ENOSPC' });
    await expect(importFromUrl(dir, 'https://cdn.example.com/logo.svg', undefined, { ...serving(SVG), renameFile: async () => { throw enospc; } })).rejects.toThrow(/could not be saved: .*ENOSPC/);
    expect(await uploads()).toEqual([]);
    const eacces = Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' });
    await expect(importFromUrl(dir, 'https://cdn.example.com/a.png', undefined, { ...serving(PNG), probe: probeAs(null), renameFile: async () => { throw eacces; } })).rejects.toThrow(/EACCES/);
    expect(await uploads()).toEqual([]);
    await expect(importFromUrl(dir, 'https://cdn.example.com/a.mp4', undefined, { ...serving(MP4), probe: async () => { throw new Error('probe crashed'); } })).rejects.toThrow(/probe crashed/);
    expect(await uploads()).toEqual([]);
  });
});

// The default connection: TLS verified against the URL's host name, socket pinned to the checked address (no DNS).
describe('connectPinned', () => {
  let server: Server | null = null;
  let port = 0;
  let cert: Buffer;
  const seen: string[] = [];
  let certDir = '';

  beforeAll(async () => {
    certDir = await mkdtemp(join(tmpdir(), 'mge-tls-'));
    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(certDir, 'key.pem'), '-out', join(certDir, 'cert.pem'), '-days', '1', '-subj', '/CN=media.mge-test.invalid', '-addext', 'subjectAltName=DNS:media.mge-test.invalid'], { stdio: 'ignore' });
    } catch {
      return;
    }
    cert = await readFile(join(certDir, 'cert.pem'));
    server = createServer({ key: await readFile(join(certDir, 'key.pem')), cert }, (req, res) => {
      seen.push(`${req.headers.host} ${req.url}`);
      if (req.url === '/redirect') {
        res.writeHead(302, { location: 'https://127.0.0.1/secret' });
        return void res.end();
      }
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(PNG.length) });
      res.end(PNG);
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => {
    if (server) await new Promise<void>((r) => server!.close(() => r()));
    await rm(certDir, { recursive: true, force: true });
  });

  it('connects to the pinned address with the URL host name for TLS, and never follows redirects itself', async (ctx) => {
    if (!server) return ctx.skip();
    // media.mge-test.invalid resolves nowhere: the request can only reach the server through the pinned address.
    const pin = { address: '127.0.0.1', family: 4 as const };
    const res = await connectPinned(new URL(`https://media.mge-test.invalid:${port}/a.png`), pin, AbortSignal.timeout(5000), { ca: cert });
    expect(res.status).toBe(200);
    const chunks: Buffer[] = [];
    for await (const c of res.body) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks)).toEqual(PNG);
    const redirect = await connectPinned(new URL(`https://media.mge-test.invalid:${port}/redirect`), pin, AbortSignal.timeout(5000), { ca: cert });
    expect(redirect).toMatchObject({ status: 302, headers: { location: 'https://127.0.0.1/secret' } });
    redirect.body.destroy();
    expect(seen).toEqual([`media.mge-test.invalid:${port} /a.png`, `media.mge-test.invalid:${port} /redirect`]);
    // Without the CA the certificate is still verified (no silent downgrade).
    await expect(connectPinned(new URL(`https://media.mge-test.invalid:${port}/a.png`), pin, AbortSignal.timeout(5000))).rejects.toThrow(/self[- ]signed|certificate/i);
  });

  it('pinnedLookup answers only the checked address, in both callback forms', () => {
    const lookup = pinnedLookup({ address: '8.8.8.8', family: 4 }) as unknown as (h: string, o: { all?: boolean }, cb: (...a: unknown[]) => void) => void;
    const answers: unknown[][] = [];
    lookup('evil.example', {}, (...a) => answers.push(a));
    lookup('evil.example', { all: true }, (...a) => answers.push(a));
    expect(answers).toEqual([[null, '8.8.8.8', 4], [null, [{ address: '8.8.8.8', family: 4 }]]]);
  });
});
