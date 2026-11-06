import { describe, expect, it } from 'vitest';
import { fixtureProject } from './__fixtures__/fixtureProject';
import { createDocState } from './history';
import { checkPatch } from './patch';
import { STYLE_PACKS } from './style';
import { ACCENT_MIN_CONTRAST, brandDomain, brandStyleCommands, classifyFont, contrast, extractBrand, logoAssetFromPath, normalizeHex, styleFromBrand, TEXT_MIN_CONTRAST, type BrandColor, type BrandExtract } from './brand-kit';

const PAGE = 'https://www.acme.test/about';

const HTML = `
<!doctype html>
<html>
<head>
  <title>Acme Solar</title>
  <meta name="theme-color" content="#58ad80">
  <meta property="og:image" content="/og.png">
  <link rel="apple-touch-icon" href="/apple-touch.png">
  <link rel="icon" href="/favicon.ico">
  <link rel="stylesheet" href="/app.css">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400" rel="stylesheet">
  <style>
    :root { --bg: #f5f4f0; --text: #15171c; --primary: #58ad80; --accent-2: #1fb0bf; }
    body { font-family: "Space Grotesk", Inter, sans-serif; color: var(--text); background: var(--bg); }
  </style>
</head>
<body>
  <header>
    <a class="logo" href="/"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg></a>
  </header>
</body>
</html>`;

const CSS = `
@font-face { font-family: "Acme Sans"; font-weight: 600; src: url(/acme.woff2); }
h1 { font-family: "Acme Sans", sans-serif; color: #0a1528; }
.card { background-color: #ffffff; }
`;

