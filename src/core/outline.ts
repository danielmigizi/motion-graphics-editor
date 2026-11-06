// Brief → outline → scenes. Pure pieces of the "New video" flow: the brief,
// validating an agent's outline, editing it, turning an approved outline into
// a project skeleton (one empty scene per item), and the two messages sent to
// the chat agent (draft an outline; build the approved one).

import { z } from 'zod';
import type { OutlineDraft, OutlineScene, OutlineSceneDraft, UploadAssetResponse } from './api-contract';
import { SEEDED_BANNED } from './critique';
import {
  EXIT_RATIO,
  FRAME_USE,
  LIVENESS,
  READING,
  SCENE_BANDS,
  SEAM,
  STAGGER_FRAMES,
  STORY,
  TIMING_BANDS,
  TYPE_MIN,
  TYPE_SCALE,
} from './motionRules';
import { STYLE_PACKS, STYLE_PACK_NOTES, type StylePackId } from './style';
import { craftLine, craftOf, HOUSE_PACK_ID } from './styleCraft';
import { routeWorkflow, workflowLine } from './workflow';
import { TEMPLATES, TEMPLATE_IDS } from './templates';
import { PROJECT_SCHEMA_VERSION, STORY_BEAT_ROLES } from './types';
import type { Asset, AudioClip, Project, ProjectStory, Scene, StoryBeat, StylePack } from './types';

// ---------------------------------------------------------------------------
// Brief
// ---------------------------------------------------------------------------

export type AspectId = '16:9' | '1:1' | '9:16' | '4:5';

export const ASPECTS: readonly { id: AspectId; label: string; width: number; height: number }[] = [
  { id: '16:9', label: 'Landscape', width: 1920, height: 1080 },
  { id: '1:1', label: 'Square', width: 1080, height: 1080 },
  { id: '9:16', label: 'Vertical', width: 1080, height: 1920 },
  { id: '4:5', label: 'Portrait', width: 1080, height: 1350 },
];

export const FPS_CHOICES = [24, 25, 30, 60] as const;

/** Target length of a new video, seconds. */
export const LENGTH_RANGE = { min: 15, max: 90 } as const;

/** A brand file already uploaded to the server; `id` becomes its asset id. */
export interface BrandFile extends UploadAssetResponse {
  id: string;
}

export interface VideoBrief {
  brief: string;
  audience: string;
  tone: string;
  targetSeconds: number;
  width: number;
  height: number;
  fps: number;
  backgroundColor: string;
  brandColors: string[];
  files: BrandFile[];
  /** A file in `files` that is the logo. */
  logoId?: string;
  /** The Music step. */
  music?: BriefMusic;
}

/** Music for a new video: a chosen track, and/or a mood for the agent. */
export interface BriefMusic {
  /** An audio file in `files` to use as the music bed (otherwise the first audio file is). */
  fileId?: string;
  /** "Describe the mood", for the agent (e.g. "upbeat, 120 bpm, no vocals"). */
  mood?: string;
  /** The user wants scene lengths to land on the track's downbeats. */
  snapToBeats?: boolean;
  /** The chosen track's analysis (the beats endpoint), in seconds. */
  tempo?: BriefTempo;
}

export interface BriefTempo {
  bpm: number | null;
  confidence: number;
  durationSeconds: number;
  /** Bar starts, seconds from the start of the track. */
  downbeatSeconds: number[];
}

/** The track that becomes the music bed: the chosen one, else the first audio file. */
export function musicFile(brief: VideoBrief): BrandFile | undefined {
  const audio = brief.files.filter((f) => f.kind === 'audio');
  return audio.find((f) => f.id === brief.music?.fileId) ?? audio[0];
}

/** The likeliest logo among brand files: one named like a logo, else an SVG, else the first image. */
export function likelyLogo(files: readonly BrandFile[]): string | undefined {
  const visual = files.filter((f) => f.kind !== 'audio');
  return (visual.find((f) => /logo|wordmark|brand/i.test(f.name)) ?? visual.find((f) => f.kind === 'svg') ?? visual[0])?.id;
}

export function aspectOf(width: number, height: number): AspectId | null {
  return ASPECTS.find((a) => a.width === width && a.height === height)?.id ?? null;
}

/** Brand files as project assets, at the brief's frame rate. The logo is named so. */
export function brandAssets(brief: VideoBrief): Asset[] {
  return brief.files.map((f) => {
    const asset: Asset = { id: f.id, kind: f.kind, name: f.id === brief.logoId ? `Logo (${f.name})` : f.name, src: f.src, mimeType: f.mimeType };
    if (f.width) asset.width = f.width;
    if (f.height) asset.height = f.height;
    if (f.durationSeconds) asset.durationInFrames = Math.max(1, Math.round(f.durationSeconds * brief.fps));
    return asset;
  });
}

