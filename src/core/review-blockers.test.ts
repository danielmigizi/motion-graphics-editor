// Regression tests: commands and patches reject undeclared fields, rollback
// respects scene locks, replacing an asset a locked scene uses, and imported
// revision history is verified.

import { describe, expect, it } from 'vitest';
import { fixtureProject as fixture } from './__fixtures__/fixtureProject';
import { applyCommand } from './commands';
import { createDocState, execute, loadDoc, restoreRevision, serializeDoc, touchedSince } from './history';
import { applyPatch, checkPatch, parsePatch } from './patch';
import { validateProject } from './validate';
import type { AiPatch, Command, DocResult, DocState, Project, ProjectFile } from './types';

const fresh = (): Project => structuredClone(fixture);

function ok(r: DocResult): DocState {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} @ ${r.error.path}`);
  return r.state;
}

const headline = (text: string): Command => ({ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { text } } });
const lock = (sceneId: string, locked = true): Command => ({ type: 'setSceneLock', sceneId, locked });
const introText = (p: Project) => p.scenes.find((s) => s.id === 'scn_intro')!.elements.find((e) => e.id === 'el_intro_headline')!.props.text;

function patchOf(p: Project, targets: AiPatch['targets'], commands: unknown[]): AiPatch {
  return { protocol: 'mge.patch/1', projectId: p.id, baseRevision: p.revision, summary: 'repro', targets, commands: commands as Command[] };
}

const roundTrip = (s: DocState): ProjectFile => JSON.parse(JSON.stringify(serializeDoc(s)));

describe('commands and patches reject undeclared fields', () => {
  it('AI cannot set a scene lock through updateScene.changes.locked', () => {
    const p = fresh();
    const raw = patchOf(p, [{ sceneId: 'scn_intro' }], [{ type: 'updateScene', sceneId: 'scn_intro', changes: { name: 'Intro revised', locked: true } }]);
    const parsed = parsePatch(JSON.stringify(raw));
    expect(parsed).toMatchObject({ ok: false, error: { code: 'PROTOCOL', path: 'commands[0].changes.locked' } });
    if (!parsed.ok) expect(parsed.error.message).toContain('"locked"');
    // Handing the object straight to applyPatch is refused the same way.
    const applied = applyPatch(createDocState(p), raw);
    expect(applied).toMatchObject({ ok: false, error: { code: 'PROTOCOL', path: 'commands[0].changes.locked' } });
  });

  it('an element layout patch cannot erase tracks via an undeclared changes.tracks', () => {
    const p = fresh();
    const before = p.scenes[0].elements[1].tracks.length;
    expect(before).toBeGreaterThan(0);
    const raw = patchOf(p, [{ sceneId: 'scn_intro', elementId: 'el_intro_logo' }], [
      { type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_logo', changes: { transform: { x: 800 }, tracks: [] } },
    ]);
    expect(parsePatch(JSON.stringify(raw))).toMatchObject({ ok: false, error: { code: 'PROTOCOL', path: 'commands[0].changes.tracks' } });
    expect(checkPatch(createDocState(p), raw)).toMatchObject({ ok: false, error: { code: 'PROTOCOL', path: 'commands[0].changes.tracks' } });
    // The same command executed by the user is INVALID, and nothing changes.
    const s = createDocState(p);
    const r = execute(s, raw.commands[0]);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'changes.tracks' } });
    expect(s.project.scenes[0].elements[1].tracks).toHaveLength(before);
  });

  it('an undeclared scene.elements array cannot commit an invalid project', () => {
    const p = fresh();
    const raw = patchOf(p, [{ sceneId: 'scn_intro' }], [
      { type: 'updateScene', sceneId: 'scn_intro', changes: { name: 'Intro revised', elements: p.scenes[0].elements.map((e) => ({ ...e, visible: 'not-a-boolean' })) } },
    ]);
    expect(parsePatch(JSON.stringify(raw))).toMatchObject({ ok: false, error: { code: 'PROTOCOL', path: 'commands[0].changes.elements' } });
    expect(applyPatch(createDocState(p), raw)).toMatchObject({ ok: false, error: { code: 'PROTOCOL' } });
  });

  it('unknown keys are rejected at any depth, with the key in the path', () => {
    const p = fresh();
    const element = { ...structuredClone(p.scenes[0].elements[2]), id: 'el_new' };
    const nested = { type: 'addElement', sceneId: 'scn_outro', element: { ...element, transform: { ...element.transform, skew: 3 } } } as unknown as Command;
    expect(applyCommand(p, nested, { source: 'user' })).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'element.transform.skew' } });
    const inBatch = { type: 'batch', label: 'b', commands: [headline('ok'), { type: 'removeElement', sceneId: 'scn_intro', elementId: 'el_intro_sub', force: true }] } as unknown as Command;
    expect(applyCommand(p, inBatch, { source: 'user' })).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'commands[1].force' } });
    const target = patchOf(p, [{ sceneId: 'scn_intro', elementId: 'el_intro_headline', all: true } as never], [headline('x')]);
    expect(parsePatch(JSON.stringify(target))).toMatchObject({ ok: false, error: { code: 'PROTOCOL', path: 'targets[0].all' } });
    const top = { ...patchOf(p, [{ sceneId: 'scn_intro' }], [headline('x')]), force: true };
    expect(parsePatch(JSON.stringify(top))).toMatchObject({ ok: false, error: { code: 'PROTOCOL', path: 'force' } });
  });

  it('the parsed value is what gets applied, and every committed project reopens', () => {
    let s = createDocState(fresh());
    s = ok(execute(s, { type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_logo', changes: { transform: { x: 800 } } }));
    expect(s.project.scenes[0].elements[1].tracks).toHaveLength(fixture.scenes[0].elements[1].tracks.length);
    const applied = ok(applyPatch(s, patchOf(s.project, [{ sceneId: 'scn_intro' }], [{ type: 'updateScene', sceneId: 'scn_intro', changes: { name: 'Intro revised' } }])));
    expect(validateProject(applied.project).ok).toBe(true);
    expect(loadDoc(roundTrip(applied)).ok).toBe(true);
  });

  it('loading a project file with an undeclared field is rejected (shape validation is strict)', () => {
    const file = roundTrip(createDocState(fresh()));
    (file.project.scenes[0].elements[0] as unknown as Record<string, unknown>).secret = 1;
    expect(loadDoc(file)).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'project.scenes[0].elements[0].secret' } });
  });
});

describe('rollback respects scene locks', () => {
  it('refuses a rollback that would change an approved (locked) scene, naming it', () => {
    let s = createDocState(fresh());
    s = ok(execute(s, headline('APPROVED')));
    s = ok(execute(s, lock('scn_intro')));
    const r = restoreRevision(s, 1);
    expect(r).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    if (!r.ok) {
      expect(r.error.message).toContain('"Intro" (scn_intro)');
      expect(r.error.message).toMatch(/Unlock it first/);
    }
    expect(introText(s.project)).toBe('APPROVED');
    // After unlocking, the rollback goes through.
    s = ok(execute(s, lock('scn_intro', false)));
    s = ok(restoreRevision(s, 1));
    expect(introText(s.project)).toBe('Updates your team actually reads');
  });

  it('refuses when only the lock flag would change (rolling back to before the lock)', () => {
    let s = createDocState(fresh());
    s = ok(execute(s, lock('scn_intro')));
    expect(restoreRevision(s, 1)).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
  });

  it('allows a rollback that leaves every locked scene identical', () => {
    let s = createDocState(fresh());
    s = ok(execute(s, lock('scn_intro')));
    s = ok(execute(s, { type: 'updateScene', sceneId: 'scn_outro', changes: { name: 'End' } }));
    s = ok(restoreRevision(s, 2));
    expect(s.project.scenes[2].name).toBe('Outro');
    expect(s.project.scenes[0].locked).toBe(true);
  });

  it('refuses when an asset used by the locked scene would change (scene itself identical)', () => {
    let s = createDocState(fresh());
    s = ok(execute(s, lock('scn_outro'))); // r2: outro locked, old logo
    s = ok(execute(s, lock('scn_outro', false)));
    s = ok(execute(s, { type: 'replaceAsset', assetId: 'ast_logo', changes: { src: 'assets/uploads/v2.svg' } }));
    s = ok(execute(s, lock('scn_outro'))); // r5: outro locked, new logo
    const r = restoreRevision(s, 2);
    expect(r).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    if (!r.ok) {
      expect(r.error.message).toContain('"Outro" (scn_outro)');
      expect(r.error.message).not.toContain('scn_intro');
    }
    expect(s.project.assets.ast_logo.src).toBe('assets/uploads/v2.svg');
  });

  it('refuses when an audio clip anchored to the locked scene would change (scene itself identical)', () => {
    let s = createDocState(fresh());
    s = ok(execute(s, lock('scn_product'))); // r2
    s = ok(execute(s, lock('scn_product', false)));
    s = ok(execute(s, { type: 'updateAudioClip', clipId: 'aud_whoosh', changes: { volume: 0.2 } }));
    s = ok(execute(s, lock('scn_product')));
    const r = restoreRevision(s, 2);
    expect(r).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    if (!r.ok) expect(r.error.message).toContain('scn_product');
  });
});

describe('replacing an asset used by a locked scene', () => {
  it('replaceAsset of a logo used by a locked scene → LOCKED naming the scene', () => {
    const s = ok(execute(createDocState(fresh()), lock('scn_intro')));
    const r = execute(s, { type: 'replaceAsset', assetId: 'ast_logo', changes: { src: 'assets/uploads/replacement.svg' } });
    expect(r).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    if (!r.ok) {
      expect(r.error.message).toContain('"Intro" (scn_intro)');
      expect(r.error.message).toMatch(/Unlock it first/);
    }
    expect(s.project.assets.ast_logo.src).toBe('assets/logo.svg');
  });

  it('names every locked scene that uses the asset', () => {
    let s = ok(execute(createDocState(fresh()), lock('scn_intro')));
    s = ok(execute(s, lock('scn_outro')));
    const r = execute(s, { type: 'replaceAsset', assetId: 'ast_logo', changes: { src: 'assets/uploads/replacement.svg' } });
    expect(r).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    if (!r.ok) {
      expect(r.error.message).toContain('scn_intro');
      expect(r.error.message).toContain('scn_outro');
      expect(r.error.message).toMatch(/Unlock them first/);
    }
  });

  it('an audio asset anchored to a locked scene is locked; a project-level clip does not lock its asset', () => {
    let s = createDocState(fresh());
    for (const sc of s.project.scenes) s = ok(execute(s, lock(sc.id)));
    expect(execute(s, { type: 'replaceAsset', assetId: 'ast_whoosh', changes: { src: 'assets/uploads/w2.wav' } })).toMatchObject({
      ok: false,
      error: { code: 'LOCKED' },
    });
    // ast_music is only used by the project-level music bed.
    const r = ok(execute(s, { type: 'replaceAsset', assetId: 'ast_music', changes: { src: 'assets/uploads/music2.wav' } }));
    expect(r.project.assets.ast_music.src).toBe('assets/uploads/music2.wav');
  });

  it('unlocked users and renames stay allowed', () => {
    const s = createDocState(fresh());
    expect(execute(s, { type: 'replaceAsset', assetId: 'ast_logo', changes: { src: 'assets/uploads/replacement.svg' } }).ok).toBe(true);
    const locked = ok(execute(s, lock('scn_intro')));
    expect(execute(locked, { type: 'replaceAsset', assetId: 'ast_logo', changes: { name: 'Logo v2' } }).ok).toBe(true);
  });
});

describe('imported revision history is verified', () => {
  it('forged touched lists are ignored: a stale patch cannot reconcile over a manual edit', () => {
    let s = createDocState(fresh());
    s = ok(execute(s, headline('Manual headline')));
    const file = roundTrip(s);
    file.revisions.find((r) => r.revision === 2)!.touched = [];
    const opened = ok(loadDoc(file));
    const stale = patchOf(fixture, [{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }], [headline('Stale AI overwrites manual')]);
    const r = applyPatch(opened, stale, { reconcile: true });
    expect(r).toMatchObject({ ok: false, error: { code: 'STALE' } });
    expect(introText(opened.project)).toBe('Manual headline');
  });

  it('recomputed history still lets an untouched target reconcile after reopening', () => {
    let s = createDocState(fresh());
    s = ok(execute(s, { type: 'updateScene', sceneId: 'scn_outro', changes: { name: 'End' } }));
    const opened = ok(loadDoc(roundTrip(s)));
    expect(touchedSince(opened, 1)).toEqual([{ kind: 'scene', sceneId: 'scn_outro' }]);
    const r = ok(applyPatch(opened, patchOf(fixture, [{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }], [headline('Reconciled')]), { reconcile: true }));
    expect(introText(r.project)).toBe('Reconciled');
  });

  it('the first loaded record is a boundary: no reconcile across it', () => {
    let s = createDocState(fresh());
    for (let i = 0; i < 35; i++) s = ok(execute(s, { type: 'updateScene', sceneId: 'scn_outro', changes: { name: `End ${i}` } }));
    const opened = ok(loadDoc(roundTrip(s)));
    const first = opened.revisions[0].revision;
    expect(first).toBeGreaterThan(1);
    expect(touchedSince(opened, first - 1)).toBeNull();
    expect(touchedSince(opened, first)).not.toBeNull();
  });

  it('rejects history whose snapshot belongs to another project', () => {
    const file = roundTrip(createDocState(fresh()));
    file.project = { ...file.project, revision: 2 };
    file.revisions[0].snapshot = { ...fresh(), id: 'prj_unrelated' };
    const r = loadDoc(file);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'revisions[0].snapshot.id' } });
    if (!r.ok) expect(r.error.message).toContain('prj_unrelated');
  });

  it('rejects records whose revision does not match the snapshot, out-of-order or future revisions, and a mismatched current snapshot', () => {
    let s = createDocState(fresh());
    s = ok(execute(s, headline('A')));
    s = ok(execute(s, headline('B')));
    const base = roundTrip(s);

    const mismatch = structuredClone(base);
    mismatch.revisions[1].revision = 7;
    expect(loadDoc(mismatch)).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'revisions[1].snapshot.revision' } });

    const unordered = structuredClone(base);
    unordered.revisions = [unordered.revisions[1], unordered.revisions[0], unordered.revisions[2]];
    expect(loadDoc(unordered)).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'revisions[1].revision' } });

    const dup = structuredClone(base);
    dup.revisions = [dup.revisions[0], dup.revisions[1], dup.revisions[1], dup.revisions[2]];
    expect(loadDoc(dup)).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'revisions[2].revision' } });

    const future = structuredClone(base);
    future.revisions.push({ ...future.revisions[2], revision: 9, snapshot: { ...future.project, revision: 9 } });
    expect(loadDoc(future)).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'revisions[3].revision' } });

    const forgedCurrent = structuredClone(base);
    forgedCurrent.revisions[2].snapshot = { ...forgedCurrent.revisions[1].snapshot, revision: 3 };
    expect(loadDoc(forgedCurrent)).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'revisions[2].snapshot' } });

    expect(loadDoc(base).ok).toBe(true);
  });

  it('restoreRevision refuses a snapshot from a different project', () => {
    const s = createDocState(fresh());
    const forged: DocState = { ...s, project: { ...s.project, revision: 2 }, revisions: [{ ...s.revisions[0], snapshot: { ...fresh(), id: 'prj_unrelated' } }] };
    const r = restoreRevision(forged, 1);
    expect(r).toMatchObject({ ok: false, error: { code: 'PROJECT_MISMATCH' } });
  });
});
