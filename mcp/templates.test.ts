// editor_build_template / editor_build_motion: the editor's own templates and
// presets as ready patches. What the tools return must validate through the
// patch path and commit exactly what the Insert menu / inspector would.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureProject } from '../src/core/__fixtures__/fixtureProject';
import { createDocState } from '../src/core/history';
import { checkPatch } from '../src/core/patch';
import { PRESET_IDS } from '../src/core/presets';
import { STYLE_PACKS } from '../src/core/style';
import { TEMPLATE_IDS, TEMPLATES } from '../src/core/templates';
import { CUT_CARDS } from '../src/core/cutCatalog';
import { sceneStartFrame } from '../src/core/timing';
import { PATCH_PROTOCOL, type Project } from '../src/core/types';
import { validateProject } from '../src/core/validate';
import { applyPreset, arriveApart, followThrough, insertTemplate } from '../src/editor/presetActions';
import { useEditor } from '../src/editor/store';
import { contextFor } from '../server/testing/fakeEditor';
import { motionToolDescription, templateToolDescription } from './build';
import { LocalEditor } from './local';
import { createHandlers, type ToolResult } from './tools';

const textOf = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
const project = () => useEditor.getState().doc.project;

/** Handlers over a live editor showing `p` (only local.state is read). */
function handlersFor(p: Project) {
  const local = new LocalEditor({ rootDir: '/tmp', serverPort: 1, webPort: 1, openBrowser: false });
  const command = vi.spyOn(local, 'command');
  const request = vi.spyOn(local, 'request');
  vi.spyOn(local, 'state').mockResolvedValue({ connected: true, project: structuredClone(p), context: contextFor(createDocState(p)), updatedAt: null });
  return { h: createHandlers(local), command, request };
}

