import { describe, expect, it } from 'vitest';
import { evaluateElement, resolvedEffects } from '../core/animation';
import { applyCommand } from '../core/commands';
import { element, project } from '../core/__fixtures__/schema2Project';
import type { Command, Element, Paint, Project } from '../core/types';
import {
  addStop,
  baseEdit,
  colorToHex,
  componentFromGroup,
  convertPaint,
  easingEdit,
  keyState,
  localFrameOf,
  maskedBy,
  maskSources,
  moveStop,
  normalizePaint,
  previewElement,
  removeAnimation,
  removeStop,
  resetEdit,
  routeEdit,
  toggleKey,
  valueAt,
  type FieldRef,
  type GradientPaint,
} from './inspectorModel';

const X: FieldRef = { kind: 'transform', property: 'x' };
const OPACITY: FieldRef = { kind: 'transform', property: 'opacity' };
const STROKE_W: FieldRef = { kind: 'prop', key: 'strokeWidth' };
const FILL: FieldRef = { kind: 'prop', key: 'fill' };
const BLUR: FieldRef = { kind: 'effect', key: 'blur' };

/** A shape with an x track (offset 0 → 100 over frames 10..30) and a strokeWidth prop track. */
function animated(): Element {
  return element('a', 'shape', {
    transform: { x: 100, y: 20, width: 80, height: 60, rotation: 0, scale: 1, opacity: 0.8 },
    tracks: [{ property: 'x', keyframes: [{ frame: 10, value: 0, easing: 'linear' }, { frame: 30, value: 100, easing: 'easeOut' }] }],
    propTracks: [{ key: 'props.strokeWidth', keyframes: [{ frame: 0, value: 2, easing: 'linear' }, { frame: 40, value: 10, easing: 'linear' }] }],
  });
}
const target = (el: Element) => ({ sceneId: 's', element: el });

/** Apply a command to a one-scene project holding `el`; returns the element afterwards. */
function apply(el: Element, command: Command, extra: Element[] = []): Element {
  const r = applyCommand(project([el, ...extra]), command, { source: 'user' });
  if (!r.ok) throw new Error(r.error.message);
  return r.project.scenes[0].elements.find((e) => e.id === el.id)!;
}

describe('keyState', () => {
  it('is none without a track, key on a keyframe, animated between keys', () => {
    const el = animated();
    expect(keyState(el, { kind: 'transform', property: 'y' }, 10)).toBe('none');
    expect(keyState(el, X, 10)).toBe('key');
    expect(keyState(el, X, 20)).toBe('animated');
    expect(keyState(el, X, 50)).toBe('animated');
    expect(keyState(el, STROKE_W, 40)).toBe('key');
    expect(keyState(el, STROKE_W, 39)).toBe('animated');
    expect(keyState(el, BLUR, 0)).toBe('none');
  });
});

