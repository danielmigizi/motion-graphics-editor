import { describe, expect, it } from 'vitest';
import { COMPONENTS } from './components';
import {
  critiqueProject,
  formatCritique,
  isKeyLine,
  mergeBanned,
  SEEDED_BANNED_IDS,
  textLandedLocal,
  typeRole,
} from './critique';
import { pulseReference } from '../sample/golden/pulseReference';
import { fixtureProject } from './__fixtures__/fixtureProject';
import { GOLDEN_EXAMPLES } from '../sample/golden';
import { readingFrames } from './motionRules';
import { STYLE_PACKS } from './style';
import type { Element, Project, Scene, Transform } from './types';
import { validateProject } from './validate';

const FPS = 30;

function el(
  id: string,
  type: Element['type'],
  name: string,
  transform: Partial<Transform> & Pick<Transform, 'x' | 'y' | 'width' | 'height'>,
  props: Record<string, unknown>,
  timing: { startFrame: number; durationInFrames: number },
  tracks: Element['tracks'] = [],
): Element {
  return {
    id,
    type,
    name,
    startFrame: timing.startFrame,
    durationInFrames: timing.durationInFrames,
    visible: true,
    transform: { rotation: 0, scale: 1, opacity: 1, ...transform },
    props: { ...COMPONENTS[type].defaultProps, ...props },
    tracks,
  };
}

/** A 4 s scene that looks like a first-draft AI default: tiny type, short hold, glow orb, purple gradient, fade-slide, linear move, particles, dead hold. */
export function clicheProject(): Project {
  const fadeSlide = (y = 40): Element['tracks'] => [
    { property: 'opacity', keyframes: [{ frame: 0, value: 0, easing: 'easeOut' }, { frame: 12, value: 1, easing: 'linear' }] },
    { property: 'y', keyframes: [{ frame: 0, value: y, easing: 'linear' }, { frame: 12, value: 0, easing: 'linear' }] },
  ];
  return {
    schemaVersion: 3,
    id: 'prj_cliche',
    name: 'AI default',
    revision: 1,
    fps: FPS,
    width: 1920,
    height: 1080,
    backgroundColor: '#0B0F1A',
    style: STYLE_PACKS['snappy-saas'],
    scenes: [
      {
        id: 'scn_hook',
        name: 'Hook',
        durationInFrames: 4 * FPS,
        backgroundColor: '#0B0F1A',
        locked: false,
        transitionIn: { type: 'fade', durationInFrames: 12 },
        elements: [
          el('el_orb', 'shape', 'Glow orb', { x: 560, y: 140, width: 800, height: 800, opacity: 0.35 }, { shape: 'ellipse', fill: '#7C3AED' }, { startFrame: 0, durationInFrames: 120 }),
          el(
            'el_wash',
            'shape',
            'Purple wash',
            { x: 0, y: 0, width: 1920, height: 1080, opacity: 0.4 },
            { shape: 'rect', fill: { type: 'linear', angle: 135, stops: [{ offset: 0, color: '#4C1D95' }, { offset: 1, color: '#A78BFA' }] } },
            { startFrame: 0, durationInFrames: 120 },
          ),
          el('el_tiny', 'text', 'Caption', { x: 80, y: 80, width: 400, height: 40 }, { text: 'INTRODUCING RELAY TODAY', fontSize: 16, letterSpacing: 6, color: '#94A3B8' }, { startFrame: 0, durationInFrames: 24 }, fadeSlide(30)),
          el('el_line', 'text', 'Headline', { x: 80, y: 140, width: 600, height: 80 }, { text: 'Ship faster with fewer meetings on Tuesdays', fontSize: 28, color: '#E2E8F0', reveal: 'fadeUp', revealDurationInFrames: 10 }, { startFrame: 0, durationInFrames: 24 }, fadeSlide(40)),
          el('el_card', 'text', 'Subhead', { x: 80, y: 230, width: 500, height: 50 }, { text: 'Another line that also fades', fontSize: 22, color: '#E2E8F0' }, { startFrame: 0, durationInFrames: 24 }, fadeSlide(50)),
          ...Array.from({ length: 10 }, (_, i) =>
            el(`el_dot_${i}`, 'shape', `Dot ${i}`, { x: 100 + i * 40, y: 900, width: 12, height: 12 }, { shape: 'ellipse', fill: '#A78BFA' }, { startFrame: 0, durationInFrames: 120 }),
          ),
        ],
      },
      {
        id: 'scn_end',
        name: 'End',
        durationInFrames: 3 * FPS,
        backgroundColor: '#0B0F1A',
        locked: false,
        transitionIn: { type: 'fade', durationInFrames: 15 },
        elements: [
          el(
            'el_end',
            'text',
            'Thanks',
            { x: 200, y: 400, width: 1400, height: 120 },
            { text: 'Thanks', fontSize: 72, color: '#F8FAFC', reveal: 'none' },
            { startFrame: 0, durationInFrames: 90 },
            [{ property: 'x', keyframes: [{ frame: 0, value: 200, easing: 'linear' }, { frame: 20, value: 0, easing: 'linear' }] }],
          ),
        ],
      },
    ],
    assets: {},
    audio: [],
    compositions: {},
    markers: [],
  };
}

