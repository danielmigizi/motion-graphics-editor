import { describe, expect, it } from 'vitest';
import { fixtureProject as sampleProject } from './__fixtures__/fixtureProject';
import { diffProjects } from './diff';
import { createDocState, execute, loadDoc, redo, restoreRevision, serializeDoc, touchedSince, undo } from './history';
import { applyPatch, checkPatch, parsePatch } from './patch';
import type { AiPatch, Command, DocResult, DocState } from './types';

function ok(r: DocResult): DocState {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.state;
}

const headline = (text: string): Command => ({ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { text } } });

function headlinePatch(baseRevision: number, text = 'Release notes people finish'): AiPatch {
  return {
    protocol: 'mge.patch/1',
    projectId: 'prj_sample',
    baseRevision,
    summary: 'Sharper headline',
    targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }],
    commands: [headline(text)],
  };
}

describe('history', () => {
  it('undo/redo restore content while revisions keep increasing', () => {
    let s = createDocState(sampleProject);
    s = ok(execute(s, headline('A')));
    s = ok(execute(s, headline('B')));
    expect(s.project.revision).toBe(3);
    s = undo(s);
    expect(s.project.revision).toBe(4);
    expect(s.project.scenes[0].elements[2].props.text).toBe('A');
    s = undo(s);
    expect(s.project.revision).toBe(5);
    expect(s.project.scenes[0].elements[2].props.text).toBe('Updates your team actually reads');
    s = redo(s);
    expect(s.project.revision).toBe(6);
    expect(s.project.scenes[0].elements[2].props.text).toBe('A');
    expect(s.revisions.map((r) => r.source)).toEqual(['load', 'user', 'user', 'undo', 'undo', 'redo']);
    // undo/redo records carry the touched refs of the change they revert
    expect(s.revisions[3].touched).toEqual([{ kind: 'element', sceneId: 'scn_intro', elementId: 'el_intro_headline' }]);
    expect(s.revisions[5].touched).toEqual([{ kind: 'element', sceneId: 'scn_intro', elementId: 'el_intro_headline' }]);
    // a new change clears redo
    s = ok(execute(s, headline('C')));
    expect(s.redoStack).toHaveLength(0);
  });

  it('failed commands do not change state or revision', () => {
    const s = createDocState(sampleProject);
    const r = execute(s, { type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 1 } } });
    expect(r.ok).toBe(false);
    expect(s.project.revision).toBe(1);
  });

  it('batch is one undo step and one revision', () => {
    let s = createDocState(sampleProject);
    s = ok(execute(s, { type: 'batch', label: 'Two edits', commands: [headline('X'), { type: 'updateScene', sceneId: 'scn_outro', changes: { name: 'End' } }] }));
    expect(s.project.revision).toBe(2);
    expect(s.undoStack).toHaveLength(1);
    s = undo(s);
    expect(s.project.scenes[2].name).toBe('Outro');
    expect(s.project.scenes[0].elements[2].props.text).toBe('Updates your team actually reads');
  });

  it('restoreRevision rolls back as a new, undoable revision', () => {
    let s = createDocState(sampleProject);
    s = ok(execute(s, headline('A')));
    s = ok(execute(s, headline('B')));
    s = ok(restoreRevision(s, 1));
    expect(s.project.revision).toBe(4);
    expect(s.project.scenes[0].elements[2].props.text).toBe('Updates your team actually reads');
    expect(s.revisions.at(-1)!.source).toBe('rollback');
    s = undo(s);
    expect(s.project.scenes[0].elements[2].props.text).toBe('B');
    expect(restoreRevision(s, 999)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('touchedSince unions refs after a revision and returns null past the log', () => {
    let s = createDocState(sampleProject);
    s = ok(execute(s, headline('A')));
    s = ok(execute(s, { type: 'updateScene', sceneId: 'scn_outro', changes: { name: 'End' } }));
    expect(touchedSince(s, 3)).toEqual([]);
    expect(touchedSince(s, 2)).toEqual([{ kind: 'scene', sceneId: 'scn_outro' }]);
    expect(touchedSince(s, 1)).toEqual([
      { kind: 'element', sceneId: 'scn_intro', elementId: 'el_intro_headline' },
      { kind: 'scene', sceneId: 'scn_outro' },
    ]);
    expect(touchedSince(s, 0)).toBeNull();
    expect(touchedSince(s, 7)).toBeNull();
  });

  it('serializeDoc / loadDoc round-trips content, layout, timing, tracks, assets and audio', () => {
    let s = createDocState(sampleProject);
    s = ok(execute(s, headline('Saved')));
    s = ok(execute(s, { type: 'moveScene', sceneId: 'scn_outro', toIndex: 0 }));
    const file = JSON.parse(JSON.stringify(serializeDoc(s)));
    expect(file.format).toBe('mge.project/1');
    const loaded = ok(loadDoc(file));
    expect(loaded.project).toEqual(s.project);
    expect(loaded.project.scenes.map((sc) => sc.elements.map((e) => [e.transform, e.startFrame, e.durationInFrames, e.tracks, e.props]))).toEqual(
      s.project.scenes.map((sc) => sc.elements.map((e) => [e.transform, e.startFrame, e.durationInFrames, e.tracks, e.props])),
    );
    expect(loaded.project.assets).toEqual(sampleProject.assets);
    expect(loaded.project.audio).toEqual(sampleProject.audio);
    expect(loaded.revisions.map((r) => r.revision)).toEqual([1, 2, 3]);
    expect(loaded.undoStack).toEqual([]);
  });

  it('serializeDoc keeps only the last 30 revisions; loadDoc rejects invalid files', () => {
    let s = createDocState(sampleProject);
    for (let i = 0; i < 40; i++) s = ok(execute(s, headline(`v${i}`)));
    expect(serializeDoc(s).revisions).toHaveLength(30);
    const file = JSON.parse(JSON.stringify(serializeDoc(s)));
    file.project.scenes[0].elements[2].props.fontSize = 900;
    expect(loadDoc(file)).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'project.scenes[0].elements[2].props.fontSize' } });
    expect(loadDoc({ format: 'nope' } as never)).toMatchObject({ ok: false, error: { code: 'INVALID' } });
  });
});