describe('routeEdit: base vs animated', () => {
  it('edits the base of a static field', () => {
    const edit = routeEdit(target(animated()), { kind: 'transform', property: 'y' }, 55, 20, 'y')!;
    expect(edit.command).toEqual({ type: 'updateElement', sceneId: 's', elementId: 'a', changes: { transform: { y: 55 } } });
  });

  it('keys an animated transform at the playhead, converting the final value to an offset', () => {
    const el = animated();
    // At frame 20 the x offset is 50 → final 150. Typing 170 keys offset 70 at frame 20.
    expect(valueAt(el, X, 20)).toBe(150);
    const edit = routeEdit(target(el), X, 170, 20, 'x')!;
    expect(edit.command).toEqual({ type: 'setKeyframe', sceneId: 's', elementId: 'a', property: 'x', frame: 20, value: 70 });
    expect(edit.label).toBe('Add x keyframe');
    const after = apply(el, edit.command);
    expect(after.transform.x).toBe(100); // base untouched
    expect(evaluateElement(after, after.startFrame + 20).x).toBe(170);
  });

  it('updates an existing key keeping its easing, and converts multiplicative values to factors', () => {
    const el = { ...animated(), tracks: [{ property: 'opacity' as const, keyframes: [{ frame: 5, value: 1, easing: 'backOut' as const }, { frame: 15, value: 0.5, easing: 'linear' as const }] }] };
    const edit = routeEdit(target(el), OPACITY, 0.4, 5, 'opacity')!;
    expect(edit.label).toBe('Update opacity keyframe');
    const after = apply(el, edit.command);
    expect(after.tracks[0].keyframes[0]).toEqual({ frame: 5, value: 0.5, easing: 'backOut' }); // 0.4 / base 0.8
  });

  it('keys an animated prop / effect with the absolute value', () => {
    expect(routeEdit(target(animated()), STROKE_W, 6, 12, 'stroke width')!.command).toEqual({ type: 'setPropertyKeyframe', sceneId: 's', elementId: 'a', key: 'props.strokeWidth', frame: 12, value: 6 });
    const blurred = { ...animated(), propTracks: [{ key: 'effects.blur', keyframes: [{ frame: 0, value: 4, easing: 'linear' as const }] }] };
    expect(routeEdit(target(blurred), BLUR, 9, 3, 'blur')!.command).toMatchObject({ type: 'setPropertyKeyframe', key: 'effects.blur', frame: 3, value: 9 });
  });

  it('edits a static effect as a base effect', () => {
    expect(routeEdit(target(animated()), BLUR, 6, 3, 'blur')!.command).toEqual({ type: 'updateElement', sceneId: 's', elementId: 'a', changes: { effects: { blur: 6 } } });
  });

  it('refuses to key an animated field outside the element lifetime', () => {
    expect(routeEdit(target(animated()), X, 170, 150, 'x')).toBeNull();
    expect(routeEdit(target(animated()), X, 170, -1, 'x')).toBeNull();
  });

  it('never touches a track when the base is edited explicitly', () => {
    const el = animated();
    const after = apply(el, baseEdit(target(el), X, 300, 'x').command);
    expect(after.transform.x).toBe(300);
    expect(after.tracks).toBe(el.tracks);
    expect(after.propTracks).toBe(el.propTracks);
  });
});

