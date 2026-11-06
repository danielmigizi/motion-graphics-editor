import { describe, expect, it } from 'vitest';
import { fixtureProject as sampleProject } from './__fixtures__/fixtureProject';
import { COMPONENTS } from './components';
import { applyCommand } from './commands';
import type { Command, CommandResult, Element, Project } from './types';

const user = { source: 'user' as const };
const ai = { source: 'ai' as const };

function ok(r: CommandResult): Extract<CommandResult, { ok: true }> {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message} @ ${r.error.path}`);
  return r;
}

function lockScene(p: Project, sceneId: string): Project {
  return ok(applyCommand(p, { type: 'setSceneLock', sceneId, locked: true }, user)).project;
}

const headlineUpdate = (text: string): Command => ({
  type: 'updateElement',
  sceneId: 'scn_intro',
  elementId: 'el_intro_headline',
  changes: { props: { text } },
});

describe('applyCommand — structural sharing', () => {
  it('updateElement locks an element for the editor and false clears it', () => {
    const lock = (locked: boolean): Command => ({ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { locked } });
    const headline = (p: Project) => p.scenes.find((s) => s.id === 'scn_intro')!.elements.find((e) => e.id === 'el_intro_headline')!;
    const locked = ok(applyCommand(sampleProject, lock(true), user)).project;
    expect(headline(locked).locked).toBe(true);
    expect('locked' in headline(ok(applyCommand(locked, lock(false), user)).project)).toBe(false);
  });

  it('updateElement keeps untouched scenes, elements, assets and audio by reference', () => {
    const r = ok(applyCommand(sampleProject, headlineUpdate('Hello'), user));
    const p = r.project;
    expect(p).not.toBe(sampleProject);
    expect(p.scenes[1]).toBe(sampleProject.scenes[1]);
    expect(p.scenes[2]).toBe(sampleProject.scenes[2]);
    expect(p.assets).toBe(sampleProject.assets);
    expect(p.audio).toBe(sampleProject.audio);
    sampleProject.scenes[0].elements.forEach((e, i) => {
      if (e.id === 'el_intro_headline') expect(p.scenes[0].elements[i]).not.toBe(e);
      else expect(p.scenes[0].elements[i]).toBe(e);
    });
    expect(p.scenes[0].elements[2].props.text).toBe('Hello');
    expect(sampleProject.scenes[0].elements[2].props.text).toBe('Updates your team actually reads');
    expect(r.touched).toEqual([{ kind: 'element', sceneId: 'scn_intro', elementId: 'el_intro_headline' }]);
  });

  it('moveScene preserves element IDs and element object identity', () => {
    const r = ok(applyCommand(sampleProject, { type: 'moveScene', sceneId: 'scn_outro', toIndex: 0 }, user));
    expect(r.project.scenes.map((s) => s.id)).toEqual(['scn_outro', 'scn_intro', 'scn_product']);
    for (const s of sampleProject.scenes) {
      const moved = r.project.scenes.find((x) => x.id === s.id)!;
      expect(moved).toBe(s);
      moved.elements.forEach((e, i) => expect(e).toBe(s.elements[i]));
    }
    expect(r.touched).toEqual([{ kind: 'project' }]);
  });
});

describe('applyCommand — every command', () => {
  it('updateProject', () => {
    const r = ok(applyCommand(sampleProject, { type: 'updateProject', changes: { name: 'Renamed' } }, user));
    expect(r.project.name).toBe('Renamed');
    expect(r.touched).toEqual([{ kind: 'project' }]);
  });

  it('addScene / removeScene', () => {
    const scene = { id: 'scn_new', name: 'New', durationInFrames: 60, backgroundColor: '#000000', locked: false, transitionIn: { type: 'none' as const, durationInFrames: 0 }, elements: [] };
    const r = ok(applyCommand(sampleProject, { type: 'addScene', scene, index: 1 }, user));
    expect(r.project.scenes.map((s) => s.id)).toEqual(['scn_intro', 'scn_new', 'scn_product', 'scn_outro']);
    const r2 = ok(applyCommand(r.project, { type: 'removeScene', sceneId: 'scn_new' }, user));
    expect(r2.project.scenes.map((s) => s.id)).toEqual(['scn_intro', 'scn_product', 'scn_outro']);
    // duplicate id is invalid
    expect(applyCommand(sampleProject, { type: 'addScene', scene: { ...scene, id: 'scn_intro' } }, user)).toMatchObject({ ok: false, error: { code: 'INVALID' } });
  });

  it('removeScene with anchored audio is refused unless the clip goes first in the batch', () => {
    expect(applyCommand(sampleProject, { type: 'removeScene', sceneId: 'scn_product' }, user)).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    const r = ok(
      applyCommand(
        sampleProject,
        { type: 'batch', label: 'rm', commands: [{ type: 'removeAudioClip', clipId: 'aud_whoosh' }, { type: 'removeScene', sceneId: 'scn_product' }] },
        user,
      ),
    );
    expect(r.project.scenes).toHaveLength(2);
  });

  it('updateScene, and refuses a duration that would cut off an element', () => {
    const r = ok(applyCommand(sampleProject, { type: 'updateScene', sceneId: 'scn_intro', changes: { name: 'Opening', transitionIn: { type: 'wipe' } } }, user));
    expect(r.project.scenes[0].name).toBe('Opening');
    expect(r.project.scenes[0].transitionIn).toEqual({ type: 'wipe', durationInFrames: 12 });
    const bad = applyCommand(sampleProject, { type: 'updateScene', sceneId: 'scn_intro', changes: { durationInFrames: 100 } }, user);
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    if (!bad.ok) expect(bad.error.hint).toMatch(/Shorten or move/);
  });

  it('addElement / moveElement / removeElement', () => {
    const element: Element = {
      id: 'el_new',
      type: 'shape',
      name: 'Box',
      startFrame: 0,
      durationInFrames: 30,
      visible: true,
      transform: { x: 0, y: 0, width: 100, height: 100, rotation: 0, scale: 1, opacity: 1 },
      props: { ...COMPONENTS.shape.defaultProps },
      tracks: [],
    };
    const a = ok(applyCommand(sampleProject, { type: 'addElement', sceneId: 'scn_outro', element, index: 0 }, user));
    expect(a.project.scenes[2].elements[0].id).toBe('el_new');
    const m = ok(applyCommand(a.project, { type: 'moveElement', sceneId: 'scn_outro', elementId: 'el_new', toIndex: 99 }, user));
    expect(m.project.scenes[2].elements.at(-1)!.id).toBe('el_new');
    const d = ok(applyCommand(m.project, { type: 'removeElement', sceneId: 'scn_outro', elementId: 'el_new' }, user));
    expect(d.project.scenes[2].elements.map((e) => e.id)).toEqual(sampleProject.scenes[2].elements.map((e) => e.id));
    // unknown prop on a new element is invalid
    const bad = applyCommand(sampleProject, { type: 'addElement', sceneId: 'scn_outro', element: { ...element, props: { ...element.props, sparkle: 1 } } }, user);
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'scenes[2].elements[3].props.sparkle' } });
  });

  it('setKeyframe inserts sorted / replaces; removeKeyframe removes and drops empty tracks', () => {
    const base = { sceneId: 'scn_intro', elementId: 'el_intro_headline' };
    const a = ok(applyCommand(sampleProject, { type: 'setKeyframe', ...base, property: 'x', frame: 30, value: 10 }, user));
    const b = ok(applyCommand(a.project, { type: 'setKeyframe', ...base, property: 'x', frame: 0, value: -50, easing: 'easeOut' }, user));
    const c = ok(applyCommand(b.project, { type: 'setKeyframe', ...base, property: 'x', frame: 30, value: 20 }, user));
    const track = c.project.scenes[0].elements[2].tracks.find((t) => t.property === 'x')!;
    expect(track.keyframes).toEqual([
      { frame: 0, value: -50, easing: 'easeOut' },
      { frame: 30, value: 20, easing: 'easeInOut' },
    ]);
    const d = ok(applyCommand(c.project, { type: 'removeKeyframe', ...base, property: 'x', frame: 0 }, user));
    const e = ok(applyCommand(d.project, { type: 'removeKeyframe', ...base, property: 'x', frame: 30 }, user));
    expect(e.project.scenes[0].elements[2].tracks).toEqual([]);
    expect(applyCommand(e.project, { type: 'removeKeyframe', ...base, property: 'x', frame: 30 }, user)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(applyCommand(sampleProject, { type: 'setKeyframe', ...base, property: 'x', frame: 1.5, value: 0 }, user)).toMatchObject({ ok: false, error: { code: 'INVALID' } });
  });

  it('addAsset / replaceAsset', () => {
    const asset = { id: 'ast_new', kind: 'image' as const, name: 'New', src: 'assets/new.png', mimeType: 'image/png' };
    const a = ok(applyCommand(sampleProject, { type: 'addAsset', asset }, user));
    expect(a.project.assets.ast_new).toEqual(asset);
    expect(applyCommand(a.project, { type: 'addAsset', asset }, user)).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    const r = ok(applyCommand(sampleProject, { type: 'replaceAsset', assetId: 'ast_logo', changes: { src: 'assets/uploads/logo2.svg' } }, user));
    expect(r.project.assets.ast_logo.src).toBe('assets/uploads/logo2.svg');
    expect(r.project.scenes).toBe(sampleProject.scenes);
    // changing the kind breaks the logo elements' reference rule
    expect(applyCommand(sampleProject, { type: 'replaceAsset', assetId: 'ast_logo', changes: { kind: 'image' } }, user)).toMatchObject({ ok: false, error: { code: 'INVALID' } });
  });

  it('audio clip commands', () => {
    const clip = { id: 'aud_new', assetId: 'ast_whoosh', name: 'Whoosh 2', sceneId: 'scn_outro', startFrame: 10, trimStartFrames: 0, durationInFrames: 20, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 };
    const a = ok(applyCommand(sampleProject, { type: 'addAudioClip', clip }, user));
    const u = ok(applyCommand(a.project, { type: 'updateAudioClip', clipId: 'aud_new', changes: { volume: 0.5, sceneId: undefined } }, user));
    const updated = u.project.audio.find((c) => c.id === 'aud_new')!;
    expect(updated.volume).toBe(0.5);
    expect('sceneId' in updated).toBe(false);
    expect(applyCommand(a.project, { type: 'updateAudioClip', clipId: 'aud_new', changes: { volume: 2 } }, user)).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'audio[2].volume' } });
    const d = ok(applyCommand(u.project, { type: 'removeAudioClip', clipId: 'aud_new' }, user));
    expect(d.project.audio.map((c) => c.id)).toEqual(['aud_music', 'aud_whoosh']);
  });

  it('rejects malformed commands at the shape level', () => {
    const r = applyCommand(sampleProject, { type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { transform: { x: 'left' } } } as unknown as Command, user);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'changes.transform.x' } });
    expect(applyCommand(sampleProject, { type: 'nope' } as unknown as Command, user)).toMatchObject({ ok: false, error: { code: 'INVALID' } });
  });

  it('invalid prop → INVALID with project path and unchanged input', () => {
    const r = applyCommand(sampleProject, { type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 900 } } }, user);
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'scenes[0].elements[2].props.fontSize' } });
    if (!r.ok) expect(r.error.message).toBe('fontSize must be between 8 and 400; got 900');
    expect(sampleProject.scenes[0].elements[2].props.fontSize).toBe(104);
  });

  it('unknown ids → NOT_FOUND', () => {
    expect(applyCommand(sampleProject, { type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_x', changes: {} }, user)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(applyCommand(sampleProject, { type: 'moveScene', sceneId: 'scn_x', toIndex: 0 }, user)).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

describe('applyCommand — batch atomicity', () => {
  it('one bad sub-command leaves the project unchanged and returns no partial result', () => {
    const snapshot = structuredClone(sampleProject);
    const r = applyCommand(
      sampleProject,
      {
        type: 'batch',
        label: 'Mixed',
        commands: [headlineUpdate('First'), { type: 'updateElement', sceneId: 'scn_product', elementId: 'el_product_headline', changes: { props: { fontSize: -1 } } }],
      },
      user,
    );
    expect(r.ok).toBe(false);
    expect('project' in r).toBe(false);
    expect(sampleProject).toEqual(snapshot);
  });

  it('error paths name the failing sub-command; touched is the union; nested batches work', () => {
    const bad = applyCommand(sampleProject, { type: 'batch', label: 'x', commands: [headlineUpdate('a'), { type: 'removeElement', sceneId: 'scn_intro', elementId: 'nope' }] }, user);
    expect(bad).toMatchObject({ ok: false, error: { code: 'NOT_FOUND', path: 'commands[1]' } });
    const r = ok(
      applyCommand(
        sampleProject,
        {
          type: 'batch',
          label: 'Two',
          commands: [
            headlineUpdate('a'),
            { type: 'batch', label: 'inner', commands: [headlineUpdate('b'), { type: 'updateScene', sceneId: 'scn_outro', changes: { name: 'End' } }] },
          ],
        },
        user,
      ),
    );
    expect(r.touched).toEqual([
      { kind: 'element', sceneId: 'scn_intro', elementId: 'el_intro_headline' },
      { kind: 'scene', sceneId: 'scn_outro' },
    ]);
    expect(r.project.scenes[0].elements[2].props.text).toBe('b');
  });

  it('only the final batch state is validated (shorten element then scene)', () => {
    const r = ok(
      applyCommand(
        sampleProject,
        {
          type: 'batch',
          label: 'Shorten',
          commands: [
            { type: 'updateElement', sceneId: 'scn_outro', elementId: 'el_outro_logo', changes: { durationInFrames: 200 } },
            { type: 'updateElement', sceneId: 'scn_outro', elementId: 'el_outro_headline', changes: { durationInFrames: 170 } },
            { type: 'updateElement', sceneId: 'scn_outro', elementId: 'el_outro_url', changes: { durationInFrames: 140 } },
            { type: 'updateScene', sceneId: 'scn_outro', changes: { durationInFrames: 200 } },
          ],
        },
        user,
      ),
    );
    expect(r.project.scenes[2].durationInFrames).toBe(200);
  });
});

describe('applyCommand — scene locks', () => {
  const locked = lockScene(sampleProject, 'scn_intro');

  it('user update on a locked scene → LOCKED naming the scene; unlock → works', () => {
    const r = applyCommand(locked, headlineUpdate('x'), user);
    expect(r).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    if (!r.ok) {
      expect(r.error.message).toContain('"Intro"');
      expect(r.error.message).toMatch(/[Uu]nlock it first/);
    }
    const unlocked = ok(applyCommand(locked, { type: 'setSceneLock', sceneId: 'scn_intro', locked: false }, user)).project;
    expect(ok(applyCommand(unlocked, headlineUpdate('x'), user)).project.scenes[0].elements[2].props.text).toBe('x');
  });

  it('AI may never change locks', () => {
    expect(applyCommand(sampleProject, { type: 'setSceneLock', sceneId: 'scn_intro', locked: true }, ai)).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    expect(applyCommand(locked, { type: 'setSceneLock', sceneId: 'scn_intro', locked: false }, ai)).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
  });

  it('every kind of scene-content change is refused on a locked scene', () => {
    const cmds: Command[] = [
      { type: 'updateScene', sceneId: 'scn_intro', changes: { name: 'n' } },
      { type: 'removeScene', sceneId: 'scn_intro' },
      { type: 'removeElement', sceneId: 'scn_intro', elementId: 'el_intro_sub' },
      { type: 'moveElement', sceneId: 'scn_intro', elementId: 'el_intro_sub', toIndex: 0 },
      { type: 'setKeyframe', sceneId: 'scn_intro', elementId: 'el_intro_sub', property: 'x', frame: 0, value: 1 },
      { type: 'removeKeyframe', sceneId: 'scn_intro', elementId: 'el_intro_logo', property: 'y', frame: 0 },
    ];
    for (const c of cmds) expect(applyCommand(locked, c, user)).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
    const lockedProduct = lockScene(sampleProject, 'scn_product');
    expect(applyCommand(lockedProduct, { type: 'updateAudioClip', clipId: 'aud_whoosh', changes: { volume: 0.1 } }, user)).toMatchObject({
      ok: false,
      error: { code: 'LOCKED' },
    });
    // project-level and asset commands are allowed
    expect(applyCommand(locked, { type: 'updateProject', changes: { name: 'ok' } }, user).ok).toBe(true);
    expect(applyCommand(locked, { type: 'replaceAsset', assetId: 'ast_logo', changes: { name: 'Logo v2' } }, user).ok).toBe(true);
  });

  it('moveScene of a locked scene: user allowed, AI refused', () => {
    expect(applyCommand(locked, { type: 'moveScene', sceneId: 'scn_intro', toIndex: 2 }, user).ok).toBe(true);
    expect(applyCommand(locked, { type: 'moveScene', sceneId: 'scn_intro', toIndex: 2 }, ai)).toMatchObject({ ok: false, error: { code: 'LOCKED' } });
  });
});
