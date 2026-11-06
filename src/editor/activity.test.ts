import { describe, expect, it } from 'vitest';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import { createDocState, execute, undo } from '../core/history';
import { applyPatch } from '../core/patch';
import { PATCH_PROTOCOL, type DocState } from '../core/types';
import { activityItems, ago, withProposals } from './activity';

function run(doc: DocState, ...args: Parameters<typeof execute> extends [DocState, ...infer R] ? R : never): DocState {
  const r = execute(doc, ...args);
  if (!r.ok) throw new Error(r.error.message);
  return r.state;
}

describe('activity feed', () => {
  it('describes changes in plain words, newest first, crediting the agent by name and the user', () => {
    let doc = createDocState(structuredClone(fixtureProject));
    doc = run(doc, { type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 110 } } });
    const p = applyPatch(doc, {
      protocol: PATCH_PROTOCOL,
      projectId: doc.project.id,
      baseRevision: doc.project.revision,
      summary: 'Warmer subhead',
      targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_sub' }],
      commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_sub', changes: { props: { color: '#FFD8A8' } } }],
    }, { actor: 'Codex' });
    if (!p.ok) throw new Error(p.error.message);
    doc = run(p.state, { type: 'removeElement', sceneId: 'scn_intro', elementId: 'el_intro_glow' }, 'user');

    const items = activityItems(doc);
    expect(items.map((i) => [i.who, i.text])).toEqual([
      ['You', 'Removed “Glow”'],
      ['Codex', 'Warmer subhead'],
      ['You', 'Edited “Headline”'],
    ]);
    expect(items.map((i) => i.undoable)).toEqual([true, false, false]);
  });

  it('shows undo as its own entry and moves the undo offer back', () => {
    let doc = createDocState(structuredClone(fixtureProject));
    doc = run(doc, { type: 'updateScene', sceneId: 'scn_intro', changes: { name: 'Opening' } });
    doc = run(doc, { type: 'updateScene', sceneId: 'scn_outro', changes: { name: 'Close' } });
    doc = undo(doc);
    const items = activityItems(doc);
    expect(items[0].text).toBe('Undid: Edited scene “Close”');
    expect(items.find((i) => i.undoable)?.text).toBe('Edited scene “Opening”');
  });

  it('names the element for editor labels that only name the action', () => {
    let doc = createDocState(structuredClone(fixtureProject));
    doc = run(doc, { type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_logo', changes: { transform: { x: 700 } } }, 'user', 'Nudge element');
    doc = run(doc, { type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_logo', changes: { transform: { x: 710 } } }, 'user', 'Changed “Logo” text');
    expect(activityItems(doc).map((i) => i.text)).toEqual(['Changed “Logo” text', 'Nudge element · “Logo”']);
  });

  it('credits pasted or older agent patches ("AI: …") to "Agent"', () => {
    let doc = createDocState(structuredClone(fixtureProject));
    const p = applyPatch(doc, {
      protocol: PATCH_PROTOCOL,
      projectId: doc.project.id,
      baseRevision: doc.project.revision,
      summary: 'Pasted change',
      targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_sub' }],
      commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_sub', changes: { name: 'Sub' } }],
    });
    if (!p.ok) throw new Error(p.error.message);
    doc = p.state;
    expect(activityItems(doc)[0]).toMatchObject({ who: 'Agent', text: 'Pasted change', byAgent: true });
  });

  it('credits a patch the user pasted and applied ("You: …") to the user', () => {
    const doc = createDocState(structuredClone(fixtureProject));
    const p = applyPatch(doc, {
      protocol: PATCH_PROTOCOL,
      projectId: doc.project.id,
      baseRevision: doc.project.revision,
      summary: 'Pasted change',
      targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_sub' }],
      commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_sub', changes: { name: 'Sub' } }],
    }, { actor: 'You' });
    if (!p.ok) throw new Error(p.error.message);
    expect(activityItems(p.state)[0]).toMatchObject({ who: 'You', text: 'Pasted change', byAgent: false });
  });

  it('lists declined and out-of-date proposals by time, but not applied or replaced ones', () => {
    const items = activityItems(createDocState(structuredClone(fixtureProject)));
    const base = { projectId: 'prj_sample', source: 'mcp' as const, baseRevision: 1, createdAt: 0 };
    const merged = withProposals(
      [{ key: 'r2', revision: 2, who: 'You', byAgent: false, text: 'Edited', at: 150, undoable: true }, ...items],
      [
        { ...base, id: 'p3', agent: 'Codex', summary: 'Bigger', status: 'cancelled', decidedAt: 300 },
        { ...base, id: 'p2', agent: 'Codex', summary: 'Bluer', status: 'stale', decidedAt: 100 },
        { ...base, id: 'p1', agent: 'Codex', summary: 'Older', status: 'replaced', decidedAt: 90 },
        { ...base, id: 'p0', agent: 'Codex', summary: 'Kept', status: 'applied', revision: 2, decidedAt: 80 },
      ],
    );
    expect(merged.map((i) => [i.who, i.text, !!i.notApplied])).toEqual([
      ['You', 'Declined Codex’s proposal: Bigger', true],
      ['You', 'Edited', false],
      ['Codex', 'Proposal went out of date: Bluer', true],
    ]);
  });

  it('formats relative times', () => {
    expect(ago(1000, 20000)).toBe('just now');
    expect(ago(0, 5 * 60000)).toBe('5 min ago');
    expect(ago(0, 3 * 3600000)).toBe('3 h ago');
  });
});
