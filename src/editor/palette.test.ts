import { describe, expect, it } from 'vitest';
import { fuzzyMatch, paletteText, parseRecent, pushRecent, rankEntries, sameShortcut, splitShortcut, type PaletteEntry } from './palette';

// A stand-in for the registry (actions.ts ACTIONS is filled by the menus), plus scenes, elements and settings.
const ENTRIES: PaletteEntry[] = [
  { id: 'action:edit.undo', prefix: 'Edit', label: 'Undo' },
  { id: 'action:edit.duplicate', prefix: 'Edit', label: 'Duplicate', keywords: ['copy', 'clone'] },
  { id: 'action:edit.delete', prefix: 'Edit', label: 'Delete' },
  { id: 'action:scene.duplicate', prefix: 'Scene', label: 'Duplicate scene' },
  { id: 'action:view.timeline', prefix: 'View', label: 'Timeline' },
  { id: 'scene:scn_1', prefix: 'Go to scene', label: 'Open' },
  { id: 'scene:scn_2', prefix: 'Go to scene', label: 'Music scene' },
  { id: 'element:scn_1/el_1', prefix: 'Select', label: 'Headline', detail: 'Open' },
  { id: 'element:scn_2/el_2', prefix: 'Select', label: 'Subhead', detail: 'Music scene' },
  { id: 'setting:theme', prefix: 'Settings', label: 'Theme', keywords: ['dark', 'light', 'appearance'] },
  { id: 'setting:format', prefix: 'Settings', label: 'Size and frame rate', keywords: ['fps', 'resolution'] },
];

const ids = (query: string, recent: string[] = []) => rankEntries(ENTRIES, query, recent).map((r) => r.entry.id);

describe('paletteText', () => {
  it('reads prefix · label — detail', () => {
    expect(paletteText(ENTRIES[1])).toBe('Edit · Duplicate');
    expect(paletteText(ENTRIES[7])).toBe('Select · Headline — Open');
  });
});

describe('fuzzyMatch', () => {
  it('matches letters in order, case-insensitively, and nothing else', () => {
    expect(fuzzyMatch('dpl', 'Duplicate')).not.toBeNull();
    expect(fuzzyMatch('DUP', 'duplicate')).not.toBeNull();
    expect(fuzzyMatch('pud', 'Duplicate')).toBeNull();
    expect(fuzzyMatch('x', 'Duplicate')).toBeNull();
  });

  it('places letters on word starts and runs rather than scattered', () => {
    // "sc" could take the s and c of "Music"; the start of "scene" is better.
    expect(fuzzyMatch('sc', 'Music scene')?.positions).toEqual([6, 7]);
    // "ds": the starts of both words.
    expect(fuzzyMatch('ds', 'Duplicate scene')?.positions).toEqual([0, 10]);
  });

  it('scores a word start above a letter inside a word', () => {
    expect(fuzzyMatch('t', 'Theme')!.score).toBeGreaterThan(fuzzyMatch('t', 'Fit')!.score);
    expect(fuzzyMatch('sh', 'Subhead')!.score).toBeLessThan(fuzzyMatch('sh', 'Shape')!.score);
  });

  it('counts camelCase and digits as word starts', () => {
    expect(fuzzyMatch('s', 'fadeScale')!.score).toBe(fuzzyMatch('s', 'Scale')!.score);
    expect(fuzzyMatch('2', 'Scene2')!.score).toBe(fuzzyMatch('2', 'Scene 2')!.score);
  });

  it('takes each word of the query on its own, in any order', () => {
    expect(fuzzyMatch('scene dup', 'Scene · Duplicate scene')).not.toBeNull();
    expect(fuzzyMatch('dup scene', 'Scene · Duplicate scene')).not.toBeNull();
    expect(fuzzyMatch('dup zz', 'Scene · Duplicate scene')).toBeNull();
  });

  it('matches everything with an empty query', () => {
    expect(fuzzyMatch('  ', 'Anything')).toEqual({ score: 0, positions: [] });
  });
});

