import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { multiplyMatrices, transformPoint, worldCorners, type Matrix } from '../core/animation';
import { buildTemplate } from '../core/templates';
import { element, composition, project } from '../core/__fixtures__/schema2Project';
import type { Element, NestedComposition } from '../core/types';
import { effectsFilter, ElementTree, instanceFrame, matteArea, MAX_INSTANCE_DEPTH, type TreeContext } from './ElementTree';

function render(elements: Element[], frame: number, ctx: Partial<TreeContext> = {}): string {
  return renderToStaticMarkup(
    createElement(ElementTree, { elements, frame, width: 1000, height: 600, ctx: { assets: {}, assetBaseUrl: '/', fps: 30, compositions: {}, depth: 0, ...ctx } }),
  );
}

// --- A tiny reader for the rendered markup: composes the CSS box transforms of
// every positioned ancestor, exactly as the browser does.

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const translate = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];

function parseStyle(attrs: string): Record<string, string> {
  const m = /style="([^"]*)"/.exec(attrs);
  if (!m) return {};
  return Object.fromEntries(
    m[1]
      .replace(/&quot;/g, '"')
      .split(/;(?![^(]*\))/)
      .filter(Boolean)
      .map((d) => [d.slice(0, d.indexOf(':')).trim(), d.slice(d.indexOf(':') + 1).trim()]),
  );
}

function boxMatrix(s: Record<string, string>): Matrix {
  if (s.position !== 'absolute') return IDENTITY;
  const px = (v: string | undefined) => (v ? parseFloat(v) : 0);
  const [w, h] = [px(s.width), px(s.height)];
  const [ox, oy] = (s['transform-origin'] ?? '50% 50%').split(' ').map((v, i) => (v.endsWith('%') ? (parseFloat(v) / 100) * (i ? h : w) : parseFloat(v)));
  let t = IDENTITY;
  for (const [, fn, arg] of (s.transform ?? '').matchAll(/(\w+)\(([^)]*)\)/g)) {
    const v = parseFloat(arg);
    const r = (v * Math.PI) / 180;
    const step: Matrix = fn === 'rotate' ? [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0] : fn === 'scale' ? [v, 0, 0, v, 0, 0] : IDENTITY;
    t = multiplyMatrices(t, step);
  }
  return multiplyMatrices(multiplyMatrices(translate(px(s.left) + ox, px(s.top) + oy), t), translate(-ox, -oy));
}

/** Screen corners (clockwise from local top-left) of the element box with this data-element-id. */
function domCorners(html: string, id: string) {
  const stack: Matrix[] = [IDENTITY];
  for (const [, close, , attrs, selfClose] of html.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    if (close) {
      stack.pop();
      continue;
    }
    const style = parseStyle(attrs);
    const world = multiplyMatrices(stack[stack.length - 1], boxMatrix(style));
    if (attrs.includes(`data-element-id="${id}"`)) {
      const [w, h] = [parseFloat(style.width), parseFloat(style.height)];
      return [{ x: 0, y: 0 }, { x: w, y: 0 }, { x: w, y: h }, { x: 0, y: h }].map((p) => transformPoint(world, p));
    }
    if (!selfClose) stack.push(world);
  }
  return null;
}

function expectSameCorners(actual: { x: number; y: number }[] | null, expected: { x: number; y: number }[]) {
  expect(actual).not.toBeNull();
  actual!.forEach((p, i) => {
    expect(p.x).toBeCloseTo(expected[i].x, 6);
    expect(p.y).toBeCloseTo(expected[i].y, 6);
  });
}

