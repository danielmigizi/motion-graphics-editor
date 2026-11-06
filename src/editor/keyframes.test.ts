import { describe, expect, it } from 'vitest';
import { applyCommand } from '../core/commands';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import type { Command, CubicBezierEasing, Element, Project } from '../core/types';
import {
  acceptsKey,
  allKeyFrames,
  animatedTracks,
  clampBezier,
  clampRetime,
  copyKeys,
  curveOverflow,
  curvesAllowed,
  curveToPx,
  deleteKeys,
  dragGraphKey,
  dragHandle,
  easingLabel,
  graphRange,
  keyframesOf,
  pasteKeys,
  PRESET_BEZIERS,
  pxToCurve,
  retimeKeys,
  roundTrackValue,
  segmentAt,
  toBezier,
  toggleKey,
  trackLabel,
  transformCurvesSupported,
  type CurveBox,
} from './keyframes';

// Fixture: el_product_card (uiCard, 230 f) has opacity [0 → 15] and x [0 → 24].
const SCENE = 'scn_product';
const project = (): Project => structuredClone(fixtureProject);
const card = (p: Project) => p.scenes.find((s) => s.id === SCENE)!.elements.find((e) => e.id === 'el_product_card')!;

function apply(p: Project, commands: Command[]): Project {
  const r = applyCommand(p, { type: 'batch', label: 'test', commands }, { source: 'user' });
  if (!r.ok) throw new Error(`${r.error.message} @ ${r.error.path}`);
  return r.project;
}

/** Card with property tracks: accentColor keyed at 0 and 30, effects.blur at 10. */
function withPropTracks(p: Project): Project {
  return apply(p, [
    { type: 'setPropertyKeyframe', sceneId: SCENE, elementId: 'el_product_card', key: 'props.accentColor', frame: 0, value: '#FF0000' },
    { type: 'setPropertyKeyframe', sceneId: SCENE, elementId: 'el_product_card', key: 'props.accentColor', frame: 30, value: '#00FF00' },
    { type: 'setPropertyKeyframe', sceneId: SCENE, elementId: 'el_product_card', key: 'effects.blur', frame: 10, value: 40 },
  ]);
}

describe('tracks', () => {
  it('lists transform tracks in property order, then property tracks, with readable labels', () => {
    const el = card(withPropTracks(project()));
    const tracks = animatedTracks(el);
    expect(tracks.map((t) => [t.track, t.label, t.kind, t.numeric, t.eased])).toEqual([
      ['x', 'X position', 'transform', true, true],
      ['opacity', 'Opacity', 'transform', true, true],
      ['props.accentColor', 'Accent', 'prop', false, true],
      ['effects.blur', 'Blur', 'effect', true, true],
    ]);
    expect(trackLabel('text', 'props.fontSize')).toBe('Size');
    expect(trackLabel('path', 'props.trimStart')).toBe('Trim start');
    expect(trackLabel('shape', 'effects.saturate')).toBe('Saturation');
    expect(allKeyFrames(el)).toEqual([0, 10, 15, 24, 30]);
  });

  it('finds the segment that starts at a key', () => {
    const el = card(project());
    expect(segmentAt(el, { track: 'x', frame: 0 })).toEqual({ from: el.tracks[1].keyframes[0], to: el.tracks[1].keyframes[1] });
    expect(segmentAt(el, { track: 'x', frame: 24 })).toBeNull();
  });

  it('toggles keys in a selection', () => {
    const a = { track: 'x', frame: 0 };
    expect(toggleKey([], a)).toEqual([a]);
    expect(toggleKey([a], { ...a })).toEqual([]);
  });
});

