// The editor session. The local server prints a one-time editor link,
// http://localhost:<port>/?session=<token>, at launch; only a browser that
// opened it counts as the user. The server keeps the proof in an HttpOnly
// cookie this code never sees, plus a secret it hands this tab on unlock: a
// localhost cookie reaches every port and every tab (one an agent opens too),
// the secret only this tab. It lives in sessionStorage (a reload keeps it, a
// new tab starts locked) and goes with every request (api.ts withTab).
// Locked, the routes that act for the user (agents, chat, the fal key,
// generation settings, the server autosave) answer 401; editing, Save and
// exports still work (persistence.ts skips the server autosave). A server restart forgets every session, so a 401 or a reconnect checks again.
// Another unlocked tab: Settings › New tab opens one with this tab as its
// opener, and the browser copies sessionStorage (so the secret) into it; no
// link changes hands. Another browser needs a minted link, and claiming that
// takes two steps: the server answers with a pairing code, which this tab
// shows while it waits for an unlocked tab to allow it (a permission card
// naming the same code), so a program that copied the link can't use it
// unnoticed.

import { create } from 'zustand';
import { EDITOR_LINK_PARAM, type ClaimSessionResponse } from '../core/api-contract';
import { api, ApiRequestError, errorText, onServerStatus, onUnauthorized, provideTabSecret, ServerDownError, SERVER_DOWN_MESSAGE } from './api';

export const LINK_USED_MESSAGE = 'That link was already used or is from an earlier server start. Use the newest link in the terminal.';
export const NO_TOKEN_MESSAGE = 'That link has no session=… part. Copy the whole editor link from the terminal.';

interface SessionState {
  /** True: this tab opened the editor link. False: locked. Null: not known yet (booting, or the server never answered). */
  editor: boolean | null;
  /** Why the last unlock failed, shown in the locked notice; cleared by the next success. */
  error: string | null;
  /**
   * The pairing code while a minted link's claim waits on an unlocked tab to
   * allow it, else null. The locked notice shows it; the unlocked tab's card
   * names the same code.
   */
  code: string | null;
  /** Where the link was saved when an agent started the server (GET /api/session), else null: it was printed in a terminal. */
  linkFile: string | null;
}

export const useSession = create<SessionState>(() => ({ editor: null, error: null, code: null, linkFile: null }));

/** A waiting claim asks the server for the unlocked tab's answer this often. */
export const CLAIM_POLL_MS = 1000;
/** The unlocked tab's card waits 120 s for an answer (the server's permission timeout): a waiting claim gives up a little after. */
export const CLAIM_TIMEOUT_MS = 130_000;
export const NO_ANSWER_MESSAGE = 'The unlocked tab didn’t answer. Try the link again.';

const TAB_KEY = 'mge.tab';

/** sessionStorage can be missing or throw (privacy modes, quota): then memory alone holds the secret, for this page. */
function storedSecret(): string | null {
  try {
    return sessionStorage.getItem(TAB_KEY);
  } catch {
    return null;
  }
}

let secret: string | null = storedSecret();

function keepSecret(value: string | null) {
  secret = value;
  try {
    if (value === null) sessionStorage.removeItem(TAB_KEY);
    else sessionStorage.setItem(TAB_KEY, value);
  } catch {
    // Memory still has it.
  }
}

/** The secret this tab got at its last unlock, or null when it has none. */
export function tabSecret(): string | null {
  return secret;
}
provideTabSecret(tabSecret);

/** When this tab last unlocked: a 401 to a request sent before then predates the cookie and proves nothing. */
let unlockedAt = 0;

/** A route answered 401: the tab is locked (the server restarted, or the link was never opened). */
export function markLocked(sentAt = Date.now()) {
  if (sentAt <= unlockedAt) return;
  if (useSession.getState().editor !== false) useSession.setState({ editor: false });
}
onUnauthorized(markLocked);

/** One session call at a time, so a check sent before an unlock can never land after it and lock the tab again. */
let busy: Promise<unknown> | null = null;
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = (busy ?? Promise.resolve()).then(fn, fn);
  busy = run;
  const clear = () => {
    if (busy === run) busy = null;
  };
  run.then(clear, clear);
  return run;
}

/** The token in a pasted editor link, or the pasted text itself when it is a bare token. '' when there is none. */
export function tokenFrom(text: string): string {
  const s = text.trim();
  const q = s.indexOf('?');
  // A link, or the bare `session=…` part of one. (Tokens are base64url: no '?', '=', '/' or ':'.)
  if (q >= 0 || s.includes('=')) return new URLSearchParams(s.slice(q + 1).split('#')[0]).get(EDITOR_LINK_PARAM)?.trim() ?? '';
  // A link without one.
  if (s.includes('/') || s.includes(':')) return '';
  return s;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The unlocked tab's answer to a waiting claim: the unlock, or null when it
 * never came. `pending` stays here, in memory: never in storage or the
 * address, where something else could read it and finish the claim.
 */
async function awaitApproval(pending: string): Promise<ClaimSessionResponse | null> {
  const deadline = Date.now() + CLAIM_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(CLAIM_POLL_MS);
    const r = await api.pendingClaim(pending);
    if (r) return r;
  }
  return null;
}