const rules = (report: ReturnType<typeof critiqueProject>) => report.findings.map((f) => f.rule);

describe('critique', () => {
  it('demo: catches real AI-default defects on a sample project, tied to frames', () => {
    const project = clicheProject();
    expect(validateProject(project).ok).toBe(true);
    const report = critiqueProject(project, {
      beats: { beats: [0, 15, 30, 45, 60, 75, 90, 105], downbeats: [0, 60], confidence: 0.8 },
    });
    const ids = rules(report);
    expect(ids).toEqual(expect.arrayContaining(['readingHold', 'typeMin', 'deadFrames', 'linearMove', 'banned:glow-orb', 'banned:purple-gradient', 'banned:particles', 'banned:fade-and-slide', 'banned:every-scene-fades', 'cutOffBeat']));
    expect(report.errors).toBeGreaterThan(0);
    const reading = report.findings.find((f) => f.rule === 'readingHold')!;
    expect(reading.severity).toBe('error');
    expect(reading.frame).toBeGreaterThanOrEqual(0);
    expect(reading.message).toMatch(/holds \d+ f/);
    expect(reading.fix).toMatch(/Lengthen/);
    const tiny = report.findings.find((f) => f.elementId === 'el_tiny' && f.rule === 'typeMin')!;
    expect(tiny.message).toMatch(/16 px/);
    const cut = report.findings.find((f) => f.rule === 'cutOffBeat')!;
    expect(cut.frame).toBe(120);
    expect(formatCritique(report)).toMatch(/\[error\] readingHold @ frame/);
  });

  it('skips empty skeleton scenes and reports a clean project as zero findings', () => {
    const blank: Project = {
      ...structuredClone(fixtureProject),
      scenes: [{ id: 'scn_empty', name: 'Empty', durationInFrames: 90, backgroundColor: '#000', locked: false, transitionIn: { type: 'none', durationInFrames: 0 }, elements: [] }],
    };
    const report = critiqueProject(blank);
    expect(report.findings).toEqual([]);
    expect(formatCritique(report)).toMatch(/No document-level defects/);
  });

  it('merges seeded banned ids with project.banned and extras', () => {
    expect(mergeBanned({})).toEqual([...SEEDED_BANNED_IDS]);
    expect(mergeBanned({ banned: ['neon-on-black'] }, ['neon-on-black', '  extra  '])).toEqual([...SEEDED_BANNED_IDS, 'neon-on-black', 'extra']);
  });

  it('classifies tracked caps vs body and measures when text has landed', () => {
    const kicker = el('k', 'text', 'Kicker', { x: 0, y: 0, width: 400, height: 40 }, { text: 'INTRODUCING', fontSize: 32, letterSpacing: 8 }, { startFrame: 0, durationInFrames: 90 });
    expect(typeRole(kicker)).toBe('trackedCaps');
    const body = el('b', 'text', 'Body', { x: 0, y: 0, width: 800, height: 80 }, { text: 'A sentence.', fontSize: 36, reveal: 'wordStagger', revealDurationInFrames: 24 }, { startFrame: 10, durationInFrames: 80 });
    expect(typeRole(body)).toBe('body');
    expect(textLandedLocal(body)).toBe(24);
  });

  it('flags a hold shorter than readingFrames and type below the floor', () => {
    const text = 'Your week of engineering changes summarised';
    const need = readingFrames(text, FPS);
    const p = structuredClone(fixtureProject);
    p.scenes = [
      {
        id: 'scn_one',
        name: 'One',
        durationInFrames: need,
        backgroundColor: '#0B0F1A',
        locked: false,
        transitionIn: { type: 'none', durationInFrames: 0 },
        elements: [
          el('el_short', 'text', 'Headline', { x: 200, y: 400, width: 1400, height: 120 }, { text, fontSize: 18, color: '#F8FAFC', reveal: 'none' }, { startFrame: 0, durationInFrames: 20 }),
        ],
      },
    ];
    const report = critiqueProject(p);
    expect(rules(report)).toEqual(expect.arrayContaining(['readingHold', 'typeMin']));
  });

  it('does not flag a cut on a downbeat, and skips a weak pulse', () => {
    const p = structuredClone(fixtureProject);
    const on = critiqueProject(p, { beats: { beats: [0, 210, 480], downbeats: [0, 210, 480], confidence: 0.9 } });
    expect(rules(on)).not.toContain('cutOffBeat');
    const weak = critiqueProject(p, { beats: { beats: [0, 17, 34], downbeats: [0, 34], confidence: 0.1 } });
    expect(rules(weak)).not.toContain('cutOffBeat');
  });

  it.each(GOLDEN_EXAMPLES.map((g) => [g.id, g.project] as const))('%s has no error-level critique findings', (_id, project) => {
    const report = critiqueProject(project);
    expect(report.findings.filter((f) => f.severity === 'error').map((f) => `${f.rule}: ${f.message}`)).toEqual([]);
  });

  it('treats Pulse pops and late cuts as in-style, and still errors on a short key line', () => {
    const project = pulseReference();
    const report = critiqueProject(project, {
      beats: { beats: [0, 30, 60, 90, 120, 150, 180, 210], downbeats: [0, 180], confidence: 0.9 },
    });
    expect(report.findings.filter((f) => f.rule === 'cutOffBeat')).toEqual([]);
    expect(report.findings.filter((f) => f.rule === 'heroSize')).toEqual([]);
    expect(report.findings.filter((f) => f.rule === 'seam:entry')).toEqual([]);
    expect(report.bar).toMatch(/Bar vs pulse/);
    expect(isKeyLine(el('w', 'text', 'Wordmark', { x: 0, y: 0, width: 400, height: 40 }, { text: 'Northline', fontSize: 42 }, { startFrame: 0, durationInFrames: 90 }))).toBe(true);
    expect(isKeyLine(el('p', 'text', 'Pill', { x: 0, y: 0, width: 200, height: 30 }, { text: 'Brand tokens', fontSize: 26 }, { startFrame: 0, durationInFrames: 90 }))).toBe(false);

    const short = structuredClone(project);
    const end = short.scenes[1]!;
    const line = end.elements.find((e) => e.name === 'Wordmark')!;
    line.durationInFrames = 8;
    const again = critiqueProject(short);
    expect(again.findings.some((f) => f.rule === 'readingHold' && f.elementId === line.id)).toBe(true);
  });

  it.each(GOLDEN_EXAMPLES.map((g) => [g.id, g.project] as const))('%s has no story-structure findings', (_id, project) => {
    const report = critiqueProject(project);
    expect(report.findings.filter((f) => f.rule.startsWith('story:')).map((f) => `${f.rule}: ${f.message}`)).toEqual([]);
  });

  it('demo: catches a weak-story project (logo open, no hook, too many ideas, dead middle, no payoff)', () => {
    const project = weakStoryProject();
    expect(validateProject(project).ok).toBe(true);
    const report = critiqueProject(project);
    const ids = rules(report);
    expect(ids).toEqual(
      expect.arrayContaining([
        'story:noHook',
        'story:logoOpen',
        'story:tooManyIdeas',
        'story:deadMiddle',
        'story:noPayoff',
        'story:unresolvedEnd',
        'story:unmappedScene',
        'story:missingRoles',
      ]),
    );
    expect(report.findings.filter((f) => f.rule.startsWith('story:')).every((f) => f.severity === 'warn')).toBe(true);
    const hook = report.findings.find((f) => f.rule === 'story:noHook')!;
    expect(hook.frame).toBe(0);
    expect(hook.sceneId).toBe('scn_open');
    expect(formatCritique(report)).toMatch(/\[warn\] story:noHook @ frame 0/);
  });

  it.each(GOLDEN_EXAMPLES.map((g) => [g.id, g.project] as const))('%s has no seam or lazy-default findings', (_id, project) => {
    const report = critiqueProject(project);
    expect(report.findings.filter((f) => f.rule.startsWith('seam:') || f.rule.startsWith('banned:gradient') || f.rule.startsWith('banned:cyan') || f.rule.startsWith('banned:pure') || f.rule.startsWith('banned:identical') || f.rule.startsWith('banned:edge') || f.rule.startsWith('banned:idle')).map((f) => `${f.rule}: ${f.message}`)).toEqual([]);
  });

  it('demo: flags settle-then-cut, axis flip, idle wobble, long entry, and lazy design defaults', () => {
    const project = lazyDoctrineProject();
    expect(validateProject(project).ok).toBe(true);
    const report = critiqueProject(project);
    const ids = rules(report);
    expect(ids).toEqual(
      expect.arrayContaining([
        'seam:axis',
        'seam:settle',
        'seam:entry',
        'banned:idle-wobble',
        'banned:cyan-neon',
        'banned:pure-black-white',
        'banned:identical-cards',
        'banned:edge-stripe',
        'seam:stillness',
      ]),
    );
    expect(report.findings.filter((f) => f.rule.startsWith('seam:') || f.rule.startsWith('banned:')).every((f) => f.severity === 'warn')).toBe(true);
    const axis = report.findings.find((f) => f.rule === 'seam:axis')!;
    expect(axis.frame).toBe(120);
    expect(axis.message).toMatch(/x out → y in/);
    expect(formatCritique(report)).toMatch(/\[warn\] seam:axis @ frame 120/);
  });

  it('does not flag a one-way hold push as idle wobble', () => {
    const p = structuredClone(fixtureProject);
    p.scenes = [
      {
        id: 'scn_push',
        name: 'Push',
        durationInFrames: 90,
        backgroundColor: '#0B0D17',
        locked: false,
        transitionIn: { type: 'none', durationInFrames: 0 },
        elements: [
          el(
            'el_hero',
            'text',
            'Headline',
            { x: 200, y: 400, width: 1400, height: 120 },
            { text: 'A claim that holds', fontSize: 72, color: '#F5F7FF', reveal: 'none' },
            { startFrame: 0, durationInFrames: 90 },
            [{ property: 'scale', keyframes: [{ frame: 12, value: 1, easing: 'easeInOut' }, { frame: 89, value: 1.04, easing: 'linear' }] }],
          ),
        ],
      },
    ];
    const report = critiqueProject(p);
    expect(rules(report)).not.toContain('banned:idle-wobble');
    expect(rules(report)).not.toContain('seam:entry');
  });

  it('does not run mapping checks without story.beats, and skips hook when the first scene is out of scope', () => {
    const project = weakStoryProject();
    const noStory = { ...project, story: undefined };
    const whole = critiqueProject(noStory);
    expect(rules(whole)).not.toEqual(expect.arrayContaining(['story:unmappedScene', 'story:missingRoles']));
    expect(rules(whole)).toEqual(expect.arrayContaining(['story:noHook', 'story:logoOpen']));
    const scoped = critiqueProject(project, { sceneIds: ['scn_mid_2'] });
    expect(rules(scoped)).toEqual(expect.arrayContaining(['story:unmappedScene']));
    expect(rules(scoped)).not.toEqual(expect.arrayContaining(['story:noHook', 'story:tooManyIdeas', 'story:noPayoff', 'story:deadMiddle']));
  });

  it('flags gradient text when the fill is a gradient paint', () => {
    const p = structuredClone(fixtureProject);
    p.scenes = [
      {
        id: 'scn_g',
        name: 'G',
        durationInFrames: 90,
        backgroundColor: '#0F0E0C',
        locked: false,
        transitionIn: { type: 'none', durationInFrames: 0 },
        elements: [
          el(
            'el_g',
            'text',
            'Gradient',
            { x: 120, y: 200, width: 1600, height: 100 },
            { text: 'Gradient headline here', fontSize: 64, color: { type: 'linear', angle: 90, stops: [{ offset: 0, color: '#00E5FF' }, { offset: 1, color: '#7C3AED' }] }, reveal: 'none' },
            { startFrame: 0, durationInFrames: 90 },
          ),
        ],
      },
    ];
    expect(rules(critiqueProject(p))).toContain('banned:gradient-text');
  });
});

