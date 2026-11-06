// Pulse house-bar reference: two characteristic shots (a kit that assembles
// and a springy end card) built from placeholder shapes and copy. Numbers
// come from STYLE_PACKS.pulse.craft.

import { COMPONENTS } from '../../core/components';
import { STYLE_PACKS } from '../../core/style';
import type { Element, Transform } from '../../core/types';
import { Draft } from './draft';

const pack = STYLE_PACKS.pulse;
const enter = pack.motion.enter;
const C = pack.colors;

const KIT = 183; // cut lands +3 f after a 30 f beat (180)
const END = 225;

function t(x: number, y: number, width: number, height: number, extra: Partial<Transform> = {}): Transform {
  return { x, y, width, height, rotation: 0, scale: 1, opacity: 1, ...extra };
}

function shape(id: string, name: string, box: Transform, props: Record<string, unknown>, start: number, duration: number, tracks: Element['tracks'] = [], extra: Partial<Element> = {}): Element {
  return {
    id, type: 'shape', name, startFrame: start, durationInFrames: duration, visible: true, transform: box,
    props: { ...COMPONENTS.shape.defaultProps, ...props },
    tracks, ...extra,
  };
}

function text(id: string, name: string, box: Transform, props: Record<string, unknown>, start: number, duration: number, tracks: Element['tracks'] = [], extra: Partial<Element> = {}): Element {
  return {
    id, type: 'text', name, startFrame: start, durationInFrames: duration, visible: true, transform: box,
    props: { ...COMPONENTS.text.defaultProps, fontFamily: pack.fonts.heading, fontWeight: 500, color: C.text, align: 'center', reveal: 'none', revealDurationInFrames: 0, ...props },
    tracks, ...extra,
  };
}

function pop(frames: number): Element['tracks'] {
  return [
    { property: 'scale', keyframes: [{ frame: 0, value: 0.55, easing: enter }, { frame: frames, value: 1, easing: 'linear' }] },
    { property: 'opacity', keyframes: [{ frame: 0, value: 0, easing: enter }, { frame: frames, value: 1, easing: 'linear' }] },
  ];
}

function slideFade(frames: number, y = 36): Element['tracks'] {
  return [
    { property: 'opacity', keyframes: [{ frame: 0, value: 0, easing: 'easeOut' }, { frame: frames, value: 1, easing: 'linear' }] },
    { property: 'y', keyframes: [{ frame: 0, value: y, easing: 'linear' }, { frame: frames, value: 0, easing: 'linear' }] },
  ];
}

interface Tile {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  fill: string | { type: 'linear'; angle: number; stops: { offset: number; color: string }[] };
  start: number;
  pop: number;
  gx: number;
  gy: number;
  label?: string;
}

const TILES: Tile[] = [
  { name: 'Dark tile', x: 700, y: 300, w: 200, h: 200, fill: '#18100E', start: 4, pop: 3, gx: 780, gy: 300 },
  { name: 'Mint card', x: 1080, y: 240, w: 240, h: 280, fill: '#CEF7E7', start: 5, pop: 2, gx: 1000, gy: 280 },
  { name: 'Aa plate', x: 840, y: 620, w: 220, h: 220, fill: '#FFFFFF', start: 6, pop: 4, gx: 1220, gy: 300, label: 'Aa' },
  { name: 'Teal chip', x: 640, y: 520, w: 120, h: 48, fill: '#66E4DA', start: 8, pop: 2, gx: 780, gy: 520 },
  { name: 'Mint chip', x: 900, y: 280, w: 72, h: 72, fill: C.accent, start: 9, pop: 2, gx: 1000, gy: 520 },
  { name: 'Grey card', x: 1220, y: 500, w: 180, h: 180, fill: '#E8E4DC', start: 12, pop: 3, gx: 1220, gy: 520 },
  { name: 'Ivory card', x: 560, y: 640, w: 180, h: 140, fill: '#F9F6E7', start: 14, pop: 4, gx: 880, gy: 700 },
  { name: 'Teal tile', x: 1040, y: 720, w: 200, h: 200, fill: { type: 'linear', angle: 135, stops: [{ offset: 0, color: '#66E4DA' }, { offset: 1, color: C.accent2! }] }, start: 18, pop: 3, gx: 1100, gy: 680 },
];

