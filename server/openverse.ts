// Server-side Openverse client: anonymous or OAuth, commercial CC0/BY only,
// search cache, download cache under public/assets/uploads/openverse/.

import { copyFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type {
  OpenverseAudioHit,
  OpenverseImportResponse,
  OpenverseRateLimit,
  OpenverseSearchResponse,
} from '../src/core/api-contract';
import type { ImportUrlResponse } from '../src/core/generation';
import {
  OPENVERSE_LICENSE_QUERY,
  OPENVERSE_NOTICE,
  isAllowedOpenverseLicense,
  openverseLengthBucket,
  rejectOpenverseLicense,
} from '../src/core/openverseLicense';
import { importFromUrl, type ImportOptions } from './url-import';

export const DEFAULT_OPENVERSE_API_BASE = 'https://api.openverse.org/v1';
const SEARCH_CACHE_MS = 60_000;
const USER_AGENT = 'motion-graphics-editor/0.1';

export class OpenverseError extends Error {
  status: number;
  code: 'RATE_LIMIT' | 'LICENSE' | 'NOT_FOUND' | 'INVALID' | 'NETWORK';
  retryAfterSeconds?: number;
  constructor(
    message: string,
    opts: { status?: number; code?: OpenverseError['code']; retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'OpenverseError';
    this.status = opts.status ?? 400;
    this.code = opts.code ?? 'INVALID';
    if (opts.retryAfterSeconds !== undefined) this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export interface SearchAudioArgs {
  query: string;
  kind?: 'music' | 'sfx';
  mood?: string;
  durationSeconds?: number;
  page?: number;
  pageSize?: number;
}

export interface OpenverseClient {
  searchAudio(args: SearchAudioArgs): Promise<OpenverseSearchResponse>;
  getAudio(id: string): Promise<OpenverseAudioHit>;
  importAudio(publicDir: string, id: string, name?: string, urlImport?: ImportOptions): Promise<OpenverseImportResponse>;
  status(): { authenticated: boolean; apiBase: string; notice: string };
}

export interface OpenverseClientOptions {
  fetch?: typeof fetch;
  now?: () => number;
  env?: NodeJS.Dict<string>;
  importAudioFile?: typeof importFromUrl;
}

interface TokenCache {
  access: string;
  expiresAt: number;
}

interface SearchCacheEntry {
  expiresAt: number;
  payload: OpenverseSearchResponse;
}

function apiBase(env: NodeJS.Dict<string>): string {
  return (env.OPENVERSE_API_BASE ?? DEFAULT_OPENVERSE_API_BASE).replace(/\/+$/, '');
}

function retryAfterSeconds(res: Response): number | undefined {
  const raw = res.headers.get('retry-after');
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return n;
  const when = Date.parse(raw);
  if (!Number.isNaN(when)) return Math.max(0, Math.ceil((when - Date.now()) / 1000));
  return undefined;
}

function parseRateLimit(res: Response, retry?: number): OpenverseRateLimit | undefined {
  const num = (name: string) => {
    const v = res.headers.get(name);
    if (v === null || v === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };
  const limit: OpenverseRateLimit = {
    limitMinute: num('x-ratelimit-limit-request-minute'),
    remainingMinute: num('x-ratelimit-available-request-minute'),
    limitDay: num('x-ratelimit-limit-request-day'),
    remainingDay: num('x-ratelimit-available-request-day'),
    retryAfterSeconds: retry,
  };
  return Object.values(limit).some((v) => v !== undefined) ? limit : retry !== undefined ? { retryAfterSeconds: retry } : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

function tagsOf(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((t) => {
    if (typeof t === 'string' && t.trim()) return [t.trim()];
    const name = asRecord(t)?.name;
    return typeof name === 'string' && name.trim() ? [name.trim()] : [];
  });
}

/** Openverse `duration` is milliseconds. */
function durationSecondsOf(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return null;
  return raw / 1000;
}

export function parseOpenverseWork(raw: unknown): OpenverseAudioHit {
  const o = asRecord(raw);
  const id = str(o?.id);
  if (!id) throw new OpenverseError('Openverse returned a work without an id.', { code: 'INVALID' });
  const duration = durationSecondsOf(o?.duration);
  const hit: OpenverseAudioHit = {
    id,
    title: str(o?.title) ?? 'Untitled',
    durationSeconds: duration,
    license: str(o?.license) ?? '',
    attribution: str(o?.attribution) ?? '',
    tags: tagsOf(o?.tags),
  };
  const creator = str(o?.creator);
  if (creator) hit.creator = creator;
  const creatorUrl = str(o?.creator_url);
  if (creatorUrl) hit.creatorUrl = creatorUrl;
  const licenseVersion = str(o?.license_version);
  if (licenseVersion) hit.licenseVersion = licenseVersion;
  const licenseUrl = str(o?.license_url);
  if (licenseUrl) hit.licenseUrl = licenseUrl;
  const category = str(o?.category);
  if (category) hit.category = category;
  const provider = str(o?.provider);
  if (provider) hit.provider = provider;
  const source = str(o?.source);
  if (source) hit.source = source;
  const foreign = str(o?.foreign_landing_url);
  if (foreign) hit.foreignLandingUrl = foreign;
  const url = str(o?.url);
  if (url) hit.previewUrl = url;
  const thumbnail = str(o?.thumbnail);
  if (thumbnail) hit.thumbnail = thumbnail;
  if (!hit.attribution) {
    const who = hit.creator ?? 'unknown';
    hit.attribution = `"${hit.title}" by ${who} is licensed under ${hit.license || 'an unknown license'}.`;
  }
  return hit;
}

export function assertAllowedLicense(work: OpenverseAudioHit): void {
  const reason = rejectOpenverseLicense(work.license);
  if (reason) throw new OpenverseError(reason, { status: 403, code: 'LICENSE' });
}

export function extractOpenverseId(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  const fromUrl = /(?:openverse\.org\/(?:audio|music)\/|api\.openverse\.org\/v1\/audio\/)([0-9a-f-]{8,})/i.exec(s);
  if (fromUrl) return fromUrl[1].replace(/\/+$/, '');
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return s;
  return null;
}

function cacheKey(args: SearchAudioArgs): string {
  return JSON.stringify({
    q: args.query.trim(),
    kind: args.kind ?? '',
    mood: args.mood?.trim() ?? '',
    durationSeconds: args.durationSeconds ?? null,
    page: args.page ?? 1,
    pageSize: args.pageSize ?? 8,
  });
}

interface CacheMeta {
  src: string;
  mimeType: string;
  kind: 'audio';
  durationSeconds?: number;
  bytes?: number;
  name: string;
}

function cachePaths(publicDir: string, id: string) {
  const safe = id.replace(/[^a-zA-Z0-9-]/g, '');
  const dir = join(publicDir, 'assets', 'uploads', 'openverse');
  return { dir, meta: join(dir, `${safe}.meta.json`), safe };
}

export function createOpenverseClient(opts: OpenverseClientOptions = {}): OpenverseClient {
  const fetchFn = opts.fetch ?? fetch;
  const now = opts.now ?? Date.now;
  const env = opts.env ?? process.env;
  const importFile = opts.importAudioFile ?? importFromUrl;
  let token: TokenCache | null = null;
  const searchCache = new Map<string, SearchCacheEntry>();

  const base = () => apiBase(env);
  const hasOAuth = () => !!(env.OPENVERSE_CLIENT_ID && env.OPENVERSE_CLIENT_SECRET);

  async function openverseToken(force = false): Promise<string | null> {
    if (!hasOAuth()) return null;
    if (!force && token && now() < token.expiresAt - 60_000) return token.access;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: env.OPENVERSE_CLIENT_ID!,
      client_secret: env.OPENVERSE_CLIENT_SECRET!,
    });
    const res = await fetchFn(`${base()}/auth_tokens/token/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': USER_AGENT },
      body,
    });
    if (!res.ok) throw new OpenverseError('Could not authenticate with Openverse. Check OPENVERSE_CLIENT_ID / OPENVERSE_CLIENT_SECRET.', { status: res.status, code: 'NETWORK' });
    const json = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!json.access_token) throw new OpenverseError('Openverse token response was missing access_token.', { code: 'NETWORK' });
    token = { access: json.access_token, expiresAt: now() + Math.max(60, json.expires_in ?? 3600) * 1000 };
    return token.access;
  }

  async function openverseFetch(path: string, retryAuth = true): Promise<{ res: Response; json: unknown; rateLimit?: OpenverseRateLimit }> {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'application/json' };
    const bearer = await openverseToken();
    if (bearer) headers.Authorization = `Bearer ${bearer}`;
    const res = await fetchFn(`${base()}${path.startsWith('/') ? path : `/${path}`}`, { headers });
    const retry = retryAfterSeconds(res);
    const rateLimit = parseRateLimit(res, retry);
    if (res.status === 401 && retryAuth && hasOAuth()) {
      token = null;
      await openverseToken(true);
      return openverseFetch(path, false);
    }
    if (res.status === 429) {
      const wait = retry ?? 60;
      throw new OpenverseError(`Openverse rate limit reached. Try again in ${wait} seconds (anonymous: 20/min, 200/day).`, {
        status: 429,
        code: 'RATE_LIMIT',
        retryAfterSeconds: wait,
      });
    }
    if (res.status === 404) throw new OpenverseError('That Openverse work was not found.', { status: 404, code: 'NOT_FOUND' });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      throw new OpenverseError(`Openverse request failed (HTTP ${res.status}).`, { status: res.status, code: 'NETWORK' });
    }
    return { res, json, rateLimit };
  }

  async function getAudio(id: string): Promise<OpenverseAudioHit> {
    const resolved = extractOpenverseId(id);
    if (!resolved) {
      throw new OpenverseError(
        'Pass an Openverse work id (a UUID), not a file URL. License is checked against the catalog; a direct download URL cannot skip that.',
        { status: 400, code: 'INVALID' },
      );
    }
    const { json } = await openverseFetch(`/audio/${encodeURIComponent(resolved)}/`);
    const work = parseOpenverseWork(json);
    assertAllowedLicense(work);
    return work;
  }

  async function searchAudio(args: SearchAudioArgs): Promise<OpenverseSearchResponse> {
    const query = args.query.trim();
    if (!query) throw new OpenverseError('query must not be empty.', { code: 'INVALID' });
    if (query.length > 180) throw new OpenverseError('query is too long (max 180 characters).', { code: 'INVALID' });
    const key = cacheKey(args);
    const cached = searchCache.get(key);
    if (cached && cached.expiresAt > now()) return cached.payload;

    const q = [query, args.mood?.trim()].filter(Boolean).join(' ');
    const params = new URLSearchParams();
    params.set('q', q.slice(0, 200));
    params.set('license', OPENVERSE_LICENSE_QUERY);
    params.set('license_type', 'commercial');
    params.set('mature', 'false');
    params.set('page', String(Math.max(1, args.page ?? 1)));
    params.set('page_size', String(Math.min(20, Math.max(1, args.pageSize ?? 8))));
    if (args.kind === 'music') params.set('category', 'music');
    if (args.kind === 'sfx') {
      params.set('category', 'sound_effect');
      params.set('length', args.durationSeconds !== undefined ? openverseLengthBucket(args.durationSeconds) : 'shortest,short');
    } else if (args.durationSeconds !== undefined) {
      params.set('length', openverseLengthBucket(args.durationSeconds));
    }

    const { json, rateLimit } = await openverseFetch(`/audio/?${params}`);
    const body = asRecord(json);
    const results = Array.isArray(body?.results) ? body.results : [];
    const hits = results
      .map((row) => {
        try {
          return parseOpenverseWork(row);
        } catch {
          return null;
        }
      })
      .filter((h): h is OpenverseAudioHit => !!h && isAllowedOpenverseLicense(h.license));

    const payload: OpenverseSearchResponse = {
      results: hits,
      page: typeof body?.page === 'number' ? body.page : (args.page ?? 1),
      pageCount: typeof body?.page_count === 'number' ? body.page_count : 1,
      resultCount: typeof body?.result_count === 'number' ? body.result_count : hits.length,
      authenticated: hasOAuth(),
      notice: OPENVERSE_NOTICE,
    };
    if (rateLimit) payload.rateLimit = rateLimit;
    searchCache.set(key, { expiresAt: now() + SEARCH_CACHE_MS, payload });
    return payload;
  }

  async function readCache(publicDir: string, id: string): Promise<CacheMeta | null> {
    try {
      const { meta } = cachePaths(publicDir, id);
      const parsed = JSON.parse(await readFile(meta, 'utf8')) as CacheMeta;
      if (parsed.kind !== 'audio' || !parsed.src) return null;
      await readFile(join(publicDir, parsed.src));
      return parsed;
    } catch {
      return null;
    }
  }

  async function writeCache(publicDir: string, id: string, meta: CacheMeta): Promise<void> {
    const { dir, meta: metaPath } = cachePaths(publicDir, id);
    await mkdir(dir, { recursive: true });
    await writeFile(metaPath, JSON.stringify(meta, null, 2));
  }

  async function importAudio(
    publicDir: string,
    id: string,
    name?: string,
    urlImport?: ImportOptions,
  ): Promise<OpenverseImportResponse> {
    const work = await getAudio(id);
    assertAllowedLicense(work);
    if (!work.previewUrl) throw new OpenverseError('That work has no download URL.', { code: 'INVALID' });

    const cached = await readCache(publicDir, work.id);
    if (cached) {
      const out: OpenverseImportResponse = {
        src: cached.src,
        name: name?.trim() || cached.name || work.title,
        mimeType: cached.mimeType,
        kind: 'audio',
        cached: true,
        work,
        notice: OPENVERSE_NOTICE,
      };
      if (cached.durationSeconds !== undefined) out.durationSeconds = cached.durationSeconds;
      else if (work.durationSeconds !== null) out.durationSeconds = work.durationSeconds;
      if (cached.bytes !== undefined) out.bytes = cached.bytes;
      return out;
    }

    const up: ImportUrlResponse = await importFile(publicDir, work.previewUrl, name?.trim() || work.title, urlImport);
    if (up.kind !== 'audio') {
      throw new OpenverseError('Openverse returned a file that is not audio.', { code: 'INVALID' });
    }
    const { dir, safe } = cachePaths(publicDir, work.id);
    await mkdir(dir, { recursive: true });
    const ext = (basename(up.src).split('.').pop() ?? 'mp3').replace(/[^a-z0-9]/gi, '') || 'mp3';
    const cachedRel = `assets/uploads/openverse/${safe}.${ext}`;
    await copyFile(join(publicDir, up.src), join(publicDir, cachedRel));
    await unlink(join(publicDir, up.src)).catch(() => undefined);
    const meta: CacheMeta = {
      src: cachedRel,
      mimeType: up.mimeType,
      kind: 'audio',
      name: up.name,
      bytes: up.bytes,
    };
    if (up.durationSeconds !== undefined) meta.durationSeconds = up.durationSeconds;
    await writeCache(publicDir, work.id, meta);
    const out: OpenverseImportResponse = {
      src: cachedRel,
      name: name?.trim() || up.name,
      mimeType: up.mimeType,
      kind: 'audio',
      cached: false,
      work,
      notice: OPENVERSE_NOTICE,
    };
    if (up.bytes !== undefined) out.bytes = up.bytes;
    if (up.durationSeconds !== undefined) out.durationSeconds = up.durationSeconds;
    else if (work.durationSeconds !== null) out.durationSeconds = work.durationSeconds;
    return out;
  }

  return {
    searchAudio,
    getAudio,
    importAudio,
    status: () => ({ authenticated: hasOAuth(), apiBase: base(), notice: OPENVERSE_NOTICE }),
  };
}
