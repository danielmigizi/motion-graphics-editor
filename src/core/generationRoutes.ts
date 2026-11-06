// Pure generation routes, prices and fal mappings, shared by the editor and
// local server. Endpoint availability and live prices come from the caller.

import { JOB_KINDS, formatUsd } from './generationStudio';
import type { FrameSource, GenerateRequest, GenerationEstimate, GenerationModelsResponse, GenerationMedia, JobKind, JobSettings, RouteDecision, RoutePolicy, RouteSuggestion } from './generationStudio';

/** Bump when a route, default or mapping changes; recorded with every job. */
export const ROUTE_VERSION = '2026-10-21.c1';

/** fal pricing API units understood by the registry. */
export type FalPriceUnit = 'units' | 'megapixels' | 'minutes' | '1000 characters' | 'seconds';

type VideoRates = Partial<Record<'480p' | '720p' | '1080p', number>>;
interface VideoPrice {
  standard: VideoRates;
  promotion?: { through: number; label: string; rates: VideoRates };
}

/** A model's endpoints, capabilities and list price (checked 2026-10-21). */
export interface ModelSpec {
  id: string;
  label: string;
  license: string;
  endpoints: Partial<Record<JobKind, string>>;
  caps: {
    transparency?: boolean;
    mask?: boolean;
    maxReferences?: number;
    batch?: number;
    maxResolution?: '1k' | '2k' | '4k';
    aspectRatios?: readonly string[];
  };
  price: { unit: FalPriceUnit; usd: number; reserve?: boolean };
  videoPrice?: VideoPrice;
  endpointVideoPrices?: Partial<Record<JobKind, VideoPrice>>;
  referenceVideoRates?: VideoRates;
}

/** A job's choice text and models in quality order. */
export interface JobSpec {
  job: JobKind;
  media: GenerationMedia;
  label: string;
  hint: string;
  candidates: readonly string[];
}

const GPT = 'gpt-image-2.5-flare';
const SEEDREAM = 'seedream-5-pro';
const FLUX = 'flux-3-image';
const MUSIC = 'elevenlabs-music-2.5';
const VOICE = 'eleven-v4';
const SFX = 'elevenlabs-sfx-2';
const FLUX_VIDEO = 'flux-3-max';
const H3 = 'h3-max';
const TURBO = 'h3-max-turbo';
const WAN_PRIME = 'wan-3-prime';
const WAN = 'wan-3';
const VIDEO_FLUX_RATIOS = ['21:9', '2:1', '16:9', '4:3', '1:1', '3:4', '9:16'];
const WAN_RATIOS = ['16:9', '4:3', '1:1', '3:4', '9:16'];
const FLUX_RATIOS = ['21:9', '2:1', '16:9', '3:2', '7:5', '4:3', '5:4', '1:1', '4:5', '3:4', '5:7', '2:3', '9:16', '1:2'] as const;
const DEFAULT_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'];
const LICENSE = 'Commercial use (fal partner model)';
// Per output second, checked on fal model pages 2026-10-21. The pricing API
// returns the lowest-resolution rate; it cannot price a chosen video resolution.
const H3_REFERENCE_PRICE: VideoPrice = { standard: { '480p': 0.05, '720p': 0.08, '1080p': 0.16 } };

