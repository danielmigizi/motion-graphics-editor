// Motion stats vs a style pack's craft tokens. Agents get frame-tied notes
// on how far a draft sits from the house bar (pops, stagger, drift, dead
// frames, beat offset, type scale, palette count). Pure and deterministic.

import { evaluateElementWorld } from './animation';
import { parseColor } from './color';
import { sceneStartFrames } from './timing';
import { craftOf } from './styleCraft';
import type { Element, Paint, Project, Scene, StyleCraft } from './types';

/** Same shape as critique's beat grid — kept local to avoid a cycle. */
export interface StatsBeats {
  beats: number[];
  downbeats?: number[];
  confidence?: number;
}

export interface DeadRun {
  sceneId: string;
  sceneName: string;
  start: number;
  frames: number;
}

export interface MotionStats {
  popDurations: number[];
  staggers: number[];
  deadRuns: DeadRun[];
  hasDrift: boolean;
  typeShares: number[];
  paletteCount: number;
  beatOffsets: number[];
}

export interface BaselineNote {
  rule: string;
  frame: number;
  sceneId: string;
  sceneName: string;
  elementId?: string;
  message: string;
  expected: string;
  actual: string;
}

const median = (xs: number[]): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};

const inBand = (n: number, band: { min: number; max: number }, pad = 0) => n + 0.01 >= band.min - pad && n - 0.01 <= band.max + pad;

function paintsOf(el: Element): Paint[] {
  const out: Paint[] = [];
  for (const key of ['fill', 'stroke', 'color', 'background', 'accentColor', 'bubbleColor', 'textColor']) {
    const v = el.props[key];
    if (typeof v === 'string' || (v && typeof v === 'object' && 'type' in (v as object))) out.push(v as Paint);
  }
  return out;
}

function colourStops(paint: Paint): string[] {
  if (typeof paint === 'string') return paint === 'none' ? [] : [paint];
  return paint.stops.map((s) => s.color);
}

function hexKey(color: string): string | null {
  const c = parseColor(color);
  if (!c || c[3] < 0.15) return null;
  const hex = (n: number) => n.toString(16).padStart(2, '0');
  return `#${hex(c[0])}${hex(c[1])}${hex(c[2])}`;
}

function entranceSpan(el: Element): number | null {
  let first = Infinity;
  let last = -Infinity;
  for (const track of el.tracks) {
    if (track.property !== 'scale' && track.property !== 'opacity') continue;
    for (let i = 0; i < track.keyframes.length - 1; i++) {
      const a = track.keyframes[i]!;
      const b = track.keyframes[i + 1]!;
      if (a.frame > el.durationInFrames * 0.55) continue;
      if (a.value >= b.value - 0.05) continue;
      first = Math.min(first, a.frame);
      last = Math.max(last, b.frame);
    }
  }
  if (!Number.isFinite(first) || last < first) return null;
  const span = last - first;
  return span >= 1 && span <= 40 ? span : null;
}

function siblingStaggers(scene: Scene): number[] {
  const groups = new Map<string, number[]>();
  for (const el of scene.elements) {
    if (!el.visible) continue;
    const key = el.parentId ?? scene.id;
    const list = groups.get(key) ?? [];
    list.push(el.startFrame);
    groups.set(key, list);
  }
  const out: number[] = [];
  for (const starts of groups.values()) {
    if (starts.length < 2) continue;
    const sorted = [...new Set(starts)].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) {
      const gap = sorted[i]! - sorted[i - 1]!;
      if (gap > 0 && gap <= 16) out.push(gap);
    }
  }
  return out;
}

function isDriftTrack(el: Element): boolean {
  for (const track of el.tracks) {
    for (let i = 0; i < track.keyframes.length - 1; i++) {
      const a = track.keyframes[i]!;
      const b = track.keyframes[i + 1]!;
      const frames = b.frame - a.frame;
      const delta = Math.abs(b.value - a.value);
      // Entrances are short; a house-bar drift/push runs across a hold.
      if (frames < 40) continue;
      if (track.property === 'scale' && delta > 0.005 && delta <= 0.08) return true;
      if ((track.property === 'x' || track.property === 'y') && delta >= 6 && delta <= 120) return true;
    }
  }
  return false;
}

