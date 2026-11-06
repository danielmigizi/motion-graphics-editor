import { describe, expect, it } from 'vitest';
import { fixtureProject as sampleProject } from './__fixtures__/fixtureProject';
import { applyCommand } from './commands';
import { diffProjects } from './diff';
import { buildAgentPrompt } from './prompt';
import type { Command, EditRequest, Project } from './types';

function apply(p: Project, c: Command): Project {
  const r = applyCommand(p, c, { source: 'user' });
  if (!r.ok) throw new Error(r.error.message);
  return r.project;
}

describe('diffProjects', () => {
  it('identical projects → no entries; revision is ignored', () => {
    expect(diffProjects(sampleProject, sampleProject)).toEqual([]);
    expect(diffProjects(sampleProject, { ...sampleProject, revision: 9 })).toEqual([]);
  });

  it('scene move reports only the moved scene, by id', () => {
    const after = apply(sampleProject, { type: 'moveScene', sceneId: 'scn_outro', toIndex: 0 });
    const d = diffProjects(sampleProject, after);
    expect(d).toEqual([{ kind: 'scene', sceneId: 'scn_outro', label: 'Scene "Outro" › order', path: 'order', change: 'moved', before: 2, after: 0 }]);
  });

  it('field-level element changes: transform, tracks, timing, props', () => {
    let p = apply(sampleProject, { type: 'updateElement', sceneId: 'scn_product', elementId: 'el_product_card', changes: { startFrame: 30, transform: { x: 1000 }, props: { title: 'Brief' } } });
    p = apply(p, { type: 'setKeyframe', sceneId: 'scn_product', elementId: 'el_product_card', property: 'opacity', frame: 15, value: 0.8 });
    const d = diffProjects(sampleProject, p);
    expect(d.map((c) => c.path).sort()).toEqual(['props.title', 'startFrame', 'tracks.opacity', 'transform.x']);
    expect(d.find((c) => c.path === 'transform.x')).toMatchObject({ before: 1180, after: 1000, label: 'Scene "Product" › Weekly brief card › transform.x' });
  });

  it('added / removed scenes, elements, assets and audio', () => {
    let p = apply(sampleProject, { type: 'removeElement', sceneId: 'scn_intro', elementId: 'el_intro_sub' });
    p = apply(p, { type: 'addAsset', asset: { id: 'ast_new', kind: 'image', name: 'New', src: 'assets/n.png', mimeType: 'image/png' } });
    p = apply(p, { type: 'removeAudioClip', clipId: 'aud_whoosh' });
    p = apply(p, { type: 'addScene', scene: { id: 'scn_x', name: 'Extra', durationInFrames: 30, backgroundColor: '#000', locked: false, transitionIn: { type: 'none', durationInFrames: 0 }, elements: [] }, index: 0 });
    const d = diffProjects(sampleProject, p);
    expect(d.map((c) => `${c.kind}:${c.change}`).sort()).toEqual(['asset:added', 'audio:removed', 'element:removed', 'scene:added']);
  });
});

describe('buildAgentPrompt', () => {
  const requests: EditRequest[] = [
    { id: 'req_1', sceneId: 'scn_intro', elementId: 'el_intro_headline', instruction: 'Make the headline punchier and shorter.', frame: 45 },
    { id: 'req_2', sceneId: 'scn_product', instruction: 'Slow down the chat answer by half a second.', frame: 400 },
  ];

  it('includes project, scenes, frame context, schema and protocol', () => {
    const text = buildAgentPrompt(sampleProject, requests);
    expect(text).toContain('`prj_sample`');
    expect(text).toContain('Base revision: 1');
    expect(text).toContain('| 2 | `scn_product` | Product | 210 | 270 | no |');
    expect(text).toContain('global frame 45 (0:01:15), scene frame 45, element frame 25');
    expect(text).toContain('`fontSize` (integer 8..400)');
    expect(text).toContain('"protocol": "mge.patch/1"');
    expect(text).toContain('[{"sceneId":"scn_intro","elementId":"el_intro_headline"},{"sceneId":"scn_product"}]');
  });

  it('is deterministic and matches the snapshot', () => {
    const a = buildAgentPrompt(sampleProject, requests);
    expect(buildAgentPrompt(sampleProject, requests)).toBe(a);
    expect(a).toMatchSnapshot();
  });

  it('its worked example is itself a valid patch (parsePatch skips the non-JSON sketch)', async () => {
    const { parsePatch } = await import('./patch');
    const text = buildAgentPrompt(sampleProject, requests);
    // The whole prompt also contains a non-JSON ```ts sketch mentioning "protocol"; the valid JSON fence wins.
    const r = parsePatch(text);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.targets).toEqual([{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }]);
  });
});