/** Audio, image and video registry. GPT's price is supplied by the reserve setting. */
export const MODELS: Readonly<Record<string, ModelSpec>> = {
  [GPT]: {
    id: GPT, label: 'GPT Image 2.5 Flare', license: LICENSE,
    endpoints: {
      'image.generate': 'openai/gpt-image-2.5/flare/text-to-image',
      'image.cutout': 'openai/gpt-image-2.5/flare/text-to-image',
      'image.typography': 'openai/gpt-image-2.5/flare/text-to-image',
      'image.plate': 'openai/gpt-image-2.5/flare/text-to-image',
      'image.edit': 'openai/gpt-image-2.5/flare/edit',
      'image.composite': 'openai/gpt-image-2.5/flare/edit',
    },
    caps: { transparency: true, mask: true, maxReferences: 16, batch: 4, maxResolution: '4k' },
    price: { unit: 'units', usd: 0, reserve: true },
  },
  [SEEDREAM]: {
    id: SEEDREAM, label: 'Seedream 5.0 Pro', license: LICENSE,
    endpoints: {
      'image.generate': 'bytedance/seedream/v5/pro/text-to-image',
      'image.typography': 'bytedance/seedream/v5/pro/text-to-image',
      'image.plate': 'bytedance/seedream/v5/pro/text-to-image',
      'image.edit': 'bytedance/seedream/v5/pro/edit',
      'image.composite': 'bytedance/seedream/v5/pro/edit',
    },
    caps: { maxReferences: 10, batch: 4, maxResolution: '2k' },
    price: { unit: 'units', usd: 0.0675 },
  },
  [FLUX]: {
    id: FLUX, label: 'FLUX 3 Image', license: LICENSE,
    endpoints: {
      'image.generate': 'blackforestlabs/flux-3/text-to-image',
      'image.typography': 'blackforestlabs/flux-3/text-to-image',
      'image.plate': 'blackforestlabs/flux-3/text-to-image',
      'image.edit': 'blackforestlabs/flux-3/edit-image',
      'image.composite': 'blackforestlabs/flux-3/edit-image',
    },
    caps: { maxReferences: 10, batch: 1, maxResolution: '4k', aspectRatios: FLUX_RATIOS },
    price: { unit: 'megapixels', usd: 0.048 },
  },
  [MUSIC]: {
    id: MUSIC, label: 'ElevenLabs Music v2.5', license: LICENSE,
    endpoints: { 'music.bed': 'elevenlabs/music/v2.5', 'music.scored': 'elevenlabs/music/v2.5' }, caps: {}, price: { unit: 'minutes', usd: 0.6 },
  },
  [VOICE]: {
    id: VOICE, label: 'Eleven v4', license: LICENSE,
    endpoints: { 'voice.line': 'elevenlabs/tts/eleven-v4', 'voice.narration': 'elevenlabs/tts/eleven-v4' },
    caps: {}, price: { unit: '1000 characters', usd: 0.08 },
  },
  [SFX]: {
    id: SFX, label: 'ElevenLabs SFX v2', license: LICENSE,
    endpoints: { 'sfx.hit': 'fal-ai/elevenlabs/sound-effects/v2', 'sfx.ambience': 'fal-ai/elevenlabs/sound-effects/v2' },
    caps: {}, price: { unit: 'seconds', usd: 0.002 },
  },
  [FLUX_VIDEO]: {
    id: FLUX_VIDEO, label: 'FLUX 3 Max', license: LICENSE,
    endpoints: {
      'video.generate': 'blackforestlabs/flux-3-max/text-to-video',
      'video.animate': 'blackforestlabs/flux-3-max/image-to-video',
      'video.between': 'blackforestlabs/flux-3-max/image-to-video',
      'video.keyframes': 'blackforestlabs/flux-3-max/keyframes-to-video',
    },
    caps: { aspectRatios: VIDEO_FLUX_RATIOS }, price: { unit: 'seconds', usd: 0.17 },
    videoPrice: { standard: { '720p': 0.17, '1080p': 0.29 }, promotion: {
      through: 20261107, label: '7 Nov', rates: { '720p': 0.0425, '1080p': 0.0725 },
    } },
  },
  [H3]: {
    id: H3, label: 'MiniMax H3 Max', license: LICENSE,
    endpoints: {
      'video.generate': 'minimax/h3-max/text-to-video',
      'video.animate': 'minimax/h3-max/image-to-video',
      'video.between': 'minimax/h3-max/image-to-video',
      'video.reference': 'minimax/h3-max/reference-to-video',
      'video.keyframes': 'minimax/h3-max/reference-to-video',
    },
    caps: { aspectRatios: DEFAULT_RATIOS }, price: { unit: 'seconds', usd: 0.05 },
    videoPrice: { standard: { '480p': 0.05, '720p': 0.08, '1080p': 0.16 }, promotion: {
      through: 20261031, label: '31 Oct', rates: { '480p': 0.0325, '720p': 0.052, '1080p': 0.104 },
    } },
    endpointVideoPrices: { 'video.reference': H3_REFERENCE_PRICE, 'video.keyframes': H3_REFERENCE_PRICE },
    referenceVideoRates: { '480p': 0.006, '720p': 0.08, '1080p': 0.08 },
  },
  [TURBO]: {
    id: TURBO, label: 'H3 Max Turbo', license: LICENSE,
    endpoints: {
      'video.generate': 'minimax/h3-max-turbo/text-to-video',
      'video.animate': 'minimax/h3-max-turbo/image-to-video',
      'video.between': 'minimax/h3-max-turbo/image-to-video',
    },
    caps: { aspectRatios: DEFAULT_RATIOS }, price: { unit: 'seconds', usd: 0.025 },
    videoPrice: { standard: { '480p': 0.025, '720p': 0.04, '1080p': 0.08 }, promotion: {
      through: 20261031, label: '31 Oct', rates: { '480p': 0.01625, '720p': 0.026, '1080p': 0.052 },
    } },
  },
  [WAN_PRIME]: {
    id: WAN_PRIME, label: 'Wan 3.0 Prime', license: LICENSE,
    endpoints: {
      'video.generate': 'alibaba/wan-3.0-prime/reference-to-video',
      'video.animate': 'alibaba/wan-3.0-prime/reference-to-video',
      'video.reference': 'alibaba/wan-3.0-prime/reference-to-video',
      'video.long': 'alibaba/wan-3.0-prime/reference-to-video',
    },
    caps: { aspectRatios: WAN_RATIOS }, price: { unit: 'seconds', usd: 0.068 },
    videoPrice: { standard: { '480p': 0.068, '720p': 0.14, '1080p': 0.28 } },
  },
  [WAN]: {
    id: WAN, label: 'Wan 3.0', license: LICENSE,
    endpoints: { 'video.reference': 'alibaba/wan-3.0/reference-to-video', 'video.long': 'alibaba/wan-3.0/reference-to-video' },
    caps: { aspectRatios: WAN_RATIOS }, price: { unit: 'seconds', usd: 0.05 },
    videoPrice: { standard: { '480p': 0.05, '720p': 0.10, '1080p': 0.20 } },
  },
};

const voiceHint = 'The exact words to speak. Tags like [excited] or [whispering] steer delivery';
const sfxHint = 'What makes the sound and how it moves — e.g. a soft whoosh left to right';

/** Jobs and their quality defaults; draft compares every capable candidate. */
export const JOBS: Readonly<Record<JobKind, JobSpec>> = {
  'music.bed': { job: 'music.bed', media: 'music', label: 'Music bed for the whole video', hint: 'Genre, mood, instruments and tempo — e.g. warm lo-fi, soft keys, 85 BPM, builds at the end', candidates: [MUSIC] },
  'music.scored': { job: 'music.scored', media: 'music', label: 'Music scored to the cut', hint: "Genre and instruments for the whole piece; each scene's section can have its own direction", candidates: [MUSIC] },
  'voice.line': { job: 'voice.line', media: 'voice', label: 'A voice-over line', hint: voiceHint, candidates: [VOICE] },
  'voice.narration': { job: 'voice.narration', media: 'voice', label: 'Narration', hint: voiceHint, candidates: [VOICE] },
  'sfx.hit': { job: 'sfx.hit', media: 'sfx', label: 'A sound effect (hit, whoosh, click)', hint: sfxHint, candidates: [SFX] },
  'sfx.ambience': { job: 'sfx.ambience', media: 'sfx', label: 'Ambience that loops', hint: 'Describe the place and its steady background sounds; say what should loop', candidates: [SFX] },
  'image.generate': { job: 'image.generate', media: 'image', label: 'A still image', hint: 'Describe the subject, setting, style and composition', candidates: [GPT, SEEDREAM, FLUX] },
  'image.cutout': { job: 'image.cutout', media: 'image', label: 'Cutout with transparent background', hint: 'One object on its own; the background is removed', candidates: [GPT] },
  'image.typography': { job: 'image.typography', media: 'image', label: 'Image with text in it', hint: 'Put the exact text in quotes; say where it sits', candidates: [SEEDREAM, GPT] },
  'image.plate': { job: 'image.plate', media: 'image', label: 'Wide or high-resolution background', hint: 'A background with room for titles; say what goes where', candidates: [FLUX, GPT] },
  'image.edit': { job: 'image.edit', media: 'image', label: 'Change one thing in a project image', hint: 'Say only what changes; everything else stays', candidates: [GPT, SEEDREAM, FLUX] },
  'image.composite': { job: 'image.composite', media: 'image', label: 'Combine project images (product + logo)', hint: 'Say how the referenced images combine (Image 1, Image 2 …)', candidates: [GPT, SEEDREAM, FLUX] },
  'video.generate': { job: 'video.generate', media: 'video', label: 'A clip from text', hint: 'Subject, action, camera move and mood — one shot', candidates: [FLUX_VIDEO, H3, WAN_PRIME, TURBO] },
  'video.animate': { job: 'video.animate', media: 'video', label: 'Animate this image', hint: 'How the still comes alive: what moves, how the camera moves', candidates: [FLUX_VIDEO, H3, WAN_PRIME, TURBO] },
  'video.between': { job: 'video.between', media: 'video', label: 'Between two frames (across a cut)', hint: 'What happens between the two frames; the clip starts and ends exactly on them', candidates: [FLUX_VIDEO, H3, TURBO] },
  'video.keyframes': { job: 'video.keyframes', media: 'video', label: 'Through pinned keyframes', hint: 'What happens across the pinned frames', candidates: [FLUX_VIDEO, H3] },
  'video.reference': { job: 'video.reference', media: 'video', label: 'Keep a subject consistent across shots', hint: 'Refer to the references as Image 1, Image 2 (and Video 1)', candidates: [H3, WAN_PRIME, WAN] },
  'video.long': { job: 'video.long', media: 'video', label: 'Longer clip, or from a document or web page', hint: 'What the clip should show from the document or page, and its length', candidates: [WAN_PRIME, WAN] },
};

