// Site copy from fetched HTML (no JS): the product name, the hero headline and
// subhead, value props, a number worth showing, a price, the call to action
// and a customer quote, for filling cut-card slots before an agent polishes
// them. Pure and deterministic: same markup → same copy. Every field is text
// the page itself shows; nothing is invented, and a missing field stays
// missing.

export interface SiteStat {
  /** The number as the page writes it, e.g. "4×", "92%", "10,000+". */
  value: string;
  /** The words around it, e.g. "faster reviews". */
  label: string;
}

export interface SiteQuote {
  text: string;
  name?: string;
  role?: string;
}

export interface SiteCopy {
  url: string;
  /** Host without www, e.g. "acme.dev". */
  domain: string;
  product: string;
  headline?: string;
  subhead?: string;
  valueProps: { title: string; body?: string }[];
  stat?: SiteStat;
  price?: string;
  cta?: string;
  quote?: SiteQuote;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', times: '×', middot: '·', trade: '™', reg: '®', copy: '©' };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
    if (code[0] === '#') {
      const n = code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[code.toLowerCase()] ?? m;
  });
}

/** Visible text of a fragment: tags out, entities decoded, whitespace collapsed. */
export function textOf(fragment: string): string {
  return decode(fragment.replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/** The page without what is never read as copy: scripts, styles, SVG drawings, templates, comments. */
function readable(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, ' ');
}

/** The page body without site chrome (nav, header menus, footer, cookie banners). */
function mainContent(html: string): string {
  const body = readable(html);
  const main = /<main\b[\s\S]*?<\/main>/i.exec(body)?.[0];
  return (main ?? body).replace(/<(nav|footer|form)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+(cookie|consent)[^>]*>[\s\S]{0,2000}?<\/(div|section|aside)>/gi, ' ');
}

const meta = (html: string, key: string): string | undefined => {
  const a = new RegExp(`<meta\\b[^>]*(?:name|property)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i').exec(html)?.[1];
  const b = new RegExp(`<meta\\b[^>]*content=["']([^"']*)["'][^>]*(?:name|property)=["']${key}["']`, 'i').exec(html)?.[1];
  const v = textOf(a ?? b ?? '');
  return v || undefined;
};

function tagTexts(html: string, tag: string): { text: string; end: number }[] {
  const out: { text: string; end: number }[] = [];
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'gi');
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const text = textOf(m[1]);
    if (text) out.push({ text, end: m.index + m[0].length });
  }
  return out;
}

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;
/** Words with letters in them (not separators, handles or numbers). */
const realWords = (t: string) => (t.match(/\p{L}{2,}/gu) ?? []).length;

/** First sentence (or the whole line when it has no stop). */
export function firstSentence(text: string): string {
  const m = /^(.{12,}?[.!?])(\s|$)/.exec(text.trim());
  return (m ? m[1] : text).trim();
}

/** Brand name: og:site_name, else the title's first or last part around a separator, else the domain's name. */
function productName(html: string, domain: string): string {
  const site = meta(html, 'og:site_name') ?? meta(html, 'application-name');
  if (site && site.length <= 32) return site;
  const title = textOf(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  const parts = title.split(/\s+[|–—:·-]\s+/).map((p) => p.trim()).filter(Boolean);
  const root = domain.split('.')[0] ?? domain;
  const named = parts.find((p) => p.toLowerCase().replace(/\s+/g, '').includes(root.toLowerCase()));
  if (named && named.length <= 32) return named;
  const short = parts.length > 1 ? [parts[0], parts[parts.length - 1]].sort((a, b) => a.length - b.length)[0] : undefined;
  if (short && short.length <= 24 && words(short) <= 3) return short;
  return root.charAt(0).toUpperCase() + root.slice(1);
}

const NAV_WORDS = /^(home|pricing|blog|docs|documentation|about( us)?|careers|contact( us)?|login|log in|sign in|sign up|resources|customers|company|product|features|solutions|faq|legal|privacy|terms|changelog|support|menu|search)$/i;

function valueProps(html: string, headline?: string): SiteCopy['valueProps'] {
  const seen = new Set<string>(headline ? [headline.toLowerCase()] : []);
  const out: SiteCopy['valueProps'] = [];
  for (const tag of ['h2', 'h3']) {
    const list = tagTexts(html, tag);
    for (const h of list) {
      const title = h.text.replace(/[.:]$/, '');
      const key = title.toLowerCase();
      if (seen.has(key) || NAV_WORDS.test(title) || title.length < 4 || title.length > 70 || words(title) > 10) continue;
      seen.add(key);
      // The paragraph right after the heading, close by and before the next heading, quote or section.
      const near = html.slice(h.end, h.end + 900);
      const stop = /<(h[1-6]|blockquote|section|article|li)\b/i.exec(near)?.index ?? near.length;
      const p = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(near.slice(0, stop));
      const body = p && p.index < 500 ? firstSentence(textOf(p[1])) : undefined;
      out.push({ title, ...(body && body.length <= 140 && body.toLowerCase() !== key ? { body } : {}) });
      if (out.length >= 6) return out;
    }
  }
  return out;
}

// A number a launch video can show: a multiplier, a percentage, a count, a duration.
const STAT_RE = /(\d{1,3}(?:[,.]\d{3})+|\d+(?:[.,]\d+)?)\s?(×|x\b|%|\+|[kKM](?=\+|\b)|million\b|billion\b|hours?\b|hrs?\b|minutes?\b|mins?\b|seconds?\b|days?\b|weeks?\b)?(\+)?/g;
const YEARISH = /^(19|20)\d{2}$/;
const STAT_DANGLING = /\b(for|to|in|of|with|by|at|on|the|a|an|and|or|from|than|over|about|nearly|almost|up)$/i;

function statFrom(texts: string[]): SiteStat | undefined {
  for (const t of texts) {
    if (t.length > 160) continue;
    STAT_RE.lastIndex = 0;
    for (let m = STAT_RE.exec(t); m; m = STAT_RE.exec(t)) {
      const [whole, digits, unit] = m;
      // A bare number is only a stat with a unit, a sign or thousands in it.
      if (!unit && !/^\d{1,3}(,\d{3})+$/.test(digits)) continue;
      if (YEARISH.test(digits) && !unit) continue;
      if (/^[$€£]/.test(t.slice(Math.max(0, m.index - 1), m.index))) continue;
      const value = whole.replace(/\s?x\b/, '×').replace(/\s+(?=[%+×])/, '').trim();
      const label = `${t.slice(0, m.index)} ${t.slice(m.index + whole.length)}`.replace(/\s+/g, ' ').replace(/^[\s,–—:-]+|[\s,.–—:-]+$/g, '').trim();
      // A stat needs a real phrase around it, not a UI fragment ("Worked for").
      if (realWords(label) < 3 || label.length > 48 || STAT_DANGLING.test(label) || /\bago\b|…|\.\.\.|[⋅·|]/i.test(label)) continue;
      return { value, label };
    }
  }
  return undefined;
}

const CTA_RE = /\b(get started|start( (free|now|building|today|your))?|try( it)?( for)? free|try\b|sign up|join|book a demo|request( a)? demo|get( a)? demo|download|get early access|request access|join (the )?waitlist|buy|shop|subscribe|start (a )?free trial|get [a-z]+ free)\b/i;

function ctaFrom(html: string): string | undefined {
  const candidates = [...tagTexts(html, 'a'), ...tagTexts(html, 'button')].map((c) => c.text).filter((t) => t.length >= 3 && t.length <= 28 && words(t) <= 5 && CTA_RE.test(t));
  // The most repeated wins (the hero and the nav usually share it), then the first.
  const counts = new Map<string, number>();
  for (const c of candidates) counts.set(c, (counts.get(c) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

function quoteFrom(html: string): SiteQuote | undefined {
  const m = /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>([\s\S]{0,600})/i.exec(html);
  if (!m) return undefined;
  const inner = m[1];
  const cite = /<(cite|footer|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(inner + m[2]);
  const text = textOf(inner.replace(/<(cite|footer)\b[\s\S]*?<\/\1>/gi, ' ')).replace(/^[“"']|[”"']$/g, '').trim();
  if (text.length < 20 || text.length > 220) return undefined;
  const by = cite ? textOf(cite[2]).replace(/^[—–-]\s*/, '') : '';
  const [name, ...rest] = by.split(/\s*[,|·–—]\s*/);
  return { text, ...(name && words(name) <= 4 ? { name } : {}), ...(rest.length ? { role: rest.join(', ') } : {}) };
}

/** A page title without its brand part: "Linear – The system for product development" → "The system for product development". */
function withoutBrand(title: string, product: string): string | undefined {
  const parts = title.split(/\s+[|–—:·-]\s+/).map((p) => p.trim()).filter(Boolean);
  const rest = parts.filter((p) => p.toLowerCase() !== product.toLowerCase());
  const pick = (rest.length ? rest : parts).sort((a, b) => words(b) - words(a))[0];
  return pick && pick.length >= 4 ? pick : undefined;
}

export function extractSiteCopy(html: string, pageUrl: string): SiteCopy {
  let domain = pageUrl;
  try {
    domain = new URL(pageUrl).hostname.replace(/^www\./i, '').toLowerCase();
  } catch {
    // Not a URL: keep it as given.
  }
  const main = mainContent(html);
  const h1 = tagTexts(main, 'h1').map((h) => h.text).find((t) => t.length >= 4 && t.length <= 120);
  const product = productName(html, domain);
  const headline = h1 ?? withoutBrand(meta(html, 'og:title') ?? textOf(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? ''), product);
  const description = meta(html, 'description') ?? meta(html, 'og:description');
  const firstP = tagTexts(main, 'p').map((p) => p.text).find((t) => words(t) >= 6 && t.length <= 240);
  const subhead = description ?? firstP;
  const props = valueProps(main, headline);
  const lines = [...tagTexts(main, 'h2'), ...tagTexts(main, 'h3'), ...tagTexts(main, 'p'), ...tagTexts(main, 'li'), ...tagTexts(main, 'span'), ...tagTexts(main, 'div')].map((t) => t.text);
  const stat = statFrom([...(headline ? [headline] : []), ...(subhead ? [subhead] : []), ...lines]);
  // A plan price only: per period or per seat (a bare "$0.01" is usually a fee, not what the product costs).
  const price = /(?:^|\s)([$€£]\s?\d+(?:[.,]\d{2})?\s?\/\s?(?:mo|month|user|seat|year|yr)\b)/i.exec(textOf(main))?.[1]?.trim();
  const cta = ctaFrom(readable(html));
  const quote = quoteFrom(main);
  return {
    url: pageUrl,
    domain,
    product,
    ...(headline ? { headline } : {}),
    ...(subhead ? { subhead } : {}),
    valueProps: props,
    ...(stat ? { stat } : {}),
    ...(price ? { price } : {}),
    ...(cta ? { cta } : {}),
    ...(quote ? { quote } : {}),
  };
}
