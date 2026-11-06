// The generation studio's shared contract: job kinds, routing
// policies, jobs, outcomes, settings and the key status, plus the HTTP
// routes that carry them. The local server (server/generation/), the MCP
// server (mcp/tools.ts) and the editor (Generate tab, Settings › Generation,
// takes) all import these types — change them here, never ad hoc.
//
// A request names a job kind, not a model. The router
// (generationRoutes.ts) picks the model for the active policy, maps the
// request onto the model's input and estimates the cost. The person (or an
// agent) can override the model; the override is recorded.
//
// HTTP (all JSON, all under the local server; errors are ApiError):
//
//   GET    /api/generation/status          → GenerationStatus
//   PUT    /api/generation/settings        (Partial<GenerationSettings>) → GenerationSettings     [editor origin only]
//   PUT    /api/generation/key             ({ key }) → FalKeyStatus (tested first; a rejected key is not saved) [editor origin only]
//   POST   /api/generation/key/test        → FalKeyStatus                                        [editor origin only]
//   DELETE /api/generation/key             → FalKeyStatus                                        [editor origin only]
//   GET    /api/generation/models          → GenerationModelsResponse
//   POST   /api/generation/estimate        (GenerateRequest) → GenerationQuote
//   POST   /api/generation/jobs            (GenerateRequest & { agent?, confirmed? }) → { job: GenerationJob }
//   GET    /api/generation/jobs?projectId= → GenerationJob[] (this server run's jobs, newest first)
//   GET    /api/generation/jobs/:id        → GenerationJob
//   POST   /api/generation/jobs/:id/cancel → GenerationJob
//   POST   /api/generation/jobs/:id/delivered → GenerationJob (the editor added its outputs to the project)
//   POST   /api/generation/outcomes        (OutcomeReport) → { ok: true }
//   GET    /api/generation/thumbs?jobIds=a,b → Record<assetId, 1 | -1> (the takes' current 👍/👎, from the records)
//   GET    /api/generation/scoreboard      → GenerationScoreboard (Phase C)
//   POST   /api/generation/route-overrides ({ job, model: string | null }) → GenerationScoreboard   [editor origin only]
//   POST   /api/generation/suggestions/dismiss ({ job, model }) → GenerationScoreboard           [editor origin only]
//
// Who asked: a request carrying the editor's Origin header is the person's
// own click; a request without an Origin is an agent (MCP). Agent requests
// always wait for the permission card; the person's own clicks skip it when
// settings.skipCardForOwnClicks is on (the price is on the button). Key and
// settings writes are refused without the editor's Origin, so an agent can
// never change the key, the budget or the confirmation threshold.
//
// Jobs stream to the editor as `generation-job` events (the whole
// GenerationJob on every change) on the editor event stream.
//
// The fal key never leaves the local server: not in projects, the generation
// log, records, jobs, events, MCP output, chat transcripts or error text.

import type { Asset } from './types';

export type GenerationMedia = 'music' | 'voice' | 'sfx' | 'image' | 'video';

/** Phase A: audio and images. Phase B: video.*. Phase C: music.scored and per-scene narration. */
export type JobKind =
  | 'music.bed'
  /** Music scored to the cut: one composition section per scene, changing at the scene cuts. */
  | 'music.scored'
  | 'voice.line'
  | 'voice.narration'
  | 'sfx.hit'
  | 'sfx.ambience'
  | 'image.generate'
  | 'image.cutout'
  | 'image.typography'
  | 'image.plate'
  | 'image.edit'
  | 'image.composite'
  /** A clip from text. */
  | 'video.generate'
  /** Animate a still (settings.start). */
  | 'video.animate'
  /** From a start frame to an end frame, e.g. across a scene cut (settings.start + settings.end). */
  | 'video.between'
  /** Three or more frame-pinned images (settings.keyframes). */
  | 'video.keyframes'
  /** The same subject or product across shots (settings.referenceAssetIds: images, and up to 3 video clips). */
  | 'video.reference'
  /** Over 15 s, or built from a document or web page (settings.documentUrl / settings.webUrl). */
  | 'video.long';

export const JOB_KINDS: readonly JobKind[] = [
  'music.bed',
  'music.scored',
  'voice.line',
  'voice.narration',
  'sfx.hit',
  'sfx.ambience',
  'image.generate',
  'image.cutout',
  'image.typography',
  'image.plate',
  'image.edit',
  'image.composite',
  'video.generate',
  'video.animate',
  'video.between',
  'video.keyframes',
  'video.reference',
  'video.long',
];

