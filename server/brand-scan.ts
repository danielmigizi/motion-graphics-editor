// Read-only brand scan: fetch a public https page and its CSS (no JS), extract
// colours / fonts / logo, cache per domain, and propose a style-pack overlay.
// Network goes through url-import's SSRF checks (timeouts, size caps, https only).

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { brandDomain, extractBrand, styleFromBrand, type BrandKit, type BrandLogo } from '../src/core/brand-kit';
import { extractSiteCopy, type SiteCopy } from '../src/core/siteCopy';
import { downloadBytes, ImportUrlError, type ImportOptions } from './url-import';

export const BRAND_HTML_LIMIT = 1_500_000;
export const BRAND_CSS_LIMIT = 400_000;
export const BRAND_LOGO_LIMIT = 2_000_000;
export const BRAND_CSS_MAX = 8;
export const BRAND_TIMEOUT_MS = 15_000;

export class BrandScanError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export interface BrandScanOptions extends ImportOptions {
  /** Skip the on-disk cache (tests). */
  refresh?: boolean;
}

export interface BrandScanResult extends BrandKit {
  /** Asset-root-relative path when the logo was written under public/. */
  logoPath?: string;
  /** The page's own copy (headline, value props, a stat, CTA) for filling cut cards. */
  copy?: SiteCopy;
  fetchedAt: number;
}

function cacheDir(publicDir: string, domain: string): string {
  return join(publicDir, 'analysis', 'brand', domain.replace(/[^a-z0-9.-]+/gi, '_'));
}

async function readCache(dir: string): Promise<BrandScanResult | null> {
  try {
    const raw = JSON.parse(await readFile(join(dir, 'kit.json'), 'utf8')) as BrandScanResult;
    // Scans cached before site copy was read are fetched again.
    return raw && raw.domain && raw.copy ? { ...raw, cached: true } : null;
  } catch {
    return null;
  }
}

async function writeCache(dir: string, kit: BrandScanResult): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'kit.json'), JSON.stringify({ ...kit, cached: true }, null, 2));
}

function isCss(contentType: string, href: string): boolean {
  return /text\/css|javascript|json/.test(contentType) ? /text\/css/.test(contentType) : /\.css(\?|$)/i.test(href) || /text\/plain/.test(contentType);
}

async function fetchCss(hrefs: string[], opts: BrandScanOptions): Promise<string> {
  const chunks: string[] = [];
  for (const href of hrefs.slice(0, BRAND_CSS_MAX)) {
    try {
      const file = await downloadBytes(href, { ...opts, maxBytes: BRAND_CSS_LIMIT, timeoutMs: opts.timeoutMs ?? 10_000 });
      if (!isCss(file.contentType, href) && !/[:{};]/.test(file.body.subarray(0, 200).toString('utf8'))) continue;
      chunks.push(file.body.toString('utf8'));
    } catch {
      // One missing stylesheet must not fail the scan.
    }
  }
  return chunks.join('\n');
}

function logoDir(publicDir: string, domain: string): string {
  return join(publicDir, 'assets', 'uploads', 'brand', domain.replace(/[^a-z0-9.-]+/gi, '_'));
}

function publicLogoPath(domain: string, name: string): string {
  return ['assets', 'uploads', 'brand', domain.replace(/[^a-z0-9.-]+/gi, '_'), name].join('/');
}

async function saveLogo(publicDir: string, domain: string, logo: BrandLogo | null, opts: BrandScanOptions): Promise<{ logo: BrandLogo | null; logoPath?: string }> {
  if (!logo) return { logo };
  const dir = logoDir(publicDir, domain);
  await mkdir(dir, { recursive: true });
  if (logo.svg) {
    await writeFile(join(dir, 'logo.svg'), logo.svg);
    return { logo, logoPath: publicLogoPath(domain, 'logo.svg') };
  }
  if (!logo.url) return { logo };
  try {
    const file = await downloadBytes(logo.url, { ...opts, maxBytes: BRAND_LOGO_LIMIT, timeoutMs: opts.timeoutMs ?? 10_000 });
    const ext = /\.svg(\?|$)/i.test(logo.url) || /svg/i.test(file.contentType) ? 'svg'
      : /\.png(\?|$)/i.test(logo.url) || /png/i.test(file.contentType) ? 'png'
      : /\.jpe?g(\?|$)/i.test(logo.url) || /jpeg/i.test(file.contentType) ? 'jpg'
      : /\.ico(\?|$)/i.test(logo.url) || /icon/i.test(file.contentType) ? 'ico'
      : 'bin';
    const name = `logo.${ext}`;
    await writeFile(join(dir, name), file.body);
    return { logo, logoPath: publicLogoPath(domain, name) };
  } catch {
    return { logo };
  }
}

/** Fetch `url`, extract a brand kit, cache under public/analysis/brand/<domain>/. */
export async function scanBrand(publicDir: string, rawUrl: string, opts: BrandScanOptions = {}): Promise<BrandScanResult> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BrandScanError('url is not a valid URL.');
  }
  if (url.protocol !== 'https:') throw new BrandScanError('Only https:// URLs can be scanned.');
  const domain = brandDomain(url.href);
  const dir = cacheDir(publicDir, domain);
  if (!opts.refresh) {
    const hit = await readCache(dir);
    if (hit) return hit;
  }
  let page;
  try {
    page = await downloadBytes(url.href, { ...opts, maxBytes: BRAND_HTML_LIMIT, timeoutMs: opts.timeoutMs ?? BRAND_TIMEOUT_MS });
  } catch (e) {
    throw new BrandScanError(e instanceof ImportUrlError || e instanceof Error ? e.message : String(e), e instanceof ImportUrlError ? 400 : 502);
  }
  const html = page.body.toString('utf8');
  if (!/<html|<!doctype|<head|<body/i.test(html) && html.length < 40) {
    throw new BrandScanError('The URL did not return an HTML page.');
  }
  const first = extractBrand(html, '', page.finalUrl);
  const css = await fetchCss(first.stylesheetHrefs, opts);
  const extracted = extractBrand(html, css, page.finalUrl);
  const saved = await saveLogo(publicDir, domain, extracted.logo, opts);
  const style = styleFromBrand(extracted, domain);
  const kit: BrandScanResult = {
    ...extracted,
    logo: saved.logo,
    ...(saved.logoPath ? { logoPath: saved.logoPath } : {}),
    domain,
    url: page.finalUrl,
    style,
    copy: extractSiteCopy(html, page.finalUrl),
    cached: false,
    fetchedAt: Date.now(),
  };
  await writeCache(dir, kit);
  return kit;
}
