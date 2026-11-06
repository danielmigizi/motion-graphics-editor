import { describe, expect, it } from 'vitest';
import { fixtureProject } from './__fixtures__/fixtureProject';
import { evaluateElement, evaluatePropertyTrack } from './animation';
import { applyCommand } from './commands';
import { COMPONENTS, ELEMENT_TYPES } from './components';
import { execute, createDocState } from './history';
import { applyStagger, defaultPresetOptions, followThroughCommands, matchCutCommands, PRESET_IDS, PRESETS, presetAppliesTo, presetCommands, staggerPlan, withoutEntrance, withPreset, withStagger, type PresetId } from './presets';
import { MOTION_PERSONALITIES, STYLE_PACK_IDS, STYLE_PACKS } from './style';
import type { Element, ElementType, Project } from './types';
import { validateProject } from './validate';

/** The fixture plus one element of every type in a fresh scene (group child and composition for the instance). */
function everyTypeProject(): Project {
  const p = structuredClone(fixtureProject);
  p.compositions = {
    cmp_badge: { id: 'cmp_badge', name: 'Badge', width: 400, height: 200, durationInFrames: 60, backgroundColor: 'transparent', elements: [] },
  };
  p.assets.ast_clip = { id: 'ast_clip', kind: 'video', name: 'Clip', src: 'assets/uploads/u_clip.mp4', mimeType: 'video/mp4', width: 1920, height: 1080, durationInFrames: 300, fps: 30, hasAudio: true };
  const make = (type: ElementType): Element => {
    const props: Record<string, unknown> = structuredClone(COMPONENTS[type].defaultProps);
    if (type === 'logo') props.assetId = 'ast_logo';
    if (type === 'image') props.assetId = 'ast_screenshot';
    if (type === 'instance') props.compositionId = 'cmp_badge';
    if (type === 'video') props.assetId = 'ast_clip';
    if (type === 'text') props.text = 'Every type, animated';
    const { width, height } = COMPONENTS[type].defaultSize;
    return { id: `el_all_${type}`, type, name: type, startFrame: 0, durationInFrames: 120, visible: true, transform: { x: 100, y: 100, width, height, rotation: 0, scale: 1, opacity: 1 }, props, tracks: [] };
  };
  p.scenes.push({ id: 'scn_all', name: 'All types', durationInFrames: 120, backgroundColor: '#000000', locked: false, transitionIn: { type: 'none', durationInFrames: 0 }, elements: ELEMENT_TYPES.map(make) });
  return p;
}

const el = (p: Project, id: string) => p.scenes.flatMap((s) => s.elements).find((e) => e.id === id)!;

