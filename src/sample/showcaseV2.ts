// Schema v2 render showcase: 9.6 s at 30 fps, three scenes, no assets.
// Exercises every v2 render feature once: blur-in / per-character / line /
// scale-in text reveals, a gradient path drawn on with an animated trim, a
// rotating group with children, one composition instanced twice with
// different time offsets, a moving elliptical alpha matte, a multiply blend,
// and the zoom / blur scene transitions. Rendered to stills by
// scripts/render-showcase.ts.

import { COMPONENTS } from '../core/components';
import type { AnimationTrack, Element, ElementType, NestedComposition, Project, PropertyTrack, Transform } from '../core/types';

type Box = Partial<Transform> & Pick<Transform, 'x' | 'y' | 'width' | 'height'>;

function el(
  id: string,
  type: ElementType,
  box: Box,
  props: Record<string, unknown>,
  extra: Partial<Element> & { startFrame?: number; durationInFrames: number },
): Element {
  return {
    id,
    type,
    name: id.replace(/^el_/, '').replace(/_/g, ' '),
    startFrame: 0,
    visible: true,
    transform: { rotation: 0, scale: 1, opacity: 1, ...box },
    props: { ...COMPONENTS[type].defaultProps, ...props },
    tracks: [],
    ...extra,
  };
}

const track = (property: AnimationTrack['property'], keys: [number, number][], easing: AnimationTrack['keyframes'][number]['easing'] = 'linear'): AnimationTrack => ({
  property,
  keyframes: keys.map(([frame, value]) => ({ frame, value, easing })),
});

const propTrack = (key: string, keys: [number, number][], easing: PropertyTrack['keyframes'][number]['easing'] = 'linear'): PropertyTrack => ({
  key,
  keyframes: keys.map(([frame, value]) => ({ frame, value, easing })),
});

const C = {
  canvas: '#07080D',
  ink: '#0B0D14',
  night: '#0E1020',
  paper: '#F3EFE6',
  text: '#F5F1E8',
  textDark: '#151622',
  muted: '#A3A6B4',
  mutedDark: '#6B6A73',
  amber: '#F5A524',
  coral: '#F0605D',
  violet: '#8B5CF6',
  indigo: '#3730A3',
  teal: '#2DD4BF',
};

const display = { fontFamily: 'Fraunces', fontWeight: 600, letterSpacing: 0, lineHeight: 1.05 };
const mono = { fontFamily: 'IBM Plex Mono', fontWeight: 500, fontSize: 22, letterSpacing: 3, reveal: 'none' };

// Scene 1 — Draw ------------------------------------------------------------

const drawScene: Element[] = [
  el('el_kicker', 'text', { x: 160, y: 262, width: 1000, height: 40 }, { ...mono, text: 'SCHEMA V2 · RENDER SHOWCASE', color: C.amber, reveal: 'charStagger', revealDurationInFrames: 8, revealStagger: 1, revealOrder: 'forward', revealEasing: 'linear' }, { durationInFrames: 96 }),
  el(
    'el_headline',
    'text',
    { x: 160, y: 330, width: 1600, height: 150 },
    { ...display, text: 'Motion, drawn by hand.', fontSize: 120, color: C.text, reveal: 'blurIn', revealDurationInFrames: 16, revealStagger: 2, revealOrder: 'forward', revealEasing: 'easeOutCubic' },
    { startFrame: 4, durationInFrames: 92 },
  ),
  el(
    'el_swash',
    'path',
    { x: 164, y: 482, width: 1180, height: 120 },
    {
      nodes: [
        { x: 8, y: 84, out: { x: 300, y: 20 } },
        { x: 620, y: 62, in: { x: 420, y: 112 }, out: { x: 820, y: 12 } },
        { x: 1172, y: 36, in: { x: 980, y: 92 } },
      ],
      closed: false,
      fill: 'none',
      stroke: { type: 'linear', angle: 90, stops: [{ offset: 0, color: C.amber }, { offset: 0.55, color: C.coral }, { offset: 1, color: C.violet }] },
      strokeWidth: 12,
      lineCap: 'round',
      lineJoin: 'round',
      trimStart: 0,
      trimEnd: 0,
      trimOffset: 0,
    },
    { startFrame: 20, durationInFrames: 76, propTracks: [propTrack('props.trimEnd', [[0, 0], [36, 1]], 'easeInOutCubic')] },
  ),
  el(
    'el_sub',
    'text',
    { x: 160, y: 650, width: 1300, height: 120 },
    {
      text: 'Groups, instances, paths, mattes and blend modes —\nrendered from one document, frame for frame.',
      fontFamily: 'Inter',
      fontWeight: 500,
      fontSize: 40,
      color: C.muted,
      lineHeight: 1.35,
      reveal: 'lineStagger',
      revealDurationInFrames: 18,
      revealStagger: 8,
      revealOrder: 'forward',
      revealEasing: 'easeOutCubic',
    },
    { startFrame: 40, durationInFrames: 56 },
  ),
];

