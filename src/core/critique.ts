// Deterministic motion critique. Agents call this (editor_critique) instead of
// a vibe checklist: every finding is a number tied to a frame, derived from
// motionRules and the project document. No rendering, no Date.now, no randomness.

import { evaluateElementWorld } from './animation';
import { parseColor } from './color';
import {
  contrastRatio,
  FRAME_USE,
  LIVENESS,
  readingFrames,
  SAFE_MARGIN,
  SEAM,
  STORY,
  TYPE_MIN,
  TYPE_SCALE,
} from './motionRules';
import { compareToCraft, formatBar, computeMotionStats, type MotionStats } from './motionStats';
import { craftOf, isHousePack } from './styleCraft';
import { locateFrame, projectDurationInFrames, sceneStartFrames } from './timing';
import type { Element, EasingSpec, Paint, Project, Scene, StoryBeatRole, StyleCraft } from './types';

export type CritiqueSeverity = 'error' | 'warn';

export interface CritiqueFinding {
  id: string;
  severity: CritiqueSeverity;
  rule: string;
  sceneId: string;
  sceneName: string;
  elementId?: string;
  elementName?: string;
  /** Global timeline frame the defect is visible. */
  frame: number;
  frameInScene: number;
  message: string;
  fix: string;
}

export interface CritiqueBeats {
  /** Project-timeline beat frames. */
  beats: number[];
  downbeats?: number[];
  /** Below 0.2 the grid is a guess: skip cut-on-beat checks. */
  confidence?: number;
}

export interface CritiqueOptions {
  /** Limit to these scenes (a patch's targets). Empty = whole project. */
  sceneIds?: readonly string[];
  beats?: CritiqueBeats;
  /** Extra banned items the agent added after a contact sheet. */
  extraBanned?: readonly string[];
}

export interface CritiqueReport {
  findings: CritiqueFinding[];
  errors: number;
  warnings: number;
  banned: string[];
  scenes: number;
  /** Measured motion vs the pack's craft tokens (house bar). */
  stats: MotionStats;
  bar: string;
}

/** Seeded AI-default clichés. `detect` is set when the document can prove it. */
export interface BannedItem {
  id: string;
  label: string;
  /** How an agent should avoid it. */
  avoid: string;
  /** True when a detector in critiqueProject can flag this. */
  detectable: boolean;
}

export const SEEDED_BANNED: readonly BannedItem[] = [
  { id: 'purple-gradient', label: 'purple / violet gradients', avoid: 'Use the pack accent at lower opacity, not a new purple hue.', detectable: true },
  { id: 'glow-orb', label: 'glow orbs (soft ellipses floating with no hero)', avoid: 'A glow is a treatment behind a screenshot or logo, never the subject.', detectable: true },
  { id: 'particles', label: 'particle fields (many tiny identical dots)', avoid: 'One or two chips, not a sprinkle of dots.', detectable: true },
  { id: 'fade-and-slide', label: 'fade-and-slide on everything', avoid: 'Vary entrances: masked rise, wordStagger, overshoot. Fade+slide is one tool, not the default.', detectable: true },
  { id: 'linear-move', label: 'linear position / scale easing', avoid: 'Arrivals ease out, exits ease in; linear only for a slow drift or push.', detectable: true },
  { id: 'every-scene-fades', label: 'fade every scene in', avoid: 'Cut on the beat; fade 6–10 f only when nothing carries across.', detectable: true },
  { id: 'tiny-type', label: 'type below video-safe size', avoid: `Labels ≥ ${TYPE_MIN.label} px, tracked caps ≥ ${TYPE_MIN.trackedCaps}, body ≥ ${TYPE_MIN.body} at 1080.`, detectable: true },
  { id: 'dead-hold', label: 'a still frame longer than a reading hold', avoid: 'Secondary motion (push, drift, backdrop) while the hero sits.', detectable: true },
  { id: 'glassmorphism', label: 'frosted-glass panels (blur + white fill as the look)', avoid: 'Solid pack surfaces; blur is for a hit or an exit, not decoration.', detectable: false },
  { id: 'stock-sans-on-navy', label: 'Inter on a generic navy plate when the pack is not that', avoid: 'Use project.style fonts and the pack background.', detectable: false },
  { id: 'gradient-text', label: 'gradient text', avoid: 'Solid pack text or accent. A gradient fill on type is the first LLM tell.', detectable: true },
  { id: 'cyan-neon', label: 'cyan-on-dark neon (or purple-to-blue neon) when it is not a pack role', avoid: 'Accents only from the pack. Tint neutrals toward the accent; do not invent neon.', detectable: true },
  { id: 'pure-black-white', label: 'pure #000 / #fff when the pack is not that', avoid: 'Tint the plate and type toward the pack accent. Use the pack background / text / surface.', detectable: true },
  { id: 'identical-cards', label: 'identical card grids (same-size cards, same start or same copy)', avoid: 'If cards are a real product UI, stagger them and give each unique copy. Otherwise pick one hero card.', detectable: true },
  { id: 'edge-stripe', label: 'left-edge accent stripes on cards', avoid: 'Lead the eye with type size or a real icon, not a 8 px accent bar.', detectable: true },
  { id: 'idle-wobble', label: 'idle sine loops (breathe / float / pulse) used as filler', avoid: 'Purposeful one-way drift or a 2–5 % push is fine. A looping sine reads as waiting — add story instead.', detectable: true },
];

export const SEEDED_BANNED_IDS = SEEDED_BANNED.map((b) => b.id);

const MAX_BANNED = 40;
const MAX_BANNED_CHARS = 80;

/** Seeded ids plus project.banned plus extras, de-duplicated, stable order. */
export function mergeBanned(project: Pick<Project, 'banned'>, extra: readonly string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const item = raw.trim().slice(0, MAX_BANNED_CHARS);
    if (!item || seen.has(item)) return;
    seen.add(item);
    out.push(item);
  };
  for (const id of SEEDED_BANNED_IDS) add(id);
  for (const item of project.banned ?? []) add(item);
  for (const item of extra) add(item);
  return out.slice(0, MAX_BANNED);
}

