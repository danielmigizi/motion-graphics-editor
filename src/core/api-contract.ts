// HTTP contract between the editor (browser) and the local server
// (server/index.ts, default port 5318; Vite proxies /api and /renders).
// Both sides import these types — change them here, never ad hoc.

import type { AiPatch, ChangeEntry, CommandError, CommandErrorCode, EditRequest, Project, ProjectFile, ProjectStory, StylePack } from './types';
import type { SiteCopy } from './siteCopy';
import type { GenerationAsk } from './generation';

export const DEFAULT_SERVER_PORT = 5318;

export interface ProjectSummary {
  id: string;
  name: string;
  revision: number;
  savedAt: string;
}

export interface CheckpointSummary {
  id: string;
  name: string;
  note?: string;
  createdAt: string;
  revision: number;
  projectHash: string;
}
export interface Checkpoint extends CheckpointSummary { file: ProjectFile }
export interface SaveCheckpointRequest { name: string; note?: string; file: ProjectFile }
export interface JournalSummary { id: string; revision: number; createdAt: string }
export interface JournalEntry extends JournalSummary { file: ProjectFile }
/** GET/POST /api/projects/:id/checkpoints; GET/DELETE /:checkpoint */
/** GET /api/projects/:id/journal; GET /:entry. PUT ?autosave=1 appends to the journal. */

/** GET /api/projects → ProjectSummary[] */
/** GET /api/projects/:id → ProjectFile | 404 ApiError */
/** PUT /api/projects/:id (body: ProjectFile) → SaveProjectResponse | 400 ApiError */
export interface SaveProjectResponse {
  ok: true;
  savedAt: string;
}

/**
 * POST /api/assets?filename=<original name>  (raw body, Content-Type = file mime)
 * Stores under public/assets/uploads/ and returns asset metadata (no id —
 * the editor assigns the id and issues an addAsset/replaceAsset command).
 */
export interface UploadAssetResponse {
  src: string; // e.g. 'assets/uploads/u_ab12cd.png'
  name: string;
  mimeType: string;
  kind: 'image' | 'svg' | 'audio' | 'video';
  width?: number;
  height?: number;
  /** Audio and video, in seconds (editor converts to frames). */
  durationSeconds?: number;
  /** Video only: average frame rate, soundtrack present (and playable), codec, file size. */
  fps?: number;
  hasAudio?: boolean;
  codec?: string;
  bytes?: number;
  /** Video only: a preview proxy is being made in the background ('pending'; poll GET /api/assets/proxy) or not needed ('none'). */
  proxy?: 'pending' | 'none';
  /** Why a proxy is made, e.g. "variable frame rate". */
  proxyReasons?: string[];
}

/** GET /api/assets/proxy?src= — read-only status of a video asset's preview proxy. POST /api/assets/proxy?src= (editor origin only) asks for one to be made. */
export interface AssetProxyResponse {
  status: 'none' | 'pending' | 'ready' | 'failed';
  /** When ready: asset-root-relative path to store as the asset's proxySrc. */
  proxySrc?: string;
  error?: string;
  reasons: string[];
}

/** GET /api/assets/probe?src= */
export interface AssetProbeResponse {
  exists: boolean;
  bytes?: number;
  /** Sniffed from the file's bytes (not its extension). */
  mimeType?: string;
  width?: number;
  height?: number;
  decodable: boolean;
  /** Why it is missing or not decodable, in words. */
  error?: string;
  /** Video only (ffprobe). */
  durationSeconds?: number;
  fps?: number;
  codec?: string;
  hasAudio?: boolean;
}

/** GET /api/assets/check?src=<src> → { exists: boolean } (missing-asset diagnostics) */
export interface AssetCheckResponse {
  exists: boolean;
}

/** Openverse catalog search / import (server-side; MCP tools call these). */
export interface OpenverseRateLimit {
  limitMinute?: number;
  remainingMinute?: number;
  limitDay?: number;
  remainingDay?: number;
  retryAfterSeconds?: number;
}

