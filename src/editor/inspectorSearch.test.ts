import { describe, expect, it } from 'vitest';
import { FIELD_ALIASES, fieldMatches, queryTokens, words } from './inspectorSearch';

const match = (query: string, entry: Parameters<typeof fieldMatches>[0]) => fieldMatches(entry, queryTokens(query));

describe('inspector search', () => {
  it('tokenises the query; a blank query matches everything', () => {
    expect(queryTokens('  Stroke   width ')).toEqual(['stroke', 'width']);
    expect(queryTokens('')).toEqual([]);
    expect(match('', { label: 'X' })).toBe(true);
  });

  it('splits camelCase and dotted keys into words', () => {
    expect(words('strokeWidth')).toBe('stroke width');
    expect(words('effects.dropShadow')).toBe('effects drop shadow');
  });

  it('matches labels, keys and section titles, case-insensitively, every token', () => {
    expect(match('font', { label: 'Size', key: 'fontSize', section: 'Properties' })).toBe(true);
    expect(match('size', { label: 'Size', key: 'fontSize' })).toBe(true);
    expect(match('font size', { label: 'Size', key: 'fontSize' })).toBe(true);
    expect(match('font colour', { label: 'Size', key: 'fontSize' })).toBe(false);
    expect(match('APPEAR', { label: 'Blur', key: 'effects.blur', section: 'Appearance' })).toBe(true);
    expect(match('layout', { label: 'Blur', key: 'effects.blur', section: 'Appearance' })).toBe(false);
  });

  it('matches aliases', () => {
    expect(match('position', { label: 'X', key: 'x', aliases: FIELD_ALIASES.x })).toBe(true);
    expect(match('matte', { label: 'Mask', key: 'mask', aliases: FIELD_ALIASES.mask })).toBe(true);
    expect(match('colour', { label: 'Accent', key: 'accentColor', aliases: FIELD_ALIASES.accentColor })).toBe(true);
    expect(match('alpha', { label: 'Opacity', key: 'opacity', aliases: FIELD_ALIASES.opacity })).toBe(true);
    // The scene's entrance row holds its kind and its length.
    expect(match('transition length', { label: 'Entrance', key: 'transition', aliases: FIELD_ALIASES.transition })).toBe(true);
  });
});
