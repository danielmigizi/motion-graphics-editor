// Fill cut-card slots from a site's copy (siteCopy.ts), deterministically and
// before any agent runs, so "Use this cut" with a website gives a draft in the
// user's own words at once. Only copy the page shows goes in. A slot the site
// has nothing for keeps its sample: `kept` when the sample is neutral
// placeholder copy, `missing` when it states a fact (a number, a person, the
// sample product) that must be replaced before the video ships.

import { cutSlotValues, type CutCard, type CutSlot } from './cutCards';
import { firstSentence, type SiteCopy } from './siteCopy';

export interface CutFill {
  values: Record<string, string>;
  /** Slots filled with the site's copy. */
  fromSite: string[];
  /** Neutral sample copy left in place (fine as a placeholder). */
  kept: string[];
  /** Sample facts left in place: replace before shipping. */
  missing: string[];
}

/** Slots whose sample states a fact about the product (numbers, people, outcomes). */
const FACTUAL = new Set(['stat', 'metric', 'price', 'label', 'chip', 'quote', 'name', 'role', 'then', 'before', 'terms', 'items', 'features', 'chips', 'results', 'days']);

const lineCount = (s: string) => s.split('\n').filter(Boolean).length;

/** Split a line into two at the word boundary nearest the middle. */
export function twoLines(text: string): string {
  const words = text.trim().split(/\s+/);
  if (words.length < 3) return text.trim();
  let best = 1;
  const total = text.length;
  for (let i = 1; i < words.length; i++) {
    const left = words.slice(0, i).join(' ').length;
    if (Math.abs(total / 2 - left) < Math.abs(total / 2 - words.slice(0, best).join(' ').length)) best = i;
  }
  return `${words.slice(0, best).join(' ')}\n${words.slice(best).join(' ')}`;
}

