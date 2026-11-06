// The command palette's pure parts (CommandPalette.tsx renders them): fuzzy
// ranking of its entries for a query, recent picks first while the query is
// empty, and the printed form of a shortcut split into key caps, which the
// shortcuts sheet (ShortcutsSheet.tsx) uses too.

import type { Shortcut } from './actions';

/** One thing the palette can run, as it reads: "Edit · Duplicate", "Select · Headline — Open". */
export interface PaletteEntry {
  /** Stable across openings, for the recent list: 'action:edit.undo', 'scene:scn_1', 'setting:theme'. */
  id: string;
  /** The quiet lead: the menu ("Edit"), "Go to scene", "Select", "Settings". */
  prefix: string;
  label: string;
  /** Quieter still, after the label: the scene an element is in. */
  detail?: string;
  /** Extra words the query may match; they never highlight. */
  keywords?: readonly string[];
}

export interface Ranked<T extends PaletteEntry> {
  entry: T;
  /** Matched character offsets in paletteText(entry), for highlighting. */
  positions: number[];
  /** Listed first because it was picked recently (empty query only). */
  recent?: boolean;
}

/** The entry as one line: "Edit · Duplicate", "Select · Headline — Open". */
export function paletteText(e: PaletteEntry): string {
  return `${e.prefix} · ${e.label}${e.detail ? ` — ${e.detail}` : ''}`;
}

const MATCH = 1;
/** A character at the start of a word ("D" of "Duplicate", "S" of "fadeScale"). */
const WORD_START = 6;
/** A character right after the previous match: runs beat scattered letters. */
const RUN = 4;
/** Each jump between matched characters. */
const GAP = 1;

const isWordChar = (c: string) => /[\p{L}\p{N}]/u.test(c);

function wordStarts(text: string): boolean[] {
  return Array.from({ length: text.length }, (_, i) => {
    const c = text[i];
    if (i === 0) return isWordChar(c);
    const prev = text[i - 1];
    if (!isWordChar(prev)) return isWordChar(c);
    // camelCase and digit boundaries: "fadeScale", "Scene2".
    return (c !== c.toLowerCase() && prev === prev.toLowerCase() && prev !== prev.toUpperCase()) || (/\d/.test(c) && !/\d/.test(prev));
  });
}

/**
 * The best placement of one query word as a subsequence of `text`
 * (case-insensitive): word starts and unbroken runs score most. null when the
 * letters don't all appear in order.
 */
function matchWord(word: string, text: string, starts: boolean[]): { score: number; positions: number[] } | null {
  const q = word.toLowerCase();
  const t = text.toLowerCase();
  const m = q.length;
  const n = t.length;
  if (m === 0 || m > n) return null;
  // best[i][j]: the best score with q[i] placed on t[j]; from[i][j]: where q[i-1] sat.
  const best: Float64Array[] = [];
  const from: Int32Array[] = [];
  for (let i = 0; i < m; i++) {
    const row = new Float64Array(n).fill(-Infinity);
    const back = new Int32Array(n).fill(-1);
    const prev = best[i - 1];
    // The best placement of q[i-1] at or before j-2 (a jump), carried along j.
    let jump = -Infinity;
    let jumpAt = -1;
    for (let j = i; j < n; j++) {
      if (prev && j >= 2 && prev[j - 2] > jump) {
        jump = prev[j - 2];
        jumpAt = j - 2;
      }
      if (t[j] !== q[i]) continue;
      const here = MATCH + (starts[j] ? WORD_START : 0);
      if (!prev) {
        row[j] = here;
        continue;
      }
      const run = j >= 1 ? prev[j - 1] + RUN : -Infinity;
      const gap = jump - GAP;
      if (run === -Infinity && gap === -Infinity) continue;
      if (run >= gap) {
        row[j] = here + run;
        back[j] = j - 1;
      } else {
        row[j] = here + gap;
        back[j] = jumpAt;
      }
    }
    best.push(row);
    from.push(back);
  }
  let end = -1;
  for (let j = 0; j < n; j++) if (best[m - 1][j] > (end < 0 ? -Infinity : best[m - 1][end])) end = j;
  if (end < 0 || best[m - 1][end] === -Infinity) return null;
  const positions: number[] = [];
  for (let i = m - 1, j = end; i >= 0; j = from[i][j], i--) positions.unshift(j);
  return { score: best[m - 1][end], positions };
}