function motionSignature(scene: Scene, project: Project, frameInScene: number): string {
  const sources = new Set(scene.elements.filter((e) => e.mask).map((e) => e.mask!.sourceId));
  const parts: string[] = [];
  for (const el of scene.elements) {
    if (sources.has(el.id) || !el.visible) continue;
    const w = evaluateElementWorld(scene.elements, el, frameInScene);
    if (!w.active || w.opacity < 0.02) continue;
    const r = (n: number, d = 1) => Math.round(n * d) / d;
    parts.push(`${el.id}:${r(w.x)}:${r(w.y)}:${r(w.scale, 100)}:${r(w.rotation, 10)}:${r(w.opacity, 100)}`);
  }
  return parts.join('|');
}

function deadRunsOf(scene: Scene, project: Project, sceneStart: number): DeadRun[] {
  const dur = scene.durationInFrames;
  if (dur < 4) return [];
  let prev = motionSignature(scene, project, 0);
  let stillFrom = 0;
  const runs: DeadRun[] = [];
  for (let f = 1; f < dur; f++) {
    const sig = motionSignature(scene, project, f);
    if (sig === prev) continue;
    const still = f - stillFrom;
    if (still >= 8) runs.push({ sceneId: scene.id, sceneName: scene.name, start: sceneStart + stillFrom, frames: still });
    prev = sig;
    stillFrom = f;
  }
  const tail = dur - stillFrom;
  if (tail >= 8) runs.push({ sceneId: scene.id, sceneName: scene.name, start: sceneStart + stillFrom, frames: tail });
  return runs;
}

function nearest(list: number[], f: number): number | null {
  return list.reduce<number | null>((best, b) => (best === null || Math.abs(b - f) < Math.abs(best - f) ? b : best), null);
}

export function computeMotionStats(project: Project, beats?: StatsBeats): MotionStats {
  const starts = sceneStartFrames(project);
  const popDurations: number[] = [];
  const staggers: number[] = [];
  const deadRuns: DeadRun[] = [];
  const typeShares: number[] = [];
  const palette = new Set<string>();
  let hasDrift = false;

  for (const hex of [project.backgroundColor, ...project.scenes.map((s) => s.backgroundColor)].map(hexKey)) {
    if (hex) palette.add(hex);
  }

  project.scenes.forEach((scene, i) => {
    if (!scene.elements.some((e) => e.visible)) return;
    const sceneStart = starts[i] ?? 0;
    staggers.push(...siblingStaggers(scene));
    deadRuns.push(...deadRunsOf(scene, project, sceneStart));
    for (const el of scene.elements) {
      if (!el.visible) continue;
      const pop = entranceSpan(el);
      if (pop !== null) popDurations.push(pop);
      if (isDriftTrack(el)) hasDrift = true;
      const size = Number(el.props.fontSize);
      if (el.type === 'text' && Number.isFinite(size) && size > 0) typeShares.push(size / project.height);
      for (const paint of paintsOf(el)) {
        for (const stop of colourStops(paint)) {
          const hex = hexKey(stop);
          if (hex) palette.add(hex);
        }
      }
    }
  });

  const beatOffsets: number[] = [];
  const grid = beats?.downbeats?.length ? beats.downbeats : beats?.beats;
  if (grid?.length && (beats?.confidence ?? 1) >= 0.2) {
    project.scenes.forEach((scene, i) => {
      if (i === 0) return;
      const f = starts[i] ?? 0;
      const n = nearest(grid, f);
      if (n !== null) beatOffsets.push(f - n);
    });
  }

  return { popDurations, staggers, deadRuns, hasDrift, typeShares, paletteCount: palette.size, beatOffsets };
}

