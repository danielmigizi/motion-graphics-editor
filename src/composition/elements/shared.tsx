// Shared helpers for element renderers. Everything here is a pure function of
// its inputs (no time, no randomness) so preview and export match frame for frame.

import React from 'react';
import { EASINGS } from '../../core/animation';
import { COMPONENTS } from '../../core/components';
import type { Asset, Element, ElementType, ID, Paint, PathNode } from '../../core/types';
import { resolveAssetUrl } from '../../core/timing';
import { buildPathSpec, buildShapeSpec, readPaint, svgGradient, type PathSpec, type ShapeSpec } from '../svg';

export interface ElementRendererProps {
  /** The element with `props` already resolved at `localFrame` (property tracks applied). */
  element: Element;
  /** Element-relative frame (0 = first frame on screen). */
  localFrame: number;
  /** Size of the element's box (base transform width/height). */
  width: number;
  height: number;
  assets: Record<ID, Asset>;
  assetBaseUrl: string;
  fps: number;
}

export type ElementRenderer = React.FC<ElementRendererProps>;

/** Read a prop, falling back to the component default when missing or of the wrong type. */
export function prop<T extends string | number | boolean>(element: Element, type: ElementType, key: string): T {
  const fallback = COMPONENTS[type].defaultProps[key] as T;
  const value = element.props[key];
  return (typeof value === typeof fallback ? value : fallback) as T;
}

export const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Normalised progress of `frame` through [start, start + duration], 1 when duration <= 0. */
export function progress(frame: number, start: number, duration: number): number {
  if (duration <= 0) return frame >= start ? 1 : 0;
  return clamp01((frame - start) / duration);
}

export const easeOut = EASINGS.easeOut;

/** Stronger ease-out (cubic) for UI build-ins; reads as "settling" rather than linear. */
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp01(t), 3);

/** `color` at `percent`% opacity (works for any CSS colour, not just hex). */
export const tint = (color: string, percent: number) => `color-mix(in srgb, ${color} ${percent}%, transparent)`;

/** CSS family name of a bundled font (the variable @fontsource packages register "<Name> Variable"). */
/** The CSS family a font name registers under (variable fonts carry a "Variable" suffix). */
export const cssFontFamily = (family: string) =>
  family === 'Fraunces' ? 'Fraunces Variable'
    : family.startsWith('Archivo') ? 'Archivo Variable'
      : family === 'Geist Mono' ? 'Geist Mono Variable'
        : family;

/** Width-axis presets of one variable family: wide caps for titles, narrow caps for annotations. */
export const fontStretchFor = (family: string): string | undefined =>
  family === 'Archivo Expanded' ? '118%' : family === 'Archivo Narrow' ? '74%' : undefined;

export const fontStack = (family: string) =>
  `'${cssFontFamily(family)}', ${family === 'IBM Plex Mono' || family === 'Geist Mono' ? 'ui-monospace, Menlo, monospace' : family === 'Fraunces' ? 'Georgia, serif' : 'system-ui, sans-serif'}`;

/** Look up an asset usable by an element; null when missing or of a disallowed kind. */
export function findAsset(assets: Record<ID, Asset>, assetId: unknown, kinds: readonly Asset['kind'][]): Asset | null {
  if (typeof assetId !== 'string' || assetId === '') return null;
  const asset = assets[assetId];
  if (!asset || !kinds.includes(asset.kind)) return null;
  return asset;
}

export function assetUrl(asset: Asset, assetBaseUrl: string): string {
  return resolveAssetUrl(assetBaseUrl, asset.src);
}

/** Visible neutral placeholder for a missing asset. Never throws. */
export const MissingAsset: React.FC<{ width: number; height: number; radius?: number }> = ({ width, height, radius = 12 }) => {
  const size = Math.max(14, Math.min(40, Math.min(width, height) * 0.14));
  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        boxSizing: 'border-box',
        borderRadius: radius,
        border: `${Math.max(2, size * 0.08)}px dashed rgba(203, 213, 225, 0.45)`,
        background: 'rgba(100, 116, 139, 0.22)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'rgba(226, 232, 240, 0.85)',
        fontFamily: fontStack('Inter'),
        fontWeight: 500,
        fontSize: size,
        textAlign: 'center',
        overflow: 'hidden',
      }}
    >
      Missing asset
    </div>
  );
};

// ---------------------------------------------------------------------------
// Vector paint (shapes, paths)
// ---------------------------------------------------------------------------

export function shapeSpec(element: Element, width: number, height: number): ShapeSpec {
  const d = COMPONENTS.shape.defaultProps;
  return buildShapeSpec(
    {
      shape: prop<string>(element, 'shape', 'shape'),
      fill: readPaint(element.props.fill, d.fill as Paint),
      stroke: readPaint(element.props.stroke, d.stroke as Paint),
      strokeWidth: prop<number>(element, 'shape', 'strokeWidth'),
      cornerRadius: Math.max(0, prop<number>(element, 'shape', 'cornerRadius')),
    },
    width,
    height,
  );
}

export function pathSpec(element: Element): PathSpec {
  const d = COMPONENTS.path.defaultProps;
  const nodes = Array.isArray(element.props.nodes) ? (element.props.nodes as PathNode[]) : (d.nodes as PathNode[]);
  return buildPathSpec({
    nodes,
    closed: prop<boolean>(element, 'path', 'closed'),
    fill: readPaint(element.props.fill, d.fill as Paint),
    stroke: readPaint(element.props.stroke, d.stroke as Paint),
    strokeWidth: prop<number>(element, 'path', 'strokeWidth'),
    lineCap: prop<string>(element, 'path', 'lineCap'),
    lineJoin: prop<string>(element, 'path', 'lineJoin'),
    trimStart: prop<number>(element, 'path', 'trimStart'),
    trimEnd: prop<number>(element, 'path', 'trimEnd'),
    trimOffset: prop<number>(element, 'path', 'trimOffset'),
  });
}

/** SVG paint attribute: 'none', the colour itself, or a reference to the gradient def `id`. */
export const svgPaint = (paint: Paint | null, id: string) => (paint === null ? 'none' : typeof paint === 'string' ? paint : `url(#${id})`);

/**
 * Gradient defs for the gradient paints among `paints` (solid colours need none).
 * `ids` must be unique in the document: callers derive them from the element id
 * plus React's useId(), because one element can be on the page more than once
 * (an instance played twice, the stage and the timeline players).
 */
export const GradientDefs: React.FC<{ paints: { id: string; paint: Paint | null }[]; width: number; height: number }> = ({ paints, width, height }) => {
  const gradients = paints.filter((p) => p.paint !== null && typeof p.paint !== 'string');
  if (gradients.length === 0) return null;
  return (
    <defs>
      {gradients.map(({ id, paint }) => {
        const g = svgGradient(paint as Exclude<Paint, string>, width, height);
        const stops = g.stops.map((s, i) => <stop key={i} offset={s.offset} stopColor={s.color} stopOpacity={s.opacity} />);
        return g.tag === 'linearGradient' ? (
          <linearGradient key={id} id={id} {...g.attrs}>
            {stops}
          </linearGradient>
        ) : (
          <radialGradient key={id} id={id} {...g.attrs}>
            {stops}
          </radialGradient>
        );
      })}
    </defs>
  );
};

/** Document-unique, deterministic SVG id prefix for an element (useId is stable for a tree position). */
export function useSvgId(element: Element): string {
  return `${element.id.replace(/[^A-Za-z0-9_-]/g, '_')}${React.useId().replace(/[^A-Za-z0-9_-]/g, '_')}`;
}
