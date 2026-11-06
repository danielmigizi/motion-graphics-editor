import { describe, expect, it } from 'vitest';
import { sampleProject } from '../sample/sampleProject';
import { isValidColor, validateProject } from './validate';
import type { Project } from './types';

const clone = (): Project => structuredClone(sampleProject);

function expectInvalid(p: unknown, path: string, messagePart?: string) {
  const r = validateProject(p);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.code).toBe('INVALID');
  expect(r.error.path).toBe(path);
  if (messagePart) expect(r.error.message).toContain(messagePart);
}

describe('validateProject', () => {
  it('accepts the sample project and returns the same object', () => {
    const r = validateProject(sampleProject);
    expect(r).toEqual({ ok: true, value: sampleProject });
    if (r.ok) expect(r.value).toBe(sampleProject);
  });

  it('rejects out-of-range props with a precise path and actionable message', () => {
    const p = clone();
    p.scenes[1].elements[0].props.fontSize = 900;
    expectInvalid(p, 'scenes[1].elements[0].props.fontSize', 'fontSize must be between 8 and 400; got 900');
  });

  it('rejects unknown prop keys, bad colours, bad selects and non-integer sizes', () => {
    let p = clone();
    p.scenes[0].elements[2].props.glow = true;
    expectInvalid(p, 'scenes[0].elements[2].props.glow', 'not a property');
    p = clone();
    p.scenes[0].elements[2].props.color = 'red';
    expectInvalid(p, 'scenes[0].elements[2].props.color', 'hex colour');
    p = clone();
    p.scenes[0].elements[2].props.align = 'justify';
    expectInvalid(p, 'scenes[0].elements[2].props.align', 'must be one of');
    p = clone();
    p.scenes[0].elements[2].props.fontSize = 50.5;
    expectInvalid(p, 'scenes[0].elements[2].props.fontSize', 'whole number');
    p = clone();
    delete p.scenes[0].elements[2].props.text;
    expectInvalid(p, 'scenes[0].elements[2].props.text', 'required');
  });

  it('checks asset references and kinds', () => {
    let p = clone();
    p.scenes[0].elements[1].props.assetId = 'ast_missing';
    expectInvalid(p, 'scenes[0].elements[1].props.assetId', 'unknown asset');
    p = clone();
    p.scenes[0].elements[1].props.assetId = 'ast_screenshot'; // logo requires svg
    expectInvalid(p, 'scenes[0].elements[1].props.assetId', 'svg');
    p = clone();
    p.scenes[0].elements[1].props.assetId = '';
    expectInvalid(p, 'scenes[0].elements[1].props.assetId');
    p = clone();
    p.audio[0].assetId = 'ast_logo';
    expectInvalid(p, 'audio[0].assetId', 'audio asset');
    p = clone();
    p.audio[1].sceneId = 'scn_nope';
    expectInvalid(p, 'audio[1].sceneId');
  });

  it('enforces timing, keyframe and transform rules', () => {
    let p = clone();
    p.scenes[0].elements[2].durationInFrames = 500;
    expectInvalid(p, 'scenes[0].elements[2].durationInFrames', 'only 210 frames');
    p = clone();
    p.scenes[0].elements[2].startFrame = 2.5;
    expectInvalid(p, 'scenes[0].elements[2].startFrame', 'whole number');
    p = clone();
    p.scenes[0].durationInFrames = 0;
    expectInvalid(p, 'scenes[0].durationInFrames');
    p = clone();
    p.scenes[0].elements[1].tracks[0].keyframes.reverse();
    expectInvalid(p, 'scenes[0].elements[1].tracks[0].keyframes[1].frame', 'sorted');
    p = clone();
    p.scenes[0].elements[1].tracks[0].keyframes[1].frame = 0;
    expectInvalid(p, 'scenes[0].elements[1].tracks[0].keyframes[1].frame', 'unique');
    p = clone();
    p.scenes[0].elements[1].transform.opacity = 1.5;
    expectInvalid(p, 'scenes[0].elements[1].transform.opacity');
    p = clone();
    p.scenes[0].elements[1].transform.scale = 0;
    expectInvalid(p, 'scenes[0].elements[1].transform.scale');
    p = clone();
    p.fps = 30.5;
    expectInvalid(p, 'fps');
    p = clone();
    p.fps = 240;
    expectInvalid(p, 'fps', 'between 1 and 120');
  });

  it('rejects duplicate IDs across the project', () => {
    const p = clone();
    p.scenes[1].elements[0].id = 'el_intro_headline';
    expectInvalid(p, 'scenes[1].elements[0].id', 'more than once');
  });

  it('reports shape errors with paths', () => {
    const p = clone() as unknown as { scenes: { elements: { transform: { x: unknown } }[] }[] };
    p.scenes[2].elements[0].transform.x = 'left';
    expectInvalid(p, 'scenes[2].elements[0].transform.x');
    expect(validateProject(null).ok).toBe(false);
  });

  it('colour helper', () => {
    expect(isValidColor('#fff')).toBe(true);
    expect(isValidColor('#11223344')).toBe(true);
    expect(isValidColor('#12345')).toBe(false);
    expect(isValidColor('none')).toBe(false);
    expect(isValidColor('none', true)).toBe(true);
  });

  it('accepts a short banned list and rejects empty or oversized items', () => {
    const p = clone();
    p.banned = ['neon-on-black'];
    expect(validateProject(p).ok).toBe(true);
    p.banned = [''];
    expectInvalid(p, 'banned[0]');
    p.banned = ['x'.repeat(81)];
    expectInvalid(p, 'banned[0]', 'at most 80');
  });

  it('accepts a story layer and rejects empty idea or an oversized beat', () => {
    const p = clone();
    p.story = {
      idea: 'One brief.',
      hook: 'Nobody reads the notes.',
      payoff: 'They do now.',
      beats: [{ role: 'hook', summary: 'Pain', sceneName: 'Hook' }],
    };
    expect(validateProject(p).ok).toBe(true);
    p.story = { ...p.story, idea: '  ' };
    expectInvalid(p, 'story.idea', 'non-empty');
    p.story = {
      idea: 'One brief.',
      hook: 'Nobody reads the notes.',
      payoff: 'They do now.',
      beats: [{ role: 'hook', summary: 'x'.repeat(401) }],
    };
    expectInvalid(p, 'story.beats[0].summary', 'at most 400');
  });
});

describe('asset src paths', () => {
  it('rejects traversal and encoded paths, accepts plain asset paths', async () => {
    const { validateProject } = await import('./validate');
    const { fixtureProject } = await import('./__fixtures__/fixtureProject');
    const withSrc = (src: string) => ({ ...fixtureProject, assets: { ...fixtureProject.assets, ast_logo: { ...fixtureProject.assets.ast_logo, src } } });
    expect(validateProject(withSrc('assets/uploads/u_ab12.svg')).ok).toBe(true);
    for (const bad of ['assets/%2e%2e/%2e%2e/projects/x.json', 'assets/../projects/x.json', '/etc/passwd', 'projects/prj.json']) {
      const r = validateProject(withSrc(bad));
      expect(r.ok, bad).toBe(false);
    }
  });
});