// ---------------------------------------------------------------------------
// Outline
// ---------------------------------------------------------------------------

export interface Outline {
  title: string;
  scenes: OutlineScene[];
  story?: ProjectStory;
}

export const OUTLINE_LIMITS = { maxScenes: 24, minSeconds: 0.5, maxSeconds: 60 } as const;

/** Field schemas of one outline scene (the MCP tool adds descriptions to these). */
export const outlineSceneFields = {
  name: z.string().trim().min(1).max(80),
  purpose: z.string().max(500),
  durationSeconds: z.number().min(OUTLINE_LIMITS.minSeconds).max(OUTLINE_LIMITS.maxSeconds),
  onScreenText: z.string().max(500).optional(),
  visuals: z.string().max(800).optional(),
  templateHints: z.array(z.string().max(40)).max(8).optional(),
};

export const outlineTitleField = z.string().trim().min(1).max(120);

export const outlineStoryBeatFields = {
  role: z.enum(STORY_BEAT_ROLES),
  summary: z.string().trim().min(1).max(400),
  sceneName: z.string().trim().min(1).max(80).optional(),
  fromSeconds: z.number().min(0).max(120).optional(),
  toSeconds: z.number().min(0).max(120).optional(),
};

export const outlineStoryFields = {
  idea: z.string().trim().min(1).max(400),
  hook: z.string().trim().min(1).max(400),
  audience: z.string().max(400).optional(),
  tension: z.string().max(400).optional(),
  payoff: z.string().trim().min(1).max(400),
  cta: z.string().max(400).optional(),
  beats: z.array(z.object(outlineStoryBeatFields)).min(1).max(OUTLINE_LIMITS.maxScenes),
};

const OutlineDraftSchema = z.object({
  title: outlineTitleField,
  scenes: z.array(z.object(outlineSceneFields)).min(1).max(OUTLINE_LIMITS.maxScenes),
  story: z.object(outlineStoryFields).optional(),
});

export type ParsedOutline = { ok: true; outline: Outline } | { ok: false; message: string; path?: string };

/** Validate an agent's outline and give its scenes ids. */
export function parseOutline(input: unknown): ParsedOutline {
  const r = OutlineDraftSchema.safeParse(input);
  if (!r.success) {
    const issue = r.error.issues[0];
    const path = issue.path.join('.');
    return { ok: false, message: `${path ? `${path}: ` : ''}${issue.message}`, ...(path ? { path } : {}) };
  }
  const story = r.data.story ? cleanStory(r.data.story) : undefined;
  return { ok: true, outline: { title: r.data.title, scenes: r.data.scenes.map((s, i) => ({ id: `ol_${i + 1}`, ...clean(s) })), ...(story ? { story } : {}) } };
}

/** Drop empty optional text so the outline stays tidy. */
function clean(s: OutlineSceneDraft): OutlineSceneDraft {
  const out: OutlineSceneDraft = { name: s.name.trim(), purpose: s.purpose.trim(), durationSeconds: s.durationSeconds };
  if (s.onScreenText?.trim()) out.onScreenText = s.onScreenText.trim();
  if (s.visuals?.trim()) out.visuals = s.visuals.trim();
  const hints = s.templateHints?.map((h) => h.trim()).filter(Boolean);
  if (hints?.length) out.templateHints = hints;
  return out;
}

function cleanStory(s: ProjectStory): ProjectStory {
  const out: ProjectStory = {
    idea: s.idea.trim(),
    hook: s.hook.trim(),
    payoff: s.payoff.trim(),
    beats: s.beats.map((b) => {
      const beat: StoryBeat = { role: b.role, summary: b.summary.trim() };
      if (b.sceneName?.trim()) beat.sceneName = b.sceneName.trim();
      if (b.fromSeconds !== undefined) beat.fromSeconds = b.fromSeconds;
      if (b.toSeconds !== undefined) beat.toSeconds = b.toSeconds;
      if (b.sceneId) beat.sceneId = b.sceneId;
      if (b.fromFrame !== undefined) beat.fromFrame = b.fromFrame;
      if (b.toFrame !== undefined) beat.toFrame = b.toFrame;
      return beat;
    }),
  };
  if (s.audience?.trim()) out.audience = s.audience.trim();
  if (s.tension?.trim()) out.tension = s.tension.trim();
  if (s.cta?.trim()) out.cta = s.cta.trim();
  return out;
}

