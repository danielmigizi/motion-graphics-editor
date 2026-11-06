// Pure text splitting and ordering for the per-unit text reveals. No layout
// measurement: units are decided from the string alone, so the preview and
// the export split identically.

export type TextToken = { kind: 'space'; text: string } | { kind: 'word'; chars: string[] };

let segmenter: Intl.Segmenter | null | undefined;

/** User-perceived characters (grapheme clusters), so emoji and combining marks stay whole. */
export function graphemes(s: string): string[] {
  if (segmenter === undefined) segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
  return segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);
}

/** Words (split into characters) and the whitespace runs between them, in order. */
export function splitWords(text: string): TextToken[] {
  return text
    .split(/(\s+)/)
    .filter((t) => t !== '')
    .map((t) => (/^\s+$/.test(t) ? { kind: 'space', text: t } : { kind: 'word', chars: graphemes(t) }));
}

/**
 * Lines for 'lineStagger': split on explicit newlines only (soft wraps are
 * layout-dependent and never define units). A single trailing newline does not
 * add a line, matching how the unsplit text lays out.
 */
export function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/**
 * Start slot of each of `n` units (slot × revealStagger = start frame).
 * forward: 0..n-1; reverse: n-1..0; center: middle first, outward; edges:
 * both ends first, inward. Units equidistant from the middle share a slot.
 */
export function revealSlots(n: number, order: string): number[] {
  const c = (n - 1) / 2;
  return Array.from({ length: n }, (_, i) => {
    switch (order) {
      case 'reverse':
        return n - 1 - i;
      case 'center':
        return Math.abs(i - c) - (c % 1);
      case 'edges':
        return c - Math.abs(i - c);
      default:
        return i;
    }
  });
}
