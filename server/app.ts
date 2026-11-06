// Express app implementing src/core/api-contract.ts. Kept separate from
// index.ts (which only listens) so tests can construct it with fakes.

import { validateProposal } from '../src/core/savedProposal';
import express, { type NextFunction, type Request, type Response } from 'express';
import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
  DEFAULT_SERVER_PORT,
  EDITOR_LINK_PARAM,
  type ClaimSessionRequest,
  type ClaimSessionResponse,
  type PendingClaimRequest,
  type PendingClaimResponse,
  permissionTimeoutMs,
  type EditorSessionResponse,
  type EditorLinkResponse,
  type ApiError,
  type ContactSheetRequest,
  type ContactSheetResponse,
  type AssetCheckResponse,
  type BridgeCommand,
  type BridgeReply,
  type EditorStateReport,
  type ProviderInfo,
  type SendChatRequest,
  type SaveProjectResponse,
  type StartRenderRequest,
  type StillRequest,
  type ExportStillRequest,
  type ExportStillResponse,
  type StillResponse,
  type OpenverseSearchResponse,
  type OpenverseImportResponse,
  type OpenverseStatusResponse,
} from '../src/core/api-contract';
import { deliverySettings } from '../src/core/delivery';
import { projectDurationInFrames } from '../src/core/timing';
import type { CommandError, Project } from '../src/core/types';
import { parseProjectFile, validateProject } from '../src/core/validate';
import { AssetError, assetExists, probeAsset, resolvePublicPath, sniffAssetKind, storeUpload } from './assets';
import { beatsFor, BeatsError } from './beats';
import { ProxyQueue, storeVideoUpload, videoExportProblem, VideoUploadError } from './video';
import { EditorBridge } from './bridge';
import { openAgentFile, PrivateFileError } from './local-file';
import { newId } from '../src/core/ids';
import { EditorSession, isUser as sessionUser, USER_REQUIRED } from './session';
import type { ChatManager } from './chat';
import { isValidProjectId, type ProjectStore } from './projects';
import { RenderConflictError, type RenderManager } from './renders';
import { compositionHash, projectHash, rendererVersion } from './manifest';
import { contactSheetLayout } from '../src/composition/contact-sheet-layout';
import type { ImportUrlRequest } from '../src/core/generation';
import type { GenerationLog } from './generation-log';
import { ImportUrlError, importFromUrl, type ImportOptions } from './url-import';
import { BrandScanError, scanBrand } from './brand-scan';
import { createBrandKitStore, type BrandKitStore } from './brand-kits';
import { ReferenceAnalyzeError, analyzeReference } from './reference-analyze';
import { createOpenverseClient, OpenverseError, type OpenverseClient } from './openverse';
import type { GenerationService } from './generation/jobs';
import { registerGenerationRoutes } from './generation/routes';
import { OPENVERSE_NOTICE } from '../src/core/openverseLicense';

export interface AppDeps {
  publicDir: string;
  /** Per-launch browser sessions; a fresh in-memory session is created when omitted. */
  session?: EditorSession;
  /** Live renderer bundle origins, evaluated on every request. */
  extraOrigins?: () => Iterable<string>;
  rootDir?: string;
  rendersDir: string;
  projects: ProjectStore;
  renders: RenderManager;
  /** Called for POST /api/renders?rebundle=1. */
  invalidateBundle?: () => void;
  /** Editor (Vite) port allowed to write. Default MGE_WEB_PORT ?? 5317. */
  webPort?: number;
  /** This server's own port (its own origin may write). Default MGE_SERVER_PORT ?? 5318. */
  serverPort?: number;
  /** Agent bridge relay. A fresh one is created when omitted. */
  bridge?: EditorBridge;
  /** Renders one frame of `project` to a PNG at `outputPath`. Without it POST /api/stills answers 503. */
  renderStill?: (args: { project: Project; frame: number; scale: number; outputPath: string; signal?: AbortSignal; imageFormat?: 'png' | 'jpeg'; jpegQuality?: number; onCompositionHash?: (hash: string) => Promise<void> | void }) => Promise<void>;
  renderContactSheet?: (args: { project: Project; frames: number[]; columns: number; scale?: number; labels?: boolean; outputPath: string; signal?: AbortSignal }) => Promise<void>;
  /** Editor chat with the user's coding agent. Without it /api/chat answers 503. */
  chat?: ChatManager;
  /** GET /api/chat/providers. `refresh` (from ?refresh=1): re-check every agent instead of using cached status (ProviderRegistry.invalidateAll). */
  chatProviders?: (opts?: { refresh?: boolean }) => Promise<ProviderInfo[]>;
  /** Today's generation activity. Without it the log route answers 503 and imports are not logged. */
  generations?: GenerationLog;
  /** The local fal generation studio. */
  generation?: GenerationService;
  /** DNS and connections for POST /api/assets/import-url (tests pass fakes; default: system DNS, pinned https). */
  urlImport?: Pick<ImportOptions, 'lookup' | 'connect'>;
  /** Openverse catalog (tests inject a fake; default talks to api.openverse.org). */
  openverse?: OpenverseClient;
  /** Saved brand kits. Default: <rootDir>/brand-kits (or next to publicDir). */
  brandKits?: BrandKitStore;
  /** Background video preview proxies. A fresh queue is created when omitted. */
  proxies?: ProxyQueue;
}

const BRIDGE_COMMANDS = new Set<BridgeCommand['type']>(['applyPatch', 'openProject', 'focus', 'save', 'askPermission', 'proposeOutline']);
const KEEP_STILLS = 40;

async function pruneStills(dir: string) {
  const names = (await readdir(dir)).filter((n) => /\.(png|jpe?g)$/.test(n));
  if (names.length <= KEEP_STILLS) return;
  const dated = await Promise.all(names.map(async (n) => ({ n, t: (await stat(join(dir, n))).mtimeMs })));
  dated.sort((a, b) => a.t - b.t);
  await Promise.all(dated.slice(0, dated.length - KEEP_STILLS).map((d) => unlink(join(dir, d.n)).catch(() => undefined)));
}

let stillSeq = 0;

const fail = (res: Response, status: number, error: CommandError) => res.status(status).json({ error } satisfies ApiError);

