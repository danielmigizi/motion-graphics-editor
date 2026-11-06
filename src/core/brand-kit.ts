// Brand-kit extraction from fetched HTML + CSS (no JS). Pure and deterministic:
// same markup → same colours, fonts, logo cascade and proposed style overlay.

import { FONT_FAMILIES } from './components';
import { STYLE_PACKS, type StylePackId } from './style';
import type { Command, StylePack } from './types';

export const BRAND_LOGO_KINDS = ['inline-svg', 'apple-touch-icon', 'og-image', 'favicon'] as const;
export type BrandLogoKind = (typeof BRAND_LOGO_KINDS)[number];

export type BrandColorSource = 'css-variable' | 'declaration' | 'meta-theme';
export type BrandFontAvailability = 'bundled' | 'system' | 'webfont-licensable' | 'unknown';

export interface BrandColor {
  hex: string;
  role?: 'background' | 'surface' | 'text' | 'muted' | 'accent' | 'accent2';
  source: BrandColorSource;
  /** CSS custom-property name, without the leading --. */
  name?: string;
  rank: number;
  count: number;
}

export interface BrandFont {
  family: string;
  weights: number[];
  role?: 'heading' | 'body' | 'mono';
  availability: BrandFontAvailability;
  /** Bundled family the renderer will actually paint. */
  fallback: string;
  source: string;
}

export interface BrandLogo {
  kind: BrandLogoKind;
  /** Absolute URL when the logo is a linked file. */
  url?: string;
  /** Inline SVG markup (never redrawn). */
  svg?: string;
}

export interface BrandExtract {
  title?: string;
  stylesheetHrefs: string[];
  colors: BrandColor[];
  fonts: BrandFont[];
  logo: BrandLogo | null;
  /**
   * The page's own background, from the strongest signal the markup gives: a
   * html/body/:root background rule, then a neutral theme-color, then the
   * darkest declared background when the page says it is dark.
   */
  plate?: { hex: string; source: 'page-rule' | 'meta-theme' | 'dark-scheme' };
}

export interface BrandKit extends BrandExtract {
  domain: string;
  url: string;
  /** Style pack overlay: closest shipped pack with extracted colours/fonts. */
  style: StylePack;
  cached: boolean;
}

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff',
  yellow: '#ffff00', orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', gray: '#808080',
  grey: '#808080', navy: '#000080', teal: '#008080', silver: '#c0c0c8', maroon: '#800000',
  olive: '#808000', lime: '#00ff00', aqua: '#00ffff', cyan: '#00ffff', fuchsia: '#ff00ff',
  magenta: '#ff00ff', indigo: '#4b0082', violet: '#ee82ee', brown: '#a52a2a',
  transparent: '', inherit: '', currentcolor: '', none: '',
};

const ROLE_VARS: Record<string, NonNullable<BrandColor['role']>> = {
  background: 'background', bg: 'background', 'page-bg': 'background', canvas: 'background',
  surface: 'surface', card: 'surface', panel: 'surface', paper: 'surface',
  text: 'text', fg: 'text', foreground: 'text', ink: 'text', 'body-color': 'text',
  muted: 'muted', secondary: 'muted', subtle: 'muted',
  accent: 'accent', primary: 'accent', brand: 'accent', 'brand-primary': 'accent',
  accent2: 'accent2', tertiary: 'accent2', 'brand-secondary': 'accent2',
};

/** Bundled monospace families: code and annotations, never a headline or body face. */
const isMonoFace = (family: string | undefined) => family === 'IBM Plex Mono' || family === 'Geist Mono';

const SYSTEM_FONTS = new Set([
  'system-ui', '-apple-system', 'blinkmacsystemfont', 'segoe ui', 'roboto', 'helvetica neue',
  'helvetica', 'arial', 'ui-sans-serif', 'ui-serif', 'ui-monospace', 'sans-serif', 'serif',
  'monospace', 'georgia', 'times new roman', 'times', 'courier new', 'menlo', 'monaco',
  'consolas', 'apple color emoji', 'segoe ui emoji',
]);

const WEBFONT_HINT = /google|gstatic|typekit|adobe|fontshare|fontsource|bunny|jsdelivr|unpkg|cdnfonts/i;
const LOGO_NAME = /logo|wordmark|brandmark|masthead/i;

export function brandDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    return url.replace(/^https?:\/\//i, '').split('/')[0]?.replace(/^www\./i, '').toLowerCase() || 'unknown';
  }
}