function kitScene(d: Draft, naive: boolean): void {
  const scene = d.scene('Kit', KIT);
  const gid = d.next('el');
  const groupDur = KIT;
  d.add(scene, {
    id: gid, type: 'group', name: 'Kit cluster', startFrame: 0, durationInFrames: groupDur, visible: true,
    transform: t(0, 0, 1920, 1080),
    props: { clip: false },
    tracks: naive
      ? []
      : [
          { property: 'scale', keyframes: [{ frame: 20, value: 1, easing: 'easeInOut' }, { frame: 96, value: 1.04, easing: 'linear' }] },
          { property: 'x', keyframes: [{ frame: 0, value: 0, easing: 'linear' }, { frame: KIT - 1, value: 22, easing: 'linear' }] },
        ],
  });

  const statusPop = naive ? 12 : 2;
  d.add(scene, text(
    d.next('el'), 'Status', t(660, 500, 600, 56),
    { text: 'Assembling.', fontSize: naive ? 72 : 40, fontWeight: 500, color: '#2A2824', letterSpacing: -0.4 },
    1, KIT - 1,
    naive ? slideFade(statusPop) : pop(statusPop),
    { parentId: gid },
  ));

  for (const tile of TILES) {
    const id = d.next('el');
    const relayout = 90 - tile.start;
    const fadeAt = 140 - tile.start;
    const move: Element['tracks'] = naive
      ? []
      : [
          { property: 'x', keyframes: [{ frame: Math.max(tile.pop, relayout), value: 0, easing: 'easeInOut' }, { frame: relayout + 24, value: tile.gx - tile.x, easing: 'linear' }] },
          { property: 'y', keyframes: [{ frame: Math.max(tile.pop, relayout), value: 0, easing: 'easeInOut' }, { frame: relayout + 24, value: tile.gy - tile.y, easing: 'linear' }] },
          { property: 'opacity', keyframes: [{ frame: 0, value: 0, easing: enter }, { frame: tile.pop, value: 1, easing: 'hold' }, { frame: fadeAt, value: 1, easing: 'easeIn' }, { frame: fadeAt + 8, value: 0, easing: 'linear' }] },
        ];
    const tracks = naive ? slideFade(12) : [...pop(tile.pop).filter((tr) => tr.property === 'scale'), ...move];
    d.add(scene, shape(
      id, tile.name, t(tile.x, tile.y, tile.w, tile.h),
      { shape: 'rect', fill: tile.fill, cornerRadius: tile.h < 40 ? 16 : 20, stroke: 'none' },
      naive ? 8 + TILES.indexOf(tile) * 8 : tile.start, groupDur - (naive ? 8 + TILES.indexOf(tile) * 8 : tile.start),
      tracks,
      { parentId: gid },
    ));
    if (tile.label) {
      d.add(scene, text(
        d.next('el'), 'Specimen', t(tile.x + 20, tile.y + 40, tile.w - 40, 56),
        { text: tile.label, fontSize: 40, fontWeight: 600, color: '#2A2824' },
        naive ? 16 : tile.start + 1, groupDur - tile.start - 1,
        naive ? slideFade(12) : [
          pop(3).find((tr) => tr.property === 'scale')!,
          { property: 'opacity', keyframes: [{ frame: 0, value: 0, easing: enter }, { frame: 3, value: 1, easing: 'hold' }, { frame: 140 - tile.start, value: 1, easing: 'easeIn' }, { frame: 148 - tile.start, value: 0, easing: 'linear' }] },
        ],
        { parentId: gid },
      ));
    }
  }

  const cardAt = naive ? 120 : 140;
  d.add(scene, shape(
    d.next('el'), 'Kit card', t(780, 280, 360, 460),
    { shape: 'rect', fill: C.surface, stroke: C.accent, strokeWidth: 3, cornerRadius: 32 },
    cardAt, KIT - cardAt,
    naive ? slideFade(16) : pop(3),
    { parentId: gid },
  ));
  d.add(scene, text(
    d.next('el'), 'Wordmark', t(830, 400, 260, 120),
    { text: 'N', fontSize: naive ? 96 : 56, fontWeight: 600, color: '#2A2824' },
    cardAt + 3, KIT - cardAt - 3,
    naive ? slideFade(12) : pop(3),
    { parentId: gid },
  ));
  d.add(scene, text(
    d.next('el'), 'Check', t(920, 530, 80, 64),
    { text: '✓', fontSize: 48, fontWeight: 600, color: C.accent },
    cardAt + 8, KIT - cardAt - 8,
    naive ? slideFade(12) : pop(2),
    { parentId: gid },
  ));
}