describe('motion presets', () => {
  const base = everyTypeProject();

  it('produce valid keyframe commands for every applicable element type', () => {
    expect(validateProject(base).ok).toBe(true);
    let applied = 0;
    for (const id of PRESET_IDS) {
      const preset = PRESETS[id];
      for (const type of ELEMENT_TYPES) {
        const element = el(base, `el_all_${type}`);
        const commands = presetCommands('scn_all', element, id, defaultPresetOptions(preset, element, { fps: 30, localFrame: 40 }));
        if (!presetAppliesTo(preset, element)) {
          expect(commands, `${id} on ${type}`).toEqual([]);
          continue;
        }
        expect(commands.length, `${id} on ${type}`).toBeGreaterThan(0);
        const r = applyCommand(base, { type: 'batch', label: id, commands }, { source: 'user' });
        expect(r.ok, `${id} on ${type}: ${r.ok ? '' : `${r.error.message} at ${r.error.path}`}`).toBe(true);
        if (r.ok) expect(validateProject(r.project).ok).toBe(true);
        applied++;
      }
    }
    expect(applied).toBeGreaterThan(PRESET_IDS.length * 3);
  });

  it('only writes ordinary keys and reveal props', () => {
    const element = el(base, 'el_all_text');
    const types = new Set(PRESET_IDS.flatMap((id) => presetCommands('scn_all', element, id, defaultPresetOptions(PRESETS[id], element, { fps: 30 })).map((c) => c.type)));
    expect([...types].sort()).toEqual(['setKeyframe', 'setPropertyKeyframe', 'updateElement'].sort());
  });

  it('animate the way their names say', () => {
    const run = (id: PresetId, elementId: string) => {
      const element = el(base, elementId);
      const r = applyCommand(base, { type: 'batch', label: id, commands: presetCommands('scn_all', element, id, defaultPresetOptions(PRESETS[id], element, { fps: 30 })) }, { source: 'user' });
      if (!r.ok) throw new Error(r.error.message);
      return el(r.project, elementId);
    };
    const rise = run('riseIn', 'el_all_shape');
    expect(evaluateElement(rise, 0)).toMatchObject({ y: 100 + 48, opacity: 0 });
    expect(evaluateElement(rise, 18)).toMatchObject({ y: 100, opacity: 1 });
    const fade = run('fadeOut', 'el_all_shape');
    expect(evaluateElement(fade, 100).opacity).toBe(1);
    expect(evaluateElement(fade, 119).opacity).toBe(0);
    const wipe = run('wipeOn', 'el_all_path');
    expect(evaluatePropertyTrack(wipe, 'props.trimEnd', 0)).toBe(0);
    expect(evaluatePropertyTrack(wipe, 'props.trimEnd', 30)).toBe(1);
    const blur = run('blurIn', 'el_all_image');
    expect(evaluatePropertyTrack(blur, 'effects.blur', 0)).toBe(24);
    expect(evaluatePropertyTrack(blur, 'effects.blur', 21)).toBe(0);
    const pop = run('popIn', 'el_all_uiCard');
    expect(Math.max(...[3, 6, 9, 12].map((f) => evaluateElement(pop, f).scale))).toBeGreaterThan(1); // back-out overshoot
    const snap = run('snapPop', 'el_all_shape');
    expect(evaluateElement(snap, 0).opacity).toBe(0);
    expect(evaluateElement(snap, 0).scale).toBeLessThan(0.7);
    expect(evaluateElement(snap, 5).opacity).toBe(1);
    const spring = run('springIn', 'el_all_shape');
    expect(evaluateElement(spring, 0).scale).toBeGreaterThan(2);
    expect(evaluateElement(spring, 15).scale).toBeCloseTo(1, 1);
    const smear = run('smear', 'el_all_shape');
    const smearBlur = Array.from({ length: 120 }, (_, f) => Number(evaluatePropertyTrack(smear, 'effects.blur', f) ?? 0));
    expect(Math.max(...smearBlur)).toBeGreaterThan(4);
    expect(smearBlur[119]).toBe(0);
    const typed = run('typewriter', 'el_all_text');
    expect(typed.props).toMatchObject({ reveal: 'typewriter', revealDurationInFrames: 45 });
    const stagger = run('charStagger', 'el_all_text');
    expect(stagger.props.reveal).toBe('charFadeUp');
    expect(stagger.props.revealStagger).toBeGreaterThanOrEqual(1);
    const float = run('floatLoop', 'el_all_logo');
    const ys = Array.from({ length: 120 }, (_, f) => evaluateElement(float, f).y - 100);
    expect(Math.min(...ys)).toBeCloseTo(-12, 0);
    expect(Math.max(...ys)).toBeCloseTo(12, 0);
    expect(ys[119]).toBe(0);
  });

  it('switch off the built-in reveal when a text gets an entrance, and replace keys inside their window', () => {
    const headline = el(fixtureProject, 'el_intro_headline'); // reveal: wordStagger
    const commands = presetCommands('scn_intro', headline, 'fadeIn', defaultPresetOptions(PRESETS.fadeIn, headline, { fps: 30 }));
    expect(commands).toContainEqual({ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { reveal: 'none' } } });

    const withKeys: Element = { ...el(base, 'el_all_shape'), tracks: [{ property: 'opacity', keyframes: [{ frame: 0, value: 0.2, easing: 'linear' }, { frame: 5, value: 0.7, easing: 'linear' }, { frame: 60, value: 0.5, easing: 'hold' }] }] };
    const cmds = presetCommands('scn_all', withKeys, 'fadeIn', { at: 0, duration: 15, intensity: 1, fps: 30 });
    expect(cmds[0]).toEqual({ type: 'removeKeyframe', sceneId: 'scn_all', elementId: withKeys.id, property: 'opacity', frame: 5 });
    // In-memory application (templates) matches the commands.
    const p = structuredClone(base);
    p.scenes[3].elements[p.scenes[3].elements.findIndex((e) => e.id === withKeys.id)] = withKeys;
    const r = applyCommand(p, { type: 'batch', label: 'x', commands: cmds }, { source: 'user' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(el(r.project, withKeys.id)).toEqual(withPreset(withKeys, 'fadeIn', { at: 0, duration: 15, intensity: 1, fps: 30 }));
  });

  it('places entrances at the start, exits at the end, emphasis at the playhead', () => {
    const shape = el(base, 'el_all_shape');
    expect(defaultPresetOptions(PRESETS.riseIn, shape, { fps: 30 })).toMatchObject({ at: 0, duration: 18 });
    expect(defaultPresetOptions(PRESETS.fadeOut, shape, { fps: 30 })).toMatchObject({ at: 104, duration: 15 });
    expect(defaultPresetOptions(PRESETS.pulse, shape, { fps: 30, localFrame: 50 })).toMatchObject({ at: 50, duration: 18 });
    expect(defaultPresetOptions(PRESETS.floatLoop, shape, { fps: 30, localFrame: 500 })).toMatchObject({ at: 0, duration: 119 });
    // Playhead outside: emphasis mid-element, loops after the entrance, so neither replaces it.
    const entered = withPreset(shape, 'riseIn', { at: 0, duration: 18, intensity: 1, fps: 30 });
    expect(defaultPresetOptions(PRESETS.pulse, entered, { fps: 30, localFrame: -6 })).toMatchObject({ at: 51, duration: 18 });
    expect(defaultPresetOptions(PRESETS.floatLoop, entered, { fps: 30 })).toMatchObject({ at: 18, duration: 101 });
    // A short element squeezes the window instead of keying past its end.
    const short = { ...shape, durationInFrames: 6 };
    expect(defaultPresetOptions(PRESETS.riseIn, short, { fps: 30 })).toMatchObject({ at: 0, duration: 5 });
    expect(presetAppliesTo(PRESETS.riseIn, { ...shape, durationInFrames: 1 })).toBe(false);
  });

  it('applying one is a single undo step', () => {
    const shape = el(base, 'el_all_shape');
    const state = createDocState(base);
    const r = execute(state, { type: 'batch', label: 'Rise in', commands: presetCommands('scn_all', shape, 'riseIn', defaultPresetOptions(PRESETS.riseIn, shape, { fps: 30 })) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.state.undoStack).toHaveLength(1);
      expect(r.state.project.revision).toBe(base.revision + 1);
    }
  });
});

describe('motion presets read the style pack', () => {
  const base = everyTypeProject();
  const shape = el(base, 'el_all_shape');

  it('produce valid keys on every applicable type with every pack', () => {
    for (const packId of STYLE_PACK_IDS) {
      const motion = STYLE_PACKS[packId].motion;
      const project = { ...base, style: STYLE_PACKS[packId] };
      for (const id of PRESET_IDS) {
        for (const type of ELEMENT_TYPES) {
          const element = el(project, `el_all_${type}`);
          const commands = presetCommands('scn_all', element, id, defaultPresetOptions(PRESETS[id], element, { fps: 30, localFrame: 40, motion }));
          if (!presetAppliesTo(PRESETS[id], element)) continue;
          const r = applyCommand(project, { type: 'batch', label: id, commands }, { source: 'user' });
          expect(r.ok, `${packId} · ${id} on ${type}: ${r.ok ? '' : `${r.error.message} at ${r.error.path}`}`).toBe(true);
        }
      }
    }
  });

  it('retime and re-ease when the pack changes', () => {
    const snappy = defaultPresetOptions(PRESETS.riseIn, shape, { fps: 30, motion: MOTION_PERSONALITIES.snappy });
    const premium = defaultPresetOptions(PRESETS.riseIn, shape, { fps: 30, motion: MOTION_PERSONALITIES.premium });
    expect(snappy.duration).toBe(14); // 0.6 s × 0.8
    expect(premium.duration).toBe(24); // 0.6 s × 1.35
    const yKey = (motion: (typeof MOTION_PERSONALITIES)['snappy']) => withPreset(shape, 'riseIn', defaultPresetOptions(PRESETS.riseIn, shape, { fps: 30, motion })).tracks.find((t) => t.property === 'y')!.keyframes[0].easing;
    expect(yKey(MOTION_PERSONALITIES.snappy)).toEqual(MOTION_PERSONALITIES.snappy.enter);
    expect(yKey(MOTION_PERSONALITIES.editorial)).toEqual(MOTION_PERSONALITIES.editorial.enter);
    // Exits take the exit curve; playful's back-in winds back before leaving.
    const out = withPreset(shape, 'slideOutRight', defaultPresetOptions(PRESETS.slideOutRight, shape, { fps: 30, motion: MOTION_PERSONALITIES.playful }));
    const xs = Array.from({ length: 30 }, (_, f) => evaluateElement(out, 92 + f).x - 100);
    expect(Math.min(...xs)).toBeLessThan(0);
    // Overshoot amounts come from the pack: a snappy pop passes 100% by its 4 %.
    const pop = withPreset(shape, 'popIn', defaultPresetOptions(PRESETS.popIn, shape, { fps: 30, motion: MOTION_PERSONALITIES.snappy }));
    expect(Math.max(...pop.tracks.find((t) => t.property === 'scale')!.keyframes.map((k) => k.value))).toBeCloseTo(1.04, 5);
    // Without a pack nothing changes from the editor defaults.
    expect(withPreset(shape, 'riseIn', defaultPresetOptions(PRESETS.riseIn, shape, { fps: 30 })).tracks.find((t) => t.property === 'y')!.keyframes[0].easing).toBe('easeOutCubic');
  });
});

describe('principle presets', () => {
  const base = everyTypeProject();
  const shape = el(base, 'el_all_shape'); // 400×400 at (100, 100), 120 frames
  const run = (id: PresetId, element: Element = shape) => withPreset(element, id, defaultPresetOptions(PRESETS[id], element, { fps: 30, localFrame: 30 }));
  const at = (e: Element, f: number) => evaluateElement(e, f);

  it('overshoot and settle passes its size, swings back, settles', () => {
    const e = run('overshootSettle');
    const scales = Array.from({ length: 22 }, (_, f) => at(e, f).scale);
    expect(Math.max(...scales)).toBeCloseTo(1.08, 2);
    expect(Math.min(...scales.slice(12))).toBeLessThan(1);
    expect(at(e, 21).scale).toBe(1);
    const tuned = withPreset(shape, 'overshootSettle', { at: 0, duration: 21, intensity: 1, fps: 30, overshoot: 0.2 });
    expect(Math.max(...Array.from({ length: 22 }, (_, f) => at(tuned, f).scale))).toBeCloseTo(1.2, 2);
  });

  it('squash on land compresses at the floor and keeps the base planted', () => {
    const e = run('squashLand'); // 24 frames: lands at 12, squash at 15
    expect(at(e, 0).y).toBe(100 - 200);
    expect(at(e, 12)).toMatchObject({ y: 100, scale: 1 });
    const squashed = at(e, 15);
    expect(squashed.scale).toBeCloseTo(0.92, 5);
    // Bottom edge (centre + half height × scale) stays on the floor at y = 500.
    expect(squashed.y + 200 + 200 * squashed.scale).toBeCloseTo(500, 0);
  });

  it('arc in travels a curve, not a line', () => {
    const e = run('arcIn');
    const p0 = at(e, 0);
    const mid = at(e, 12);
    const p1 = at(e, 24);
    // Distance of the midpoint from the straight chord.
    const cross = Math.abs((p1.x - p0.x) * (mid.y - p0.y) - (p1.y - p0.y) * (mid.x - p0.x)) / Math.hypot(p1.x - p0.x, p1.y - p0.y);
    expect(cross).toBeGreaterThan(30);
  });

  it('hold and hit snaps one frame in and decays', () => {
    const e = run('holdHit');
    expect(at(e, 30).scale).toBe(1);
    expect(at(e, 31).scale).toBeCloseTo(1.1, 5);
    expect(at(e, 42).scale).toBe(1);
    expect(e.propTracks?.find((t) => t.key === 'effects.brightness')?.keyframes[1]).toMatchObject({ frame: 31, value: 1.35 });
  });

  it('anticipate and go winds back before launching', () => {
    const e = run('anticipateGo'); // last 21 frames
    const xs = Array.from({ length: 21 }, (_, f) => at(e, 98 + f).x - 100);
    expect(Math.min(...xs)).toBeCloseTo(-24, 0);
    expect(xs.indexOf(Math.min(...xs))).toBeLessThan(xs.length / 2);
    expect(at(e, 119)).toMatchObject({ x: 340, opacity: 0 });
  });

  it('match-cut out and in push through the cut at matching scale', () => {
    const out = run('matchOut');
    const into = run('matchIn');
    expect(at(out, 119).scale).toBeCloseTo(1.25, 5);
    expect(at(into, 0).scale).toBeCloseTo(0.8, 5);
    expect(at(out, 119).opacity).toBe(1);
  });
});

describe('arrive apart (applyStagger)', () => {
  const base = everyTypeProject();
  const scene = base.scenes[3];
  const items = ['shape', 'image', 'uiCard'].map((t) => el(base, `el_all_${t}`)).map((e, i) => ({ ...e, transform: { ...e.transform, x: 100 + i * 500, y: 600 - i * 200 } }));

  it('offsets each arrival by the stagger, in reading order, as one valid batch', () => {
    const plan = staggerPlan(items, 'riseIn', { fps: 30, stagger: 5, order: 'reading' });
    expect(plan.map((p) => p.element.id)).toEqual(['el_all_uiCard', 'el_all_image', 'el_all_shape']); // top row first
    expect(plan.map((p) => p.options.at)).toEqual([0, 5, 10]);
    const project = structuredClone(base);
    project.scenes[3] = { ...scene, elements: scene.elements.map((e) => items.find((i) => i.id === e.id) ?? e) };
    const commands = applyStagger(items, 'riseIn', { sceneId: 'scn_all', fps: 30, stagger: 5 });
    const r = execute(createDocState(project), { type: 'batch', label: 'Arrive apart', commands });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.undoStack).toHaveLength(1);
  });

  it('takes the stagger from the pack and orders importance or centre-out', () => {
    expect(staggerPlan(items, 'fadeIn', { fps: 30, motion: MOTION_PERSONALITIES.premium }).map((p) => p.options.at)).toEqual([0, 6, 12]);
    expect(staggerPlan(items, 'fadeIn', { fps: 30, order: 'importance' })[0].element.id).toBe('el_all_image');
    const staggered = withStagger(items, 'fadeIn', { fps: 30, stagger: 4, order: 'given' });
    expect(staggered.map((e) => e.tracks[0].keyframes[0].frame)).toEqual([0, 4, 8]);
  });

  it('puts later-starting siblings on the same clock, and exits leave in order', () => {
    const late = [items[0], { ...items[1], startFrame: 6 }];
    expect(staggerPlan(late, 'fadeIn', { fps: 30, stagger: 4, order: 'given' }).map((p) => p.options.at)).toEqual([2, 0]); // Delay the common start so the later layer can keep the four-frame stagger
    const exits = staggerPlan(items, 'fadeOut', { fps: 30, stagger: 4, order: 'given' });
    expect(exits.map((p) => p.options.at + p.options.duration)).toEqual([111, 115, 119]);
  });
});

