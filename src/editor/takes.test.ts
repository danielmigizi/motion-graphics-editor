import { describe, expect, it } from 'vitest';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import { createDocState } from '../core/history';
import { applyPatch } from '../core/patch';
import type { AiPatch, Asset, AssetProvenance, Project } from '../core/types';
import { createElement } from './doc';
import { generationItem, withGenerations } from './activity';
import { groupTakes, moreLikeThisPrompt, planUseTake, takeAlreadyPlaced, takeLength, takeUsage } from './takes';

describe('a video take’s length', () => {
  it('leads its status line in seconds, from project frames; pictures and sound say nothing', () => {
    const clip: Asset = { id: 'v', kind: 'video', name: 'Pour', src: 'assets/generated/v.mp4', mimeType: 'video/mp4', durationInFrames: 240, fps: 24 };
    expect(takeLength(clip, 30)).toBe('8.0 s · ');
    expect(takeLength({ ...clip, durationInFrames: undefined }, 30)).toBe('');
    expect(takeLength({ ...clip, kind: 'image' }, 30)).toBe('');
  });
});

const gen = (requestId: string, createdAt: number, extra: Partial<AssetProvenance> = {}): AssetProvenance => ({
  source: 'generated', provider: 'fal', requestId, createdAt, model: 'gpt-image-2', prompt: 'Soft studio background, iris to ember dusk gradient', cost: '1 image credit', providerRefs: { requestId: `fal_${createdAt}` }, ...extra,
});

/** The fixture with two takes of one background request (take 1 in use) and two voice-over takes (take 1 in a clip). */
function project(): Project {
  const p = structuredClone(fixtureProject) as Project;
  p.assets.ast_screenshot.provenance = gen('req_bg', 100);
  const a: Asset[] = [
    { id: 'ast_bg2', kind: 'image', name: 'bg take 2.png', src: 'assets/uploads/u_2.png', mimeType: 'image/png', width: 1920, height: 1080, provenance: gen('req_bg', 200) },
    { id: 'ast_hero1', kind: 'image', name: 'hero 1.png', src: 'assets/uploads/u_h1.png', mimeType: 'image/png', width: 1000, height: 1000, provenance: gen('req_hero', 300, { prompt: 'Glass bottle on wet slate' }) },
    { id: 'ast_hero2', kind: 'image', name: 'hero 2.png', src: 'assets/uploads/u_h2.png', mimeType: 'image/png', width: 1000, height: 1000, provenance: gen('req_hero', 310) },
    { id: 'ast_vo2', kind: 'audio', name: 'vo take 2.mp3', src: 'assets/uploads/u_v2.mp3', mimeType: 'audio/mpeg', durationInFrames: 15, provenance: gen('req_vo', 50, { model: 'voice-x' }) },
    { id: 'ast_style', kind: 'image', name: 'style frame.png', src: 'assets/uploads/u_s.png', mimeType: 'image/png', reference: true },
  ];
  for (const x of a) p.assets[x.id] = x;
  p.assets.ast_whoosh.provenance = gen('req_vo', 40, { model: 'voice-x' });
  return p;
}

/** The project after the patch (which must apply). */
function applied(p: Project, patch: AiPatch): Project {
  const r = applyPatch(createDocState(p), patch);
  if (!r.ok) throw new Error(`${r.error.message} (${r.error.path ?? ''})`);
  return r.state.project;
}

describe('grouping takes', () => {
  it('groups generated assets by request, newest request first, takes oldest first', () => {
    const groups = groupTakes(project());
    expect(groups.map((g) => g.key)).toEqual(['req_hero', 'req_bg', 'req_vo']);
    expect(groups[1].takes.map((t) => t.id)).toEqual(['ast_screenshot', 'ast_bg2']);
    expect(groups[0]).toMatchObject({ provider: 'fal', prompt: 'Glass bottle on wet slate', model: 'gpt-image-2', cost: '1 image credit' });
    // Uploads and references are not takes.
    expect(groups.flatMap((g) => g.takes.map((t) => t.id))).not.toContain('ast_style');
    expect(groups.flatMap((g) => g.takes.map((t) => t.id))).not.toContain('ast_logo');
    expect(takeUsage(project()).get('ast_screenshot')).toBe(1);
  });
});