// Scene 2 — Structure ---------------------------------------------------------

const pulse: NestedComposition = {
  id: 'cmp_pulse',
  name: 'Pulse',
  width: 300,
  height: 300,
  durationInFrames: 60,
  backgroundColor: 'transparent',
  elements: [
    el('el_pulse_ring', 'shape', { x: 30, y: 30, width: 240, height: 240 }, { shape: 'ellipse', fill: 'none', stroke: C.teal, strokeWidth: 6 }, {
      durationInFrames: 60,
      tracks: [track('scale', [[0, 0.3], [60, 1]], 'easeOutCubic'), track('opacity', [[0, 1], [60, 0]])],
    }),
    el('el_pulse_core', 'shape', { x: 105, y: 105, width: 90, height: 90 }, { shape: 'ellipse', fill: C.teal, stroke: 'none', strokeWidth: 0 }, {
      durationInFrames: 60,
      tracks: [track('scale', [[0, 1.15], [30, 0.9], [59, 1.15]], 'easeInOutCubic')],
    }),
  ],
};

const structureScene: Element[] = [
  el(
    'el_title_structure',
    'text',
    { x: 160, y: 110, width: 1200, height: 110 },
    { ...display, text: 'Groups & instances', fontSize: 88, color: C.text, reveal: 'scaleIn', revealDurationInFrames: 14, revealStagger: 2, revealOrder: 'edges', revealEasing: 'backOut' },
    { durationInFrames: 96 },
  ),
  el('el_orbit', 'group', { x: 710, y: 300, width: 500, height: 500 }, { clip: false }, {
    durationInFrames: 96,
    tracks: [track('rotation', [[0, 0], [96, 120]])],
  }),
  el('el_orbit_ring', 'shape', { x: 40, y: 40, width: 420, height: 420 }, { shape: 'ellipse', fill: 'none', stroke: '#FFFFFF2E', strokeWidth: 2 }, {
    parentId: 'el_orbit',
    durationInFrames: 96,
  }),
  el(
    'el_orbit_tile',
    'shape',
    { x: 150, y: 150, width: 200, height: 200 },
    { shape: 'rect', fill: { type: 'radial', stops: [{ offset: 0, color: '#A78BFA' }, { offset: 1, color: C.indigo }] }, stroke: 'none', strokeWidth: 0, cornerRadius: 44 },
    { parentId: 'el_orbit', durationInFrames: 96, tracks: [track('rotation', [[0, 0], [96, -240]])] },
  ),
  el('el_orbit_moon', 'shape', { x: 420, y: 210, width: 80, height: 80 }, { shape: 'ellipse', fill: C.amber, stroke: 'none', strokeWidth: 0 }, {
    parentId: 'el_orbit',
    durationInFrames: 96,
  }),
  el('el_pulse_a', 'instance', { x: 200, y: 400, width: 300, height: 300 }, { compositionId: 'cmp_pulse', timeOffset: 0, loop: true }, { durationInFrames: 96 }),
  el('el_pulse_b', 'instance', { x: 1420, y: 400, width: 300, height: 300 }, { compositionId: 'cmp_pulse', timeOffset: 30, loop: true }, { durationInFrames: 96 }),
  el('el_caption_a', 'text', { x: 150, y: 740, width: 400, height: 36 }, { ...mono, text: 'timeOffset 0', color: C.muted, align: 'center' }, { durationInFrames: 96 }),
  el('el_caption_b', 'text', { x: 1370, y: 740, width: 400, height: 36 }, { ...mono, text: 'timeOffset 30', color: C.muted, align: 'center' }, { durationInFrames: 96 }),
];

// Scene 3 — Matte & blend -----------------------------------------------------