describe('parsePatch', () => {
  const patch = headlinePatch(1);

  it('accepts raw JSON', () => {
    expect(parsePatch(JSON.stringify(patch))).toEqual({ ok: true, patch });
  });

  it('accepts JSON inside a fenced block, taking the first fence with "protocol"', () => {
    const text = `Here you go.\n\n\`\`\`ts\nconst x = 1;\n\`\`\`\n\n\`\`\`json\n${JSON.stringify(patch, null, 2)}\n\`\`\`\nDone.`;
    expect(parsePatch(text)).toEqual({ ok: true, patch });
  });

  it('reports PROTOCOL errors with paths', () => {
    expect(parsePatch('no json here')).toMatchObject({ ok: false, error: { code: 'PROTOCOL' } });
    expect(parsePatch('{ not json')).toMatchObject({ ok: false, error: { code: 'PROTOCOL' } });
    expect(parsePatch(JSON.stringify({ ...patch, protocol: 'v0' }))).toMatchObject({ ok: false, error: { code: 'PROTOCOL', path: 'protocol' } });
    const r = parsePatch(JSON.stringify({ ...patch, commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { startFrame: 'soon' } }] }));
    expect(r).toMatchObject({ ok: false, error: { code: 'PROTOCOL', path: 'commands[0].changes.startFrame' } });
  });
});