export interface OpenverseAudioHit {
  id: string;
  title: string;
  creator?: string;
  creatorUrl?: string;
  durationSeconds: number | null;
  license: string;
  licenseVersion?: string;
  licenseUrl?: string;
  attribution: string;
  category?: string;
  provider?: string;
  source?: string;
  foreignLandingUrl?: string;
  previewUrl?: string;
  thumbnail?: string;
  tags: string[];
}

export interface OpenverseSearchResponse {
  results: OpenverseAudioHit[];
  page: number;
  pageCount: number;
  resultCount: number;
  authenticated: boolean;
  rateLimit?: OpenverseRateLimit;
  /** Always present so agents credit the catalog. */
  notice: string;
}

export interface OpenverseImportResponse {
  src: string;
  name: string;
  mimeType: string;
  kind: 'audio';
  bytes?: number;
  durationSeconds?: number;
  cached: boolean;
  work: OpenverseAudioHit;
  notice: string;
}

export interface OpenverseStatusResponse {
  authenticated: boolean;
  apiBase: string;
  notice: string;
}

/** Engine that rendered a job. */
export type RenderEngine = 'native';

export type DeliveryPreset = 'mp4-1080' | 'mp4-720' | 'mp4-2160' | 'webm-1080' | 'prores-1080' | 'gif-480';
export type StillPreset = 'png-full' | 'jpeg-thumb';
export interface ExportStillRequest { project: Project; frame: number; preset: StillPreset }
export interface ExportStillResponse { url: string; path: string; width: number; height: number }

export type RenderStatus = 'queued' | 'bundling' | 'rendering' | 'encoding' | 'done' | 'failed' | 'cancelled' | 'interrupted';

export interface RenderJob {
  id: string;
  projectId: string;
  /** Revision of the project snapshot being rendered. */
  projectRevision: number;
  preset?: DeliveryPreset;
  manifestUrl?: string;
  projectHash?: string;
  rendererVersion?: string;
  /** Engine that rendered it (absent on older job records). */
  engine?: RenderEngine;
  status: RenderStatus;
  /** 0..1 overall. */
  progress: number;
  renderedFrames: number;
  encodedFrames: number;
  totalFrames: number;
  /** Failure or interruption reason. */
  error?: string;
  /** e.g. '/renders/r_abc.mp4' when done. */
  outputUrl?: string;
  /** Absolute filesystem path when done. */
  outputPath?: string;
  createdAt: string;
  finishedAt?: string;
  /** Job id this one retried. */
  retryOf?: string;
}

/** POST /api/renders (body: StartRenderRequest) → RenderJob */
export interface StartRenderRequest {
  project: Project;
  preset?: DeliveryPreset;
  /** Test hook: fail deliberately once progress passes this value (0..1). */
  simulateFailureAtProgress?: number;
}
/** GET /api/renders → RenderJob[] (newest first) */
/** GET /api/renders/:id → RenderJob */
/** GET /api/renders/:id/project → Project (the exact snapshot rendered) */
/** POST /api/renders/:id/cancel → RenderJob (404 unknown, 409 terminal) */
/** GET /api/renders/:id/manifest → RenderManifest; ?verify=1 → { manifest, changedAssets } */
/** POST /api/renders/:id/retry → RenderJob (new job, same snapshot, no failure hook) */
/** GET /renders/<id>.mp4 → the file */

export interface RenderManifest {
  format: 'mge.manifest/1';
  projectId: string;
  projectRevision: number;
  preset?: DeliveryPreset;
  projectHash: string;
  assets: { id: string; src: string; sha256: string | null; bytes: number | null; missing: boolean }[];
  fonts: { family: string; package: string; version: string }[];
  renderer: { engine?: RenderEngine; version?: string; node: string };
  code: { gitCommit: string | null; dirty: boolean | null; compositionHash: string };
  createdAt: string;
}

