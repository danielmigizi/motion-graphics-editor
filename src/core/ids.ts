// ID generation for new entities created in the editor. Never used inside the
// render path. Prefixes make IDs readable in prompts and diffs.

export function newId(prefix: 'prj' | 'scn' | 'el' | 'ast' | 'aud' | 'req' | 'prop'): string {
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