/** Origins allowed to use write methods: the local editor and this server itself, on loopback only. */
export function allowedWriteOrigins(webPort: number, serverPort: number): Set<string> {
  const origins = new Set<string>();
  for (const port of [webPort, serverPort]) {
    origins.add(`http://localhost:${port}`);
    origins.add(`http://127.0.0.1:${port}`);
  }
  return origins;
}

export function createApp(deps: AppDeps) {
  const app = express();
  app.disable('x-powered-by');

  const webPort = deps.webPort ?? Number(process.env.MGE_WEB_PORT ?? 5317);
  const serverPort = deps.serverPort ?? Number(process.env.MGE_SERVER_PORT ?? DEFAULT_SERVER_PORT);
  const writeOrigins = allowedWriteOrigins(webPort, serverPort);
  const editorOrigins = new Set([`http://localhost:${webPort}`, `http://127.0.0.1:${webPort}`]);
  const session = deps.session ?? new EditorSession({ port: serverPort });
  const isUser = (req: Request) => sessionUser(req, session, editorOrigins);
  const requireUser = (req: Request, res: Response, next: NextFunction) => {
    if (!isUser(req)) return void fail(res, 401, USER_REQUIRED);
    next();
  };
  const isAllowedOrigin = (origin: string) => writeOrigins.has(origin) || new Set(deps.extraOrigins?.()).has(origin);
  const brandKits = deps.brandKits ?? createBrandKitStore(join(deps.rootDir ?? dirname(deps.publicDir), 'brand-kits'));

  // Include errors from the Host/Origin gates and OPTIONS responses as well.
  app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  // Only answer requests addressed to this machine by a loopback name, so a
  // DNS-rebinding page cannot read projects through a hostile hostname.
  app.use((req, res, next) => {
    const host = (req.get('host') ?? '').toLowerCase();
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return next();
    return void fail(res, 403, { code: 'PROTOCOL', message: `Host ${host || '(none)'} is not allowed.`, hint: `Use http://localhost:${serverPort}.` });
  });

  // Only the editor, this server and the renderer's bundle page may call this
  // server from a browser (SECURITY.md). Any other Origin gets 403 on every
  // route, reads included. Requests without an Origin (CLI, MCP, tests, the
  // editor's own same-origin GETs through the Vite proxy) are allowed. Under
  // /api, a browser request from another site or another localhost port
  // (Sec-Fetch-Site other than same-origin/none) also needs an allowed Origin,
  // so a page cannot embed API responses or hold the editor event stream with a
  // <script> tag; static media may still be embedded without one.
  const SAME_ORIGIN_FETCH = new Set(['same-origin', 'none']);
  app.use((req, res, next) => {
    const origin = req.get('origin');
    const originAllowed = origin !== undefined && isAllowedOrigin(origin);
    const fetchSite = req.get('sec-fetch-site');
    res.vary('Origin');
    if ((origin !== undefined && !originAllowed) ||
        (/^\/api(?:\/|$)/i.test(req.path) && fetchSite !== undefined && !SAME_ORIGIN_FETCH.has(fetchSite) && !originAllowed)) {
      return void fail(res, 403, { code: 'PROTOCOL', message: `Origin ${origin ?? '(none)'} may not access this server.`, hint: `Open the editor at http://localhost:${webPort}.` });
    }
    if (origin !== undefined) res.setHeader('Access-Control-Allow-Origin', origin);
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,POST,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-MGE-Tab');
      return void res.sendStatus(204);
    }
    next();
  });

  if (deps.generation) registerGenerationRoutes(app, { generation: deps.generation, isUser, isAllowedOrigin, fail });

  const json = express.json({ limit: '50mb' });
  const bridge = deps.bridge ?? new EditorBridge();
  const proxies = deps.proxies ?? new ProxyQueue(deps.publicDir);
  const openverse = deps.openverse ?? createOpenverseClient();

  const openverseFail = (res: Response, err: unknown): boolean => {
    if (!(err instanceof OpenverseError)) return false;
    const status = err.status === 429 ? 429 : err.status === 404 ? 404 : err.status === 403 ? 403 : 400;
    if (err.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(err.retryAfterSeconds));
    fail(res, status, { code: err.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INVALID', message: err.message, hint: err.code === 'RATE_LIMIT' ? `Wait ${err.retryAfterSeconds ?? 60}s, or set OPENVERSE_CLIENT_ID / OPENVERSE_CLIENT_SECRET for higher limits.` : err.code === 'LICENSE' ? 'Only CC0 and CC BY are allowed; the server ignores any other license filter.' : undefined });
    return true;
  };
  /** Exports, stills and contact sheets refuse a project whose video files are missing or undecodable. */
  const videoRefusal = async (res: Response, project: Project): Promise<boolean> => {
    const problem = await videoExportProblem(project, (src) => resolvePublicPath(deps.publicDir, src));
    if (problem) fail(res, 400, { code: 'INVALID', message: problem, hint: 'Open Assets → Problems to relink or replace the file.' });
    return !!problem;
  };

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, publicDir: deps.publicDir, publicExists: existsSync(deps.publicDir) });
  });

  // ---- projects -----------------------------------------------------------
  app.get('/api/projects', async (_req, res) => {
    res.json(await deps.projects.list());
  });

  app.get('/api/projects/:id', async (req, res) => {
    const { id } = req.params;
    if (!isValidProjectId(id)) return void fail(res, 400, { code: 'INVALID', message: `Invalid project id "${id}". Use letters, digits, "_" or "-".` });
    const file = await deps.projects.load(id);
    if (!file) return void fail(res, 404, { code: 'NOT_FOUND', message: `Project "${id}" does not exist.`, hint: 'Save it first with PUT /api/projects/:id.' });
    res.json(file);
  });

  app.put('/api/projects/:id', json, async (req, res) => {
    const user = isUser(req);
    if (req.query.autosave === '1' && !user) return void fail(res, 401, USER_REQUIRED);
    const { id } = req.params;
    if (!isValidProjectId(id)) return void fail(res, 400, { code: 'INVALID', message: `Invalid project id "${id}". Use letters, digits, "_" or "-".` });
    const parsed = parseProjectFile(req.body);
    if (!parsed.ok) return void fail(res, 400, parsed.error);
    const file = parsed.value;
    if (!file || typeof file !== 'object' || !file.project || typeof file.project !== 'object') {
      return void fail(res, 400, { code: 'INVALID', message: 'Body must be a ProjectFile ({ format, project, revisions, savedAt }).', path: 'project' });
    }
    if (file.project.id !== id) {
      return void fail(res, 400, { code: 'PROJECT_MISMATCH', message: `URL id "${id}" does not match project.id "${file.project.id}".`, path: 'project.id' });
    }
    const savedAt = new Date().toISOString();
    // Only the user may autosave; an autosave of changes an agent applied (Auto-apply) is filed as the agent's.
    const by = !user || req.query.by === 'agent' ? 'agent' : 'user';
    if (req.query.autosave === '1') await deps.projects.autosave(id, { ...file, savedAt }, { by });
    else await deps.projects.save(id, { ...file, savedAt }, { by });
    res.json({ ok: true, savedAt } satisfies SaveProjectResponse);
  });

  // Checkpoints and journal entries share the PUT ProjectFile validation rules.
  app.use(['/api/projects/:id/checkpoints', '/api/projects/:id/journal'], (req, res, next) => {
    if (!isValidProjectId(req.params.id)) return void fail(res, 400, { code: 'INVALID', message: 'Invalid project id.' });
    next();
  });
  app.get('/api/projects/:id/checkpoints', async (req, res) => { res.json(await deps.projects.checkpoints(req.params.id)); });
  app.post('/api/projects/:id/checkpoints', json, async (req, res) => {
    const { name, note, file } = req.body ?? {};
    if (typeof name !== 'string' || !name.trim() || name.length > 80) return void fail(res, 400, { code: 'INVALID', message: 'Checkpoint name must contain 1 to 80 characters.', path: 'name' });
    if (note !== undefined && typeof note !== 'string') return void fail(res, 400, { code: 'INVALID', message: 'Checkpoint note must be text.', path: 'note' });
    const parsed = parseProjectFile(file);
    if (!parsed.ok) return void fail(res, 400, parsed.error);
    if (parsed.value.project.id !== req.params.id) return void fail(res, 400, { code: 'PROJECT_MISMATCH', message: 'Checkpoint project id does not match the URL.', path: 'file.project.id' });
    res.json(await deps.projects.saveCheckpoint(req.params.id, name.trim(), note, parsed.value));
  });
  const validEntry = (entry: string) => isValidProjectId(entry) && entry.length <= 80;
  app.get('/api/projects/:id/checkpoints/:cp', async (req, res) => {
    if (!validEntry(req.params.cp)) return void fail(res, 400, { code: 'INVALID', message: 'Invalid checkpoint id.' });
    const checkpoint = await deps.projects.checkpoint(req.params.id, req.params.cp);
    if (!checkpoint) return void fail(res, 404, { code: 'NOT_FOUND', message: 'Checkpoint not found.' });
    res.json(checkpoint);
  });
  app.delete('/api/projects/:id/checkpoints/:cp', requireUser, async (req, res) => {
    if (!validEntry(String(req.params.cp))) return void fail(res, 400, { code: 'INVALID', message: 'Invalid checkpoint id.' });
    if (!await deps.projects.deleteCheckpoint(String(req.params.id), String(req.params.cp))) return void fail(res, 404, { code: 'NOT_FOUND', message: 'Checkpoint not found.' });
    res.json({ ok: true });
  });
  app.get('/api/projects/:id/journal', async (req, res) => { res.json(await deps.projects.journal(req.params.id)); });
  app.get('/api/projects/:id/journal/:entry', async (req, res) => {
    if (!validEntry(req.params.entry)) return void fail(res, 400, { code: 'INVALID', message: 'Invalid journal entry id.' });
    const entry = await deps.projects.journalEntry(req.params.id, req.params.entry);
    if (!entry) return void fail(res, 404, { code: 'NOT_FOUND', message: 'Journal entry not found.' });
    res.json(entry);
  });

  app.get('/api/projects/:id/proposal', async (req, res) => {
    const { id } = req.params;
    if (!isValidProjectId(id)) return void fail(res, 400, { code: 'INVALID', message: 'Invalid project id.' });
    const saved = await deps.projects.loadProposal(id);
    if (!saved) return void fail(res, 404, { code: 'NOT_FOUND', message: 'No pending proposal for this project.' });
    res.json(saved);
  });

  app.put('/api/projects/:id/proposal', requireUser, json, async (req, res) => {
    const { id } = req.params;
    if (!isValidProjectId(id)) return void fail(res, 400, { code: 'INVALID', message: 'Invalid project id.' });
    const valid = validateProposal(req.body?.proposal, id);
    if (!valid.ok) return void fail(res, 400, valid.error);
    if (!(await deps.projects.load(id))) return void fail(res, 404, { code: 'NOT_FOUND', message: 'Save the project before persisting a proposal.' });
    const savedAt = new Date().toISOString();
    await deps.projects.saveProposal(id, { proposal: valid.proposal, savedAt });
    res.json({ ok: true, savedAt } satisfies SaveProjectResponse);
  });

  app.delete('/api/projects/:id/proposal', requireUser, async (req, res) => {
    const { id } = req.params;
    if (!isValidProjectId(id)) return void fail(res, 400, { code: 'INVALID', message: 'Invalid project id.' });
    await deps.projects.deleteProposal(id);
    res.json({ ok: true });
  });

  // ---- assets -------------------------------------------------------------
  app.get('/api/assets/check', async (req, res) => {
    const src = typeof req.query.src === 'string' ? req.query.src : '';
    res.json({ exists: await assetExists(deps.publicDir, src) } satisfies AssetCheckResponse);
  });

  // Existence + decodability (header sniff and intrinsic size) for the Assets panel.
  app.get('/api/assets/probe', async (req, res) => {
    const src = typeof req.query.src === 'string' ? req.query.src : '';
    res.json(await probeAsset(deps.publicDir, src));
  });

  // Tempo, beat grid, downbeats and strong hits of an audio file (server/beats.ts), in source frames at ?fps.
  app.get('/api/assets/beats', async (req, res) => {
    const src = typeof req.query.src === 'string' ? req.query.src : '';
    const fps = Number(req.query.fps ?? 30);
    try {
      res.json(await beatsFor(deps.publicDir, src, fps));
    } catch (err) {
      if (err instanceof BeatsError) return void fail(res, err.status, { code: err.status === 404 ? 'NOT_FOUND' : 'INVALID', message: err.message });
      throw err;
    }
  });

  // Video files stream straight to disk (up to 500 MB); everything else arrives as one buffer (50 MB).
  const rawUpload = express.raw({ type: () => true, limit: '50mb' });
  app.post('/api/assets', async (req, res, next) => {
    const filename = typeof req.query.filename === 'string' ? req.query.filename : undefined;
    const info = sniffAssetKind(req.get('content-type'), filename);
    if (info?.kind !== 'video') return void rawUpload(req, res, next);
    const length = Number(req.get('content-length'));
    try {
      res.json(await storeVideoUpload(deps.publicDir, req, info, filename, { contentLength: Number.isFinite(length) ? length : undefined, proxies }));
    } catch (err) {
      if (err instanceof VideoUploadError) {
        // Tell the client not to keep sending a body the server refused.
        if (err.status === 413) res.setHeader('Connection', 'close');
        return void fail(res, err.status, { code: 'INVALID', message: err.message, ...(err.status === 413 ? { hint: 'Trim or compress the video (H.264 MP4) and upload it again.' } : {}) });
      }
      throw err;
    }
  }, async (req, res) => {
    const filename = typeof req.query.filename === 'string' ? req.query.filename : undefined;
    const body = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      res.json(await storeUpload(deps.publicDir, filename, req.get('content-type'), body));
    } catch (err) {
      if (err instanceof AssetError) return void fail(res, 400, { code: 'INVALID', message: err.message });
      throw err;
    }
  });

  app.post('/api/assets/import-local', json, async (req, res) => {
    const body = (req.body ?? {}) as { path?: unknown; name?: unknown };
    if (typeof body.path !== 'string' || !body.path.trim() || body.path.includes('\0')) return void fail(res, 400, { code: 'INVALID', message: 'Body must be { path, name? } (a local file).' });
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 120)) return void fail(res, 400, { code: 'INVALID', message: 'name must be text (at most 120 characters).' });
    try {
      const { file, info: fileInfo } = await openAgentFile(body.path, deps.rootDir ?? dirname(deps.publicDir));
      try {
        const filename = basename(body.path);
        const info = sniffAssetKind(undefined, filename);
        if (!info) throw new AssetError('Unsupported file type.');
        const uploaded = info.kind === 'video'
          ? await storeVideoUpload(deps.publicDir, file.createReadStream({ autoClose: false }), info, filename, { contentLength: fileInfo.size, proxies })
          : await (async () => {
            if (fileInfo.size > 50 * 1024 * 1024) throw new AssetError('File too large (limit 50 MB).');
            return storeUpload(deps.publicDir, filename, undefined, await file.readFile());
          })();
        res.json({ ...uploaded, ...(typeof body.name === 'string' ? { name: body.name } : {}) });
      } finally { await file.close(); }
    } catch (err) {
      if (err instanceof PrivateFileError) return void fail(res, 403, { code: 'PROTOCOL', message: err.message });
      if (err instanceof AssetError || err instanceof VideoUploadError) return void fail(res, err instanceof VideoUploadError ? err.status : 400, { code: 'INVALID', message: err.message });
      if (['ENOENT', 'ENOTDIR', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) return void fail(res, 400, { code: 'INVALID', message: 'Local file not found or unreadable.' });
      throw err;
    }
  });

  // Openverse: search and import stay on the server so OAuth secrets and the
  // CC0/BY license guardrail cannot be bypassed from a tool caller.
  app.get('/api/openverse/status', (_req, res) => {
    const s = openverse.status();
    res.json({ ...s, notice: s.notice ?? OPENVERSE_NOTICE } satisfies OpenverseStatusResponse);
  });

  app.get('/api/openverse/audio/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q : typeof req.query.query === 'string' ? req.query.query : '';
    const kind = req.query.kind === 'sfx' || req.query.kind === 'music' ? req.query.kind : undefined;
    const mood = typeof req.query.mood === 'string' ? req.query.mood : undefined;
    const durationSeconds = req.query.durationSeconds !== undefined ? Number(req.query.durationSeconds) : undefined;
    const page = req.query.page !== undefined ? Number(req.query.page) : undefined;
    const pageSize = req.query.pageSize !== undefined ? Number(req.query.pageSize) : undefined;
    if (!q.trim()) return void fail(res, 400, { code: 'INVALID', message: 'q must be a non-empty search query.', path: 'q' });
    try {
      const result = await openverse.searchAudio({
        query: q,
        kind,
        mood,
        durationSeconds: durationSeconds !== undefined && Number.isFinite(durationSeconds) ? durationSeconds : undefined,
        page: page !== undefined && Number.isFinite(page) ? page : undefined,
        pageSize: pageSize !== undefined && Number.isFinite(pageSize) ? pageSize : undefined,
      });
      res.json(result satisfies OpenverseSearchResponse);
    } catch (err) {
      if (!openverseFail(res, err)) throw err;
    }
  });

  app.get('/api/openverse/audio/:id', async (req, res) => {
    try {
      const work = await openverse.getAudio(req.params.id);
      res.json({ ...work, notice: OPENVERSE_NOTICE });
    } catch (err) {
      if (!openverseFail(res, err)) throw err;
    }
  });

  app.post('/api/openverse/audio/import', json, async (req, res) => {
    const body = (req.body ?? {}) as { id?: unknown; name?: unknown };
    if (typeof body.id !== 'string' || !body.id.trim()) return void fail(res, 400, { code: 'INVALID', message: 'Body must be { id } (an Openverse work id).', path: 'id' });
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 120)) return void fail(res, 400, { code: 'INVALID', message: 'name must be text (at most 120 characters).', path: 'name' });
    try {
      const imported = await openverse.importAudio(deps.publicDir, body.id.trim(), typeof body.name === 'string' ? body.name : undefined, deps.urlImport);
      res.json(imported satisfies OpenverseImportResponse);
    } catch (err) {
      if (err instanceof ImportUrlError) return void fail(res, 400, { code: 'INVALID', message: err.message, path: 'id' });
      if (!openverseFail(res, err)) throw err;
    }
  });

  // Brand kit from a public https page (HTML+CSS only, cached per domain).
  app.post('/api/brand/scan', json, async (req, res) => {
    const body = (req.body ?? {}) as { url?: unknown; refresh?: unknown };
    if (typeof body.url !== 'string' || !body.url.trim()) return void fail(res, 400, { code: 'INVALID', message: 'Body must be { url } (an https page).', path: 'url' });
    try {
      res.json(await scanBrand(deps.publicDir, body.url.trim(), { ...deps.urlImport, refresh: body.refresh === true }));
    } catch (err) {
      if (err instanceof BrandScanError) return void fail(res, err.status, { code: 'INVALID', message: err.message, path: 'url' });
      if (err instanceof ImportUrlError) return void fail(res, 400, { code: 'INVALID', message: err.message, path: 'url' });
      throw err;
    }
  });

  // Saved brand kits: scan a site (style, logo, copy) once, reuse it in later videos.
  app.get('/api/brand-kits', async (_req, res) => {
    res.json(await brandKits.list());
  });

  app.get('/api/brand-kits/:id', async (req, res) => {
    const kit = await brandKits.get(req.params.id);
    if (!kit) return void fail(res, 404, { code: 'NOT_FOUND', message: `No brand kit ${req.params.id}.` });
    res.json(kit);
  });

  app.post('/api/brand-kits', json, async (req, res) => {
    const body = (req.body ?? {}) as { url?: unknown; refresh?: unknown };
    if (typeof body.url !== 'string' || !body.url.trim()) return void fail(res, 400, { code: 'INVALID', message: 'Body must be { url } (an https page).', path: 'url' });
    try {
      res.json(await brandKits.save(await scanBrand(deps.publicDir, body.url.trim(), { ...deps.urlImport, refresh: body.refresh === true })));
    } catch (err) {
      if (err instanceof BrandScanError) return void fail(res, err.status, { code: 'INVALID', message: err.message, path: 'url' });
      if (err instanceof ImportUrlError) return void fail(res, 400, { code: 'INVALID', message: err.message, path: 'url' });
      throw err;
    }
  });

  // Reference-video analysis (local file or https URL). ffmpeg artefacts, never imported.
  app.post('/api/reference/analyze', json, async (req, res) => {
    const body = (req.body ?? {}) as { url?: unknown; path?: unknown; refresh?: unknown };
    const url = typeof body.url === 'string' ? body.url.trim() : undefined;
    const path = typeof body.path === 'string' ? body.path.trim() : undefined;
    if (!url && !path) return void fail(res, 400, { code: 'INVALID', message: 'Body must be { url } or { path }.', path: 'url' });
    try {
      res.json(await analyzeReference(deps.publicDir, { url, path }, { ...deps.urlImport, rootDir: deps.rootDir, refresh: body.refresh === true }));
    } catch (err) {
      if (err instanceof PrivateFileError) return void fail(res, 403, { code: 'INVALID', message: err.message });
      if (err instanceof ReferenceAnalyzeError) return void fail(res, err.status, { code: 'INVALID', message: err.message });
      if (err instanceof ImportUrlError) return void fail(res, 400, { code: 'INVALID', message: err.message });
      throw err;
    }
  });

  // Generated media: download an https URL into uploads (streamed, ≤ 200 MB, kind sniffed from the bytes).
  app.post('/api/assets/import-url', json, async (req, res) => {
    const body = (req.body ?? {}) as Partial<ImportUrlRequest> & { agent?: unknown };
    if (typeof body.url !== 'string' || !body.url) return void fail(res, 400, { code: 'INVALID', message: 'Body must be { url, name?, provenance? }.', path: 'url' });
    if (body.name !== undefined && (typeof body.name !== 'string' || body.name.length > 120)) return void fail(res, 400, { code: 'INVALID', message: 'name must be text (at most 120 characters).', path: 'name' });
    try {
      const up = await importFromUrl(deps.publicDir, body.url, body.name, { ...deps.urlImport });
      const provider = body.provenance?.provider;
      if (typeof provider === 'string' && provider) await deps.generations?.imported(typeof body.agent === 'string' && body.agent ? body.agent.slice(0, 40) : 'Agent', up.name, provider.slice(0, 40));
      res.json(up);
    } catch (err) {
      if (err instanceof ImportUrlError) return void fail(res, 400, { code: 'INVALID', message: err.message, path: 'url' });
      throw err;
    }
  });

  // ---- generations --------------------------------------------------------
  deps.generations?.onEntry((entry) => bridge.broadcast('generation', entry));

  app.get('/api/generations/log', async (_req, res) => {
    if (!deps.generations) return void fail(res, 503, { code: 'PROTOCOL', message: 'The generation log is not available on this server.' });
    res.json(await deps.generations.log());
  });

  // Preview proxy of a video asset: none | pending | ready (+ proxySrc) | failed.
  // GET only reads the status (the editor, the renderer and local tools may GET); POST { src } makes a missing
  // proxy — it runs ffmpeg and writes a file, so like every write it is
  // accepted from the editor's origin only (the CORS middleware above).
  const proxySource = (res: Response, value: unknown): string | null => {
    const src = typeof value === 'string' ? value : '';
    if (sniffAssetKind(undefined, src)?.kind === 'video') return src;
    fail(res, 400, { code: 'INVALID', message: 'src must be a video asset path (.mp4, .webm, .mov).', path: 'src' });
    return null;
  };
  app.get('/api/assets/proxy', async (req, res) => {
    const src = proxySource(res, req.query.src);
    if (src !== null) res.json(await proxies.status(src));
  });
  app.post('/api/assets/proxy', json, async (req, res) => {
    const src = proxySource(res, (req.body as { src?: unknown } | undefined)?.src ?? req.query.src);
    if (src !== null) res.json(await proxies.request(src));
  });

  // ---- renders ------------------------------------------------------------
  app.get('/api/renders', (_req, res) => {
    res.json(deps.renders.list());
  });

  app.post('/api/renders', json, async (req, res) => {
    const body = (req.body ?? {}) as Partial<StartRenderRequest>;
    const valid = validateProject(body.project);
    if (!body.project || !valid.ok) {
      return void fail(res, 400, valid.ok ? { code: 'INVALID', message: 'Body must be { project: Project }.', path: 'project' } : valid.error);
    }
    if (body.simulateFailureAtProgress !== undefined && typeof body.simulateFailureAtProgress !== 'number') {
      return void fail(res, 400, { code: 'INVALID', message: 'simulateFailureAtProgress must be a number between 0 and 1.', path: 'simulateFailureAtProgress' });
    }
    try { deliverySettings(body.preset, valid.value.height); }
    catch (err) { return void fail(res, 400, { code: 'INVALID', message: (err as Error).message, path: 'preset' }); }
    if (await videoRefusal(res, valid.value)) return;
    if (req.query.rebundle === '1') deps.invalidateBundle?.();
    const job = await deps.renders.start(valid.value, { simulateFailureAtProgress: body.simulateFailureAtProgress, preset: body.preset });
    if (isUser(req)) void deps.generation?.markKept(valid.value).catch(() => undefined);
    res.json(job);
  });

  app.post('/api/renders/still', json, async (req, res) => {
    const body = (req.body ?? {}) as Partial<ExportStillRequest>;
    const valid = validateProject(body.project);
    if (!valid.ok) return void fail(res, 400, valid.error);
    if (body.preset !== 'png-full' && body.preset !== 'jpeg-thumb') return void fail(res, 400, { code: 'INVALID', message: 'preset must be png-full or jpeg-thumb.', path: 'preset' });
    const project = valid.value;
    const frame = body.frame;
    if (typeof frame !== 'number' || !Number.isInteger(frame) || frame < 0 || frame >= projectDurationInFrames(project)) return void fail(res, 400, { code: 'INVALID', message: 'frame is outside the project.', path: 'frame' });
    if (!deps.renderStill) return void fail(res, 503, { code: 'PROTOCOL', message: 'Still rendering is not available on this server.' });
    if (await videoRefusal(res, project)) return;
    const thumb = body.preset === 'jpeg-thumb';
    const scale = thumb ? 0.25 : 1;
    const dir = join(deps.rendersDir, 'stills');
    await mkdir(dir, { recursive: true });
    const name = `s_${Date.now().toString(36)}${(++stillSeq).toString(36)}.${thumb ? 'jpg' : 'png'}`;
    const outputPath = join(dir, name);
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    try {
      await deps.renderStill({ project, frame, scale, outputPath, imageFormat: thumb ? 'jpeg' : 'png', ...(thumb ? { jpegQuality: 80 } : {}), signal: controller.signal });
    } finally { res.off('close', abort); }
    void pruneStills(dir).catch(() => undefined);
    res.json({ url: `/renders/stills/${name}`, path: outputPath, width: Math.round(project.width * scale), height: Math.round(project.height * scale) } satisfies ExportStillResponse);
  });

  app.get('/api/renders/:id', (req, res) => {
    const job = deps.renders.get(req.params.id);
    if (!job) return void fail(res, 404, { code: 'NOT_FOUND', message: `Render job "${req.params.id}" does not exist.` });
    res.json(job);
  });

  app.get('/api/renders/:id/project', async (req, res) => {
    const project = await deps.renders.getSnapshot(req.params.id);
    if (!project) return void fail(res, 404, { code: 'NOT_FOUND', message: `No project snapshot for render job "${req.params.id}".` });
    res.json(project);
  });

  app.get('/api/renders/:id/manifest', async (req, res) => {
    const manifest = await deps.renders.getManifest(req.params.id, req.query.verify === '1');
    if (!manifest) return void fail(res, 404, { code: 'NOT_FOUND', message: `No manifest for render job "${req.params.id}".` });
    res.json(manifest);
  });

  for (const action of ['cancel', 'retry'] as const) {
    app.post(`/api/renders/:id/${action}`, async (req, res) => {
      try {
        const job = await deps.renders[action](req.params.id);
        if (!job) return void fail(res, 404, { code: 'NOT_FOUND', message: `Render job "${req.params.id}" does not exist.` });
        res.json(job);
      } catch (err) {
        if (err instanceof RenderConflictError) return void fail(res, 409, { code: 'INVALID', message: err.message });
        throw err;
      }
    });
  }

  // ---- stills -------------------------------------------------------------
  app.post('/api/stills', json, async (req, res) => {
    const body = (req.body ?? {}) as Partial<StillRequest>;
    const valid = validateProject(body.project);
    if (!body.project || !valid.ok) {
      return void fail(res, 400, valid.ok ? { code: 'INVALID', message: 'Body must be { project, frame, scale? }.', path: 'project' } : valid.error);
    }
    const project = valid.value;
    const total = projectDurationInFrames(project);
    const frame = body.frame;
    if (typeof frame !== 'number' || !Number.isInteger(frame) || frame < 0 || frame >= total) {
      return void fail(res, 400, { code: 'INVALID', message: `frame must be an integer from 0 to ${total - 1}.`, path: 'frame' });
    }
    const scale = body.scale ?? 0.5;
    if (typeof scale !== 'number' || !(scale >= 0.1 && scale <= 1)) {
      return void fail(res, 400, { code: 'INVALID', message: 'scale must be a number from 0.1 to 1.', path: 'scale' });
    }
    if (body.proposalId !== undefined && (typeof body.proposalId !== 'string' || !body.proposalId.trim())) {
      return void fail(res, 400, { code: 'INVALID', message: 'proposalId must be a non-empty string.', path: 'proposalId' });
    }
    if (!deps.renderStill) return void fail(res, 503, { code: 'PROTOCOL', message: 'Still rendering is not available on this server.' });
    if (await videoRefusal(res, project)) return;
    bridge.notify({ kind: 'rendering', detail: `rendering frame ${frame}` });
    const dir = join(deps.rendersDir, 'stills');
    await mkdir(dir, { recursive: true });
    const name = `s_${Date.now().toString(36)}${(++stillSeq).toString(36)}.png`;
    const outputPath = join(dir, name);
    const rootDir = deps.rootDir ?? process.cwd();
    const identity = {
      projectId: project.id, revision: project.revision, projectHash: projectHash(project),
      kind: body.proposalId !== undefined ? 'proposal' as const : 'committed' as const,
      ...(body.proposalId !== undefined ? { proposalId: body.proposalId } : {}),
      frame, rendererVersion: await rendererVersion(rootDir), compositionHash: await compositionHash(rootDir),
    };
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    try {
      await deps.renderStill({ project, frame, scale, outputPath, signal: controller.signal, onCompositionHash: hash => { identity.compositionHash = hash; } });
    } finally {
      res.off('close', abort);
    }
    void pruneStills(dir).catch(() => undefined);
    res.json({ identity, frame, width: Math.round(project.width * scale), height: Math.round(project.height * scale), url: `/renders/stills/${name}`, path: outputPath } satisfies StillResponse);
  });

  app.post('/api/stills/contact-sheet', json, async (req, res) => {
    const body = (req.body ?? {}) as Partial<ContactSheetRequest>;
    const valid = validateProject(body.project);
    if (!valid.ok) return void fail(res, 400, valid.error);
    const project = valid.value;
    const total = projectDurationInFrames(project);
    const frames = body.frames;
    if (!Array.isArray(frames) || frames.length < 1 || frames.length > 24 || frames.some((frame) => !Number.isInteger(frame) || frame < 0 || frame >= total)) {
      return void fail(res, 400, { code: 'INVALID', message: `frames must contain 1 to 24 integers from 0 to ${total - 1}.`, path: 'frames' });
    }
    const columns = body.columns ?? Math.min(3, frames.length);
    if (!Number.isInteger(columns) || columns < 1 || columns > 24) return void fail(res, 400, { code: 'INVALID', message: 'columns must be an integer from 1 to 24.', path: 'columns' });
    const scale = body.scale ?? 1;
    if (typeof scale !== 'number' || !(scale >= 0.1 && scale <= 1)) return void fail(res, 400, { code: 'INVALID', message: 'scale must be a number from 0.1 to 1.', path: 'scale' });
    if (!deps.renderContactSheet) return void fail(res, 503, { code: 'PROTOCOL', message: 'Contact sheet rendering is not available on this server.' });
    if (await videoRefusal(res, project)) return;
    bridge.notify({ kind: 'rendering', detail: `rendering contact sheet (${frames.length} frames)` });
    const dir = join(deps.rendersDir, 'stills');
    await mkdir(dir, { recursive: true });
    const name = `cs_${Date.now().toString(36)}${(++stillSeq).toString(36)}.png`;
    const outputPath = join(dir, name);
    const controller = new AbortController();
    const abort = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', abort);
    try {
      await deps.renderContactSheet({ project, frames, columns, scale, labels: true, outputPath, signal: controller.signal });
    } finally {
      res.off('close', abort);
    }
    void pruneStills(dir).catch(() => undefined);
    const { width, height } = contactSheetLayout({ project, frames, columns, scale, labels: true });
    res.json({ url: `/renders/stills/${name}`, path: outputPath, width, height, frames } satisfies ContactSheetResponse);
  });

  // ---- editor session -----------------------------------------------------
  app.get('/api/session', (req, res) => {
    res.json({ editor: isUser(req), ...(process.env.MGE_EDITOR_LINK_FILE ? { linkFile: process.env.MGE_EDITOR_LINK_FILE } : {}) } satisfies EditorSessionResponse);
  });

  app.post('/api/session', json, async (req, res) => {
    const origin = req.get('origin');
    const body = req.body as Partial<ClaimSessionRequest> | undefined;
    const id = origin !== undefined && editorOrigins.has(origin) && typeof body?.token === 'string'
      ? session.claim(body.token) : null;
    if (!id) return void fail(res, 403, {
      code: 'PROTOCOL',
      message: 'This editor link was already used or is from an earlier server start.',
      hint: 'Use the newest editor link printed by npm run dev, or restart the server for a new one.',
    });
    if (id.kind === 'minted') {
      const pending = session.beginPending(id);
      res.status(202).json(pending satisfies PendingClaimResponse);
      // The card outlives this HTTP response. Its own timeout cancels the bridge
      // request; disconnecting a poll must not deny the user's pending card.
      const controller = new AbortController();
      const timer = setTimeout(() => {
        session.resolvePending(pending.pending, 'denied');
        controller.abort();
      }, permissionTimeoutMs());
      timer.unref();
      void (async () => {
        try {
          const reply = await bridge.send({ type: 'askPermission', requestId: newId('req'), agent: 'Another browser',
            action: 'Unlock the editor in another browser or tab',
            detail: 'Code ' + pending.code + '. Allow only if the other tab shows this code.' }, undefined, controller.signal);
          const busy = reply.ok ? 'reason' in reply && reply.reason === 'another request is waiting'
            : reply.error.code === 'EDITOR_NOT_CONNECTED';
          session.resolvePending(pending.pending, busy ? 'busy' : reply.ok && reply.message === 'allowed' ? 'allowed' : 'denied');
        } catch { session.resolvePending(pending.pending, 'denied'); }
        finally { clearTimeout(timer); }
      })();
      return;
    }
    session.setCookie(res, id.sessionId);
    res.json({ editor: true, tabSecret: id.tabSecret } satisfies ClaimSessionResponse);
  });

  app.post('/api/session/pending', json, (req, res) => {
    const body = req.body as Partial<PendingClaimRequest> | undefined;
    const origin = req.get('origin');
    if (origin === undefined || !editorOrigins.has(origin) || typeof body?.pending !== 'string') {
      return void fail(res, 403, { code: 'PROTOCOL', message: "The unlocked editor tab didn't allow this." });
    }
    const result = session.pollPending(body.pending);
    if (result.status === 'waiting') return void res.status(202).json({ waiting: true });
    if (result.status === 'denied') return void fail(res, 403, { code: 'PROTOCOL', message: result.message });
    session.setCookie(res, result.claim.sessionId);
    res.json({ editor: true, tabSecret: result.claim.tabSecret } satisfies ClaimSessionResponse);
  });

  app.post('/api/session/link', requireUser, (_req, res) => {
    res.json({ url: `http://localhost:${webPort}/?${EDITOR_LINK_PARAM}=${session.mintLink()}` } satisfies EditorLinkResponse);
  });

  // ---- agent bridge -------------------------------------------------------
  app.get('/api/editor/events', requireUser, (req, res) => {
    bridge.connect(res);
  });

  app.get('/api/editor/state', (_req, res) => {
    // Only agents read this (the editor reports, it never reads), so it marks the agent as looking.
    bridge.notify({ kind: 'reading', detail: 'looking at the project' });
    res.json(bridge.state());
  });

  app.post('/api/editor/state', requireUser, json, (req, res) => {
    const body = req.body as Partial<EditorStateReport> | undefined;
    if (!body || typeof body.clientId !== 'string' || !body.context || typeof body.context !== 'object') {
      return void fail(res, 400, { code: 'INVALID', message: 'Body must be { clientId, context, project? }.' });
    }
    if (body.project !== undefined) {
      const valid = validateProject(body.project);
      if (!valid.ok) return void fail(res, 400, valid.error);
    }
    res.json({ ok: true, accepted: bridge.report(body as EditorStateReport) });
  });

  app.post('/api/editor/commands', json, async (req, res) => {
    const command = req.body as BridgeCommand | undefined;
    if (!command || typeof command !== 'object' || !BRIDGE_COMMANDS.has(command.type)) {
      return void fail(res, 400, { code: 'INVALID', message: `Body must be a bridge command with type ${[...BRIDGE_COMMANDS].join(' | ')}.`, path: 'type' });
    }
    if (command.type === 'askPermission' && (
      (typeof command.requestId !== 'string' || !command.requestId.trim()) || typeof command.agent !== 'string' || !command.agent.trim() ||
      typeof command.action !== 'string' || !command.action.trim() ||
      (command.detail !== undefined && typeof command.detail !== 'string') ||
      (command.timeoutMs !== undefined && (typeof command.timeoutMs !== 'number' || !Number.isFinite(command.timeoutMs) || command.timeoutMs <= 0))
    )) return void fail(res, 400, { code: 'INVALID', message: 'Permission commands require requestId, agent, action and an optional positive timeoutMs.' });
    const reply = await bridge.send(command);
    const status = reply.ok ? 200 : reply.error.code === 'EDITOR_NOT_CONNECTED' ? 409 : reply.error.code === 'TIMEOUT' ? 504 : 422;
    res.status(status).json(reply);
  });

  app.post('/api/editor/replies/:id', requireUser, json, (req, res) => {
    const reply = req.body as BridgeReply | undefined;
    if (!reply || typeof reply !== 'object' || typeof reply.ok !== 'boolean') {
      return void fail(res, 400, { code: 'INVALID', message: 'Body must be a bridge reply ({ ok: true, ... } or { ok: false, error }).' });
    }
    if (!bridge.reply(String(req.params.id), reply)) return void fail(res, 404, { code: 'NOT_FOUND', message: `No command "${req.params.id}" is waiting for a reply (it may have timed out).` });
    res.json({ ok: true });
  });

  // ---- chat ---------------------------------------------------------------
  const noChat = (res: Response) => fail(res, 503, { code: 'PROTOCOL', message: 'Chat is not available on this server.' });

  app.get('/api/chat/providers', async (req, res) => {
    res.json(deps.chatProviders ? await deps.chatProviders({ refresh: req.query.refresh === '1' }) : []);
  });

  app.get('/api/chat/:projectId', async (req, res) => {
    if (!deps.chat) return void noChat(res);
    if (!isValidProjectId(req.params.projectId)) return void fail(res, 400, { code: 'INVALID', message: 'Invalid project id.' });
    res.json(await deps.chat.state(req.params.projectId));
  });

  app.post('/api/chat/:projectId/messages', requireUser, json, async (req, res) => {
    if (!deps.chat) return void noChat(res);
    if (!isValidProjectId(req.params.projectId)) return void fail(res, 400, { code: 'INVALID', message: 'Invalid project id.' });
    const body = req.body as Partial<SendChatRequest> | undefined;
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    const attachments = Array.isArray(body?.attachments) ? body.attachments : [];
    if (!text && attachments.length === 0) return void fail(res, 400, { code: 'INVALID', message: 'Write a message or attach a file.', path: 'text' });
    for (const [i, a] of attachments.entries()) {
      if (!a || typeof a.src !== 'string' || !a.src.startsWith('assets/uploads/') || a.src.includes('..')) {
        return void fail(res, 400, { code: 'INVALID', message: 'Attachments must be files uploaded with POST /api/assets.', path: `attachments[${i}].src` });
      }
    }
    // Only a literal true turns Auto-apply's auto permission mode on; anything else (or nothing, from older editors) is off.
    res.json(await deps.chat.send(req.params.projectId, { text: text || 'See the attached file(s).', attachments, context: body?.context, autoApply: body?.autoApply === true }));
  });

  app.post('/api/chat/:projectId/cancel', requireUser, async (req, res) => {
    if (!deps.chat) return void noChat(res);
    if (!isValidProjectId(req.params.projectId)) return void fail(res, 400, { code: 'INVALID', message: 'Invalid project id.' });
    await deps.chat.cancel(req.params.projectId);
    res.json({ ok: true });
  });

  app.post('/api/chat/:projectId/reset', requireUser, async (req, res) => {
    if (!deps.chat) return void noChat(res);
    if (!isValidProjectId(req.params.projectId)) return void fail(res, 400, { code: 'INVALID', message: 'Invalid project id.' });
    res.json(await deps.chat.reset(req.params.projectId));
  });

  app.post('/api/chat/:projectId/settings', requireUser, json, async (req, res) => {
    if (!deps.chat) return void noChat(res);
    if (!isValidProjectId(req.params.projectId)) return void fail(res, 400, { code: 'INVALID', message: 'Invalid project id.' });
    const body = req.body as { provider?: unknown; model?: unknown } | undefined;
    if (typeof body?.provider !== 'string' || typeof body.model !== 'string') {
      return void fail(res, 400, { code: 'INVALID', message: 'Body must be { provider, model } (model "" = the agent’s default).' });
    }
    const r = await deps.chat.setSettings(req.params.projectId, { provider: body.provider, model: body.model });
    if (!r.ok) return void fail(res, r.status, r.error);
    res.json(r.state);
  });

  app.use('/api', (_req, res) => {
    fail(res, 404, { code: 'NOT_FOUND', message: 'Unknown API route.' });
  });

  // ---- static -------------------------------------------------------------
  const staticOptions = { index: false as const, setHeaders: (res: import('node:http').ServerResponse) => {
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; media-src 'self'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
  } };
  app.use('/renders', express.static(deps.rendersDir, staticOptions));
  app.use('/', express.static(deps.publicDir, staticOptions));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === 'entity.too.large') return void fail(res, 413, { code: 'INVALID', message: 'Upload too large (limit 50 MB; videos up to 500 MB).' });
    if (e?.type === 'entity.parse.failed') return void fail(res, 400, { code: 'INVALID', message: 'Request body is not valid JSON.' });
    console.error(err);
    fail(res, e?.status ?? 500, { code: 'PROTOCOL', message: e?.message ?? 'Internal server error' });
  });

  return app;
}