export function critiqueProject(project: Project, opts: CritiqueOptions = {}): CritiqueReport {
  const banned = mergeBanned(project, opts.extraBanned);
  const starts = sceneStartFrames(project);
  const sceneFilter = opts.sceneIds && opts.sceneIds.length ? new Set(opts.sceneIds) : null;
  const findings: CritiqueFinding[] = [];
  const add = (f: CritiqueFinding) => findings.push(f);

  project.scenes.forEach((scene, i) => {
    if (sceneFilter && !sceneFilter.has(scene.id)) return;
    if (!scene.elements.some((e) => e.visible)) return; // empty skeleton: nothing to judge
    const sceneStart = starts[i] ?? 0;
    const ctx: SceneCtx = { project, scene, sceneStart, banned: new Set(banned), craft: craftOf(project.style) };
    checkReadingHolds(ctx, add);
    checkTypeMinimums(ctx, add);
    checkContrast(ctx, add);
    checkDeadFrames(ctx, add);
    checkSimultaneousHeroes(ctx, add);
    checkLinearMoves(ctx, add);
    checkStagger(ctx, add);
    checkBannedDetectable(ctx, add);
    checkHeroSize(ctx, add);
    checkEmptyFrame(ctx, add);
    checkEntryExitTiming(ctx, add);
    checkIdleWobble(ctx, add);
    checkStillnessBeforeClimax(ctx, add);
  });
  checkCutsOnBeat(project, starts, opts.beats, sceneFilter, add);
  checkEverySceneFades(project, sceneFilter, add);
  checkStoryStructure(project, starts, sceneFilter, add);
  checkSeamContinuity(project, starts, sceneFilter, add);

  const stats = computeMotionStats(project, opts.beats);
  const craft = craftOf(project.style);
  if (!sceneFilter) {
    for (const note of compareToCraft(stats, craft, project)) {
      const sceneStart = starts[project.scenes.findIndex((s) => s.id === note.sceneId)] ?? 0;
      add({
        id: `${note.rule}:${note.frame}:${note.sceneId}`,
        severity: 'warn',
        rule: note.rule,
        sceneId: note.sceneId,
        sceneName: note.sceneName,
        elementId: note.elementId,
        frame: note.frame,
        frameInScene: Math.max(0, note.frame - sceneStart),
        message: note.message,
        fix: `Match the ${project.style?.id ?? 'pack'} craft: ${note.expected} (saw ${note.actual}).`,
      });
    }
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  return {
    findings,
    errors,
    warnings: findings.length - errors,
    banned,
    scenes: sceneFilter ? project.scenes.filter((s) => sceneFilter.has(s.id)).length : project.scenes.length,
    stats,
    bar: formatBar(stats, craft, project.style?.id ?? 'default'),
  };
}

/** Compact text agents can paste into a fix pass. */
export function formatCritique(report: CritiqueReport): string {
  const lines: string[] = [
    `Critique: ${report.errors} error${report.errors === 1 ? '' : 's'}, ${report.warnings} warning${report.warnings === 1 ? '' : 's'} across ${report.scenes} scene${report.scenes === 1 ? '' : 's'}.`,
  ];
  if (!report.findings.length) {
    lines.push('No document-level defects. Still look at a contact sheet: colour, crop and taste are visual.');
    lines.push(report.bar);
    return lines.join('\n');
  }
  for (const f of report.findings) {
    const who = f.elementName ? `${f.sceneName} › ${f.elementName}` : f.sceneName;
    lines.push(`- [${f.severity}] ${f.rule} @ frame ${f.frame} (${who}): ${f.message} ${f.fix}`);
  }
  lines.push(report.bar);
  lines.push(`Banned: ${report.banned.join(', ')}.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Scene helpers
// ---------------------------------------------------------------------------

interface SceneCtx {
  project: Project;
  scene: Scene;
  sceneStart: number;
  banned: Set<string>;
  craft: StyleCraft;
}

function finding(
  ctx: SceneCtx,
  over: Omit<CritiqueFinding, 'sceneId' | 'sceneName' | 'frame'> & { frameInScene: number },
): CritiqueFinding {
  return {
    sceneId: ctx.scene.id,
    sceneName: ctx.scene.name,
    frame: ctx.sceneStart + over.frameInScene,
    ...over,
  };
}

function byId(scene: Scene): Map<string, Element> {
  return new Map(scene.elements.map((e) => [e.id, e]));
}

/** Scene-relative start, walking parent groups. */
export function sceneStartOf(el: Element, ids: Map<string, Element>, visiting = new Set<string>()): number {
  if (visiting.has(el.id)) return el.startFrame;
  visiting.add(el.id);
  const parent = el.parentId ? ids.get(el.parentId) : undefined;
  return el.startFrame + (parent ? sceneStartOf(parent, ids, visiting) : 0);
}

function maskSources(scene: Scene): Set<string> {
  return new Set(scene.elements.filter((e) => e.mask).map((e) => e.mask!.sourceId));
}

function scale1080(project: Pick<Project, 'width' | 'height'>): number {
  return Math.min(project.width, project.height) / 1080;
}

function isPainted(el: Element, sources: Set<string>): boolean {
  return el.visible && !sources.has(el.id);
}

const UNIT_REVEALS = new Set(['charStagger', 'lineStagger', 'charFadeUp', 'scaleIn', 'blurIn']);

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/** Key lines keep a full reading hold; chips / status / pills can pop and sit. */
export function isKeyLine(el: Element): boolean {
  if (el.type !== 'text') return false;
  const name = el.name;
  if (/chip|pill|tag|kicker|eyebrow|badge|dot|caption|status|specimen/i.test(name)) return false;
  if (/headline|title|wordmark|payoff|hero|statement|line\b/i.test(name)) return true;
  return wordCount(String(el.props.text ?? '')) >= 3;
}

function unitCount(el: Element): number {
  const text = String(el.props.text ?? '');
  const reveal = String(el.props.reveal ?? 'none');
  if (reveal === 'lineStagger') return Math.max(1, text.split('\n').filter((l, i, a) => l !== '' || i < a.length - 1).length);
  if (UNIT_REVEALS.has(reveal)) return Math.max(1, Array.from(text.replace(/\s+/g, '')).length);
  return Math.max(1, wordCount(text));
}

/** Local frame at which the text is fully readable (reveal + entrance keys done). */
export function textLandedLocal(el: Element): number {
  const reveal = String(el.props.reveal ?? 'none');
  const revealDur = reveal !== 'none' ? Math.max(0, Number(el.props.revealDurationInFrames) || 0) : 0;
  const stagger = Number(el.props.revealStagger) || 0;
  const revealEnd = UNIT_REVEALS.has(reveal) ? revealDur + stagger * Math.max(0, unitCount(el) - 1) : revealDur;
  let entrance = 0;
  for (const track of el.tracks) {
    for (const key of track.keyframes) {
      if (key.frame <= el.durationInFrames * 0.6) entrance = Math.max(entrance, key.frame);
    }
  }
  for (const track of el.propTracks ?? []) {
    for (const key of track.keyframes) {
      if (key.frame <= el.durationInFrames * 0.6) entrance = Math.max(entrance, key.frame);
    }
  }
  return Math.max(0, revealEnd, entrance);
}

export type TypeRole = 'trackedCaps' | 'label' | 'body' | 'callout' | 'ctaLabel';

/** Which video-safe minimum applies. Kickers in tracked caps need the larger floor. */
export function typeRole(el: Element): TypeRole {
  const name = el.name;
  const text = String(el.props.text ?? '');
  const tracking = Number(el.props.letterSpacing) || 0;
  const caps = text.length > 2 && text === text.toUpperCase() && /[\p{L}]/u.test(text);
  if (/kicker|eyebrow|badge|step\b/i.test(name) || (tracking >= 3 && caps)) return 'trackedCaps';
  if (/chip|callout|pill|tag\b/i.test(name)) return 'callout';
  if (/button|cta|label/i.test(name) && !/metric/i.test(name)) return 'ctaLabel';
  const size = Number(el.props.fontSize);
  // Caption-scale type (below the body band) is a label, not body copy.
  if (Number.isFinite(size) && size < TYPE_SCALE.body[0]) return 'label';
  return 'body';
}

function typeMinFor(role: TypeRole): number {
  return TYPE_MIN[role];
}

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

function hsl(rgb: [number, number, number]): { h: number; s: number; l: number } {
  const r = rgb[0] / 255;
  const g = rgb[1] / 255;
  const b = rgb[2] / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

function packHues(project: Project): number[] {
  const colors = project.style?.colors;
  if (!colors) return [];
  const hues: number[] = [];
  for (const value of Object.values(colors)) {
    if (!value) continue;
    const c = parseColor(value);
    if (!c) continue;
    const { h, s } = hsl([c[0], c[1], c[2]]);
    if (s >= 0.12) hues.push(h);
  }
  return hues;
}

function hueNearPack(h: number, pack: number[], windowDeg = 22): boolean {
  return pack.some((p) => Math.min(Math.abs(h - p), 360 - Math.abs(h - p)) <= windowDeg);
}

function namedEasing(spec: EasingSpec): string | null {
  return typeof spec === 'string' ? spec : null;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkReadingHolds(ctx: SceneCtx, add: (f: CritiqueFinding) => void): void {
  const ids = byId(ctx.scene);
  const sources = maskSources(ctx.scene);
  const fps = ctx.project.fps;
  for (const el of ctx.scene.elements) {
    if (el.type !== 'text' || !isPainted(el, sources)) continue;
    const text = String(el.props.text ?? '');
    if (!wordCount(text)) continue;
    // Pulse: chips and status pops are not reading-hold errors; key lines still are.
    if (ctx.craft.readingHoldOnKeyLines && !isKeyLine(el)) continue;
    const start = sceneStartOf(el, ids);
    const landed = start + textLandedLocal(el);
    const gone = Math.min(ctx.scene.durationInFrames, start + el.durationInFrames);
    const held = gone - landed;
    const need = readingFrames(text, fps);
    if (held >= need - 1) continue;
    add(
      finding(ctx, {
        id: `reading:${el.id}`,
        severity: 'error',
        rule: 'readingHold',
        elementId: el.id,
        elementName: el.name,
        frameInScene: Math.max(0, Math.min(ctx.scene.durationInFrames - 1, landed)),
        message: `holds ${held} f after landing; needs ${need} f (words ÷ 3.5 + 0.5 s, min 1.2 s).`,
        fix: 'Lengthen the element (and the scene if it would clip) so the hold reaches the reading time; never cut the hold to hit a beat — stretch to the next downbeat.',
      }),
    );
  }
}

function checkTypeMinimums(ctx: SceneCtx, add: (f: CritiqueFinding) => void): void {
  const sources = maskSources(ctx.scene);
  const scale = scale1080(ctx.project);
  for (const el of ctx.scene.elements) {
    if (!isPainted(el, sources)) continue;
    const size = Number(el.props.fontSize);
    if (!Number.isFinite(size)) continue;
    if (el.type !== 'text' && el.type !== 'chatBubble') continue;
    const role = el.type === 'chatBubble' ? 'body' : typeRole(el);
    const min = typeMinFor(role) * scale;
    if (size + 0.5 >= min) continue;
    // Goldens and templates sit 1–2 px under a floor; that's a warn. 16 px
    // kickers are the defect — error when clearly below (~15 % or 6 px).
    const clearlyTiny = size < min * 0.85 || size <= min - 6;
    add(
      finding(ctx, {
        id: `type:${el.id}`,
        severity: clearlyTiny ? 'error' : 'warn',
        rule: 'typeMin',
        elementId: el.id,
        elementName: el.name,
        frameInScene: Math.max(0, sceneStartOf(el, byId(ctx.scene))),
        message: `${role} is ${size} px; minimum ${Math.round(min)} px at this frame size (${role} ≥ ${typeMinFor(role)} at 1080).`,
        fix: 'Raise fontSize (wrap the line rather than shrinking). Tracked caps need the kicker floor, not the mixed-case label floor.',
      }),
    );
  }
}

function checkContrast(ctx: SceneCtx, add: (f: CritiqueFinding) => void): void {
  const sources = maskSources(ctx.scene);
  const bg = ctx.scene.backgroundColor;
  for (const el of ctx.scene.elements) {
    if (el.type !== 'text' || !isPainted(el, sources)) continue;
    const fg = typeof el.props.color === 'string' ? el.props.color : null;
    if (!fg) continue;
    const ratio = contrastRatio(fg, bg);
    if (ratio === null || ratio + 0.05 >= TYPE_MIN.contrast) continue;
    add(
      finding(ctx, {
        id: `contrast:${el.id}`,
        severity: 'warn',
        rule: 'contrast',
        elementId: el.id,
        elementName: el.name,
        frameInScene: Math.max(0, sceneStartOf(el, byId(ctx.scene))),
        message: `contrast ${ratio.toFixed(2)}:1 against the scene plate (need ≥ ${TYPE_MIN.contrast}).`,
        fix: 'Punchline in the pack text or accent colour, never muted grey on a mid plate.',
      }),
    );
  }
}

function revealActive(el: Element, localFrame: number): boolean {
  if (el.type !== 'text') return false;
  const reveal = String(el.props.reveal ?? 'none');
  if (reveal === 'none') return false;
  return localFrame >= 0 && localFrame < textLandedLocal(el);
}

function motionSignature(ctx: SceneCtx, frameInScene: number): string {
  const sources = maskSources(ctx.scene);
  const parts: string[] = [];
  for (const el of ctx.scene.elements) {
    if (sources.has(el.id) || !el.visible) continue;
    const w = evaluateElementWorld(ctx.scene.elements, el, frameInScene);
    if (!w.active || w.opacity < 0.02) continue;
    const r = (n: number, d = 1) => Math.round(n * d) / d;
    parts.push(`${el.id}:${r(w.x)}:${r(w.y)}:${r(w.scale, 100)}:${r(w.rotation, 10)}:${r(w.opacity, 100)}`);
    if (revealActive(el, w.localFrame)) parts.push(`${el.id}:reveal:${w.localFrame}`);
  }
  return parts.join('|');
}

function checkDeadFrames(ctx: SceneCtx, add: (f: CritiqueFinding) => void): void {
  const fps = ctx.project.fps;
  // Pulse expects constant drift: warn after 8 f, error past the true-hold cap.
  // Other packs keep the 0.5 s / 1 s rule.
  const warnAfter = isHousePack(ctx.project.style) ? 8 : Math.max(1, Math.round(LIVENESS.maxStillSeconds * fps));
  const errorAfter = isHousePack(ctx.project.style) ? ctx.craft.trueHoldMaxFrames : fps;
  const dur = ctx.scene.durationInFrames;
  if (dur <= warnAfter) return;
  let prev = motionSignature(ctx, 0);
  let stillFrom = 0;
  let flagged = false;
  for (let f = 1; f < dur; f++) {
    const sig = motionSignature(ctx, f);
    if (sig === prev) {
      if (!flagged && f - stillFrom > warnAfter) {
        const still = f - stillFrom;
        add(
          finding(ctx, {
            id: `dead:${ctx.scene.id}:${stillFrom}`,
            severity: still > errorAfter ? 'error' : 'warn',
            rule: 'deadFrames',
            frameInScene: stillFrom,
            message: `no motion for ${f - stillFrom} f (> ${isHousePack(ctx.project.style) ? 'a few frames of drift' : `${LIVENESS.maxStillSeconds} s`}). The hold is still, not alive.`,
            fix: 'Add secondary motion over the hold: a 2–5 % push, a 10–30 px drift, a backdrop, or staggered chips. Keep the hero readable.',
          }),
        );
        flagged = true; // one finding per still run
      }
    } else {
      prev = sig;
      stillFrom = f;
      flagged = false;
    }
  }
}

function isHeroCandidate(el: Element, project: Project): boolean {
  if (el.type === 'text') return (Number(el.props.fontSize) || 0) >= TYPE_SCALE.title[0] * scale1080(project) * 0.85;
  if (el.type === 'image' || el.type === 'video' || el.type === 'logo') return true;
  const area = el.transform.width * el.transform.height * el.transform.scale * el.transform.scale;
  return area / (project.width * project.height) >= 0.08;
}

function movingAt(ctx: SceneCtx, el: Element, frameInScene: number): boolean {
  const a = evaluateElementWorld(ctx.scene.elements, el, frameInScene);
  const b = evaluateElementWorld(ctx.scene.elements, el, Math.min(ctx.scene.durationInFrames - 1, frameInScene + 1));
  if (!a.active || a.opacity < 0.4) return false;
  return Math.abs(a.x - b.x) > 2 || Math.abs(a.y - b.y) > 2 || Math.abs(a.scale - b.scale) > 0.008 || Math.abs(a.rotation - b.rotation) > 0.4 || revealActive(el, a.localFrame);
}

function checkSimultaneousHeroes(ctx: SceneCtx, add: (f: CritiqueFinding) => void): void {
  const heroes = ctx.scene.elements.filter((el) => el.visible && isHeroCandidate(el, ctx.project));
  if (heroes.length < 2) return;
  const dur = ctx.scene.durationInFrames;
  let run = 0;
  let runAt = 0;
  let runWho: Element[] = [];
  for (let f = 0; f < dur; f++) {
    const moving = heroes.filter((el) => movingAt(ctx, el, f));
    if (moving.length >= 2) {
      if (run === 0) {
        runAt = f;
        runWho = moving;
      }
      run++;
      if (run === 6) {
        add(
          finding(ctx, {
            id: `heroes:${ctx.scene.id}:${runAt}`,
            severity: 'warn',
            rule: 'simultaneousHeroes',
            elementId: runWho[0]?.id,
            elementName: runWho.map((e) => e.name).join(' + '),
            frameInScene: runAt,
            message: `${moving.length} heroes moving at once (${runWho.map((e) => e.name).join(', ')}). One hero per beat.`,
            fix: 'Hold or dim the others to 50–60 % opacity while the hero travels; accent only on the hero.',
          }),
        );
        return;
      }
    } else {
      run = 0;
    }
  }
}

function isSlowDrift(from: number, to: number, frames: number, prop: string): boolean {
  const delta = Math.abs(to - from);
  if (prop === 'scale') return delta <= LIVENESS.push[1] + 0.01 && frames >= 12;
  if (prop === 'x' || prop === 'y') return delta <= 40 && frames >= 12;
  return false;
}

function checkLinearMoves(ctx: SceneCtx, add: (f: CritiqueFinding) => void): void {
  if (!ctx.banned.has('linear-move')) return;
  for (const el of ctx.scene.elements) {
    for (const track of el.tracks) {
      if (track.property === 'opacity') continue;
      for (let i = 0; i < track.keyframes.length - 1; i++) {
        const a = track.keyframes[i];
        const b = track.keyframes[i + 1];
        if (namedEasing(a.easing) !== 'linear') continue;
        if (a.value === b.value) continue;
        if (isSlowDrift(a.value, b.value, b.frame - a.frame, track.property)) continue;
        const start = sceneStartOf(el, byId(ctx.scene));
        add(
          finding(ctx, {
            id: `linear:${el.id}:${track.property}:${a.frame}`,
            severity: 'warn',
            rule: 'linearMove',
            elementId: el.id,
            elementName: el.name,
            frameInScene: Math.max(0, start + a.frame),
            message: `${track.property} eases linear over ${b.frame - a.frame} f (${a.value} → ${b.value}).`,
            fix: 'Arrivals ease out, exits ease in, on-screen moves in-out. Linear only for a slow constant drift or push.',
          }),
        );
        return; // one linear finding per element is enough
      }
    }
  }
}

function checkStagger(ctx: SceneCtx, add: (f: CritiqueFinding) => void): void {
  const groups = new Map<string, Element[]>();
  for (const el of ctx.scene.elements) {
    if (!el.visible) continue;
    const key = el.parentId ?? '';
    const list = groups.get(key) ?? [];
    list.push(el);
    groups.set(key, list);
  }
  for (const siblings of groups.values()) {
    if (siblings.length < 3) continue;
    const byStart = new Map<number, Element[]>();
    for (const el of siblings) {
      const list = byStart.get(el.startFrame) ?? [];
      list.push(el);
      byStart.set(el.startFrame, list);
    }
    for (const [start, bunch] of byStart) {
      if (bunch.length < 3) continue;
      add(
        finding(ctx, {
          id: `stagger:${ctx.scene.id}:${start}`,
          severity: 'warn',
          rule: 'stagger',
          elementId: bunch[0]?.id,
          elementName: bunch.map((e) => e.name).join(', '),
          frameInScene: Math.max(0, start),
          message: `${bunch.length} siblings start on the same frame (${start}). Under 3 f of stagger reads as one block.`,
          fix: `Offset startFrame by the pack stagger (${ctx.project.style?.motion.staggerFrames ?? 4} f) in reading order.`,
        }),
      );
      return;
    }
  }
}

function isFadeAndSlide(el: Element): boolean {
  const op = el.tracks.find((t) => t.property === 'opacity');
  const slide = el.tracks.find((t) => t.property === 'y') ?? el.tracks.find((t) => t.property === 'x');
  if (!slide || slide.keyframes.length < 2) return false;
  const from = slide.keyframes[0]!.value;
  const to = slide.keyframes[1]!.value;
  if (Math.abs(from) < 20 || Math.abs(to) >= 2) return false;
  const fadeTrack = op && op.keyframes.length >= 2 && op.keyframes[0]!.value < 0.15 && op.keyframes[1]!.value > 0.85;
  const reveal = String(el.props.reveal ?? 'none');
  return Boolean(fadeTrack || reveal === 'fadeUp');
}

function overlappingContent(ctx: SceneCtx, glow: Element): boolean {
  const gx = glow.transform.x + glow.transform.width / 2;
  const gy = glow.transform.y + glow.transform.height / 2;
  return ctx.scene.elements.some((el) => {
    if (el.id === glow.id || !el.visible) return false;
    if (!(el.type === 'image' || el.type === 'logo' || el.type === 'video' || el.type === 'uiCard' || el.type === 'text')) return false;
    const cx = el.transform.x + el.transform.width / 2;
    const cy = el.transform.y + el.transform.height / 2;
    const inside = Math.abs(cx - gx) < glow.transform.width * 0.45 && Math.abs(cy - gy) < glow.transform.height * 0.45;
    const smaller = el.transform.width * el.transform.height < glow.transform.width * glow.transform.height;
    return inside && smaller;
  });
}

function checkBannedDetectable(ctx: SceneCtx, add: (f: CritiqueFinding) => void): void {
  const scale = scale1080(ctx.project);
  const pack = packHues(ctx.project);

  if (ctx.banned.has('glow-orb')) {
    for (const el of ctx.scene.elements) {
      if (el.type !== 'shape' || !el.visible) continue;
      if (el.props.shape !== 'ellipse') continue;
      const opacity = el.transform.opacity;
      const short = Math.min(el.transform.width, el.transform.height);
      if (opacity > 0.5 || short < 0.32 * Math.min(ctx.project.width, ctx.project.height)) continue;
      if (overlappingContent(ctx, el)) continue;
      add(
        finding(ctx, {
          id: `glow-orb:${el.id}`,
          severity: 'warn',
          rule: 'banned:glow-orb',
          elementId: el.id,
          elementName: el.name,
          frameInScene: Math.max(0, sceneStartOf(el, byId(ctx.scene))),
          message: `a ${Math.round(el.transform.width)}×${Math.round(el.transform.height)} ellipse at opacity ${opacity} with no hero sitting on it — a glow orb.`,
          fix: 'Delete it, or put a screenshot/logo on it so the glow is a treatment, not the subject.',
        }),
      );
    }
  }

  if (ctx.banned.has('purple-gradient')) {
    let purple = false;
    for (const el of ctx.scene.elements) {
      if (purple) break;
      for (const paint of paintsOf(el)) {
        if (purple) break;
        if (typeof paint === 'string' || (paint.type !== 'linear' && paint.type !== 'radial')) continue;
        for (const stop of paint.stops) {
          const c = parseColor(stop.color);
          if (!c || c[3] < 0.2) continue;
          const { h, s } = hsl([c[0], c[1], c[2]]);
          if (s < 0.25 || h < 255 || h > 310) continue;
          if (hueNearPack(h, pack)) continue;
          add(
            finding(ctx, {
              id: `purple:${el.id}`,
              severity: 'warn',
              rule: 'banned:purple-gradient',
              elementId: el.id,
              elementName: el.name,
              frameInScene: Math.max(0, sceneStartOf(el, byId(ctx.scene))),
              message: `${paint.type} gradient stop ${stop.color} is purple (hue ${Math.round(h)}) and not a pack role.`,
              fix: 'Recolour with the pack accent / accent2 at lower opacity.',
            }),
          );
          purple = true;
          break;
        }
      }
    }
  }

  if (ctx.banned.has('particles')) {
    const dots = ctx.scene.elements.filter((el) => {
      if (!el.visible || (el.type !== 'shape' && el.type !== 'path')) return false;
      const area = el.transform.width * el.transform.height;
      return area <= 48 * 48 * scale * scale;
    });
    if (dots.length >= 6) {
      const sizes = dots.map((d) => d.transform.width);
      const ratio = Math.max(...sizes) / Math.max(1, Math.min(...sizes));
      if (ratio <= 2.2) {
        add(
          finding(ctx, {
            id: `particles:${ctx.scene.id}`,
            severity: 'warn',
            rule: 'banned:particles',
            elementId: dots[0]?.id,
            elementName: dots[0]?.name,
            frameInScene: 0,
            message: `${dots.length} tiny similar shapes — a particle field.`,
            fix: 'Drop the sprinkle. One or two chips that say something, staggered.',
          }),
        );
      }
    }
  }

  if (ctx.banned.has('fade-and-slide')) {
    const movers = ctx.scene.elements.filter((el) => el.visible && el.tracks.length > 0 && el.type !== 'shape' && el.type !== 'path');
    if (movers.length >= 2) {
      const fadeSlide = movers.filter((el) => isFadeAndSlide(el));
      if (fadeSlide.length >= 2 && fadeSlide.length / movers.length >= 0.65) {
        add(
          finding(ctx, {
            id: `fade-slide:${ctx.scene.id}`,
            severity: 'warn',
            rule: 'banned:fade-and-slide',
            frameInScene: 0,
            message: `${fadeSlide.length}/${movers.length} moving elements fade and slide the same way.`,
            fix: 'Give the hero a different entrance (masked rise, wordStagger, overshoot). Fade+slide on every layer is the AI default.',
          }),
        );
      }
    }
  }

  checkLazyDesignDefaults(ctx, add);
}

function checkHeroSize(ctx: SceneCtx, add: (f: CritiqueFinding) => void): void {
  const texts = ctx.scene.elements.filter((el) => el.type === 'text' && el.visible);
  if (!texts.length) return;
  const hero = texts.reduce((a, b) => ((Number(b.props.fontSize) || 0) > (Number(a.props.fontSize) || 0) ? b : a));
  const size = Number(hero.props.fontSize) || 0;
  const cap = size * 0.72;
  // Pulse uses small calm type plus a modest end wordmark; don't flag that as a tiny hero.
  if (isHousePack(ctx.project.style)) return;
  const need = FRAME_USE.heroCapHeightShare * Math.min(ctx.project.width, ctx.project.height);
  // Only on a type-led scene (the biggest text is the subject, not a caption next to a screen).
  const hasScreen = ctx.scene.elements.some((el) => el.type === 'image' || el.type === 'video' || el.type === 'uiCard');
  if (hasScreen || cap + 1 >= need * 0.85) return;
  if (size < TYPE_SCALE.headline[0] * scale1080(ctx.project) * 0.7) return; // already a typeMin or a small label scene
  add(
    finding(ctx, {
      id: `heroSize:${hero.id}`,
      severity: 'warn',
      rule: 'heroSize',
      elementId: hero.id,
      elementName: hero.name,
      frameInScene: Math.max(0, sceneStartOf(hero, byId(ctx.scene))),
      message: `hero cap height ${Math.round(cap)} px is under ${Math.round(need)} px (${Math.round(FRAME_USE.heroCapHeightShare * 100)} % of the frame).`,
      fix: 'Wrap the line rather than shrinking. A statement should own the frame.',
    }),
  );
}

function checkEmptyFrame(ctx: SceneCtx, add: (f: CritiqueFinding) => void): void {
  const mid = Math.floor(ctx.scene.durationInFrames * 0.5);
  const sources = maskSources(ctx.scene);
  let minX = ctx.project.width;
  let minY = ctx.project.height;
  let maxX = 0;
  let maxY = 0;
  let any = false;
  for (const el of ctx.scene.elements) {
    if (!isPainted(el, sources)) continue;
    const w = evaluateElementWorld(ctx.scene.elements, el, mid);
    if (!w.active || w.opacity < 0.12) continue;
    any = true;
    minX = Math.min(minX, w.x);
    minY = Math.min(minY, w.y);
    maxX = Math.max(maxX, w.x + w.width * w.scale);
    maxY = Math.max(maxY, w.y + w.height * w.scale);
  }
  if (!any) return;
  const area = Math.max(0, maxX - minX) * Math.max(0, maxY - minY);
  const share = area / (ctx.project.width * ctx.project.height);
  const maxEmpty = ctx.craft.maxEmptyShare;
  if (share >= 1 - maxEmpty) return;
  const margin = SAFE_MARGIN.min * scale1080(ctx.project);
  const pinned = minX < margin * 1.5 && minY < margin * 1.5 && maxX < ctx.project.width * 0.55 && maxY < ctx.project.height * 0.55;
  add(
    finding(ctx, {
      id: `empty:${ctx.scene.id}`,
      severity: 'warn',
      rule: 'emptyFrame',
      frameInScene: mid,
      message: pinned
        ? `content sits top-left and fills ~${Math.round(share * 100)} % of the frame (default top-left).`
        : `visible content fills ~${Math.round(share * 100)} % of the frame (max empty ${Math.round(maxEmpty * 100)} %).`,
      fix: 'Centre or balance the block; grow the hero; or fill the other half with a screenshot, a texture, or a bigger type.',
    }),
  );
}

function nearest(list: number[], f: number): number | null {
  return list.reduce<number | null>((best, b) => (best === null || Math.abs(b - f) < Math.abs(best - f) ? b : best), null);
}

function checkCutsOnBeat(
  project: Project,
  starts: number[],
  beats: CritiqueBeats | undefined,
  sceneFilter: Set<string> | null,
  add: (f: CritiqueFinding) => void,
): void {
  if (!beats?.beats.length) return;
  if ((beats.confidence ?? 1) < 0.2) return;
  const grid = beats.downbeats?.length ? beats.downbeats : beats.beats;
  project.scenes.forEach((scene, i) => {
    if (i === 0) return;
    if (sceneFilter && !sceneFilter.has(scene.id)) return;
    const f = starts[i] ?? 0;
    const n = nearest(grid, f);
    if (n === null) return;
    const craft = craftOf(project.style);
    const delta = f - n;
    if (Math.abs(delta - craft.beatOffsetFrames) <= craft.beatOffsetWindow) return;
    add({
      id: `cut:${scene.id}`,
      severity: 'warn',
      rule: 'cutOffBeat',
      sceneId: scene.id,
      sceneName: scene.name,
      frame: f,
      frameInScene: 0,
      message: `cut is ${delta} f from the nearest ${beats.downbeats?.length ? 'downbeat' : 'beat'} (frame ${n}); pack wants +${craft.beatOffsetFrames} f (±${craft.beatOffsetWindow}).`,
      fix: 'Change the previous scene’s durationInFrames so this cut lands at the pack beat offset (Pulse: 3–4 frames after the beat). Stretch a reading hold to the next bar rather than shortening it.',
    });
  });
}

const CTA_RE = /\b(try|get|start|sign[\s-]?up|join|subscribe|learn more|early access|free trial|book|download|shop|buy|watch|read more)\b/i;
const LOOP_RE = /\b(again|replay|loop|watch again|from the start)\b/i;
/** Each entry is satisfied by any of its roles: a cut's proof beat is its payoff. */
const REQUIRED_STORY_ROLES: readonly (readonly StoryBeatRole[])[] = [['hook'], ['payoff', 'proof']];

function copyKey(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

function elementText(el: Element): string {
  return String(el.props.text ?? '');
}

function filledScene(scene: Scene): boolean {
  return scene.elements.some((e) => e.visible);
}

function storyContentType(el: Element): boolean {
  return el.type === 'text' || el.type === 'image' || el.type === 'video' || el.type === 'uiCard' || el.type === 'logo' || el.type === 'chatBubble';
}

function atScene(scene: Scene, sceneStart: number, over: Omit<CritiqueFinding, 'sceneId' | 'sceneName' | 'frame'> & { frameInScene: number }): CritiqueFinding {
  return { sceneId: scene.id, sceneName: scene.name, frame: sceneStart + over.frameInScene, ...over };
}

function isReadableHookText(el: Element, opacity: number, scale: number): boolean {
  if (el.type !== 'text' && el.type !== 'chatBubble') return false;
  if (opacity < 0.25) return false;
  const size = Number(el.props.fontSize) || 0;
  const words = wordCount(elementText(el));
  return size >= TYPE_SCALE.body[0] * scale * 0.85 || (words >= 3 && size >= TYPE_MIN.label * scale * 0.85);
}

function visibleAt(scene: Scene, el: Element, frameInScene: number): { opacity: number; active: boolean } {
  const w = evaluateElementWorld(scene.elements, el, frameInScene);
  return { opacity: w.opacity, active: w.active };
}

function checkStoryStructure(
  project: Project,
  starts: number[],
  sceneFilter: Set<string> | null,
  add: (f: CritiqueFinding) => void,
): void {
  const filled = project.scenes.filter(filledScene);
  if (!filled.length) return;
  const fps = project.fps;
  const total = projectDurationInFrames(project);
  if (total <= 0) return;
  const scale = scale1080(project);
  const first = project.scenes[0]!;
  const last = project.scenes[project.scenes.length - 1]!;
  const lastStart = starts[project.scenes.length - 1] ?? 0;
  const whole = !sceneFilter;

  if (whole || sceneFilter.has(first.id)) {
    checkHookAndLogoOpen(project, first, starts[0] ?? 0, fps, total, scale, add);
  }
  if (whole) {
    checkTooManyIdeas(project, first, starts[0] ?? 0, filled, total, fps, add);
    checkTextDensity(project, first, starts[0] ?? 0, total, fps, add);
    checkDeadMiddle(project, starts, total, fps, add);
  }
  if (whole || sceneFilter.has(last.id)) {
    checkPayoffAndEnding(project, starts, last, lastStart, total, fps, scale, add);
  }
  if ((project.story?.beats.length ?? 0) > 0) {
    checkStoryMapping(project, starts, sceneFilter, add);
  }
}

function checkHookAndLogoOpen(
  project: Project,
  first: Scene,
  firstStart: number,
  fps: number,
  total: number,
  scale: number,
  add: (f: CritiqueFinding) => void,
): void {
  const hookEnd = Math.min(total, Math.round(STORY.hookSeconds[1] * fps));
  if (hookEnd <= 0) return;
  let hasHook = false;
  let hasLogo = false;
  let maxText = 0;
  for (let f = 0; f < hookEnd; f++) {
    const loc = locateFrame(project, f);
    if (!loc) break;
    for (const el of loc.scene.elements) {
      if (!el.visible) continue;
      const vis = visibleAt(loc.scene, el, loc.frameInScene);
      if (!vis.active || vis.opacity < 0.25) continue;
      if (el.type === 'logo') hasLogo = true;
      if (el.type === 'text' || el.type === 'chatBubble') maxText = Math.max(maxText, Number(el.props.fontSize) || 0);
      if (isReadableHookText(el, vis.opacity, scale)) hasHook = true;
      if (el.type === 'image' || el.type === 'video' || el.type === 'uiCard' || el.type === 'chatBubble') hasHook = true;
    }
  }
  if (!hasHook) {
    add(
      atScene(first, firstStart, {
        id: `story:noHook:${first.id}`,
        severity: 'warn',
        rule: 'story:noHook',
        frameInScene: 0,
        message: `no readable text, image, video, card or chat in the first ${STORY.hookSeconds[1]} s. A glow or empty plate is not a hook.`,
        fix: `Put a claim, a picture or a move on screen by ${STORY.hookSeconds[0]}–${STORY.hookSeconds[1]} s so someone stops scrolling. Do not open on a logo.`,
      }),
    );
  }
  const titleFloor = TYPE_SCALE.title[0] * scale * 0.65;
  if (hasLogo && maxText < titleFloor) {
    add(
      atScene(first, firstStart, {
        id: `story:logoOpen:${first.id}`,
        severity: 'warn',
        rule: 'story:logoOpen',
        frameInScene: 0,
        message: `opens on a logo or title card (logo visible in the first ${STORY.hookSeconds[1]} s, no headline ≥ ${Math.round(titleFloor)} px).`,
        fix: 'Lead with the idea. Save the logo for the product scene and the end card.',
      }),
    );
  }
}

function checkTooManyIdeas(
  project: Project,
  first: Scene,
  firstStart: number,
  filled: Scene[],
  total: number,
  fps: number,
  add: (f: CritiqueFinding) => void,
): void {
  const seconds = total / fps;
  const avg = seconds / filled.length;
  if (filled.length < STORY.tooManyScenes || avg >= STORY.minSceneSeconds) return;
  add(
    atScene(first, firstStart, {
      id: 'story:tooManyIdeas',
      severity: 'warn',
      rule: 'story:tooManyIdeas',
      frameInScene: 0,
      message: `${filled.length} filled scenes in ${seconds.toFixed(1)} s (avg ${avg.toFixed(1)} s; need ≥ ${STORY.minSceneSeconds} s and fewer than ${STORY.tooManyScenes} ideas).`,
      fix: 'Cut to one idea per scene and give each at least a statement-length hold. Merge leftover cards into the scene that already says that thing.',
    }),
  );
}

function checkTextDensity(
  project: Project,
  first: Scene,
  firstStart: number,
  total: number,
  fps: number,
  add: (f: CritiqueFinding) => void,
): void {
  const seconds = total / fps;
  if (seconds <= 0) return;
  let texts = 0;
  for (const scene of project.scenes) {
    for (const el of scene.elements) {
      if (!el.visible) continue;
      if (el.type !== 'text' && el.type !== 'chatBubble') continue;
      if (wordCount(elementText(el)) >= 1) texts++;
    }
  }
  const rate = texts / seconds;
  if (texts < STORY.tooManyTexts || rate <= STORY.maxTextPerSecond) return;
  add(
    atScene(first, firstStart, {
      id: 'story:textDensity',
      severity: 'warn',
      rule: 'story:textDensity',
      frameInScene: 0,
      message: `${texts} word-bearing texts in ${seconds.toFixed(1)} s (${rate.toFixed(2)} / s; max ${STORY.maxTextPerSecond} / s).`,
      fix: 'One line per beat. Cut captions that repeat the picture; keep the claim, the proof, the payoff.',
    }),
  );
}

function firstHalfCopies(project: Project, starts: number[], half: number): Set<string> {
  const copies = new Set<string>();
  project.scenes.forEach((scene, i) => {
    const sceneStart = starts[i] ?? 0;
    const ids = byId(scene);
    for (const el of scene.elements) {
      if (el.type !== 'text' && el.type !== 'chatBubble') continue;
      const key = copyKey(elementText(el));
      if (!key) continue;
      const land = sceneStart + sceneStartOf(el, ids) + textLandedLocal(el);
      if (land < half) copies.add(key);
    }
  });
  return copies;
}

function textsOverlapping(project: Project, starts: number[], from: number, to: number): Element[] {
  const out: Element[] = [];
  project.scenes.forEach((scene, i) => {
    const sceneStart = starts[i] ?? 0;
    const ids = byId(scene);
    for (const el of scene.elements) {
      if (!el.visible) continue;
      if (el.type !== 'text' && el.type !== 'chatBubble') continue;
      const a = sceneStart + sceneStartOf(el, ids);
      const b = a + el.durationInFrames;
      if (a < to && b > from) out.push(el);
    }
  });
  return out;
}

function checkPayoffAndEnding(
  project: Project,
  starts: number[],
  last: Scene,
  lastStart: number,
  total: number,
  fps: number,
  scale: number,
  add: (f: CritiqueFinding) => void,
): void {
  const payoffStart = Math.floor(total * (1 - STORY.payoffShare));
  const half = total * 0.5;
  const known = firstHalfCopies(project, starts, half);
  const payoffTexts = textsOverlapping(project, starts, payoffStart, total);
  const unique = payoffTexts.filter((el) => {
    const key = copyKey(elementText(el));
    return key && !known.has(key);
  });
  const payoffBlob = payoffTexts.map(elementText).join(' ');
  const hasCta = CTA_RE.test(payoffBlob);
  const hasLoop = LOOP_RE.test(payoffBlob);
  if (!unique.length && !hasCta && !hasLoop) {
    add(
      atScene(last, lastStart, {
        id: 'story:noPayoff',
        severity: 'warn',
        rule: 'story:noPayoff',
        frameInScene: Math.max(0, payoffStart - lastStart),
        message: `last ${Math.round(STORY.payoffShare * 100)} % (${Math.round((total - payoffStart) / fps * 10) / 10} s) has no new copy, CTA or loop-back.`,
        fix: 'End on the one thing we now believe, a CTA, or a loop back to the hook. A second logo is not a payoff.',
      }),
    );
  }

  const lastBlob = last.elements.filter((el) => el.visible && (el.type === 'text' || el.type === 'chatBubble')).map(elementText).join(' ');
  const lastUniqueTitle = last.elements.some((el) => {
    if (!el.visible || (el.type !== 'text' && el.type !== 'chatBubble')) return false;
    const size = Number(el.props.fontSize) || 0;
    if (size < TYPE_SCALE.title[0] * scale * 0.65) return false;
    const key = copyKey(elementText(el));
    return Boolean(key) && !known.has(key);
  });
  if (!CTA_RE.test(lastBlob) && !LOOP_RE.test(lastBlob) && !lastUniqueTitle) {
    add(
      atScene(last, lastStart, {
        id: 'story:unresolvedEnd',
        severity: 'warn',
        rule: 'story:unresolvedEnd',
        frameInScene: 0,
        message: 'ending does not resolve or loop: no CTA, no loop-back, no new title-sized line.',
        fix: 'Close with a CTA, a loop back to the hook, or a concluding line at title size. Do not leave a logo sitting alone.',
      }),
    );
  }
}

function checkDeadMiddle(project: Project, starts: number[], total: number, fps: number, add: (f: CritiqueFinding) => void): void {
  project.scenes.forEach((scene, i) => {
    if (i === 0 || i === project.scenes.length - 1) return;
    if (!filledScene(scene)) return;
    const hasContent = scene.elements.some((el) => el.visible && storyContentType(el));
    if (hasContent) return;
    add(
      atScene(scene, starts[i] ?? 0, {
        id: `story:deadMiddle:${scene.id}`,
        severity: 'warn',
        rule: 'story:deadMiddle',
        frameInScene: 0,
        message: `interior scene "${scene.name}" has no text, image, video, card, logo or chat — a dead middle.`,
        fix: 'Give the middle a beat (setup, tension, proof) or cut it. A glow between two logos is not a story.',
      }),
    );
  });

  const seconds = total / fps;
  if (seconds < STORY.deadMiddleMinSeconds) return;
  const hookEnd = Math.round(STORY.hookSeconds[1] * fps);
  const payoffStart = Math.floor(total * (1 - STORY.payoffShare));
  const lands: number[] = [hookEnd];
  project.scenes.forEach((scene, i) => {
    if (!filledScene(scene)) return;
    const sceneStart = starts[i] ?? 0;
    const ids = byId(scene);
    for (const el of scene.elements) {
      if (!el.visible || (el.type !== 'text' && el.type !== 'chatBubble')) continue;
      if (!wordCount(elementText(el))) continue;
      lands.push(sceneStart + sceneStartOf(el, ids) + textLandedLocal(el));
    }
  });
  lands.push(payoffStart);
  lands.sort((a, b) => a - b);
  const gapNeed = Math.round(STORY.deadMiddleSeconds * fps);
  for (let i = 0; i < lands.length - 1; i++) {
    const a = lands[i]!;
    const b = lands[i + 1]!;
    if (b - a <= gapNeed) continue;
    const mid = Math.floor((a + b) / 2);
    const loc = locateFrame(project, Math.min(total - 1, Math.max(0, mid)));
    if (!loc || !filledScene(loc.scene)) continue;
    const hasContent = loc.scene.elements.some((el) => el.visible && storyContentType(el));
    if (!hasContent && loc.scene.elements.some((el) => el.visible)) {
      // glow-only already flagged as a dead-middle scene
      continue;
    }
    if (!hasContent) continue;
    add(
      atScene(loc.scene, loc.sceneStart, {
        id: `story:deadMiddleGap:${a}`,
        severity: 'warn',
        rule: 'story:deadMiddle',
        frameInScene: loc.frameInScene,
        message: `no new unique text lands for ${Math.round((b - a) / fps * 10) / 10} s in the middle (> ${STORY.deadMiddleSeconds} s).`,
        fix: 'Land a new claim, a proof, or a picture in that stretch, or cut it. The middle has to carry tension, not wait.',
      }),
    );
    return;
  }
}

function checkStoryMapping(
  project: Project,
  starts: number[],
  sceneFilter: Set<string> | null,
  add: (f: CritiqueFinding) => void,
): void {
  const beats = project.story?.beats ?? [];
  const mapped = new Set<string>();
  for (const beat of beats) {
    if (beat.sceneId && project.scenes.some((s) => s.id === beat.sceneId)) mapped.add(beat.sceneId);
    else if (beat.sceneName) {
      const match = project.scenes.find((s) => s.name.trim().toLowerCase() === beat.sceneName!.trim().toLowerCase());
      if (match) mapped.add(match.id);
    }
  }
  project.scenes.forEach((scene, i) => {
    if (sceneFilter && !sceneFilter.has(scene.id)) return;
    if (!filledScene(scene)) return;
    if (mapped.has(scene.id)) return;
    add(
      atScene(scene, starts[i] ?? 0, {
        id: `story:unmappedScene:${scene.id}`,
        severity: 'warn',
        rule: 'story:unmappedScene',
        frameInScene: 0,
        message: `scene "${scene.name}" is not mapped to a story beat.`,
        fix: 'Point a beat at this scene (sceneName / sceneId) or cut the scene. Every scene earns its place in the script.',
      }),
    );
  });
  if (sceneFilter) return;
  const roles = new Set(beats.map((b) => b.role));
  const missing = REQUIRED_STORY_ROLES.filter((any) => !any.some((r) => roles.has(r))).map((any) => any.join('/'));
  if (!missing.length) return;
  const first = project.scenes[0]!;
  add(
    atScene(first, starts[0] ?? 0, {
      id: 'story:missingRoles',
      severity: 'warn',
      rule: 'story:missingRoles',
      frameInScene: 0,
      message: `story.beats is missing ${missing.join(' and ')}.`,
      fix: 'A script needs a hook beat and a payoff (or proof) beat (setup/tension/turn and CTA/loop as the story needs). Write them before building motion.',
    }),
  );
}

function checkEverySceneFades(project: Project, sceneFilter: Set<string> | null, add: (f: CritiqueFinding) => void): void {
  if (sceneFilter) return;
  // Two fades is already the AI default; a single opening fade is fine.
  if (project.scenes.length < 2) return;
  if (!project.scenes.every((s) => s.transitionIn.type === 'fade' && s.transitionIn.durationInFrames > 0)) return;
  const first = project.scenes[0]!;
  add({
    id: 'every-scene-fades',
    severity: 'warn',
    rule: 'banned:every-scene-fades',
    sceneId: first.id,
    sceneName: first.name,
    frame: 0,
    frameInScene: 0,
    message: `all ${project.scenes.length} scenes fade in. A fade on every cut is the AI default.`,
    fix: 'Cut hard on the beat and carry something across (position, colour, a screen). Fade 6–10 f only when nothing carries.',
  });
}

// ---------------------------------------------------------------------------
// Continuity across cuts, and overused design defaults. Everything here is
// checked from the project document alone, without rendering.
// ---------------------------------------------------------------------------

type Axis = 'x' | 'y' | 'z';

interface SeamVec {
  axis: Axis;
  /** +1 or −1 along the axis. On Z, +1 is growing (push). */
  dir: 1 | -1;
  /** Dominant-component speed (px/frame at 1080, or scale/frame × 400 for Z). */
  speed: number;
}

function rgbKey(value: string): string | null {
  const c = parseColor(value);
  if (!c || c[3] < 0.9) return null;
  return `${c[0]},${c[1]},${c[2]}`;
}

function packRgb(project: Project): Set<string> {
  const out = new Set<string>();
  const colors = project.style?.colors;
  if (!colors) return out;
  for (const value of Object.values(colors)) {
    if (!value) continue;
    const key = rgbKey(value);
    if (key) out.add(key);
  }
  return out;
}

function isPureBlack(value: string): boolean {
  const c = parseColor(value);
  return Boolean(c && c[3] >= 0.9 && c[0] <= 2 && c[1] <= 2 && c[2] <= 2);
}

function isPureWhite(value: string): boolean {
  const c = parseColor(value);
  return Boolean(c && c[3] >= 0.9 && c[0] >= 253 && c[1] >= 253 && c[2] >= 253);
}

function sceneLuminance(bg: string): number | null {
  const c = parseColor(bg);
  if (!c) return null;
  const lin = (v: number) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
}

function velocityAt(scene: Scene, el: Element, frameInScene: number): { dx: number; dy: number; ds: number; active: boolean } {
  const last = Math.max(0, scene.durationInFrames - 1);
  const a = evaluateElementWorld(scene.elements, el, frameInScene);
  const b = evaluateElementWorld(scene.elements, el, Math.min(last, frameInScene + 1));
  if (!a.active || a.opacity < 0.2) return { dx: 0, dy: 0, ds: 0, active: false };
  return { dx: b.x - a.x, dy: b.y - a.y, ds: b.scale - a.scale, active: true };
}

/** The same screenshot or card in the same box on both sides of a cut: the shot continues, so a still cut is fine. */
function isOneTake(a: Scene, b: Scene): boolean {
  const carriers = (scene: Scene) =>
    scene.elements.filter((el) => el.visible && (el.type === 'image' || el.type === 'video' || el.type === 'uiCard'));
  for (const left of carriers(a)) {
    for (const right of carriers(b)) {
      const sameBox =
        Math.abs(left.transform.x - right.transform.x) < 24 &&
        Math.abs(left.transform.y - right.transform.y) < 24 &&
        Math.abs(left.transform.width - right.transform.width) < 24 &&
        Math.abs(left.transform.height - right.transform.height) < 24;
      if (sameBox) return true;
    }
  }
  return false;
}

function windowMotion(scene: Scene, project: Project, from: number, to: number): { vec: SeamVec | null; drifting: boolean } {
  const scale = scale1080(project);
  const minPx = SEAM.minSpeedPx * scale;
  const heroes = scene.elements.filter((el) => el.visible && isHeroCandidate(el, project));
  const story = scene.elements.filter((el) => el.visible && storyContentType(el));
  // Pulse (and similar) heroes are often a springing mark — a shape, not type.
  const marks = scene.elements.filter((el) => el.visible && (el.type === 'shape' || el.type === 'group'));
  const pool = heroes.length ? heroes : story.length ? story : marks;
  let best: SeamVec | null = null;
  let bestMag = 0;
  let drifting = false;
  for (const el of pool) {
    let dx = 0;
    let dy = 0;
    let ds = 0;
    let n = 0;
    for (let f = from; f < to; f++) {
      const v = velocityAt(scene, el, f);
      if (!v.active) continue;
      dx += v.dx;
      dy += v.dy;
      ds += v.ds;
      n++;
    }
    if (!n) continue;
    dx /= n;
    dy /= n;
    ds /= n;
    // A 2–5 % push or a pack-rate drift over a hold is purposeful, not a dead settle.
    const driftFloor = Math.min(0.12, Math.max(0.04, craftOf(project.style).driftPxPerFrame * 0.08)) * scale;
    if (Math.abs(dx) + Math.abs(dy) > driftFloor || Math.abs(ds) > 0.00015) drifting = true;
    const z = Math.abs(ds) * 400;
    const magX = Math.abs(dx);
    const magY = Math.abs(dy);
    const dominant = z >= magX && z >= magY ? 'z' : magX >= magY ? 'x' : 'y';
    const raw = dominant === 'z' ? ds : dominant === 'x' ? dx : dy;
    const mag = dominant === 'z' ? z : Math.abs(raw);
    const moving = dominant === 'z' ? Math.abs(ds) >= SEAM.minScalePerFrame : mag >= minPx;
    if (!moving || mag <= bestMag) continue;
    bestMag = mag;
    best = { axis: dominant, dir: raw >= 0 ? 1 : -1, speed: mag };
  }
  return { vec: best, drifting };
}

function checkSeamContinuity(
  project: Project,
  starts: number[],
  sceneFilter: Set<string> | null,
  add: (f: CritiqueFinding) => void,
): void {
  const fps = project.fps;
  const sample = Math.max(3, Math.round(SEAM.sampleSeconds * fps));
  project.scenes.forEach((incoming, i) => {
    if (i === 0) return;
    const outgoing = project.scenes[i - 1]!;
    if (!filledScene(outgoing) || !filledScene(incoming)) return;
    if (sceneFilter && !sceneFilter.has(incoming.id) && !sceneFilter.has(outgoing.id)) return;
    const outFrom = Math.max(0, outgoing.durationInFrames - sample);
    const inTo = Math.min(incoming.durationInFrames, sample);
    const exit = windowMotion(outgoing, project, outFrom, outgoing.durationInFrames);
    const entry = windowMotion(incoming, project, 0, inTo);
    const cut = starts[i] ?? 0;
    if (isOneTake(outgoing, incoming)) return;
    if (!exit.drifting && !entry.drifting) {
      add({
        id: `seam:settle:${incoming.id}`,
        severity: 'warn',
        rule: 'seam:settle',
        sceneId: incoming.id,
        sceneName: incoming.name,
        frame: cut,
        frameInScene: 0,
        message: `cut at frame ${cut} settles on both sides (last ${sample} f of "${outgoing.name}" and first ${sample} f of "${incoming.name}" are still).`,
        fix: `Cut while things are moving: let the outgoing hero keep travelling into the cut and have the incoming one enter already moving along the same axis (default direction: ${SEAM.current}).`,
      });
      return;
    }
    if (!exit.vec || !entry.vec) return;
    if (exit.vec.axis !== entry.vec.axis) {
      add({
        id: `seam:axis:${incoming.id}`,
        severity: 'warn',
        rule: 'seam:axis',
        sceneId: incoming.id,
        sceneName: incoming.name,
        frame: cut,
        frameInScene: 0,
        message: `cut trades axes (${exit.vec.axis} out → ${entry.vec.axis} in) between "${outgoing.name}" and "${incoming.name}".`,
        fix: 'Move along the same axis on both sides of the cut: horizontal with horizontal, vertical with vertical, scale with scale. A common slip is an exit that shrinks away followed by an entry that grows in.',
      });
      return;
    }
    if (exit.vec.dir !== entry.vec.dir) {
      add({
        id: `seam:direction:${incoming.id}`,
        severity: 'warn',
        rule: 'seam:direction',
        sceneId: incoming.id,
        sceneName: incoming.name,
        frame: cut,
        frameInScene: 0,
        message: `${exit.vec.axis}-axis direction flips at the cut (${exit.vec.dir > 0 ? '+' : '−'} out → ${entry.vec.dir > 0 ? '+' : '−'} in).`,
        fix: 'Keep travelling the same way through the cut: an exit to the left wants an entry that also moves left, and a shrinking exit should not be followed by something growing in.',
      });
      return;
    }
    const faster = Math.max(exit.vec.speed, entry.vec.speed);
    const slower = Math.max(0.0001, Math.min(exit.vec.speed, entry.vec.speed));
    if (faster / slower > SEAM.speedRatioWarn) {
      add({
        id: `seam:speed:${incoming.id}`,
        severity: 'warn',
        rule: 'seam:speed',
        sceneId: incoming.id,
        sceneName: incoming.name,
        frame: cut,
        frameInScene: 0,
        message: `entry/exit speeds differ by ${(faster / slower).toFixed(1)}× on ${exit.vec.axis} (need ≤ ${SEAM.speedRatioWarn}×).`,
        fix: `Give both sides a similar distance and duration so the incoming move continues at the outgoing speed. An exit takes about ${SEAM.exitRatio}× as long as its entry.`,
      });
    }
  });
}

function revealIsStagger(el: Element): boolean {
  const reveal = String(el.props.reveal ?? 'none');
  return reveal === 'wordStagger' || UNIT_REVEALS.has(reveal);
}

/** First-to-last key in a share of the element. `arrivalOnly` skips hold-pushes that start later. */
function spanInShare(el: Element, fromShare: number, toShare: number, arrivalOnly = false): number {
  const lo = el.durationInFrames * fromShare;
  const hi = el.durationInFrames * toShare;
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  const visit = (frame: number, a: number, b: number, start: number) => {
    if (arrivalOnly && start > 8) return;
    if (frame < lo || frame > hi) return;
    if (a === b) return;
    min = Math.min(min, frame);
    max = Math.max(max, frame);
  };
  for (const track of el.tracks) {
    for (let i = 0; i < track.keyframes.length - 1; i++) {
      const a = track.keyframes[i]!;
      const b = track.keyframes[i + 1]!;
      visit(a.frame, a.value, b.value, a.frame);
      visit(b.frame, a.value, b.value, a.frame);
    }
  }
  if (!Number.isFinite(min)) return 0;
  return Math.max(0, max - min);
}

/** Arrival keys that are a one-way drift or a pack camera push — the hold, not an entry. */
function arrivalIsCraftHold(el: Element, craft: StyleCraft): boolean {
  let saw = false;
  for (const track of el.tracks) {
    if (track.property === 'opacity') continue;
    for (let i = 0; i < track.keyframes.length - 1; i++) {
      const a = track.keyframes[i]!;
      const b = track.keyframes[i + 1]!;
      if (a.frame > 8) continue;
      if (a.value === b.value) continue;
      saw = true;
      const frames = b.frame - a.frame;
      if (isSlowDrift(a.value, b.value, frames, track.property)) continue;
      const camera = frames >= craft.cameraFrames.min && frames <= craft.cameraFrames.max + 12;
      const travel = Math.abs(b.value - a.value);
      const small = track.property === 'scale' ? travel <= 0.08 : travel <= 48;
      if (camera && small) continue;
      return false;
    }
  }
  return saw;
}

function checkEntryExitTiming(ctx: SceneCtx, add: (f: CritiqueFinding) => void): void {
  const fps = ctx.project.fps;
  // 800 ms is the craft target; warn only when clearly over (~1.2 s), not on a 0.7 s riseIn.
  // Pulse pops (2–4 f) sit well under this; camera/drift (66–96 f) is the hold.
  const maxEntry = Math.max(Math.round(1.2 * fps), Math.round(SEAM.maxEntrySeconds * fps * (ctx.project.style?.motion.timingScale ?? 1)));
  const ids = byId(ctx.scene);
  for (const el of ctx.scene.elements) {
    if (!el.visible || revealIsStagger(el)) continue;
    const entry = spanInShare(el, 0, 0.6, true);
    if (entry > maxEntry + 2 && !arrivalIsCraftHold(el, ctx.craft)) {
      add(
        finding(ctx, {
          id: `seam:entry:${el.id}`,
          severity: 'warn',
          rule: 'seam:entry',
          elementId: el.id,
          elementName: el.name,
          frameInScene: Math.max(0, sceneStartOf(el, ids)),
          message: `entrance spans ${entry} f (> ${maxEntry} f / ${SEAM.maxEntrySeconds} s × timingScale).`,
          fix: `Let one element finish entering within ${SEAM.maxEntrySeconds} s. For a longer build, bring in several elements one after another instead of slowing one down.`,
        }),
      );
    }
    const exit = spanInShare(el, 0.6, 1);
    if (entry >= 6 && exit >= 6 && exit > entry * SEAM.exitRatio * 1.2) {
      add(
        finding(ctx, {
          id: `seam:exit:${el.id}`,
          severity: 'warn',
          rule: 'seam:exit',
          elementId: el.id,
          elementName: el.name,
          frameInScene: Math.max(0, sceneStartOf(el, ids) + Math.round(el.durationInFrames * 0.6)),
          message: `exit spans ${exit} f vs entry ${entry} f (want ≈ ${SEAM.exitRatio}×).`,
          fix: `Shorten the exit to about ${Math.round(entry * SEAM.exitRatio)} f, or cut before it finishes and let the next scene continue the move.`,
        }),
      );
    }
  }
}

function idleReversals(el: Element): { track: string; reversals: number } | null {
  for (const track of el.tracks) {
    if (track.property === 'opacity') continue;
    const keys = track.keyframes;
    if (keys.length < 4) continue;
    let lastDir = 0;
    let reversals = 0;
    const amps: number[] = [];
    for (let i = 0; i < keys.length - 1; i++) {
      const d = keys[i + 1]!.value - keys[i]!.value;
      if (Math.abs(d) < 1e-4) continue;
      const dir = d > 0 ? 1 : -1;
      amps.push(Math.abs(d));
      if (lastDir && dir !== lastDir) reversals++;
      lastDir = dir;
    }
    if (reversals < SEAM.idleReversals || amps.length < 3) continue;
    const max = Math.max(...amps);
    const min = Math.min(...amps);
    if (max / Math.max(min, 1e-4) > 2.8) continue; // a settle or a real accent, not a loop
    return { track: track.property, reversals };
  }
  return null;
}

function checkIdleWobble(ctx: SceneCtx, add: (f: CritiqueFinding) => void): void {
  if (!ctx.banned.has('idle-wobble')) return;
  for (const el of ctx.scene.elements) {
    if (!el.visible) continue;
    const hit = idleReversals(el);
    if (!hit) continue;
    add(
      finding(ctx, {
        id: `idle-wobble:${el.id}`,
        severity: 'warn',
        rule: 'banned:idle-wobble',
        elementId: el.id,
        elementName: el.name,
        frameInScene: Math.max(0, sceneStartOf(el, byId(ctx.scene))),
        message: `${hit.track} changes direction ${hit.reversals} times: it bobs back and forth instead of moving one way.`,
        fix: 'A slow move in one direction (10–30 px, or a 2–5 % push) keeps a hold alive. Floating or pulsing back and forth only fills time: add a reveal or some product UI activity, or cut earlier.',
      }),
    );
    return;
  }
}

function checkStillnessBeforeClimax(ctx: SceneCtx, add: (f: CritiqueFinding) => void): void {
  // Hooks are supposed to land fast; the comma belongs on a later beat.
  if (ctx.sceneStart === 0) return;
  const fps = ctx.project.fps;
  const scale = scale1080(ctx.project);
  const ids = byId(ctx.scene);
  const minGap = Math.round(SEAM.stillnessSeconds[0] * fps);
  let climaxAt = -1;
  let climax: Element | null = null;
  for (const el of ctx.scene.elements) {
    if (!el.visible || (el.type !== 'text' && el.type !== 'chatBubble')) continue;
    const size = Number(el.props.fontSize) || 0;
    if (size < TYPE_SCALE.title[0] * scale * 0.7) continue;
    const land = sceneStartOf(el, ids) + textLandedLocal(el);
    if (land >= climaxAt) {
      climaxAt = land;
      climax = el;
    }
  }
  if (!climax || climaxAt < 0) return;
  let actionEnd = -1;
  for (const el of ctx.scene.elements) {
    // Text-to-text stagger is overlap, not a missing comma.
    if (!el.visible || el.id === climax.id || el.type === 'text' || el.type === 'chatBubble') continue;
    const start = sceneStartOf(el, ids);
    for (const track of el.tracks) {
      if (track.property === 'opacity') continue;
      for (let i = 0; i < track.keyframes.length - 1; i++) {
        const a = track.keyframes[i]!;
        const b = track.keyframes[i + 1]!;
        const end = start + b.frame;
        if (end > climaxAt) continue;
        const delta = Math.abs(b.value - a.value);
        const big = track.property === 'scale' ? delta >= 0.2 : delta >= 160 * scale;
        if (!big) continue;
        actionEnd = Math.max(actionEnd, end);
      }
    }
  }
  if (actionEnd < 0) return;
  const gap = climaxAt - actionEnd;
  // FOLLOW_FRAMES is 2–4 f (a card then its copy). Only a slam that lands
  // on the result (0–1 f) is a missing comma — goldens use the 2 f follow.
  if (gap < 0 || gap >= Math.min(minGap, 2)) return;
  add(
    finding(ctx, {
      id: `seam:stillness:${ctx.scene.id}`,
      severity: 'warn',
      rule: 'seam:stillness',
      elementId: climax.id,
      elementName: climax.name,
      frameInScene: Math.max(0, actionEnd),
      message: `${gap} f between the last big move and "${climax.name}" landing (need ${SEAM.stillnessSeconds[0]}–${SEAM.stillnessSeconds[1]} s).`,
      fix: `After the big move, pause ${SEAM.stillnessSeconds[0]}–${SEAM.stillnessSeconds[1]} s before the result lands. Give the pause as an exact number of frames.`,
    }),
  );
}

function checkLazyDesignDefaults(ctx: SceneCtx, add: (f: CritiqueFinding) => void): void {
  const pack = packRgb(ctx.project);
  const packH = packHues(ctx.project);
  const ids = byId(ctx.scene);
  const scale = scale1080(ctx.project);
  const lum = sceneLuminance(ctx.scene.backgroundColor);

  if (ctx.banned.has('gradient-text')) {
    for (const el of ctx.scene.elements) {
      if (el.type !== 'text' || !el.visible) continue;
      // text.color is typed as a string; agents still put gradient paints here.
      const paint = paintsOf(el).find((p) => typeof p !== 'string' && (p.type === 'linear' || p.type === 'radial'));
      if (!paint || typeof paint === 'string') continue;
      add(
        finding(ctx, {
          id: `gradient-text:${el.id}`,
          severity: 'warn',
          rule: 'banned:gradient-text',
          elementId: el.id,
          elementName: el.name,
          frameInScene: Math.max(0, sceneStartOf(el, ids)),
          message: `text is filled with a ${paint.type} gradient, an overused default for display type.`,
          fix: 'Use a solid pack text or accent colour. For emphasis, change the weight or size instead.',
        }),
      );
      break;
    }
  }

  if (ctx.banned.has('cyan-neon') && lum !== null && lum < 0.22) {
    let cyanHit = false;
    for (const el of ctx.scene.elements) {
      if (!el.visible) continue;
      for (const paint of paintsOf(el)) {
        for (const stop of colourStops(paint)) {
          const c = parseColor(stop);
          if (!c || c[3] < 0.45) continue;
          const key = rgbKey(stop);
          if (key && pack.has(key)) continue;
          const { h, s, l } = hsl([c[0], c[1], c[2]]);
          const cyan = h >= 165 && h <= 205 && s >= 0.45 && l >= 0.35 && l <= 0.72;
          const neonPurple = h >= 255 && h <= 290 && s >= 0.45 && l >= 0.35;
          if (!cyan && !neonPurple) continue;
          if (hueNearPack(h, packH)) continue;
          add(
            finding(ctx, {
              id: `cyan-neon:${el.id}`,
              severity: 'warn',
              rule: 'banned:cyan-neon',
              elementId: el.id,
              elementName: el.name,
              frameInScene: Math.max(0, sceneStartOf(el, ids)),
              message: `${stop} on a dark plate is ${cyan ? 'cyan neon' : 'purple neon'} and not a pack role (hue ${Math.round(h)}).`,
              fix: 'Use the pack accent or accent2, at a lower opacity if needed, instead of a new neon colour.',
            }),
          );
          cyanHit = true;
          break;
        }
        if (cyanHit) break;
      }
      if (cyanHit) break;
    }
  }

  // Plates only — #fff type on a dark pack is on-accent / contrast, not a lazy default.
  if (ctx.banned.has('pure-black-white')) {
    const bg = ctx.scene.backgroundColor;
    const bgKey = rgbKey(bg);
    if ((isPureBlack(bg) || isPureWhite(bg)) && (!bgKey || !pack.has(bgKey))) {
      add(
        finding(ctx, {
          id: `pure-plate:${ctx.scene.id}`,
          severity: 'warn',
          rule: 'banned:pure-black-white',
          frameInScene: 0,
          message: `scene plate is ${bg} (pure black/white) and not a pack role.`,
          fix: 'Use the pack background colour, or tint the plate slightly toward the accent.',
        }),
      );
    }
  }

  if (ctx.banned.has('identical-cards')) {
    const plates = ctx.scene.elements.filter((el) => {
      if (!el.visible) return false;
      if (el.type !== 'shape' && el.type !== 'uiCard') return false;
      if (el.type === 'shape' && el.props.shape && el.props.shape !== 'rect') return false;
      const area = el.transform.width * el.transform.height;
      const share = area / (ctx.project.width * ctx.project.height);
      return share >= 0.04 && share <= 0.28;
    });
    const groups = new Map<string, Element[]>();
    for (const el of plates) {
      const w = Math.round(el.transform.width / 8);
      const h = Math.round(el.transform.height / 8);
      const key = `${w}x${h}`;
      const list = groups.get(key) ?? [];
      list.push(el);
      groups.set(key, list);
    }
    for (const bunch of groups.values()) {
      if (bunch.length < 3) continue;
      const starts = new Set(bunch.map((el) => el.startFrame));
      const copies = new Set(
        bunch.map((el) => {
          const nearby = ctx.scene.elements.find((t) => t.type === 'text' && t.visible && Math.abs(t.transform.x - el.transform.x) < 48 && Math.abs(t.transform.y - el.transform.y) < el.transform.height);
          return nearby ? copyKey(elementText(nearby)) : '';
        }),
      );
      copies.delete('');
      if (starts.size > 1 && copies.size > 1) continue;
      add(
        finding(ctx, {
          id: `identical-cards:${ctx.scene.id}`,
          severity: 'warn',
          rule: 'banned:identical-cards',
          elementId: bunch[0]?.id,
          elementName: bunch.map((e) => e.name).join(', '),
          frameInScene: Math.max(0, bunch[0]?.startFrame ?? 0),
          message: `${bunch.length} same-size cards with ${starts.size === 1 ? 'the same start frame' : 'the same or empty copy'}.`,
          fix: 'Stagger the cards’ arrivals and give each its own copy, or show one hero card instead of repeating a tile.',
        }),
      );
      break;
    }
  }

  if (ctx.banned.has('edge-stripe')) {
    for (const el of ctx.scene.elements) {
      if (el.type !== 'shape' || !el.visible || el.props.shape !== 'rect') continue;
      if (el.transform.width > 16 * scale || el.transform.height < 72 * scale) continue;
      const host = ctx.scene.elements.find((other) => {
        if (other.id === el.id || !other.visible) return false;
        if (other.type !== 'shape' && other.type !== 'uiCard') return false;
        const left = Math.abs(other.transform.x - el.transform.x) < 8 * scale;
        const tall = Math.abs(other.transform.height - el.transform.height) < 24 * scale;
        return left && tall && other.transform.width > el.transform.width * 4;
      });
      if (!host) continue;
      add(
        finding(ctx, {
          id: `edge-stripe:${el.id}`,
          severity: 'warn',
          rule: 'banned:edge-stripe',
          elementId: el.id,
          elementName: el.name,
          frameInScene: Math.max(0, sceneStartOf(el, ids)),
          message: `a ${Math.round(el.transform.width)} px bar on the left of "${host.name}" — a left-edge accent stripe.`,
          fix: 'Remove the stripe and show hierarchy with type size, weight or a real icon.',
        }),
      );
      break;
    }
  }
}