/** Availability, prices, reserve and project dimensions supplied by the caller. */
export interface RouteContext {
  routeOverrides?: Partial<Record<JobKind, string>>;
  suggestions?: RouteSuggestion[];
  available?: Readonly<Record<string, boolean>>;
  livePrices?: Readonly<Record<string, { unitPrice: number; unit: string }>>;
  gptImageReserveUsd: number;
  now?: number;
  referenceAssetSeconds?: Readonly<Record<string, number>>;
  referenceAssetFps?: Readonly<Record<string, number>>;
  /** Asset kinds from the project, when known; unresolved ids are treated as images. */
  referenceAssetKinds?: Readonly<Record<string, 'image' | 'video'>>;
  project?: { width: number; height: number; fps: number; durationSeconds: number };
}

function clamp(value: number | undefined, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && !Number.isNaN(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function parsedRatio(value: string | undefined): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value);
  const n = match ? Number(match[1]) / Number(match[2]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function ratio(value: string | undefined): number {
  return parsedRatio(value) ?? 16 / 9;
}

function nearestRatio(n: number, choices: readonly string[]): string {
  return choices.reduce((best, next) => Math.abs(ratio(next) - n) < Math.abs(ratio(best) - n) ? next : best);
}

/** Apply job defaults without changing the request or its reference array. */
export function normalizeSettings(job: JobKind, settings: JobSettings | undefined, ctx: Pick<RouteContext, 'project'>): JobSettings {
  const s: JobSettings = { ...settings };
  if (Array.isArray(s.referenceAssetIds)) s.referenceAssetIds = [...s.referenceAssetIds];
  if (job.startsWith('image.') || job.startsWith('video.')) {
    const projectRatio = ctx.project ? ctx.project.width / ctx.project.height : NaN;
    s.aspectRatio ??= nearestRatio(Number.isFinite(projectRatio) && projectRatio > 0 ? projectRatio : 16 / 9, DEFAULT_RATIOS);
    if (job.startsWith('video.')) {
      s.durationSeconds ??= 5;
      s.videoResolution ??= '1080p';
    } else s.resolution ??= job === 'image.plate' ? '2k' : '1k';
  } else if (job === 'music.bed') {
    const duration = clamp(ctx.project?.durationSeconds, 30, 3, 600);
    s.durationSeconds = clamp(s.durationSeconds, duration, 3, 600);
    s.instrumental ??= true;
  } else if (job.startsWith('sfx.')) {
    s.durationSeconds = clamp(s.durationSeconds, job === 'sfx.hit' ? 2 : 10, 0.5, 22);
    if (job === 'sfx.ambience') s.loop ??= true;
  } else if (job.startsWith('voice.')) s.voice ??= 'Rachel';
  return s;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const policies: readonly RoutePolicy[] = ['quality', 'balanced', 'draft'];
const stringSettings = ['aspectRatio', 'voice', 'languageCode', 'maskAssetId'];

function isFrameSource(value: unknown): value is FrameSource {
  if (!isObject(value) || Object.keys(value).length !== 1) return false;
  return typeof value.assetId === 'string' && !!value.assetId.trim()
    || typeof value.projectFrame === 'number' && Number.isInteger(value.projectFrame) && value.projectFrame >= 0;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2000) return false;
  try { const url = new URL(value); return url.protocol === 'https:' && !!url.hostname; } catch { return false; }
}

/** Validate the HTTP body, keeping errors tied to the offending field. */
export function validateRequest(raw: unknown): { ok: true; value: GenerateRequest } | { ok: false; error: string; path: string } {
  const bad = (path: string, why: string) => ({ ok: false as const, error: `${path} ${why}.`, path });
  if (!isObject(raw)) return bad('request', 'must be an object');
  if (!JOB_KINDS.includes(raw.job as JobKind)) return bad('job', 'must name a supported job');
  const job = raw.job as JobKind;
  const hasLines = job === 'voice.narration' && isObject(raw.settings) && Array.isArray(raw.settings.lines);
  if (typeof raw.prompt !== 'string' || !raw.prompt.trim() && !hasLines) return bad('prompt', 'must be non-empty text');
  const prompt = raw.prompt.trim();
  const max = job.startsWith('voice.') || job.startsWith('video.') ? 5000 : job.startsWith('sfx.') ? 450 : job === 'music.bed' ? 4100 : 32000;
  if (!hasLines && prompt.length > max) return bad('prompt', `must be at most ${max} characters`);
  if (typeof raw.projectId !== 'string' || !raw.projectId.trim()) return bad('projectId', 'must be non-empty text');
  if (raw.takes !== undefined && (typeof raw.takes !== 'number' || !Number.isInteger(raw.takes) || raw.takes < 1 || raw.takes > 4)) return bad('takes', 'must be an integer from 1 to 4');
  if (raw.policy !== undefined && !policies.includes(raw.policy as RoutePolicy)) return bad('policy', 'must be quality, balanced or draft');
  for (const key of ['model', 'regenerateOf']) if (raw[key] !== undefined && typeof raw[key] !== 'string') return bad(key, 'must be text');
  let settings: JobSettings | undefined;
  if (raw.settings !== undefined) {
    if (!isObject(raw.settings)) return bad('settings', 'must be an object');
    for (const [key, value] of Object.entries(raw.settings)) {
      const path = `settings.${key}`;
      if (stringSettings.includes(key)) {
        if (typeof value !== 'string') return bad(path, 'must be text');
      } else if (key === 'resolution') {
        if (!['1k', '2k', '4k'].includes(value as string)) return bad(path, 'must be 1k, 2k or 4k');
      } else if (key === 'durationSeconds' || key === 'seed') {
        if (typeof value !== 'number' || !Number.isFinite(value)) return bad(path, 'must be a finite number');
        if (key === 'seed' && job.startsWith('video.') && !Number.isInteger(value)) return bad(path, 'must be an integer');
      } else if (key === 'bpm') {
        if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return bad(path, 'must be a positive finite number');
      } else if (key === 'score') {
        const error = scoreError(value);
        if (error) return bad(error.path, error.why);
      } else if (key === 'lines') {
        if (!Array.isArray(value)) return bad(path, 'must be an array of scene narration lines');
        for (const [i, line] of value.entries()) {
          if (!isObject(line)) return bad(`${path}[${i}]`, 'must be a scene narration line');
          if (typeof line.sceneId !== 'string' || !line.sceneId.trim()) return bad(`${path}[${i}].sceneId`, 'must be non-empty text');
          if (typeof line.text !== 'string' || line.text.length > 5000) return bad(`${path}[${i}].text`, 'must be text of at most 5,000 characters');
        }
        if (job === 'voice.narration' && !value.some((line) => line.text.trim())) return bad(path, 'must contain at least one non-empty line');
      } else if (key === 'videoResolution') {
        if (value !== '720p' && value !== '1080p') return bad(path, 'must be 720p or 1080p');
      } else if (key === 'start' || key === 'end') {
        if (!isFrameSource(value)) return bad(path, 'must be {assetId: non-empty text} or {projectFrame: non-negative integer}');
      } else if (key === 'keyframes') {
        if (!Array.isArray(value) || value.length < 1 || value.length > 10) return bad(path, 'must be an array of 1 to 10 pinned frames');
        for (const [i, pin] of value.entries()) {
          if (!isObject(pin)) return bad(`${path}.${i}`, 'must be a pinned frame');
          if (!isFrameSource(pin.frame)) return bad(`${path}.${i}.frame`, 'must be a frame source');
          if (typeof pin.atSeconds !== 'number' || !Number.isFinite(pin.atSeconds) || pin.atSeconds < 0) return bad(`${path}.${i}.atSeconds`, 'must be finite and non-negative');
        }
      } else if (key === 'documentUrl' || key === 'webUrl') {
        if (!isHttpsUrl(value)) return bad(path, 'must be an https URL of at most 2,000 characters');
      } else if (key === 'instrumental' || key === 'loop') {
        if (typeof value !== 'boolean') return bad(path, 'must be true or false');
      } else if (key === 'referenceAssetIds') {
        if (!Array.isArray(value) || value.length > 16 || value.some((id) => typeof id !== 'string')) return bad(path, 'must be an array of at most 16 asset id strings');
      } else return bad(path, 'is not a known setting');
    }
    settings = { ...raw.settings } as JobSettings;
    if (settings.referenceAssetIds) settings.referenceAssetIds = [...settings.referenceAssetIds];
  }
  if (job === 'music.scored') {
    const error = scoreError(settings?.score);
    if (error) return bad(error.path, error.why);
  }
  return { ok: true, value: {
    job, prompt, projectId: raw.projectId,
    ...(raw.takes !== undefined ? { takes: raw.takes as number } : {}),
    ...(raw.policy !== undefined ? { policy: raw.policy as RoutePolicy } : {}),
    ...(raw.model !== undefined ? { model: raw.model as string } : {}),
    ...(raw.regenerateOf !== undefined ? { regenerateOf: raw.regenerateOf as string } : {}),
    ...(settings ? { settings } : {}),
  } };
}

/** Check the plan against fal's chunk and total duration bounds. */
function scoreError(value: unknown): { path: string; why: string } | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) return { path: 'settings.score', why: 'must contain 1 to 30 sections' };
  let total = 0;
  for (const [i, section] of value.entries()) {
    const path = `settings.score[${i}]`;
    if (!isObject(section)) return { path, why: 'must be a score section' };
    if (!Array.isArray(section.sceneIds) || !section.sceneIds.length || section.sceneIds.some((id) => typeof id !== 'string' || !id.trim())) return { path: `${path}.sceneIds`, why: 'must contain scene id strings' };
    if (typeof section.seconds !== 'number' || !Number.isFinite(section.seconds) || section.seconds < 3 || section.seconds > 120) return { path: `${path}.seconds`, why: 'must be from 3 to 120 seconds' };
    if (!Array.isArray(section.styles) || section.styles.some((style) => typeof style !== 'string')) return { path: `${path}.styles`, why: 'must be an array of style strings' };
    if (section.label !== undefined && typeof section.label !== 'string') return { path: `${path}.label`, why: 'must be text' };
    total += Math.round(section.seconds * 1000);
    if (total > 600000) return { path: `${path}.seconds`, why: 'makes the score longer than 600 seconds' };
  }
}