describe('applyPatch', () => {
  it('targeted headline patch changes exactly one field; everything else is reference-equal', () => {
    const s = createDocState(sampleProject);
    const next = ok(applyPatch(s, headlinePatch(1)));
    const before = s.project;
    const after = next.project;
    const diff = diffProjects(before, after);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toMatchObject({ kind: 'element', elementId: 'el_intro_headline', path: 'props.text', change: 'modified', after: 'Release notes people finish' });
    expect(diff[0].label).toBe('Scene "Intro" › Headline › props.text');
    expect(after.scenes[1]).toBe(before.scenes[1]);
    expect(after.scenes[2]).toBe(before.scenes[2]);
    after.scenes[0].elements.forEach((e, i) => {
      if (e.id !== 'el_intro_headline') expect(e).toBe(before.scenes[0].elements[i]);
    });
    expect(after.scenes[0].elements[2].transform).toBe(before.scenes[0].elements[2].transform);
    expect(after.scenes[0].elements[2].tracks).toBe(before.scenes[0].elements[2].tracks);
    expect(after.assets).toBe(before.assets);
    expect(after.audio).toBe(before.audio);
    // one revision, one undo step, labelled, source ai
    expect(after.revision).toBe(2);
    expect(next.undoStack).toHaveLength(1);
    expect(next.revisions.at(-1)).toMatchObject({ source: 'ai', label: 'AI: Sharper headline' });
    expect(undo(next).project.scenes[0].elements[2].props.text).toBe('Updates your team actually reads');
  });

  it('checkPatch previews without committing', () => {
    const s = createDocState(sampleProject);
    const r = checkPatch(s, headlinePatch(1));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.diff).toHaveLength(1);
      expect(r.project.revision).toBe(1);
    }
    expect(s.project).toBe(sampleProject);
  });

  it('project mismatch → PROJECT_MISMATCH', () => {
    const s = createDocState(sampleProject);
    expect(applyPatch(s, { ...headlinePatch(1), projectId: 'prj_other' })).toMatchObject({ ok: false, error: { code: 'PROJECT_MISMATCH' } });
  });

  it('stale patch → STALE with both revisions', () => {
    let s = createDocState(sampleProject);
    s = ok(execute(s, { type: 'updateScene', sceneId: 'scn_outro', changes: { name: 'End' } }));
    const r = applyPatch(s, headlinePatch(1));
    expect(r).toMatchObject({ ok: false, error: { code: 'STALE' } });
    if (!r.ok) {
      expect(r.error.message).toContain('revision 1');
      expect(r.error.message).toContain('revision 2');
      expect(r.error.message).toContain('Regenerate the prompt, or Reconcile if the targets have not changed');
    }
  });

  it('reconcile is allowed when an unrelated element changed, refused when the target changed', () => {
    let s = createDocState(sampleProject);
    s = ok(execute(s, { type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_sub', changes: { props: { text: 'Other' } } }));
    const r = ok(applyPatch(s, headlinePatch(1), { reconcile: true }));
    expect(r.project.revision).toBe(3);
    expect(r.project.scenes[0].elements[2].props.text).toBe('Release notes people finish');
    expect(r.project.scenes[0].elements[3].props.text).toBe('Other');

    let t = createDocState(sampleProject);
    t = ok(execute(t, headline('Manual edit')));
    const refused = checkPatch(t, headlinePatch(1), { reconcile: true });
    expect(refused).toMatchObject({ ok: false, error: { code: 'STALE' }, conflicts: [{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }] });
    // scene-level change of the target's scene also conflicts
    let u = createDocState(sampleProject);
    u = ok(execute(u, { type: 'updateScene', sceneId: 'scn_intro', changes: { name: 'Opening' } }));
    expect(checkPatch(u, headlinePatch(1), { reconcile: true })).toMatchObject({ ok: false, error: { code: 'STALE' } });
  });

  it('a patch targeting an element still applies after its scene moved (reconcile)', () => {
    let s = createDocState(sampleProject);
    s = ok(execute(s, { type: 'moveScene', sceneId: 'scn_intro', toIndex: 2 }));
    expect(applyPatch(s, headlinePatch(1))).toMatchObject({ ok: false, error: { code: 'STALE' } });
    const r = ok(applyPatch(s, headlinePatch(1), { reconcile: true }));
    const intro = r.project.scenes[2];
    expect(intro.id).toBe('scn_intro');
    expect(intro.elements.find((e) => e.id === 'el_intro_headline')!.props.text).toBe('Release notes people finish');
  });

  it('out-of-scope commands → OUT_OF_SCOPE', () => {
    const s = createDocState(sampleProject);
    const otherElement: AiPatch = { ...headlinePatch(1), commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_sub', changes: { props: { text: 'x' } } }] };
    expect(applyPatch(s, otherElement)).toMatchObject({ ok: false, error: { code: 'OUT_OF_SCOPE', path: 'commands[0]' } });
    const forbidden: AiPatch = { ...headlinePatch(1), commands: [{ type: 'updateProject', changes: { name: 'x' } }] };
    expect(applyPatch(s, forbidden)).toMatchObject({ ok: false, error: { code: 'OUT_OF_SCOPE' } });
    const needsScene: AiPatch = { ...headlinePatch(1), commands: [{ type: 'removeElement', sceneId: 'scn_intro', elementId: 'el_intro_headline' }] };
    expect(applyPatch(s, needsScene)).toMatchObject({ ok: false, error: { code: 'OUT_OF_SCOPE' } });
    const nested: AiPatch = { ...headlinePatch(1), commands: [{ type: 'batch', label: 'b', commands: [{ type: 'setSceneLock', sceneId: 'scn_intro', locked: true }] }] };
    expect(applyPatch(s, nested)).toMatchObject({ ok: false, error: { code: 'OUT_OF_SCOPE', path: 'commands[0].commands[0]' } });
    // scene target permits its elements
    const sceneWide: AiPatch = { ...headlinePatch(1), targets: [{ sceneId: 'scn_intro' }], commands: [headline('a'), { type: 'removeElement', sceneId: 'scn_intro', elementId: 'el_intro_sub' }] };
    expect(applyPatch(s, sceneWide).ok).toBe(true);
  });

  it('AI patch touching a locked scene → LOCKED and project unchanged', () => {
    let s = createDocState(sampleProject);
    s = ok(execute(s, { type: 'setSceneLock', sceneId: 'scn_intro', locked: true }));
    const r = applyPatch(s, headlinePatch(2));
    expect(r).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    expect(s.project.scenes[0].elements[2].props.text).toBe('Updates your team actually reads');
    expect(s.project.revision).toBe(2);
  });

  it('invalid prop in a patch → INVALID with path, nothing applied', () => {
    const s = createDocState(sampleProject);
    const bad: AiPatch = { ...headlinePatch(1), commands: [headline('ok'), { type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 900 } } }] };
    const r = applyPatch(s, bad);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'scenes[0].elements[2].props.fontSize' } });
  });
});

describe('no-op commands', () => {
  it('commit no revision and no undo step', async () => {
    const { createDocState, execute } = await import('./history');
    const { sampleProject } = await import('./__fixtures__/fixtureProject').then((m) => ({ sampleProject: m.fixtureProject }));
    const s0 = createDocState(sampleProject);
    const el = sampleProject.scenes[0].elements[2];
    const r = execute(s0, { type: 'updateElement', sceneId: 'scn_intro', elementId: el.id, changes: { transform: { x: el.transform.x } } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.state.project.revision).toBe(sampleProject.revision);
    expect(r.state.undoStack.length).toBe(0);
  });
});
