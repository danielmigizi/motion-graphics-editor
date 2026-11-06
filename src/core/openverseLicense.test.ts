import { describe, expect, it } from 'vitest';
import {
  ALLOWED_OPENVERSE_LICENSES,
  OPENVERSE_LICENSE_QUERY,
  isAllowedOpenverseLicense,
  normalizeOpenverseLicense,
  openverseLengthBucket,
  rejectOpenverseLicense,
} from './openverseLicense';

describe('Openverse license guardrail', () => {
  it('allows only cc0 and by, in the catalog query', () => {
    expect(ALLOWED_OPENVERSE_LICENSES).toEqual(['cc0', 'by']);
    expect(OPENVERSE_LICENSE_QUERY).toBe('cc0,by');
  });

  it.each(['cc0', 'CC0', 'CC0 1.0', 'by', 'CC-BY', 'CC BY 4.0', 'cc-by-4.0'])('accepts %s', (raw) => {
    expect(isAllowedOpenverseLicense(raw)).toBe(true);
    expect(rejectOpenverseLicense(raw)).toBeNull();
  });

  it.each([
    'by-sa',
    'CC-BY-SA',
    'by-nc',
    'by-nc-sa',
    'by-nd',
    'by-nc-nd',
    'pdm',
    'sampling+',
    'nc-sampling+',
    '',
    undefined,
  ])('rejects %s', (raw) => {
    expect(isAllowedOpenverseLicense(raw)).toBe(false);
    expect(rejectOpenverseLicense(raw)).toMatch(/not allowed|CC0 and CC BY/i);
  });

  it('normalises catalog shortcodes', () => {
    expect(normalizeOpenverseLicense('CC-BY-SA 4.0')).toBe('by-sa');
    expect(normalizeOpenverseLicense(' cc0 ')).toBe('cc0');
  });

  it('maps duration to Openverse length buckets', () => {
    expect(openverseLengthBucket(10)).toBe('shortest');
    expect(openverseLengthBucket(45)).toBe('short');
    expect(openverseLengthBucket(180)).toBe('medium');
    expect(openverseLengthBucket(400)).toBe('long');
  });
});