const roundSeconds = (s: number) => Math.round(s * 10) / 10;

export function draftOf(outline: Outline): OutlineDraft {
  return { title: outline.title, scenes: outline.scenes.map(({ id: _id, notes: _notes, ...rest }) => rest), ...(outline.story ? { story: outline.story } : {}) };
}

/**
 * Stamp outline story beats onto the skeleton: resolve sceneName → sceneId
 * and seconds → frames (or the scene's range when seconds are omitted).
 */
export function stampStory(story: ProjectStory | undefined, scenes: readonly Scene[], fps: number): ProjectStory | undefined {
  if (!story) return undefined;
  const byName = new Map(scenes.map((s) => [s.name.trim().toLowerCase(), s]));
  const starts = new Map<string, number>();
  let acc = 0;
  for (const s of scenes) {
    starts.set(s.id, acc);
    acc += s.durationInFrames;
  }
  return {
    ...story,
    beats: story.beats.map((b) => {
      const scene = b.sceneName ? byName.get(b.sceneName.trim().toLowerCase()) : undefined;
      const start = scene ? starts.get(scene.id) : undefined;
      const fromFrame = b.fromSeconds !== undefined ? Math.round(b.fromSeconds * fps) : start;
      const toFrame = b.toSeconds !== undefined ? Math.round(b.toSeconds * fps) : scene && start !== undefined ? start + scene.durationInFrames : undefined;
      const beat: StoryBeat = { role: b.role, summary: b.summary };
      if (b.sceneName) beat.sceneName = b.sceneName;
      if (scene) beat.sceneId = scene.id;
      if (fromFrame !== undefined) beat.fromFrame = fromFrame;
      if (toFrame !== undefined) beat.toFrame = toFrame;
      if (b.fromSeconds !== undefined) beat.fromSeconds = b.fromSeconds;
      if (b.toSeconds !== undefined) beat.toSeconds = b.toSeconds;
      return beat;
    }),
  };
}

export const outlineSeconds = (outline: Outline) => outline.scenes.reduce((n, s) => n + s.durationSeconds, 0);

/** "12 s", "4.5 s". */
export const formatSeconds = (s: number) => `${roundSeconds(s)} s`;

/** Total against the target, within ±10% counts as on target. */
export function lengthVerdict(total: number, target: number): { status: 'short' | 'ok' | 'long'; text: string } {
  const delta = roundSeconds(total - target);
  if (Math.abs(delta) <= target * 0.1) return { status: 'ok', text: delta === 0 ? 'On target' : `${delta > 0 ? '+' : '−'}${formatSeconds(Math.abs(delta))} · on target` };
  return delta > 0 ? { status: 'long', text: `${formatSeconds(delta)} over target` } : { status: 'short', text: `${formatSeconds(-delta)} under target` };
}

export function updateOutlineScene(outline: Outline, id: string, changes: Partial<Omit<OutlineScene, 'id'>>): Outline {
  return {
    ...outline,
    scenes: outline.scenes.map((s) => {
      if (s.id !== id) return s;
      const next = { ...s, ...changes };
      next.durationSeconds = Math.min(OUTLINE_LIMITS.maxSeconds, Math.max(OUTLINE_LIMITS.minSeconds, next.durationSeconds));
      return next;
    }),
  };
}

export function moveOutlineScene(outline: Outline, id: string, toIndex: number): Outline {
  const from = outline.scenes.findIndex((s) => s.id === id);
  if (from < 0) return outline;
  const to = Math.max(0, Math.min(outline.scenes.length - 1, toIndex));
  const scenes = outline.scenes.slice();
  const [scene] = scenes.splice(from, 1);
  scenes.splice(to, 0, scene);
  return { ...outline, scenes };
}

export function removeOutlineScene(outline: Outline, id: string): Outline {
  return { ...outline, scenes: outline.scenes.filter((s) => s.id !== id) };
}

/** A new blank scene after `afterIndex` (default: at the end). */
export function addOutlineScene(outline: Outline, afterIndex = outline.scenes.length - 1): { outline: Outline; id: string } {
  const n = Math.max(0, ...outline.scenes.map((s) => Number(/^ol_(\d+)$/.exec(s.id)?.[1] ?? 0))) + 1;
  const scene: OutlineScene = { id: `ol_${n}`, name: `Scene ${outline.scenes.length + 1}`, purpose: '', durationSeconds: 4 };
  const scenes = outline.scenes.slice();
  scenes.splice(afterIndex + 1, 0, scene);
  return { outline: { ...outline, scenes }, id: scene.id };
}