export interface FrameIdentity {
  projectId: string;
  revision: number;
  projectHash: string;
  kind: 'committed' | 'proposal';
  proposalId?: string;
  frame: number;
  rendererVersion: string;
  compositionHash: string;
}

/** POST /api/stills/contact-sheet → ContactSheetResponse (1..24 valid frames). */
export interface ContactSheetRequest {
  project: Project;
  frames: number[];
  columns?: number;
  scale?: number;
}

export interface ContactSheetResponse {
  url: string;
  path: string;
  width: number;
  height: number;
  frames: number[];
}

export interface ApiError {
  error: CommandError;
}

// ---------------------------------------------------------------------------
// Still frames (agent visual feedback)
// ---------------------------------------------------------------------------

/** POST /api/stills (body: StillRequest) → StillResponse. Renders one frame to PNG. */
export interface StillRequest {
  project: Project;
  proposalId?: string;
  /** Global frame, 0..duration-1. */
  frame: number;
  /** Output scale, 0.1..1 (default 0.5 → 960×540 for a 1080p project). */
  scale?: number;
}

export interface StillResponse {
  identity: FrameIdentity;
  frame: number;
  width: number;
  height: number;
  /** e.g. '/renders/stills/s_abc.png' */
  url: string;
  /** Absolute filesystem path. */
  path: string;
}

// ---------------------------------------------------------------------------
// Agent bridge: lets a coding agent (via the MCP server in mcp/) work inside
// the open editor. The editor stays the authority over the document: the
// server only relays commands to it and keeps the latest context it reported.
//
//   GET  /api/editor/events        → text/event-stream; events: `hello` {clientId}, `command` BridgeEnvelope,
//                                    `activity` AgentActivity (what the agent is doing, for the editor's status)
//   POST /api/editor/state         (body: EditorStateReport) → { ok: true }
//   GET  /api/editor/state         → EditorStateResponse
//   POST /api/editor/commands      (body: BridgeCommand) → BridgeReply (waits for the editor; 409 none open, 504 timeout)
//   POST /api/editor/replies/:id   (body: BridgeReply) → { ok: true }
//
// Only the most recently connected editor tab receives commands.
// ---------------------------------------------------------------------------

/** What the editor is showing right now. */
export interface EditorContext {
  docSession: string;
  projectId: string;
  projectName: string;
  revision: number;
  /** Unsaved changes relative to the last open/save. */
  dirty: boolean;
  /** Nothing has been made in the project yet (no element, asset, clip or marker): agents may fill or overwrite it without asking. */
  untouched: boolean;
  /** `new`: a blank project not yet on the server. */
  origin: 'new' | 'sample' | 'server' | 'file' | 'recovered';
  /** elementId is the primary selection; elementIds lists every selected element (primary included). */
  selection: { sceneId: string | null; elementId: string | null; elementIds?: string[] };
  /** Global frame. */
  playhead: number;
  playing: boolean;
  editMode: 'layout' | 'animate';
  requests: EditRequest[];
  /**
   * Auto-apply (chat panel switch, off by default): agent edits apply at once.
   * Off: every agent edit becomes a proposal the user reviews, then Applies or Cancels.
   */
  autoApply: boolean;
  /** The pending proposal (at most one per project), or null. */
  proposal: ProposalSummary | null;
  /** Recently decided proposals, newest first (at most 10): how the user answered agents. */
  proposalLog: ProposalSummary[];
  /** The latest outline from editor_propose_outline and the user's answer (absent until one is proposed). */
  outline?: OutlineSummary | null;
}