describe('toggleKey / resetEdit / removeAnimation / easingEdit', () => {
  it('adds a key holding the current value, or removes the key at the playhead', () => {
    const el = animated();
    const add = toggleKey(target(el), X, 20, 'x')!;
    expect(add.command).toEqual({ type: 'setKeyframe', sceneId: 's', elementId: 'a', property: 'x', frame: 20, value: 50 });
    const keyed = apply(el, add.command);
    expect(evaluateElement(keyed, 20).x).toBe(evaluateElement(el, 20).x); // adding a key never changes the look
    expect(toggleKey(target(keyed), X, 20, 'x')!.command).toEqual({ type: 'removeKeyframe', sceneId: 's', elementId: 'a', property: 'x', frame: 20 });
    // Static field: starts a track with the neutral offset.
    expect(toggleKey(target(el), { kind: 'transform', property: 'rotation' }, 3, 'rotation')!.command).toMatchObject({ property: 'rotation', frame: 3, value: 0 });
    expect(toggleKey(target(el), BLUR, 3, 'blur')!.command).toMatchObject({ type: 'setPropertyKeyframe', key: 'effects.blur', frame: 3, value: 0 });
    expect(toggleKey(target(el), X, 500, 'x')).toBeNull();
  });

  it('resets a static field to its default and an animated one to its base at the playhead', () => {
    const el = { ...animated(), transform: { ...animated().transform, rotation: 30 } };
    expect(resetEdit(target(el), { kind: 'transform', property: 'rotation' }, 0, 'rotation')!.command).toMatchObject({ changes: { transform: { rotation: 0 } } });
    expect(resetEdit(target(el), { kind: 'transform', property: 'y' }, 0, 'y')).toBeNull(); // x / y have no default
    expect(resetEdit(target(el), X, 20, 'x')!.command).toEqual({ type: 'setKeyframe', sceneId: 's', elementId: 'a', property: 'x', frame: 20, value: 0 });
    expect(resetEdit(target(el), STROKE_W, 20, 'stroke width')!.command).toMatchObject({ type: 'setPropertyKeyframe', key: 'props.strokeWidth', frame: 20, value: el.props.strokeWidth });
    const withEffect = { ...el, effects: { blur: 5 } };
    expect(resetEdit(target(withEffect), BLUR, 0, 'blur')!.command).toMatchObject({ changes: { effects: { blur: null } } });
    expect(resetEdit(target(el), BLUR, 0, 'blur')).toBeNull();
  });

  it('removes a whole track in ONE batch and only then', () => {
    const el = animated();
    const edit = removeAnimation(target(el), X, 'x')!;
    expect(edit.command.type).toBe('batch');
    const after = apply(el, edit.command);
    expect(after.tracks.find((t) => t.property === 'x')).toBeUndefined();
    expect(after.transform.x).toBe(100);
    expect(removeAnimation(target(el), { kind: 'transform', property: 'y' }, 'y')).toBeNull();
  });

  it('switches a keyframe to a preset easing, keeping its value', () => {
    const el = animated();
    expect(easingEdit(target(el), X, 30, 'hold', 'x')!.command).toEqual({ type: 'setKeyframe', sceneId: 's', elementId: 'a', property: 'x', frame: 30, value: 100, easing: 'hold' });
    expect(easingEdit(target(el), X, 30, 'easeOut', 'x')).toBeNull();
    const custom = { ...el, propTracks: [{ key: 'props.strokeWidth', keyframes: [{ frame: 0, value: 2, easing: { type: 'cubicBezier' as const, x1: 0.1, y1: 0, x2: 0.2, y2: 1 } }] }] };
    expect(apply(custom, easingEdit(target(custom), STROKE_W, 0, 'linear', 'stroke width')!.command).propTracks![0].keyframes[0].easing).toBe('linear');
  });
});

describe('previewElement', () => {
  it('previews a base edit or a key at the playhead without touching anything else', () => {
    const el = animated();
    expect(previewElement(el, { kind: 'transform', property: 'y' }, 77, 20).transform.y).toBe(77);
    const keyed = previewElement(el, X, 170, 20);
    expect(evaluateElement(keyed, 20).x).toBe(170);
    expect(keyed.transform.x).toBe(100);
    expect(previewElement(el, X, 170, 500)).toBe(el);
  });
});