/**
 * A frame given to a video model: a project image asset, or a frame of the
 * open project that the server renders as a still (e.g. a scene's last frame).
 */
export type FrameSource = { assetId: string } | { projectFrame: number };

/** quality: the best capable model (default). balanced: measured results only (Phase C; until then it behaves as quality). draft: the cheapest capable model. */
export type RoutePolicy = 'quality' | 'balanced' | 'draft';

/** Model-neutral settings; the registry maps them onto each model's input. Unknown or inapplicable settings are ignored. */
export interface JobSettings {
  /** "16:9", "9:16", "1:1", "4:3", "21:9" … — images; from the project format by default. */
  aspectRatio?: string;
  /** Image resolution tier; plates default to '2k'. */
  resolution?: '1k' | '2k' | '4k';
  /** Music, sound effects and video: length in seconds (music 3–600, sfx 0.5–22, video 2–30 depending on the model). */
  durationSeconds?: number;
  /** Voice: an ElevenLabs voice name ("Rachel", "Aria", …). */
  voice?: string;
  /** Voice: ISO 639-1. */
  languageCode?: string;
  /** Music: instrumental only (music.bed defaults to true). */
  instrumental?: boolean;
  /** Sound effects: loops seamlessly (sfx.ambience defaults to true). */
  loop?: boolean;
  /** image.edit / image.composite: project asset ids, in order (the first is the image being edited). */
  referenceAssetIds?: string[];
  /** image.edit: a project image whose transparent area marks what to change (GPT Image only). */
  maskAssetId?: string;
  seed?: number;
  /** Video: output resolution tier (default 1080p, quality first). */
  videoResolution?: '720p' | '1080p';
  /** video.animate / video.between / video.reference: the first frame. */
  start?: FrameSource;
  /** video.between (and optionally video.reference): the last frame. */
  end?: FrameSource;
  /** video.keyframes: 3–10 frames pinned to times in the clip (seconds from its start, unique, within durationSeconds). */
  keyframes?: { frame: FrameSource; atSeconds: number }[];
  /** video.long: a public document URL or web page the clip is built from (https only). */
  documentUrl?: string;
  webUrl?: string;
  /** music.scored: the plan, one section per scene (short scenes merged to reach 3 s). Built from the scenes and story by default. */
  score?: ScoreSection[];
  /** music.scored: tempo in BPM, sent as a style and used to judge the cut alignment. */
  bpm?: number;
  /** voice.narration: one line per scene; each becomes its own take, tagged with its scene. */
  lines?: { sceneId: string; text: string }[];
}

/** One section of a scored bed: a scene, or adjacent short scenes merged to reach 3 s. */
export interface ScoreSection {
  /** Scene ids this section covers, in order. */
  sceneIds: string[];
  /** Section length in seconds (the sum of its scenes). */
  seconds: number;
  /** Musical direction for this section ("quiet, building", "full, driving"). Editable. */
  styles: string[];
  /** Optional section label sent to the model ("Hook"). */
  label?: string;
}

/** Per-output details beyond the Asset (GenerationJob.outputMeta[assetId]). */
export interface GeneratedOutputMeta {
  /** Narration: the scene this line belongs to. */
  sceneId?: string;
  /** Narration: word timings in seconds from the start of the take (from the model's timestamps). */
  words?: { text: string; start: number; end: number }[];
  /** Scored music: where each scene cut falls against the bed's downbeats (project frames, assuming the bed starts at frame 0). */
  cuts?: { sceneId: string; cutFrame: number; nearestDownbeatFrame: number | null; offsetFrames: number | null }[];
  /** Scored music: the tempo the analysis found. */
  bpm?: number | null;
  /** Scored music: every downbeat the analysis found, in frames of the file at the project's fps (frame 0 = the file's first sample). */
  downbeats?: number[];
}

export interface GenerateRequest {
  job: JobKind;
  /** The prompt; for voice jobs, the text to speak. */
  prompt: string;
  /** A registry model id ("gpt-image-2.5-flare"); omitted = the route's pick for the policy. */
  model?: string;
  /** Omitted = settings.policy. */
  policy?: RoutePolicy;
  settings?: JobSettings;
  /** Takes per request, 1–4 (default 1). */
  takes?: number;
  /** The project the takes land in. */
  projectId: string;
  /** "More like this" / asking again: the job this repeats. Its record counts a regeneration (a rejection signal). */
  regenerateOf?: string;
}

