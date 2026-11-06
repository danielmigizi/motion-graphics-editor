// Editor chat state: agent/model settings and message attribution; how the
// chat column folds the editor's own prompts and reports the agent's progress.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ChatState, ProviderInfo } from '../core/api-contract';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import { createDocState } from '../core/history';
import { buildScenesPrompt, buildSkeletonProject, directBuildPrompt, outlineRequestPrompt, type Outline, type VideoBrief } from '../core/outline';
import { currentStep, elapsedText } from './AgentStatus';
import { applyChatEvent, attributedMessages, cancelChat, followOpenProject, heldBanner, loadChat, loadProviders, modelLabel, onProjectOpened, openedByAgent, providerLabel, providerStatus, resetChat, sendChat, setChatSettings, startChatSync, useChat } from './chat';
import { ChatMessageRow, editorRequest } from './ChatPanel';
import { useProposals } from './proposals';
import { useEditor } from './store';

const realFetch = globalThis.fetch;

const PROVIDERS: ProviderInfo[] = [
  { id: 'claude', label: 'Claude Code', available: true, detail: '2.1.0', models: [{ id: '', label: 'Default' }, { id: 'opus', label: 'Opus' }] },
  { id: 'codex', label: 'Codex', available: false, detail: 'Not signed in. Run `codex login` in a terminal.', models: [] },
  { id: 'cursor', label: 'Cursor', available: false, detail: 'Cursor Agent is not installed (the `cursor-agent` command was not found).', models: [] },
];

const state = (over: Partial<ChatState> = {}): ChatState => ({ projectId: fixtureProject.id, provider: 'claude', model: '', busy: false, messages: [], ...over });

/** Answer fetches from a route table; records every request. */
function serve(routes: Record<string, (body: unknown) => [number, unknown]>) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, url: String(url), body });
    const route = routes[`${method} ${String(url)}`];
    const [status, out] = route ? route(body) : [404, 'Cannot POST'];
    return typeof out === 'string'
      ? new Response(out, { status, headers: { 'content-type': 'text/html' } })
      : new Response(JSON.stringify(out), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return calls;
}

const chatUrl = `/api/chat/${fixtureProject.id}`;