// ---------------------------------------------------------------------------
// Outlines: brief → outline → scenes. The agent proposes an outline
// (editor_propose_outline → bridge command `proposeOutline`); the user edits
// it (rename, reorder, retime, delete, add, notes) and approves or declines in
// the editor. Approval creates a new project with one empty scene per outline
// item and asks the agent to build it scene by scene. The outline lives in the
// editor, never in a document; agents read the decision from
// EditorContext.outline.
// ---------------------------------------------------------------------------

export interface OutlineSceneDraft {
  name: string;
  /** What the scene must achieve in the story. */
  purpose: string;
  durationSeconds: number;
  onScreenText?: string;
  visuals?: string;
  /** Template ids that fit (titleCard, lowerThird, …). */
  templateHints?: string[];
}

/** What the agent proposes. */
export interface OutlineDraft {
  title: string;
  scenes: OutlineSceneDraft[];
  /** Story beats written before any motion; stamped onto project.story on approval. */
  story?: ProjectStory;
}

export interface OutlineScene extends OutlineSceneDraft {
  /** Stable within one outline (survives reordering in the review). */
  id: string;
  /** The user's notes for the agent. */
  notes?: string;
}

export type OutlineStatus = 'pending' | 'approved' | 'declined';

export interface OutlineSummary {
  status: OutlineStatus;
  title: string;
  /** As the user left them (edited, reordered). */
  scenes: OutlineScene[];
  story?: ProjectStory;
  /** Who proposed it. */
  agent?: string;
  targetSeconds?: number;
  /** approved: the project the editor created for it. */
  projectId?: string;
}

// ---------------------------------------------------------------------------
// Proposals: an agent edit (or pasted patch) the user reviews before it lands.
// The candidate document lives outside the document/history store; Apply
// revalidates against the latest document and commits ONE revision; Cancel
// changes nothing. Applying, cancelling and going stale are reported back to
// the agent through EditorContext.proposalLog (editor_get_context,
// editor_proposal_status, and the next chat turn's prompt).
// ---------------------------------------------------------------------------

export type ProposalSource = 'chat' | 'mcp' | 'paste';

export type ProposalStatus =
  /** Waiting for the user. */
  | 'pending'
  /** The user applied it; `revision` is the revision it became. */
  | 'applied'
  /** The user declined it. */
  | 'cancelled'
  /** Its targets changed after it was proposed (by the user or another edit); it can no longer apply. */
  | 'stale'
  /** A newer proposal took its place before the user decided. */
  | 'replaced';

export interface ProposalSummary {
  id: string;
  projectId: string;
  /** Who proposed it: an agent label ("Codex") or "You" for a pasted patch. */
  agent: string;
  /** Model id the agent ran on, when known. */
  model?: string;
  source: ProposalSource;
  summary: string;
  /** Project revision the patch was written against. */
  baseRevision: number;
  status: ProposalStatus;
  /** applied: the new revision. */
  revision?: number;
  /** stale / replaced: why, in plain words. */
  reason?: string;
  /** Epoch ms. */
  createdAt: number;
  decidedAt?: number;
}

export interface EditorStateReport {
  clientId: string;
  context: EditorContext;
  /** Included whenever the document changed since the previous report. */
  project?: Project;
}

export interface EditorStateResponse {
  connected: boolean;
  context: EditorContext | null;
  project: Project | null;
  /** ISO time of the last report. */
  updatedAt: string | null;
}

// ---------------------------------------------------------------------------
// Editor session (SECURITY.md). The server makes a secret at launch and prints
// a one-time editor link (`/?session=<token>`). The editor exchanges the token
// for an HttpOnly cookie; only a request carrying that cookie counts as the
// user. Routes that need it answer 401 without it.
// ---------------------------------------------------------------------------

/** Query parameter of the one-time editor link. */
export const EDITOR_LINK_PARAM = 'session';

/** POST /api/session body: the token from the editor link. */
export interface ClaimSessionRequest {
  token: string;
}