describe('hierarchy', () => {
  const nested = () => {
    const root = element('root', 'group', { startFrame: 10, durationInFrames: 50, transform: { x: 100, y: 100, width: 100, height: 100, rotation: 90, scale: 2, opacity: 0.5 } });
    const group = element('g', 'group', { parentId: 'root', startFrame: 5, transform: { x: 0, y: 0, width: 50, height: 50, rotation: -90, scale: 0.5, opacity: 0.5 } });
    const child = element('c', 'shape', { parentId: 'g', startFrame: 3, transform: { x: 10, y: 20, width: 20, height: 10, rotation: 0, scale: 1, opacity: 0.8 } });
    return [root, group, child];
  };

  it('composes nested rotated + scaled boxes exactly like worldCorners', () => {
    const elements = nested();
    expectSameCorners(domCorners(render(elements, 18), 'c'), worldCorners(elements, elements[2], 18));
  });

  it('matches worldCorners for animated parents and children at several frames', () => {
    const elements = nested();
    elements[0].tracks = [{ property: 'rotation', keyframes: [{ frame: 0, value: 0, easing: 'linear' }, { frame: 40, value: 200, easing: 'linear' }] }];
    elements[1].tracks = [{ property: 'x', keyframes: [{ frame: 0, value: -30, easing: 'easeOut' }, { frame: 20, value: 60, easing: 'linear' }] }];
    elements[2].tracks = [{ property: 'scale', keyframes: [{ frame: 0, value: 0.5, easing: 'backOut' }, { frame: 12, value: 1.5, easing: 'linear' }] }];
    elements[2].transform.rotation = 33;
    for (const frame of [18, 25, 37, 59]) expectSameCorners(domCorners(render(elements, frame), 'c'), worldCorners(elements, elements[2], frame));
  });

  it('draws a child only while every ancestor is active, at its own parent-relative frame', () => {
    const elements = nested();
    expect(render(elements, 17)).not.toContain('data-element-id="c"');
    expect(render(elements, 18)).toContain('data-element-id="c"');
    expect(render(elements, 60)).toBe('');
    elements[1].visible = false;
    expect(render(elements, 20)).not.toContain('data-element-id="c"');
  });

  it('paints children in list order inside the group box, and clips when asked', () => {
    const g = element('g', 'group');
    const html = render([element('b', 'shape', { parentId: 'g' }), g, element('a', 'shape', { parentId: 'g' })], 0);
    expect(html.indexOf('data-element-id="g"')).toBeLessThan(html.indexOf('data-element-id="b"'));
    expect(html.indexOf('data-element-id="b"')).toBeLessThan(html.indexOf('data-element-id="a"'));
    expect(html).not.toContain('overflow:hidden');
    g.props.clip = true;
    expect(render([g, element('a', 'shape', { parentId: 'g' })], 0)).toContain('opacity:1;overflow:hidden"');
  });

  it('keeps the box style of documents without v2 fields byte-for-byte', () => {
    expect(render([element('a')], 0)).toMatch(
      /^<div data-element-id="a" style="position:absolute;left:10px;top:20px;width:80px;height:60px;transform:rotate\(0deg\) scale\(1\);transform-origin:50% 50%;opacity:1"><svg/,
    );
  });
});

describe('property tracks, effects and blend', () => {
  it('hands renderers the props resolved at the local frame', () => {
    const a = element('a', 'shape', { startFrame: 5, propTracks: [{ key: 'props.fill', keyframes: [{ frame: 0, value: '#000000', easing: 'linear' }, { frame: 10, value: '#ffffff', easing: 'linear' }] }] });
    expect(render([a], 10)).toContain('fill="rgba(188, 188, 188, 1)"');
    expect(a.props.fill).toBe('#3B82F6');
  });

  it('maps effects to a CSS filter in contract order and omits neutral values', () => {
    expect(effectsFilter({})).toBeUndefined();
    expect(effectsFilter({ blur: 0, brightness: 1, contrast: 1, saturate: 1 })).toBeUndefined();
    expect(effectsFilter({ saturate: 0.5, blur: 4, dropShadow: { x: 0, y: 8, blur: 20, color: '#00000080' }, brightness: 1.2, contrast: 1 })).toBe(
      'blur(4px) brightness(1.2) saturate(0.5) drop-shadow(0px 8px 20px #00000080)',
    );
    const a = element('a', 'shape', { effects: { blur: 2 }, propTracks: [{ key: 'effects.blur', keyframes: [{ frame: 0, value: 0, easing: 'linear' }, { frame: 10, value: 10, easing: 'linear' }] }] });
    expect(render([a], 5)).toContain('opacity:1;filter:blur(5px)');
  });

  it('puts the blend mode on the element box, or on the matte wrapper when masked', () => {
    expect(render([element('a', 'shape', { blendMode: 'multiply' })], 0)).toContain('opacity:1;mix-blend-mode:multiply"');
    const html = render([element('m', 'shape'), element('a', 'shape', { blendMode: 'screen', mask: { sourceId: 'm', mode: 'alpha' } })], 0);
    expect(html).toMatch(/<div data-matte-for="a" style="[^"]*mix-blend-mode:screen"/);
    expect(html).toMatch(/data-element-id="a" style="[^"]*opacity:1"/);
  });
});

