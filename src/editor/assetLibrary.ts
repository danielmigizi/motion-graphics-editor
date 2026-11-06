// The Assets library's filters, sort orders and search (AssetsPanel.tsx), and
// the choices it remembers per browser. "Date added" is the order assets came
// into the project: the document keeps them in that order.

import type { Asset } from '../core/types';

export type LibraryFilter = 'all' | 'image' | 'video' | 'audio' | 'generated' | 'reference';
export type LibrarySort = 'newest' | 'oldest' | 'name' | 'kind' | 'size' | 'used';
export type LibraryView = 'list' | 'grid';

export const LIBRARY_FILTERS: { id: LibraryFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'image', label: 'Images' },
  { id: 'video', label: 'Video' },
  { id: 'audio', label: 'Audio' },
  { id: 'generated', label: 'Generated' },
  { id: 'reference', label: 'References' },
];

export const LIBRARY_SORTS: { id: LibrarySort; label: string; short: string }[] = [
  { id: 'newest', label: 'Newest first', short: 'Newest' },
  { id: 'oldest', label: 'Oldest first', short: 'Oldest' },
  { id: 'name', label: 'Name, A to Z', short: 'Name' },
  { id: 'kind', label: 'Kind, then name', short: 'Kind' },
  { id: 'size', label: 'File size, largest first', short: 'Size' },
  { id: 'used', label: 'Most used first', short: 'Most used' },
];

const KIND_ORDER: Record<Asset['kind'], number> = { image: 0, svg: 1, video: 2, audio: 3 };

export function matchesFilter(a: Asset, filter: LibraryFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'image':
      return a.kind === 'image' || a.kind === 'svg';
    case 'generated':
      return a.provenance?.source === 'generated';
    case 'reference':
      return !!a.reference;
    default:
      return a.kind === filter;
  }
}

export function filterCounts(assets: readonly Asset[]): Record<LibraryFilter, number> {
  const out = Object.fromEntries(LIBRARY_FILTERS.map((f) => [f.id, 0])) as Record<LibraryFilter, number>;
  for (const a of assets) for (const f of LIBRARY_FILTERS) if (matchesFilter(a, f.id)) out[f.id]++;
  return out;
}

/** The query matches the name, the prompt it was generated from, or its kind; every word must match. */
export function matchesQuery(a: Asset, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${a.name} ${a.provenance?.prompt ?? ''} ${a.kind} ${a.provenance?.model ?? ''}`.toLowerCase();
  return words.every((w) => hay.includes(w));
}

const byName = (x: Asset, y: Asset) => x.name.localeCompare(y.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * The library's rows: `assets` in date-added order, filtered, searched and
 * sorted. Ties fall back to newest first, so the order never jumps.
 * `bytes` and `uses` give file sizes (unknown sorts last) and use counts.
 */
export function libraryItems(assets: readonly Asset[], opts: { filter: LibraryFilter; sort: LibrarySort; query: string; bytes?: (a: Asset) => number | undefined; uses?: ReadonlyMap<string, number> }): Asset[] {
  const added = new Map(assets.map((a, i) => [a.id, i]));
  const newest = (x: Asset, y: Asset) => added.get(y.id)! - added.get(x.id)!;
  const rows = assets.filter((a) => matchesFilter(a, opts.filter) && matchesQuery(a, opts.query));
  const cmp: Record<LibrarySort, (x: Asset, y: Asset) => number> = {
    newest,
    oldest: (x, y) => -newest(x, y),
    name: (x, y) => byName(x, y) || newest(x, y),
    kind: (x, y) => KIND_ORDER[x.kind] - KIND_ORDER[y.kind] || byName(x, y) || newest(x, y),
    size: (x, y) => (opts.bytes?.(y) ?? -1) - (opts.bytes?.(x) ?? -1) || newest(x, y),
    used: (x, y) => (opts.uses?.get(y.id) ?? 0) - (opts.uses?.get(x.id) ?? 0) || newest(x, y),
  };
  return rows.sort(cmp[opts.sort]);
}

export interface LibraryPrefs {
  filter: LibraryFilter;
  sort: LibrarySort;
  view: LibraryView;
}

export const DEFAULT_LIBRARY_PREFS: LibraryPrefs = { filter: 'all', sort: 'newest', view: 'list' };

export function parseLibraryPrefs(raw: string | null | undefined): LibraryPrefs {
  try {
    const p = JSON.parse(raw ?? '{}') as Partial<Record<keyof LibraryPrefs, unknown>>;
    return {
      filter: LIBRARY_FILTERS.some((f) => f.id === p.filter) ? (p.filter as LibraryFilter) : DEFAULT_LIBRARY_PREFS.filter,
      sort: LIBRARY_SORTS.some((s) => s.id === p.sort) ? (p.sort as LibrarySort) : DEFAULT_LIBRARY_PREFS.sort,
      view: p.view === 'grid' || p.view === 'list' ? p.view : DEFAULT_LIBRARY_PREFS.view,
    };
  } catch {
    return DEFAULT_LIBRARY_PREFS;
  }
}