// ---------------------------------------------------------------------------
// Skeleton project
// ---------------------------------------------------------------------------

export interface SkeletonIds {
  project: string;
  scene: (index: number) => string;
  audioClip: () => string;
}

/**
 * The project an approved outline becomes: one empty scene per outline item
 * (in order, named and timed as approved), the brief's size, frame rate and
 * background, its brand files as assets, and the chosen track (or the first
 * audio file) as a music bed across the whole video.
 */
export function buildSkeletonProject(outline: Outline, brief: VideoBrief, ids: SkeletonIds): Project {
  let seconds = 0;
  let boundary = 0;
  const scenes = outline.scenes.map((s, i) => {
    seconds += s.durationSeconds;
    const nextBoundary = Math.max(boundary + 1, Math.round(seconds * brief.fps));
    const durationInFrames = nextBoundary - boundary;
    boundary = nextBoundary;
    return {
      id: ids.scene(i),
      name: s.name,
      durationInFrames,
      backgroundColor: brief.backgroundColor,
      locked: false,
      transitionIn: { type: 'none' as const, durationInFrames: 0 },
      elements: [],
    };
  });
  const total = scenes.reduce((n, s) => n + s.durationInFrames, 0);
  const assets = brandAssets(brief);
  const chosen = musicFile(brief);
  const music = assets.find((a) => a.id === chosen?.id);
  const audio: AudioClip[] = [];
  if (music) {
    const durationInFrames = Math.min(total, music.durationInFrames ?? total);
    audio.push({ id: ids.audioClip(), assetId: music.id, name: 'Music bed', startFrame: 0, trimStartFrames: 0, durationInFrames, volume: 0.6, fadeInFrames: Math.min(durationInFrames, Math.round(brief.fps * 0.5)), fadeOutFrames: Math.min(durationInFrames, Math.round(brief.fps * 1.5)) });
  }
  const story = stampStory(outline.story, scenes, brief.fps);
  return {
    schemaVersion: PROJECT_SCHEMA_VERSION,
    id: ids.project,
    name: outline.title,
    revision: 1,
    fps: brief.fps,
    width: brief.width,
    height: brief.height,
    backgroundColor: brief.backgroundColor,
    scenes,
    assets: Object.fromEntries(assets.map((a) => [a.id, a])),
    audio,
    compositions: {},
    markers: [],
    ...(story ? { story } : {}),
  };
}

// ---------------------------------------------------------------------------
// Messages to the chat agent
// ---------------------------------------------------------------------------

const TEMPLATE_LIST = TEMPLATE_IDS.map((id) => `${id} (${TEMPLATES[id].label.toLowerCase()})`).join(', ');

function briefLines(brief: VideoBrief): string[] {
  const aspect = aspectOf(brief.width, brief.height);
  const logo = brief.files.find((f) => f.id === brief.logoId);
  return [
    `Brief: ${brief.brief.trim()}`,
    brief.audience.trim() && `Audience: ${brief.audience.trim()}`,
    brief.tone.trim() && `Tone: ${brief.tone.trim()}`,
    `Target length: ${brief.targetSeconds} s`,
    `Format: ${brief.width}×${brief.height}${aspect ? ` (${aspect})` : ''} at ${brief.fps} fps, background ${brief.backgroundColor}`,
    brief.brandColors.length ? `Brand colours: ${brief.brandColors.join(', ')}` : '',
    logo ? `Logo: "${logo.name}" (${logo.kind})` : '',
    ...musicLines(brief),
  ].filter(Boolean) as string[];
}

const secondsText = (s: number) => `${Number(s.toFixed(2))}`;

function musicLines(brief: VideoBrief): string[] {
  const track = musicFile(brief);
  const mood = brief.music?.mood?.trim();
  const tempo = track && track.id === brief.music?.fileId ? brief.music?.tempo : undefined;
  const lines: string[] = [];
  if (track) {
    const bar = tempo?.bpm ? (240 / tempo.bpm) : null;
    const facts = [
      tempo ? formatSeconds(tempo.durationSeconds) : track.durationSeconds ? formatSeconds(track.durationSeconds) : '',
      tempo?.bpm ? `~${Math.round(tempo.bpm)} BPM${tempo.confidence < 0.2 ? ' (weak pulse)' : ''}` : '',
      bar ? `a bar every ${secondsText(bar)} s` : '',
    ].filter(Boolean);
    lines.push(`Music: "${track.name}"${facts.length ? ` (${facts.join(', ')})` : ''}; it becomes the music bed under the whole video.`);
  }
  if (mood) lines.push(`Music mood: ${mood}${track ? '' : ' (no track chosen yet)'}`);
  return lines;
}