/** One model as the Generate tab and editor_generation_models show it. */
export interface GenerationModelInfo {
  /** Registry id, e.g. 'seedream-5-pro'. */
  id: string;
  /** "Seedream 5.0 Pro". */
  label: string;
  /** The fal endpoint this model uses for this job kind. */
  endpoint: string;
  /** "$0.0675 per image", "$0.60 per minute", "≈$0.50 per image (budget reserve)". */
  priceLabel: string;
  /** false when the startup endpoint check did not find it (it drops out of routing). null: not checked (no key yet). */
  available: boolean | null;
  /** Short licence note for provenance and credits. */
  license?: string;
}

export interface JobRouteInfo {
  job: JobKind;
  media: GenerationMedia;
  /** Plain choice text: "Cutout with transparent background". */
  label: string;
  /** One-line prompt helper for the prompt box. */
  hint: string;
  /** Candidates in route order; the quality default first. */
  models: GenerationModelInfo[];
  /** The model each policy picks with no constraints (ids). */
  defaults: Record<RoutePolicy, string>;
}

export interface GenerationModelsResponse {
  routeVersion: string;
  policy: RoutePolicy;
  jobs: JobRouteInfo[];
}

/** What a request would cost (before it runs). */
export interface GenerationEstimate {
  /** Total for all takes, USD. */
  usd: number;
  /** "2 × $0.0675 per image". */
  basis: string;
  /** The figure is a budget reserve, not a list price (GPT Image until billing events confirm real costs). */
  reserve?: boolean;
}

/** The router's answer for one request. */
export interface RouteDecision {
  model: string;
  modelLabel: string;
  endpoint: string;
  /** "quality default", "draft: cheapest capable", "your choice". */
  reason: string;
  /** True when the request named a model. */
  overridden: boolean;
  /** Candidates that could not take the request, and why ("needs at most 10 references"). */
  dropped: { model: string; why: string }[];
}

/** POST /api/generation/estimate. */
export interface GenerationQuote {
  route: RouteDecision;
  estimate: GenerationEstimate;
  /** Today's spend so far (local day), USD. */
  spendTodayUsd: number;
  budgetUsd: number;
  /** This request would take today's spend over the budget; it would be refused. */
  overBudget: boolean;
  /** Over the single-request confirmation threshold: the editor must confirm (POST jobs with confirmed: true). */
  needsConfirm: boolean;
}

export type GenerationJobStatus =
  | 'awaiting-permission'
  | 'queued'
  | 'running'
  | 'importing'
  | 'done'
  | 'failed'
  | 'cancelled'
  | 'denied';

export type GenerationFailure =
  | 'interrupted'
  | 'no_key'
  | 'auth' /* 401/403 from fal */
  | 'rejected_input' /* 422 */
  | 'provider_error' /* 5xx: fal does not bill these */
  | 'timeout'
  | 'network'
  | 'import_failed'
  | 'budget'
  | 'model_unavailable';

export interface GenerationJob {
  /** 'gjob_…'; also each take's provenance.requestId, so the takes group. */
  id: string;
  projectId: string;
  job: JobKind;
  prompt: string;
  model: string;
  modelLabel: string;
  endpoint: string;
  policy: RoutePolicy;
  routeVersion: string;
  overridden: boolean;
  settings: JobSettings;
  takes: number;
  requestedBy: { origin: 'user' | 'agent'; agent?: string };
  regenerateOf?: string;
  status: GenerationJobStatus;
  /** Epoch ms. */
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  /** While queued at fal. */
  queuePosition?: number;
  estimate: GenerationEstimate;
  /** From fal billing events when the key allows; otherwise absent. */
  actualUsd?: number;
  /** false for failures fal does not bill (5xx, never submitted). */
  billed?: boolean;
  /** fal request ids, one per submitted request. */
  falRequestIds: string[];
  /** Imported takes: complete Asset objects (provenance filled), ready for an addAsset command. */
  outputs: Asset[];
  error?: { type: GenerationFailure; message: string };
  note?: string;
  /** Per-output details: narration scenes and word timings, scored-bed cut alignment. */
  outputMeta?: Record<string, GeneratedOutputMeta>;
  /** The editor added the outputs to the project (POST …/delivered). */
  delivered: boolean;
}