describe('paint', () => {
  const lin = (stops: GradientPaint['stops'], angle = 90): GradientPaint => ({ type: 'linear', angle, stops });

  it('normalises colours, offsets, order and angle', () => {
    expect(normalizePaint('#abc')).toBe('#AABBCC');
    expect(normalizePaint('rgba(255, 0, 0, 0.5)')).toBe('#FF000080');
    expect(normalizePaint('none')).toBe('none');
    expect(normalizePaint(lin([{ offset: 1.4, color: '#fff' }, { offset: -0.2, color: '#000' }, { offset: 0.33333, color: '#f00' }], -90))).toEqual(
      lin([{ offset: 0, color: '#000000' }, { offset: 0.333, color: '#FF0000' }, { offset: 1, color: '#FFFFFF' }], 270),
    );
    expect(normalizePaint({ type: 'radial', stops: [{ offset: 0.5, color: '#123456' }] })).toEqual({ type: 'radial', stops: [{ offset: 0, color: '#123456' }, { offset: 1, color: '#123456' }] });
  });

  it('converts between kinds keeping as much as possible', () => {
    expect(convertPaint('#3B82F6', 'linear')).toEqual(lin([{ offset: 0, color: '#3B82F6' }, { offset: 1, color: '#3B82F600' }]));
    expect(convertPaint('none', 'radial')).toEqual({ type: 'radial', stops: [{ offset: 0, color: '#FFFFFF' }, { offset: 1, color: '#FFFFFF00' }] });
    const g = lin([{ offset: 0, color: '#FF0000' }, { offset: 1, color: '#0000FF' }], 45);
    expect(convertPaint(g, 'solid')).toBe('#FF0000');
    expect(convertPaint(g, 'radial')).toEqual({ type: 'radial', stops: g.stops });
    expect(convertPaint({ type: 'radial', stops: g.stops }, 'linear')).toMatchObject({ type: 'linear', angle: 90 });
    expect(convertPaint(g, 'none')).toBe('none');
    expect(convertPaint('none', 'solid')).toBe('#FFFFFF');
  });

  it('adds stops without changing the look, removes down to two, and tracks a moved stop', () => {
    const g = lin([{ offset: 0, color: '#000000' }, { offset: 1, color: '#FFFFFF' }]);
    const added = addStop(g);
    expect(added.index).toBe(1);
    expect(added.paint.stops[1]).toEqual({ offset: 0.5, color: '#BCBCBC' }); // linear-light midpoint, as rendered
    expect(addStop(added.paint, 0.25).paint.stops.map((s) => s.offset)).toEqual([0, 0.25, 0.5, 1]);
    expect(removeStop(added.paint, 1).stops).toHaveLength(2);
    expect(removeStop(g, 0)).toBe(g);
    const moved = moveStop(added.paint, 0, 0.8);
    expect(moved.paint.stops.map((s) => s.offset)).toEqual([0.5, 0.8, 1]);
    expect(moved.index).toBe(1);
    expect(moved.paint.stops[moved.index].color).toBe('#000000');
  });

  it('keeps a validator-clean paint through every helper', () => {
    const shape = element('sh', 'shape'); // (the fixture project's own id is 'p')
    let paint: Paint = convertPaint('#22C55E', 'linear');
    paint = addStop(paint as GradientPaint).paint;
    paint = moveStop(paint as GradientPaint, 2, 0.1).paint;
    const r = applyCommand(project([shape]), { type: 'updateElement', sceneId: 's', elementId: 'sh', changes: { props: { fill: normalizePaint(paint) } } }, { source: 'user' });
    expect(r.ok).toBe(true);
  });

  it('colorToHex reads hex and rgb()', () => {
    expect(colorToHex('rgb(16, 32, 48)')).toBe('#102030');
    expect(colorToHex('nope')).toBeNull();
  });
});

describe('masks', () => {
  it('offers unmasked shapes/paths with the same parent', () => {
    const els = [
      element('t', 'text'),
      element('s1', 'shape'),
      element('p1', 'path'),
      element('s2', 'shape', { mask: { sourceId: 's1', mode: 'alpha' } }),
      element('g', 'group'),
      element('s3', 'shape', { parentId: 'g' }),
    ];
    expect(maskSources(els, els[0]).map((e) => e.id)).toEqual(['s1', 'p1']);
    expect(maskSources(els, els[1]).map((e) => e.id)).toEqual(['p1']);
    expect(maskedBy(els, els[1]).map((e) => e.id)).toEqual(['s2']);
  });
});

describe('localFrameOf', () => {
  it('subtracts every ancestor start', () => {
    const els = [element('g', 'group', { startFrame: 10 }), element('c', 'shape', { parentId: 'g', startFrame: 5 })];
    expect(localFrameOf(els, els[1], 40)).toBe(25);
    expect(localFrameOf(els, els[0], 40)).toBe(30);
  });
});

