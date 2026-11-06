import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { EDITOR_TAB_HEADER, EDITOR_TAB_PARAM, permissionTimeoutMs, type PendingClaimResponse } from '../src/core/api-contract';
import type { CommandError } from '../src/core/types';

export const USER_REQUIRED: CommandError = {
  code: 'PROTOCOL',
  message: 'This needs the editor tab that was opened from the editor link.',
  hint: 'Open the editor link printed by npm run dev (it ends in ?session=…).',
};

const fresh = () => randomBytes(32).toString('base64url');
const CLAIM_DENIED = "The unlocked editor tab didn't allow this.";
const CLAIM_BUSY = 'The unlocked tab is busy with another request. Try the link again in a moment.';
type Claim = { sessionId: string; tabSecret: string; kind: 'launch' | 'minted' };
type PendingResult = { status: 'waiting' } | { status: 'allowed'; claim: Claim } | { status: 'denied'; message: string };
interface PendingClaim {
  claim: Claim;
  expiresAt: number;
  result: PendingResult;
}

/** Secrets live only in this server process and disappear on restart. */
export class EditorSession {
  private readonly initialToken: string;
  private readonly tokens = new Map<string, number>();
  private readonly tabSecrets = new Set<string>();
  private readonly now: () => number;
  private readonly sessions = new Set<string>();
  private readonly reserved = new WeakMap<Claim, { token: string; expiresAt: number }>();
  private readonly pending = new Map<string, PendingClaim>();

  readonly cookieName: string;

  constructor(options: { token?: string; now?: () => number; port?: number } = {}) {
    this.cookieName = `mge_editor_${options.port ?? Number(process.env.MGE_SERVER_PORT ?? 5318)}`;
    this.now = options.now ?? Date.now;
    this.initialToken = options.token ?? fresh();
    this.tokens.set(this.initialToken, Infinity);
  }

  launchToken(): string | null {
    return this.tokens.has(this.initialToken) ? this.initialToken : null;
  }

  claim(token: string): Claim | null {
    if (typeof token !== 'string') return null;
    const candidate = Buffer.from(token);
    let match: string | undefined;
    for (const [outstanding, expiresAt] of this.tokens) {
      if (this.now() >= expiresAt) { this.tokens.delete(outstanding); continue; }
      const expected = Buffer.from(outstanding);
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) match = outstanding;
    }
    if (match === undefined) return null;
    const expiresAt = this.tokens.get(match)!;
    this.tokens.delete(match);
    const id = fresh();
    const tabSecret = fresh();
    const claim = { sessionId: id, tabSecret, kind: match === this.initialToken ? 'launch' as const : 'minted' as const };
    if (claim.kind === 'launch') this.approveClaim(claim);
    else this.reserved.set(claim, { token: match, expiresAt });
    return claim;
  }

  beginPending(claim: Claim): PendingClaimResponse {
    for (const [id, entry] of this.pending) if (this.now() >= entry.expiresAt) this.pending.delete(id);
    const pending = fresh();
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const letters = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join('');
    this.pending.set(pending, { claim, expiresAt: this.now() + permissionTimeoutMs(), result: { status: 'waiting' } });
    return { pending, code: `${letters.slice(0, 3)}-${letters.slice(3)}` };
  }

  resolvePending(pending: string, decision: 'allowed' | 'denied' | 'busy'): void {
    const entry = this.pending.get(pending);
    if (!entry || entry.result.status !== 'waiting') return;
    if (this.now() >= entry.expiresAt) { this.pending.delete(pending); return; }
    if (decision === 'busy') {
      const reserved = this.reserved.get(entry.claim);
      // Keep the original five-minute lifetime, even across repeated busy replies.
      if (reserved && this.now() < reserved.expiresAt) this.tokens.set(reserved.token, reserved.expiresAt);
    }
    this.reserved.delete(entry.claim);
    entry.result = decision === 'allowed' ? { status: 'allowed', claim: entry.claim }
      : { status: 'denied', message: decision === 'busy' ? CLAIM_BUSY : CLAIM_DENIED };
  }

  pollPending(pending: string): PendingResult {
    const entry = this.pending.get(pending);
    if (!entry) return { status: 'denied', message: CLAIM_DENIED };
    if (this.now() >= entry.expiresAt) {
      this.pending.delete(pending);
      return { status: 'denied', message: CLAIM_DENIED };
    }
    if (entry.result.status !== 'waiting') {
      this.pending.delete(pending);
      if (entry.result.status === 'allowed') this.approveClaim(entry.claim);
    }
    return entry.result;
  }

  /** A reserved minted token gains no authority until the unlocked tab approves. */
  approveClaim(claim: { sessionId: string; tabSecret: string }): void {
    this.sessions.add(claim.sessionId);
    this.tabSecrets.add(claim.tabSecret);
  }

  mintLink(): string {
    const token = fresh();
    this.tokens.set(token, this.now() + 5 * 60 * 1000);
    if (this.tokens.size > 8) this.tokens.delete(this.tokens.keys().next().value!);
    return token;
  }

  isEditor(req: Request): boolean {
    const cookies = (req.headers.cookie ?? '').split(';');
    const knownCookie = cookies.some((cookie) => {
      const index = cookie.indexOf('=');
      return index >= 0 && cookie.slice(0, index).trim() === this.cookieName
        && this.sessions.has(cookie.slice(index + 1).trim());
    });
    if (!knownCookie) return false;
    const secret = req.get(EDITOR_TAB_HEADER) ?? (req.method === 'GET' && req.path === '/api/editor/events'
      && typeof req.query[EDITOR_TAB_PARAM] === 'string' ? req.query[EDITOR_TAB_PARAM] : undefined);
    if (typeof secret !== 'string') return false;
    const candidate = Buffer.from(secret);
    let valid = false;
    for (const tabSecret of this.tabSecrets) {
      const expected = Buffer.from(tabSecret);
      if (candidate.length === expected.length && timingSafeEqual(candidate, expected)) valid = true;
    }
    return valid;
  }

  setCookie(res: Response, sessionId: string): void {
    res.setHeader('Set-Cookie', `${this.cookieName}=${sessionId}; Path=/; HttpOnly; SameSite=Strict`);
  }
}

/** Both the browser cookie and tab secret prove the user; Origin restricts that proof. */
export function isUser(req: Request, session: EditorSession, editorOrigins: ReadonlySet<string>): boolean {
  const origin = req.get('origin');
  return session.isEditor(req) && (origin === undefined || editorOrigins.has(origin));
}