/** Expand #RGB / #RRGGBB / #RRGGBBAA and a few rgb()/hsl()/named colours to #RRGGBB. */
export function normalizeHex(raw: string): string | null {
  const s = raw.trim().toLowerCase();
  if (!s) return null;
  const named = NAMED[s];
  if (named !== undefined) return named || null;
  const hex = s.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const h = hex[1];
    if (h.length === 3 || h.length === 4) return `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
    if (h.length === 6 || h.length === 8) return `#${h.slice(0, 6)}`;
    return null;
  }
  const rgb = s.match(/^rgba?\(\s*([\d.]+)(%?)\s*[, ]\s*([\d.]+)(%?)\s*[, ]\s*([\d.]+)(%?)/);
  if (rgb) {
    const ch = (v: string, pct: string) => Math.max(0, Math.min(255, Math.round(pct ? (Number(v) / 100) * 255 : Number(v))));
    return toHex(ch(rgb[1], rgb[2]), ch(rgb[3], rgb[4]), ch(rgb[5], rgb[6]));
  }
  const hsl = s.match(/^hsla?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)%\s*[, ]\s*([\d.]+)%/);
  if (hsl) return hslToHex(Number(hsl[1]), Number(hsl[2]), Number(hsl[3]));
  return null;
}

function toHex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

function hslToHex(h: number, s: number, l: number): string {
  const S = s / 100;
  const L = l / 100;
  const a = S * Math.min(L, 1 - L);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return L - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return toHex(Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255));
}

export function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const lin = (v: number) => {
    const x = v / 255;
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
}

function parseAttr(tag: string, name: string): string | undefined {
  const m = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m?.[1] ?? m?.[2] ?? m?.[3];
}

function relOf(tag: string): string {
  return (parseAttr(tag, 'rel') ?? '').toLowerCase();
}

/** Stylesheet hrefs in document order (absolute against `pageUrl`). */
export function stylesheetHrefs(html: string, pageUrl: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (href: string | undefined) => {
    if (!href) return;
    try {
      const abs = new URL(href, pageUrl).href;
      if (seen.has(abs)) return;
      seen.add(abs);
      out.push(abs);
    } catch {
      // skip
    }
  };
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = relOf(tag);
    if (rel.includes('stylesheet') || rel === 'preload' && (parseAttr(tag, 'as') ?? '').toLowerCase() === 'style') add(parseAttr(tag, 'href'));
  }
  for (const m of html.matchAll(/@import\s+(?:url\()?['"]?([^'")\s]+)['"]?\)?/gi)) add(m[1]);
  return out;
}