describe('componentFromGroup', () => {
  function grouped(): Project {
    const g = element('g', 'group', { startFrame: 10, durationInFrames: 50, transform: { x: 100, y: 50, width: 200, height: 100, rotation: 15, scale: 1, opacity: 1 }, tracks: [{ property: 'y', keyframes: [{ frame: 0, value: 0, easing: 'linear' }] }] });
    const a = element('a', 'shape', { parentId: 'g', transform: { x: 10, y: 10, width: 50, height: 50, rotation: 0, scale: 1, opacity: 1 } });
    const m = element('m', 'shape', { parentId: 'g', transform: { x: 0, y: 0, width: 80, height: 80, rotation: 0, scale: 1, opacity: 1 } });
    const b = element('b', 'text', { parentId: 'g', startFrame: 5, mask: { sourceId: 'm', mode: 'alpha' }, transform: { x: 100, y: 20, width: 90, height: 40, rotation: 0, scale: 1, opacity: 1 } });
    return project([element('before'), a, m, g, b, element('after')]);
  }
  const ids = { compositionId: 'cmp_new', instanceId: 'inst', elementId: (id: string) => `copy_${id}` };

  it('builds one valid batch: composition of copies + an instance in the group slot', () => {
    const p = grouped();
    const r = componentFromGroup(p, 's', 'g', ids);
    if ('error' in r) throw new Error(r.error);
    expect(r.overhang).toBe(false);
    const applied = applyCommand(p, r.command, { source: 'user' });
    if (!applied.ok) throw new Error(applied.error.message);
    const out = applied.project;
    const comp = out.compositions.cmp_new;
    expect(comp).toMatchObject({ name: 'g', width: 200, height: 100, durationInFrames: 50, backgroundColor: 'transparent' });
    // Copies keep group-local positions and starts; durations end inside the 50-frame component.
    expect(comp.elements.map((e) => [e.id, e.parentId, e.transform.x, e.startFrame, e.durationInFrames])).toEqual([
      ['copy_a', undefined, 10, 0, 50],
      ['copy_m', undefined, 0, 0, 50],
      ['copy_b', undefined, 100, 5, 45],
    ]);
    expect(comp.elements[2].mask).toEqual({ sourceId: 'copy_m', mode: 'alpha' });
    const scene = out.scenes[0].elements;
    expect(scene.map((e) => e.id)).toEqual(['before', 'inst', 'after']);
    const inst = scene[1];
    expect(inst).toMatchObject({ type: 'instance', name: 'g', startFrame: 10, durationInFrames: 50, transform: p.scenes[0].elements[3].transform, props: { compositionId: 'cmp_new', timeOffset: 0, loop: false } });
    expect(inst.tracks).toEqual(p.scenes[0].elements[3].tracks);
  });

  it('keeps the group’s effect animation on the instance', () => {
    const p = grouped();
    const g = p.scenes[0].elements[3];
    g.effects = { blur: 0 };
    g.propTracks = [{ key: 'effects.blur', keyframes: [{ frame: 0, value: 0, easing: 'linear' }, { frame: 30, value: 20, easing: 'linear' }] }];
    expect(resolvedEffects(g, 15).blur).toBe(10);
    const r = componentFromGroup(p, 's', 'g', ids);
    if ('error' in r) throw new Error(r.error);
    const applied = applyCommand(p, r.command, { source: 'user' });
    if (!applied.ok) throw new Error(applied.error.message);
    const inst = applied.project.scenes[0].elements.find((e) => e.id === 'inst')!;
    expect(inst.propTracks).toEqual(g.propTracks);
    expect(inst.propTracks).not.toBe(g.propTracks);
    expect(resolvedEffects(inst, 15).blur).toBe(10);
  });

  it('flags children that stick out of the group box', () => {
    const p = grouped();
    p.scenes[0].elements[1].transform.x = 180; // 180 + 50 > 200
    const r = componentFromGroup(p, 's', 'g', ids);
    expect('error' in r ? null : r.overhang).toBe(true);
  });

  it('refuses locked scenes, non-groups, empty groups and children that start after the group ends', () => {
    const p = grouped();
    const late = grouped();
    late.scenes[0].elements[1].startFrame = 60;
    expect(componentFromGroup(late, 's', 'g', ids)).toHaveProperty('error');
    expect(componentFromGroup({ ...p, scenes: [{ ...p.scenes[0], locked: true }] }, 's', 'g', ids)).toHaveProperty('error');
    expect(componentFromGroup(p, 's', 'a', ids)).toHaveProperty('error');
    expect(componentFromGroup(project([element('g', 'group')]), 's', 'g', ids)).toHaveProperty('error');
  });
});