describe('brand-kit extract', () => {
  it('normalises colours and classifies fonts', () => {
    expect(normalizeHex('#58a')).toBe('#5588aa');
    expect(normalizeHex('rgb(88, 173, 128)')).toBe('#58ad80');
    expect(normalizeHex('hsl(150, 40%, 50%)')).toMatch(/^#[0-9a-f]{6}$/);
    expect(normalizeHex('transparent')).toBeNull();
    expect(classifyFont('Inter')).toEqual({ availability: 'bundled', fallback: 'Inter' });
    expect(classifyFont('system-ui').availability).toBe('system');
    expect(classifyFont('Acme Sans').fallback).toBe('Inter');
    expect(brandDomain(PAGE)).toBe('acme.test');
    expect(logoAssetFromPath('ast_l', 'assets/uploads/brand/acme.test/logo.svg', 'Logo')).toMatchObject({ kind: 'svg', mimeType: 'image/svg+xml' });
    expect(logoAssetFromPath('ast_l', 'assets/uploads/brand/acme.test/logo.ico', 'Logo')).toBeUndefined();
  });

  it('ranks CSS variables, follows the logo cascade, and maps a style overlay', () => {
    const extracted = extractBrand(HTML, CSS, PAGE);
    expect(extracted.title).toBe('Acme Solar');
    expect(extracted.stylesheetHrefs).toEqual(['https://www.acme.test/app.css', 'https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400']);
    expect(extracted.logo).toEqual({ kind: 'inline-svg', svg: expect.stringContaining('<circle') });
    expect(extracted.colors.find((c) => c.hex === '#f5f4f0')).toMatchObject({ role: 'background', source: 'css-variable' });
    expect(extracted.colors.find((c) => c.hex === '#58ad80')).toMatchObject({ role: 'accent' });
    expect(extracted.colors.map((c) => c.hex)).toEqual(expect.arrayContaining(['#f5f4f0', '#58ad80', '#15171c', '#1fb0bf']));
    expect(extracted.fonts.some((f) => f.family === 'Space Grotesk' && f.availability === 'bundled')).toBe(true);
    expect(extracted.fonts.some((f) => f.family === 'Acme Sans' && f.availability === 'webfont-licensable' && f.fallback === 'Inter')).toBe(true);
    const style = styleFromBrand(extracted, 'acme.test');
    expect(style.id).toBe('custom');
    expect(style.name).toBe('Acme Solar');
    expect(style.colors.background).toBe('#f5f4f0');
    // The site's green reads at 2.5:1 on its cream plate: darkened, same hue, to 3:1.
    expect(style.colors.accent).toBe('#4c9b71');
    expect(style.fonts.heading).toBe('Space Grotesk');
    expect(style.motion).toEqual(STYLE_PACKS['playful-consumer'].motion);
    const commands = brandStyleCommands({
      style,
      logoAsset: { id: 'ast_brand_logo', kind: 'svg', name: 'Logo', src: 'assets/uploads/brand/acme.test/logo.svg', mimeType: 'image/svg+xml' },
      backgroundSceneIds: ['scn_intro'],
    });
    expect(commands[0]).toMatchObject({ type: 'addAsset', asset: { reference: true, src: 'assets/uploads/brand/acme.test/logo.svg' } });
    expect(commands[1]).toEqual({ type: 'setStyle', style });
    expect(commands[2]).toEqual({ type: 'updateScene', sceneId: 'scn_intro', changes: { backgroundColor: style.colors.background } });
    const legal = checkPatch(createDocState(fixtureProject), {
      protocol: 'mge.patch/1',
      projectId: fixtureProject.id,
      baseRevision: fixtureProject.revision,
      summary: 'Brand kit',
      targets: [{ style: 'project' }, { sceneId: 'scn_intro' }],
      commands,
    });
    expect(legal.ok, legal.ok ? '' : legal.error.message).toBe(true);
  });

  it('falls through the logo cascade when there is no inline SVG', () => {
    const html = `<link rel="apple-touch-icon" href="/a.png"><link rel="icon" href="/f.ico"><meta property="og:image" content="https://cdn.test/og.jpg">`;
    expect(extractBrand(html, '', PAGE).logo).toEqual({ kind: 'apple-touch-icon', url: 'https://www.acme.test/a.png' });
    expect(extractBrand('<meta property="og:image" content="/og.jpg">', '', PAGE).logo).toEqual({ kind: 'og-image', url: 'https://www.acme.test/og.jpg' });
    expect(extractBrand('<link rel="icon" href="/favicon.ico">', '', PAGE).logo).toEqual({ kind: 'favicon', url: 'https://www.acme.test/favicon.ico' });
    expect(extractBrand('<p>no brand</p>', '', PAGE).logo).toBeNull();
  });
});

describe('readable brand colours', () => {
  const extract = (colors: [string, BrandColor['role']?, BrandColor['source']?, string?][]): BrandExtract => ({
    stylesheetHrefs: [],
    fonts: [],
    logo: null,
    colors: colors.map(([hex, role, source, name], i) => ({ hex, ...(role ? { role } : {}), ...(name ? { name } : {}), source: source ?? 'css-variable', rank: 100 - i, count: name ? 2 : 1 })),
  });

  it('never keeps a pale accent on white: the site’s accent is darkened, hue kept, not swapped for a diff green (Linear)', () => {
    const style = styleFromBrand(extract([['#9c9da1'], ['#ffebc6', 'accent'], ['#626366'], ['#ffffff', 'background'], ['#000000', 'background'], ['#27a644', 'background', 'css-variable', 'diff-new-color'], ['#f34e52', 'background', 'css-variable', 'diff-old-color'], ['#e2e4e7', 'text']]), 'linear.app');
    expect(style.colors.background).toBe('#ffffff');
    expect(style.colors.accent).not.toBe('#ffebc6');
    expect(style.colors.accent).not.toBe('#27a644');
    expect(contrast(style.colors.accent, '#ffffff')).toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST);
    // Still the peach's warm hue: red over blue.
    const n = parseInt(style.colors.accent.slice(1), 16);
    expect((n >> 16) & 255).toBeGreaterThan(n & 255);
    // Near-white text on white is replaced by the brand's own grey that reads.
    expect(style.colors.text).toBe('#626366');
  });

  it('takes a brand neutral for a monochrome site whose theme colour is near-white (Vercel)', () => {
    const style = styleFromBrand(extract([['#ffffff', 'background'], ['#000000', 'background', 'declaration'], ['#111111', 'text'], ['#fafafa', 'accent', 'meta-theme'], ['#00ffe0', 'background', 'declaration']]), 'site.com');
    expect(style.colors.accent).toBe('#000000');
    expect(style.colors.text).toBe('#111111');
  });

  it('passes over one-off and interface-state colours for a monochrome site', () => {
    const style = styleFromBrand(extract([['#ffffff', 'background'], ['#fafafa', 'accent', 'meta-theme'], ['#9a050f', 'text', 'declaration'], ['#e00000', undefined, 'css-variable', 'error-color'], ['#000000', 'background']]), 'mono.test');
    expect(style.colors.accent).toBe('#000000');
  });

  it('darkens the site’s own accent, hue kept, when no other brand colour reads', () => {
    const style = styleFromBrand(extract([['#ffffff', 'background'], ['#ffd400', 'accent'], ['#15171c', 'text']]), 'sun.test');
    expect(style.colors.accent).not.toBe('#ffd400');
    expect(contrast(style.colors.accent, '#ffffff')).toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST);
    // Still yellow-orange, not a grey.
    const n = parseInt(style.colors.accent.slice(1), 16);
    expect((n >> 16) & 255).toBeGreaterThan(n & 255);
  });

  it('keeps an accent that already reads, on light and dark plates', () => {
    expect(styleFromBrand(extract([['#ffffff', 'background'], ['#533afd', 'accent'], ['#061b31', 'text']]), 'stripe.com').colors.accent).toBe('#533afd');
    expect(styleFromBrand(extract([['#08090a', 'background'], ['#5e6ad2', 'accent'], ['#f7f8f8', 'text']]), 'dark.test').colors.accent).toBe('#5e6ad2');
  });

  it('always meets the floors, whatever the site gives', () => {
    const palettes: [string, BrandColor['role']?][][] = [
      [['#ffffff', 'background'], ['#fafafa', 'accent'], ['#f0f0f0', 'text'], ['#eeeeee', 'muted'], ['#f9f9f9', 'accent2']],
      [['#000000', 'background'], ['#0a0a0a', 'accent'], ['#111111', 'text']],
      [['#7f7f7f', 'background'], ['#808080', 'accent']],
      [],
    ];
    for (const p of palettes) {
      const c = styleFromBrand(extract(p), 'x.test').colors;
      expect(contrast(c.accent, c.background), JSON.stringify(c)).toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST);
      expect(contrast(c.accent2!, c.background), JSON.stringify(c)).toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST);
      expect(contrast(c.muted, c.background), JSON.stringify(c)).toBeGreaterThanOrEqual(ACCENT_MIN_CONTRAST);
      expect(contrast(c.text, c.background), JSON.stringify(c)).toBeGreaterThanOrEqual(TEXT_MIN_CONTRAST);
    }
  });
});

