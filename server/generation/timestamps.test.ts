import { describe, expect, it } from 'vitest';
import { parseWords } from './timestamps';

describe('optional narration timestamps', () => {
  it('accepts both word array field spellings and skips malformed entries', () => {
    expect(parseWords([{ word: ' Hello ', start: 0, end: 0.4 }, null, { text: 'world', start_time: 0.5, end_time: 0.9 },
      { word: 'bad', start: -1, end: 2 }, { word: 'bad', start: 2, end: 1 }, { word: 'bad', start: NaN, end: 2 }]))
      .toEqual([{ text: 'Hello', start: 0, end: 0.4 }, { text: 'world', start: 0.5, end: 0.9 }]);
  });
  it('folds characters into words at whitespace, including the final word', () => {
    const characters = [...' Hi\tthere\n'];
    expect(parseWords({ characters, character_start_times_seconds: characters.map((_, i) => i / 10), character_end_times_seconds: characters.map((_, i) => (i + 1) / 10) }))
      .toEqual([{ text: 'Hi', start: 0.1, end: 0.3 }, { text: 'there', start: 0.4, end: 0.9 }]);
    expect(parseWords({ characters: ['H', 'i'], character_start_times_seconds: [0, 0.1], character_end_times_seconds: [0.1, 0.2] }))
      .toEqual([{ text: 'Hi', start: 0, end: 0.2 }]);
  });
  it.each([undefined, null, 'unknown', 4, {}, [], [{ text: 'missing timing' }],
    { characters: ['a'], character_start_times_seconds: [], character_end_times_seconds: [1] },
    { characters: [5], character_start_times_seconds: [0], character_end_times_seconds: [1] },
    { characters: ['a'], character_start_times_seconds: [0], character_end_times_seconds: [Infinity] },
  ])('ignores unknown or malformed shape %j', (raw) => { expect(parseWords(raw)).toBeUndefined(); });
});
