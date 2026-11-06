// Renders one element tree (a scene's or a nested composition's elements) at
// a frame. Pure function of (elements, frame, context): no time, no
// randomness, so the preview Player, the capture page and the export agree.
//
// Hierarchy: top-level elements paint in list order; a group paints its
// children (in list order) inside its own box, so a child's left/top are local
// to the group and the group's rotation/scale/opacity apply around its centre
// — the same composition as core evaluateElementWorld(). A child's frame is
// its group's local frame, and it is drawn only while every ancestor is.
//
// Isolation: a group or instance box is its own stacking context, so blend
// modes inside it blend only with that group's content (top-level elements
// blend with the scene background and everything below them).

import React, { useMemo } from 'react';
import { elementMatrix, evaluateElement, resolvedEffects, resolvedProps, transformPoint, type EvaluatedElement, type Matrix } from '../core/animation';
import type { Asset, Effects, Element, ID, NestedComposition } from '../core/types';
import { ELEMENT_RENDERERS, MissingAsset } from './elements';
import { pathSpec, prop, shapeSpec } from './elements/shared';
import { maskSvg, svgDataUrl, vectorBounds, type Box, type MatteSource } from './svg';

import { MAX_INSTANCE_DEPTH } from '../core/limits';
export { MAX_INSTANCE_DEPTH } from '../core/limits';

export interface TreeContext {
  assets: Record<ID, Asset>;
  assetBaseUrl: string;
  fps: number;
  compositions: Record<ID, NestedComposition>;
  /** Instance nesting depth of this tree (0 = a scene). */
  depth: number;
}

/** CSS filter for an element's effects in contract order (blur, brightness, contrast, saturate, drop shadow); undefined when neutral. */
export function effectsFilter(effects: Effects): string | undefined {
  const parts: string[] = [];
  if (effects.blur !== undefined && effects.blur > 0) parts.push(`blur(${effects.blur}px)`);
  for (const key of ['brightness', 'contrast', 'saturate'] as const) {
    const v = effects[key];
    if (v !== undefined && v !== 1) parts.push(`${key}(${Math.max(0, v)})`);
  }
  const s = effects.dropShadow;
  if (s) parts.push(`drop-shadow(${s.x}px ${s.y}px ${s.blur}px ${s.color})`);
  return parts.length ? parts.join(' ') : undefined;
}

/**
 * Composition frame an instance shows at its own local frame:
 * `localFrame + timeOffset`. With loop it wraps modulo the composition
 * duration. Without loop, nothing is drawn before frame 0 (null) and the
 * last frame holds after the end.
 */
export function instanceFrame(localFrame: number, timeOffset: number, loop: boolean, duration: number): number | null {
  if (duration <= 0) return null;
  const f = localFrame + timeOffset;
  if (loop) return ((f % duration) + duration) % duration;
  if (f < 0) return null;
  return Math.min(f, duration - 1);
}

/** Axis-aligned bounds of `box` mapped through `m`. */
export function transformedBounds(m: Matrix, box: Box): Box {
  const pts = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ].map((p) => transformPoint(m, p));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/**
 * Area a matte image covers, in the parent's pixels: the parent box plus the
 * target's and source's bounds (children of an unclipped group may overhang
 * it), rounded out to whole px.
 */
export function matteArea(parent: { width: number; height: number }, boxes: Box[]): Box {
  const all = [{ x: 0, y: 0, width: parent.width, height: parent.height }, ...boxes];
  const x = Math.floor(Math.min(...all.map((b) => b.x)));
  const y = Math.floor(Math.min(...all.map((b) => b.y)));
  const right = Math.ceil(Math.max(...all.map((b) => b.x + b.width)));
  const bottom = Math.ceil(Math.max(...all.map((b) => b.y + b.height)));
  return { x, y, width: right - x, height: bottom - y };
}

interface TreeIndex {
  /** Children by parent id ('' = top level), in list (paint) order. */
  children: Map<string, Element[]>;
  byId: Map<ID, Element>;
  /** Mask sources: never painted themselves. */
  sources: Set<ID>;
}