describe('rankEntries', () => {
  it('ranks the tightest match first and drops the rest', () => {
    const r = ids('dup');
    expect(r.slice(0, 2)).toEqual(['action:edit.duplicate', 'action:scene.duplicate']);
    expect(r).not.toContain('action:edit.undo');
  });

  it('ranks word-start hits above letters found inside words', () => {
    expect(ids('sub')[0]).toBe('element:scn_2/el_2');
    expect(ids('tl')[0]).toBe('action:view.timeline');
  });

  it('finds elements by the scene they are in, after those named so', () => {
    expect(ids('headline open')).toEqual(['element:scn_1/el_1']);
    // "Music" is Subhead's scene but the note's own (longer) name: the name wins.
    const entries = [...ENTRIES, { id: 'element:scn_1/el_9', prefix: 'Select', label: 'Musical note, left side', detail: 'Open' }];
    const order = rankEntries(entries, 'music').map((r) => r.entry.id);
    expect(order.indexOf('element:scn_1/el_9')).toBeLessThan(order.indexOf('element:scn_2/el_2'));
  });

  it('matches keywords, below the same words on screen', () => {
    expect(ids('dark')).toEqual(['setting:theme']);
    expect(ids('fps')).toEqual(['setting:format']);
    expect(ids('copy')).toContain('action:edit.duplicate');
    // A keyword hit carries no highlight.
    expect(rankEntries(ENTRIES, 'dark')[0].positions).toEqual([]);
  });

  it('returns highlight positions into the whole line', () => {
    const [top] = rankEntries(ENTRIES, 'theme');
    expect(top.entry.id).toBe('setting:theme');
    expect(top.positions).toEqual([11, 12, 13, 14, 15]);
    expect(paletteText(top.entry).slice(11, 16)).toBe('Theme');
  });

  it('lists recent picks first while the query is empty, then everything in order', () => {
    const r = rankEntries(ENTRIES, '', ['setting:theme', 'gone:id', 'scene:scn_2']);
    expect(r.map((x) => x.entry.id).slice(0, 3)).toEqual(['setting:theme', 'scene:scn_2', 'action:edit.undo']);
    expect(r.filter((x) => x.recent).length).toBe(2);
    expect(r).toHaveLength(ENTRIES.length);
  });

  it('keeps recent picks out of a search order', () => {
    expect(ids('dup', ['action:scene.duplicate'])[0]).toBe('action:edit.duplicate');
  });
});

describe('recent picks', () => {
  it('moves a pick to the front, without repeats, keeping eight', () => {
    expect(pushRecent(['a', 'b', 'c'], 'b')).toEqual(['b', 'a', 'c']);
    const many = pushRecent(['1', '2', '3', '4', '5', '6', '7', '8'], 'new');
    expect(many).toHaveLength(8);
    expect(many[0]).toBe('new');
  });

  it('reads back a stored list, or nothing', () => {
    expect(parseRecent('["a","b"]')).toEqual(['a', 'b']);
    expect(parseRecent('[1,"a",null]')).toEqual(['a']);
    expect(parseRecent('{"a":1}')).toEqual([]);
    expect(parseRecent('not json')).toEqual([]);
    expect(parseRecent(null)).toEqual([]);
  });
});

describe('splitShortcut', () => {
  it('splits Mac glyphs into caps', () => {
    expect(splitShortcut('⇧⌘Z', 'Z')).toEqual(['⇧', '⌘', 'Z']);
    expect(splitShortcut('⌥←', '←')).toEqual(['⌥', '←']);
    expect(splitShortcut('Space', 'Space')).toEqual(['Space']);
  });

  it('splits the words used elsewhere', () => {
    expect(splitShortcut('Ctrl+Shift+Z', 'Z')).toEqual(['Ctrl', 'Shift', 'Z']);
    expect(splitShortcut('Alt+←', '←')).toEqual(['Alt', '←']);
    expect(splitShortcut('Ctrl++', '+')).toEqual(['Ctrl', '+']);
  });

  it('leaves just the modifiers for a held key', () => {
    expect(splitShortcut('⇧', '')).toEqual(['⇧']);
    expect(splitShortcut('Shift+', '')).toEqual(['Shift']);
  });
});

describe('sameShortcut', () => {
  it('compares the key (any case) and every modifier', () => {
    expect(sameShortcut({ key: 'z', mod: true }, { key: 'Z', mod: true, shift: false })).toBe(true);
    expect(sameShortcut({ key: 'Z', mod: true }, { key: 'Z', mod: true, shift: true })).toBe(false);
    expect(sameShortcut({ key: '←', alt: true }, { key: '←' })).toBe(false);
  });
});
