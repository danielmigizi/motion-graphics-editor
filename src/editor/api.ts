import type { Proposal } from '../core/proposal';
import type { SavedProposal } from '../core/api-contract';
// Client for the local server (src/core/api-contract.ts). Every call
// distinguishes "server not running" from a real API error so the UI can show
// the offline state without blocking editing.

import { EDITOR_TAB_HEADER } from '../core/api-contract';
import type {
  ApiError,
  ClaimSessionRequest,
  ClaimSessionResponse,
  EditorLinkResponse,
  EditorSessionResponse,
  PendingClaimRequest,
  PendingClaimResponse,
  Checkpoint,
  CheckpointSummary,
  JournalEntry,
  JournalSummary,
  SaveCheckpointRequest,
  ExportStillRequest,
  ExportStillResponse,
  AssetCheckResponse,
  BrandKitRecord,
  ChatMessage,
  ChatSettings,
  ChatState,
  ProviderInfo,
  SendChatRequest,
  ProjectSummary,
  RenderJob,
  SaveProjectResponse,
  SaveBrandKitRequest,
  StartRenderRequest,
  UploadAssetResponse,
} from '../core/api-contract';
import type { FalKeyStatus, GenerateRequest, GenerationJob, GenerationModelsResponse, GenerationQuote, GenerationScoreboard, GenerationSettings, GenerationStatus, JobKind, OutcomeReport } from '../core/generationStudio';
import type { ProjectFile } from '../core/types';

export const SERVER_DOWN_MESSAGE = 'Local server not running — start it with npm run dev';

/** What a 401 means to the person: this tab has not opened the editor link (session.ts). */
export const LOCKED_MESSAGE = 'Unlock this tab with the editor link first.';

export class ServerDownError extends Error {
  constructor() {
    super(SERVER_DOWN_MESSAGE);
    this.name = 'ServerDownError';
  }
}

export class ApiRequestError extends Error {
  hint?: string;
  path?: string;
  /** HTTP status of the response. */
  status?: number;
  constructor(message: string, hint?: string, path?: string, status?: number) {
    super(message);
    this.name = 'ApiRequestError';
    this.hint = hint;
    this.path = path;
    this.status = status;
  }
}