export function videoDuration(modelId: string, seconds: number): number {
  if (modelId === FLUX_VIDEO) return Math.round(clamp(seconds, 5, 5, 20));
  if (modelId === H3 || modelId === TURBO) return clamp(seconds, 5, 0.92, 15);
  return Math.round(clamp(seconds, 5, 2, 30));
}

function videoRatios(job: JobKind, model: ModelSpec): readonly string[] | undefined {
  // H3 image-to-video follows the start image, so has no aspect-ratio input.
  return (model.id === H3 || model.id === TURBO) && (job === 'video.animate' || job === 'video.between')
    ? undefined : model.caps.aspectRatios;
}

function referenceError(modelId: string, images: number, videos: number): string | undefined {
  const h3 = modelId === H3;
  const maxImages = h3 ? 9 : 10;
  const maxVideos = h3 ? 3 : 5;
  if (images + videos > maxImages + maxVideos) return `takes at most ${maxImages + maxVideos} reference files total`;
  if (images > maxImages) return `takes at most ${maxImages} reference images`;
  if (videos > maxVideos) return `takes at most ${maxVideos} reference videos`;
}

function videoCapabilityError(job: JobKind, s: JobSettings, model: ModelSpec, ctx: RouteContext): string | undefined {
  const duration = s.durationSeconds!;
  const flux = model.id === FLUX_VIDEO;
  const h3 = model.id === H3 || model.id === TURBO;
  // Exact-length jobs cannot trim away an end frame or change pinned times.
  const min = flux ? 5 : h3 ? 0.92 : 2;
  if ((job === 'video.between' || job === 'video.keyframes') && duration < min) return `makes at least ${min} s; this clip must be ${duration} s`;
  if (!flux && !h3 && (job === 'video.reference' || job === 'video.animate') && (s.start || s.end)) return "can't start or end on a chosen frame";
  const max = flux ? 20 : h3 ? 15 : 30;
  if (!Number.isFinite(duration) || duration <= 0 || duration > max) return `takes at most ${max} seconds`;
  if ((s.documentUrl || s.webUrl) && (job !== 'video.long' || flux || h3)) return 'takes document or web URLs only with video.long on Wan';
  if ((job === 'video.animate' || job === 'video.between') && !s.start) return 'needs a start frame';
  if (job === 'video.between' && !s.end) return 'needs an end frame';
  if (job === 'video.keyframes') {
    const pins = s.keyframes ?? [];
    if (pins.length < 3 || pins.length > 10) return 'needs 3 to 10 keyframes';
    if (h3 && pins.length !== 3) return 'takes exactly 3 keyframes';
    if (h3 && s.videoResolution !== '720p') return 'takes a middle frame only at 768P';
    const clipDuration = Math.min(duration, videoDuration(model.id, duration));
    if (pins.some((pin) => !Number.isFinite(pin.atSeconds) || pin.atSeconds < 0 || pin.atSeconds > clipDuration + (h3 ? 1 / 24 : 0))) return 'needs keyframe times within the clip duration';
    const positions = pins.map((pin) => flux ? Math.round(pin.atSeconds * 24) : pin.atSeconds);
    if (new Set(positions).size !== positions.length) return flux ? 'needs unique keyframe frame indices at 24 fps' : 'needs unique keyframe times';
    if (h3 && positions.some((time, i) => i > 0 && time <= positions[i - 1])) return 'needs keyframes in increasing time order';
    if (h3 && (pins[0].atSeconds > 1 / 24 || Math.abs(pins[2].atSeconds - duration) > 1 / 24 + 1e-9
      || Math.round(pins[1].atSeconds * 24) <= 0 || Math.round(pins[1].atSeconds * 24) >= Math.round(duration * 24))) {
      return 'pins the first and last frames to the ends of the clip';
    }
  }
  if (job === 'video.reference') {
    const ids = s.referenceAssetIds ?? [];
    if (!ids.length) return 'needs at least 1 reference image or video';
    const videoIds = ids.filter((id) => ctx.referenceAssetKinds?.[id] === 'video');
    if (h3 && videoIds.some((id) => (ctx.referenceAssetSeconds?.[id] ?? Infinity) < 2)) return 'needs reference clips of at least 2 s';
    if (!h3 && videoIds.some((id) => (ctx.referenceAssetFps?.[id] ?? Infinity) < 16)) return 'needs reference clips of at least 16 fps';
    const why = referenceError(model.id, ids.length - videoIds.length, videoIds.length);
    if (why) return why;
  }
  const choices = videoRatios(job, model);
  if (s.aspectRatio && choices) {
    const n = parsedRatio(s.aspectRatio);
    if (n === undefined || Math.abs(ratio(nearestRatio(n, choices)) - n) / n > 0.03) return `does not support aspect ratio ${s.aspectRatio}`;
  }
}

