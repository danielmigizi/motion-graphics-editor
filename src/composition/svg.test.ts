import { describe, expect, it } from 'vitest';
import { buildPathSpec, buildShapeSpec, maskSvg, paintToCss, readPaint, svgDataUrl, svgGradient, vectorBounds, type GradientPaint } from './svg';

const linear = (angle: number): GradientPaint => ({ type: 'linear', angle, stops: [{ offset: 0, color: '#000' }, { offset: 1, color: '#fff' }] });
const shape = (over: Partial<Parameters<typeof buildShapeSpec>[0]> = {}, w = 200, h = 100) =>
  buildShapeSpec({ shape: 'rect', fill: '#3B82F6', stroke: 'none', strokeWidth: 0, cornerRadius: 24, ...over }, w, h);
const path = (over: Partial<Parameters<typeof buildPathSpec>[0]> = {}) =>
  buildPathSpec({
    nodes: [{ x: 0, y: 80, out: { x: 60, y: 0 } }, { x: 180, y: 80, in: { x: 120, y: 160 } }],
    closed: false,
    fill: 'none',
    stroke: '#F8FAFC',
    strokeWidth: 8,
    lineCap: 'round',
    lineJoin: 'round',
    trimStart: 0,
    trimEnd: 1,
    trimOffset: 0,
    ...over,
  });

describe('paint', () => {
  it('maps colours, none and gradients to CSS', () => {
    expect(paintToCss('#3B82F6')).toBe('#3B82F6');
    expect(paintToCss('none')).toBe('transparent');
    expect(paintToCss({ type: 'linear', angle: 135, stops: [{ offset: 0, color: '#8B5CF6' }, { offset: 0.5, color: '#F0605D' }, { offset: 1, color: '#F5A524' }] })).toBe(
      'linear-gradient(135deg, #8B5CF6 0%, #F0605D 50%, #F5A524 100%)',
    );
    expect(paintToCss({ type: 'radial', stops: [{ offset: 0, color: '#000' }, { offset: 1, color: 'rgba(255,255,255,0.5)' }] })).toBe(
      'radial-gradient(closest-side, #000 0%, rgba(255,255,255,0.5) 100%)',
    );
  });

  it('reads stored paints and falls back on anything else', () => {
    const g = linear(90);
    expect(readPaint(g, '#fff')).toBe(g);
    expect(readPaint('#123', '#fff')).toBe('#123');
    expect(readPaint(42, '#fff')).toBe('#fff');
    expect(readPaint({ type: 'conic', stops: [] }, '#fff')).toBe('#fff');
  });

  it('places SVG linear gradients on the CSS gradient line (0deg up, 90deg right)', () => {
    expect(svgGradient(linear(90), 200, 100).attrs).toEqual({ gradientUnits: 'userSpaceOnUse', x1: '0', y1: '50', x2: '200', y2: '50' });
    expect(svgGradient(linear(0), 200, 100).attrs).toEqual({ gradientUnits: 'userSpaceOnUse', x1: '100', y1: '100', x2: '100', y2: '0' });
  });

  it.each([30, 135, 200, 300])('puts the starting and ending corners at 0 and 1 for %sdeg, like CSS', (angle) => {
    const w = 200;
    const h = 100;
    const { x1, y1, x2, y2 } = svgGradient(linear(angle), w, h).attrs;
    const [ax, ay, bx, by] = [x1, y1, x2, y2].map(Number);
    const t = (x: number, y: number) => ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2);
    const ts = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => t(x, y));
    expect(Math.min(...ts)).toBeCloseTo(0, 2);
    expect(Math.max(...ts)).toBeCloseTo(1, 2);
  });

  it('makes radial gradients the ellipse inscribed in the box, with alpha split out of stop colours', () => {
    const g = svgGradient({ type: 'radial', stops: [{ offset: 0, color: '#3B82F680' }, { offset: 1, color: 'rgba(1, 2, 3, 0.25)' }] }, 200, 100);
    expect(g.tag).toBe('radialGradient');
    expect(g.attrs).toEqual({ gradientUnits: 'userSpaceOnUse', cx: '100', cy: '50', r: '100', gradientTransform: 'translate(100 50) scale(1 0.5) translate(-100 -50)' });
    expect(g.stops).toEqual([
      { offset: '0', color: 'rgb(59, 130, 246)', opacity: '0.502' },
      { offset: '1', color: 'rgb(1, 2, 3)', opacity: '0.25' },
    ]);
    expect(svgGradient({ type: 'radial', stops: g.stops.map((s) => ({ offset: Number(s.offset), color: '#fff' })) }, 80, 80).attrs.gradientTransform).toBeUndefined();
    expect(svgGradient(linear(0), 10, 10, true).stops.map((s) => s.color)).toEqual(['#000', '#000']);
  });
});