describe('arrive apart replaces existing entrances', () => {
  // The sample Product scene: the card (fade in 0–15 + slide from the right
  // 0–24) and both chat bubbles (fade in + slide up) already arrive; the
  // headline has no keys (only its text reveal).
  const ids = ['el_product_card', 'el_product_chat_user', 'el_product_chat_ai', 'el_product_headline'];
  const stagger = (presetId: PresetId = 'riseIn') => {
    const p = structuredClone(fixtureProject);
    const scene = p.scenes[1];
    const targets = scene.elements.filter((e) => ids.includes(e.id));
    const commands = applyStagger(targets, presetId, { sceneId: scene.id, fps: 30, stagger: 4, order: 'given', within: scene.elements });
    const r = applyCommand(p, { type: 'batch', label: 'Arrive apart', commands }, { source: 'user' });
    if (!r.ok) throw new Error(r.error.message);
    expect(validateProject(r.project).ok).toBe(true);
    return { before: scene, after: r.project.scenes[1] };
  };
  /** Times the opacity turns from falling or flat-at-0 to rising (arrivals), over the element's life. */
  const arrivals = (e: Element) => {
    let n = 0;
    let rising = false;
    for (let f = e.startFrame; f < e.startFrame + e.durationInFrames - 1; f++) {
      const up = evaluateElement(e, f + 1).opacity > evaluateElement(e, f).opacity + 1e-6;
      if (up && !rising) n++;
      rising = up;
    }
    return n;
  };

  it('each layer arrives exactly once, on the stagger clock', () => {
    const { before, after } = stagger();
    for (const id of ids) expect(arrivals(after.elements.find((e) => e.id === id)!), id).toBe(1);
    // Before the fix the card faded in, faded out to make room, then faded in again.
    const card = after.elements.find((e) => e.id === 'el_product_card')!;
    const opacity = card.tracks.find((t) => t.property === 'opacity')!.keyframes;
    expect(opacity.map((k) => k.value)).toEqual([0, 1]);
    expect(opacity[0].frame).toBeGreaterThan(24); // the card waits for the stagger, it does not arrive twice
    // Its own slide from the right is part of the entrance it replaces: the settled pose (x offset 0) stays as one key.
    expect(card.tracks.find((t) => t.property === 'x')!.keyframes).toEqual([{ frame: 24, value: 0, easing: 'linear' }]);
    // Scene-clock arrivals 4 frames apart, in the order given (the scene's layer order).
    const starts = ['el_product_headline', 'el_product_card', 'el_product_chat_user', 'el_product_chat_ai'].map((id) => {
      const e = after.elements.find((x) => x.id === id)!;
      return e.startFrame + e.tracks.find((t) => t.property === 'opacity')!.keyframes[0].frame;
    });
    expect(starts.slice(1).map((s, i) => s - starts[i])).toEqual([4, 4, 4]);
    // A layer without an entrance just gains the preset's keys.
    const headline = after.elements.find((e) => e.id === 'el_product_headline')!;
    expect(before.elements.find((e) => e.id === 'el_product_headline')!.tracks).toEqual([]);
    expect(headline.tracks.map((t) => t.property).sort()).toEqual(['opacity', 'y']);
  });

  it('keeps keys after the entrance (an exit) and leaves elements without an entrance alone', () => {
    const card = el(fixtureProject, 'el_product_card');
    const withExit: Element = { ...card, tracks: card.tracks.map((t) => (t.property === 'opacity' ? { ...t, keyframes: [...t.keyframes, { frame: 200, value: 1, easing: 'easeIn' }, { frame: 229, value: 0, easing: 'linear' }] } : t)) };
    const plan = { keys: [{ track: 'opacity' as const, frame: 100, value: 0 }, { track: 'opacity' as const, frame: 110, value: 1 }] };
    const cleared = withoutEntrance(withExit, plan);
    expect(cleared.tracks.find((t) => t.property === 'opacity')!.keyframes.map((k) => k.frame)).toEqual([200, 229]);
    expect(cleared.tracks.find((t) => t.property === 'x')!.keyframes.map((k) => k.frame)).toEqual([24]);
    const still: Element = { ...card, tracks: [{ property: 'opacity', keyframes: [{ frame: 0, value: 0.6, easing: 'linear' }] }] };
    expect(withoutEntrance(still, plan)).toBe(still);
    // Templates (withStagger) follow the same rule.
    const [a] = withStagger([withExit, { ...card, id: 'el_other' }], 'fadeIn', { fps: 30, stagger: 4, order: 'given' });
    expect(arrivals(a)).toBe(1);
  });
});