function capabilityError(job: JobKind, s: JobSettings, model: ModelSpec, ctx: RouteContext): string | undefined {
  if (job === 'music.scored') {
    const error = scoreError(s.score);
    if (error) return `${error.path} ${error.why}`;
  }
  if (job.startsWith('video.')) return videoCapabilityError(job, s, model, ctx);
  const refs = s.referenceAssetIds?.length ?? 0;
  if (job === 'image.cutout' && !model.caps.transparency) return 'cannot make a transparent background';
  if (job === 'image.edit' && refs < 1) return 'needs at least 1 reference image';
  if (job === 'image.composite' && refs < 2) return 'needs at least 2 reference images';
  if (model.caps.maxReferences !== undefined && refs > model.caps.maxReferences) return `takes at most ${model.caps.maxReferences} images`;
  if (s.maskAssetId !== undefined && !model.caps.mask) return 'cannot use a mask';
  if (s.resolution && model.caps.maxResolution && parseInt(s.resolution) > parseInt(model.caps.maxResolution)) return `supports at most ${model.caps.maxResolution} resolution`;
  if (s.aspectRatio && model.caps.aspectRatios && !model.caps.aspectRatios.includes(s.aspectRatio)) {
    const n = parsedRatio(s.aspectRatio);
    if (model.id !== FLUX || n === undefined || Math.abs(ratio(nearestRatio(n, model.caps.aspectRatios)) - n) / n > 0.03) return `does not support aspect ratio ${s.aspectRatio}`;
  }
}

/** Select the first capable model, or the cheapest for draft; honor overrides. */
export function route(req: GenerateRequest, policy: RoutePolicy, ctx: RouteContext): { ok: true; decision: RouteDecision } | { ok: false; error: string; dropped: RouteDecision['dropped'] } {
  const dropped: RouteDecision['dropped'] = [];
  const s = normalizeSettings(req.job, req.settings, ctx);
  const candidates = JOBS[req.job].candidates;
  const remaining = candidates.filter((id) => {
    const model = MODELS[id];
    const endpoint = model.endpoints[req.job]!;
    const why = ctx.available?.[endpoint] === false ? 'not offered by fal right now' : capabilityError(req.job, s, model, ctx);
    if (why) dropped.push({ model: id, why });
    return !why;
  });
  if (req.model !== undefined) {
    if (!candidates.includes(req.model)) {
      const label = Object.hasOwn(MODELS, req.model) ? MODELS[req.model].label : req.model;
      return { ok: false, error: `${label} does not do this job`, dropped };
    }
    const rejected = dropped.find((d) => d.model === req.model);
    if (rejected) return { ok: false, error: `${MODELS[req.model].label}: ${rejected.why}`, dropped };
  }
  if (!remaining.length) return { ok: false, error: `No model can do this: ${dropped.map((d) => `${MODELS[d.model].label}: ${d.why}`).join('; ')}`, dropped };
  const activePolicy = req.policy ?? policy;
  const override = ctx.routeOverrides?.[req.job];
  const accepted = override && remaining.includes(override) ? override : undefined;
  const suggestion = ctx.suggestions?.find((s) => s.job === req.job && remaining.includes(s.to));
  const model = req.model ?? (activePolicy === 'draft'
    ? remaining.reduce((best, id) => estimate(req, id, ctx).usd < estimate(req, best, ctx).usd ? id : best)
    : accepted ?? (activePolicy === 'balanced' ? suggestion?.to : undefined) ?? remaining[0]);
  return { ok: true, decision: {
    model, modelLabel: MODELS[model].label, endpoint: MODELS[model].endpoints[req.job]!,
    reason: req.model !== undefined ? 'your choice' : activePolicy === 'draft' ? 'draft: cheapest capable'
      : accepted ? 'your default (accepted suggestion)'
      : activePolicy === 'balanced' && suggestion ? `balanced: ${suggestion.reason}`
      : activePolicy === 'balanced' ? 'balanced: no open suggestion for this job, quality default' : 'quality default',
    overridden: req.model !== undefined, dropped,
  } };
}

