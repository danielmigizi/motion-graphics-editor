import { describe, expect, it } from 'vitest';
import { fixtureProject } from './__fixtures__/fixtureProject';
import { element } from './__fixtures__/schema2Project';
import { applyCommand } from './commands';
import { COMPONENTS } from './components';
import { createDocState } from './history';
import { checkPatch, isSceneTarget, parsePatch } from './patch';
import { validateProject } from './validate';
import type { AiPatch, Project, StylePack } from './types';

const clone = (): Project => structuredClone(fixtureProject);

const style = (): StylePack => ({
  id: 'snappy-saas',
  name: 'Snappy SaaS',
  fonts: { heading: 'Space Grotesk', body: 'Inter', mono: 'IBM Plex Mono' },
  colors: { background: '#0B0F1A', surface: '#111827', text: '#F9FAFB', muted: '#94A3B8', accent: '#22C55E', accent2: 'rgb(59, 130, 246)' },
  motion: { id: 'snappy', timingScale: 0.8, staggerFrames: 3, overshoot: 0.04, enter: 'easeOutCubic', exit: { type: 'cubicBezier', x1: 0.4, y1: 0, x2: 1, y2: 1 } },
});

function expectInvalid(p: unknown, path: string, messagePart?: string) {
  const r = validateProject(p);
  expect(r.ok).toBe(false);
  if (r.ok) return;
  expect(r.error.code).toBe('INVALID');
  expect(r.error.path).toBe(path);
  if (messagePart) expect(r.error.message).toContain(messagePart);
}

describe('schema v3: style pack', () => {
  it('is optional and accepted when valid', () => {
    expect(validateProject(clone()).ok).toBe(true);
    const p = clone();
    p.style = style();
    expect(validateProject(p).ok).toBe(true);
  });

  it('validates colour roles as colours', () => {
    const p = clone();
    p.style = style();
    p.style.colors.accent = 'green-ish';
    expectInvalid(p, 'style.colors.accent', 'colour');
    p.style.colors.accent = '#22C55E';
    p.style.colors.accent2 = 'nope';
    expectInvalid(p, 'style.colors.accent2', 'colour');
  });

  it.each([
    ['timingScale', 0.4, 'between 0.5 and 2'],
    ['timingScale', 2.5, 'between 0.5 and 2'],
    ['staggerFrames', 13, 'between 0 and 12'],
    ['staggerFrames', 2.5, 'whole number'],
    ['staggerFrames', -1, 'between 0 and 12'],
    ['overshoot', 0.31, 'between 0 and 0.3'],
    ['overshoot', -0.01, 'between 0 and 0.3'],
  ] as const)('rejects motion.%s = %s', (key, value, message) => {
    const p = clone();
    p.style = style();
    (p.style.motion as unknown as Record<string, number>)[key] = value;
    expectInvalid(p, `style.motion.${key}`, message);
  });

  it('validates enter/exit easing', () => {
    const p = clone();
    p.style = style();
    p.style.motion.exit = { type: 'cubicBezier', x1: 1.5, y1: 0, x2: 1, y2: 1 };
    expectInvalid(p, 'style.motion.exit.x1');
    p.style.motion.exit = 'bouncy' as never;
    expect(validateProject(p).ok).toBe(false);
  });

  it('is a strict shape: fonts are strings, no unknown keys, known personality ids', () => {
    const p = clone();
    p.style = style();
    (p.style.fonts as unknown as Record<string, unknown>).heading = 700;
    expect(validateProject(p)).toMatchObject({ ok: false, error: { path: 'style.fonts.heading' } });
    p.style = { ...style(), extra: true } as never;
    expect(validateProject(p)).toMatchObject({ ok: false, error: { path: 'style.extra' } });
    p.style = style();
    p.style.motion.id = 'wobbly' as never;
    expect(validateProject(p)).toMatchObject({ ok: false, error: { path: 'style.motion.id' } });
  });
});