describe('follow-through and match cuts', () => {
  it('follow-through: the group arrives, its children trail then carry on past the stop', () => {
    const p = structuredClone(fixtureProject);
    const scene = p.scenes[1];
    const kids = scene.elements.slice(0, 2).map((e) => e.id);
    const grouped = applyCommand(p, { type: 'groupElements', sceneId: scene.id, elementIds: kids, group: { id: 'el_grp', name: 'Group' } }, { source: 'user' });
    if (!grouped.ok) throw new Error(grouped.error.message);
    const s = grouped.project.scenes[1];
    const group = s.elements.find((e) => e.id === 'el_grp')!;
    const children = s.elements.filter((e) => e.parentId === 'el_grp');
    const commands = followThroughCommands(s.id, group, children, { fps: 30 });
    const r = applyCommand(grouped.project, { type: 'batch', label: 'Follow-through', commands }, { source: 'user' });
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
    if (!r.ok) return;
    const after = r.project.scenes[1].elements;
    const g = after.find((e) => e.id === 'el_grp')!;
    expect(g.tracks.find((t) => t.property === 'x')!.keyframes.map((k) => k.value)).toEqual([-200, 0]);
    const child = after.find((e) => e.id === children[0].id)!;
    const values = child.tracks.find((t) => t.property === 'x')!.keyframes.map((k) => k.value);
    expect(values[0]).toBeLessThan(0); // trails
    expect(values[1]).toBeGreaterThan(0); // carries on
    expect(values[2]).toBe(0); // settles
  });

  it('match cut: same centre and size on both sides of the cut', () => {
    const p = structuredClone(fixtureProject);
    const a = p.scenes[0].elements.find((e) => !e.parentId && e.type === 'text')!;
    const b = p.scenes[1].elements.find((e) => !e.parentId && e.type !== 'text')!;
    const aEnd = { ...a, durationInFrames: p.scenes[0].durationInFrames - a.startFrame };
    p.scenes[0].elements = p.scenes[0].elements.map((e) => (e.id === a.id ? aEnd : e));
    const bStart = { ...b, startFrame: 0 };
    p.scenes[1].elements = p.scenes[1].elements.map((e) => (e.id === b.id ? bStart : e));
    const commands = matchCutCommands({ sceneId: p.scenes[0].id, element: aEnd }, { sceneId: p.scenes[1].id, element: bStart }, { fps: 30 });
    const r = applyCommand(p, { type: 'batch', label: 'Match cut', commands }, { source: 'user' });
    expect(r.ok, r.ok ? '' : `${r.error.message} at ${r.error.path}`).toBe(true);
    if (!r.ok) return;
    const A = r.project.scenes[0].elements.find((e) => e.id === a.id)!;
    const B = r.project.scenes[1].elements.find((e) => e.id === b.id)!;
    const ea = evaluateElement(A, A.startFrame + A.durationInFrames - 1); // scene-relative
    const eb = evaluateElement(B, 0);
    const centre = (e: typeof ea, el: Element) => ({ x: e.x + el.transform.width / 2, y: e.y + el.transform.height / 2 });
    expect(centre(ea, A).x).toBeCloseTo(centre(eb, B).x, 0);
    expect(centre(ea, A).y).toBeCloseTo(centre(eb, B).y, 0);
    const size = (el: Element, s: number) => Math.sqrt(el.transform.width * el.transform.height) * s;
    expect(size(A, ea.scale)).toBeCloseTo(size(B, eb.scale), 0);
    expect(r.project.scenes[1].transitionIn).toEqual({ type: 'none', durationInFrames: 0 });
  });
});
