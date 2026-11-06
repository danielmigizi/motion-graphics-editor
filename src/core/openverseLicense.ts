// Hard license guardrail for Openverse (and any catalog import that reuses it).
// The editor may only place CC0 and CC BY. NC, SA, ND, PDM, sampling+ and
// anything else are refused in code, even if a caller asked for them.

export const ALLOWED_OPENVERSE_LICENSES = ['cc0', 'by'] as const;
export type AllowedOpenverseLicense = (typeof ALLOWED_OPENVERSE_LICENSES)[number];

/** Comma list sent to Openverse; never caller-controlled. */
export const OPENVERSE_LICENSE_QUERY = ALLOWED_OPENVERSE_LICENSES.join(',');

export const OPENVERSE_NOTICE =
  'Audio search powered by Openverse (https://openverse.org/). Made with Openverse. Not endorsed or certified by Openverse.';

/** Lowercase shortcode: 'CC-BY-SA 4.0' → 'by-sa', 'cc0' → 'cc0'. */
export function normalizeOpenverseLicense(raw: string | null | undefined): string {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  s = s.replace(/^cc[-_\s]+/, '');
  s = s.replace(/\s+/g, '-');
  s = s.replace(/_+/g, '-');
  // Drop a trailing "4.0" / "-3.0" version, never the 0 in cc0.
  s = s.replace(/[-_]\d+(\.\d+)?$/, '');
  return s.replace(/-+$/g, '');
}

export function isAllowedOpenverseLicense(raw: string | null | undefined): raw is AllowedOpenverseLicense {
  const n = normalizeOpenverseLicense(raw);
  return n === 'cc0' || n === 'by';
}

export function rejectOpenverseLicense(raw: string | null | undefined): string | null {
  if (isAllowedOpenverseLicense(raw)) return null;
  const shown = typeof raw === 'string' && raw.trim() ? raw.trim() : '(missing)';
  return `License "${shown}" is not allowed. This editor only uses CC0 and CC BY (no NC, SA, ND, or other terms).`;
}

/** Openverse audio length buckets (duration is milliseconds in the API). */
export function openverseLengthBucket(durationSeconds: number): 'shortest' | 'short' | 'medium' | 'long' {
  if (durationSeconds < 30) return 'shortest';
  if (durationSeconds < 120) return 'short';
  if (durationSeconds < 350) return 'medium';
  return 'long';
}