/**
 * Score `text` for `query`: every word of the query must appear as a
 * subsequence, in any order ("scene dup" finds "Scene · Duplicate scene").
 * Higher is better; null is no match. An empty query matches with score 0.
 */
export function fuzzyMatch(query: string, text: string): { score: number; positions: number[] } | null {
  const words = query.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return { score: 0, positions: [] };
  const starts = wordStarts(text);
  let score = 0;
  const hit = new Set<number>();
  for (const w of words) {
    const m = matchWord(w, text, starts);
    if (!m) return null;
    score += m.score;
    m.positions.forEach((p) => hit.add(p));
  }
  return { score, positions: [...hit].sort((a, b) => a - b) };
}

/** Keywords count for a little less than the words on screen. */
const KEYWORD_WEIGHT = 0.8;
/** Each letter matched in the detail (an element's scene) counts less, so "sh" finds "Shape" before everything in "Show". */
const DETAIL_COST = 3;

/**
 * The palette's list for `query`. Empty: the recent picks (most recent first)
 * that still exist, then everything else in its given order. Otherwise: the
 * entries that match, best first; ties keep the given order, shorter lines
 * first.
 */
export function rankEntries<T extends PaletteEntry>(entries: readonly T[], query: string, recent: readonly string[] = []): Ranked<T>[] {
  if (!query.trim()) {
    const byId = new Map(entries.map((e) => [e.id, e]));
    const firsts = recent.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
    const shown = new Set(firsts.map((e) => e.id));
    return [...firsts.map((entry) => ({ entry, positions: [], recent: true })), ...entries.filter((e) => !shown.has(e.id)).map((entry) => ({ entry, positions: [] }))];
  }
  const scored: { r: Ranked<T>; score: number; index: number; length: number }[] = [];
  entries.forEach((entry, index) => {
    const text = paletteText(entry);
    const onScreen = fuzzyMatch(query, text);
    const detailAt = entry.detail ? text.length - entry.detail.length : Infinity;
    let score = onScreen ? onScreen.score - DETAIL_COST * onScreen.positions.filter((p) => p >= detailAt).length : -Infinity;
    for (const k of entry.keywords ?? []) {
      const m = fuzzyMatch(query, k);
      if (m && m.score * KEYWORD_WEIGHT > score) score = m.score * KEYWORD_WEIGHT;
    }
    if (score === -Infinity) return;
    scored.push({ r: { entry, positions: onScreen?.positions ?? [] }, score, index, length: text.length });
  });
  return scored.sort((a, b) => b.score - a.score || a.length - b.length || a.index - b.index).map((s) => s.r);
}

/** The recent list after picking `id`: it moves to the front; the list keeps `max`. */
export function pushRecent(recent: readonly string[], id: string, max = 8): string[] {
  return [id, ...recent.filter((r) => r !== id)].slice(0, max);
}

/** A stored recent list, or empty for anything unexpected. */
export function parseRecent(raw: string | null | undefined): string[] {
  try {
    const v: unknown = JSON.parse(raw ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 8) : [];
  } catch {
    return [];
  }
}

/**
 * A printed shortcut (shortcutText) as key caps: "⇧⌘Z" → ⇧ ⌘ Z on a Mac,
 * "Ctrl+Shift+Z" → Ctrl Shift Z elsewhere. `key` is the shortcut's own key;
 * empty for a modifier held during a gesture (⇧ + drag).
 */
export function splitShortcut(printed: string, key: string): string[] {
  const mods = printed.slice(0, printed.length - key.length);
  const caps = mods.includes('+') ? mods.split('+').filter(Boolean) : [...mods];
  return key ? [...caps, key] : caps;
}

/** The same key and modifiers. */
export function sameShortcut(a: Shortcut, b: Shortcut): boolean {
  return a.key.toLowerCase() === b.key.toLowerCase() && !!a.mod === !!b.mod && !!a.shift === !!b.shift && !!a.alt === !!b.alt;
}