describe('shape and path specs', () => {
  it('keeps the stroke inside the box (same geometry as before paints)', () => {
    expect(shape({ stroke: '#fff', strokeWidth: 10 })).toEqual({
      kind: 'shape',
      geometry: { kind: 'rect', x: 5, y: 5, width: 190, height: 90, rx: 19 },
      fill: '#3B82F6',
      stroke: '#fff',
      strokeWidth: 10,
    });
    expect(shape({ shape: 'ellipse', fill: 'none' }).geometry).toEqual({ kind: 'ellipse', cx: 100, cy: 50, rx: 100, ry: 50 });
    expect(shape({ shape: 'ellipse', fill: 'none' }).fill).toBeNull();
    expect(shape({ stroke: 'none', strokeWidth: 10 })).toMatchObject({ stroke: null, strokeWidth: 0 });
    expect(shape({ stroke: '#fff', strokeWidth: 300 }).strokeWidth).toBe(50);
  });

  it('drops a trimmed-away or unpainted stroke but keeps the fill', () => {
    expect(path({ trimEnd: 0 })).toMatchObject({ stroke: null, trim: { visible: false } });
    expect(path({ stroke: 'none', fill: '#fff' })).toMatchObject({ stroke: null, fill: '#fff' });
    expect(path().d).toBe('M0 80 C60 0 120 160 180 80');
  });

  it('bounds paths by their control hull plus a miter allowance', () => {
    expect(vectorBounds(path(), 200, 200)).toEqual({ x: -16, y: -16, width: 212, height: 192 });
    expect(vectorBounds(shape(), 200, 100)).toEqual({ x: 0, y: 0, width: 200, height: 100 });
  });
});

describe('maskSvg', () => {
  const area = { x: 0, y: 0, width: 1000, height: 600 };

  it('draws a rect source (with corner radius) at its parent-space transform', () => {
    expect(maskSvg(area, 'alpha', { spec: shape(), width: 200, height: 100, matrix: [1, 0, 0, 1, 50, 60], opacity: 1 })).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600" viewBox="0 0 1000 600">' +
        '<g transform="matrix(1 0 0 1 50 60)"><rect x="0" y="0" width="200" height="100" rx="24" fill="#000" stroke="none"/></g></svg>',
    );
  });

  it('draws an ellipse source with its opacity and a rotated/scaled matrix', () => {
    const svg = maskSvg({ x: -20, y: -10, width: 1040, height: 620 }, 'alpha', {
      spec: shape({ shape: 'ellipse', fill: '#ff000080' }, 300, 300),
      width: 300,
      height: 300,
      matrix: [0, 2, -2, 0, 450, -150],
      opacity: 0.5,
    });
    expect(svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" width="1040" height="620" viewBox="-20 -10 1040 620">' +
        '<g transform="matrix(0 2 -2 0 450 -150)" opacity="0.5"><ellipse cx="150" cy="150" rx="150" ry="150" fill="#000" fill-opacity="0.502" stroke="none"/></g></svg>',
    );
  });

  it('draws a trimmed path source with an alpha-only gradient stroke', () => {
    const svg = maskSvg(area, 'alpha', {
      spec: path({ stroke: linear(90), trimEnd: 0.5, trimOffset: 0.25 }),
      width: 200,
      height: 200,
      matrix: [1, 0, 0, 1, 0, 0],
      opacity: 1,
    });
    expect(svg).toContain(
      '<defs><linearGradient id="ms" gradientUnits="userSpaceOnUse" x1="0" y1="100" x2="200" y2="100">' +
        '<stop offset="0" stop-color="#000" stop-opacity="1"/><stop offset="1" stop-color="#000" stop-opacity="1"/></linearGradient></defs>',
    );
    expect(svg).toContain(
      '<path d="M0 80 C60 0 120 160 180 80" fill="none" stroke="url(#ms)" stroke-width="8" stroke-linecap="round" stroke-linejoin="round" pathLength="1" stroke-dasharray="0.5 0.5" stroke-dashoffset="-0.25"/>',
    );
  });

  it('inverts with a Porter-Duff "out" over the whole area', () => {
    const svg = maskSvg(area, 'inverted', { spec: shape(), width: 200, height: 100, matrix: [1, 0, 0, 1, 50, 60], opacity: 1 });
    expect(svg).toContain(
      '<filter id="invert" filterUnits="userSpaceOnUse" x="0" y="0" width="1000" height="600"><feFlood flood-color="#000" flood-opacity="1"/><feComposite in2="SourceGraphic" operator="out"/></filter>',
    );
    expect(svg).toContain('<g filter="url(#invert)"><g transform="matrix(1 0 0 1 50 60)"><rect');
  });

  it('is empty without a source (alpha hides the target) and full when inverted', () => {
    expect(maskSvg(area, 'alpha', null)).toBe('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="600" viewBox="0 0 1000 600"/>');
    expect(maskSvg(area, 'inverted', null)).toContain('<rect x="0" y="0" width="1000" height="600" fill="#000"/></svg>');
  });

  it('encodes the image as a CSS data URL', () => {
    expect(svgDataUrl('<svg a="#"/>')).toBe('url("data:image/svg+xml,%3Csvg%20a%3D%22%23%22%2F%3E")');
  });
});