describe('Use this take', () => {
  it('swaps every element showing another take of the request, as a reviewable patch', () => {
    const p = project();
    const bg = groupTakes(p).find((g) => g.key === 'req_bg')!;
    const plan = planUseTake(p, bg, 'ast_bg2', 'scn_intro');
    expect(plan.kind).toBe('patch');
    if (plan.kind !== 'patch') return;
    expect(plan.patch.targets).toEqual([{ sceneId: 'scn_product', elementId: 'el_product_image' }]);
    const r = applyPatch(createDocState(p), plan.patch);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.state.project.scenes[1].elements.find((e) => e.id === 'el_product_image')!.props.assetId).toBe('ast_bg2');
  });

  it('does nothing for a take that is already the one in the video (no duplicate layer)', () => {
    const p = project();
    const bg = groupTakes(p).find((g) => g.key === 'req_bg')!;
    // ast_screenshot (take 1) is placed, take 2 is not: using take 1 again is a no-op.
    expect(takeAlreadyPlaced(bg, 'ast_screenshot', takeUsage(p))).toBe(true);
    expect(planUseTake(p, bg, 'ast_screenshot', 'scn_intro')).toEqual({ kind: 'none', message: `Already in the video: “${p.assets.ast_screenshot.name}” is the take of this request the video uses.` });
    expect(takeAlreadyPlaced(bg, 'ast_bg2', takeUsage(p))).toBe(false);
    // Once both takes are in use, each one can still take over the other's places.
    const both = structuredClone(p);
    const extra = createElement(both, both.scenes[0], 'image');
    extra.props = { ...extra.props, assetId: 'ast_screenshot' };
    both.scenes[0].elements.unshift(extra);
    both.scenes[1].elements.find((e) => e.id === 'el_product_image')!.props.assetId = 'ast_bg2';
    const bgBoth = groupTakes(both).find((g) => g.key === 'req_bg')!;
    expect(takeAlreadyPlaced(bgBoth, 'ast_screenshot', takeUsage(both))).toBe(false);
    expect(planUseTake(both, bgBoth, 'ast_screenshot', 'scn_intro')).toMatchObject({ kind: 'patch', patch: { targets: [{ sceneId: 'scn_product', elementId: 'el_product_image' }] } });
    // Audio: the voice-over take a clip already plays.
    const vo = groupTakes(p).find((g) => g.key === 'req_vo')!;
    expect(planUseTake(p, vo, 'ast_whoosh', 'scn_intro')).toMatchObject({ kind: 'none', message: expect.stringContaining('Already in the video') });
  });

  it('inserts the take into the current scene when nothing uses the request yet', () => {
    const p = project();
    const hero = groupTakes(p).find((g) => g.key === 'req_hero')!;
    const plan = planUseTake(p, hero, 'ast_hero2', 'scn_intro');
    expect(plan).toMatchObject({ kind: 'patch', summary: 'Place take “hero 2.png” in “Intro”' });
    if (plan.kind !== 'patch') return;
    const r = applyPatch(createDocState(p), plan.patch);
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
    if (!r.ok) return;
    const added = r.state.project.scenes[0].elements[0];
    expect(added).toMatchObject({ type: 'image', name: 'hero 2', props: { assetId: 'ast_hero2' } });
    // Square take, letterboxed into the 16:9 frame.
    expect(added.transform).toMatchObject({ width: p.height, height: p.height, y: 0 });
  });

  it('switches audio clips, or adds a clip, as a reviewable patch with audio targets', () => {
    const p = project();
    const vo = groupTakes(p).find((g) => g.key === 'req_vo')!;
    const plan = planUseTake(p, vo, 'ast_vo2', 'scn_intro');
    expect(plan.kind).toBe('patch');
    if (plan.kind !== 'patch') return;
    // The clip is anchored to its scene: the scene target covers it.
    expect(plan.patch.targets).toEqual([{ sceneId: 'scn_product' }]);
    expect(applied(p, plan.patch).audio.find((c) => c.id === 'aud_whoosh')).toMatchObject({ assetId: 'ast_vo2', durationInFrames: 15 });
    // Nothing plays a take yet: add one to the current scene.
    const q = structuredClone(p);
    q.audio = q.audio.filter((c) => c.id !== 'aud_whoosh');
    const add = planUseTake(q, groupTakes(q).find((g) => g.key === 'req_vo')!, 'ast_vo2', 'scn_outro');
    expect(add).toMatchObject({ kind: 'patch', patch: { targets: [{ sceneId: 'scn_outro' }] } });
    if (add.kind === 'patch') expect(applied(q, add.patch).audio.at(-1)).toMatchObject({ assetId: 'ast_vo2', sceneId: 'scn_outro', startFrame: 0 });
    // The music bed is project audio.
    const m = structuredClone(p);
    m.assets.ast_music.provenance = gen('req_music', 400);
    m.assets.ast_music2 = { id: 'ast_music2', kind: 'audio', name: 'music take 2.mp3', src: 'assets/uploads/u_m2.mp3', mimeType: 'audio/mpeg', durationInFrames: 900, provenance: gen('req_music', 410) };
    const bed = planUseTake(m, groupTakes(m).find((g) => g.key === 'req_music')!, 'ast_music2', 'scn_intro');
    expect(bed).toMatchObject({ kind: 'patch', patch: { targets: [{ audio: 'project' }] } });
    if (bed.kind === 'patch') expect(applied(m, bed.patch).audio.find((c) => c.id === 'aud_music')).toMatchObject({ assetId: 'ast_music2' });
  });

  it('fits trim, fades and the volume envelope to a shorter audio take', () => {
    const p = project();
    p.assets.ast_whoosh.durationInFrames = 90;
    p.assets.ast_vo2.durationInFrames = 30;
    const clip = p.audio.find((c) => c.id === 'aud_whoosh')!;
    Object.assign(clip, { trimStartFrames: 40, durationInFrames: 50, fadeInFrames: 10, fadeOutFrames: 45, volumeEnvelope: [{ frame: 0, value: 1 }, { frame: 20, value: 0.5 }, { frame: 50, value: 0.2 }] });
    const plan = planUseTake(p, groupTakes(p).find((g) => g.key === 'req_vo')!, 'ast_vo2', null);
    expect(plan.kind).toBe('patch');
    if (plan.kind !== 'patch') return;
    const after = applied(p, plan.patch).audio.find((c) => c.id === 'aud_whoosh')!;
    // The old in-point is past the 30-frame take: it starts from the top.
    expect(after).toMatchObject({ assetId: 'ast_vo2', trimStartFrames: 0, durationInFrames: 30, fadeInFrames: 10, fadeOutFrames: 30 });
    expect(after.volumeEnvelope?.every((pt) => pt.frame <= 30)).toBe(true);
  });

  it('times a video take from the take itself, placed or swapped in', () => {
    const p = project();
    const video = (id: string, durationInFrames: number, requestId: string, createdAt: number): Asset => ({ id, kind: 'video', name: `${id}.mp4`, src: `assets/uploads/${id}.mp4`, mimeType: 'video/mp4', width: 1920, height: 1080, durationInFrames, fps: 30, hasAudio: true, provenance: gen(requestId, createdAt) });
    // A longer, older video comes first in the assets: createElement would size from it.
    p.assets.ast_long = { ...video('ast_long', 300, 'req_other', 1), provenance: undefined };
    p.assets.ast_clip1 = video('ast_clip1', 300, 'req_clip', 500);
    p.assets.ast_clip2 = video('ast_clip2', 60, 'req_clip', 510);
    const place = planUseTake(p, groupTakes(p).find((g) => g.key === 'req_clip')!, 'ast_clip2', 'scn_intro');
    expect(place.kind).toBe('patch');
    if (place.kind !== 'patch') return;
    expect(applied(p, place.patch).scenes[0].elements[0]).toMatchObject({ type: 'video', durationInFrames: 60, props: { assetId: 'ast_clip2', trimStartFrames: 0 } });

    // Swap: take 1 plays from frame 100 for 200 frames; take 2 is only 60 frames long.
    const q = structuredClone(p);
    const el = createElement(q, q.scenes[0], 'video');
    Object.assign(el, { id: 'el_clip', durationInFrames: 200, props: { ...el.props, assetId: 'ast_clip1', trimStartFrames: 100 } });
    q.scenes[0].elements.push(el);
    const swap = planUseTake(q, groupTakes(q).find((g) => g.key === 'req_clip')!, 'ast_clip2', 'scn_intro');
    expect(swap.kind).toBe('patch');
    if (swap.kind !== 'patch') return;
    expect(applied(q, swap.patch).scenes[0].elements.find((e) => e.id === 'el_clip')).toMatchObject({ durationInFrames: 60, props: { assetId: 'ast_clip2', trimStartFrames: 0 } });
  });

  it('counts uses inside reusable components, and never places a take again over one', () => {
    const p = project();
    const scene = p.scenes[0];
    const img = createElement(p, scene, 'image');
    Object.assign(img, { id: 'el_card_img', props: { ...img.props, assetId: 'ast_hero1' } });
    p.compositions.cmp_card = { id: 'cmp_card', name: 'Card', width: 600, height: 400, durationInFrames: 60, backgroundColor: 'transparent', elements: [img] };
    const inst = createElement(p, scene, 'instance');
    Object.assign(inst, { id: 'el_card', props: { ...inst.props, compositionId: 'cmp_card' } });
    scene.elements.push(inst);
    expect(takeUsage(p).get('ast_hero1')).toBe(1);
    const hero = groupTakes(p).find((g) => g.key === 'req_hero')!;
    expect(planUseTake(p, hero, 'ast_hero2', 'scn_intro')).toMatchObject({ kind: 'none', message: expect.stringContaining('“Card”') });
    // A component nothing plays is not "in the video".
    const q = structuredClone(p);
    q.scenes[0].elements = q.scenes[0].elements.filter((e) => e.id !== 'el_card');
    expect(takeUsage(q).get('ast_hero1')).toBeUndefined();
    // Scene uses are still swapped; the component is named as left unchanged.
    const r = structuredClone(p);
    const shown = createElement(r, r.scenes[1], 'image');
    Object.assign(shown, { id: 'el_hero', props: { ...shown.props, assetId: 'ast_hero1' } });
    r.scenes[1].elements.push(shown);
    expect(planUseTake(r, groupTakes(r).find((g) => g.key === 'req_hero')!, 'ast_hero2', 'scn_intro')).toMatchObject({ kind: 'patch', patch: { targets: [{ sceneId: r.scenes[1].id, elementId: 'el_hero' }] }, note: expect.stringContaining('“Card”') });
  });

  it('never places a reference, and explains locked scenes', () => {
    const p = project();
    p.assets.ast_hero2.reference = true;
    const hero = groupTakes(p).find((g) => g.key === 'req_hero')!;
    expect(planUseTake(p, hero, 'ast_hero2', 'scn_intro')).toMatchObject({ kind: 'none', message: expect.stringContaining('reference') });
    p.scenes[0].locked = true;
    expect(planUseTake(p, hero, 'ast_hero1', 'scn_intro')).toMatchObject({ kind: 'none', message: expect.stringContaining('locked') });
  });

  it('More like this names the request, model and prompt', () => {
    const p = project();
    const hero = groupTakes(p).find((g) => g.key === 'req_hero')!;
    expect(moreLikeThisPrompt(hero, hero.takes[0])).toBe('Generate two more takes like “hero 1.png” with fal, same request and model (gpt-image-2). Original prompt: “Glass bottle on wet slate”. Keep what works in this image; vary the composition. Import them as takes of request req_hero.');
  });
});