function takesFor(req: GenerateRequest): number {
  return Math.floor(clamp(req.takes, 1, 1, 4));
}

function unitPrice(model: ModelSpec, job: JobKind, ctx: RouteContext): number {
  if (model.price.reserve) return ctx.gptImageReserveUsd;
  const live = ctx.livePrices?.[model.endpoints[job]!];
  return live?.unit === model.price.unit && Number.isFinite(live.unitPrice) && live.unitPrice >= 0 ? live.unitPrice : model.price.usd;
}

function videoRate(model: ModelSpec, job: JobKind, resolution: keyof VideoRates, ctx: RouteContext) {
  const table = model.endpointVideoPrices?.[job] ?? model.videoPrice!;
  const date = new Date(ctx.now ?? Date.now());
  const day = date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
  const promo = table.promotion && day <= table.promotion.through ? table.promotion : undefined;
  const price = (promo?.rates ?? table.standard)[resolution]!;
  return { price, basis: `$${price} per second at ${resolution}${promo ? ` (promotional until ${promo.label})` : ' (standard)'}` };
}

/** Cost for every take, using matching live units or the configured reserve. */
export function estimate(req: GenerateRequest, modelId: string, ctx: RouteContext): GenerationEstimate {
  const model = MODELS[modelId];
  const s = normalizeSettings(req.job, req.settings, ctx);
  const takes = takesFor(req);
  if (req.job.startsWith('video.')) {
    const { price, basis } = videoRate(model, req.job, s.videoResolution ?? '1080p', ctx);
    const quantity = videoDuration(modelId, s.durationSeconds!);
    const referenceSeconds = req.job === 'video.reference' ? (s.referenceAssetIds ?? []).reduce((sum, id) =>
      sum + (ctx.referenceAssetKinds?.[id] === 'video' ? ctx.referenceAssetSeconds?.[id] ?? 0 : 0), 0) : 0;
    const referenceRate = model.referenceVideoRates?.[s.videoResolution ?? '1080p'] ?? price;
    // Billing reconciliation still replaces estimates with actual cost when the key allows.
    return { usd: Number(((quantity * price + referenceSeconds * referenceRate) * takes).toFixed(4)),
      basis: `${takes} × ${quantity} s × ${basis}${referenceSeconds ? ` + ${referenceSeconds} s of reference clips × $${referenceRate} per second per take` : ''}` };
  }
  const price = unitPrice(model, req.job, ctx);
  if (model.price.reserve) return { usd: Number((price * takes).toFixed(4)), basis: `${takes} × ≈${formatUsd(price)} per image (budget reserve)`, reserve: true };
  let quantity = 1;
  let basis = `${formatUsd(price)} per image`;
  if (modelId === SEEDREAM) {
    const { width, height } = imageSize(modelId, s);
    quantity = width * height > 2_359_296 ? 2 : 1;
    // Reference-image surcharges are not modelled; billing reconciliation corrects actual cost.
    basis = `${quantity} units × ${formatUsd(price)}`;
  } else if (model.price.unit === 'megapixels') {
    const edge = s.resolution === '4k' ? 4096 : s.resolution === '2k' ? 2048 : 1024;
    quantity = Math.ceil(edge * edge / 1e6 * 100) / 100;
    basis = `${quantity} MP × ${formatUsd(price)} per megapixel`;
  } else if (model.price.unit === 'minutes') {
    quantity = (req.job === 'music.scored' ? (s.score ?? []).reduce((sum, section) => sum + Math.round(section.seconds * 1000) / 1000, 0) : s.durationSeconds!) / 60;
    basis = `${Number(quantity.toFixed(2))} minutes × ${formatUsd(price)} per minute`;
  } else if (model.price.unit === '1000 characters') {
    const characters = narrationTexts(req).reduce((sum, text) => sum + text.length, 0);
    quantity = characters / 1000;
    basis = `${characters} characters × ${formatUsd(price)} per 1,000 characters`;
  } else if (model.price.unit === 'seconds') {
    quantity = s.durationSeconds!;
    basis = `${quantity} seconds × ${formatUsd(price)} per second`;
  }
  return { usd: Number((quantity * price * takes).toFixed(4)), basis: `${takes} × ${basis}` };
}

/** Reservations in fal body order, preserving the rounded full-job estimate. */
export function bodyEstimates(req: GenerateRequest, modelId: string, ctx: RouteContext): number[] {
  const total = estimate(req, modelId, ctx).usd;
  const takes = takesFor(req);
  const batch = MODELS[modelId].caps.batch ?? 1;
  const weights = req.job === 'voice.narration' && req.settings?.lines
    ? Array.from({ length: takes }, () => narrationTexts(req).map((text) => text.length)).flat()
    : Array.from({ length: Math.ceil(takes / batch) }, (_, i) => Math.min(batch, takes - i * batch));
  const sum = weights.reduce((a, b) => a + b, 0);
  // Allocate cumulative rounded amounts so tiny lines cannot produce a negative remainder.
  let weight = 0, allocated = 0;
  return weights.map((value, i) => {
    weight += value;
    const cumulative = i === weights.length - 1 ? total : Number((total * weight / sum).toFixed(4));
    const amount = Number((cumulative - allocated).toFixed(4));
    allocated = cumulative;
    return amount;
  });
}

function imageSize(modelId: string, s: JobSettings): { width: number; height: number } {
  const n = modelId === GPT ? Math.max(1 / 3, Math.min(3, ratio(s.aspectRatio))) : ratio(s.aspectRatio);
  const edge = modelId === GPT ? s.resolution === '4k' ? 3840 : s.resolution === '2k' ? 2048 : 1536 : s.resolution === '2k' || s.resolution === '4k' ? 2048 : 1024;
  let width = modelId === GPT ? n >= 1 ? edge : edge * n : edge * Math.sqrt(n);
  let height = modelId === GPT ? n >= 1 ? edge / n : edge : edge / Math.sqrt(n);
  const min = modelId === GPT ? 655360 : 1048576;
  const max = modelId === GPT ? 8294400 : 4194304;
  const scale = Math.sqrt(Math.max(min, Math.min(max, width * height)) / (width * height));
  width = Math.max(16, Math.min(max / 16, Math.round(width * scale / 16) * 16));
  height = Math.max(16, Math.min(max / 16, Math.round(height * scale / 16) * 16));
  // Round inside the pixel bounds, including tiers whose target sits on a bound.
  while (width * height < min) {
    if (width / height < n) width += 16;
    else height += 16;
  }
  while (width * height > max) {
    if ((width / height > n && width > 16) || height === 16) width -= 16;
    else height -= 16;
  }
  if (modelId === GPT) {
    width = Math.min(width, height * 3);
    height = Math.min(height, width * 3);
  }
  return { width, height };
}