describe('schema v3: assets, video elements and audio envelopes', () => {
  const video = () => ({
    id: 'ast_clip',
    kind: 'video' as const,
    name: 'Clip',
    src: 'assets/uploads/u_clip.mp4',
    mimeType: 'video/mp4',
    width: 1920,
    height: 1080,
    durationInFrames: 120,
    fps: 30,
    hasAudio: true,
    proxySrc: 'assets/uploads/u_clip.proxy.mp4',
    provenance: { source: 'generated' as const, provider: 'fal', providerRefs: { requestId: 'req_1' }, model: 'm', prompt: 'p', seed: 42, requestId: 'req', cost: '1 credit', createdAt: 1 },
  });

  it('accepts video assets with optional metadata and reference flags', () => {
    const p = clone();
    p.assets.ast_clip = video();
    p.assets.ast_screenshot = { ...p.assets.ast_screenshot, reference: true, provenance: { source: 'upload' } };
    p.assets.ast_music = {
      ...p.assets.ast_music,
      provenance: {
        source: 'openverse',
        provider: 'openverse',
        license: { spdxOrCc: 'cc0', attribution: '"Bed" by Ada is licensed under CC0.', openverseId: '11111111-1111-4111-8111-111111111111' },
      },
    };
    expect(validateProject(p).ok).toBe(true);
  });

  it('applies the src path rules to proxySrc and rejects bad fps / provenance', () => {
    const p = clone();
    p.assets.ast_clip = { ...video(), proxySrc: '../outside.mp4' };
    expect(validateProject(p)).toMatchObject({ ok: false, error: { path: 'assets.ast_clip.proxySrc' } });
    p.assets.ast_clip = { ...video(), fps: 0 };
    expectInvalid(p, 'assets.ast_clip.fps');
    p.assets.ast_clip = { ...video(), provenance: { source: 'generated', vendor: 'x' } as never };
    expect(validateProject(p)).toMatchObject({ ok: false, error: { path: 'assets.ast_clip.provenance.vendor' } });
  });

  it('accepts a video element referencing a video asset, but not an image', () => {
    const p = clone();
    p.assets.ast_clip = video();
    const scene = p.scenes[0];
    scene.elements.push(element('el_video', 'video', { durationInFrames: Math.min(120, scene.durationInFrames), props: { ...COMPONENTS.video.defaultProps, assetId: 'ast_clip' } }));
    expect(validateProject(p).ok).toBe(true);
    scene.elements[scene.elements.length - 1].props.assetId = 'ast_screenshot';
    expectInvalid(p, `scenes[0].elements[${scene.elements.length - 1}].props.assetId`, 'video');
  });

  it('detachVideoAudio refuses elements that are not videos (see video.test.ts)', () => {
    const r = applyCommand(clone(), { type: 'detachVideoAudio', sceneId: 'scn_intro', elementId: 'el_intro_headline', clipId: 'clip_new' }, { source: 'user' });
    expect(r).toMatchObject({ ok: false, error: { code: 'INVALID', path: 'elementId' } });
  });

  it('validates volume envelopes: integer frames inside the clip, ascending, values 0..1', () => {
    const p = clone();
    const clip = p.audio[0];
    clip.volumeEnvelope = [{ frame: 0, value: 1 }, { frame: 10, value: 0.3 }, { frame: clip.durationInFrames, value: 0.3 }];
    expect(validateProject(p).ok).toBe(true);
    clip.volumeEnvelope = [{ frame: 0, value: 1.2 }];
    expectInvalid(p, 'audio[0].volumeEnvelope[0].value', 'between 0 and 1');
    clip.volumeEnvelope = [{ frame: 1.5, value: 1 }];
    expectInvalid(p, 'audio[0].volumeEnvelope[0].frame', 'whole number');
    clip.volumeEnvelope = [{ frame: clip.durationInFrames + 1, value: 1 }];
    expectInvalid(p, 'audio[0].volumeEnvelope[0].frame');
    clip.volumeEnvelope = [{ frame: 10, value: 1 }, { frame: 10, value: 0.5 }];
    expectInvalid(p, 'audio[0].volumeEnvelope[1].frame', 'sorted');
    clip.volumeEnvelope = [{ frame: 10, value: 1 }, { frame: 5, value: 0.5 }];
    expectInvalid(p, 'audio[0].volumeEnvelope[1].frame', 'sorted');
  });
});

describe('schema v3: patch targets', () => {
  const patch = (targets: AiPatch['targets']): AiPatch => ({
    protocol: 'mge.patch/1',
    projectId: 'prj_sample',
    baseRevision: fixtureProject.revision,
    summary: 'Headline',
    targets,
    commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { text: 'New' } } }],
  });

  it('parses an { audio: "project" } or { style: "project" } target but rejects other shapes', () => {
    expect(parsePatch(JSON.stringify(patch([{ audio: 'project' }]))).ok).toBe(true);
    expect(parsePatch(JSON.stringify(patch([{ style: 'project' }]))).ok).toBe(true);
    expect(parsePatch(JSON.stringify(patch([{ audio: 'scene' } as never]))).ok).toBe(false);
    expect(parsePatch(JSON.stringify(patch([{ sceneId: 'scn_intro', audio: 'project' } as never]))).ok).toBe(false);
    expect(parsePatch(JSON.stringify(patch([{ style: 'scene' } as never]))).ok).toBe(false);
  });

  it('isSceneTarget narrows scene/element targets', () => {
    expect(isSceneTarget({ sceneId: 's' })).toBe(true);
    expect(isSceneTarget({ sceneId: 's', elementId: 'e' })).toBe(true);
    expect(isSceneTarget({ audio: 'project' })).toBe(false);
  });

  it('an audio target covers project audio only: alone it does not reach elements; mixed with an element target it is fine', () => {
    const s = createDocState(fixtureProject);
    expect(checkPatch(s, patch([{ audio: 'project' }]))).toMatchObject({ ok: false, error: { code: 'OUT_OF_SCOPE', path: 'commands[0]' } });
    expect(checkPatch(s, patch([{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }, { audio: 'project' }])).ok).toBe(true);
    expect(checkPatch(s, patch([{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }])).ok).toBe(true);
  });
});