/** Downbeats (seconds) the outline can cut on, up to a little past the target length. */
function beatPlan(brief: VideoBrief): string[] {
  const track = musicFile(brief);
  const tempo = track && track.id === brief.music?.fileId ? brief.music?.tempo : undefined;
  if (!tempo?.downbeatSeconds.length) return [];
  const until = brief.targetSeconds * 1.25;
  const bars = tempo.downbeatSeconds.filter((s) => s <= until).map(secondsText);
  if (!bars.length) return [];
  const list = `${bars.join(', ')}`;
  return brief.music?.snapToBeats
    ? [
        `The user wants scene lengths snapped to the music. Make every scene boundary — the running total of durationSeconds from 0 — land on one of the track's downbeats (bar starts, seconds from the start): ${list}. Use decimal durations to hit them exactly.`,
      ]
    : [`If it suits the story, put scene boundaries on the track's downbeats (bar starts, seconds from the start): ${list}.`];
}

/** Pack the brief's tone/audience/copy most likely wants; agents copy these numbers, not adjectives. */
export function suggestedPackId(brief: VideoBrief): StylePackId {
  const blob = `${brief.tone} ${brief.audience} ${brief.brief}`.toLowerCase();
  if (/\b(editorial|kinetic type|magazine|story|quote|publishing)\b/.test(blob)) return 'editorial';
  if (/\b(premium|luxury|finance|brand film|calm|champagne)\b/.test(blob)) return 'calm-premium';
  if (/\b(playful|consumer|social|kids|bouncy|fun)\b/.test(blob)) return 'playful-consumer';
  if (/\b(saas|product|demo|ui|engineering|b2b)\b/.test(blob)) return 'snappy-saas';
  // Launch videos and anything without a stronger voice use the house bar.
  return 'pulse';
}

const band = (r: readonly [number, number]) => `${r[0]}–${r[1]}`;
const curve = (e: StylePack['motion']['enter']) => (typeof e === 'string' ? e : `cubicBezier(${e.x1}, ${e.y1}, ${e.x2}, ${e.y2})`);

/** How a scene's patch lands: proposed for review, or applied at once (Auto-apply on). */
type PatchTool = 'editor_propose_patch' | 'editor_apply_patch';

/**
 * Directed brief (GOAL / OUTPUT / ROUTE / TIME / LOOK / MOTION / SHOTS / STORY / BANNED / QA)
 * with numbers from the style pack and motionRules, so agents don't invent a look.
 * `patchTool` is the QA line's last step: proposing by default, applying when the
 * build runs with Auto-apply on.
 */