/** Frame sources and asset ids this request needs resolved before falInputs, for the chosen model.
 * Pass the routed model in req.model so optional model-specific frames can be omitted.
 */
export function requiredMedia(req: GenerateRequest): { start?: FrameSource; end?: FrameSource; keyframes: FrameSource[]; referenceImageIds: string[]; referenceVideoIds: string[] } {
  const s = req.settings ?? {};
  const frames = req.job === 'video.animate' || req.job === 'video.between'
    || req.job === 'video.reference' && req.model !== WAN && req.model !== WAN_PRIME;
  const references = req.job === 'image.edit' || req.job === 'image.composite' || req.job === 'video.reference';
  return {
    ...(frames && s.start ? { start: s.start } : {}),
    ...(frames && req.job !== 'video.animate' && s.end ? { end: s.end } : {}),
    keyframes: req.job === 'video.keyframes' ? (s.keyframes ?? []).map((pin) => pin.frame) : [],
    // IDs carry no asset kinds. Return all here; the server re-splits them by asset kind.
    referenceImageIds: references ? [...s.referenceAssetIds ?? []] : [],
    referenceVideoIds: [],
  };
}

interface ResolvedMedia {
  referenceUrls: string[];
  maskUrl?: string;
  referenceVideoUrls?: string[];
  startUrl?: string;
  endUrl?: string;
  keyframeUrls?: string[];
}

function videoInput(req: GenerateRequest, modelId: string, s: JobSettings, refs: ResolvedMedia): Record<string, unknown> {
  const duration = videoDuration(modelId, s.durationSeconds!);
  const choices = videoRatios(req.job, MODELS[modelId]);
  const aspect = choices ? nearestRatio(ratio(s.aspectRatio), choices) : undefined;
  if (req.job === 'video.reference') {
    const why = referenceError(modelId, refs.referenceUrls.length, refs.referenceVideoUrls?.length ?? 0);
    if (why) throw new Error(`${MODELS[modelId].label}: ${why}`);
    if (!refs.referenceUrls.length && !refs.referenceVideoUrls?.length) throw new Error('needs at least 1 reference image or video');
  }
  if ((req.job === 'video.animate' || req.job === 'video.between') && !refs.startUrl) throw new Error('needs a resolved start frame');
  if (req.job === 'video.between' && !refs.endUrl) throw new Error('needs a resolved end frame');
  if (req.job === 'video.keyframes' && refs.keyframeUrls?.length !== s.keyframes?.length) throw new Error('needs every keyframe resolved in order');
  if (modelId === FLUX_VIDEO) return {
    prompt: req.prompt, aspect_ratio: aspect, duration, resolution: s.videoResolution, generate_audio: false,
    ...(req.job === 'video.animate' || req.job === 'video.between' ? { image_url: refs.startUrl } : {}),
    ...(req.job === 'video.between' ? { end_image_url: refs.endUrl } : {}),
    ...(req.job === 'video.keyframes' ? { keyframes: s.keyframes!.map((pin, i) => ({ image_url: refs.keyframeUrls![i], frame_index: Math.round(pin.atSeconds * 24) })) } : {}),
  };
  if (modelId === H3 || modelId === TURBO) {
    const body: Record<string, unknown> = { prompt: req.prompt, prompt_expansion_mode: 'balanced', duration, resolution: s.videoResolution === '720p' ? '768P' : '1080P' };
    if (aspect) body.aspect_ratio = aspect;
    if (req.job === 'video.keyframes') Object.assign(body, {
      image_url: refs.keyframeUrls![0], middle_image_url: refs.keyframeUrls![1],
      middle_frame_time: s.keyframes![1].atSeconds, end_image_url: refs.keyframeUrls![2],
    });
    else if (req.job === 'video.reference') Object.assign(body, {
      ...(refs.referenceUrls.length ? { reference_image_urls: refs.referenceUrls } : {}),
      ...(refs.referenceVideoUrls?.length ? { reference_video_urls: refs.referenceVideoUrls } : {}),
      ...(refs.startUrl ? { image_url: refs.startUrl } : {}),
      ...(refs.endUrl ? { end_image_url: refs.endUrl } : {}),
    });
    else if (req.job === 'video.animate' || req.job === 'video.between') Object.assign(body, {
      image_url: refs.startUrl, ...(req.job === 'video.between' ? { end_image_url: refs.endUrl } : {}),
    });
    return body;
  }
  return {
    prompt: req.prompt, duration, resolution: s.videoResolution, aspect_ratio: aspect ?? 'adaptive', audio: false, enable_prompt_expansion: true,
    ...(req.job === 'video.animate' ? { reference_image_urls: [refs.startUrl] } : {}),
    ...(req.job === 'video.reference' && refs.referenceUrls.length ? { reference_image_urls: refs.referenceUrls } : {}),
    ...(req.job === 'video.reference' && refs.referenceVideoUrls?.length ? { reference_video_urls: refs.referenceVideoUrls } : {}),
    ...(req.job === 'video.long' && (s.documentUrl || s.webUrl) ? {
      enable_thinking: true,
      ...(s.documentUrl ? { file_url: s.documentUrl } : {}), ...(s.webUrl ? { web_url: s.webUrl } : {}),
    } : {}),
  };
}