export type OutcomeEvent =
  | 'auditioned'
  | 'used'
  | 'kept'
  | 'replaced'
  | 'deleted'
  | 'thumbsUp'
  | 'thumbsDown'
  | 'thumbCleared';

/** POST /api/generation/outcomes. `jobId` is the take's provenance.requestId. */
export interface OutcomeReport {
  jobId: string;
  assetId: string;
  event: OutcomeEvent;
}

export interface GenerationSettings {
  /** Default 5. */
  dailyBudgetUsd: number;
  /** A single request over this asks for confirmation. Default 1. */
  confirmOverUsd: number;
  /** The person's own clicks skip the permission card. Default true. */
  skipCardForOwnClicks: boolean;
  /** Budget reserve per GPT Image 2.5 image until real costs are measured. Default 0.5. */
  gptImageReserveUsd: number;
  /** Default 'quality'. */
  policy: RoutePolicy;
  /** Accepted route suggestions: the job's default model. Default {}. */
  routeOverrides: Partial<Record<JobKind, string>>;
  /** Dismissed suggestions as "<job>:<model>": not shown and not followed by Balanced. Default []. */
  dismissedSuggestions: string[];
}

export const DEFAULT_GENERATION_SETTINGS: GenerationSettings = {
  dailyBudgetUsd: 5,
  confirmOverUsd: 1,
  skipCardForOwnClicks: true,
  gptImageReserveUsd: 0.5,
  policy: 'quality',
  routeOverrides: {},
  dismissedSuggestions: [],
};

/** Runs per model a job kind needs before the scoreboard suggests a route change. */
export const SUGGESTION_THRESHOLD = 20;

/** One job kind × model row of the scoreboard (all projects, this user). */
export interface ModelScore {
  job: JobKind;
  model: string;
  modelLabel: string;
  runs: number;
  /** Takes generated across those runs. */
  takes: number;
  /** used ÷ takes, 0–1. */
  useRate: number;
  /** kept ÷ takes, 0–1. */
  keepRate: number;
  thumbsUp: number;
  thumbsDown: number;
  /** Share of checked outputs that matched the request, 0–1; null with no checks. */
  matchRate: number | null;
  /** Spend ÷ kept takes, USD; null when nothing was kept. */
  costPerKept: number | null;
  /** Median seconds from request to done; null when unknown. */
  p50Seconds: number | null;
  /** failed ÷ runs, 0–1. */
  failureRate: number;
  /** Fewer than SUGGESTION_THRESHOLD runs: too few to trust. */
  smallSample: boolean;
  /** Runs where the person or agent picked this model over the route's default. */
  overrides: number;
}

export interface RouteSuggestion {
  job: JobKind;
  /** The job's current default model. */
  from: string;
  /** The suggested model. */
  to: string;
  /** cheaper: use and keep rates within 5 points of the default at a lower cost per kept take. better: a higher keep rate and a lower cost per kept take. */
  kind: 'cheaper' | 'better';
  /** One plain sentence with the numbers behind it. */
  reason: string;
}

/** GET /api/generation/scoreboard. */
export interface GenerationScoreboard {
  rows: ModelScore[];
  suggestions: RouteSuggestion[];
  overrides: Partial<Record<JobKind, string>>;
  threshold: number;
}

/** What the browser may know about the key: never the key itself. */
export interface FalKeyStatus {
  configured: boolean;
  source?: 'keychain' | 'file' | 'env';
  /** "ab12": the last four characters. */
  last4?: string;
  /** The last test: true = fal accepted it. */
  valid?: boolean;
  /** The key can read billing events (BILLING or FULL preset): actual costs replace estimates. null = unknown. */
  billing?: boolean | null;
  checkedAt?: number;
  /** Why the last test failed, in plain words (never containing the key). */
  error?: string;
}

/** GET /api/generation/status. */
export interface GenerationStatus {
  key: FalKeyStatus;
  settings: GenerationSettings;
  spendTodayUsd: number;
  /** Jobs queued or running now. */
  activeJobs: number;
}

/** The editor event-stream event that carries a GenerationJob. */
export const GENERATION_JOB_EVENT = 'generation-job';

/** "$0.27" / "$0.0675" / "$12.40": two decimals, up to four below ten cents. */
export function formatUsd(usd: number): string {
  if (!Number.isFinite(usd)) return '$—';
  if (usd > 0 && usd < 0.1) return `$${usd.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`;
  return `$${usd.toFixed(2)}`;
}