/** Spend a token. Resolves to null when this tab is now unlocked, or the reason it is not. */
export function claim(token: string): Promise<string | null> {
  return serial(async () => {
    try {
      const answer = await api.claimSession(token);
      let r: ClaimSessionResponse | null;
      if (answer.waiting) {
        // A minted link: an unlocked tab must allow it. Show the code its card will name.
        useSession.setState({ code: answer.waiting.code });
        r = await awaitApproval(answer.waiting.pending);
        if (!r) return NO_ANSWER_MESSAGE;
      } else r = answer.claimed;
      if (r.editor) {
        keepSecret(r.tabSecret);
        unlockedAt = Date.now();
        useSession.setState({ editor: true, error: null });
        return null;
      }
      return LINK_USED_MESSAGE;
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 403) {
        // A tab known to be locked holds a secret the server no longer accepts. At boot that is
        // not known yet: the check claimFromUrl makes next decides, so an unlocked tab keeps its own.
        if (useSession.getState().editor === false) keepSecret(null);
        // The server says which: already used or stale, not allowed, or no unlocked tab to ask.
        const { message, hint } = errorText(e);
        return hint ? `${message} ${hint}` : message;
      }
      if (e instanceof ServerDownError) return SERVER_DOWN_MESSAGE;
      return errorText(e).message;
    } finally {
      if (useSession.getState().code !== null) useSession.setState({ code: null });
    }
  });
}

/** Ask the server whether this tab is unlocked. Resolves to the answer, or null when the server could not say. */
export function refresh(): Promise<boolean | null> {
  // A check already on its way (or an unlock) answers this one too.
  if (busy) return busy.then(() => useSession.getState().editor);
  return serial(async () => {
    try {
      const { editor, linkFile = null } = await api.session();
      if (editor) unlockedAt = Math.max(unlockedAt, Date.now());
      // The server does not know this tab's secret (it restarted): it unlocks nothing any more.
      else if (secret !== null) keepSecret(null);
      useSession.setState(editor ? { editor, error: null, linkFile } : { editor, linkFile });
      return editor;
    } catch {
      return null;
    }
  });
}

/**
 * Boot: spend the editor link's token if the address has one, else ask. The
 * token leaves the address bar (and history) before anything else, whatever
 * the outcome: it works once and must not linger where it can be copied.
 */
export async function claimFromUrl(): Promise<void> {
  // A tab opened from Settings › New tab already has the secret (sessionStorage was copied as it opened): it needs nothing more from its opener.
  if (window.opener) window.opener = null;
  const url = new URL(window.location.href);
  const token = url.searchParams.get(EDITOR_LINK_PARAM);
  if (token === null) {
    await refresh();
    return;
  }
  url.searchParams.delete(EDITOR_LINK_PARAM);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  const error = await claim(token.trim());
  if (error === null) return;
  // A used link in a tab that is already unlocked (a reload of an old link) changes nothing.
  // A server that is down already shows as offline in the header: the notice keeps its own reason for links.
  if ((await refresh()) !== true) useSession.setState({ editor: false, error: error === SERVER_DOWN_MESSAGE ? null : error });
}

/**
 * Settings › New tab: this editor in a new tab that is already unlocked. It
 * keeps the opener relationship on purpose (no `noopener`): only then does the
 * browser copy this tab's sessionStorage, and with it the secret, into the new
 * one. The new tab drops `window.opener` as it boots (claimFromUrl). False when
 * the browser blocked the tab.
 */
export function openUnlockedTab(): boolean {
  return window.open(`${window.location.origin}/`, '_blank') !== null;
}

/** Ask again whenever the server comes back (a restart forgets every session) or has never answered yet. */
export function watchSession(): () => void {
  let wasDown = false;
  return onServerStatus((up) => {
    if (!up) wasDown = true;
    else if (wasDown || useSession.getState().editor === null) {
      wasDown = false;
      void refresh();
    }
  });
}

/** Run `start` while this tab is unlocked: started on unlock, stopped (its returned stop) on lock. Returns a stop for the watch. */
export function whileUnlocked(start: () => () => void): () => void {
  let stop: (() => void) | null = null;
  const sync = (editor: boolean | null) => {
    if (editor === true && !stop) stop = start();
    else if (editor !== true && stop) {
      stop();
      stop = null;
    }
  };
  sync(useSession.getState().editor);
  const unsubscribe = useSession.subscribe((s) => sync(s.editor));
  return () => {
    unsubscribe();
    stop?.();
    stop = null;
  };
}
