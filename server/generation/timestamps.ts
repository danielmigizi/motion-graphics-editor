import type { GeneratedOutputMeta } from '../../src/core/generationStudio';

type Word = NonNullable<GeneratedOutputMeta['words']>[number];
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const time = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** Provider timing metadata is optional: malformed entries never prevent an import. */
export function parseWords(timestamps: unknown): GeneratedOutputMeta['words'] {
  if (Array.isArray(timestamps)) {
    const words = timestamps.flatMap((entry): Word[] => {
      if (!object(entry)) return [];
      const text = entry.word ?? entry.text;
      const start = entry.start ?? entry.start_time;
      const end = entry.end ?? entry.end_time;
      return typeof text === 'string' && text.trim() && time(start) && time(end) && end >= start
        ? [{ text: text.trim(), start, end }] : [];
    });
    return words.length ? words : undefined;
  }
  if (!object(timestamps)) return undefined;
  const { characters, character_start_times_seconds: starts, character_end_times_seconds: ends } = timestamps;
  if (!Array.isArray(characters) || !Array.isArray(starts) || !Array.isArray(ends)
    || characters.length !== starts.length || characters.length !== ends.length
    || !characters.every((c) => typeof c === 'string')) return undefined;
  const words: Word[] = [];
  let word: Word | undefined;
  let invalid = false;
  const flush = () => {
    if (word && !invalid) words.push(word);
    word = undefined;
    invalid = false;
  };
  for (let i = 0; i < characters.length; i++) {
    for (const char of characters[i] as string) {
      if (/\s/u.test(char)) { flush(); continue; }
      const start: unknown = starts[i], end: unknown = ends[i];
      if (!time(start) || !time(end) || end < start) { invalid = true; continue; }
      if (word) { word.text += char; word.end = end; if (end < word.start) invalid = true; }
      else word = { text: char, start, end };
    }
  }
  flush();
  return words.length ? words : undefined;
}