const matteScene: Element[] = [
  el(
    'el_title_matte',
    'text',
    { x: 160, y: 110, width: 1300, height: 110 },
    { ...display, text: 'Mattes & multiply', fontSize: 88, color: C.textDark, reveal: 'charFadeUp', revealDurationInFrames: 12, revealStagger: 2, revealOrder: 'center', revealEasing: 'easeOutCubic' },
    { durationInFrames: 96 },
  ),
  el('el_matte_frame', 'shape', { x: 160, y: 300, width: 760, height: 540 }, { shape: 'rect', fill: 'none', stroke: '#15162240', strokeWidth: 2, cornerRadius: 0 }, { durationInFrames: 96 }),
  el(
    'el_matte_lens',
    'shape',
    { x: 160, y: 400, width: 340, height: 340 },
    { shape: 'ellipse', fill: '#000000', stroke: 'none', strokeWidth: 0 },
    { durationInFrames: 96, tracks: [track('x', [[0, 0], [90, 420]], 'easeInOutCubic')] },
  ),
  el(
    'el_matte_target',
    'shape',
    { x: 160, y: 300, width: 760, height: 540 },
    {
      shape: 'rect',
      fill: { type: 'linear', angle: 135, stops: [{ offset: 0, color: C.violet }, { offset: 0.5, color: C.coral }, { offset: 1, color: C.amber }] },
      stroke: 'none',
      strokeWidth: 0,
      cornerRadius: 0,
    },
    { durationInFrames: 96, mask: { sourceId: 'el_matte_lens', mode: 'alpha' } },
  ),
  el('el_block_amber', 'shape', { x: 1080, y: 330, width: 400, height: 400 }, { shape: 'rect', fill: C.amber, stroke: 'none', strokeWidth: 0, cornerRadius: 36 }, { durationInFrames: 96 }),
  el('el_disc_teal', 'shape', { x: 1290, y: 450, width: 400, height: 400 }, { shape: 'ellipse', fill: C.teal, stroke: 'none', strokeWidth: 0 }, {
    durationInFrames: 96,
    blendMode: 'multiply',
  }),
  el('el_caption_matte', 'text', { x: 160, y: 868, width: 760, height: 36 }, { ...mono, text: 'alpha matte · moving ellipse', color: C.mutedDark }, { durationInFrames: 96 }),
  el('el_caption_blend', 'text', { x: 1080, y: 868, width: 610, height: 36 }, { ...mono, text: 'blendMode multiply', color: C.mutedDark }, { durationInFrames: 96 }),
];

export const showcaseV2: Project = {
  schemaVersion: 3,
  id: 'prj_showcase_v2',
  name: 'Schema v2 render showcase',
  revision: 1,
  fps: 30,
  width: 1920,
  height: 1080,
  backgroundColor: C.canvas,
  assets: {},
  audio: [],
  compositions: { cmp_pulse: pulse },
  markers: [],
  scenes: [
    { id: 'scn_draw', name: 'Draw', durationInFrames: 96, backgroundColor: C.ink, locked: false, transitionIn: { type: 'zoom', durationInFrames: 18 }, elements: drawScene },
    { id: 'scn_structure', name: 'Structure', durationInFrames: 96, backgroundColor: C.night, locked: false, transitionIn: { type: 'fade', durationInFrames: 12 }, elements: structureScene },
    { id: 'scn_matte', name: 'Matte & blend', durationInFrames: 96, backgroundColor: C.paper, locked: false, transitionIn: { type: 'blur', durationInFrames: 15 }, elements: matteScene },
  ],
};

/** Global frames rendered by scripts/render-showcase.ts, with what each one shows. */
export const SHOWCASE_STILLS: { frame: number; name: string; shows: string }[] = [
  { frame: 9, name: '01-zoom-transition', shows: 'Scene 1 mid zoom entrance (scale 1.08→1 + fade); kicker fading on per character (charStagger); headline starting its blurIn' },
  { frame: 36, name: '02-blur-in-and-trim', shows: 'Headline mid blurIn (2-frame per-character stagger); gradient swash about a third drawn by its trimEnd track' },
  { frame: 84, name: '03-draw-complete', shows: 'Scene 1 settled: Fraunces headline, full gradient swash, two-line lineStagger subtitle' },
  { frame: 136, name: '04-group-and-instances', shows: 'Rotating group (ring, counter-rotating radial tile, orbiting moon); the pulse composition twice, 30 frames apart' },
  { frame: 200, name: '05-blur-transition', shows: 'Scene 3 mid blur entrance (blur 24px→0 + fade); matte lens at the left; multiply overlap' },
  { frame: 262, name: '06-matte-and-multiply', shows: 'Elliptical alpha matte moved right over the gradient; teal disc multiplied over amber block and paper; charFadeUp title (centre-out order)' },
];