export function directedBrief(brief: VideoBrief, style?: StylePack, patchTool: PatchTool = 'editor_propose_patch'): string[] {
  const pack = style ?? STYLE_PACKS[suggestedPackId(brief)];
  const m = pack.motion;
  const fps = brief.fps;
  const fpb = brief.music?.tempo?.bpm ? Math.round((fps * 60) / brief.music.tempo.bpm) : null;
  const scenes = Object.entries(SCENE_BANDS).map(([k, b]) => `${k} ${band(b)}s`).join(', ');
  const banned = SEEDED_BANNED.map((b) => b.label).join('; ');
  const roles = STORY_BEAT_ROLES.join('|');
  return [
    'Directed brief (use these numbers; do not replace them with adjectives):',
    `GOAL: ${brief.brief.trim() || '(see chat)'}`,
    `OUTPUT: ${brief.width}×${brief.height} at ${fps} fps, ${brief.targetSeconds} s${brief.audience.trim() ? `; audience ${brief.audience.trim()}` : ''}.`,
    `ROUTE: ${workflowLine(routeWorkflow({ brief: brief.brief, audience: brief.audience, tone: brief.tone, targetSeconds: brief.targetSeconds, hasMusic: Boolean(musicFile(brief)) }))}`,
    `TIME: reading hold = words ÷ ${READING.wordsPerSecond} + ${READING.findSeconds} s (min ${READING.minSeconds} s). Entrances at 30 fps × ${m.timingScale} timingScale: ${Object.entries(TIMING_BANDS).map(([k, b]) => `${k} ${band(b.frames)}f`).join(', ')}; exits × ${EXIT_RATIO}. One element enters within ${SEAM.maxEntrySeconds} s; for a longer build, stagger several elements. Stagger ${STAGGER_FRAMES.min}–${STAGGER_FRAMES.max} f (this pack ${m.staggerFrames} f).${fpb ? ` Beat grid: ${fpb} f/beat (round fps×60/BPM per beat).` : ''}`,
    `LOOK: pack \`${pack.id}\` — ${STYLE_PACK_NOTES[pack.id as StylePackId] ?? pack.name} Fonts ${pack.fonts.heading} / ${pack.fonts.body}. Colours background ${pack.colors.background}, surface ${pack.colors.surface}, text ${pack.colors.text}, muted ${pack.colors.muted}, accent ${pack.colors.accent}${pack.colors.accent2 ? `, accent2 ${pack.colors.accent2}` : ''}.${brief.brandColors.length ? ` Brand extras ${brief.brandColors.join(', ')} (map onto accent/accent2, do not add hues).` : ''} Type at 1080: hero ${band(TYPE_SCALE.hero)} px, headline ${band(TYPE_SCALE.headline)}, body ${band(TYPE_SCALE.body)}; floors label ${TYPE_MIN.label}, tracked caps ${TYPE_MIN.trackedCaps}, body ${TYPE_MIN.body}, callout ${TYPE_MIN.callout}, CTA ${TYPE_MIN.ctaLabel}; contrast ≥ ${TYPE_MIN.contrast}. Hero cap height ≥ ${Math.round(FRAME_USE.heroCapHeightShare * 100)} % of the frame.`,
    `MOTION: enter \`${curve(m.enter)}\`, exit \`${curve(m.exit)}\`, overshoot ${Math.round(m.overshoot * 100)} %. Never linear position. One hero per shot. Across cuts: same axis, same direction, similar speed, cut mid-motion (default direction ${SEAM.current}). Pause ${SEAM.stillnessSeconds[0]}–${SEAM.stillnessSeconds[1]} s before a climax. A slow one-way drift is fine; floating back and forth only fills time. During a hold keep secondary motion (push ${Math.round(LIVENESS.push[0] * 100)}–${Math.round(LIVENESS.push[1] * 100)} %, drift ${LIVENESS.driftPx[0]}–${LIVENESS.driftPx[1]} px, or a backdrop). Craft: ${craftLine(craftOf(pack))}${pack.id === HOUSE_PACK_ID ? ' This is the default house bar.' : ''}`,
    `SHOTS: one idea per scene (${scenes}). Most scenes 3–8 s. Name the one hero and how it arrives in each scene's visuals.`,
    `STORY: one idea. Hook in the first ${STORY.hookSeconds[0]}–${STORY.hookSeconds[1]} s (a claim, a picture, or a move — not a logo or title card). Audience, tension/setup, payoff in the last ~${Math.round(STORY.payoffShare * 100)} %, optional CTA or loop-back. Write beats before motion: [{ role: ${roles}, summary, sceneName, fromSeconds?, toSeconds? }] covering every scene. Average scene ≥ ${STORY.minSceneSeconds} s. editor_critique flags a missing hook, a logo/title-card open, too many ideas, a dead middle (> ${STORY.deadMiddleSeconds} s), no payoff, an unresolved end, and scenes that don't map to a beat.`,
    `BANNED: ${banned}. After the first contact sheet, pass new items to editor_critique { addBanned } and store them on project.banned.`,
    `QA: story beats first, then motion, then editor_preview_patch (contactSheet) → editor_critique → fix once → ${patchTool}. Usually 2–4 rounds. Critique findings are frame numbers, not vibes. State every correction as an absolute (fontSize 32, hold 48 f, x 0 → −80), not "bigger" or "a bit longer".`,
  ];
}