describe('the page’s own plate and faces', () => {
  const brand = (html: string, css = '') => {
    const extracted = extractBrand(html, css, 'https://site.test/');
    return { extracted, style: styleFromBrand(extracted, 'site.test') };
  };

  it('reads a dark site from its theme-color, not a stray light variable (Linear)', () => {
    const { extracted, style } = brand(
      '<html lang="en" data-theme="dark"><head><meta name="theme-color" content="#08090a"></head></html>',
      ':root { --kbd-bg: #ffffff; --accent: #ffebc6; --token-text: #e2e4e7; } code { font-family: var(--font-monospace); } :root { --font-monospace: "Berkeley Mono", monospace; }',
    );
    expect(extracted.plate).toEqual({ hex: '#08090a', source: 'meta-theme' });
    expect(style.colors.background).toBe('#08090a');
    // On the dark plate the site's peach accent and light text read as they are.
    expect(style.colors.accent).toBe('#ffebc6');
    expect(style.colors.text).toBe('#e2e4e7');
    expect(contrast(style.colors.text, style.colors.background)).toBeGreaterThanOrEqual(TEXT_MIN_CONTRAST);
  });

  it('takes a html/body/:root background rule first, through its variable', () => {
    const { extracted, style } = brand('<html>', ':root { --page: #0f1011; --card-bg: #ffffff; } body { margin: 0; background: var(--page); }');
    expect(extracted.plate).toEqual({ hex: '#0f1011', source: 'page-rule' });
    expect(style.colors.background).toBe('#0f1011');
  });

  it('keeps a light page light when a dark variable ranks higher', () => {
    const { style } = brand('<html>', ':root { --footer-bg: #000000; --nav-bg: #000000; --hero-bg: #000000; } html, body { background-color: #fdfdfc; } .card { background: #000; }');
    expect(style.colors.background).toBe('#fdfdfc');
  });

  it('falls back to the darkest declared background when the page only says it is dark', () => {
    const { extracted } = brand('<html class="dark">', '.a { background: #ffffff; } .b { background: #0b0b0d; } .c { background: #0b0b0d; }');
    expect(extracted.plate).toEqual({ hex: '#0b0b0d', source: 'dark-scheme' });
    // A light-and-dark site is not forced dark.
    expect(brand('<meta name="color-scheme" content="light dark">', '.b { background: #0b0b0d; }').extracted.plate).toBeUndefined();
  });

  it('never lets a mono face set the headline or the body', () => {
    const site = brand('<html>', '@font-face { font-family: "Geist Mono"; } @font-face { font-family: "GeistSans"; } body { font-family: GeistSans, sans-serif; }');
    expect(site.extracted.fonts.find((f) => f.role === 'heading')?.family).toBe('GeistSans');
    expect(site.style.fonts.heading).not.toBe('IBM Plex Mono');
    expect(site.style.fonts.mono).toBe('Geist Mono');
    const monoOnly = brand('<html>', ':root { --font-monospace: "Berkeley Mono"; } code { font-family: var(--font-monospace); }');
    expect(monoOnly.extracted.fonts.map((f) => f.family)).toEqual(['Berkeley Mono']);
    // Only a mono face on the page: a neutral sans sets the type, not the guessed pack's personality face.
    expect(monoOnly.style.fonts).toMatchObject({ heading: 'Inter', body: 'Inter', mono: 'IBM Plex Mono' });
  });

  it('does not take a one-off hue for the accent of a monochrome site on its theme plate (Vercel)', () => {
    const { style } = brand('<meta name="theme-color" content="#fafafa">', '.x { background: #00ffe0; } body { color: #111111; } .y { color: #000000; } .z { color: #000000; }');
    expect(style.colors.background).toBe('#fafafa');
    expect(style.colors.accent).toBe('#000000');
  });

  it('does not take a sans-serif face for a serif headline', () => {
    const { extracted } = brand('<html>', 'h1 { font-family: "Acme Sans-Serif"; } p { font-family: "Noto Serif Display"; }');
    expect(extracted.fonts.find((f) => f.role === 'heading')?.family).toBe('Noto Serif Display');
  });
});