describe('retime', () => {
  it('moves selected keys by a delta as one undoable batch (remove, then set)', () => {
    const p = project();
    const el = card(p);
    const r = retimeKeys(SCENE, el, [{ track: 'x', frame: 24 }, { track: 'opacity', frame: 15 }], 6);
    expect(r.keys).toEqual([{ track: 'x', frame: 30 }, { track: 'opacity', frame: 21 }]);
    expect(r.commands.map((c) => c.type)).toEqual(['removeKeyframe', 'removeKeyframe', 'setKeyframe', 'setKeyframe']);
    const next = card(apply(p, r.commands));
    expect(keyframesOf(next, 'x')).toEqual([
      { frame: 0, value: 120, easing: 'easeOut' },
      { frame: 30, value: 0, easing: 'linear' },
    ]);
    expect(keyframesOf(next, 'opacity').map((k) => k.frame)).toEqual([0, 21]);
  });

  it('collision: a moved key replaces the unselected key it lands on', () => {
    const p = project();
    const r = retimeKeys(SCENE, card(p), [{ track: 'x', frame: 0 }], 24);
    const x = keyframesOf(card(apply(p, r.commands)), 'x');
    // The moved key (value 120, easeOut) wins; the old key at 24 is gone.
    expect(x).toEqual([{ frame: 24, value: 120, easing: 'easeOut' }]);
  });

  it('moving several keys keeps their spacing and order', () => {
    const p = project();
    const both = [{ track: 'x', frame: 0 }, { track: 'x', frame: 24 }];
    const x = keyframesOf(card(apply(p, retimeKeys(SCENE, card(p), both, 10).commands)), 'x');
    expect(x.map((k) => [k.frame, k.value])).toEqual([[10, 120], [34, 0]]);
  });

  it('clamps at frame 0 and past the element end', () => {
    const el = card(project());
    expect(clampRetime(el, [{ track: 'x', frame: 24 }], -100)).toBe(-24);
    expect(clampRetime(el, [{ track: 'x', frame: 24 }], 1000)).toBe(229 - 24);
    expect(retimeKeys(SCENE, el, [{ track: 'x', frame: 0 }], -5).commands).toEqual([]);
  });

  it('carries property-track values and easings', () => {
    const p = withPropTracks(project());
    const r = retimeKeys(SCENE, card(p), [{ track: 'props.accentColor', frame: 30 }], -10);
    expect(r.commands.map((c) => c.type)).toEqual(['removePropertyKeyframe', 'setPropertyKeyframe']);
    expect(keyframesOf(card(apply(p, r.commands)), 'props.accentColor').map((k) => [k.frame, k.value])).toEqual([[0, '#FF0000'], [20, '#00FF00']]);
  });

  it('ignores refs to keys that no longer exist', () => {
    const el = card(project());
    expect(retimeKeys(SCENE, el, [{ track: 'x', frame: 5 }], 3).commands).toEqual([]);
    expect(deleteKeys(SCENE, el, [{ track: 'x', frame: 5 }, { track: 'x', frame: 0 }])).toEqual([{ type: 'removeKeyframe', sceneId: SCENE, elementId: 'el_product_card', property: 'x', frame: 0 }]);
  });
});

