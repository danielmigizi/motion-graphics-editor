// Pure vector helpers for the renderer: paint (colour or gradient) to CSS and
// SVG, shape/path geometry, and the SVG track-matte image used by masks.
// No React and no DOM: every function is a deterministic function of its
// inputs, so the same strings come out of the preview and the export.

import type { Matrix } from '../core/animation';
import { parseColor } from '../core/color';
import { pathControlBounds, pathData, svgNumber, trimDash, type TrimDash } from '../core/path';
import type { Paint, PathNode } from '../core/types';

export type GradientPaint = Exclude<Paint, string>;

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const n = (v: number) => svgNumber(v);

export const isNoneColor = (c: string) => c === '' || c.toLowerCase() === 'none' || c.toLowerCase() === 'transparent';

export function isGradientPaint(value: unknown): value is GradientPaint {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { type?: unknown; stops?: unknown };
  return (v.type === 'linear' || v.type === 'radial') && Array.isArray(v.stops);
}

/** A stored paint prop, or `fallback` when it is neither a colour string nor a gradient. */
export function readPaint(value: unknown, fallback: Paint): Paint {
  return typeof value === 'string' || isGradientPaint(value) ? value : fallback;
}

/** True for "no paint" ('none', 'transparent' or empty). A gradient is never none. */
export const isNonePaint = (paint: Paint) => typeof paint === 'string' && isNoneColor(paint);

/**
 * CSS `background` value for a paint over a box. Gradient geometry matches
 * svgGradient() over the same box: a linear angle follows CSS (0deg points up,
 * 90deg right, the line spans the box corners); a radial gradient is the
 * ellipse inscribed in the box (`closest-side`).
 */
export function paintToCss(paint: Paint): string {
  if (typeof paint === 'string') return isNoneColor(paint) ? 'transparent' : paint;
  const stops = paint.stops.map((s) => `${s.color} ${svgNumber(s.offset * 100, 2)}%`).join(', ');
  return paint.type === 'linear' ? `linear-gradient(${n(paint.angle)}deg, ${stops})` : `radial-gradient(closest-side, ${stops})`;
}

export interface SvgGradientStop {
  offset: string;
  color: string;
  opacity: string;
}

export interface SvgGradient {
  tag: 'linearGradient' | 'radialGradient';
  /** SVG attribute names (valid as-is in markup and in React). */
  attrs: Record<string, string>;
  stops: SvgGradientStop[];
}

/**
 * An SVG gradient in userSpaceOnUse over a 0..width × 0..height box, with the
 * same geometry as paintToCss(). Stop colours are split into rgb + opacity so
 * alpha works in every SVG renderer. `alphaOnly` paints every stop black and
 * keeps its alpha (for track mattes, where only coverage matters).
 */