/** 12 s, six 2 s scenes: logo-only open, glow middles, logo end, incomplete beats. */
export function weakStoryProject(): Project {
  const two = 2 * FPS;
  const glow = (id: string) =>
    el(id, 'shape', 'Glow', { x: 560, y: 140, width: 800, height: 800, opacity: 0.3 }, { shape: 'ellipse', fill: '#1E293B' }, { startFrame: 0, durationInFrames: two });
  const mark = (id: string) => el(id, 'logo', 'Logo', { x: 760, y: 470, width: 400, height: 140 }, { assetId: 'ast_logo' }, { startFrame: 0, durationInFrames: two });
  const emptyish = (id: string, name: string, extra: Element[]): Scene => ({
    id,
    name,
    durationInFrames: two,
    backgroundColor: '#0B0F1A',
    locked: false,
    transitionIn: { type: 'none', durationInFrames: 0 },
    elements: extra,
  });
  return {
    schemaVersion: 3,
    id: 'prj_weak_story',
    name: 'Logo sandwich',
    revision: 1,
    fps: FPS,
    width: 1920,
    height: 1080,
    backgroundColor: '#0B0F1A',
    style: STYLE_PACKS['snappy-saas'],
    story: {
      idea: 'Something about Relay, never stated on screen.',
      hook: 'We meant to have one.',
      payoff: 'Also never shown.',
      beats: [{ role: 'setup', summary: 'A glow, allegedly tension.', sceneName: 'Glow 1' }],
    },
    scenes: [
      emptyish('scn_open', 'Logo in', [mark('el_logo_in')]),
      emptyish('scn_mid_1', 'Glow 1', [glow('el_g1')]),
      emptyish('scn_mid_2', 'Glow 2', [glow('el_g2')]),
      emptyish('scn_mid_3', 'Glow 3', [glow('el_g3')]),
      emptyish('scn_mid_4', 'Glow 4', [glow('el_g4')]),
      emptyish('scn_end', 'Logo out', [mark('el_logo_out')]),
    ],
    assets: {
      ast_logo: { id: 'ast_logo', kind: 'svg', name: 'Relay logo', src: 'assets/logo.svg', mimeType: 'image/svg+xml', width: 480, height: 140 },
    },
    audio: [],
    compositions: {},
    markers: [],
  };
}