function endScene(d: Draft, naive: boolean): void {
  const scene = d.scene('End', END);
  d.run({ type: 'updateScene', sceneId: scene, changes: { backgroundColor: '#FFFFFF' } });

  d.add(scene, shape(
    d.next('el'), 'Wash', t(0, 0, 1920, 1080),
    { shape: 'rect', fill: { type: 'linear', angle: 180, stops: [{ offset: 0, color: '#FFFFFF' }, { offset: 0.5, color: '#C7FAEE' }, { offset: 1, color: '#66E4DA' }] }, cornerRadius: 0, stroke: 'none' },
    0, END,
  ));
  if (!naive) {
    d.add(scene, shape(
      d.next('el'), 'Cream wipe', t(0, 0, 1920, 1080),
      { shape: 'rect', fill: C.background, cornerRadius: 0, stroke: 'none' },
      0, 12,
      [{ property: 'opacity', keyframes: [{ frame: 0, value: 1, easing: 'easeInOut' }, { frame: 10, value: 0, easing: 'linear' }] }],
    ));
  }

  const markTracks: Element['tracks'] = naive
    ? slideFade(16)
    : [
        { property: 'scale', keyframes: [{ frame: 0, value: 3, easing: enter }, { frame: 8, value: 1.08, easing: 'easeInOut' }, { frame: 10, value: 1, easing: 'linear' }] },
        { property: 'x', keyframes: [{ frame: 10, value: 0, easing: 'linear' }, { frame: END - 4, value: 46, easing: 'linear' }] },
      ];
  d.add(scene, shape(
    d.next('el'), 'Mark', t(850, 300, 220, 220),
    { shape: 'ellipse', fill: C.accent, stroke: 'none' },
    naive ? 8 : 2, END - (naive ? 8 : 2),
    markTracks,
    naive ? {} : { effects: { blur: 0 }, propTracks: [{ key: 'effects.blur', keyframes: [{ frame: 0, value: 18, easing: 'easeOut' }, { frame: 4, value: 0, easing: 'linear' }] }] },
  ));
  d.add(scene, shape(
    d.next('el'), 'Mark hole', t(926, 376, 68, 68),
    { shape: 'ellipse', fill: '#FFFFFF', stroke: 'none' },
    naive ? 12 : 6, END - (naive ? 12 : 6),
    naive ? slideFade(12) : pop(3),
  ));

  const wordAt = naive ? 20 : 26;
  d.add(scene, text(
    d.next('el'), 'Wordmark', t(560, 548, 800, 90),
    { text: 'Northline', fontSize: naive ? 84 : 72, fontWeight: 600, letterSpacing: -1.5, color: '#2A2824', lineHeight: 1 },
    wordAt, END - wordAt,
    naive ? slideFade(16) : pop(4),
  ));
  const studioAt = naive ? 40 : 104;
  d.add(scene, text(
    d.next('el'), 'Title', t(560, 624, 800, 48),
    { text: 'Studio', fontSize: naive ? 48 : 40, fontWeight: 500, color: '#2A2824', reveal: naive ? 'none' : 'typewriter', revealDurationInFrames: naive ? 0 : 6 },
    studioAt, END - studioAt,
    naive ? slideFade(12) : [],
  ));

  const pills = [
    { name: 'Pill', text: 'Reference shot', at: naive ? 80 : 138 },
    { name: 'Pill', text: 'Brand tokens', at: naive ? 88 : 142 },
  ];
  pills.forEach((p, i) => {
    const x = 680 + i * 280;
    d.add(scene, shape(
      d.next('el'), `${p.name} plate`, t(x, 740, 260, 52),
      { shape: 'rect', fill: C.surface, stroke: C.muted, strokeWidth: 1, cornerRadius: 26 },
      p.at, END - p.at,
      naive ? slideFade(12) : pop(2),
    ));
    d.add(scene, text(
      d.next('el'), p.name, t(x, 748, 260, 40),
      { text: p.text, fontSize: 28, fontWeight: 500, color: '#2A2824' },
      p.at, END - p.at,
      naive ? slideFade(12) : pop(2),
    ));
  });
}

function build(id: string, name: string, naive: boolean) {
  const d = new Draft({ id, name, pack: 'pulse' });
  kitScene(d, naive);
  endScene(d, naive);
  d.marker(KIT, naive ? 'Cut' : 'Cut · +3 after beat');
  return d.project;
}

/** Crafted Pulse reference — the house bar. */
export const pulseReference = () => build('prj_golden_pulse', 'Northline — kit + end', false);

/** Same shots with slow fades and no drift: the "before" we iterate away from. */
export const pulseReferenceBefore = () => build('prj_pulse_before', 'Northline — before', true);
