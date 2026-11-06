/** Restricted deterministic CSS colour parser. RGB channels are 0..255, alpha 0..1. */
export function parseColor(value: unknown): [number, number, number, number] | null {
  if (typeof value !== 'string') return null;
  if (/^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) {
    let hex = value.slice(1);
    if (hex.length === 3) hex = [...hex].map(c => c + c).join('');
    return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16), hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1];
  }
  const m = /^(rgb|rgba)\(\s*([+-]?(?:\d*\.)?\d+)\s*,\s*([+-]?(?:\d*\.)?\d+)\s*,\s*([+-]?(?:\d*\.)?\d+)(?:\s*,\s*([+-]?(?:\d*\.)?\d+))?\s*\)$/i.exec(value);
  if (!m || (m[1].toLowerCase() === 'rgba') !== (m[5] !== undefined)) return null;
  const channels: [number, number, number, number] = [Number(m[2]), Number(m[3]), Number(m[4]), m[5] === undefined ? 1 : Number(m[5])];
  return channels.every((v, i) => Number.isFinite(v) && v >= 0 && v <= (i === 3 ? 1 : 255)) ? channels : null;
}

export function interpolateColor(a: string, b: string, t: number): string | undefined {
  const ca = parseColor(a), cb = parseColor(b);
  if (!ca || !cb) return undefined;
  const linear = (v: number) => (v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const encode = (v: number) => Math.round(255 * Math.max(0, Math.min(1, v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)));
  const rgb = [0, 1, 2].map(i => encode(linear(ca[i]) + (linear(cb[i]) - linear(ca[i])) * t));
  const alpha = Math.max(0, Math.min(1, ca[3] + (cb[3] - ca[3]) * t));
  return `rgba(${rgb.join(', ')}, ${Number(alpha.toFixed(6))})`;
}