describe('copy / paste', () => {
  it('pastes at a frame keeping relative spacing, onto the same properties', () => {
    const p = withPropTracks(project());
    const clip = copyKeys(card(p), [{ track: 'x', frame: 24 }, { track: 'opacity', frame: 15 }, { track: 'effects.blur', frame: 10 }])!;
    expect(clip.entries.map((e) => [e.track, e.offset])).toEqual([['effects.blur', 0], ['opacity', 5], ['x', 14]]);
    const r = pasteKeys(SCENE, card(p), clip, 100);
    expect(r.skipped).toBe(0);
    expect(r.keys).toEqual([{ track: 'effects.blur', frame: 100 }, { track: 'opacity', frame: 105 }, { track: 'x', frame: 114 }]);
    const next = card(apply(p, r.commands));
    expect(keyframesOf(next, 'x').map((k) => k.frame)).toEqual([0, 24, 114]);
    expect(keyframesOf(next, 'effects.blur').map((k) => [k.frame, k.value])).toEqual([[10, 40], [100, 40]]);
  });

  it('pasting onto an existing key replaces it', () => {
    const p = project();
    const clip = copyKeys(card(p), [{ track: 'x', frame: 0 }])!;
    const next = card(apply(p, pasteKeys(SCENE, card(p), clip, 24).commands));
    expect(keyframesOf(next, 'x')).toEqual([
      { frame: 0, value: 120, easing: 'easeOut' },
      { frame: 24, value: 120, easing: 'easeOut' },
    ]);
  });

  it('skips properties the target element does not have, and frames before 0', () => {
    const p = withPropTracks(project());
    const clip = copyKeys(card(p), [{ track: 'props.accentColor', frame: 0 }, { track: 'opacity', frame: 15 }])!;
    const headline = p.scenes.find((s) => s.id === SCENE)!.elements.find((e) => e.id === 'el_product_headline')!;
    const r = pasteKeys(SCENE, headline, clip, 0);
    expect(r.skipped).toBe(1); // text has no accentColor
    expect(r.keys).toEqual([{ track: 'opacity', frame: 15 }]);
    apply(p, r.commands);
    expect(pasteKeys(SCENE, headline, { entries: [{ track: 'x', offset: 0, value: 1, easing: 'linear' }] }, -3).skipped).toBe(1);
  });

  it('checks values against the target property', () => {
    const p = project();
    const el = card(p);
    const image = p.scenes.find((s) => s.id === SCENE)!.elements.find((e) => e.id === 'el_product_image')!;
    expect(acceptsKey(image, 'props.cornerRadius', 40)).toBe(true);
    expect(acceptsKey(image, 'props.cornerRadius', 9999)).toBe(false);
    expect(acceptsKey(image, 'props.cornerRadius', '40')).toBe(false);
    expect(acceptsKey(el, 'props.cornerRadius', 40)).toBe(false); // not animatable on a UI card
    expect(acceptsKey(el, 'props.accentColor', '#123456')).toBe(true);
    expect(acceptsKey(el, 'props.title', 'Hi')).toBe(false);
    expect(acceptsKey(el, 'effects.blur', 12)).toBe(true);
    expect(acceptsKey(el, 'effects.glow', 1)).toBe(false);
  });

  it('copies nothing from an empty selection', () => {
    expect(copyKeys(card(project()), [])).toBeNull();
  });
});