/** The ready patch the tool printed (its last line), applied with the editor's patch checks. */
function applyToolPatch(base: Project, result: ToolResult) {
  expect(result.isError, textOf(result)).toBeUndefined();
  const args = JSON.parse(textOf(result).trim().split('\n').at(-1)!);
  expect(args).toMatchObject({ baseRevision: base.revision, docSession: 's-1' });
  // docSession is an editor_propose_patch argument, not part of the patch document.
  const { docSession: _session, ...patch } = args;
  const r = checkPatch(createDocState(base), { protocol: PATCH_PROTOCOL, projectId: base.id, ...patch }, { reconcile: true });
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} at ${r.error.path}`);
  expect(validateProject(r.project).ok).toBe(true);
  return { args, project: r.project };
}

/** Scenes with the ids the edit created replaced by their order of appearance, so two builds compare equal. */
function normalised(base: Project, after: Project): unknown {
  const known = new Set(base.scenes.flatMap((s) => s.elements.map((e) => e.id)));
  let json = JSON.stringify(after.scenes);
  after.scenes.flatMap((s) => s.elements).filter((e) => !known.has(e.id)).forEach((e, i) => { json = json.split(`"${e.id}"`).join(`"new_${i}"`); });
  return JSON.parse(json);
}

function freshStore(style: keyof typeof STYLE_PACKS = 'snappy-saas') {
  useEditor.getState().loadDocument(createDocState(structuredClone(fixtureProject)), { kind: 'server', id: fixtureProject.id });
  useEditor.getState().run({ type: 'setStyle', style: STYLE_PACKS[style] });
  useEditor.setState({ toasts: [] });
  return project();
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('editor_build_template', () => {
  it.each(TEMPLATE_IDS)('%s: the returned patch validates and commits what Insert commits (style pack, assets, size, fps)', async (id) => {
    const base = freshStore();
    const at = 30;
    const scene = base.scenes[1];
    const { h, command, request } = handlersFor(base);
    const result = await h.editor_build_template({ template: id, sceneId: scene.id, at });
    const { args, project: viaTool } = applyToolPatch(base, result);
    expect(args.targets).toEqual([{ sceneId: scene.id }]);
    expect(command).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    // The tool holds to the cut; Insert with the same length must commit the same elements.
    useEditor.getState().seek(sceneStartFrame(base, scene.id) + at);
    expect(insertTemplate(id, { seconds: (scene.durationInFrames - at) / base.fps })).toBe(true);
    expect(normalised(base, viaTool)).toEqual(normalised(base, project()));
    const group = viaTool.scenes[1].elements.find((e) => e.type === 'group' && e.name === TEMPLATES[id].label && !base.scenes[1].elements.some((b) => b.id === e.id))!;
    expect(group).toMatchObject({ startFrame: at, durationInFrames: scene.durationInFrames - at });
    for (const line of textOf(result).split('\n').filter((l) => l.startsWith('- '))) expect(line).toMatch(/^- el_\w+ \w+ "[^"]+".*: scene frames \d+/);
  });

  it('passes params through and keeps an explicit length, like Insert', async () => {
    const base = freshStore('calm-premium');
    const { h } = handlersFor(base);
    const params = { lines: 'Less noise.\nMore signal.', kicker: 'RELAY', widthShare: 0.58, seconds: 3 };
    const { project: viaTool } = applyToolPatch(base, await h.editor_build_template({ template: 'kineticTitle', sceneId: 'scn_intro', at: 12, params }));
    useEditor.getState().seek(12);
    expect(insertTemplate('kineticTitle', params)).toBe(true);
    expect(normalised(base, viaTool)).toEqual(normalised(base, project()));
    const added = viaTool.scenes[0].elements.filter((e) => !base.scenes[0].elements.some((b) => b.id === e.id));
    expect(added[0]).toMatchObject({ type: 'group', startFrame: 12, durationInFrames: 90 });
    expect(added.find((e) => e.name === 'Kicker')?.props).toMatchObject({ text: 'RELAY', fontFamily: STYLE_PACKS['calm-premium'].fonts.mono });
  });

  it('puts a backdrop under the scene and builds inside a group', async () => {
    const base = freshStore();
    const { h } = handlersFor(base);
    const { project: backed } = applyToolPatch(base, await h.editor_build_template({ template: 'backdrop', sceneId: 'scn_product', params: { kind: 'grid' } }));
    expect(backed.scenes[1].elements[0]).toMatchObject({ type: 'group', name: 'Backdrop texture', startFrame: 0, durationInFrames: 270 });
    expect(backed.scenes[1].elements.slice(-5).map((e) => e.id)).toEqual(base.scenes[1].elements.map((e) => e.id).slice(-5));

    const grouped = createDocState(base);
    const host = checkPatch(grouped, { protocol: PATCH_PROTOCOL, projectId: base.id, baseRevision: base.revision, summary: 'group', targets: [{ sceneId: 'scn_product' }], commands: [{ type: 'groupElements', sceneId: 'scn_product', elementIds: ['el_product_card', 'el_product_chat_user'], group: { id: 'el_host', name: 'Host' } }] });
    if (!host.ok) throw new Error(host.error.message);
    const hostEl = host.project.scenes[1].elements.find((e) => e.id === 'el_host')!;
    const { h: h2 } = handlersFor(host.project);
    const flat = applyToolPatch(host.project, await h2.editor_build_template({ template: 'statReveal', sceneId: 'scn_product', at: 60 })).project;
    const nested = applyToolPatch(host.project, await h2.editor_build_template({ template: 'statReveal', sceneId: 'scn_product', at: 60, parentId: 'el_host' })).project;
    const added = (p: Project) => p.scenes[1].elements.filter((e) => !host.project.scenes[1].elements.some((b) => b.id === e.id));
    const [flatGroup] = added(flat);
    const [nestedGroup] = added(nested);
    expect(nestedGroup).toMatchObject({ parentId: 'el_host', startFrame: 60 - hostEl.startFrame, transform: { x: flatGroup.transform.x - hostEl.transform.x, y: flatGroup.transform.y - hostEl.transform.y } });
    expect(nestedGroup.durationInFrames).toBe(Math.min(hostEl.startFrame + hostEl.durationInFrames, 270) - 60);
    const outside = await h2.editor_build_template({ template: 'statReveal', sceneId: 'scn_product', at: 5, parentId: 'el_host' });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toContain(`plays from scene frame ${hostEl.startFrame}`);
  });

  it('refuses locked scenes and bad params plainly, without touching the editor', async () => {
    const base = freshStore();
    base.scenes[2].locked = true;
    const { h, command } = handlersFor(base);
    const cases: [Parameters<typeof h.editor_build_template>[0], string][] = [
      [{ template: 'logoSting', sceneId: 'scn_outro' }, 'Scene "Outro" (scn_outro) is approved (locked)'],
      [{ template: 'logoSting', sceneId: 'scn_nope' }, 'Scene scn_nope is not in the project'],
      [{ template: 'statReveal', sceneId: 'scn_intro', params: { value: 92 } }, 'statReveal param "value" must be a string'],
      [{ template: 'statReveal', sceneId: 'scn_intro', params: { colour: 'red' } }, 'statReveal has no param "colour". Its params: value, kicker, label, chip, seconds.'],
      [{ template: 'backdrop', sceneId: 'scn_intro', params: { kind: 'stars' } }, 'must be one of lines, grid, glow'],
      [{ template: 'uiWalkthrough', sceneId: 'scn_intro', params: { imageAssetId: 'ast_missing' } }, 'asset ast_missing is not in the project'],
      [{ template: 'uiWalkthrough', sceneId: 'scn_intro', params: { imageAssetId: 'ast_music' } }, 'needs an asset of kind image or svg; ast_music is audio'],
      [{ template: 'titleCard', sceneId: 'scn_intro', at: 210 }, 'at must be a scene frame from 0 to 209'],
      [{ template: 'titleCard', sceneId: 'scn_intro', parentId: 'el_intro_logo' }, 'el_intro_logo is not a group'],
    ];
    for (const [args, message] of cases) {
      const r = await h.editor_build_template(args);
      expect(r.isError, message).toBe(true);
      expect(textOf(r)).toContain(message);
    }
    expect(command).not.toHaveBeenCalled();
  });

  it('lists every template and its params in the tool description', () => {
    const d = templateToolDescription();
    for (const id of TEMPLATE_IDS) {
      expect(d).toContain(`- ${id} (`);
      for (const name of Object.keys(TEMPLATES[id].params)) expect(d, `${id}.${name}`).toMatch(new RegExp(`- ${id} .*\\b${name} \\(`));
    }
  });
});

describe('editor_build_motion', () => {
  it('a preset matches the inspector (style timing and easing)', async () => {
    const base = freshStore('calm-premium');
    const { h } = handlersFor(base);
    const { args, project: viaTool } = applyToolPatch(base, await h.editor_build_motion({ preset: 'riseIn', sceneId: 'scn_product', elementIds: ['el_product_card'] }));
    expect(args.summary).toBe('Rise in on “Weekly brief card”');
    expect(applyPreset('scn_product', 'el_product_card', 'riseIn')).toBe(true);
    expect(viaTool.scenes).toEqual(project().scenes);
  });

  it('arrive apart, follow-through and a match cut validate; the first two match the Insert menu', async () => {
    const base = freshStore();
    const ids = ['el_product_card', 'el_product_chat_user', 'el_product_chat_ai'];
    const { h } = handlersFor(base);
    const apart = applyToolPatch(base, await h.editor_build_motion({ preset: 'arriveApart', sceneId: 'scn_product', elementIds: ids }));
    useEditor.getState().selectMany('scn_product', ids);
    expect(arriveApart()).toBe(true);
    expect(apart.project.scenes).toEqual(project().scenes);

    freshStore();
    useEditor.getState().run({ type: 'groupElements', sceneId: 'scn_product', elementIds: ids.slice(0, 2), group: { id: 'el_ft', name: 'Cards' } });
    const withGroup = project();
    const follow = applyToolPatch(withGroup, await handlersFor(withGroup).h.editor_build_motion({ preset: 'followThrough', sceneId: 'scn_product', elementIds: ['el_ft'], opts: { intensity: 1.5 } }));
    expect(followThrough('scn_product', 'el_ft', 1.5)).toBe(true);
    expect(follow.project.scenes).toEqual(project().scenes);

    const cut = applyToolPatch(base, await h.editor_build_motion({ preset: 'matchCut', sceneId: 'scn_intro', elementIds: ['el_intro_logo'], intoSceneId: 'scn_product', intoElementId: 'el_product_headline' }));
    expect(cut.args.targets).toEqual([{ sceneId: 'scn_intro' }, { sceneId: 'scn_product' }]);
    expect(cut.project.scenes[1].transitionIn).toEqual({ type: 'none', durationInFrames: 0 });
    expect(cut.project.scenes[0].elements.find((e) => e.id === 'el_intro_logo')!.tracks.find((t) => t.property === 'scale')!.keyframes.at(-1)!.frame).toBe(209);
  });

  it('refuses locked scenes and presets that do not fit, plainly', async () => {
    const base = freshStore();
    base.scenes[0].locked = true;
    const { h } = handlersFor(base);
    const cases: [Parameters<typeof h.editor_build_motion>[0], string][] = [
      [{ preset: 'popIn', sceneId: 'scn_intro', elementIds: ['el_intro_logo'] }, 'is approved (locked)'],
      [{ preset: 'wipeOn', sceneId: 'scn_product', elementIds: ['el_product_headline'] }, 'Wipe on does not apply to "Headline" (text); it works on path elements.'],
      [{ preset: 'popIn', sceneId: 'scn_product', elementIds: ['el_intro_logo'] }, 'Element el_intro_logo is not in scene "Product"'],
      [{ preset: 'arriveApart', sceneId: 'scn_product', elementIds: ['el_product_card'] }, 'Arrive apart needs two or more layers'],
      [{ preset: 'followThrough', sceneId: 'scn_product', elementIds: ['el_product_card'] }, 'Follow-through takes one group with layers'],
      [{ preset: 'matchCut', sceneId: 'scn_product', elementIds: ['el_product_card'], intoSceneId: 'scn_intro', intoElementId: 'el_intro_logo' }, 'is approved (locked)'],
    ];
    for (const [args, message] of cases) {
      const r = await h.editor_build_motion(args);
      expect(r.isError, message).toBe(true);
      expect(textOf(r)).toContain(message);
    }
  });

  it('lists every preset and the multi-element moves in the tool description', () => {
    const d = motionToolDescription();
    for (const id of PRESET_IDS) expect(d).toContain(`- ${id} (`);
    for (const term of ['- arriveApart:', '- followThrough:', '- matchCut:', '- riseIn (enter', '- wipeOn (enter', 'path only', 'style.motion']) expect(d).toContain(term);
  });
});

describe('editor_list_cut_cards / editor_build_cut', () => {
  it('lists every card, or one beat of them', async () => {
    const { h } = handlersFor(freshStore());
    const all = textOf(await h.editor_list_cut_cards({}));
    for (const card of CUT_CARDS) expect(all).toContain(card.id);
    const hooks = textOf(await h.editor_list_cut_cards({ beat: 'hook' }));
    expect(hooks).toContain('hook.mask-rise-claim');
    expect(hooks).not.toContain('cta.logo-sting');
  });

  it('builds a card with the given copy into an empty scene and retimes it', async () => {
    const full = freshStore();
    const base = { ...full, scenes: full.scenes.map((s, i) => (i === 0 ? { ...s, elements: [] } : s)) };
    const { h, command } = handlersFor(base);
    const scene = base.scenes[0];
    const result = await h.editor_build_cut({ card: 'hook.big-number', sceneId: scene.id, slots: { stat: '9 h', label: 'lost to meetings' } });
    const { project: after } = applyToolPatch(base, result);
    const built = after.scenes.find((s) => s.id === scene.id)!;
    expect(built.durationInFrames).toBe(Math.round(3.5 * base.fps));
    const texts = built.elements.map((e) => e.props.text);
    expect(texts).toEqual(expect.arrayContaining(['9 h', 'lost to meetings']));
    expect(command).not.toHaveBeenCalled();
  });

  it('keeps a scene that holds longer elements at its length, and says so', async () => {
    const base = freshStore();
    const { h } = handlersFor(base);
    const scene = base.scenes[0];
    const result = await h.editor_build_cut({ card: 'hook.big-number', sceneId: scene.id });
    expect(textOf(result)).toContain('Scene kept at');
    const { project: after } = applyToolPatch(base, result);
    expect(after.scenes[0].durationInFrames).toBe(scene.durationInFrames);
  });

  it('keeps the scene length with fitScene false, and refuses unknown cards and slots', async () => {
    const base = freshStore();
    const { h } = handlersFor(base);
    const scene = base.scenes[0];
    const { project: after } = applyToolPatch(base, await h.editor_build_cut({ card: 'cta.logo-sting', sceneId: scene.id, fitScene: false }));
    expect(after.scenes.find((s) => s.id === scene.id)!.durationInFrames).toBe(scene.durationInFrames);
    const unknown = await h.editor_build_cut({ card: 'hook.nope', sceneId: scene.id });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('Unknown cut card');
    const slot = await h.editor_build_cut({ card: 'cta.logo-sting', sceneId: scene.id, slots: { headline: 'x' } });
    expect(textOf(slot)).toContain('has no slot "headline"');
  });
});
