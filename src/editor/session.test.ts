// The editor session, browser side: the link's token is spent once and leaves
// the address bar; the tab keeps its secret and sends it with every request;
// a 401 anywhere locks the tab; the agent bridge runs only unlocked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EDITOR_TAB_HEADER } from '../core/api-contract';
import { api, errorText, LOCKED_MESSAGE, SERVER_DOWN_MESSAGE } from './api';
import { claim, CLAIM_POLL_MS, CLAIM_TIMEOUT_MS, claimFromUrl, LINK_USED_MESSAGE, markLocked, NO_ANSWER_MESSAGE, openUnlockedTab, refresh, tabSecret, tokenFrom, useSession, whileUnlocked } from './session';

const realFetch = globalThis.fetch;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const claimed = (tabSecret = 'tab_1') => json({ editor: true, tabSecret });
const USED = 'This editor link was already used or is from an earlier server start.';
const used = () => json({ error: { code: 'PROTOCOL', message: USED } }, 403);
/** The whole session state, with the fields a test doesn't care about at rest. */
const state = (over: Partial<ReturnType<typeof useSession.getState>>) => ({ editor: null, error: null, code: null, linkFile: null, ...over });
const unauthorized = () => json({ error: { code: 'PROTOCOL', message: 'Open the editor link first.' } }, 401);

