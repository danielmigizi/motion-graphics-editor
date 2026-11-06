import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyCommand } from './commands';
import { buildCut, cutDraftProject, cutSlotValues, CUT_BEATS } from './cutCards';
import { cardsFor, CUT_CARDS, cutCard, DEFAULT_CUT } from './cutCatalog';
import { critiqueProject } from './critique';
import { blankProject } from './newProject';
import { validateProject } from './validate';

let n = 0;
const ids = (prefix: string) => `${prefix}_${++n}`;

describe('cut-card catalog', () => {
  it('has twelve cards per beat with unique, beat-prefixed ids', () => {
    for (const beat of CUT_BEATS) expect(cardsFor(beat)).toHaveLength(12);
    expect(new Set(CUT_CARDS.map((c) => c.id)).size).toBe(CUT_CARDS.length);
    for (const card of CUT_CARDS) {
      expect(card.id.startsWith(`${card.beat}.`)).toBe(true);
      expect(card.name.length).toBeGreaterThan(20);
      expect(card.why.length).toBeGreaterThan(20);
      expect(card.mechanic.length).toBeGreaterThan(0);
      expect(Object.keys(card.slots).length).toBeGreaterThan(0);
    }
  });

  it('opens hooks and closes CTAs', () => {
    expect(cardsFor('hook').every((c) => c.position === 'opener')).toBe(true);
    expect(cardsFor('cta').every((c) => c.position === 'closer')).toBe(true);
  });

  it.each([
    ['16:9', { width: 1920, height: 1080, fps: 30, backgroundColor: '#000000' }],
    ['9:16', { width: 1080, height: 1920, fps: 30, backgroundColor: '#000000' }],
  ])('builds every card into a valid project at %s', (_, format) => {
    for (const card of CUT_CARDS) {
      const project = cutDraftProject([card], { format, newId: ids });
      const v = validateProject(project);
      expect(v.ok, `${card.id}: ${v.ok ? '' : JSON.stringify(v)}`).toBe(true);
      const scene = project.scenes[0];
      expect(scene.durationInFrames).toBe(Math.round(card.seconds * 30));
      expect(scene.elements.length, card.id).toBeGreaterThan(1);
      // Every template group holds to the cut.
      for (const group of scene.elements.filter((e) => e.type === 'group' && !e.parentId)) {
        expect(group.startFrame + group.durationInFrames, card.id).toBe(scene.durationInFrames);
      }
    }
  });

  it('puts slot copy on screen', () => {
    const card = cutCard('hook.big-number')!;
    const project = cutDraftProject([card], { newId: ids, slots: { [card.id]: { stat: '9 h', label: 'lost to meetings' } } });
    const texts = project.scenes[0].elements.map((e) => e.props.text);
    expect(texts).toContain('9 h');
    expect(texts).toContain('lost to meetings');
  });
});

describe('cutSlotValues', () => {
  it('fills samples and refuses unknown slots', () => {
    const card = cutCard('cta.typed-url')!;
    const ok = cutSlotValues(card, { url: ' acme.dev ', tagline: '' });
    expect(ok).toEqual({ ok: true, values: { product: 'Brieflet', tagline: card.slots.tagline.sample, url: 'acme.dev' } });
    const bad = cutSlotValues(card, { headline: 'x' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.message).toContain('has no slot "headline"');
  });
});

describe('buildCut', () => {
  it('fits the scene to the card and builds into it, refusing locked scenes', () => {
    const base = blankProject({ project: 'prj_1', scene: 'scn_1' });
    const card = cutCard('hook.big-number')!;
    const built = buildCut(card, { project: base, sceneId: 'scn_1', fitScene: true, newId: () => ids('el') });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.commands[0]).toEqual({ type: 'updateScene', sceneId: 'scn_1', changes: { durationInFrames: 105 } });
    const applied = applyCommand(base, { type: 'batch', label: built.label, commands: built.commands }, { source: 'ai' });
    expect(applied.ok).toBe(true);
    if (applied.ok) expect(applied.project.scenes[0].elements.length).toBe(built.elements.length);

    const locked = { ...base, scenes: base.scenes.map((s) => ({ ...s, locked: true })) };
    expect(buildCut(card, { project: locked, sceneId: 'scn_1' })).toMatchObject({ ok: false });
  });
});

describe('cutDraftProject', () => {
  it('stitches the default cut with story beats on each scene', () => {
    const cards = CUT_BEATS.map((b) => cutCard(DEFAULT_CUT[b])!);
    const project = cutDraftProject(cards, { newId: ids });
    expect(validateProject(project).ok).toBe(true);
    expect(project.scenes.map((s) => s.name)).toEqual(['Open', 'Show', 'Shift', 'Close']);
    expect(project.story?.beats.map((b) => b.role)).toEqual(['hook', 'proof', 'turn', 'cta']);
    const last = project.story!.beats[3];
    expect(last.toFrame).toBe(project.scenes.reduce((sum, s) => sum + s.durationInFrames, 0));
    // The story layer satisfies critique's mapping checks.
    const rules = critiqueProject(project).findings.map((f) => f.rule);
    expect(rules).not.toContain('story:missingRoles');
    expect(rules).not.toContain('story:unmappedScene');
  });
});

describe('cut-card previews', () => {
  it('has a rendered preview for every card (run npm run cards:render after editing the catalog)', () => {
    const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '../../public/cut-previews/manifest.json'), 'utf8')) as { cards: Record<string, { video: string; poster: string }> };
    for (const card of CUT_CARDS) {
      const entry = manifest.cards[card.id];
      expect(entry, card.id).toBeDefined();
      expect(existsSync(join(import.meta.dirname, '../../public', entry.video)), entry.video).toBe(true);
      expect(existsSync(join(import.meta.dirname, '../../public', entry.poster)), entry.poster).toBe(true);
    }
  });
});