function indexTree(elements: Element[]): TreeIndex {
  const children = new Map<string, Element[]>();
  const byId = new Map<ID, Element>();
  const sources = new Set<ID>();
  for (const el of elements) {
    byId.set(el.id, el);
    const key = el.parentId ?? '';
    const list = children.get(key);
    if (list) list.push(el);
    else children.set(key, [el]);
    if (el.mask) sources.add(el.mask.sourceId);
  }
  return { children, byId, sources };
}

interface Tree extends TreeIndex {
  ctx: TreeContext;
}

export const ElementTree: React.FC<{ elements: Element[]; frame: number; width: number; height: number; ctx: TreeContext }> = ({
  elements,
  frame,
  width,
  height,
  ctx,
}) => {
  const index = useMemo(() => indexTree(elements), [elements]);
  return <Level tree={{ ...index, ctx }} parentId="" frame={frame} width={width} height={height} />;
};

/** The children of one parent (or the top level), painted at the parent's local frame inside a width × height box. */
const Level: React.FC<{ tree: Tree; parentId: string; frame: number; width: number; height: number }> = ({ tree, parentId, frame, width, height }) => (
  <>
    {(tree.children.get(parentId) ?? []).map((el) =>
      tree.sources.has(el.id) ? null : <ElementNode key={el.id} element={el} frame={frame} parentWidth={width} parentHeight={height} tree={tree} />,
    )}
  </>
);

const ElementNode: React.FC<{ element: Element; frame: number; parentWidth: number; parentHeight: number; tree: Tree }> = ({
  element,
  frame,
  parentWidth,
  parentHeight,
  tree,
}) => {
  const e = evaluateElement(element, frame);
  if (!e.active) return null;
  // Renderers always see props resolved at this frame (animated fontSize, colour, trim…).
  const resolved = element.propTracks?.length ? { ...element, props: resolvedProps(element, e.localFrame) } : element;
  const filter = element.effects || element.propTracks?.length ? effectsFilter(resolvedEffects(element, e.localFrame)) : undefined;
  const blend = element.blendMode && element.blendMode !== 'normal' ? element.blendMode : undefined;
  const clip = element.type === 'group' && resolved.props.clip === true;
  const box = (
    <div
      data-element-id={element.id}
      style={{
        position: 'absolute',
        left: e.x,
        top: e.y,
        width: e.width,
        height: e.height,
        transform: `rotate(${e.rotation}deg) scale(${e.scale})`,
        transformOrigin: '50% 50%',
        opacity: e.opacity,
        ...(filter ? { filter } : null),
        // A matte wrapper is a stacking context of its own: the blend goes on the wrapper so it still reaches the backdrop.
        ...(blend && !element.mask ? { mixBlendMode: blend } : null),
        ...(clip ? { overflow: 'hidden' } : null),
      }}
    >
      <ElementContent element={resolved} e={e} tree={tree} />
    </div>
  );
  if (!element.mask) return box;
  return (
    <Matte target={element} e={e} frame={frame} parent={{ width: parentWidth, height: parentHeight }} tree={tree} blend={blend}>
      {box}
    </Matte>
  );
};

const ElementContent: React.FC<{ element: Element; e: EvaluatedElement; tree: Tree }> = ({ element, e, tree }) => {
  if (element.type === 'group') return <Level tree={tree} parentId={element.id} frame={e.localFrame} width={e.width} height={e.height} />;
  if (element.type === 'instance') return <InstanceView element={element} e={e} ctx={tree.ctx} />;
  const Renderer = ELEMENT_RENDERERS[element.type];
  if (!Renderer) return <MissingAsset width={e.width} height={e.height} />;
  const { assets, assetBaseUrl, fps } = tree.ctx;
  return <Renderer element={element} localFrame={e.localFrame} width={e.width} height={e.height} assets={assets} assetBaseUrl={assetBaseUrl} fps={fps} />;
};