/** Build fal bodies, batching images and sending one video take per body. */
export function falInputs(req: GenerateRequest, modelId: string, refs: ResolvedMedia, ctx: Pick<RouteContext, 'project'>): Record<string, unknown>[] {
  const model = MODELS[modelId];
  const s = normalizeSettings(req.job, req.settings, ctx);
  if (req.job === 'music.scored') {
    const error = scoreError(s.score);
    if (error) throw new Error(`${error.path} ${error.why}.`);
  }
  if (req.job === 'voice.narration' && s.lines) {
    const texts = narrationTexts(req);
    return Array.from({ length: takesFor(req) }, (_, take) => texts.map((text, line) => ({
      text, voice: s.voice, timestamps: true,
      ...(s.languageCode ? { language_code: s.languageCode } : {}),
      ...(s.seed !== undefined ? { seed: s.seed + take * texts.length + line } : {}),
    }))).flat();
  }
  const batch = model.caps.batch ?? 1;
  const bodies: Record<string, unknown>[] = [];
  const edit = req.job === 'image.edit' || req.job === 'image.composite';
  for (let remaining = takesFor(req); remaining > 0; remaining -= batch) {
    const count = Math.min(batch, remaining);
    let body: Record<string, unknown>;
    if (req.job.startsWith('video.')) body = videoInput(req, modelId, s, refs);
    else if (modelId === GPT) body = {
      prompt: req.prompt, image_size: edit && req.settings?.aspectRatio === undefined ? 'auto' : imageSize(modelId, s),
      background: req.job === 'image.cutout' ? 'transparent' : 'auto', quality: 'high', num_images: count, output_format: 'png',
      ...(edit ? { image_urls: refs.referenceUrls.slice(0, 16) } : {}),
      ...(edit && refs.maskUrl ? { mask_url: refs.maskUrl } : {}),
    };
    else if (modelId === SEEDREAM) body = {
      prompt: req.prompt, image_size: imageSize(modelId, s), num_images: count, output_format: 'png',
      ...(edit ? { image_urls: refs.referenceUrls.slice(0, 10) } : {}),
    };
    else if (modelId === FLUX) body = {
      prompt: req.prompt, aspect_ratio: nearestRatio(ratio(s.aspectRatio), FLUX_RATIOS), resolution: s.resolution, output_format: 'png',
      ...(edit ? { image_urls: refs.referenceUrls.slice(0, 10) } : {}),
    };
    else if (modelId === MUSIC && req.job === 'music.scored') body = { composition_plan: { chunks: s.score!.map((section, i) => ({
      text: `[${section.label || `Section ${i + 1}`}]`, duration_ms: Math.round(section.seconds * 1000),
      positive_styles: [...req.prompt.split(',').map((style) => style.trim()).filter(Boolean).slice(0, 8), ...section.styles, ...(s.bpm ? [`${s.bpm} BPM`] : []), 'instrumental'],
      context_adherence: 'high',
    })) } };
    else if (modelId === MUSIC) body = { prompt: req.prompt, music_length_ms: Math.round(s.durationSeconds! * 1000), force_instrumental: s.instrumental };
    else if (modelId === VOICE) body = { text: req.prompt, voice: s.voice, timestamps: true, ...(s.languageCode ? { language_code: s.languageCode } : {}) };
    else body = { text: req.prompt, duration_seconds: s.durationSeconds, loop: !!s.loop };
    // Image endpoints take no seed; voice, scored music and video accept it.
    if (s.seed !== undefined && (modelId === VOICE || req.job === 'music.scored' || req.job.startsWith('video.'))) body.seed = s.seed + bodies.length;
    bodies.push(body);
  }
  return bodies;
}

function narrationTexts(req: GenerateRequest): string[] {
  return req.job === 'voice.narration' && req.settings?.lines
    ? req.settings.lines.filter((line) => line.text.trim()).map((line) => line.text) : [req.prompt];
}

/** Scene tags in precisely the same order as falInputs' bodies. */
export function bodySceneIds(req: GenerateRequest): (string | undefined)[] {
  if (req.job === 'voice.narration' && req.settings?.lines) {
    const ids = req.settings.lines.filter((line) => line.text.trim()).map((line) => line.sceneId);
    return Array.from({ length: takesFor(req) }, () => ids).flat();
  }
  const model = req.model ?? JOBS[req.job].candidates[0];
  const batch = MODELS[model]?.caps.batch ?? 1;
  return Array.from({ length: Math.ceil(takesFor(req) / batch) }, () => undefined);
}

/** Read media files, ignoring malformed values and non-HTTPS URLs. */
export function extractOutputs(job: JobKind, result: unknown): { url: string; contentType?: string; width?: number; height?: number; duration?: number; seed?: number }[] {
  if (!isObject(result)) return [];
  const images = JOBS[job].media === 'image';
  const video = JOBS[job].media === 'video';
  const files: unknown[] = images ? Array.isArray(result.images) ? result.images : [] : [video ? result.video : result.audio];
  return files.flatMap((file) => {
    if (!isObject(file) || typeof file.url !== 'string') return [];
    try {
      const url = new URL(file.url);
      if (url.protocol !== 'https:' || !url.hostname) return [];
    } catch { return []; }
    const output: { url: string; contentType?: string; width?: number; height?: number; duration?: number; seed?: number } = { url: file.url };
    if (typeof file.content_type === 'string') output.contentType = file.content_type;
    if (images || video) {
      for (const key of ['width', 'height'] as const) if (typeof file[key] === 'number' && Number.isFinite(file[key]) && file[key] > 0) output[key] = file[key];
      if (typeof result.seed === 'number' && Number.isFinite(result.seed)) output.seed = result.seed;
      if (video && typeof file.duration === 'number' && Number.isFinite(file.duration) && file.duration > 0) output.duration = file.duration;
    }
    return [output];
  });
}

function priceLabel(model: ModelSpec, job: JobKind, ctx: RouteContext): string {
  if (model.price.reserve) return `≈${formatUsd(ctx.gptImageReserveUsd)} per image (budget reserve)`;
  if (job.startsWith('video.')) return videoRate(model, job, '1080p', ctx).basis;
  const unit = { units: 'image', megapixels: 'megapixel', minutes: 'minute', '1000 characters': '1,000 characters', seconds: 'second' }[model.price.unit];
  const price = unitPrice(model, job, ctx);
  return `${job.startsWith('video.') ? `$${price}` : formatUsd(price)} per ${unit}`;
}

/** Describe all jobs in contract order, with each policy's unconstrained pick. */
export function modelsResponse(policy: RoutePolicy, ctx: RouteContext): GenerationModelsResponse {
  return { routeVersion: ROUTE_VERSION, policy, jobs: JOB_KINDS.map((job) => {
    const spec = JOBS[job];
    const req: GenerateRequest = { job, prompt: 'Example', projectId: '', settings:
      job === 'music.scored' ? { score: [{ sceneIds: ['scene-1'], seconds: 30, styles: [] }] }
      : job === 'image.edit' || job === 'image.composite' || job === 'video.reference' ? { referenceAssetIds: ['image-1', 'image-2'] }
      : job === 'video.animate' ? { start: { projectFrame: 0 } }
      : job === 'video.between' ? { start: { projectFrame: 0 }, end: { projectFrame: 120 } }
      : job === 'video.keyframes' ? { keyframes: [0, 2.5, 5].map((atSeconds) => ({ frame: { projectFrame: atSeconds * 24 }, atSeconds })) }
      : undefined };
    const defaults = {} as Record<RoutePolicy, string>;
    for (const p of policies) {
      const pick = route(req, p, ctx);
      defaults[p] = pick.ok ? pick.decision.model : '';
    }
    return {
      job, media: spec.media, label: spec.label, hint: spec.hint, defaults,
      models: spec.candidates.map((id) => {
        const model = MODELS[id];
        const endpoint = model.endpoints[job]!;
        return { id, label: model.label, endpoint, priceLabel: priceLabel(model, job, ctx), available: ctx.available?.[endpoint] ?? null, license: model.license };
      }),
    };
  }) };
}