/** The chat message that asks the agent for an outline (brand files go along as attachments). */
export function outlineRequestPrompt(brief: VideoBrief): string {
  return [
    'Plan a new video from this brief. Draft an OUTLINE only — do not edit, write or open any project yet. The open project is a blank one made for this video; after the user approves the outline, the editor fills it with one empty scene per approved item and asks you to build them.',
    '',
    ...briefLines(brief),
    brief.files.length ? `Brand files are attached for reference; the editor adds them to the project itself.` : '',
    '',
    ...directedBrief(brief),
    '',
    'Call the `editor_propose_outline` tool once with { title, story: { idea, hook, audience?, tension?, payoff, cta?, beats: [{ role, summary, sceneName, fromSeconds?, toSeconds? }] }, scenes: [{ name, purpose, durationSeconds, onScreenText?, visuals?, templateHints? }] }.',
    '- Write the story beats first (hook in 1–2 s, one idea, tension, payoff, optional CTA/loop, every scene mapped to a beat and a time range). Do not build motion yet.',
    `- Scene durations should add up to within 10% of ${brief.targetSeconds} s. One idea per scene; most scenes run 3–8 s.`,
    '- `onScreenText` is the exact words on screen; `visuals` says what we see and how it moves — name the one hero and the entrance, not "snappy" or "cinematic".',
    `- \`templateHints\` may name editor templates that fit: ${TEMPLATE_LIST}.`,
    ...beatPlan(brief).map((l) => `- ${l}`),
    brief.music?.mood?.trim() && !musicFile(brief) ? '- No track is chosen: mention in your one-sentence reply what kind of track would fit the mood.' : '',
    'The user reviews and edits the outline in the chat, so stop after proposing and reply with one short sentence.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * The chat message that asks the agent to build the video straight away, with
 * no outline to approve first ("Outline first" off). Brand files go along as
 * attachments.
 */
export function directBuildPrompt(brief: VideoBrief): string {
  return [
    ...briefLines(brief),
    brief.files.length ? 'Brand files are attached; add them to the project as assets.' : '',
    '',
    ...directedBrief(brief),
    '',
    'Build this video now in the open project, which is blank and made for it (keep its id). Write `project.story` first (idea, hook, audience, tension, payoff, cta, beats mapped to scene names and seconds), then the scenes with motion — never the other way around. Write the whole draft with `editor_write_project` using `overwrite: true` and the open project\'s id: a fresh revision, the format above, the brand files as assets, the music bed, `style` copied from the directed brief\'s pack, `story`, and every scene with its elements built from templates and presets (`editor_build_template`, `editor_build_motion`); then `editor_render_contact_sheet`, `editor_critique`, fix what it flags, and hand over. Reply with two sentences: what the video does and what to tweak.',
  ]
    .filter((l) => l !== '')
    .join('\n');
}

/**
 * The chat message that hands the approved outline to the agent to build. By
 * default the editor filled the open (blank) project with the outline;
 * `created` says it created and opened a new project for it instead.
 * `autoApply` (the chat's switch as the message goes) picks how the build
 * lands: off, one `editor_propose_patch` per scene, each reviewed before the
 * next; on, `editor_apply_patch` per scene straight through, with one contact
 * sheet and critique over the whole video at the end.
 */
export function buildScenesPrompt(outline: Outline, brief: VideoBrief, project: Project, opts: { created?: boolean; autoApply?: boolean } = {}): string {
  const fps = project.fps;
  const patchTool: PatchTool = opts.autoApply ? 'editor_apply_patch' : 'editor_propose_patch';
  const sceneLines = outline.scenes.map((s, i) => {
    const scene = project.scenes[i];
    const parts = [
      `${i + 1}. "${s.name}" — scene ${scene.id}, ${formatSeconds(s.durationSeconds)} (${scene.durationInFrames} frames)`,
      s.purpose && `   Purpose: ${s.purpose}`,
      s.onScreenText && `   On screen: ${s.onScreenText}`,
      s.visuals && `   Visuals: ${s.visuals}`,
      s.templateHints?.length && `   Templates: ${s.templateHints.join(', ')}`,
      s.notes?.trim() && `   My notes: ${s.notes.trim()}`,
    ];
    return parts.filter(Boolean).join('\n');
  });
  const assets = Object.values(project.assets);
  const story = project.story ?? outline.story;
  const storyLines = story
    ? [
        'Story (already stamped on project.story — build motion to serve it):',
        `  Idea: ${story.idea}`,
        `  Hook: ${story.hook}`,
        story.audience && `  Audience: ${story.audience}`,
        story.tension && `  Tension: ${story.tension}`,
        `  Payoff: ${story.payoff}`,
        story.cta && `  CTA: ${story.cta}`,
        ...story.beats.map((b) => {
          const who = b.sceneId ? `scene ${b.sceneId}` : b.sceneName ? `"${b.sceneName}"` : 'unmapped';
          const span = b.fromFrame !== undefined && b.toFrame !== undefined ? `, frames ${b.fromFrame}–${b.toFrame}` : b.fromSeconds !== undefined && b.toSeconds !== undefined ? `, ${b.fromSeconds}–${b.toSeconds} s` : '';
          return `  Beat ${b.role} (${who}${span}): ${b.summary}`;
        }),
      ].filter((l): l is string => Boolean(l))
    : [];
  return [
    opts.created
      ? `I approved the outline "${outline.title}". The editor created and opened the new project "${project.name}" (${project.id}): ${project.scenes.length} empty scenes at ${project.width}×${project.height}, ${fps} fps.`
      : `I approved the outline "${outline.title}". The editor filled the open project "${project.name}" (${project.id}) with ${project.scenes.length} empty scenes at ${project.width}×${project.height}, ${fps} fps.`,
    '',
    ...(opts.autoApply
      ? [
          'Auto-apply is on: build every scene now, without stopping for review. Use `editor_apply_patch` per scene (targets: [{ sceneId }]); each lands at once as its own undo step, so go straight on to the next scene. Do not propose scenes for review and do not wait for a decision between scenes (a generated take is the one exception: place it with `editor_propose_patch` as the guide says, and carry on with the other scenes while it waits). If a scene patch comes back as proposed instead of applied, Auto-apply was turned off meanwhile: switch to `editor_propose_patch` one scene at a time and check `editor_proposal_status` for my decision before the next.',
          'When every scene is built: `editor_render_contact_sheet` across the video, `editor_critique`, fix what it flags with `editor_apply_patch`, then hand over with two sentences: what the video does and what to tweak.',
        ]
      : ['Build the approved outline scene by scene; use `editor_propose_patch` per scene (targets: [{ sceneId }]) so I can review each one. Propose one scene at a time and check `editor_proposal_status` for my decision before proposing the next — a newer proposal replaces a pending one.']),
    'Only change this project. Never open, write or edit any other project, and keep the scene order and lengths as approved unless I ask.',
    `Read \`editor_guide\` first if you have not this session. The story beats are already written (see STORY and the approved outline); build motion to serve them, not the other way around. Build each scene from its templates with \`editor_build_template\` and add motion with \`editor_build_motion\` (see "Building scenes" in the guide) rather than placing every element by hand. For each scene: \`editor_preview_patch\` (contactSheet) → \`editor_critique\` → fix once → \`${patchTool}\`.`,
    '',
    ...briefLines(brief),
    ...directedBrief(brief, project.style, patchTool),
    assets.length ? `Assets in the project: ${assets.map((a) => `${a.id} "${a.name}" (${a.kind})`).join('; ')}` : '',
    ...buildMusicLines(project),
    '',
    'Approved outline:',
    ...sceneLines,
    ...storyLines,
  ]
    .filter((l) => l !== '')
    .join('\n');
}

// ---------------------------------------------------------------------------
// Brand colours from an image
// ---------------------------------------------------------------------------

const hex = (n: number) => n.toString(16).padStart(2, '0').toUpperCase();

/**
 * A few distinct, characterful colours from RGBA pixel data (e.g. a logo drawn
 * small on a canvas): opaque pixels quantised, ranked by how often they occur
 * and how saturated they are, near-duplicates dropped.
 */
export function paletteFromPixels(data: ArrayLike<number>, max = 4): string[] {
  const counts = new Map<number, { n: number; r: number; g: number; b: number }>();
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const c = counts.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    c.n++;
    c.r += r;
    c.g += g;
    c.b += b;
    counts.set(key, c);
  }
  const ranked = [...counts.values()]
    .map((c) => {
      const [r, g, b] = [c.r / c.n, c.g / c.n, c.b / c.n];
      const hi = Math.max(r, g, b);
      const lo = Math.min(r, g, b);
      const sat = hi === 0 ? 0 : (hi - lo) / hi;
      return { r: Math.round(r), g: Math.round(g), b: Math.round(b), score: c.n * (0.25 + sat) };
    })
    .sort((a, b) => b.score - a.score);
  const picked: { r: number; g: number; b: number }[] = [];
  for (const c of ranked) {
    if (picked.length >= max) break;
    if (picked.some((p) => Math.hypot(p.r - c.r, p.g - c.g, p.b - c.b) < 56)) continue;
    picked.push(c);
  }
  return picked.map((c) => `#${hex(c.r)}${hex(c.g)}${hex(c.b)}`);
}

/** What the build message says about the music bed. */
function buildMusicLines(project: Project): string[] {
  const bed = project.audio.find((c) => !c.sceneId);
  if (!bed) return [];
  return [
    `A music bed already plays across the whole video ("${bed.name}", ${bed.id}). Call \`editor_get_beats\` for its tempo, beats, downbeats and strong hits in project frames: land each scene's main entrance on a beat and its biggest moment on a strong hit, keep text on screen long enough to read, and add built-in sound effects sparingly (see "Music and sound" in \`editor_guide\`). Audio edits use the target { "audio": "project" }.`,
  ];
}