/**
 * A nested composition played inside the instance box: scaled to fit
 * (contain) and centred, clipped to the composition bounds, at
 * instanceFrame(). Background 'transparent' paints nothing.
 */
const InstanceView: React.FC<{ element: Element; e: EvaluatedElement; ctx: TreeContext }> = ({ element, e, ctx }) => {
  const comp = ctx.compositions[prop<string>(element, 'instance', 'compositionId')];
  if (!comp || ctx.depth >= MAX_INSTANCE_DEPTH) return null;
  const f = instanceFrame(e.localFrame, prop<number>(element, 'instance', 'timeOffset'), prop<boolean>(element, 'instance', 'loop'), comp.durationInFrames);
  if (f === null) return null;
  const s = Math.min(e.width / comp.width, e.height / comp.height);
  return (
    <div
      data-composition-id={comp.id}
      style={{
        position: 'absolute',
        left: (e.width - comp.width * s) / 2,
        top: (e.height - comp.height * s) / 2,
        width: comp.width,
        height: comp.height,
        transform: `scale(${s})`,
        transformOrigin: '0 0',
        overflow: 'hidden',
        ...(comp.backgroundColor !== 'transparent' ? { background: comp.backgroundColor } : null),
      }}
    >
      <ElementTree elements={comp.elements} frame={f} width={comp.width} height={comp.height} ctx={{ ...ctx, depth: ctx.depth + 1 }} />
    </div>
  );
};

/**
 * Track matte. The target box is wrapped in a parent-space layer masked by an
 * SVG image of the source (a sibling shape/path) at its evaluated transform,
 * resolved props and opacity at this frame, so moving or animated mattes update
 * every frame. The matte exists only inside the source's lifetime (outside it,
 * 'alpha' hides the target and 'inverted' shows all of it); the source's
 * `visible` flag, effects and blend do not affect the matte.
 */
const Matte: React.FC<{
  target: Element;
  e: EvaluatedElement;
  frame: number;
  parent: { width: number; height: number };
  tree: Tree;
  blend: string | undefined;
  children: React.ReactNode;
}> = ({ target, e, frame, parent, tree, blend, children }) => {
  const mask = target.mask!;
  const raw = tree.byId.get(mask.sourceId);
  let source: MatteSource | null = null;
  const bounds: Box[] = [transformedBounds(elementMatrix(e), { x: 0, y: 0, width: e.width, height: e.height })];
  if (raw && (raw.type === 'shape' || raw.type === 'path')) {
    const se = evaluateElement(raw, frame);
    if (se.localFrame >= 0 && se.localFrame < raw.durationInFrames) {
      const sourceEl = raw.propTracks?.length ? { ...raw, props: resolvedProps(raw, se.localFrame) } : raw;
      const spec = raw.type === 'shape' ? shapeSpec(sourceEl, se.width, se.height) : pathSpec(sourceEl);
      const matrix = elementMatrix(se);
      source = { spec, width: se.width, height: se.height, matrix, opacity: se.opacity };
      bounds.push(transformedBounds(matrix, vectorBounds(spec, se.width, se.height)));
    }
  }
  const area = matteArea(parent, bounds);
  const url = svgDataUrl(maskSvg(area, mask.mode, source));
  const size = `${area.width}px ${area.height}px`;
  return (
    <div
      data-matte-for={target.id}
      style={{
        position: 'absolute',
        left: area.x,
        top: area.y,
        width: area.width,
        height: area.height,
        maskImage: url,
        WebkitMaskImage: url,
        maskSize: size,
        WebkitMaskSize: size,
        maskRepeat: 'no-repeat',
        WebkitMaskRepeat: 'no-repeat',
        maskPosition: '0 0',
        WebkitMaskPosition: '0 0',
        ...(blend ? { mixBlendMode: blend as React.CSSProperties['mixBlendMode'] } : null),
      }}
    >
      {/* Undo the wrapper offset so the target keeps its parent-space position. */}
      <div style={{ position: 'absolute', left: -area.x, top: -area.y, width: parent.width, height: parent.height }}>{children}</div>
    </div>
  );
};