/** A clause boundary: punctuation, or the word that starts the next clause. */
const CLAUSE_BREAK = /\s*[,;:–—]\s+|\s+\(|\s+(?=(?:with|and|or|so|that|which|while|because|without|using|via|across|for|to|by|in|from|through)\s)/gi;
/** A phrase never ends on these. */
const DANGLING = /\b(?:a|an|the|and|or|of|to|for|with|in|on|by|from|your|our|its|their|my)$/i;

const words = (t: string) => t.split(/\s+/).filter(Boolean).length;

/** Whole sentences of a text. */
export const sentences = (text: string) => text.split(/(?<=[.!?])\s+/).map((t) => t.trim()).filter(Boolean);

/** The longest leading clause of `text` that fits `limit` and reads as a phrase (2+ words, no dangling article or preposition). */
export function leadingPhrase(text: string, limit: number): string | null {
  let best: string | null = null;
  for (const m of text.matchAll(CLAUSE_BREAK)) {
    const head = text.slice(0, m.index).trim().replace(/[,;:–—-]+$/, '');
    if (head.length > limit) break;
    if (words(head) >= 2 && !DANGLING.test(head)) best = head;
  }
  return best;
}

/**
 * Copy for a slot, from candidates in order of fit to the slot's meaning: the
 * first that fits whole (~1.25× the slot's designed length), else a whole
 * sentence of one, else a list with whole items dropped from the end, else
 * the longest clean leading clause, and only then whole words up to the limit.
 * A site's line is never cut mid-phrase while a whole one would do.
 */
export function fitCopy(text: string | readonly (string | undefined)[], slot: CutSlot): string {
  const limit = Math.round((slot.maxChars ?? 80) * 1.25);
  const fits = (t: string) => t.length <= limit;
  const list = (typeof text === 'string' ? [text] : text).map((t) => t?.replace(/\s*\n\s*/g, '\n').trim()).filter((t): t is string => !!t);
  if (!list.length) return '';
  for (const t of list) {
    if (fits(t)) return t;
    if (slot.kind === 'list' && t.includes('\n')) {
      const items = t.split('\n');
      while (items.length > 1 && !fits(items.join('\n'))) items.pop();
      if (fits(items.join('\n'))) return items.join('\n');
      continue;
    }
    const whole = sentences(t.replace(/\n/g, ' ')).find(fits);
    if (whole) return whole;
  }
  for (const t of list) {
    const phrase = leadingPhrase(firstSentence(t.replace(/\n/g, ' ')), limit);
    if (phrase) return phrase;
  }
  const first = firstSentence(list[0].replace(/\n/g, ' '));
  let out = '';
  for (const w of first.split(/\s+/)) {
    if ((out ? `${out} ${w}` : w).length > limit) break;
    out = out ? `${out} ${w}` : w;
  }
  return (out || first.slice(0, limit)).replace(/[,;:–—-]+$/, '');
}

type Candidates = string | readonly (string | undefined)[] | undefined;
type Source = (copy: SiteCopy, slot: CutSlot, card: CutCard) => Candidates;

/** A line of the site's own prose, in order of fit: the subhead, the headline, then what each value prop says. */
const prose = (c: SiteCopy) => [c.subhead, c.headline, ...c.valueProps.map((p) => p.body)];
const headlineFirst = (c: SiteCopy) => [c.headline, c.subhead, ...c.valueProps.map((p) => p.title)];
const propTitles = (c: SiteCopy, slot: CutSlot) => (c.valueProps.length ? c.valueProps.slice(0, Math.max(1, lineCount(slot.sample))).map((p) => p.title).join('\n') : undefined);

/** Where each slot name takes its copy from; `kind` decides between a headline and a chat line. */
const SOURCES: Record<string, Source> = {
  product: (c) => c.product,
  // The gap a split headline opens is where the product shows up.
  reveal: (c) => c.product,
  url: (c) => c.domain,
  kicker: (c) => c.product.toUpperCase(),
  claim: headlineFirst,
  setup: headlineFirst,
  ask: headlineFirst,
  question: (c, s) => (s.kind === 'lines' ? headlineFirst(c) : undefined),
  lines: (c, s) => (lineCount(s.sample) >= 3 && c.valueProps.length >= 3 ? propTitles(c, s) : headlineFirst(c)),
  title: headlineFirst,
  headline: headlineFirst,
  punchline: prose,
  now: prose,
  promise: prose,
  subtitle: prose,
  tagline: prose,
  caption: prose,
  answer: prose,
  after: headlineFirst,
  stat: (c) => c.stat?.value,
  metric: (c) => c.stat?.value,
  label: (c) => c.stat?.label,
  price: (c) => c.price,
  action: (c) => c.cta,
  cta: (c) => c.cta,
  offer: (c) => `${c.domain}${c.cta ? ` · ${c.cta}` : ''}`,
  features: (c, s) => (c.valueProps.length ? c.valueProps.slice(0, Math.max(1, lineCount(s.sample))).map((p) => (p.body ? `${p.title}: ${p.body}` : p.title)).join('\n') : undefined),
  // Lists in a proof are what the product does; in a hook or turn they are the problem, which the site does not list.
  items: (c, s, card) => (card.beat === 'proof' ? propTitles(c, s) : undefined),
  results: (c, s, card) => (card.beat === 'proof' ? propTitles(c, s) : undefined),
  chips: propTitles,
  quote: (c) => c.quote?.text,
  name: (c) => (c.quote ? c.quote.name : undefined),
  role: (c) => (c.quote ? c.quote.role : undefined),
};

/** Has the source anything to offer? */
const present = (c: Candidates) => (typeof c === 'string' ? !!c.trim() : !!c?.some((t) => t?.trim()));

/** Fitted copy for a slot; a 'lines' slot given one line is balanced over two. */
function fitSlot(candidates: Candidates, slot: CutSlot): string {
  const value = fitCopy(candidates ?? [], slot);
  return slot.kind === 'lines' && !value.includes('\n') && words(value) >= 3 ? twoLines(value) : value;
}

/** One card's slots from the site's copy. */
export function fillCutSlots(card: CutCard, copy: SiteCopy): CutFill {
  const values: Record<string, string> = {};
  const fill: CutFill = { values, fromSite: [], kept: [], missing: [] };
  for (const [name, slot] of Object.entries(card.slots)) {
    const raw = SOURCES[name]?.(copy, slot, card);
    if (present(raw)) {
      values[name] = fitSlot(raw, slot);
      fill.fromSite.push(name);
      continue;
    }
    values[name] = slot.sample;
    if (FACTUAL.has(name) || slot.kind === 'stat' || /brieflet/i.test(slot.sample)) fill.missing.push(name);
    else fill.kept.push(name);
  }
  // A quote with no customer behind it reads as the brand speaking: say so rather than invent a person.
  if (card.slots.quote && !copy.quote) {
    const said = [copy.subhead, copy.headline];
    if (present(said)) {
      values.quote = fitCopy(said, card.slots.quote);
      if (card.slots.name) values.name = copy.product;
      if (card.slots.role) values.role = copy.domain;
      fill.fromSite.push(...['quote', 'name', 'role'].filter((n) => card.slots[n]));
      fill.missing = fill.missing.filter((n) => !['quote', 'name', 'role'].includes(n));
    }
  }
  // Every value must still be a slot the card has (cutSlotValues refuses unknown names).
  const checked = cutSlotValues(card, values);
  if (!checked.ok) throw new Error(checked.message);
  return fill;
}

/** Slots for each card (by card id) plus what each card still needs. */
export function fillCut(cards: readonly CutCard[], copy: SiteCopy): { slots: Record<string, Record<string, string>>; report: Record<string, CutFill> } {
  const report = Object.fromEntries(cards.map((c) => [c.id, fillCutSlots(c, copy)]));
  return { slots: Object.fromEntries(Object.entries(report).map(([id, f]) => [id, f.values])), report };
}
