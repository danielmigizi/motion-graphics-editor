import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createBrandKitStore } from './brand-kits';
import { scanBrand } from './brand-scan';
import type { Connect, DownloadResponse, Lookup } from './url-import';

const PUBLIC_IP = '93.184.216.34';
const HTML = Buffer.from(`<!doctype html><html><head>
  <title>Acme Solar</title>
  <link rel="stylesheet" href="/app.css">
  <link rel="apple-touch-icon" href="/icon.png">
  <style>:root { --bg: #f5f4f0; --primary: #58ad80; --text: #15171c; }</style>
</head><body><header><svg class="logo" xmlns="http://www.w3.org/2000/svg"><circle cx="2" cy="2" r="1"/></svg></header></body></html>`);
const CSS = Buffer.from('h1 { font-family: Inter, sans-serif; color: #0a1528; }');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');

function fakeNet(pages: Record<string, Buffer>): { lookup: Lookup; connect: Connect } {
  const lookup: Lookup = async () => [{ address: PUBLIC_IP, family: 4 }];
  const connect: Connect = async (url) => {
    const body = pages[url.pathname] ?? pages[url.href] ?? HTML;
    return { status: 200, headers: { 'content-length': String(body.length) }, body: Readable.from([body]) } satisfies DownloadResponse;
  };
  return { lookup, connect };
}

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'mge-brand-')); });
afterEach(() => rm(dir, { recursive: true, force: true }));

describe('scanBrand', () => {
  it('extracts a kit from mocked HTML/CSS, writes the inline SVG, and caches per domain', async () => {
    const net = fakeNet({ '/': HTML, '/about': HTML, '/app.css': CSS, '/icon.png': PNG });
    const first = await scanBrand(dir, 'https://www.acme.test/about', net);
    expect(first.cached).toBe(false);
    expect(first.domain).toBe('acme.test');
    expect(first.title).toBe('Acme Solar');
    expect(first.style.colors.accent).toBe('#4c9b71');
    expect(first.logo?.kind).toBe('inline-svg');
    expect(first.logoPath).toBe('assets/uploads/brand/acme.test/logo.svg');
    expect(await readFile(join(dir, first.logoPath!), 'utf8')).toContain('<circle');
    const second = await scanBrand(dir, 'https://acme.test/', net);
    expect(second.cached).toBe(true);
    expect(second.style).toEqual(first.style);
    expect(second.copy).toEqual(first.copy);
  });

  it('reads the page copy for cut cards, and rescans a cache from before copy was read', async () => {
    const net = fakeNet({ '/': HTML, '/app.css': CSS, '/icon.png': PNG });
    const kit = await scanBrand(dir, 'https://acme.test/', net);
    expect(kit.copy).toMatchObject({ domain: 'acme.test', product: 'Acme Solar' });
    const cache = join(dir, 'analysis', 'brand', 'acme.test', 'kit.json');
    const { copy: _copy, ...old } = JSON.parse(await readFile(cache, 'utf8'));
    await writeFile(cache, JSON.stringify(old));
    const again = await scanBrand(dir, 'https://acme.test/', net);
    expect(again.cached).toBe(false);
    expect(again.copy?.product).toBe('Acme Solar');
  });

  it('refuses http and invalid URLs', async () => {
    await expect(scanBrand(dir, 'http://acme.test')).rejects.toThrow(/https/);
    await expect(scanBrand(dir, 'not a url')).rejects.toThrow(/valid URL/);
  });
});

describe('brand kit store', () => {
  it('saves one kit per domain, replaces it on a rescan, and lists the newest first', async () => {
    const store = createBrandKitStore(join(dir, 'brand-kits'));
    expect(await store.list()).toEqual([]);
    const scan = await scanBrand(dir, 'https://acme.test/', fakeNet({ '/': HTML, '/app.css': CSS, '/icon.png': PNG }));
    const kit = await store.save(scan);
    expect(kit).toMatchObject({ id: 'kit_acme.test', name: 'Acme Solar', domain: 'acme.test', logoPath: 'assets/uploads/brand/acme.test/logo.svg' });
    expect(kit.style.colors.accent).toBe('#4c9b71');
    expect(await store.get('kit_acme.test')).toEqual(kit);
    const again = await store.save(scan);
    expect((await store.list()).map((k) => k.id)).toEqual(['kit_acme.test']);
    expect(again.savedAt >= kit.savedAt).toBe(true);
    expect(await store.get('../etc/passwd')).toBeNull();
  });
});
