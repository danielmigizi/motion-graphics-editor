// Inspector property search: which fields stay visible for a query. Pure —
// the inspector feeds each field's label, key and section title through
// fieldMatches(); fields that don't match render nothing.

/** Lower-case words of a query. Empty for a blank query (= no filter). */
export function queryTokens(query: string): string[] {
  return query.toLowerCase().split(/[\s,]+/).filter(Boolean);
}

/** "strokeWidth" → "stroke width", "effects.dropShadow" → "effects drop shadow". */
export function words(text: string): string {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[._\-()/]+/g, ' ')
    .toLowerCase();
}

export interface FieldSearchEntry {
  label: string;
  /** Stable field key, e.g. 'x', 'fontSize', 'effects.blur'. */
  key?: string;
  /** Section title, so "appearance" lists the whole Appearance section. */
  section?: string;
  /** Extra words people may type for this field (e.g. 'position' for x/y). */
  aliases?: readonly string[];
}

/** Every token must occur in the field's label, key, section or aliases (substring, case-insensitive). */
export function fieldMatches(entry: FieldSearchEntry, tokens: readonly string[]): boolean {
  if (tokens.length === 0) return true;
  const hay = [entry.label, entry.key ?? '', entry.section ?? '', ...(entry.aliases ?? [])]
    .map((s) => `${s.toLowerCase()} ${words(s)}`)
    .join(' | ');
  return tokens.every((t) => hay.includes(t));
}

/** Words people use for fields whose label is terse. Keyed by field key. */
export const FIELD_ALIASES: Record<string, readonly string[]> = {
  x: ['position', 'left', 'horizontal'],
  y: ['position', 'top', 'vertical'],
  width: ['size', 'w'],
  height: ['size', 'h'],
  rotation: ['angle', 'rotate', 'turn'],
  scale: ['size', 'zoom'],
  opacity: ['alpha', 'transparency', 'fade'],
  startFrame: ['in', 'begin', 'time'],
  durationInFrames: ['length', 'out', 'time'],
  fontSize: ['text size', 'type size'],
  letterSpacing: ['tracking', 'kerning'],
  blendMode: ['mix', 'composite'],
  'effects.blur': ['filter', 'soften'],
  'effects.brightness': ['filter', 'light', 'exposure'],
  'effects.contrast': ['filter'],
  'effects.saturate': ['filter', 'saturation', 'colour', 'color'],
  'effects.dropShadow': ['shadow', 'filter'],
  mask: ['matte', 'clip', 'track matte'],
  color: ['colour', 'color', 'fill'],
  textColor: ['colour', 'color'],
  accentColor: ['colour', 'color'],
  background: ['colour', 'color', 'fill'],
  bubbleColor: ['colour', 'color', 'fill'],
  backgroundColor: ['colour', 'color', 'fill'],
  fill: ['colour', 'color', 'gradient', 'paint'],
  stroke: ['outline', 'border', 'colour', 'color', 'gradient', 'paint'],
  trimStart: ['trim', 'draw', 'reveal'],
  trimEnd: ['trim', 'draw', 'reveal'],
  trimOffset: ['trim', 'draw'],
  transition: ['entrance', 'length', 'fade', 'wipe', 'slide'],
};