function collectStyleBlocks(html: string): string {
  return [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
}

function collectInlineStyles(html: string): string {
  return [...html.matchAll(/\bstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)].map((m) => m[1] ?? m[2] ?? '').join(';');
}

function varRole(name: string): NonNullable<BrandColor['role']> | undefined {
  const n = name.toLowerCase().replace(/^-+/, '');
  for (const [key, role] of Object.entries(ROLE_VARS)) {
    if (n === key || n.endsWith(`-${key}`) || n.startsWith(`${key}-`) || n.includes(`-${key}-`)) return role;
  }
  return undefined;
}

interface ColorHit { hex: string; source: BrandColorSource; name?: string; role?: BrandColor['role'] }

function pushColor(hits: ColorHit[], raw: string, source: BrandColorSource, name?: string, role?: BrandColor['role']) {
  const hex = normalizeHex(raw);
  if (!hex || hex === '#000000' && /transparent|none/i.test(raw)) return;
  hits.push({ hex, source, name, role: role ?? (name ? varRole(name) : undefined) });
}

function extractCssColors(css: string): ColorHit[] {
  const hits: ColorHit[] = [];
  for (const m of css.matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*([^;!}{]+)/g)) {
    pushColor(hits, m[2].trim(), 'css-variable', m[1]);
  }
  for (const m of css.matchAll(/(?:^|[;{\s])((?:background(?:-color)?|color|border-color|outline-color|fill|stroke))\s*:\s*([^;!}{]+)/gi)) {
    const role = /background/i.test(m[1]) ? 'background' : /^color$/i.test(m[1]) ? 'text' : undefined;
    // Skip url() backgrounds; take the last colour token in the value.
    const tokens = m[2].split(/(?=#)|(?=rgb)|(?=hsl)|(?=\b(?:black|white|red|navy|teal|gray|grey)\b)/i).map((t) => t.trim()).filter(Boolean);
    const last = tokens.at(-1);
    if (last && !/url\(/i.test(last)) pushColor(hits, last.replace(/!important/i, '').trim(), 'declaration', undefined, role);
  }
  return hits;
}

function rankColors(hits: ColorHit[]): BrandColor[] {
  const by = new Map<string, BrandColor>();
  for (const h of hits) {
    const key = h.hex;
    const cur = by.get(key);
    const roleBoost = h.role ? 8 : 0;
    const varBoost = h.source === 'css-variable' ? 6 : h.source === 'meta-theme' ? 4 : 0;
    if (!cur) {
      by.set(key, { hex: key, source: h.source, name: h.name, role: h.role, count: 1, rank: 1 + roleBoost + varBoost });
      continue;
    }
    cur.count += 1;
    cur.rank += 1 + roleBoost + varBoost;
    if (!cur.role && h.role) cur.role = h.role;
    if (!cur.name && h.name) cur.name = h.name;
    if (h.source === 'css-variable' && cur.source !== 'css-variable') cur.source = 'css-variable';
  }
  return [...by.values()].sort((a, b) => b.rank - a.rank || b.count - a.count || a.hex.localeCompare(b.hex));
}

function fontStack(value: string): string[] {
  return value.split(',').map((p) => p.trim().replace(/^['"]|['"]$/g, '')).filter((p) => p && p !== 'inherit');
}

export function classifyFont(family: string): { availability: BrandFontAvailability; fallback: string } {
  const lower = family.toLowerCase();
  const bundled = FONT_FAMILIES.find((f) => f.toLowerCase() === lower);
  if (bundled) return { availability: 'bundled', fallback: bundled };
  if (SYSTEM_FONTS.has(lower)) {
    if (/mono|consolas|menlo|monaco|courier/.test(lower)) return { availability: 'system', fallback: 'IBM Plex Mono' };
    if (/serif|georgia|times/.test(lower) && !/sans/.test(lower)) return { availability: 'system', fallback: 'Fraunces' };
    return { availability: 'system', fallback: 'Inter' };
  }
  if (/mono|code|console/.test(lower)) return { availability: 'unknown', fallback: 'IBM Plex Mono' };
  if (/serif|fraunces|playfair|garamond|bodoni/.test(lower) && !/sans/.test(lower)) return { availability: 'unknown', fallback: 'Fraunces' };
  if (/grotesk|poppins|montserrat|geist|display/.test(lower)) return { availability: 'unknown', fallback: 'Space Grotesk' };
  return { availability: 'unknown', fallback: 'Inter' };
}

function extractFonts(css: string, html: string): BrandFont[] {
  const by = new Map<string, BrandFont>();
  const add = (family: string, weight: number | undefined, source: string, webfont: boolean) => {
    const name = family.trim();
    // An unresolved var(--x) is not a family name.
    if (/^var\(/i.test(name)) return;
    if (!name || SYSTEM_FONTS.has(name.toLowerCase()) && !/^(?:system-ui|ui-monospace)$/i.test(name)) {
      // Keep the first real family; skip generic fallbacks unless that is all we have.
      if (by.size) return;
    }
    const { availability, fallback } = classifyFont(name);
    const avail: BrandFontAvailability = availability === 'unknown' && webfont ? 'webfont-licensable' : availability;
    const cur = by.get(name.toLowerCase());
    if (!cur) {
      by.set(name.toLowerCase(), { family: name, weights: weight ? [weight] : [], availability: avail, fallback, source });
      return;
    }
    if (weight && !cur.weights.includes(weight)) cur.weights.push(weight);
    if (avail === 'webfont-licensable') cur.availability = avail;
  };
  const webfont = WEBFONT_HINT.test(css) || /fonts\.googleapis|fonts\.gstatic/.test(html);
  for (const m of css.matchAll(/@font-face\s*\{([^}]+)\}/gi)) {
    const block = m[1];
    const fam = block.match(/font-family\s*:\s*([^;]+)/i)?.[1];
    const w = Number(block.match(/font-weight\s*:\s*(\d+)/i)?.[1]);
    for (const f of fontStack(fam ?? '')) add(f, Number.isFinite(w) ? w : undefined, '@font-face', true);
  }
  const vars = cssVars(css);
  for (const m of css.matchAll(/font-family\s*:\s*([^;!}{]+)/gi)) {
    const stack = fontStack(resolveVar(m[1], vars));
    if (stack[0]) add(stack[0], undefined, 'font-family', webfont);
  }
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const href = parseAttr(m[0], 'href') ?? '';
    if (!/fonts\.googleapis\.com/.test(href)) continue;
    const fam = new URL(href, 'https://example.com').searchParams.get('family');
    if (!fam) continue;
    for (const part of fam.split('|')) {
      const [name, rest] = part.split(':');
      const weights = (rest ?? '').match(/\d{3}/g)?.map(Number) ?? [];
      add(name.replace(/\+/g, ' '), weights[0], 'google-fonts', true);
      const rec = by.get(name.replace(/\+/g, ' ').toLowerCase());
      if (rec) rec.weights = [...new Set([...rec.weights, ...weights])].sort((a, b) => a - b);
    }
  }
  const fonts = [...by.values()].filter((f) => !SYSTEM_FONTS.has(f.family.toLowerCase()) || f.family.toLowerCase() === 'system-ui');
  // Role: first display-ish heading, first remaining body, first mono. A mono face is never the heading or the body.
  const prose = fonts.filter((f) => !isMonoFace(f.fallback));
  const heading = prose.find((f) => /display|grotesk|headline|heading|(?<!sans[- ]?)serif/i.test(f.family)) ?? prose[0];
  if (heading) heading.role = 'heading';
  const body = prose.find((f) => f !== heading) ?? heading;
  if (body && !body.role) body.role = 'body';
  const mono = fonts.find((f) => isMonoFace(f.fallback));
  if (mono) mono.role = 'mono';
  return fonts;
}

function firstMatch(html: string, re: RegExp): string | undefined {
  return re.exec(html)?.[1];
}

function extractLogo(html: string, pageUrl: string): BrandLogo | null {
  const abs = (href: string | undefined) => {
    if (!href) return undefined;
    try {
      return new URL(href, pageUrl).href;
    } catch {
      return undefined;
    }
  };
  // 1. Inline SVG that looks like a logo (header/nav, or id/class).
  const chunks = html.match(/<(?:header|nav|a)\b[^>]*>[\s\S]*?<\/(?:header|nav|a)>/gi) ?? [];
  const search = [...chunks, html];
  for (const block of search) {
    for (const m of block.matchAll(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi)) {
      const svg = m[0];
      const around = block.slice(Math.max(0, m.index! - 80), m.index! + svg.length + 40);
      if (LOGO_NAME.test(around) || LOGO_NAME.test(svg) || block !== html) {
        return { kind: 'inline-svg', svg };
      }
    }
    if (block !== html) break;
  }
  // 2–4. Linked images in the documented cascade.
  let apple: string | undefined;
  let og: string | undefined;
  let icon: string | undefined;
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = m[0];
    const rel = relOf(tag);
    const href = abs(parseAttr(tag, 'href'));
    if (!href) continue;
    if (rel.includes('apple-touch-icon')) apple ??= href;
    else if (rel.includes('icon') || rel.includes('shortcut')) icon ??= href;
  }
  og = abs(firstMatch(html, /<meta\b[^>]*property=["']og:image["'][^>]*content=["']([^"']+)["'][^>]*>/i)
    ?? firstMatch(html, /<meta\b[^>]*content=["']([^"']+)["'][^>]*property=["']og:image["'][^>]*>/i));
  if (apple) return { kind: 'apple-touch-icon', url: apple };
  if (og) return { kind: 'og-image', url: og };
  if (icon) return { kind: 'favicon', url: icon };
  const fav = abs(firstMatch(html, /href=["']([^"']*favicon[^"']*)["']/i));
  return fav ? { kind: 'favicon', url: fav } : null;
}

/** CSS custom properties by name (last definition wins), for resolving var(--x). */
function cssVars(css: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const m of css.matchAll(/--([a-zA-Z0-9_-]+)\s*:\s*([^;!}{]+)/g)) vars.set(m[1], m[2].trim());
  return vars;
}

/** `var(--x, fallback)` resolved through `vars` (a few levels deep), else the value itself. */
function resolveVar(value: string, vars: Map<string, string>): string {
  let v = value.trim();
  for (let i = 0; i < 4; i++) {
    const m = /^var\(\s*--([a-zA-Z0-9_-]+)\s*(?:,\s*([^)]*))?\)/.exec(v);
    if (!m) break;
    v = (vars.get(m[1]) ?? m[2] ?? '').trim();
  }
  return v;
}

/** The page declares itself dark: data-theme / class on <html>, or a dark-only color-scheme. */
function darkScheme(html: string, css: string): boolean {
  const root = /<html\b[^>]*>/i.exec(html)?.[0] ?? '';
  if (/data-(?:theme|mode|color-scheme)\s*=\s*["']?dark/i.test(root) || /class\s*=\s*["'][^"']*\bdark\b/i.test(root)) return true;
  const meta = /<meta\b[^>]*name=["']color-scheme["'][^>]*content=["']([^"']+)["']/i.exec(html)?.[1] ?? /<meta\b[^>]*content=["']([^"']+)["'][^>]*name=["']color-scheme["']/i.exec(html)?.[1];
  if (meta && /^\s*dark\b/i.test(meta) && !/light/i.test(meta)) return true;
  return /(?:^|[},\s])(?:html|:root)\s*\{[^}]*color-scheme\s*:\s*dark\s*[;}]/i.test(css);
}

function pagePlate(html: string, css: string, theme: string | null, ranked: BrandColor[]): Pick<BrandExtract, 'plate'> {
  const vars = cssVars(css);
  const dark = darkScheme(html, css);
  const fits = (hex: string) => (dark ? luminance(hex) < 0.2 : true);
  // A background on html, body or :root (the selector list may hold others, but one of these alone).
  for (const m of css.matchAll(/(?<=^|[{}])\s*([^{}@]+?)\s*\{([^{}]*)\}/g)) {
    if (!m[1].split(',').some((sel) => /^\s*(?:html|body|:root)\s*$/i.test(sel))) continue;
    const decl = /(?:^|;)\s*background(?:-color)?\s*:\s*([^;!]+)/i.exec(m[2])?.[1];
    const hex = decl ? normalizeHex(resolveVar(decl, vars)) : null;
    if (hex && fits(hex)) return { plate: { hex, source: 'page-rule' } };
  }
  if (theme && !chromatic(theme) && (luminance(theme) > 0.75 || luminance(theme) < 0.12) && fits(theme)) return { plate: { hex: theme, source: 'meta-theme' } };
  if (dark) {
    const darkest = ranked.filter((c) => c.role === 'background' && luminance(c.hex) < 0.05).sort((a, b) => b.rank - a.rank)[0];
    if (darkest) return { plate: { hex: darkest.hex, source: 'dark-scheme' } };
  }
  return {};
}

export function extractBrand(html: string, css: string, pageUrl: string): BrandExtract {
  const title = firstMatch(html, /<title[^>]*>([^<]*)<\/title>/i)?.trim();
  const theme = firstMatch(html, /<meta\b[^>]*name=["']theme-color["'][^>]*content=["']([^"']+)["']/i)
    ?? firstMatch(html, /<meta\b[^>]*content=["']([^"']+)["'][^>]*name=["']theme-color["']/i);
  const themeHex = theme ? normalizeHex(theme) : null;
  const hits = [
    ...extractCssColors(`${collectStyleBlocks(html)}\n${collectInlineStyles(html)}\n${css}`),
    // A neutral theme-color is the browser chrome around the page (its plate); a hued one is the brand's accent.
    ...(themeHex ? [{ hex: themeHex, source: 'meta-theme' as const, role: chromatic(themeHex) ? ('accent' as const) : ('background' as const) }] : []),
  ];
  return {
    ...(title ? { title } : {}),
    stylesheetHrefs: stylesheetHrefs(html, pageUrl),
    colors: rankColors(hits),
    fonts: extractFonts(`${collectStyleBlocks(html)}\n${css}`, html),
    logo: extractLogo(html, pageUrl),
    ...pagePlate(html, `${collectStyleBlocks(html)}\n${css}`, themeHex, rankColors(hits)),
  };
}

function pickRole(colors: BrandColor[], role: NonNullable<BrandColor['role']>, used: Set<string>): string | undefined {
  const hit = colors.find((c) => c.role === role && !used.has(c.hex));
  if (hit) {
    used.add(hit.hex);
    return hit.hex;
  }
  return undefined;
}

function contrastPick(colors: BrandColor[], dark: boolean, used: Set<string>): string | undefined {
  const hit = colors.find((c) => !used.has(c.hex) && (dark ? luminance(c.hex) > 0.55 : luminance(c.hex) < 0.35));
  if (hit) {
    used.add(hit.hex);
    return hit.hex;
  }
  return undefined;
}

/** WCAG contrast of two hex colours (1–21). */
export function contrast(a: string, b: string): number {
  const x = luminance(a);
  const y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** Accents are big type, plates and strokes: WCAG's floor for large text and graphics. */
export const ACCENT_MIN_CONTRAST = 3;
/** Text: WCAG AA for body copy. */
export const TEXT_MIN_CONTRAST = 4.5;

/** A colour with a hue (not a grey, black or white). */
function chromatic(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return Math.max(...ch) - Math.min(...ch) > 40;
}

function hexToHsl(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return [0, 0, l * 100];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [(h * 60 + 360) % 360, s * 100, l * 100];
}

/**
 * `hex` darkened on a light plate (lightened on a dark one), hue and saturation
 * kept, until it reaches `min` against `bg`; null when even black or white would not.
 */
export function towardContrast(hex: string, bg: string, min: number): string | null {
  if (contrast(hex, bg) >= min) return hex;
  const [h, s, l] = hexToHsl(hex);
  const darker = contrast('#000000', bg) >= contrast('#ffffff', bg);
  for (let L = l; darker ? L >= 0 : L <= 100; L += darker ? -2 : 2) {
    const c = hslToHex(h, s, Math.max(0, Math.min(100, L)));
    if (contrast(c, bg) >= min) return c;
  }
  return null;
}

const extreme = (bg: string) => (contrast('#000000', bg) >= contrast('#ffffff', bg) ? '#000000' : '#ffffff');

/** Interface states, not brand colours: a diff's green or an error red never becomes the accent. */
const STATE_NAME = /diff|error|danger|success|warn|alert|info|focus|selection|link|disabled|hover|shadow|border/i;

/** A hued colour the site actually uses for its brand: more than once, and not an interface state. */
const brandHue = (c: BrandColor) => chromatic(c.hex) && c.count >= 2 && !STATE_NAME.test(c.name ?? '');

/**
 * The accent, readable on the plate (ACCENT_MIN_CONTRAST). In order: the site's
 * own accent; that accent darkened or lightened with its hue kept (it is the
 * brand's colour, just tuned for a light page or a dark one); another of the
 * site's colours that reads, used more than once and not an interface state;
 * a brand neutral that reads (monochrome brands); the first colour adjusted;
 * the pack's accent adjusted.
 */
function readableAccent(colors: BrandColor[], raw: string | undefined, bg: string, used: Set<string>, fallback: string): string {
  const ok = (hex: string) => contrast(hex, bg) >= ACCENT_MIN_CONTRAST;
  if (raw && ok(raw)) return raw;
  const adjusted = raw && chromatic(raw) ? towardContrast(raw, bg, ACCENT_MIN_CONTRAST) : null;
  if (adjusted) return adjusted;
  const brand = colors.filter((c) => c.hex !== bg && c.hex !== raw && !used.has(c.hex));
  const real = brand.find((c) => brandHue(c) && ok(c.hex));
  if (real) return real.hex;
  const neutral = brand.find((c) => !chromatic(c.hex) && ok(c.hex));
  if (neutral) return neutral.hex;
  const first = brand.find((c) => chromatic(c.hex));
  return (first && towardContrast(first.hex, bg, ACCENT_MIN_CONTRAST)) ?? towardContrast(fallback, bg, ACCENT_MIN_CONTRAST) ?? extreme(bg);
}

/**
 * Closest shipped pack by plate (light/dark) and accent warmth, then overlay
 * extracted roles. Accent and text always read on the plate (a site's pale
 * theme colour or near-white text never becomes the video's ink).
 */
export function styleFromBrand(extract: BrandExtract, domain: string): StylePack {
  const used = new Set<string>();
  const bgPick = extract.plate?.hex ?? pickRole(extract.colors, 'background', used) ?? extract.colors.find((c) => luminance(c.hex) > 0.75 || luminance(c.hex) < 0.12)?.hex;
  if (bgPick) used.add(bgPick);
  const light = !bgPick || luminance(bgPick) >= 0.45;
  const rawAccent = pickRole(extract.colors, 'accent', used) ?? extract.colors.find((c) => brandHue(c) && !used.has(c.hex))?.hex;
  const warm = rawAccent ? ((parseInt(rawAccent.slice(1, 3), 16) + parseInt(rawAccent.slice(3, 5), 16) / 2) > parseInt(rawAccent.slice(5, 7), 16) + 20) : false;
  let packId: StylePackId;
  if (light) packId = warm ? 'playful-consumer' : 'paper';
  else packId = warm ? 'calm-premium' : 'snappy-saas';
  const base = STYLE_PACKS[packId];
  const bg = bgPick ?? base.colors.background;
  const accent = readableAccent(extract.colors, rawAccent, bg, used, base.colors.accent);
  used.add(accent);
  if (rawAccent) used.add(rawAccent);
  const surface = pickRole(extract.colors, 'surface', used) ?? (light ? '#ffffff' : base.colors.surface);
  const rawText = pickRole(extract.colors, 'text', used) ?? contrastPick(extract.colors, light, used) ?? base.colors.text;
  // Greys before hues for body type, then the pack's own, then pure ink.
  const textCandidates = [rawText, ...extract.colors.filter((c) => c.hex !== bg && !chromatic(c.hex)).map((c) => c.hex), base.colors.text];
  const text = textCandidates.find((c) => contrast(c, bg) >= TEXT_MIN_CONTRAST) ?? extreme(bg);
  const rawMuted = pickRole(extract.colors, 'muted', used) ?? base.colors.muted;
  const muted = towardContrast(rawMuted, bg, ACCENT_MIN_CONTRAST) ?? text;
  const rawAccent2 = pickRole(extract.colors, 'accent2', used) ?? extract.colors.find((c) => !used.has(c.hex) && c.hex !== accent)?.hex ?? base.colors.accent2;
  const accent2 = rawAccent2 && contrast(rawAccent2, bg) >= ACCENT_MIN_CONTRAST ? rawAccent2 : (rawAccent2 && chromatic(rawAccent2) ? towardContrast(rawAccent2, bg, ACCENT_MIN_CONTRAST) : null) ?? accent;
  // A mono face is for code: it never sets the headline or the body (the pack's faces do, when the site shows no other).
  const prose = extract.fonts.filter((f) => !isMonoFace(f.fallback));
  const heading = prose.find((f) => f.role === 'heading') ?? prose[0];
  const body = prose.find((f) => f.role === 'body') ?? heading;
  const mono = extract.fonts.find((f) => f.role === 'mono');
  return {
    id: 'custom',
    name: extract.title?.trim() || domain,
    fonts: {
      // No face of the site's own: a neutral sans, not the guessed pack's personality face.
      heading: heading?.fallback ?? 'Inter',
      body: body?.fallback ?? heading?.fallback ?? 'Inter',
      mono: mono?.fallback ?? base.fonts.mono,
    },
    colors: { background: bg, surface, text, muted, accent, accent2 },
    motion: base.motion,
  };
}

/** Logo file under public/ → an addAsset payload. Never redraws the file. ico/bin are skipped. */
export function logoAssetFromPath(
  id: string,
  logoPath: string,
  name: string,
): { id: string; kind: 'image' | 'svg'; name: string; src: string; mimeType: string } | undefined {
  if (/\.svg$/i.test(logoPath)) return { id, kind: 'svg', name, src: logoPath, mimeType: 'image/svg+xml' };
  if (/\.png$/i.test(logoPath)) return { id, kind: 'image', name, src: logoPath, mimeType: 'image/png' };
  if (/\.jpe?g$/i.test(logoPath)) return { id, kind: 'image', name, src: logoPath, mimeType: 'image/jpeg' };
  if (/\.webp$/i.test(logoPath)) return { id, kind: 'image', name, src: logoPath, mimeType: 'image/webp' };
  return undefined;
}

/** AI-legal commands for the overlay: setStyle plus an optional logo reference asset. */
export function brandStyleCommands(args: {
  style: StylePack;
  logoAsset?: { id: string; kind: 'image' | 'svg'; name: string; src: string; mimeType: string; width?: number; height?: number };
  /** Unlocked scene ids to paint with the kit background (needs those scene targets). */
  backgroundSceneIds?: string[];
}): Command[] {
  const commands: Command[] = [{ type: 'setStyle', style: args.style }];
  if (args.logoAsset) {
    commands.unshift({
      type: 'addAsset',
      asset: { ...args.logoAsset, reference: true },
    });
  }
  for (const sceneId of args.backgroundSceneIds ?? []) {
    commands.push({ type: 'updateScene', sceneId, changes: { backgroundColor: args.style.colors.background } });
  }
  return commands;
}