describe('curve editor math', () => {
  const box: CurveBox = { width: 200, height: 200, yMin: -0.5, yMax: 1.5 };

  it('maps curve space to the box and back', () => {
    expect(curveToPx(box, 0, 0)).toEqual({ px: 0, py: 150 });
    expect(curveToPx(box, 1, 1)).toEqual({ px: 200, py: 50 });
    expect(pxToCurve(box, 100, 100)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('turns a handle drag into bezier numbers: x clamps to 0..1, y to -2..3, 3 decimals', () => {
    const b: CubicBezierEasing = { type: 'cubicBezier', x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
    expect(dragHandle(b, 1, 50, 100, box)).toEqual({ ...b, x1: 0.25, y1: 0.5 });
    // Beyond the box horizontally: x pins to the edge.
    expect(dragHandle(b, 2, 260, 50, box)).toEqual({ ...b, x2: 1, y2: 1 });
    expect(dragHandle(b, 1, -40, 50, box).x1).toBe(0);
    // Far above / below the visible window: y stops at the validated range.
    expect(dragHandle(b, 1, 100, -2000, box).y1).toBe(3);
    expect(dragHandle(b, 2, 100, 5000, box).y2).toBe(-2);
    expect(dragHandle(b, 1, 33.3333, 0, box).x1).toBe(0.167);
  });

  it('flags handles outside the visible window', () => {
    expect(curveOverflow(box, 2)).toBe(1);
    expect(curveOverflow(box, -1)).toBe(-1);
    expect(curveOverflow(box, 1.2)).toBe(0);
  });

  it('clamps typed numbers and maps presets to curves', () => {
    expect(clampBezier({ type: 'cubicBezier', x1: -1, y1: 9, x2: 1.4, y2: -3 })).toEqual({ type: 'cubicBezier', x1: 0, y1: 3, x2: 1, y2: -2 });
    expect(toBezier('easeInOut')).toEqual(PRESET_BEZIERS.easeInOut);
    expect(toBezier('hold')).toBeNull();
    expect(easingLabel('easeOutExpo')).toBe('Out expo');
    expect(easingLabel({ type: 'cubicBezier', x1: 0.3, y1: 1.9, x2: 0.5, y2: 0.8 })).toBe('Bounce-ish');
    expect(easingLabel({ type: 'cubicBezier', x1: 0.1, y1: 0.2, x2: 0.3, y2: 0.4 })).toBe('Custom (0.1, 0.2, 0.3, 0.4)');
  });

  it('offers curves on property tracks; transform tracks follow core support', () => {
    expect(curvesAllowed('props.accentColor')).toBe(true);
    expect(curvesAllowed('x')).toBe(transformCurvesSupported);
  });

  it('writes a custom curve to a property-track segment', () => {
    const p = withPropTracks(project());
    const curve = { type: 'cubicBezier' as const, x1: 0.2, y1: -0.4, x2: 0.6, y2: 1.3 };
    const next = card(apply(p, [{ type: 'setPropertyKeyframe', sceneId: SCENE, elementId: 'el_product_card', key: 'props.accentColor', frame: 0, value: '#FF0000', easing: curve }]));
    expect(keyframesOf(next, 'props.accentColor')[0].easing).toEqual(curve);
  });
});

describe('value graph math', () => {
  const keys = [
    { frame: 0, value: 120, easing: 'easeOut' as const },
    { frame: 24, value: 0, easing: 'linear' as const },
  ];

  it('frames the keyed span and the value range with margins', () => {
    const r = graphRange(keys);
    expect(r.frameMin).toBe(0);
    expect(r.frameMax).toBe(29); // 24 + 20 % margin
    expect(r.valueMin).toBeLessThan(0);
    expect(r.valueMax).toBeGreaterThan(120);
    expect(graphRange([{ frame: 100, value: 0, easing: 'linear' }, { frame: 140, value: 1, easing: 'linear' }]).frameMin).toBe(92);
    // Overshoot is inside the range.
    expect(graphRange([{ frame: 0, value: 0, easing: 'backOut' }, { frame: 30, value: 100, easing: 'linear' }]).valueMax).toBeGreaterThan(110);
    const flat = graphRange([{ frame: 0, value: 1, easing: 'linear' }]);
    expect(flat.valueMax).toBeGreaterThan(flat.valueMin);
  });

  it('drags a key: horizontal retimes between neighbours, vertical changes the value', () => {
    const box = { width: 230, height: 100, frameMin: 0, frameMax: 230, valueMin: 0, valueMax: 200 };
    // 1 px = 1 frame, 1 px = 2 value units.
    expect(dragGraphKey('uiCard', 'x', { frame: 24, value: 0 }, 10, -15, box, { prev: 0, next: null })).toEqual({ frame: 34, value: 30 });
    // Never onto / past a neighbour.
    expect(dragGraphKey('uiCard', 'x', { frame: 24, value: 0 }, -50, 0, box, { prev: 0, next: null }).frame).toBe(1);
    expect(dragGraphKey('uiCard', 'x', { frame: 0, value: 120 }, 80, 0, box, { prev: null, next: 24 }).frame).toBe(23);
    // Axis lock keeps the larger movement only.
    expect(dragGraphKey('uiCard', 'x', { frame: 24, value: 0 }, 3, -40, box, { prev: 0, next: null }, true)).toEqual({ frame: 24, value: 80 });
  });

  it('rounds and limits values per track', () => {
    expect(roundTrackValue('uiCard', 'x', 12.345)).toBe(12.3);
    expect(roundTrackValue('uiCard', 'opacity', -0.2)).toBe(0);
    expect(roundTrackValue('uiCard', 'scale', 0)).toBe(0.001);
    expect(roundTrackValue('image', 'props.cornerRadius', 12.7)).toBe(13);
    expect(roundTrackValue('image', 'props.cornerRadius', 900)).toBe(500);
    expect(roundTrackValue('path', 'props.trimEnd', 0.12345)).toBe(0.12);
    expect(roundTrackValue('shape', 'effects.blur', 250)).toBe(200);
  });
});

// Keep the fixture's element type in sync with the expectations above.
it('fixture sanity', () => {
  const el: Element = card(project());
  expect(el.type).toBe('uiCard');
  expect(el.durationInFrames).toBe(230);
});