type Route = (init?: RequestInit) => Response | Promise<Response>;
function serve(routes: Record<string, Route>) {
  const fetchMock = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${String(url)}`;
    const route = routes[key];
    if (!route) throw new Error(`unexpected ${key}`);
    return route(init);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

/** A window at `href` whose history records replaceState. */
function at(href: string) {
  const replaceState = vi.fn();
  vi.stubGlobal('window', { location: { href }, history: { state: null, replaceState } });
  return replaceState;
}

beforeEach(() => {
  useSession.setState(state({}));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('tokenFrom', () => {
  it('takes the token out of a pasted link, a session= part, or a bare token', () => {
    expect(tokenFrom('http://localhost:5173/?session=Ab_-9xYz')).toBe('Ab_-9xYz');
    expect(tokenFrom('  http://localhost:5173/?session=Ab_-9xYz#top \n')).toBe('Ab_-9xYz');
    expect(tokenFrom('localhost:5173/?other=1&session=Ab_-9xYz')).toBe('Ab_-9xYz');
    expect(tokenFrom('?session=Ab_-9xYz')).toBe('Ab_-9xYz');
    expect(tokenFrom('session=Ab_-9xYz')).toBe('Ab_-9xYz');
    expect(tokenFrom('Ab_-9xYz')).toBe('Ab_-9xYz');
  });

  it('finds nothing in a link without one, or in nothing', () => {
    expect(tokenFrom('http://localhost:5173/')).toBe('');
    expect(tokenFrom('http://localhost:5173/?project=p1')).toBe('');
    expect(tokenFrom('   ')).toBe('');
  });
});

describe('claimFromUrl', () => {
  it('spends the token, unlocks, and takes it out of the address bar (other parameters stay)', async () => {
    const replaceState = at('http://localhost:5173/?session=tok_1&project=p1#scene');
    const fetchMock = serve({ 'POST /api/session': () => claimed() });
    await claimFromUrl();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/?project=p1#scene');
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ token: 'tok_1' });
    // The address is clean before the token goes anywhere.
    expect(replaceState.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0]);
    expect(useSession.getState()).toEqual(state({ editor: true }));
  });

  it('a used link still leaves the address bar, and the tab is locked with the server’s reason', async () => {
    const replaceState = at('http://localhost:5173/?session=old');
    serve({ 'POST /api/session': used, 'GET /api/session': () => json({ editor: false }) });
    await claimFromUrl();
    expect(replaceState).toHaveBeenCalledWith(null, '', '/');
    expect(useSession.getState()).toEqual(state({ editor: false, error: USED }));
  });

  it('a used link in a tab that is already unlocked changes nothing', async () => {
    at('http://localhost:5173/?session=old');
    serve({ 'POST /api/session': used, 'GET /api/session': () => json({ editor: true }) });
    await claimFromUrl();
    expect(useSession.getState()).toEqual(state({ editor: true }));
  });

  it('a tab opened as a new unlocked tab lets go of its opener as it boots', async () => {
    const replaceState = vi.fn();
    const win = { location: { href: 'http://localhost:5173/' }, history: { state: null, replaceState }, opener: {} as unknown };
    vi.stubGlobal('window', win);
    serve({ 'GET /api/session': () => json({ editor: true }) });
    await claimFromUrl();
    expect(win.opener).toBeNull();
    expect(useSession.getState().editor).toBe(true);
  });

  it('keeps where an agent-started server saved the link', async () => {
    at('http://localhost:5173/');
    serve({ 'GET /api/session': () => json({ editor: false, linkFile: '/home/u/.config/mge/editor-link' }) });
    await claimFromUrl();
    expect(useSession.getState()).toEqual(state({ editor: false, linkFile: '/home/u/.config/mge/editor-link' }));
  });

  it('without a token it asks, and leaves the address alone', async () => {
    const replaceState = at('http://localhost:5173/?project=p1');
    serve({ 'GET /api/session': () => json({ editor: false }) });
    await claimFromUrl();
    expect(replaceState).not.toHaveBeenCalled();
    expect(useSession.getState().editor).toBe(false);
  });
});

describe('a 401', () => {
  // Clock times after every unlock the tests above made on the real clock.
  const T = Date.now() + 1_000_000;

  it('from any route locks the tab and reads as the one unlock sentence', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    serve({ 'POST /api/session': () => claimed(), 'PUT /api/generation/settings': unauthorized });
    expect(await claim('tok')).toBeNull();
    expect(useSession.getState().editor).toBe(true);

    vi.setSystemTime(T + 1_000);
    const err = await api.saveGenerationSettings({}).catch((e: unknown) => e);
    expect(useSession.getState().editor).toBe(false);
    expect(errorText(err)).toEqual({ message: LOCKED_MESSAGE });
  });

  it('to a request sent before the tab unlocked proves nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T + 10_000);
    let answer!: (r: Response) => void;
    serve({ 'POST /api/session': () => claimed(), 'POST /api/chat/p1/messages': () => new Promise<Response>((r) => (answer = r)) });
    const early = api.sendChat('p1', { text: 'hi' }).catch(() => undefined);
    vi.setSystemTime(T + 11_000);
    await claim('tok');
    answer(unauthorized());
    await early;
    expect(useSession.getState().editor).toBe(true);
    // A later one does count.
    markLocked(T + 12_000);
    expect(useSession.getState().editor).toBe(false);
  });
});

describe('the unlock field', () => {
  it('a used or stale link answers with the server’s reason and where to find the newest one', async () => {
    serve({ 'POST /api/session': () => json({ error: { code: 'PROTOCOL', message: USED, hint: 'Use the newest editor link printed by npm run dev.' } }, 403) });
    expect(await claim(tokenFrom('http://localhost:5173/?session=stale'))).toBe(`${USED} Use the newest editor link printed by npm run dev.`);
    expect(useSession.getState().editor).toBeNull();
  });

  it('a minted link the unlocked tab refused, or with no unlocked tab to ask, says so', async () => {
    serve({ 'POST /api/session': () => json({ error: { code: 'PROTOCOL', message: 'The unlocked editor tab didn’t allow this.' } }, 403) });
    expect(await claim('minted')).toBe('The unlocked editor tab didn’t allow this.');
    serve({ 'POST /api/session': () => json({ error: { code: 'PROTOCOL', message: 'Open the editor link in the tab that’s already unlocked, or restart the server for a new link.' } }, 403) });
    expect(await claim('minted')).toBe('Open the editor link in the tab that’s already unlocked, or restart the server for a new link.');
  });

  it('an answer that is not an unlock reads as a used link', async () => {
    serve({ 'POST /api/session': () => json({ editor: false }) });
    expect(await claim('tok')).toBe(LINK_USED_MESSAGE);
  });
});

describe('a minted link’s claim', () => {
  const waiting = () => json({ pending: 'pnd_secret', code: 'K7Q-2MX' }, 202);
  const stillOpen = () => json({ pending: true }, 202);

  it('shows the pairing code, asks every second until the unlocked tab allows it, then unlocks', async () => {
    vi.useFakeTimers();
    const storage = memoryStorage();
    vi.stubGlobal('sessionStorage', storage);
    let polls = 0;
    const fetchMock = serve({
      'POST /api/session': waiting,
      'POST /api/session/pending': () => (++polls < 3 ? stillOpen() : claimed('sec_M')),
    });
    const result = claim('minted');
    await vi.advanceTimersByTimeAsync(0);
    expect(useSession.getState()).toEqual(state({ code: 'K7Q-2MX' }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ pending: 'pnd_secret' });
    expect(useSession.getState().code).toBe('K7Q-2MX');
    await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS * 2);
    expect(await result).toBeNull();
    expect(polls).toBe(3);
    expect(useSession.getState()).toEqual(state({ editor: true }));
    expect(tabSecret()).toBe('sec_M');
    // The pending id was only ever in memory and in the request bodies.
    expect([...storage.map.values()]).toEqual(['sec_M']);
  });

  it('a denied, timed-out or unknown claim answers 403 with the server’s reason, and the code goes', async () => {
    vi.useFakeTimers();
    serve({
      'POST /api/session': waiting,
      'POST /api/session/pending': () => json({ error: { code: 'PROTOCOL', message: 'The unlocked editor tab didn’t allow this.' } }, 403),
    });
    const result = claim('minted');
    await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS);
    expect(await result).toBe('The unlocked editor tab didn’t allow this.');
    expect(useSession.getState().code).toBeNull();
  });

  it('stops asking after CLAIM_TIMEOUT_MS: the unlocked tab didn’t answer', async () => {
    vi.useFakeTimers();
    let polls = 0;
    serve({
      'POST /api/session': waiting,
      'POST /api/session/pending': () => (polls++, stillOpen()),
    });
    const result = claim('minted');
    let settled = false;
    void result.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(CLAIM_TIMEOUT_MS - CLAIM_POLL_MS);
    expect(settled).toBe(false);
    expect(useSession.getState().code).toBe('K7Q-2MX');
    await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS);
    expect(await result).toBe(NO_ANSWER_MESSAGE);
    expect(NO_ANSWER_MESSAGE).toBe('The unlocked tab didn’t answer. Try the link again.');
    expect(polls).toBe(CLAIM_TIMEOUT_MS / CLAIM_POLL_MS);
    expect(useSession.getState().code).toBeNull();
  });

  it('a server that stops answering ends the wait', async () => {
    vi.useFakeTimers();
    serve({
      'POST /api/session': waiting,
      'POST /api/session/pending': () => Promise.reject(new TypeError('Failed to fetch')),
    });
    const result = claim('minted');
    await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS);
    expect(await result).toBe(SERVER_DOWN_MESSAGE);
    expect(useSession.getState().code).toBeNull();
  });

  it('the launch link answers at once: no code, no asking', async () => {
    vi.useFakeTimers();
    const fetchMock = serve({ 'POST /api/session': () => claimed() });
    const seen: (string | null)[] = [];
    const unsubscribe = useSession.subscribe((s) => seen.push(s.code));
    expect(await claim('launch')).toBeNull();
    unsubscribe();
    await vi.advanceTimersByTimeAsync(CLAIM_POLL_MS * 2);
    expect(seen.every((c) => c === null)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('openUnlockedTab', () => {
  it('opens the editor in a new tab with an opener (no noopener), so the browser copies this tab’s secret into it', () => {
    const open = vi.fn(() => ({}));
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173', href: 'http://localhost:5173/?project=p1' }, open });
    expect(openUnlockedTab()).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    // Exactly the URL and target: no window features, so no `noopener`.
    expect(open.mock.calls[0]).toEqual(['http://localhost:5173/', '_blank']);
  });

  it('reports a blocked tab', () => {
    vi.stubGlobal('window', { location: { origin: 'http://localhost:5173' }, open: vi.fn(() => null) });
    expect(openUnlockedTab()).toBe(false);
  });
});

/** A sessionStorage kept in a Map. */
function memoryStorage(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
}
const refuse = () => {
  throw new Error('The operation is insecure.');
};
const tabHeader = (init?: RequestInit) => (init?.headers as Record<string, string> | undefined)?.[EDITOR_TAB_HEADER];

describe("the tab's secret", () => {
  it('an unlock keeps it in sessionStorage, and later requests carry it beside their own headers', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('sessionStorage', storage);
    const fetchMock = serve({ 'POST /api/session': () => claimed('sec_A'), 'PUT /api/generation/settings': () => json({}) });
    expect(await claim('tok')).toBeNull();
    expect(tabSecret()).toBe('sec_A');
    expect(storage.map.get('mge.tab')).toBe('sec_A');
    await api.saveGenerationSettings({});
    expect(fetchMock.mock.calls[1][1]?.headers).toEqual({ 'Content-Type': 'application/json', [EDITOR_TAB_HEADER]: 'sec_A' });
  });

  it('a reload of the tab still has it; a new tab, or storage that refuses, starts without one', async () => {
    vi.resetModules();
    vi.stubGlobal('sessionStorage', memoryStorage({ 'mge.tab': 'sec_kept' }));
    expect((await import('./session')).tabSecret()).toBe('sec_kept');
    vi.resetModules();
    vi.stubGlobal('sessionStorage', memoryStorage());
    expect((await import('./session')).tabSecret()).toBeNull();
    vi.resetModules();
    vi.stubGlobal('sessionStorage', { getItem: refuse, setItem: refuse, removeItem: refuse });
    expect((await import('./session')).tabSecret()).toBeNull();
  });

  it('is dropped when the server says this tab is not the editor (it restarted)', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('sessionStorage', storage);
    const fetchMock = serve({ 'POST /api/session': () => claimed('sec_B'), 'GET /api/session': () => json({ editor: false }) });
    await claim('tok');
    expect(await refresh()).toBe(false);
    expect(tabHeader(fetchMock.mock.calls[1][1])).toBe('sec_B');
    expect(tabSecret()).toBeNull();
    expect(storage.map.has('mge.tab')).toBe(false);
    await refresh();
    expect(tabHeader(fetchMock.mock.calls[2][1])).toBeUndefined();
  });

  it('a used link drops it in a locked tab; at boot, a tab the server still knows keeps it', async () => {
    const storage = memoryStorage();
    vi.stubGlobal('sessionStorage', storage);
    serve({ 'POST /api/session': () => claimed('sec_C') });
    await claim('tok');

    useSession.setState(state({}));
    at('http://localhost:5173/?session=old');
    serve({ 'POST /api/session': used, 'GET /api/session': () => json({ editor: true }) });
    await claimFromUrl();
    expect(tabSecret()).toBe('sec_C');

    useSession.setState({ editor: false });
    serve({ 'POST /api/session': used });
    expect(await claim('old')).toBe(USED);
    expect(tabSecret()).toBeNull();
    expect(storage.map.has('mge.tab')).toBe(false);
  });

  it('storage that throws does not stop an unlock: memory holds the secret', async () => {
    vi.stubGlobal('sessionStorage', { getItem: refuse, setItem: refuse, removeItem: refuse });
    const fetchMock = serve({ 'POST /api/session': () => claimed('sec_D'), 'GET /api/session': () => json({ editor: true }) });
    expect(await claim('tok')).toBeNull();
    expect(useSession.getState()).toEqual(state({ editor: true }));
    expect(tabSecret()).toBe('sec_D');
    expect(await refresh()).toBe(true);
    expect(tabHeader(fetchMock.mock.calls[1][1])).toBe('sec_D');
  });
});

describe('whileUnlocked', () => {
  it('starts only once unlocked, stops on lock, starts again on the next unlock', () => {
    const stop = vi.fn();
    const start = vi.fn(() => stop);
    useSession.setState({ editor: false });
    const end = whileUnlocked(start);
    expect(start).not.toHaveBeenCalled();
    useSession.setState({ editor: null });
    expect(start).not.toHaveBeenCalled();
    useSession.setState({ editor: true });
    useSession.setState({ editor: true, error: null });
    expect(start).toHaveBeenCalledTimes(1);
    useSession.setState({ editor: false });
    expect(stop).toHaveBeenCalledTimes(1);
    useSession.setState({ editor: true });
    expect(start).toHaveBeenCalledTimes(2);
    end();
    expect(stop).toHaveBeenCalledTimes(2);
    useSession.setState({ editor: false });
    useSession.setState({ editor: true });
    expect(start).toHaveBeenCalledTimes(2);
  });
});
