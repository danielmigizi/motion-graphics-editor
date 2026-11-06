import { describe, expect, it } from 'vitest';
import { fixtureProject } from './__fixtures__/fixtureProject';
import { evaluateElementWorld } from './animation';
import { exampleProject } from './guide';
import { createDocState, execute } from './history';
import { contrastRatio, TYPE_MIN } from './motionRules';
import { STYLE_PACK_IDS, STYLE_PACKS } from './style';
import { buildTemplate, COMMON_TEMPLATE_PARAMS, projectStyle, TEMPLATE_IDS, TEMPLATES, type TemplateId, type TemplateParams } from './templates';
import type { Element, Project } from './types';
import { validateProject } from './validate';

const counter = () => {
  let n = 0;
  return () => `el_t${++n}`;
};

function insert(project: Project, id: TemplateId, sceneId: string, at = 0) {
  const built = buildTemplate(id, {}, { sceneId, at, project, newId: counter() });
  if (!built.ok) throw new Error(built.message);
  const r = execute(createDocState(project), { type: 'batch', label: built.label, commands: built.commands });
  return { built, r };
}

const sized = (width: number, height: number): Project => ({ ...structuredClone(fixtureProject), width, height });

describe('templates', () => {
  it.each(TEMPLATE_IDS)('%s inserts one valid group as one undo step, in every aspect', (id) => {
    for (const project of [structuredClone(fixtureProject), sized(1080, 1920), sized(1080, 1080), sized(1080, 1350)]) {
      const { built, r } = insert(project, id, 'scn_product', 30);
      expect(r.ok, r.ok ? '' : `${r.error.message} at ${r.error.path}`).toBe(true);
      if (!r.ok) continue;
      expect(r.state.undoStack).toHaveLength(1);
      expect(validateProject(r.state.project).ok).toBe(true);
      const [group, ...children] = built.elements;
      expect(group.type).toBe('group');
      expect(group.startFrame).toBe(30);
      expect(children.length).toBeGreaterThanOrEqual(2);
      for (const child of children) {
        expect(child.parentId).toBe(group.id);
        expect(child.startFrame + child.durationInFrames).toBeLessThanOrEqual(group.durationInFrames);
        // Inside the group box.
        expect(child.transform.x).toBeGreaterThanOrEqual(0);
        expect(child.transform.y).toBeGreaterThanOrEqual(0);
        expect(child.transform.x + child.transform.width).toBeLessThanOrEqual(group.transform.width + 1);
        expect(child.transform.y + child.transform.height).toBeLessThanOrEqual(group.transform.height + 1);
        // Content stays inside the frame; only glows (transparent at their edges) may run past it.
        if (!/glow/i.test(child.name)) {
          expect(group.transform.x + child.transform.x, `${id}: ${child.name} left`).toBeGreaterThanOrEqual(0);
          expect(group.transform.y + child.transform.y, `${id}: ${child.name} top`).toBeGreaterThanOrEqual(0);
          expect(group.transform.x + child.transform.x + child.transform.width, `${id}: ${child.name} right`).toBeLessThanOrEqual(project.width);
          expect(group.transform.y + child.transform.y + child.transform.height, `${id}: ${child.name} bottom`).toBeLessThanOrEqual(project.height);
        }
      }
      expect(group.transform.x).toBeGreaterThanOrEqual(-project.width * 0.4);
      expect(group.transform.y).toBeGreaterThanOrEqual(-project.height * 0.4);
      // Children are animated with ordinary keys.
      expect(children.some((c) => c.tracks.length > 0 || c.propTracks?.length || c.props.reveal === 'typewriter')).toBe(true);
    }
  });

  it('uses stable, fresh ids and the project’s assets', () => {
    const { built } = insert(structuredClone(fixtureProject), 'logoOutro', 'scn_outro');
    expect(built.elements.map((e) => e.id)).toEqual(['el_t1', 'el_t2', 'el_t3', 'el_t4']);
    expect(built.elements[1]).toMatchObject({ type: 'logo', props: { assetId: 'ast_logo' } });
    const walk = insert(structuredClone(fixtureProject), 'walkthroughStep', 'scn_product').built;
    expect(walk.elements[1]).toMatchObject({ type: 'shape', name: 'Screenshot glow' });
    expect(walk.elements[2]).toMatchObject({ type: 'image', props: { assetId: 'ast_screenshot' } });
    // Without assets: a wordmark and a placeholder screen.
    const bare = exampleProject();
    expect(insert(bare, 'logoOutro', 'scn_open').built.elements[1]).toMatchObject({ type: 'text', props: { text: 'Example' } });
    expect(insert(bare, 'walkthroughStep', 'scn_open').built.elements[2]).toMatchObject({ type: 'shape', name: 'Screenshot placeholder' });
  });

  it('craft v2: screenshots fill the width on a glow, heroes keep moving through the hold', () => {
    const project = { ...structuredClone(fixtureProject), style: STYLE_PACKS['snappy-saas'] };
    const walk = insert(project, 'uiWalkthrough', 'scn_product').built;
    const screen = walk.elements.find((e) => e.name === 'Screen')!;
    expect(screen.transform.width / project.width).toBeGreaterThanOrEqual(0.6);
    expect(walk.elements.find((e) => e.name === 'Screen glow')!.props.fill).toMatchObject({ type: 'radial' });
    const step = insert(project, 'walkthroughStep', 'scn_product').built;
    expect(step.elements.find((e) => e.name === 'Screenshot')!.transform.width / project.width).toBeGreaterThanOrEqual(0.6);
    // Never dead: every template but the lower third (which exits) and the chat (which types) pushes or drifts to its last frame.
    for (const id of TEMPLATE_IDS) {
      if (id === 'lowerThird' || id === 'chatExchange' || id === 'logoOutro' || id === 'statCounter') continue;
      const { built } = insert(project, id, 'scn_product');
      const moving = built.group.tracks.filter((t) => t.property === 'scale' || t.property === 'x' || t.property === 'y');
      expect(moving.length, `${id} holds dead`).toBeGreaterThan(0);
      for (const t of moving) expect(t.keyframes.at(-1)!.frame).toBe(built.group.durationInFrames - 1);
    }
  });

  it('craft v2: the backdrop paints under the scene and drifts; the walkthrough bleeds, spotlights and chips; the sting takes a button', () => {
    const project = { ...structuredClone(fixtureProject), style: STYLE_PACKS['snappy-saas'] };
    const back = buildTemplate('backdrop', {}, { sceneId: 'scn_product', at: 0, project, newId: counter() });
    expect(back.ok && back.commands.map((c) => (c.type === 'addElement' ? c.index : -1))).toEqual(back.ok ? back.commands.map((_, i) => i) : []);
    if (!back.ok) throw new Error(back.message);
    const r = execute(createDocState(project), { type: 'batch', label: back.label, commands: back.commands });
    expect(r.ok && r.state.project.scenes[1].elements[0].id).toBe(back.group.id);
    expect(back.group.tracks.find((t) => t.property === 'y')!.keyframes.at(-1)!.value).toBeLessThan(0); // scrolls up
    for (const kind of ['grid', 'glow']) expect(buildTemplate('backdrop', { kind }, { sceneId: 'scn_product', at: 0, project, newId: counter() }).ok).toBe(true);

    const walk = buildTemplate('uiWalkthrough', { title: 'Every merge, one weekly brief.', bleed: 1, spotlight: 1, chips: '47 changes · 6 repos\n92% read rate', targetX: 0.86, targetY: 0.17 }, { sceneId: 'scn_product', at: 0, project, newId: counter() });
    if (!walk.ok) throw new Error(walk.message);
    const screen = walk.elements.find((e) => e.name === 'Screen')!;
    expect(walk.group.transform.y + screen.transform.y + screen.transform.height).toBeGreaterThan(project.height); // bleeds off the bottom
    expect(screen.transform.width / project.width).toBeGreaterThanOrEqual(0.75);
    expect(walk.elements.find((e) => e.name === 'Title')).toMatchObject({ props: { reveal: 'wordStagger' } });
    expect(walk.elements.find((e) => e.name === 'Logo')).toMatchObject({ props: { assetId: 'ast_logo' } });
    const dim = walk.elements.find((e) => e.name === 'Spotlight dim')!;
    expect(dim.mask).toMatchObject({ mode: 'inverted', sourceId: walk.elements.find((e) => e.name === 'Spotlight hole')!.id });
    const dimKeys = dim.tracks.find((t) => t.property === 'opacity')!.keyframes;
    expect(Math.max(...dimKeys.map((kf) => kf.value))).toBeCloseTo(0.4); // dims the rest to 60 %…
    expect(dimKeys.at(-1)!.value).toBe(0); // …then lifts so the product stays the picture
    const chips = walk.elements.filter((e) => /^Chip \d$/.test(e.name));
    expect(chips).toHaveLength(2);
    expect(chips[1].startFrame).toBeGreaterThan(chips[0].startFrame);
    const applied = execute(createDocState(project), { type: 'batch', label: walk.label, commands: walk.commands });
    expect(applied.ok && validateProject(applied.state.project).ok).toBe(true);

    const sting = buildTemplate('logoSting', { cta: 'Get early access', tagline: 'Release notes your team actually reads.' }, { sceneId: 'scn_outro', at: 0, project, newId: counter() });
    if (!sting.ok) throw new Error(sting.message);
    const label = sting.elements.find((e) => e.name === 'Button label')!;
    expect(Number(label.props.fontSize)).toBeGreaterThanOrEqual(30);
    expect(label.startFrame).toBe(sting.elements.find((e) => e.name === 'Button')!.startFrame); // arrives with its plate, never a blank button
    expect(sting.elements[1].name).toBe('Logo glow');
    expect(sting.elements[1].startFrame).toBe(sting.elements.find((e) => e.name === 'Logo')!.startFrame); // no empty glow

    const hook = buildTemplate('kineticTitle', { lines: '47 changes shipped.', sub: 'Nobody read them.', widthShare: 0.6 }, { sceneId: 'scn_intro', at: 0, project, newId: counter() });
    if (!hook.ok) throw new Error(hook.message);
    const punch = hook.elements.find((e) => e.name === 'Punchline')!;
    expect(punch.props).toMatchObject({ reveal: 'wordStagger', color: STYLE_PACKS['snappy-saas'].colors.accent });
    expect(punch.startFrame).toBeGreaterThan(hook.elements.find((e) => e.name === 'Line 1')!.startFrame);
  });

  it('fits the rest of the scene and refuses locked scenes', () => {
    const project = structuredClone(fixtureProject);
    const { built } = insert(project, 'chatExchange', 'scn_intro', 150); // 60 frames left of 210
    expect(built.group.durationInFrames).toBe(60);
    for (const child of built.elements.slice(1)) expect(child.startFrame).toBeLessThan(60);
    project.scenes[0].locked = true;
    expect(buildTemplate('titleCard', {}, { sceneId: 'scn_intro', at: 0, project })).toMatchObject({ ok: false, code: 'LOCKED' });
    expect(buildTemplate('titleCard', {}, { sceneId: 'scn_nope', at: 0, project })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
  });

  it('animates the stat ring with a property track', () => {
    const { built } = insert(structuredClone(fixtureProject), 'statCounter', 'scn_product');
    const ring = built.elements.find((e) => e.name === 'Ring')!;
    expect(ring.propTracks?.[0]).toMatchObject({ key: 'props.trimEnd', keyframes: [{ frame: 0, value: 0 }, { frame: 42, value: 0.87 }] });
  });

  it('takes fonts and colours from the project', () => {
    const style = projectStyle(fixtureProject);
    expect(style.font).toBe('Inter');
    expect(style.accent).toBe('#3B5BDB');
    expect(projectStyle(exampleProject()).accent).toBe('#7C83FF');
    const { built } = insert(structuredClone(fixtureProject), 'lowerThird', 'scn_product', 0, );
    expect(built.elements.find((e) => e.name === 'Accent')?.props.fill).toBe('#3B5BDB');
    expect(built.group.tracks[0]?.property).toBe('opacity'); // one exit for the whole lower third
  });

  it('honours parameters', () => {
    const built = buildTemplate('titleCard', { title: 'Hello there', subtitle: 'General Kenobi' }, { sceneId: 'scn_intro', at: 0, project: fixtureProject, newId: counter() });
    expect(built.ok && built.elements.map((e) => e.props.text)).toEqual([undefined, undefined, 'Hello there', 'General Kenobi']);
  });

  it.each(STYLE_PACK_IDS)('every template builds valid, styled motion with the %s pack', (packId) => {
    const pack = STYLE_PACKS[packId];
    for (const [w, h] of [[1920, 1080], [1080, 1920]]) {
      const project = { ...sized(w, h), style: pack };
      for (const id of TEMPLATE_IDS) {
        const { built, r } = insert(project, id, 'scn_product', 0);
        expect(r.ok, `${id}: ${r.ok ? '' : `${r.error.message} at ${r.error.path}`}`).toBe(true);
        const texts = built.elements.filter((e) => e.type === 'text');
        for (const t of texts) expect([pack.fonts.heading, pack.fonts.body, pack.fonts.mono, 'Fraunces']).toContain(t.props.fontFamily);
        // Masks point at a sibling shape of the same template.
        for (const e of built.elements) if (e.mask) expect(built.elements.find((s) => s.id === e.mask!.sourceId)).toMatchObject({ type: 'shape', parentId: built.group.id });
      }
    }
    expect(projectStyle({ ...structuredClone(fixtureProject), style: pack })).toMatchObject({ accent: pack.colors.accent, surface: pack.colors.surface, motion: pack.motion });
  });

  it('times parts by the pack: premium arrives later and longer than snappy', () => {
    const start = (packId: 'snappy-saas' | 'calm-premium') => {
      const { built } = insert({ ...structuredClone(fixtureProject), style: STYLE_PACKS[packId] }, 'featureGrid', 'scn_product', 0);
      return built.elements.find((e) => e.name === 'Card 2')!;
    };
    const snappy = start('snappy-saas');
    const premium = start('calm-premium');
    expect(premium.startFrame).toBeGreaterThan(snappy.startFrame);
    const len = (e: typeof snappy) => e.tracks.find((t) => t.property === 'y')!.keyframes.at(-1)!.frame;
    expect(len(premium)).toBeGreaterThan(len(snappy));
    expect(premium.tracks.find((t) => t.property === 'y')!.keyframes[0].easing).toEqual(STYLE_PACKS['calm-premium'].motion.enter);
  });

  it('walks a cursor to the target and clicks', () => {
    const { built } = insert(structuredClone(fixtureProject), 'uiWalkthrough', 'scn_product', 0);
    const cursor = built.elements.find((e) => e.name === 'Cursor')!;
    const x = cursor.tracks.find((t) => t.property === 'x')!.keyframes;
    expect(x[0].value).toBeGreaterThan(0);
    expect(x.at(-1)!.value).toBe(0);
    expect(Math.min(...cursor.tracks.find((t) => t.property === 'scale')!.keyframes.map((k) => k.value))).toBeLessThan(1);
    expect(built.group.tracks.find((t) => t.property === 'scale')?.keyframes.at(-1)?.value).toBeCloseTo(1.05, 5); // push in
  });

  it.each(TEMPLATE_IDS)('%s declares exactly the params its design reads (the agent tool lists them)', (id) => {
    const declared = { ...TEMPLATES[id].params, ...COMMON_TEMPLATE_PARAMS };
    const sample = (name: string) => {
      const spec = declared[name];
      if (spec.type === 'number') return 1;
      if (spec.type === 'asset') return spec.kinds?.includes('svg') ? 'ast_logo' : 'ast_screenshot';
      return spec.values?.[0] ?? `Sample ${name}`;
    };
    const everything = Object.fromEntries(Object.keys(declared).map((name) => [name, sample(name)]));
    const read = new Set<string>();
    const watched = (params: TemplateParams) => new Proxy(params, { get: (t, k) => { if (typeof k === 'string') read.add(k); return Reflect.get(t, k); } });
    const bare = { ...structuredClone(fixtureProject), assets: {} };
    for (const [project, params] of [[fixtureProject, {}], [fixtureProject, everything], [bare, {}]] as const) {
      const built = buildTemplate(id, watched({ ...params }), { sceneId: 'scn_product', at: 0, project: structuredClone(project), newId: counter() });
      expect(built.ok).toBe(true);
    }
    expect([...read].filter((name) => !(name in declared)), 'read but not declared').toEqual([]);
    expect(Object.keys(declared).filter((name) => !read.has(name)), 'declared but never read').toEqual([]);
  });
});

/** Frame-space box of a built child (its group's offset added; motion ignored). */
const frameBox = (group: Element, child: Element) => ({ x: group.transform.x + child.transform.x, y: group.transform.y + child.transform.y, width: child.transform.width, height: child.transform.height });
const overlap = (a: ReturnType<typeof frameBox>, b: ReturnType<typeof frameBox>) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe('templates: composition details', () => {
  const aspects: [number, number][] = [[1920, 1080], [1080, 1920], [3840, 2160]];
  const packs = [...STYLE_PACK_IDS, undefined];

  it('logoSting reads as a composed end card from its first frames: the logo is up by frame 6, the ring only an accent', () => {
    for (const packId of packs) {
      for (const [w, h] of aspects) {
        for (const params of [{ cta: 'Get early access' }, { wordmark: 'relay' }, {}] as TemplateParams[]) {
          const project = { ...sized(w, h), ...(packId ? { style: STYLE_PACKS[packId] } : {}) };
          const built = buildTemplate('logoSting', params, { sceneId: 'scn_outro', at: 12, project, newId: counter() });
          if (!built.ok) throw new Error(built.message);
          const logo = built.elements.find((e) => e.name === 'Logo' || e.name === 'Wordmark')!;
          const ring = built.elements.find((e) => e.name === 'Ring')!;
          const glow = built.elements.find((e) => e.name === 'Logo glow')!;
          const label = `${packId ?? 'no pack'} ${w}x${h} ${JSON.stringify(params)}`;
          expect(logo.startFrame, label).toBeLessThanOrEqual(ring.startFrame);
          expect(glow.startFrame, label).toBe(logo.startFrame);
          const at = (frame: number) => evaluateElementWorld(built.elements, logo, 12 + frame).opacity;
          expect(at(2), label).toBeGreaterThan(0);
          expect(at(6), label).toBeGreaterThanOrEqual(0.9);
          // The logo still hits when the ring closes: a scale beat after it has settled.
          expect(Math.max(...logo.tracks.find((t) => t.property === 'scale')!.keyframes.map((k) => k.value))).toBeGreaterThan(1.04);
        }
      }
    }
  });

  it('pills arrive with their text: the label starts within 2 f of its plate and is never fainter than it', () => {
    const plates: [RegExp, (name: string) => string][] = [
      [/^Callout$/, () => 'Callout text'],
      [/^Chip( \d)?$/, (n) => `${n} text`],
      [/^Button$/, () => 'Button label'],
      [/^Avatar$/, () => 'Initials'],
      [/^Card \d tile$/, (n) => n.replace('tile', 'number')],
    ];
    const builds: [TemplateId, TemplateParams][] = [
      ['uiWalkthrough', { chips: '47 changes · 6 repos\n92% read rate\nOne page' }],
      ['statReveal', {}],
      ['logoSting', { cta: 'Get early access' }],
      ['testimonial', {}],
      ['featureGrid', {}],
    ];
    for (const packId of packs) {
      const project = { ...sized(1920, 1080), ...(packId ? { style: STYLE_PACKS[packId] } : {}) };
      let checked = 0;
      for (const [id, params] of builds) {
        const built = buildTemplate(id, params, { sceneId: 'scn_product', at: 0, project, newId: counter() });
        if (!built.ok) throw new Error(built.message);
        for (const plate of built.elements) {
          const textName = plates.find(([re]) => re.test(plate.name))?.[1](plate.name);
          if (!textName) continue;
          const text = built.elements.find((e) => e.name === textName)!;
          expect(text, `${id}: ${textName}`).toBeDefined();
          expect(text.startFrame - plate.startFrame, `${id}: ${textName} starts after ${plate.name}`).toBeLessThanOrEqual(2);
          for (let f = plate.startFrame; f < plate.startFrame + 30; f++) {
            const shown = (e: Element) => evaluateElementWorld(built.elements, e, f).opacity * (evaluateElementWorld(built.elements, e, f).active ? 1 : 0);
            expect(shown(text), `${id} f${f}: ${plate.name} shows before ${textName}`).toBeGreaterThanOrEqual(shown(plate) - 0.02);
          }
          checked++;
        }
      }
      expect(checked).toBeGreaterThanOrEqual(10);
    }
  });

  it('uiWalkthrough callouts and chips never cover the target, wherever it is', () => {
    const chips = '47 changes · 6 repos\n92% read rate\nOne page, every Monday';
    for (const [w, h] of [[1920, 1080], [1080, 1080], [3840, 2160]]) {
      const project = { ...sized(w, h), style: STYLE_PACKS['snappy-saas'] };
      const sides = ['below', 'above', 'left', 'right'].map((calloutSide) => ({ calloutSide }));
      for (const extra of [{}, { bleed: 1, title: 'Every merge, one weekly brief.' }, { spotlight: 1 }, ...sides] as TemplateParams[]) {
        for (const targetX of [0.05, 0.3, 0.5, 0.75, 0.95]) {
          for (const targetY of [0.05, 0.3, 0.5, 0.75, 0.95]) {
            for (const [targetW, targetH] of [[0.2, 0.1], [0.1, 0.3]]) {
              const params = { ...extra, chips, targetX, targetY, targetW, targetH, label: 'Send the brief to the team' };
              const built = buildTemplate('uiWalkthrough', params, { sceneId: 'scn_product', at: 0, project, newId: counter() });
              if (!built.ok) throw new Error(built.message);
              const box = (name: string) => frameBox(built.group, built.elements.find((e) => e.name === name)!);
              const label = `${w}x${h} ${JSON.stringify(extra)} target ${targetX},${targetY} ${targetW}x${targetH}`;
              const target = box('Highlight');
              const callout = box('Callout');
              expect(overlap(callout, target), `${label}: callout over the target`).toBe(false);
              expect(callout.x, label).toBeGreaterThanOrEqual(0);
              expect(callout.y, label).toBeGreaterThanOrEqual(0);
              expect(callout.x + callout.width, label).toBeLessThanOrEqual(w);
              expect(callout.y + callout.height, label).toBeLessThanOrEqual(h);
              const placed = [target, callout];
              for (const name of ['Chip 1', 'Chip 2', 'Chip 3']) {
                const chip = box(name);
                for (const other of placed) expect(overlap(chip, other), `${label}: ${name} covers something`).toBe(false);
                placed.push(chip);
              }
            }
          }
        }
      }
      // A named side is taken when it fits: the agent can see what the callout would cover; the template cannot.
      for (const { calloutSide } of sides) {
        const built = buildTemplate('uiWalkthrough', { calloutSide, targetX: 0.5, targetY: 0.5 }, { sceneId: 'scn_product', at: 0, project, newId: counter() });
        if (!built.ok) throw new Error(built.message);
        const target = frameBox(built.group, built.elements.find((e) => e.name === 'Highlight')!);
        const callout = frameBox(built.group, built.elements.find((e) => e.name === 'Callout')!);
        const side = callout.y >= target.y + target.height ? 'below' : callout.y + callout.height <= target.y ? 'above' : callout.x >= target.x + target.width ? 'right' : 'left';
        expect(side, `${w}x${h}`).toBe(calloutSide);
      }
    }
  });

  it('every kicker and eyebrow (tracked caps) is at least TYPE_MIN.trackedCaps, scaled, and reads at 4.5:1 on what it sits on', () => {
    for (const packId of packs) {
      for (const [w, h] of aspects) {
        const project = { ...sized(w, h), ...(packId ? { style: STYLE_PACKS[packId] } : {}) };
        const style = projectStyle(project);
        const u = Math.min(w, h) / 1080;
        let eyebrows = 0;
        for (const id of TEMPLATE_IDS) {
          const built = buildTemplate(id, {}, { sceneId: 'scn_product', at: 0, project, newId: counter() });
          if (!built.ok) throw new Error(built.message);
          const masks = new Set(built.elements.flatMap((e) => (e.mask ? [e.mask.sourceId] : [])));
          built.elements.forEach((el, i) => {
            const text = String(el.props.text ?? '');
            if (el.type !== 'text' || !(Number(el.props.letterSpacing) > 0) || !/\p{Lu}/u.test(text) || text !== text.toUpperCase()) return;
            eyebrows++;
            const label = `${packId ?? 'no pack'} ${w}x${h} ${id}: ${el.name}`;
            expect(Number(el.props.fontSize), label).toBeGreaterThanOrEqual(TYPE_MIN.trackedCaps * u);
            // What it sits on: the nearest painted plate under it that holds its box, over the scene background.
            const own = frameBox(built.group, el);
            const plate = built.elements.slice(1, i).reverse().find((s) => {
              const b = frameBox(built.group, s);
              return s.type === 'shape' && !masks.has(s.id) && typeof s.props.fill === 'string' && b.x <= own.x && b.y <= own.y && b.x + b.width >= own.x + own.width && b.y + b.height >= own.y + own.height;
            });
            const layers = plate ? [String(plate.props.fill), style.background] : [style.background];
            expect(contrastRatio(String(el.props.color), ...layers), label).toBeGreaterThanOrEqual(TYPE_MIN.contrast);
          });
        }
        expect(eyebrows).toBeGreaterThanOrEqual(7);
      }
    }
  });
});
