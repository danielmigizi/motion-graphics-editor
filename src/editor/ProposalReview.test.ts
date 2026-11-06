// Review sound: the pictures play silenced and the heard version's complete
// soundtrack (audio clips + video soundtracks, in groups and components) plays
// from a sound-only copy.

import { describe, expect, it } from 'vitest';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import type { Element, Project } from '../core/types';
import { createElement } from './doc';
import { silentProject, soundOnlyProject } from './ProposalReview';

/** The fixture plus a video asset played top level, inside a group, and inside a reusable component (via an instance). */
function withVideos(): Project {
  const p = structuredClone(fixtureProject) as Project;
  p.assets.ast_clip = { id: 'ast_clip', kind: 'video', name: 'clip.mp4', src: 'assets/uploads/u_clip.mp4', mimeType: 'video/mp4', durationInFrames: 300, hasAudio: true };
  const scene = p.scenes[0];
  const video = (id: string, extra: Partial<Element> = {}): Element => {
    const el = createElement(p, scene, 'video');
    return { ...el, id, ...extra, props: { ...el.props, assetId: 'ast_clip', ...extra.props } };
  };
  const group = { ...createElement(p, scene, 'group'), id: 'el_group' };
  const inst = createElement(p, scene, 'instance');
  scene.elements.push(
    video('el_top', { mask: { sourceId: 'el_intro_glow', mode: 'alpha' } as Element['mask'] }),
    group,
    video('el_in_group', { parentId: 'el_group' }),
    video('el_silent', { props: { muted: true } }),
    { ...inst, id: 'el_inst', props: { ...inst.props, compositionId: 'cmp_card' } },
  );
  p.compositions.cmp_card = { id: 'cmp_card', name: 'Card', width: 600, height: 400, durationInFrames: 60, backgroundColor: 'transparent', elements: [video('el_in_comp')] };
  return p;
}

const all = (p: Project) => [...p.scenes.flatMap((s) => s.elements), ...Object.values(p.compositions).flatMap((c) => c.elements)];
const byId = (p: Project, id: string) => all(p).find((e) => e.id === id);

describe('review soundtrack', () => {
  it('silences every sound of the pictures: audio clips and every video, nested or not', () => {
    const p = withVideos();
    const silent = silentProject(p);
    expect(silent.audio).toEqual([]);
    for (const id of ['el_top', 'el_in_group', 'el_silent', 'el_in_comp']) expect(byId(silent, id)!.props.muted).toBe(true);
    // Pictures unchanged otherwise.
    expect(byId(silent, 'el_intro_headline')).toEqual(byId(p, 'el_intro_headline'));
    expect(p.scenes[0].elements.find((e) => e.id === 'el_top')!.props.muted).toBe(false);
  });

  it('keeps everything that sounds, and the groups and instances that time it, in the sound-only copy', () => {
    const p = withVideos();
    const sound = soundOnlyProject(p);
    expect(sound.audio).toEqual(p.audio);
    expect(sound.scenes[0].elements.map((e) => e.id)).toEqual(['el_top', 'el_group', 'el_in_group', 'el_inst']);
    expect(sound.compositions.cmp_card.elements.map((e) => e.id)).toEqual(['el_in_comp']);
    expect(byId(sound, 'el_top')!.mask).toBeUndefined();
    // Timing is untouched, so the sound lands exactly where it plays in the video.
    expect(byId(sound, 'el_in_group')).toEqual(byId(p, 'el_in_group'));
    expect(sound.scenes.map((s) => s.durationInFrames)).toEqual(p.scenes.map((s) => s.durationInFrames));
  });
});