/** GET /api/session. */
export interface EditorSessionResponse {
  /** True when this request carries the editor's session cookie and this tab's secret. */
  editor: boolean;
  /**
   * When an agent's MCP server started this server, the link is not printed in
   * a terminal: it is saved in this file (mode 0600, in the config directory).
   * Absent when the link was printed to the terminal.
   */
  linkFile?: string;
}

/**
 * POST /api/session on success. The cookie alone is not enough: a cookie for
 * `localhost` reaches every port and every tab, including one an agent opens.
 * `tabSecret` stays in this tab's sessionStorage and goes with every request
 * as the EDITOR_TAB_HEADER header (the event stream, which cannot send
 * headers, carries it as the EDITOR_TAB_PARAM query parameter).
 */
export interface ClaimSessionResponse extends EditorSessionResponse {
  tabSecret: string;
}

/** Request header carrying the tab secret. */
export const EDITOR_TAB_HEADER = 'X-MGE-Tab';
/** Query parameter carrying the tab secret on GET /api/editor/events. */
export const EDITOR_TAB_PARAM = 'tab';

/**
 * POST /api/session/link (editor only): a fresh one-time link for another
 * browser, valid for 5 minutes. Claiming it takes two steps, so a program that
 * copies the link off the clipboard can't use it unnoticed:
 *   1. POST /api/session { token } answers 202 PendingClaimResponse: a random
 *      `pending` id (keep it secret) and a short `code`. The claiming tab shows
 *      the code; the unlocked tab shows a permission card naming the same code.
 *   2. The claiming tab polls POST /api/session/pending { pending }: 202 while
 *      the card is open, 200 ClaimSessionResponse (and the cookie) once the
 *      user allows it, 403 when denied, timed out or unknown.
 * The launch token printed at start needs no approval (200 at once).
 */
export interface PendingClaimResponse {
  pending: string;
  /** Shown in both places; the user allows only when they match. */
  code: string;
}

/** POST /api/session/pending body. */
export interface PendingClaimRequest {
  pending: string;
}

export interface EditorLinkResponse {
  url: string;
}

export type BridgeCommand =
  /**
   * `agent` names who made the change (toasts, Activity, proposal credit); default "Claude Code".
   * `mode`: 'auto' (default) follows the editor's Auto-apply switch — apply now when it is on,
   * otherwise propose; 'propose' always creates a proposal and never commits.
   * `docSession`: the document session the agent read; the editor rejects the patch (STALE) if
   * it has opened another document since, even the same project at the same revision.
   */
  | { type: 'applyPatch'; patch: AiPatch; reconcile?: boolean; agent?: string; model?: string; mode?: 'auto' | 'propose'; docSession?: string }
  /** Open a project saved on the server. Refused when the editor has unsaved changes unless `discardUnsaved`. */
  | { type: 'openProject'; projectId: string; discardUnsaved?: boolean; agent?: string }
  /** Move the playhead and/or select a scene or element so the user sees what the agent means. */
  | { type: 'focus'; frame?: number; sceneId?: string; elementId?: string | null }
  | { type: 'askPermission'; requestId: string; agent: string; action: string; detail?: string; timeoutMs?: number; generation?: GenerationAsk }
  | { type: 'save' }
  /** Show an outline for the user to review; replaces a pending one. The reply only says it is awaiting review. */
  | { type: 'proposeOutline'; outline: OutlineDraft; agent?: string; model?: string };

/** Sent to the editor when an agent reads context, renders frames or sends a command. */
export interface AgentActivity {
  kind: 'reading' | 'rendering' | 'editing';
  /** Short human text, e.g. "rendering frame 120". */
  detail: string;
}

export interface BridgeEnvelope {
  id: string;
  command: BridgeCommand;
}

export type BridgeErrorCode =
  | CommandErrorCode
  | 'EDITOR_NOT_CONNECTED'
  | 'EDITOR_BUSY'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'UNSAVED_CHANGES'
  | 'SAVE_FAILED'
  /** Another agent's proposal is waiting for the user; wait for it to be decided. */
  | 'PROPOSAL_PENDING';

