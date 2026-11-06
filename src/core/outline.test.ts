import { describe, expect, it } from 'vitest';
import {
  addOutlineScene,
  buildScenesPrompt,
  buildSkeletonProject,
  directedBrief,
  directBuildPrompt,
  lengthVerdict,
  likelyLogo,
  moveOutlineScene,
  outlineRequestPrompt,
  outlineSeconds,
  paletteFromPixels,
  parseOutline,
  removeOutlineScene,
  stampStory,
  suggestedPackId,
  updateOutlineScene,
  type Outline,
  type VideoBrief,
} from './outline';
import { projectDurationInFrames } from './timing';
import { validateProject } from './validate';

const draft = {
  title: 'Relay in 30 seconds',
  scenes: [
    { name: 'Hook', purpose: 'Name the pain', durationSeconds: 4, onScreenText: 'Nobody reads release notes' },
    { name: 'Product', purpose: 'Show the brief', durationSeconds: 12.5, visuals: 'UI card builds in', templateHints: ['featureCallout'] },
    { name: 'Outro', purpose: 'Call to action', durationSeconds: 6, templateHints: [' logoOutro ', ''] },
  ],
};

const brief: VideoBrief = {
  brief: 'Launch video for Relay, release notes your team reads.',
  audience: 'Engineering managers',
  tone: 'Confident, warm',
  targetSeconds: 24,
  width: 1080,
  height: 1920,
  fps: 25,
  backgroundColor: '#0B0F1A',
  brandColors: ['#3B5BDB', '#F59E0B'],
  files: [
    { id: 'ast_logo1', kind: 'svg', name: 'relay.svg', src: 'assets/uploads/u_1.svg', mimeType: 'image/svg+xml', width: 480, height: 140 },
    { id: 'ast_song', kind: 'audio', name: 'song.mp3', src: 'assets/uploads/u_2.mp3', mimeType: 'audio/mpeg', durationSeconds: 40 },
  ],
  logoId: 'ast_logo1',
};

const ids = { project: 'prj_new', scene: (i: number) => `scn_${i}`, audioClip: () => 'aud_bed' };

function parsed(): Outline {
  const r = parseOutline(draft);
  if (!r.ok) throw new Error(r.message);
  return r.outline;
}

