import { describe, expect, it } from 'vitest';
import { fixtureProject } from './__fixtures__/fixtureProject';
import { parseColor } from './color';
import { applyCommand } from './commands';
import { FONT_FAMILIES } from './components';
import { createDocState, execute } from './history';
import { checkPatch } from './patch';
import { applyStylePack, easingOvershoots, MOTION_PERSONALITIES, PERSONALITY_IDS, STYLE_PACK_IDS, STYLE_PACKS, tuneMotion, withPersonality } from './style';
import type { Project } from './types';
import { validateProject } from './validate';

const clone = (): Project => structuredClone(fixtureProject);

describe('style packs', () => {
  it.each(STYLE_PACK_IDS)('%s is a valid project style with bundled fonts', (id) => {
    const pack = STYLE_PACKS[id];
    expect(pack.id).toBe(id);
    expect(validateProject({ ...clone(), style: pack }).ok).toBe(true);
    for (const font of Object.values(pack.fonts)) expect(FONT_FAMILIES).toContain(font);
    for (const colour of Object.values(pack.colors)) expect(parseColor(colour!)).not.toBeNull();
  });

  it('ship named personalities with distinct timing and curves', () => {
    expect(PERSONALITY_IDS).toEqual(['snappy', 'smooth', 'playful', 'premium', 'editorial', 'percussive']);
    const scales = PERSONALITY_IDS.map((id) => MOTION_PERSONALITIES[id].timingScale);
    expect(Math.min(...scales)).toBeGreaterThanOrEqual(0.5);
    expect(Math.max(...scales)).toBeLessThanOrEqual(2);
    expect(easingOvershoots(MOTION_PERSONALITIES.playful.enter)).toBe(true);
    expect(easingOvershoots(MOTION_PERSONALITIES.premium.enter)).toBe(false);
    expect(easingOvershoots(MOTION_PERSONALITIES.percussive.enter)).toBe(false);
    expect(new Set(PERSONALITY_IDS.map((id) => JSON.stringify(MOTION_PERSONALITIES[id].enter))).size).toBe(PERSONALITY_IDS.length);
  });

  it('ships Pulse as the house pack with measured craft tokens', () => {
    const pack = STYLE_PACKS.pulse;
    expect(pack.motion.id).toBe('percussive');
    expect(pack.craft).toBeDefined();
    expect(pack.craft?.popFrames).toEqual({ min: 2, max: 4 });
    expect(pack.craft?.beatOffsetFrames).toBe(3);
    expect(pack.craft?.spring).toEqual({ fromScale: 3, frames: 10 });
    expect(pack.craft?.typeHeightShare.max).toBeGreaterThanOrEqual(0.04);
    expect(validateProject({ ...clone(), style: pack }).ok).toBe(true);
  });

  it('tuning motion makes it custom; matching a named personality names it again', () => {
    const tuned = tuneMotion(STYLE_PACKS['snappy-saas'], { staggerFrames: 8 });
    expect(tuned.motion).toMatchObject({ id: 'custom', staggerFrames: 8 });
    expect(tuned.id).toBe('snappy-saas');
    expect(tuneMotion(tuned, { staggerFrames: 3 }).motion.id).toBe('snappy');
    expect(withPersonality(STYLE_PACKS.editorial, 'playful').motion).toEqual(MOTION_PERSONALITIES.playful);
  });
});

describe('setStyle', () => {
  it('sets and clears the project style as one undo step touching the project', () => {
    let state = createDocState(clone());
    const set = execute(state, applyStylePack(state.project, STYLE_PACKS.editorial));
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    state = set.state;
    expect(state.project.style).toEqual(STYLE_PACKS.editorial);
    expect(state.undoStack).toHaveLength(1);
    expect(state.revisions.at(-1)?.touched).toEqual([{ kind: 'project' }]);
    const cleared = applyCommand(state.project, { type: 'setStyle', style: null }, { source: 'user' });
    expect(cleared.ok && 'style' in cleared.project).toBe(false);
    // Setting the same pack again changes nothing.
    expect(applyCommand(state.project, { type: 'setStyle', style: STYLE_PACKS.editorial }, { source: 'user' })).toMatchObject({ ok: true, touched: [] });
  });

  it('rejects an out-of-range personality', () => {
    const bad = { ...STYLE_PACKS['snappy-saas'], motion: { ...STYLE_PACKS['snappy-saas'].motion, staggerFrames: 40 } };
    expect(applyCommand(clone(), { type: 'setStyle', style: bad }, { source: 'user' })).toMatchObject({ ok: false, error: { path: 'style.motion.staggerFrames' } });
  });

  it('is not allowed in AI patches without the style target', () => {
    const project = clone();
    const r = checkPatch(createDocState(project), { protocol: 'mge.patch/1', projectId: project.id, baseRevision: project.revision, summary: 'Restyle', targets: [{ sceneId: 'scn_intro' }], commands: [{ type: 'setStyle', style: STYLE_PACKS.editorial }] });
    expect(r).toMatchObject({ ok: false, error: { code: 'OUT_OF_SCOPE' } });
  });

  it('is allowed in AI patches with { style: "project" }', () => {
    const project = clone();
    const r = checkPatch(createDocState(project), { protocol: 'mge.patch/1', projectId: project.id, baseRevision: project.revision, summary: 'Brand kit', targets: [{ style: 'project' }], commands: [{ type: 'setStyle', style: STYLE_PACKS.editorial }] });
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
    if (r.ok) expect(r.project.style).toEqual(STYLE_PACKS.editorial);
  });

  it('can repaint unlocked scene backgrounds and leaves approved scenes alone', () => {
    const project = clone();
    project.scenes[2].locked = true;
    const command = applyStylePack(project, STYLE_PACKS['playful-consumer'], { backgrounds: true });
    const r = applyCommand(project, command, { source: 'user' });
    expect(r.ok, r.ok ? '' : r.error.message).toBe(true);
    if (!r.ok) return;
    expect(r.project.backgroundColor).toBe('#FFF4E8');
    expect(r.project.scenes.map((s) => s.backgroundColor)).toEqual(['#FFF4E8', '#FFF4E8', project.scenes[2].backgroundColor]);
  });
});