export function svgGradient(paint: GradientPaint, width: number, height: number, alphaOnly = false): SvgGradient {
  const stops = paint.stops.map((s) => {
    const c = parseColor(s.color);
    return {
      offset: svgNumber(s.offset, 4),
      color: alphaOnly ? '#000' : c ? `rgb(${c[0]}, ${c[1]}, ${c[2]})` : s.color,
      opacity: svgNumber(c ? c[3] : 1, 4),
    };
  });
  const cx = width / 2;
  const cy = height / 2;
  if (paint.type === 'linear') {
    const rad = (paint.angle * Math.PI) / 180;
    const dx = Math.sin(rad);
    const dy = -Math.cos(rad);
    // CSS gradient line: through the centre, long enough that the corners hit 0% and 100%.
    const half = (Math.abs(width * dx) + Math.abs(height * dy)) / 2;
    return {
      tag: 'linearGradient',
      attrs: { gradientUnits: 'userSpaceOnUse', x1: n(cx - dx * half), y1: n(cy - dy * half), x2: n(cx + dx * half), y2: n(cy + dy * half) },
      stops,
    };
  }
  const attrs: Record<string, string> = { gradientUnits: 'userSpaceOnUse', cx: n(cx), cy: n(cy), r: n(cx) };
  if (width !== height) attrs.gradientTransform = `translate(${n(cx)} ${n(cy)}) scale(1 ${svgNumber(height / width, 6)}) translate(${n(-cx)} ${n(-cy)})`;
  return { tag: 'radialGradient', attrs, stops };
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export type ShapeGeometry =
  | { kind: 'rect'; x: number; y: number; width: number; height: number; rx: number }
  | { kind: 'ellipse'; cx: number; cy: number; rx: number; ry: number };

export interface ShapeSpec {
  kind: 'shape';
  geometry: ShapeGeometry;
  /** null = not painted. */
  fill: Paint | null;
  stroke: Paint | null;
  strokeWidth: number;
}

export interface PathSpec {
  kind: 'path';
  d: string;
  nodes: readonly PathNode[];
  fill: Paint | null;
  stroke: Paint | null;
  strokeWidth: number;
  lineCap: string;
  lineJoin: string;
  /** Applies to the stroke only; the fill is never trimmed. */
  trim: TrimDash;
}

export type VectorSpec = ShapeSpec | PathSpec;

/** Shape geometry with the stroke kept inside the box, so the box stays the element's true bounds. */
export function buildShapeSpec(
  v: { shape: string; fill: Paint; stroke: Paint; strokeWidth: number; cornerRadius: number },
  width: number,
  height: number,
): ShapeSpec {
  const hasStroke = !isNonePaint(v.stroke) && v.strokeWidth > 0;
  const sw = hasStroke ? Math.min(Math.max(0, v.strokeWidth), width / 2, height / 2) : 0;
  const inset = sw / 2;
  const w = Math.max(0, width - sw);
  const h = Math.max(0, height - sw);
  const geometry: ShapeGeometry =
    v.shape === 'ellipse'
      ? { kind: 'ellipse', cx: width / 2, cy: height / 2, rx: w / 2, ry: h / 2 }
      : { kind: 'rect', x: inset, y: inset, width: w, height: h, rx: Math.min(Math.max(0, v.cornerRadius - inset), w / 2, h / 2) };
  return { kind: 'shape', geometry, fill: isNonePaint(v.fill) ? null : v.fill, stroke: hasStroke ? v.stroke : null, strokeWidth: sw };
}

export function buildPathSpec(v: {
  nodes: readonly PathNode[];
  closed: boolean;
  fill: Paint;
  stroke: Paint;
  strokeWidth: number;
  lineCap: string;
  lineJoin: string;
  trimStart: number;
  trimEnd: number;
  trimOffset: number;
}): PathSpec {
  const strokeWidth = Math.max(0, v.strokeWidth);
  const trim = trimDash(v.trimStart, v.trimEnd, v.trimOffset);
  const stroked = !isNonePaint(v.stroke) && strokeWidth > 0 && trim.visible;
  return {
    kind: 'path',
    d: pathData(v.nodes, v.closed),
    nodes: v.nodes,
    fill: isNonePaint(v.fill) ? null : v.fill,
    stroke: stroked ? v.stroke : null,
    strokeWidth,
    lineCap: v.lineCap,
    lineJoin: v.lineJoin,
    trim,
  };
}

/** Box (in the element's own pixels) that contains everything the spec paints. */
export function vectorBounds(spec: VectorSpec, width: number, height: number): Box {
  if (spec.kind === 'shape') return { x: 0, y: 0, width, height };
  const b = spec.nodes.length ? pathControlBounds(spec.nodes) : { x: 0, y: 0, width, height };
  // Miter joins reach up to miterlimit (4) × half the stroke width past the outline.
  const pad = spec.stroke ? spec.strokeWidth * 2 : 0;
  return { x: b.x - pad, y: b.y - pad, width: b.width + 2 * pad, height: b.height + 2 * pad };
}

// ---------------------------------------------------------------------------
// SVG markup (for data-URI images)
// ---------------------------------------------------------------------------

const escapeAttr = (v: string) => v.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function svgTag(name: string, attrs: Record<string, string | number | undefined>, children = ''): string {
  const a = Object.entries(attrs)
    .filter((e): e is [string, string | number] => e[1] !== undefined)
    .map(([k, v]) => ` ${k}="${escapeAttr(typeof v === 'number' ? n(v) : v)}"`)
    .join('');
  return children ? `<${name}${a}>${children}</${name}>` : `<${name}${a}/>`;
}

export function gradientMarkup(id: string, g: SvgGradient): string {
  const stops = g.stops.map((s) => svgTag('stop', { offset: s.offset, 'stop-color': s.color, 'stop-opacity': s.opacity })).join('');
  return svgTag(g.tag, { id, ...g.attrs }, stops);
}

/** Matte paint: black at the paint's alpha (a gradient keeps its per-stop alpha). */
function mattePaint(paint: Paint | null, id: string, width: number, height: number, defs: string[]): { paint: string; opacity?: string } {
  if (paint === null) return { paint: 'none' };
  if (typeof paint !== 'string') {
    defs.push(gradientMarkup(id, svgGradient(paint, width, height, true)));
    return { paint: `url(#${id})` };
  }
  const alpha = parseColor(paint)?.[3] ?? 1;
  return { paint: '#000', opacity: alpha < 1 ? svgNumber(alpha, 4) : undefined };
}

/** The spec's coverage (black, alpha-preserving) as SVG markup in the element's own pixels. */
function matteGeometry(spec: VectorSpec, width: number, height: number, defs: string[]): string {
  const fill = mattePaint(spec.fill, 'mf', width, height, defs);
  const stroke = mattePaint(spec.stroke, 'ms', width, height, defs);
  const paint = {
    fill: fill.paint,
    'fill-opacity': fill.opacity,
    stroke: stroke.paint,
    'stroke-opacity': stroke.opacity,
    'stroke-width': spec.stroke ? spec.strokeWidth : undefined,
  };
  if (spec.kind === 'path') {
    const dash = spec.stroke && spec.trim.visible ? spec.trim : undefined;
    return svgTag('path', {
      d: spec.d,
      ...paint,
      'stroke-linecap': spec.stroke ? spec.lineCap : undefined,
      'stroke-linejoin': spec.stroke ? spec.lineJoin : undefined,
      pathLength: dash?.dashArray ? 1 : undefined,
      'stroke-dasharray': dash?.dashArray,
      'stroke-dashoffset': dash?.dashOffset,
    });
  }
  const g = spec.geometry;
  return g.kind === 'ellipse'
    ? svgTag('ellipse', { cx: g.cx, cy: g.cy, rx: g.rx, ry: g.ry, ...paint })
    : svgTag('rect', { x: g.x, y: g.y, width: g.width, height: g.height, rx: g.rx, ...paint });
}

export interface MatteSource {
  spec: VectorSpec;
  /** Source box size (its own pixels). */
  width: number;
  height: number;
  /** Source box → parent pixels (core elementMatrix of the evaluated source). */
  matrix: Matrix;
  /** Evaluated source opacity, 0..1. */
  opacity: number;
}

/**
 * Track-matte image in the PARENT's pixel space, covering `area`.
 * 'alpha': opaque where the source paints. 'inverted': opaque everywhere in
 * `area` except where the source paints (Porter-Duff "out", so partial alpha
 * inverts exactly). `source` null means the matte is empty (source not on
 * screen at this frame).
 */
export function maskSvg(area: Box, mode: 'alpha' | 'inverted', source: MatteSource | null): string {
  const defs: string[] = [];
  let body = '';
  if (source) {
    const geometry = matteGeometry(source.spec, source.width, source.height, defs);
    body = svgTag(
      'g',
      { transform: `matrix(${source.matrix.map((v) => svgNumber(v, 6)).join(' ')})`, opacity: source.opacity < 1 ? svgNumber(source.opacity, 4) : undefined },
      geometry,
    );
  }
  const rect = { x: area.x, y: area.y, width: area.width, height: area.height };
  if (mode === 'inverted') {
    defs.push(
      svgTag(
        'filter',
        { id: 'invert', filterUnits: 'userSpaceOnUse', ...rect },
        svgTag('feFlood', { 'flood-color': '#000', 'flood-opacity': 1 }) + svgTag('feComposite', { in2: 'SourceGraphic', operator: 'out' }),
      ),
    );
    // An empty group would give the filter nothing to subtract: draw a full, uncovered area instead.
    body = body ? svgTag('g', { filter: 'url(#invert)' }, body) : svgTag('rect', { ...rect, fill: '#000' });
  }
  return svgTag(
    'svg',
    { xmlns: 'http://www.w3.org/2000/svg', width: area.width, height: area.height, viewBox: `${n(area.x)} ${n(area.y)} ${n(area.width)} ${n(area.height)}` },
    (defs.length ? svgTag('defs', {}, defs.join('')) : '') + body,
  );
}

/** CSS `url(...)` for an SVG string, as a data URI. */
export function svgDataUrl(svg: string): string {
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