describe('outline', () => {
  it('validates an agent outline and gives scenes ids', () => {
    const outline = parsed();
    expect(outline.scenes.map((s) => s.id)).toEqual(['ol_1', 'ol_2', 'ol_3']);
    expect(outline.scenes[2].templateHints).toEqual(['logoOutro']);
    expect(outlineSeconds(outline)).toBe(22.5);
    expect(parseOutline({ title: 'x', scenes: [] })).toMatchObject({ ok: false, path: 'scenes' });
    expect(parseOutline({ title: 'x', scenes: [{ name: 'A', purpose: '', durationSeconds: 0 }] })).toMatchObject({ ok: false, path: 'scenes.0.durationSeconds' });
  });

  it('edits: rename, retime, reorder, delete, add', () => {
    let o = parsed();
    o = updateOutlineScene(o, 'ol_2', { name: 'The product', durationSeconds: 99, notes: 'Use the screenshot' });
    expect(o.scenes[1]).toMatchObject({ name: 'The product', durationSeconds: 60, notes: 'Use the screenshot' });
    o = moveOutlineScene(o, 'ol_3', 0);
    expect(o.scenes.map((s) => s.id)).toEqual(['ol_3', 'ol_1', 'ol_2']);
    o = removeOutlineScene(o, 'ol_1');
    const added = addOutlineScene(o, 0);
    expect(added.id).toBe('ol_4');
    expect(added.outline.scenes.map((s) => s.id)).toEqual(['ol_3', 'ol_4', 'ol_2']);
  });

  it('judges the total against the target', () => {
    expect(lengthVerdict(31, 30)).toMatchObject({ status: 'ok' });
    expect(lengthVerdict(40, 30)).toEqual({ status: 'long', text: '10 s over target' });
    expect(lengthVerdict(22.5, 30)).toEqual({ status: 'short', text: '7.5 s under target' });
  });

  it('becomes a valid skeleton project with the right durations', () => {
    const outline = parsed();
    const project = buildSkeletonProject(outline, brief, ids);
    const r = validateProject(project);
    expect(r.ok, r.ok ? '' : `${r.error.message} at ${r.error.path}`).toBe(true);
    expect(project).toMatchObject({ id: 'prj_new', name: 'Relay in 30 seconds', fps: 25, width: 1080, height: 1920, revision: 1 });
    expect(project.scenes.map((s) => [s.id, s.name, s.durationInFrames, s.elements.length])).toEqual([
      ['scn_0', 'Hook', 100, 0],
      ['scn_1', 'Product', 313, 0],
      ['scn_2', 'Outro', 150, 0],
    ]);
    expect(projectDurationInFrames(project)).toBe(563);
    expect(project.assets.ast_logo1.name).toBe('Logo (relay.svg)');
    expect(project.assets.ast_song.durationInFrames).toBe(1000);
    // The song becomes a music bed across the (shorter) video.
    expect(project.audio).toEqual([{ id: 'aud_bed', assetId: 'ast_song', name: 'Music bed', startFrame: 0, trimStartFrames: 0, durationInFrames: 563, volume: 0.6, fadeInFrames: 13, fadeOutFrames: 38 }]);
  });

  it('asks for an outline, then hands over the approved one with ids and scope', () => {
    const ask = outlineRequestPrompt(brief);
    expect(ask).toContain('editor_propose_outline');
    expect(ask).toContain('1080×1920 (9:16) at 25 fps');
    expect(ask).toContain('Target length: 24 s');
    expect(ask).toContain('Logo: "relay.svg" (svg)');
    expect(ask).toContain('featureCallout (feature callout)');
    expect(ask).toMatch(/do not edit, write or open any project/);
    expect(ask).toContain('GOAL:');
    expect(ask).toContain('STORY:');
    expect(ask).toContain('BANNED:');
    expect(ask).toContain('editor_critique');
    expect(ask).toContain('story: { idea, hook');
    expect(ask).toContain('Write the story beats first');

    const outline = updateOutlineScene(parsed(), 'ol_1', { notes: 'Make it punchy' });
    const project = buildSkeletonProject(outline, brief, ids);
    const build = buildScenesPrompt(outline, brief, project);
    expect(build).toContain('Build the approved outline scene by scene; use `editor_propose_patch` per scene');
    expect(build).toContain('"Hook" — scene scn_0, 4 s (100 frames)');
    expect(build).toContain('My notes: Make it punchy');
    expect(build).toContain('ast_logo1 "Logo (relay.svg)" (svg)');
    expect(build).toContain('Only change this project. Never open, write or edit any other project');
    expect(build).toContain('A music bed already plays');
    expect(build).toContain('editor_critique');
    expect(build).toContain('GOAL:');
    expect(build).toContain('STORY:');
    expect(build).toContain('story beats are already written');
    expect(build).toMatch(/^I approved the outline "Relay in 30 seconds"\. The editor filled the open project "Relay in 30 seconds" \(prj_new\) with 3 empty scenes at 1080×1920, 25 fps\./);
    expect(buildScenesPrompt(outline, brief, project, { created: true })).toContain('The editor created and opened the new project "Relay in 30 seconds" (prj_new): 3 empty scenes');
    expect(build).toContain('fix once → `editor_propose_patch`');
    expect(build).toContain('→ editor_critique → fix once → editor_propose_patch.');

    // Auto-apply on: every scene applied straight through, nothing waits for review.
    const through = buildScenesPrompt(outline, brief, project, { autoApply: true });
    expect(through).toMatch(/^I approved the outline "Relay in 30 seconds"\./);
    expect(through).toContain('Auto-apply is on: build every scene now, without stopping for review. Use `editor_apply_patch` per scene');
    expect(through).toContain('When every scene is built: `editor_render_contact_sheet`');
    expect(through).not.toContain('Propose one scene at a time');
    expect(through).toContain('fix once → `editor_apply_patch`');
    expect(through).toContain('→ editor_critique → fix once → editor_apply_patch.');
  });

  it('asks to build straight away in the open blank project when no outline comes first', () => {
    const build = directBuildPrompt(brief);
    expect(build).toMatch(/^Brief: Launch video for Relay/);
    expect(build).toContain('1080×1920 (9:16) at 25 fps');
    expect(build).toContain('Music: "song.mp3"');
    expect(build).toContain('Build this video now in the open project, which is blank and made for it (keep its id).');
    expect(build).toContain('`editor_write_project` using `overwrite: true`');
    expect(build).toContain('editor_critique');
    expect(build).toContain('Write `project.story` first');
    expect(build).not.toContain('editor_propose_outline');
  });

  it('fills a directed brief with pack numbers, not adjectives', () => {
    expect(suggestedPackId(brief)).toBe('snappy-saas');
    const block = directedBrief(brief).join('\n');
    expect(block).toMatch(/^Directed brief/);
    expect(block).toContain('pack `snappy-saas`');
    expect(block).toContain('#6C7BFF');
    expect(block).toContain('words ÷ 3.5 + 0.5 s');
    expect(block).toContain('this pack 3 f');
    expect(block).toContain('STORY: one idea');
    expect(block).toContain('ROUTE: product-launch');
    expect(block).toContain('story beats first, then motion');
    expect(block).toContain('absolute');
    expect(block).not.toContain('cinematic');
  });

  it('parses story beats and stamps them onto skeleton scene ids and frames', () => {
    const r = parseOutline({
      ...draft,
      story: {
        idea: 'Release notes people read.',
        hook: '47 changes, nobody looked.',
        audience: 'Engineering managers',
        tension: 'Standups ate Friday.',
        payoff: 'One brief, two minutes.',
        cta: 'Get early access',
        beats: [
          { role: 'hook', summary: 'Name the pain', sceneName: 'Hook', fromSeconds: 0, toSeconds: 4 },
          { role: 'setup', summary: 'Show the product', sceneName: 'Product' },
          { role: 'payoff', summary: 'Ask them in', sceneName: 'Outro' },
        ],
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.outline.story?.idea).toBe('Release notes people read.');
    const project = buildSkeletonProject(r.outline, brief, ids);
    expect(project.story?.beats.map((b) => [b.role, b.sceneId, b.fromFrame, b.toFrame])).toEqual([
      ['hook', 'scn_0', 0, 100],
      ['setup', 'scn_1', 100, 413],
      ['payoff', 'scn_2', 413, 563],
    ]);
    const unmapped = stampStory(
      { idea: 'x', hook: 'y', payoff: 'z', beats: [{ role: 'hook', summary: 'miss', sceneName: 'Nope' }] },
      project.scenes,
      brief.fps,
    );
    expect(unmapped?.beats[0]?.sceneId).toBeUndefined();
  });

  it('picks distinct brand colours from pixels', () => {
    const px = (r: number, g: number, b: number, a = 255, n = 1) => Array.from({ length: n }, () => [r, g, b, a]).flat();
    const data = [...px(59, 91, 219, 255, 50), ...px(60, 92, 220, 255, 10), ...px(245, 158, 11, 255, 20), ...px(255, 255, 255, 255, 30), ...px(0, 0, 0, 0, 200)];
    const palette = paletteFromPixels(data, 3);
    expect(palette[0]).toBe('#3B5BDB');
    expect(palette).toContain('#F59E0B');
    expect(palette).toHaveLength(3);
  });
});

describe('brand files', () => {
  const file = (id: string, name: string, kind: 'image' | 'svg' | 'audio') => ({ id, name, kind, src: `assets/uploads/${id}`, mimeType: 'x' });
  it('picks the likeliest logo', () => {
    expect(likelyLogo([file('a', 'screenshot.png', 'image'), file('b', 'mark.svg', 'svg')])).toBe('b');
    expect(likelyLogo([file('a', 'shot.svg', 'svg'), file('b', 'Acme-Logo.png', 'image')])).toBe('b');
    expect(likelyLogo([file('m', 'song.mp3', 'audio'), file('a', 'hero.png', 'image')])).toBe('a');
    expect(likelyLogo([file('m', 'song.mp3', 'audio')])).toBeUndefined();
  });
});