describe('mattes', () => {
  const lens = () =>
    element('m', 'shape', {
      transform: { x: 0, y: 100, width: 200, height: 200, rotation: 0, scale: 1, opacity: 1 },
      props: { shape: 'ellipse', fill: '#000', stroke: 'none', strokeWidth: 0, cornerRadius: 0 },
      tracks: [{ property: 'x', keyframes: [{ frame: 0, value: 0, easing: 'linear' }, { frame: 10, value: 500, easing: 'linear' }] }],
    });
  const target = () => element('t', 'shape', { transform: { x: 0, y: 0, width: 1000, height: 600, rotation: 0, scale: 1, opacity: 1 }, mask: { sourceId: 'm', mode: 'alpha' } });
  const maskOf = (html: string) => decodeURIComponent(/mask-image:url\(&quot;data:image\/svg\+xml,([^&]*)&quot;\)/.exec(html)?.[1] ?? '');

  it('does not paint the source and wraps the target in a parent-space matte', () => {
    const html = render([lens(), target()], 0);
    expect(html).not.toContain('data-element-id="m"');
    expect(html).toContain('<div data-matte-for="t" style="position:absolute;left:0;top:0;width:1000px;height:600px;mask-image:url(');
    expect(html).toContain('<div style="position:absolute;left:0;top:0;width:1000px;height:600px"><div data-element-id="t"');
    expect(maskOf(html)).toContain('<g transform="matrix(1 0 0 1 0 100)"><ellipse cx="100" cy="100" rx="100" ry="100" fill="#000" stroke="none"/></g>');
  });

  it('moves with the animated source every frame', () => {
    expect(maskOf(render([lens(), target()], 5))).toContain('matrix(1 0 0 1 250 100)');
  });

  it('is empty outside the source lifetime and ignores the source visible flag', () => {
    const m = lens();
    m.visible = false;
    expect(maskOf(render([m, target()], 0))).toContain('<ellipse');
    m.durationInFrames = 5;
    expect(maskOf(render([m, target()], 7))).not.toContain('<ellipse');
  });

  it('covers the parent box plus overhanging target/source bounds without truncation', () => {
    expect(matteArea({ width: 1000, height: 600 }, [{ x: -10.5, y: 20, width: 100, height: 700.2 }])).toEqual({ x: -11, y: 0, width: 1011, height: 721 });
    expect(matteArea({ width: 100, height: 50 }, [{ x: -5000, y: 0, width: 10, height: 10 }])).toEqual({ x: -5000, y: 0, width: 5100, height: 50 });
  });
});

