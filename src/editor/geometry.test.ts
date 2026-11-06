import { describe, expect, it } from 'vitest';
import { worldCorners } from '../core/animation';
import { element } from '../core/__fixtures__/schema2Project';
import type { Element } from '../core/types';
import { boxQuad, containsWorld, cornersOf, hitTestDeep, normalizeAngle, parentInverse, polygonsIntersect, rotationFor, vectorIn, withTransient, worldOf } from './geometry';

const T = (x: number, y: number, width: number, height: number, rotation = 0, scale = 1) => ({ x, y, width, height, rotation, scale, opacity: 1 });

// A 200×200 group at (400, 100) rotated 90°, holding a 100×50 child at its top-left.
const scene = (): Element[] => [
  element('bg', 'shape', { transform: T(0, 0, 1000, 600) }),
  element('g', 'group', { props: { clip: false }, transform: T(400, 100, 200, 200, 90) }),
  element('child', 'shape', { parentId: 'g', transform: T(0, 0, 100, 50) }),
  element('masked', 'shape', { transform: T(800, 400, 100, 100), mask: { sourceId: 'mask', mode: 'alpha' } }),
  element('mask', 'shape', { transform: T(800, 400, 100, 100) }),
];

describe('world geometry', () => {
  it('outlines a group child with its rotated world corners', () => {
    const els = scene();
    const child = els[2];
    const q = cornersOf(worldOf(els, child, 0));
    // Group centre (500, 200); 90° turns the child's local top-left corner (400,100) to (600,100).
    expect(q[0].x).toBeCloseTo(600);
    expect(q[0].y).toBeCloseTo(100);
    expect(q[2].x).toBeCloseTo(550);
    expect(q[2].y).toBeCloseTo(200);
    expect(q).toEqual(worldCorners(els, child, 0));
  });

  it('hit-tests the deepest painted element in reverse paint order', () => {
    const els = scene();
    expect(hitTestDeep(els, 0, { x: 575, y: 150 })?.id).toBe('child'); // inside the rotated child
    expect(hitTestDeep(els, 0, { x: 450, y: 150 })?.id).toBe('bg'); // inside the group box, not a child
    expect(hitTestDeep(els, 0, { x: 850, y: 450 })?.id).toBe('masked'); // the mask source above it is never hit
    expect(hitTestDeep(els, 0, { x: 2000, y: 2000 })).toBeNull();
  });

  it('skips hidden subtrees and respects a clipped group box', () => {
    const hidden = scene().map((e) => (e.id === 'g' ? { ...e, visible: false } : e));
    expect(hitTestDeep(hidden, 0, { x: 575, y: 150 })?.id).toBe('bg');
    // Child pushed outside the group box: hit unless the group clips.
    const out = scene().map((e) => (e.id === 'child' ? { ...e, transform: T(-150, 0, 100, 50) } : e));
    const p = cornersOf(worldOf(out, out[2], 0)).reduce((a, b) => ({ x: a.x + b.x / 4, y: a.y + b.y / 4 }), { x: 0, y: 0 });
    expect(hitTestDeep(out, 0, p)?.id).toBe('child');
    const clipped = out.map((e) => (e.id === 'g' ? { ...e, props: { clip: true } } : e));
    expect(hitTestDeep(clipped, 0, p)?.id).toBe('bg');
  });

  it('containsWorld is false for a zero-scale element', () => {
    const els = [element('z', 'shape', { transform: T(0, 0, 100, 100, 0, 0) })];
    expect(containsWorld(worldOf(els, els[0], 0), { x: 50, y: 50 })).toBe(false);
  });

  it('maps a screen-space drag into the parent’s axes', () => {
    const els = scene();
    // Under a 90° group, moving right on screen is −y in the group's local axes.
    const d = vectorIn(parentInverse(els, els[2], 0), { x: 10, y: 0 });
    expect(d.x).toBeCloseTo(0);
    expect(d.y).toBeCloseTo(-10);
    expect(vectorIn(parentInverse(els, els[0], 0), { x: 10, y: 5 })).toEqual({ x: 10, y: 5 });
  });
});

describe('marquee intersection', () => {
  it('detects overlap of rotated quads and separated ones', () => {
    const diamond = [{ x: 50, y: 0 }, { x: 100, y: 50 }, { x: 50, y: 100 }, { x: 0, y: 50 }];
    expect(polygonsIntersect(diamond, boxQuad({ left: 80, top: 0, right: 120, bottom: 40 }))).toBe(true);
    // The rect's corner region next to the diamond's tip: bounding boxes overlap, shapes don't.
    expect(polygonsIntersect(diamond, boxQuad({ left: 85, top: 0, right: 120, bottom: 10 }))).toBe(false);
  });
});

describe('rotation drag math', () => {
  it('normalises swept angles across ±180°', () => {
    expect(normalizeAngle(190)).toBe(-170);
    expect(normalizeAngle(-190)).toBe(170);
    expect(normalizeAngle(180)).toBe(180);
    expect(normalizeAngle(-180)).toBe(180);
    expect(normalizeAngle(725)).toBe(5);
  });

  it('adds the sweep to the start rotation; Shift snaps to 15°', () => {
    expect(rotationFor(10, 23.456, false)).toBe(33.46);
    expect(rotationFor(10, 23.456, true)).toBe(30);
    expect(rotationFor(-5, -4, true)).toBe(-15);
    expect(rotationFor(0, 370, true)).toBe(375);
  });
});

describe('transient previews', () => {
  it('swaps every previewed element of a multi-element gesture', () => {
    const els = scene();
    const p = { scenes: [{ id: 's', elements: els }] } as never;
    const moved = (id: string) => ({ ...els.find((e) => e.id === id)!, name: `${id}*` });
    const out = withTransient(p, { sceneId: 's', element: moved('bg'), others: [moved('child')] }) as unknown as { scenes: { elements: Element[] }[] };
    expect(out.scenes[0].elements.map((e) => e.name)).toEqual(['bg*', 'g', 'child*', 'masked', 'mask']);
  });
});