describe('generation activity', () => {
  it('reads generation entries in plain words and merges them by time', () => {
    const base = { agent: 'Claude Code', provider: 'fal', title: 'Generate a shot image', usedToday: 3, dailyLimit: 10 };
    expect(generationItem({ ...base, id: 'g1', at: 1, kind: 'requested' })).toMatchObject({ who: 'Claude Code', byAgent: true, text: 'Asked to generate a shot image with fal (3 of 10 today)' });
    expect(generationItem({ ...base, id: 'g2', at: 2, kind: 'approved', usedToday: 4 })).toMatchObject({ who: 'You', text: 'Approved a generation with fal: a shot image (4 of 10 today)' });
    expect(generationItem({ ...base, id: 'g3', at: 3, kind: 'denied', reason: 'no answer in time' })).toMatchObject({ who: 'You', notApplied: true, text: 'Declined a generation with fal: a shot image (no answer in time)' });
    expect(generationItem({ ...base, id: 'g4', at: 4, kind: 'limit', usedToday: 10 })).toMatchObject({ notApplied: true, text: 'Daily generation limit reached; not generated: a shot image (10 of 10 today)' });
    expect(generationItem({ id: 'g5', at: 5, kind: 'imported', agent: 'Claude Code', title: 'Imported “hero.png” from fal' }).text).toBe('Imported “hero.png” from fal');
    const merged = withGenerations([{ key: 'r2', revision: 2, who: 'You', byAgent: false, text: 'Edited', at: 2.5, undoable: true }], [{ ...base, id: 'g1', at: 1, kind: 'requested' }, { ...base, id: 'g3', at: 3, kind: 'approved' }]);
    expect(merged.map((i) => i.key)).toEqual(['gg3', 'r2', 'gg1']);
  });
});