export interface BridgeError {
  code: BridgeErrorCode;
  message: string;
  path?: string;
  hint?: string;
}

export type BridgeReply =
  | {
      ok: true;
      /** Document revision after the command. */
      revision: number;
      projectId: string;
      /** applyPatch: field-level changes it made (applied) or would make (proposed). */
      changes?: ChangeEntry[];
      message?: string;
      /** applyPatch: true when the edit was committed now (Auto-apply on). */
      applied?: boolean;
      /** applyPatch: the proposal created instead of committing (status 'pending'). */
      proposal?: ProposalSummary;
      /** applyPatch: the older pending proposal this one replaced, if any. */
      replaced?: ProposalSummary;
    }
  | {
      ok: true;
      message: 'allowed' | 'denied' | 'timeout';
      /** Additional explanation, e.g. a second request is already waiting. */
      reason?: string;
      revision?: never; projectId?: never; changes?: never; applied?: never; proposal?: never; replaced?: never;
    }
  | { ok: false; error: BridgeError };

export type { ProjectFile };

// ---------------------------------------------------------------------------
// Editor chat: talk to the user's own coding agent (Claude Code, Codex,
// Cursor Agent or OpenCode, on their own subscription) from inside the editor. The local
// server runs the agent; updates stream to the editor as `chat` events on the
// editor event stream.
//
//   GET  /api/chat/providers           → ProviderInfo[] (?refresh=1 re-checks every agent now)
//   GET  /api/chat/:projectId          → ChatState
//   POST /api/chat/:projectId/messages (body: SendChatRequest) → ChatMessage (the user message; the reply streams)
//   POST /api/chat/:projectId/cancel   → { ok: true }
//   POST /api/chat/:projectId/reset    → ChatState (a fresh conversation)
//   POST /api/chat/:projectId/settings (body: ChatSettings) → ChatState (pick the agent and model)
//
// Each agent keeps its own session. Switching agents mid-conversation starts
// that agent's session with a short transcript of the conversation so far.
// ---------------------------------------------------------------------------

export type AgentProviderId = 'claude' | 'codex' | 'cursor' | 'opencode';

export interface ModelOption {
  /** Passed to the agent CLI's model flag; '' means the agent's own default. */
  id: string;
  label: string;
}

/**
 * Whether an agent can answer in the chat:
 * - ready: installed, signed in and limited to the editor's tools;
 * - not-installed: its CLI was not found;
 * - signed-out: installed, but the user has to sign in (see `signIn`);
 * - unsupported: installed, but the editor cannot limit it to its own tools, so it never runs;
 * - error: the CLI is there but did not answer its status check.
 */
export type ProviderState = 'ready' | 'not-installed' | 'signed-out' | 'unsupported' | 'error';

export interface ProviderInfo {
  id: AgentProviderId;
  label: string;
  /** state === 'ready' (kept for older clients). */
  available: boolean;
  /** Absent from servers older than the connect panel; derive it from available/detail then. */
  state?: ProviderState;
  /** Version when available, otherwise why not and how to fix it. */
  detail: string;
  /** How the user signs in, in their own terminal (the editor never handles credentials). */
  signIn?: { command: string; docsUrl?: string };
  /** Models the user can pick; the first is the default. */
  models: ModelOption[];
}

/** A file the user attached, already uploaded with POST /api/assets. */
export type ChatAttachment = UploadAssetResponse;

/** What the user was pointing at when they sent the message. */
export interface ChatContext {
  sceneId: string;
  elementId?: string;
  frame: number;
  /** Human label, e.g. "Tagline · Together". */
  label: string;
}