describe('instances', () => {
  const gradientComp = (): NestedComposition => ({
    ...composition('cmp', [element('in_rect', 'shape', { props: { shape: 'rect', fill: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] }, stroke: 'none', strokeWidth: 0, cornerRadius: 0 } })]),
    durationInFrames: 40,
  });
  const instance = (id: string, props: Record<string, unknown>, box = { x: 0, y: 0, width: 300, height: 400 }) =>
    element(id, 'instance', { props: { compositionId: 'cmp', timeOffset: 0, loop: false, ...props }, transform: { ...box, rotation: 0, scale: 1, opacity: 1 } });

  it('maps instance frames: offset, loop wraps, otherwise hidden before 0 and held after the end', () => {
    expect(instanceFrame(10, 5, false, 40)).toBe(15);
    expect(instanceFrame(10, -20, false, 40)).toBeNull();
    expect(instanceFrame(100, 0, false, 40)).toBe(39);
    expect(instanceFrame(45, 0, true, 40)).toBe(5);
    expect(instanceFrame(0, -15, true, 40)).toBe(25);
    expect(instanceFrame(0, 0, true, 0)).toBeNull();
  });

  it('fits the composition into the box (contain, centred, clipped) and plays it at the mapped frame', () => {
    const comp = gradientComp();
    comp.elements[0].startFrame = 10;
    comp.elements[0].durationInFrames = 30;
    const html = render([instance('i', { timeOffset: 5 })], 5, { compositions: { cmp: comp } });
    // 600×400 composition into 300×400: scale 0.5, centred vertically.
    expect(html).toContain('<div data-composition-id="cmp" style="position:absolute;left:0;top:100px;width:600px;height:400px;transform:scale(0.5);transform-origin:0 0;overflow:hidden">');
    expect(html).toContain('data-element-id="in_rect"');
    expect(render([instance('i', { timeOffset: 4 })], 5, { compositions: { cmp: comp } })).not.toContain('data-element-id="in_rect"');
    expect(render([instance('i', { timeOffset: -10 })], 5, { compositions: { cmp: comp } })).not.toContain('data-composition-id');
  });

  it('gives each playback its own gradient ids', () => {
    const html = render([instance('a', {}), instance('b', { timeOffset: 20 })], 0, { compositions: { cmp: gradientComp() } });
    const defs = [...html.matchAll(/<linearGradient id="([^"]+)"/g)].map((m) => m[1]);
    const refs = [...html.matchAll(/fill="url\(#([^)]+)\)"/g)].map((m) => m[1]);
    expect(defs).toHaveLength(2);
    expect(new Set(defs).size).toBe(2);
    expect(refs).toEqual(defs);
  });

  it('stops at the depth cap', () => {
    expect(render([instance('i', {})], 0, { compositions: { cmp: gradientComp() }, depth: MAX_INSTANCE_DEPTH })).not.toContain('data-composition-id');
  });
});


describe('verified renderer regressions', () => {
  it('renders compressed chat reply text before the group lifetime ends', () => {
    const p = project([]);
    const built = buildTemplate('chatExchange', { reply1: 'Visible reply' }, { project: p, sceneId: 's', at: 70 });
    if (!built.ok) throw new Error(built.message);
    const reply = built.elements.find(e => e.type === 'chatBubble' && e.props.sender === 'assistant')!;
    const html = render(built.elements, 99);
    expect(html).toContain(String(reply.props.text));
  });

  it.each(['brightness', 'contrast', 'saturate'] as const)('clamps overshooting %s without losing blur', key => {
    const a = element('a', 'shape', { effects: { blur: 8 }, propTracks: [{ key: `effects.${key}`, keyframes: [{ frame: 0, value: 1, easing: 'backOut' }, { frame: 10, value: 0, easing: 'linear' }] }] });
    expect(render([a], 7)).toContain(`filter:blur(8px) ${key}(0)`);
  });

  it('keeps far-overhanging mask sources and targets in an unclipped group matte', () => {
    const g = element('g', 'group', { transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0, scale: 1, opacity: 1 } });
    const box = { x: 300, y: 0, width: 50, height: 50, rotation: 0, scale: 1, opacity: 1 };
    const m = element('m', 'shape', { parentId: 'g', transform: box });
    const t = element('t', 'shape', { parentId: 'g', transform: box, mask: { sourceId: 'm', mode: 'alpha' } });
    expect(render([g, m, t], 0)).toContain('data-matte-for="t" style="position:absolute;left:0;top:0;width:350px;height:100px;');
  });
});
