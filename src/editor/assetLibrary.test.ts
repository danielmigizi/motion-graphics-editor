// The Assets library's filters, search, sort orders and remembered choices.

import { describe, expect, it } from 'vitest';
import type { Asset } from '../core/types';
import { filterCounts, libraryItems, matchesQuery, parseLibraryPrefs } from './assetLibrary';

const asset = (id: string, changes: Partial<Asset> = {}): Asset => ({ id, kind: 'image', name: id, src: `assets/${id}.png`, mimeType: 'image/png', ...changes });

// In date-added order, as the document keeps them.
const assets = [
  asset('meadow', { name: 'Meadow to ocean' }),
  asset('logo', { kind: 'svg', name: 'Logo', mimeType: 'image/svg+xml' }),
  asset('waves', { kind: 'audio', name: 'Pacific waves', mimeType: 'audio/mpeg' }),
  asset('kitchen', { name: 'Kitchen island', provenance: { source: 'generated', prompt: 'A warm kitchen at dusk', model: 'FLUX 3 Max' } }),
  asset('drone', { kind: 'video', name: 'drone pass', mimeType: 'video/mp4' }),
  asset('style', { name: 'Style frame', reference: true }),
];

const ids = (list: Asset[]) => list.map((a) => a.id);

describe('the library', () => {
  it('counts each filter; images include SVGs', () => {
    expect(filterCounts(assets)).toEqual({ all: 6, image: 4, video: 1, audio: 1, generated: 1, reference: 1 });
  });

  it('lists newest first by default and oldest first on request', () => {
    expect(ids(libraryItems(assets, { filter: 'all', sort: 'newest', query: '' }))).toEqual(['style', 'drone', 'kitchen', 'waves', 'logo', 'meadow']);
    expect(ids(libraryItems(assets, { filter: 'all', sort: 'oldest', query: '' }))).toEqual(['meadow', 'logo', 'waves', 'kitchen', 'drone', 'style']);
  });

  it('sorts by name ignoring case, and by kind then name', () => {
    expect(ids(libraryItems(assets, { filter: 'all', sort: 'name', query: '' }))).toEqual(['drone', 'kitchen', 'logo', 'meadow', 'waves', 'style']);
    expect(ids(libraryItems(assets, { filter: 'all', sort: 'kind', query: '' }))).toEqual(['kitchen', 'meadow', 'style', 'logo', 'drone', 'waves']);
  });

  it('sorts by size (unknown last) and by uses, ties newest first', () => {
    const bytes = (a: Asset) => ({ meadow: 369_000, kitchen: 183_000, drone: 9_000_000 })[a.id as 'meadow'];
    expect(ids(libraryItems(assets, { filter: 'image', sort: 'size', query: '', bytes }))).toEqual(['meadow', 'kitchen', 'style', 'logo']);
    const uses = new Map([['logo', 3], ['meadow', 1]]);
    expect(ids(libraryItems(assets, { filter: 'all', sort: 'used', query: '', uses }))).toEqual(['logo', 'meadow', 'style', 'drone', 'kitchen', 'waves']);
  });

  it('filters by kind, by generated and by reference', () => {
    expect(ids(libraryItems(assets, { filter: 'video', sort: 'newest', query: '' }))).toEqual(['drone']);
    expect(ids(libraryItems(assets, { filter: 'generated', sort: 'newest', query: '' }))).toEqual(['kitchen']);
    expect(ids(libraryItems(assets, { filter: 'reference', sort: 'newest', query: '' }))).toEqual(['style']);
  });

  it('searches names, prompts and models; every word must match', () => {
    expect(matchesQuery(assets[3], 'dusk kitchen')).toBe(true);
    expect(matchesQuery(assets[3], 'flux')).toBe(true);
    expect(matchesQuery(assets[3], 'dusk ocean')).toBe(false);
    expect(ids(libraryItems(assets, { filter: 'all', sort: 'newest', query: 'OCEAN' }))).toEqual(['meadow']);
  });

  it('reads remembered choices, falling back on anything unknown', () => {
    expect(parseLibraryPrefs('{"filter":"video","sort":"name","view":"grid"}')).toEqual({ filter: 'video', sort: 'name', view: 'grid' });
    expect(parseLibraryPrefs('{"filter":"nope","sort":3}')).toEqual({ filter: 'all', sort: 'newest', view: 'list' });
    expect(parseLibraryPrefs('not json')).toEqual({ filter: 'all', sort: 'newest', view: 'list' });
    expect(parseLibraryPrefs(null)).toEqual({ filter: 'all', sort: 'newest', view: 'list' });
  });
});