export type ChatPart =
  | { type: 'text'; text: string }
  | {
      type: 'tool';
      name: string;
      label: string;
      /** Claude Code's Skill tool: the skill this call invoked (from the call's input). */
      skill?: string;
      /** An MCP tool: the server it belongs to, as named in the session's reported MCP servers. */
      mcpServer?: string;
      /** Native MCP tool name, when the harness reports server and tool separately. */
      mcpTool?: string;
    };

/**
 * Session metadata from the selected agent's native protocol, kept on the
 * reply: names and statuses only, never paths or tool inputs. Missing fields
 * stay absent ("not reported"). Configured permission modes are distinguished
 * from effective modes the agent itself reported.
 */
export interface ChatSessionInfo {
  /** The CLI's session id: replies in the same session share it. */
  sessionId?: string;
  /** The model the CLI said it runs. */
  model?: string;
  /** Native permission mode, e.g. Claude "auto", "codex-manual", or "cursor-auto-review". */
  permissionMode?: string;
  /** Whether the harness reported the effective mode or the adapter only configured it. */
  permissionSource?: 'reported' | 'configured';
  /** False when this harness cannot report actual skill invocations. */
  skillUsageReported?: boolean;
  /** Reported tool names outside the MCP catalog. Empty may mean no tool-name inventory was reported. */
  tools: string[];
  /** Reported MCP servers: connection status, and how many of the reported tools are theirs. */
  mcpServers?: { name: string; status: string; tools?: number }[];
  /** Skills the CLI listed as available. Available is not used: invoked skills are tool parts with `skill`. */
  skills?: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  /** Epoch ms. */
  at: number;
  status: 'queued' | 'running' | 'done' | 'error' | 'cancelled';
  /** User messages. */
  text?: string;
  attachments?: ChatAttachment[];
  context?: ChatContext;
  /**
   * User messages: Auto-apply as it was when the message was sent, kept so a
   * queued message runs with it. Supported agents use their native automatic
   * approval mode when true. Absent (older messages) = off.
   */
  autoApply?: boolean;
  /** Assistant messages: text and tool steps in order. */
  parts?: ChatPart[];
  error?: string;
  /** Assistant messages: which agent and model answered. */
  provider?: AgentProviderId;
  model?: string;
  /** Assistant messages: native session metadata and the provenance of its permission mode. */
  session?: ChatSessionInfo;
}

export interface ChatSettings {
  provider: AgentProviderId;
  /** '' = the agent's default model. */
  model: string;
}

export interface ChatState {
  projectId: string;
  provider: AgentProviderId;
  model: string;
  busy: boolean;
  messages: ChatMessage[];
}

export interface SendChatRequest {
  text: string;
  attachments?: ChatAttachment[];
  context?: ChatContext;
  /** Auto-apply is on (Claude Code: run this message's turn in auto permission mode). Absent = off. */
  autoApply?: boolean;
}

/** `chat` event payload: one message was added or changed. */
export interface ChatEvent {
  projectId: string;
  busy: boolean;
  message: ChatMessage;
}

/** GET/PUT /api/projects/:id/proposal; DELETE clears the pending proposal. */
export interface SavedProposal {
  proposal: import('./proposal').Proposal;
  savedAt: string;
}

/** Permission waits are shared by the relay and the editor countdown. */
export function permissionTimeoutMs(timeoutMs?: number): number {
  return typeof timeoutMs === 'number' && Number.isFinite(timeoutMs)
    ? Math.max(1, Math.min(300000, timeoutMs)) : 120000;
}

/** A saved brand kit (`brand-kits/<id>.json`): a site's scanned style, logo and copy, reusable across projects. */
export interface BrandKitRecord {
  /** `kit_<domain>`: one kit per site, rescanning replaces it. */
  id: string;
  name: string;
  domain: string;
  url: string;
  style: StylePack;
  /** Public-relative logo file when the scan saved one. */
  logoPath?: string;
  copy?: SiteCopy;
  savedAt: string;
}

export interface SaveBrandKitRequest {
  url: string;
  refresh?: boolean;
}