export function compareToCraft(stats: MotionStats, craft: StyleCraft, project: Project): BaselineNote[] {
  const notes: BaselineNote[] = [];
  const first = project.scenes[0];
  const sceneId = first?.id ?? '';
  const sceneName = first?.name ?? '';
  const add = (note: Omit<BaselineNote, 'sceneId' | 'sceneName'> & { sceneId?: string; sceneName?: string }) => {
    notes.push({ sceneId: note.sceneId ?? sceneId, sceneName: note.sceneName ?? sceneName, ...note });
  };

  const pop = median(stats.popDurations);
  if (pop !== null && !inBand(pop, craft.popFrames, 1)) {
    add({
      rule: 'baseline:pop',
      frame: 0,
      message: `median pop is ${pop} f; house bar is ${craft.popFrames.min}–${craft.popFrames.max} f.`,
      expected: `${craft.popFrames.min}–${craft.popFrames.max} f`,
      actual: `${pop} f`,
    });
  }

  const stag = median(stats.staggers);
  if (stag !== null && !inBand(stag, craft.staggerFrames, 1)) {
    add({
      rule: 'baseline:stagger',
      frame: 0,
      message: `median stagger is ${stag} f; house bar is ${craft.staggerFrames.min}–${craft.staggerFrames.max} f (irregular, not uniform).`,
      expected: `${craft.staggerFrames.min}–${craft.staggerFrames.max} f`,
      actual: `${stag} f`,
    });
  }

  if (craft.driftPxPerFrame > 0 && !stats.hasDrift) {
    add({
      rule: 'baseline:drift',
      frame: 0,
      message: 'no slow drift or push. This style never fully freezes — add ~1 px/frame idle or a 66–96 f camera ease-in-out.',
      expected: `drift ≥ ${craft.driftPxPerFrame} px/f or a ${craft.cameraFrames.min}–${craft.cameraFrames.max} f push`,
      actual: 'none',
    });
  }

  const longDead = stats.deadRuns.filter((r) => r.frames > craft.trueHoldMaxFrames);
  for (const run of longDead.slice(0, 3)) {
    add({
      rule: 'baseline:dead',
      frame: run.start,
      sceneId: run.sceneId,
      sceneName: run.sceneName,
      message: `still for ${run.frames} f (bar allows one true hold ≤ ${craft.trueHoldMaxFrames} f). Keep secondary motion.`,
      expected: `≤ ${craft.trueHoldMaxFrames} f`,
      actual: `${run.frames} f`,
    });
  }

  const type = median(stats.typeShares);
  if (type !== null && !inBand(type, craft.typeHeightShare, 0.015)) {
    add({
      rule: 'baseline:type',
      frame: 0,
      message: `median type is ${(type * 100).toFixed(1)} % of frame height; bar is ${Math.round(craft.typeHeightShare.min * 100)}–${Math.round(craft.typeHeightShare.max * 100)} %.`,
      expected: `${craft.typeHeightShare.min}–${craft.typeHeightShare.max}`,
      actual: type.toFixed(3),
    });
  }

  const packColours = 2 + Object.values(project.style?.colors ?? {}).filter(Boolean).length;
  if (stats.paletteCount > packColours + 3) {
    add({
      rule: 'baseline:palette',
      frame: 0,
      message: `${stats.paletteCount} distinct colours; stay near the pack roles (about ${packColours}).`,
      expected: `≤ ${packColours + 3}`,
      actual: String(stats.paletteCount),
    });
  }

  for (const offset of stats.beatOffsets) {
    if (Math.abs(offset - craft.beatOffsetFrames) <= craft.beatOffsetWindow) continue;
    add({
      rule: 'baseline:beat',
      frame: 0,
      message: `cut is ${offset} f from the beat; bar lands +${craft.beatOffsetFrames} f after (±${craft.beatOffsetWindow}).`,
      expected: `+${craft.beatOffsetFrames} f`,
      actual: `${offset} f`,
    });
  }

  return notes;
}

export function formatBar(stats: MotionStats, craft: StyleCraft, packId: string): string {
  const pop = median(stats.popDurations);
  const stag = median(stats.staggers);
  const type = median(stats.typeShares);
  const dead = stats.deadRuns.length ? stats.deadRuns.map((r) => `${r.frames}f`).join(', ') : '0';
  const beat = stats.beatOffsets.length ? stats.beatOffsets.map((n) => `${n > 0 ? '+' : ''}${n}`).join(', ') : 'n/a';
  return `Bar vs ${packId}: pops median ${pop ?? 'n/a'} f (want ${craft.popFrames.min}–${craft.popFrames.max}); stagger median ${stag ?? 'n/a'} f (want ${craft.staggerFrames.min}–${craft.staggerFrames.max}); drift ${stats.hasDrift ? 'yes' : 'no'}; dead ${dead}; type ${type !== null ? `${(type * 100).toFixed(1)}%` : 'n/a'} (want ${Math.round(craft.typeHeightShare.min * 100)}–${Math.round(craft.typeHeightShare.max * 100)}%); palette ${stats.paletteCount}; beat ${beat}.`;
}

export const craftForProject = (project: Project): StyleCraft => craftOf(project.style);