beforeEach(() => {
  useEditor.getState().loadDocument(createDocState(structuredClone(fixtureProject)), { kind: 'server', id: fixtureProject.id });
  useEditor.setState({ toasts: [] });
  useChat.setState({ projectId: null, messages: [], busy: false, providers: [], provider: 'claude', model: '', switching: false, loaded: false, confirmed: null, projectName: '', held: null });
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('agent and model settings', () => {
  it('takes the agent and model from the chat state, defaulting older servers to Claude Code', async () => {
    serve({ [`GET ${chatUrl}`]: () => [200, state({ provider: 'codex', model: 'gpt-5' })] });
    await loadChat();
    expect(useChat.getState()).toMatchObject({ provider: 'codex', model: 'gpt-5', loaded: true });

    const { provider: _p, model: _m, ...old } = state();
    serve({ [`GET ${chatUrl}`]: () => [200, old] });
    await loadChat();
    expect(useChat.getState()).toMatchObject({ provider: 'claude', model: '' });
  });

  it('switches through the settings route and applies the returned state', async () => {
    useChat.setState({ projectId: fixtureProject.id, providers: PROVIDERS });
    const calls = serve({ [`POST ${chatUrl}/settings`]: (b) => [200, state(b as Partial<ChatState>)] });
    expect(await setChatSettings('claude', 'opus')).toBe(true);
    expect(calls).toEqual([{ method: 'POST', url: `${chatUrl}/settings`, body: { provider: 'claude', model: 'opus' } }]);
    expect(useChat.getState()).toMatchObject({ provider: 'claude', model: 'opus', switching: false });

    // Picking what is already selected sends nothing.
    expect(await setChatSettings('claude', 'opus')).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('asks the server when the picker shows a choice the server has not confirmed', async () => {
    // e.g. the store was never loaded, or holds another project's answer.
    useChat.setState({ projectId: fixtureProject.id, providers: PROVIDERS, provider: 'claude', model: 'opus' });
    const calls = serve({ [`POST ${chatUrl}/settings`]: (b) => [200, state(b as Partial<ChatState>)] });
    expect(await setChatSettings('claude', 'opus')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await setChatSettings('claude', 'opus')).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('drops a New chat answer that arrives after another project opened', async () => {
    const other = { ...structuredClone(fixtureProject), id: 'prj_second' };
    const otherUrl = '/api/chat/prj_second';
    let releaseReset: (r: Response) => void = () => undefined;
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const key = `${init?.method ?? 'GET'} ${String(url)}`;
      calls.push(key);
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      if (key === `GET ${chatUrl}`) return json(state({ provider: 'claude', model: 'opus', messages: [{ id: 'm1', role: 'user', at: 0, status: 'done', text: 'hi' }] }));
      if (key === `POST ${chatUrl}/reset`) return new Promise<Response>((resolve) => (releaseReset = resolve));
      if (key === `GET ${otherUrl}`) return json(state({ projectId: 'prj_second', provider: 'codex', model: '', messages: [{ id: 'm2', role: 'user', at: 0, status: 'done', text: 'other' }] }));
      if (key === `POST ${otherUrl}/settings`) return json(state({ projectId: 'prj_second', ...(JSON.parse(String(init?.body)) as Partial<ChatState>) }));
      return new Response('Not found', { status: 404 });
    }) as typeof fetch;

    // Project A on Claude Code · Opus; New chat is pending when project B (Codex) opens.
    await loadChat();
    const reset = resetChat();
    useEditor.getState().loadDocument(createDocState(other), { kind: 'server', id: 'prj_second' });
    await loadChat('prj_second');
    releaseReset(new Response(JSON.stringify(state({ provider: 'claude', model: 'opus' })), { status: 200, headers: { 'content-type': 'application/json' } }));
    await reset;
    expect(useChat.getState()).toMatchObject({ projectId: 'prj_second', provider: 'codex', model: '', confirmed: 'prj_second' });
    expect(useChat.getState().messages.map((m) => m.id)).toEqual(['m2']);

    // Picking Claude Code · Opus on B really switches B.
    expect(await setChatSettings('claude', 'opus')).toBe(true);
    expect(calls).toContain(`POST ${otherUrl}/settings`);
    expect(useChat.getState()).toMatchObject({ provider: 'claude', model: 'opus' });
  });

  it('keeps the current choice and explains a refusal', async () => {
    useChat.setState({ projectId: fixtureProject.id, providers: PROVIDERS });
    serve({ [`POST ${chatUrl}/settings`]: () => [409, { error: { code: 'BUSY', message: 'Wait for the current turn to finish.' } }] });
    expect(await setChatSettings('claude', 'opus')).toBe(false);
    expect(useChat.getState()).toMatchObject({ provider: 'claude', model: '', switching: false });
    expect(useEditor.getState().toasts.at(-1)?.message).toBe('Could not switch to Claude Code · Opus: Wait for the current turn to finish.');
  });

  it('says so when the server has no settings route yet', async () => {
    useChat.setState({ projectId: fixtureProject.id, providers: PROVIDERS });
    serve({});
    expect(await setChatSettings('claude', 'opus')).toBe(false);
    expect(useEditor.getState().toasts.at(-1)?.message).toMatch(/can’t switch agents yet/);
  });

  it('sends the Auto-apply switch with each message', async () => {
    useChat.setState({ projectId: fixtureProject.id });
    const calls = serve({ [`POST ${chatUrl}/messages`]: (b) => [200, { id: 'u1', role: 'user', at: 0, status: 'queued', ...(b as object) }] });
    const was = useProposals.getState().autoApply;
    try {
      useProposals.setState({ autoApply: true });
      expect(await sendChat('Make it pop', [])).toBe(true);
      useProposals.setState({ autoApply: false });
      expect(await sendChat('Calmer', [])).toBe(true);
    } finally {
      useProposals.setState({ autoApply: was });
    }
    expect(calls.map((c) => (c.body as { autoApply?: unknown }).autoApply)).toEqual([true, false]);
  });

  it('keeps the last provider list when the server is unreachable', async () => {
    serve({ 'GET /api/chat/providers': () => [200, PROVIDERS] });
    await loadProviders();
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed');
    }) as typeof fetch;
    await loadProviders();
    expect(useChat.getState().providers.map((p) => p.id)).toEqual(['claude', 'codex', 'cursor']);
  });
});

describe('labels', () => {
  it('names agents and models, with fallbacks before the list loads', () => {
    expect(providerLabel(PROVIDERS, 'claude')).toBe('Claude Code');
    expect(providerLabel([], 'opencode')).toBe('OpenCode');
    expect(modelLabel(PROVIDERS, 'claude', 'opus')).toBe('Opus');
    expect(modelLabel(PROVIDERS, 'claude', '')).toBe('Default');
    expect(modelLabel(PROVIDERS, 'codex', 'gpt-5')).toBe('gpt-5');
    expect(modelLabel([], 'codex', undefined)).toBe('Default');
  });

  it('tells a missing agent from a signed-out one', () => {
    expect(PROVIDERS.map(providerStatus)).toEqual(['available', 'signed-out', 'missing']);
  });

  it('attributes an assistant message when its agent or model changes', () => {
    const a = (id: string, provider?: ChatMessage['provider'], model?: string): ChatMessage => ({ id, role: 'assistant', at: 0, status: 'done', provider, model });
    const u = (id: string): ChatMessage => ({ id, role: 'user', at: 0, status: 'done', text: 'hi' });
    const msgs = [u('u1'), a('a1', 'claude', ''), u('u2'), a('a2', 'claude', ''), a('a3', 'claude', 'opus'), u('u3'), a('a4', 'codex', ''), a('a5'), a('a6', 'codex')];
    expect([...attributedMessages(msgs)]).toEqual(['a1', 'a3', 'a4']);
  });
});

describe('a project opened mid-turn', () => {
  const otherUrl = '/api/chat/prj_second';
  const other = { ...structuredClone(fixtureProject), id: 'prj_second', name: 'Launch teaser' };
  const reply = (id: string, status: 'running' | 'done'): ChatMessage => ({ id, role: 'assistant', at: 1, status, parts: [{ type: 'text', text: status === 'done' ? 'Opened it and added the logo.' : 'Working…' }] });
  const openOther = () => useEditor.getState().loadDocument(createDocState(other), { kind: 'server', id: 'prj_second' });

  /** The chat on the fixture project ("Relay launch"), its turn running. */
  async function busyOnFirst() {
    const calls = serve({
      [`GET ${chatUrl}`]: () => [200, state({ busy: true, messages: [reply('a1', 'running')] })],
      [`GET ${otherUrl}`]: () => [200, state({ projectId: 'prj_second', messages: [] })],
      [`POST ${chatUrl}/messages`]: (body) => [200, { id: 'u2', role: 'user', at: 2, status: 'done', text: (body as { text: string }).text }],
      [`POST ${chatUrl}/cancel`]: () => [200, { ok: true }],
    });
    await loadChat();
    expect(useChat.getState()).toMatchObject({ projectId: fixtureProject.id, busy: true, projectName: fixtureProject.name });
    return calls;
  }

  it('stays on the busy conversation, keeps the reply, then follows on request', async () => {
    const calls = await busyOnFirst();
    const stop = startChatSync();
    try {
      await openedByAgent('Claude Code', async () => openOther());
      // Busy: the chat did not switch, and says why.
      expect(useChat.getState()).toMatchObject({ projectId: fixtureProject.id, held: { projectId: 'prj_second', name: 'Launch teaser', by: 'Claude Code' } });
      expect(calls.filter((c) => c.url === otherUrl)).toHaveLength(0);
      expect(heldBanner(useChat.getState())?.text).toBe(`Claude Code opened “Launch teaser” — this conversation stays with “${fixtureProject.name}” while the reply finishes.`);
      // The reply streams into the held conversation and the turn ends.
      applyChatEvent({ projectId: fixtureProject.id, busy: false, message: reply('a1', 'done') });
      expect(useChat.getState().messages).toEqual([reply('a1', 'done')]);
      expect(useChat.getState().projectId).toBe(fixtureProject.id);
      expect(heldBanner(useChat.getState())).toEqual({ text: `Claude Code opened “Launch teaser” — this conversation stays with “${fixtureProject.name}”.`, action: 'Show this project’s chat' });
      // Sending and stopping still talk to the conversation on screen.
      await sendChat('Thanks', []);
      await cancelChat();
      expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(expect.arrayContaining([`POST ${chatUrl}/messages`, `POST ${chatUrl}/cancel`]));
      // "Show this project's chat" follows the open project.
      followOpenProject();
      await vi.waitFor(() => expect(useChat.getState()).toMatchObject({ projectId: 'prj_second', held: null, loaded: true, projectName: 'Launch teaser' }));
    } finally {
      stop();
    }
  });

  it('follows the open project right away when idle', async () => {
    const calls = await busyOnFirst();
    applyChatEvent({ projectId: fixtureProject.id, busy: false, message: reply('a1', 'done') });
    onProjectOpened('prj_second', 'Launch teaser', 'Claude Code');
    expect(useChat.getState()).toMatchObject({ projectId: 'prj_second', held: null });
    await vi.waitFor(() => expect(calls.some((c) => c.url === otherUrl)).toBe(true));
    expect(heldBanner(useChat.getState())).toBeNull();
  });

  it('opening the conversation’s own project again clears the banner; another open updates it', async () => {
    await busyOnFirst();
    onProjectOpened('prj_second', 'Launch teaser');
    expect(heldBanner(useChat.getState())?.text).toMatch(/^The editor opened “Launch teaser”/);
    onProjectOpened('prj_third', 'Third');
    expect(useChat.getState().held).toEqual({ projectId: 'prj_third', name: 'Third' });
    onProjectOpened(fixtureProject.id, fixtureProject.name);
    expect(useChat.getState()).toMatchObject({ projectId: fixtureProject.id, held: null });
  });
});

describe('the chat column', () => {
  const brief: VideoBrief = {
    brief: 'A 30-second launch video for Scheduler,\nfor founders on LinkedIn',
    audience: '',
    tone: '',
    targetSeconds: 30,
    width: 1920,
    height: 1080,
    fps: 30,
    backgroundColor: '#F7F6F2',
    brandColors: [],
    files: [],
  };
  const outline: Outline = {
    title: 'Scheduler in 30 seconds',
    scenes: [
      { id: 'ol_1', name: 'Hook', purpose: 'Name the pain', durationSeconds: 4 },
      { id: 'ol_2', name: 'Calendar', purpose: 'Show the calendar', durationSeconds: 18 },
      { id: 'ol_3', name: 'Outro', purpose: 'Call to action', durationSeconds: 8 },
    ],
  };
  const row = (m: ChatMessage, latest = false) => renderToStaticMarkup(createElement(ChatMessageRow, { m, fps: 30, agent: 'Claude Code', by: 'Claude Code', latest }));

  it('never folds a person’s message that happens to start like one of the editor’s prompts', () => {
    expect(editorRequest('Build this video now with larger captions')).toBeNull();
    expect(editorRequest('Plan a new video from this brief: a 20-second teaser')).toBeNull();
    expect(editorRequest('Build this video now using `editor_write_project`, with larger captions')).toBeNull();
    expect(editorRequest('I approved the outline "Teaser". The editor filled the open project "Teaser" (prj_x) with 2 empty scenes at 1920×1080, 30 fps.')).toBeNull();
  });

  it('folds the editor’s own prompts into a labelled summary', () => {
    const words = 'A 30-second launch video for Scheduler,\nfor founders on LinkedIn';
    expect(editorRequest(outlineRequestPrompt(brief))).toEqual({ label: 'Brief', summary: words });
    expect(editorRequest(directBuildPrompt(brief))).toEqual({ label: 'Build request', summary: words });
    const project = buildSkeletonProject(outline, brief, { project: 'prj_new', scene: (i) => `scn_${i}`, audioClip: () => 'aud_bed' });
    expect(editorRequest(buildScenesPrompt(outline, brief, project))).toEqual({ label: 'Approved outline', summary: 'Scheduler in 30 seconds · 3 scenes' });
    expect(editorRequest(buildScenesPrompt(outline, brief, project, { created: true }))?.label).toBe('Approved outline');
  });

  it('leaves the user’s own words alone', () => {
    for (const text of ['Make the Calendar scene calmer', 'Build this headline bigger', 'Brief: shorter please', undefined, '']) expect(editorRequest(text)).toBeNull();
  });

  it('a folded prompt keeps its full text behind “Show full request”', () => {
    const html = row({ id: 'm1', role: 'user', at: 0, status: 'done', text: outlineRequestPrompt(brief) });
    expect(html).toContain('Brief');
    expect(html).toContain('Show full request');
    expect(html).not.toContain('Draft an OUTLINE only');
  });

  it('an agent reply carries the agent’s name; an earlier turn folds its tool steps', () => {
    const m: ChatMessage = { id: 'a1', role: 'assistant', at: 0, status: 'done', provider: 'claude', parts: [{ type: 'tool', name: 'editor_guide', label: 'Reading the editor guide' }, { type: 'text', text: 'Done.' }] };
    const earlier = row(m);
    expect(earlier).toContain('Claude Code');
    expect(earlier).toContain('1 step');
    expect(earlier).not.toContain('Reading the editor guide');
    expect(row(m, true)).not.toContain('1 step');
    // The latest turn with no words yet shows only in the status line.
    expect(row({ ...m, status: 'running', parts: [m.parts![0]] }, true)).toBe('');
  });

  it('the status line names the current step and the time spent', () => {
    expect(currentStep(undefined)).toBe('Thinking…');
    expect(currentStep({ id: 'a', role: 'assistant', at: 0, status: 'running', parts: [{ type: 'tool', name: 'editor_guide', label: 'Reading the editor guide' }] })).toBe('Reading the editor guide…');
    expect(currentStep({ id: 'a', role: 'assistant', at: 0, status: 'running', parts: [{ type: 'text', text: 'Here' }] })).toBe('Writing a reply…');
    expect(elapsedText(42_400)).toBe('0:42');
    expect(elapsedText(725_000)).toBe('12:05');
  });
});