/** Axis flip, settle-then-cut, wobble, cyan neon, #000 plate, identical cards, stripe, long entry, no comma. */
export function lazyDoctrineProject(): Project {
  const four = 4 * FPS;
  const headline = (id: string, tracks: Element['tracks'], extra: Partial<Element['props']> = {}, start = 0, dur = four) =>
    el(id, 'text', 'Headline', { x: 200, y: 400, width: 1400, height: 140 }, { text: 'A readable claim on screen', fontSize: 72, color: '#F3EEE6', reveal: 'none', ...extra }, { startFrame: start, durationInFrames: dur }, tracks);
  return {
    schemaVersion: 3,
    id: 'prj_doctrine',
    name: 'Doctrine defects',
    revision: 1,
    fps: FPS,
    width: 1920,
    height: 1080,
    backgroundColor: '#0F0E0C',
    style: STYLE_PACKS['calm-premium'],
    scenes: [
      {
        id: 'scn_out',
        name: 'Out',
        durationInFrames: four,
        backgroundColor: '#0F0E0C',
        locked: false,
        transitionIn: { type: 'none', durationInFrames: 0 },
        elements: [
          headline('el_out', [{ property: 'x', keyframes: [{ frame: 96, value: 0, easing: 'easeIn' }, { frame: 119, value: 220, easing: 'linear' }] }]),
        ],
      },
      {
        id: 'scn_in',
        name: 'In',
        durationInFrames: four,
        backgroundColor: '#0F0E0C',
        locked: false,
        transitionIn: { type: 'none', durationInFrames: 0 },
        elements: [
          headline('el_in', [{ property: 'y', keyframes: [{ frame: 0, value: 200, easing: 'easeOut' }, { frame: 20, value: 0, easing: 'linear' }] }]),
          el(
            'el_slam',
            'shape',
            'Slam',
            { x: 200, y: 200, width: 400, height: 200 },
            { shape: 'rect', fill: '#1C1A17' },
            { startFrame: 0, durationInFrames: 40 },
            [{ property: 'x', keyframes: [{ frame: 0, value: 0, easing: 'easeIn' }, { frame: 20, value: 220, easing: 'linear' }] }],
          ),
          el(
            'el_result',
            'text',
            'Result',
            { x: 200, y: 560, width: 1400, height: 80 },
            { text: 'The payoff lands now', fontSize: 56, color: '#F3EEE6', reveal: 'none' },
            { startFrame: 20, durationInFrames: 100 },
          ),
        ],
      },
      {
        id: 'scn_still_a',
        name: 'Still A',
        durationInFrames: 90,
        backgroundColor: '#0F0E0C',
        locked: false,
        transitionIn: { type: 'none', durationInFrames: 0 },
        elements: [headline('el_still_a', [], {}, 0, 90)],
      },
      {
        id: 'scn_still_b',
        name: 'Still B',
        durationInFrames: 90,
        backgroundColor: '#0F0E0C',
        locked: false,
        transitionIn: { type: 'none', durationInFrames: 0 },
        elements: [headline('el_still_b', [], {}, 0, 90)],
      },
      {
        id: 'scn_lazy',
        name: 'Lazy',
        durationInFrames: four,
        backgroundColor: '#000000',
        locked: false,
        transitionIn: { type: 'none', durationInFrames: 0 },
        elements: [
          el(
            'el_long',
            'text',
            'Long entry',
            { x: 120, y: 80, width: 1600, height: 80 },
            { text: 'A slow single entrance', fontSize: 64, color: '#F3EEE6', reveal: 'none' },
            { startFrame: 0, durationInFrames: four },
            [{ property: 'x', keyframes: [{ frame: 0, value: 0, easing: 'easeOut' }, { frame: 40, value: 80, easing: 'linear' }] }],
          ),
          el('el_cyan', 'text', 'Neon', { x: 120, y: 180, width: 800, height: 50 }, { text: 'Neon line', fontSize: 36, color: '#00E5FF' }, { startFrame: 0, durationInFrames: four }),
          el(
            'el_wobble',
            'shape',
            'Breathe',
            { x: 1400, y: 80, width: 200, height: 200, opacity: 0.4 },
            { shape: 'ellipse', fill: '#D4B483' },
            { startFrame: 0, durationInFrames: four },
            [{ property: 'y', keyframes: [{ frame: 0, value: 0, easing: 'easeInOut' }, { frame: 20, value: 18, easing: 'easeInOut' }, { frame: 40, value: 0, easing: 'easeInOut' }, { frame: 60, value: 18, easing: 'easeInOut' }, { frame: 80, value: 0, easing: 'easeInOut' }] }],
          ),
          el('el_card_1', 'shape', 'Card 1', { x: 120, y: 400, width: 400, height: 280 }, { shape: 'rect', fill: '#1C1A17' }, { startFrame: 0, durationInFrames: four }),
          el('el_card_2', 'shape', 'Card 2', { x: 560, y: 400, width: 400, height: 280 }, { shape: 'rect', fill: '#1C1A17' }, { startFrame: 0, durationInFrames: four }),
          el('el_card_3', 'shape', 'Card 3', { x: 1000, y: 400, width: 400, height: 280 }, { shape: 'rect', fill: '#1C1A17' }, { startFrame: 0, durationInFrames: four }),
          el('el_stripe', 'shape', 'Stripe', { x: 120, y: 400, width: 10, height: 280 }, { shape: 'rect', fill: '#D4B483' }, { startFrame: 0, durationInFrames: four }),
        ],
      },
    ],
    assets: {},
    audio: [],
    compositions: {},
    markers: [],
  };
}