type Listener = (up: boolean) => void;
const listeners = new Set<Listener>();
export function onServerStatus(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function report(up: boolean) {
  for (const fn of listeners) fn(up);
}

/** Told of every 401, with when its request was sent. session.ts registers here (so api.ts never imports it). */
type UnauthorizedListener = (sentAt: number) => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();
export function onUnauthorized(fn: UnauthorizedListener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

/** Where this tab's secret comes from. session.ts provides it (so api.ts never imports it). */
let tabSecretSource: () => string | null = () => null;
export function provideTabSecret(fn: () => string | null) {
  tabSecretSource = fn;
}

/**
 * `init` with this tab's secret added as the EDITOR_TAB_HEADER header, when
 * the tab has one; its other headers stay. Every request to the local server
 * goes through here (the event stream carries the secret in its URL instead).
 */
export function withTab<I extends RequestInit>(init?: I): I {
  const base = init ?? ({} as I);
  const secret = tabSecretSource();
  if (!secret) return base;
  const h = base.headers;
  const headers: Record<string, string> = h instanceof Headers || Array.isArray(h) ? Object.fromEntries(new Headers(h)) : { ...h };
  headers[EDITOR_TAB_HEADER] = secret;
  return { ...base, headers };
}

async function request<T>(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  return (await send(path, init)).body as T;
}

/** request, with the status of a successful answer (a pending claim answers 202). */
async function send(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init?.timeoutMs ?? 15000);
  const sentAt = Date.now();
  let res: Response;
  try {
    res = await fetch(path, { ...withTab(init), signal: ctrl.signal });
  } catch {
    report(false);
    throw new ServerDownError();
  } finally {
    clearTimeout(timer);
  }
  const isJson = (res.headers.get('content-type') ?? '').includes('application/json');
  // The Vite proxy answers 5xx with a non-JSON body when nothing listens on the server port.
  if (!isJson && res.status >= 500) {
    report(false);
    throw new ServerDownError();
  }
  report(true);
  const body = isJson ? await res.json() : await res.text();
  if (!res.ok) {
    if (res.status === 401) for (const fn of unauthorizedListeners) fn(sentAt);
    const err = (body as ApiError)?.error;
    if (err?.message) throw new ApiRequestError(err.message, err.hint, err.path, res.status);
    throw new ApiRequestError(`Server answered ${res.status} for ${path}`, undefined, undefined, res.status);
  }
  return { status: res.status, body };
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

export const api = {
  // The editor session (session.ts): only a browser that opened the editor link counts as the user.
  /** The launch link unlocks at once (`claimed`). A minted link answers 202 (`waiting`): an unlocked tab must allow it first (pendingClaim). */
  claimSession: async (token: string) => {
    const { status, body } = await send('/api/session', json('POST', { token } satisfies ClaimSessionRequest));
    return status === 202 ? { waiting: body as PendingClaimResponse } : { claimed: body as ClaimSessionResponse };
  },
  /** A waiting claim's answer: null while the unlocked tab's card is open (202), the unlock once allowed; 403 when denied, timed out or unknown. */
  pendingClaim: async (pending: string) => {
    const { status, body } = await send('/api/session/pending', json('POST', { pending } satisfies PendingClaimRequest));
    return status === 202 ? null : (body as ClaimSessionResponse);
  },
  session: () => request<EditorSessionResponse>('/api/session', { timeoutMs: 4000 }),
  /** A fresh one-time editor link for another browser, valid for 5 minutes (unlocked tabs only); claiming it needs an unlocked tab to allow it. */
  editorLink: () => request<EditorLinkResponse>('/api/session/link', { method: 'POST' }),
  getProposal: (id: string) => request<SavedProposal>(`/api/projects/${encodeURIComponent(id)}/proposal`),
  saveProposal: (proposal: Proposal) => request<SaveProjectResponse>(`/api/projects/${encodeURIComponent(proposal.projectId)}/proposal`, json('PUT', { proposal })),
  deleteProposal: (id: string) => request<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/proposal`, { method: 'DELETE' }),
  listProjects: () => request<ProjectSummary[]>('/api/projects', { timeoutMs: 4000 }),
  getProject: (id: string) => request<ProjectFile>(`/api/projects/${encodeURIComponent(id)}`),
  /** `autosave`: to the recovery journal, not the file. `byAgent`: an agent asked for this save (the bridge's `save`), so the server files it as the agent's. */
  saveProject: (file: ProjectFile, opts: { autosave?: boolean; byAgent?: boolean } = {}) => {
    const q = [opts.autosave && 'autosave=1', opts.byAgent && 'by=agent'].filter(Boolean).join('&');
    return request<SaveProjectResponse>(`/api/projects/${encodeURIComponent(file.project.id)}${q ? `?${q}` : ''}`, json('PUT', file));
  },
  listCheckpoints: (id: string) => request<CheckpointSummary[]>(`/api/projects/${encodeURIComponent(id)}/checkpoints`),
  saveCheckpoint: (id: string, body: SaveCheckpointRequest) => request<CheckpointSummary>(`/api/projects/${encodeURIComponent(id)}/checkpoints`, json('POST', body)),
  getCheckpoint: (id: string, cp: string) => request<Checkpoint>(`/api/projects/${encodeURIComponent(id)}/checkpoints/${encodeURIComponent(cp)}`),
  deleteCheckpoint: (id: string, cp: string) => request<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}/checkpoints/${encodeURIComponent(cp)}`, { method: 'DELETE' }),
  listJournal: (id: string) => request<JournalSummary[]>(`/api/projects/${encodeURIComponent(id)}/journal`),
  getJournalEntry: (id: string, entry: string) => request<JournalEntry>(`/api/projects/${encodeURIComponent(id)}/journal/${encodeURIComponent(entry)}`),
  exportStill: (body: ExportStillRequest) => request<ExportStillResponse>('/api/renders/still', { ...json('POST', body), timeoutMs: 120000 }),
  uploadAsset: (file: File) =>
    request<UploadAssetResponse>(`/api/assets?filename=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
      // Videos (up to 500 MB) stream to disk and are probed: allow for the size.
      timeoutMs: file.size > 50 * 1024 * 1024 ? 600000 : 60000,
    }),
  checkAsset: (src: string) => request<AssetCheckResponse>(`/api/assets/check?src=${encodeURIComponent(src)}`, { timeoutMs: 4000 }),
  startRender: (body: StartRenderRequest) => request<RenderJob>('/api/renders', json('POST', body)),
  getRender: (id: string) => request<RenderJob>(`/api/renders/${encodeURIComponent(id)}`, { timeoutMs: 4000 }),
  cancelRender: (id: string) => request<RenderJob>(`/api/renders/${encodeURIComponent(id)}/cancel`, { method: 'POST', timeoutMs: 120000 }),
  retryRender: (id: string) => request<RenderJob>(`/api/renders/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
  listBrandKits: () => request<BrandKitRecord[]>('/api/brand-kits', { timeoutMs: 4000 }),
  // A scan fetches the page and its stylesheets: allow it time.
  saveBrandKit: (body: SaveBrandKitRequest) => request<BrandKitRecord>('/api/brand-kits', { ...json('POST', body), timeoutMs: 60000 }),
  chatProviders: () => request<ProviderInfo[]>('/api/chat/providers', { timeoutMs: 15000 }),
  getChat: (projectId: string) => request<ChatState>(`/api/chat/${encodeURIComponent(projectId)}`),
  sendChat: (projectId: string, body: SendChatRequest) => request<ChatMessage>(`/api/chat/${encodeURIComponent(projectId)}/messages`, json('POST', body)),
  cancelChat: (projectId: string) => request<{ ok: true }>(`/api/chat/${encodeURIComponent(projectId)}/cancel`, { method: 'POST' }),
  resetChat: (projectId: string) => request<ChatState>(`/api/chat/${encodeURIComponent(projectId)}/reset`, { method: 'POST' }),
  setChatSettings: (projectId: string, body: ChatSettings) => request<ChatState>(`/api/chat/${encodeURIComponent(projectId)}/settings`, json('POST', body)),
  // Generation studio (src/core/generationStudio.ts). The key goes in once and never comes back: only its masked status.
  generationStatus: () => request<GenerationStatus>('/api/generation/status', { timeoutMs: 4000 }),
  saveGenerationSettings: (patch: Partial<GenerationSettings>) => request<GenerationSettings>('/api/generation/settings', json('PUT', patch)),
  saveFalKey: (key: string) => request<FalKeyStatus>('/api/generation/key', { ...json('PUT', { key }), timeoutMs: 30000 }),
  testFalKey: () => request<FalKeyStatus>('/api/generation/key/test', { method: 'POST', timeoutMs: 30000 }),
  removeFalKey: () => request<FalKeyStatus>('/api/generation/key', { method: 'DELETE' }),
  generationModels: () => request<GenerationModelsResponse>('/api/generation/models'),
  estimateGeneration: (req: GenerateRequest) => request<GenerationQuote>('/api/generation/estimate', json('POST', req)),
  /** `confirmed`: the person confirmed a request over the confirmation threshold. */
  startGeneration: (req: GenerateRequest, confirmed = false) => request<{ job: GenerationJob }>('/api/generation/jobs', { ...json('POST', { ...req, confirmed }), timeoutMs: 330000 }),
  listGenerationJobs: (projectId: string) => request<GenerationJob[]>(`/api/generation/jobs?projectId=${encodeURIComponent(projectId)}`),
  cancelGeneration: (id: string) => request<GenerationJob>(`/api/generation/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  generationDelivered: (id: string) => request<GenerationJob>(`/api/generation/jobs/${encodeURIComponent(id)}/delivered`, { method: 'POST' }),
  reportOutcome: (report: OutcomeReport) => request<{ ok: true }>('/api/generation/outcomes', json('POST', report)),
  generationThumbs: (jobIds: string[]) => request<Record<string, 1 | -1>>(`/api/generation/thumbs?jobIds=${jobIds.map(encodeURIComponent).join(',')}`),
  /** How each model has done for each job, from your own runs, and the route changes that evidence suggests. */
  generationScoreboard: () => request<GenerationScoreboard>('/api/generation/scoreboard'),
  /** Make `model` the job's default (accept a suggestion), or null to go back to the route's own default. */
  setRouteOverride: (job: JobKind, model: string | null) => request<GenerationScoreboard>('/api/generation/route-overrides', json('POST', { job, model })),
  /** Dismiss the suggestion to use `model` for `job`: it is no longer shown, and Balanced no longer follows it. */
  dismissSuggestion: (job: JobKind, model: string) => request<GenerationScoreboard>('/api/generation/suggestions/dismiss', json('POST', { job, model })),
};

export function errorText(e: unknown): { message: string; hint?: string } {
  // Every route that needs the user answers a locked tab with 401: one reason for all of them.
  if (e instanceof ApiRequestError && e.status === 401) return { message: LOCKED_MESSAGE };
  if (e instanceof ApiRequestError) return { message: e.message, hint: e.hint };
  if (e instanceof Error) return { message: e.message };
  return { message: String(e) };
}
