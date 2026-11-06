// Editor side of the agent bridge: commands run against the real store.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import { createDocState } from '../core/history';
import { PATCH_PROTOCOL, type AiPatch, type ProjectFile } from '../core/types';
import { editorContext, handleBridgeCommand, SILENT_STREAM_MS, startAgentBridge, useAgentLink } from './agentBridge';
import { api, ApiRequestError } from './api';
import { PASTED_BY, TAKE_BY, useProposals } from './proposals';
import { claim, useSession, whileUnlocked } from './session';
import { useEditor } from './store';

const realFetch = globalThis.fetch;

const patch = (over: Partial<AiPatch> = {}): AiPatch => ({
  protocol: PATCH_PROTOCOL,
  projectId: fixtureProject.id,
  baseRevision: useEditor.getState().doc.project.revision,
  summary: 'Bigger headline',
  targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }],
  commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 120 } } }],
  ...over,
});

const headline = () => useEditor.getState().doc.project.scenes[0].elements.find((e) => e.id === 'el_intro_headline')!;

beforeEach(() => {
  // No saved proposal for the open project (as the server answers: 404).
  vi.spyOn(api, 'getProposal').mockRejectedValue(new ApiRequestError('No proposal', undefined, undefined, 404));
  useEditor.getState().loadDocument(createDocState(structuredClone(fixtureProject)), { kind: 'server', id: fixtureProject.id });
  useProposals.setState({ proposal: null, check: null, open: false, log: [], returnTo: null, replaced: null, autoApply: false });
});

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  vi.useRealTimers();
});

describe('applyPatch with Auto-apply on', () => {
  beforeEach(() => useProposals.setState({ autoApply: true }));

  it('with Auto-apply on, still won\u2019t change the document over the person\u2019s pasted patch waiting for review', async () => {
    const pasted = useProposals.getState().propose(patch(), { agent: PASTED_BY, source: 'paste' });
    expect(pasted.ok).toBe(true);
    const before = useEditor.getState().doc;
    const r = await handleBridgeCommand({ type: 'applyPatch', patch: patch(), agent: 'Codex' });
    expect(r).toMatchObject({ ok: false, error: { code: 'PROPOSAL_PENDING' } });
    expect(useEditor.getState().doc).toBe(before);
    expect(useProposals.getState().proposal?.source).toBe('paste');
    useProposals.getState().cancel();
  });

  it('refuses the person\u2019s own labels from a bridge caller, and changes nothing', async () => {
    const before = useEditor.getState().doc;
    for (const agent of [PASTED_BY, TAKE_BY]) {
      const r = await handleBridgeCommand({ type: 'applyPatch', patch: patch(), agent, mode: 'propose' });
      expect(r).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    }
    expect(useEditor.getState().doc).toBe(before);
  });

  it('applies as one undoable AI step and clears the requests it answers', async () => {
    const st = useEditor.getState();
    st.selectElement('scn_intro', 'el_intro_headline');
    st.addRequest('Make it bigger');
    st.selectElement('scn_intro', 'el_intro_sub');
    st.addRequest('Untouched request');
    const before = st.doc.project.revision;

    const r = await handleBridgeCommand({ type: 'applyPatch', patch: patch() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.applied).toBe(true);
    expect(r.proposal).toBeUndefined();
    expect(r.revision).toBe(before + 1);
    expect(r.changes?.map((c) => c.path)).toContain('props.fontSize');
    expect(headline().props.fontSize).toBe(120);
    expect(useEditor.getState().requests.map((q) => q.instruction)).toEqual(['Untouched request']);
    expect(useEditor.getState().doc.revisions.at(-1)?.source).toBe('ai');

    useEditor.getState().undo();
    expect(headline().props.fontSize).toBe(104);
  });

  it('rejects stale, out-of-scope and locked patches without changing the document', async () => {
    const doc = useEditor.getState().doc;
    const stale = await handleBridgeCommand({ type: 'applyPatch', patch: patch({ baseRevision: doc.project.revision - 1 }) });
    expect(!stale.ok && stale.error.code).toBe('STALE');

    const scope = await handleBridgeCommand({ type: 'applyPatch', patch: patch({ targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_sub' }] }) });
    expect(!scope.ok && scope.error.code).toBe('OUT_OF_SCOPE');

    useEditor.getState().run({ type: 'setSceneLock', sceneId: 'scn_intro', locked: true });
    const locked = await handleBridgeCommand({ type: 'applyPatch', patch: patch() });
    expect(!locked.ok && locked.error.code).toBe('LOCKED');
    expect(headline().props.fontSize).toBe(104);
  });

  it('waits for a drag to finish before applying', async () => {
    const st = useEditor.getState();
    st.setTransient({ sceneId: 'scn_intro', element: headline() });
    const pending = handleBridgeCommand({ type: 'applyPatch', patch: patch() });
    await new Promise((r) => setTimeout(r, 20));
    expect(headline().props.fontSize).toBe(104);
    useEditor.getState().setTransient(null);
    expect((await pending).ok).toBe(true);
    expect(headline().props.fontSize).toBe(120);
  });

  it('waits for a timeline, curve or path gesture (previewed outside the stage) to finish, and that gesture is then stale', async () => {
    const g = useEditor.getState().beginGesture();
    const pending = handleBridgeCommand({ type: 'applyPatch', patch: patch() });
    await new Promise((r) => setTimeout(r, 20));
    expect(headline().props.fontSize).toBe(104);
    expect(g.stale()).toBe(false);
    g.end();
    expect((await pending).ok).toBe(true);
    expect(headline().props.fontSize).toBe(120);
    // A drag released after the patch would drop its commit instead of overwriting it.
    expect(g.stale()).toBe(true);
  });

  it('reports EDITOR_BUSY if the drag never ends', async () => {
    vi.useFakeTimers();
    useEditor.getState().setTransient({ sceneId: 'scn_intro', element: headline() });
    const pending = handleBridgeCommand({ type: 'applyPatch', patch: patch() });
    await vi.advanceTimersByTimeAsync(6000);
    const r = await pending;
    expect(!r.ok && r.error.code).toBe('EDITOR_BUSY');
  });
});

describe('applyPatch with Auto-apply off (the default)', () => {
  it('proposes instead of committing: the document, history and requests are untouched until Apply', async () => {
    const st = useEditor.getState();
    st.selectElement('scn_intro', 'el_intro_headline');
    st.addRequest('Make it bigger');
    const doc = useEditor.getState().doc;
    const r = await handleBridgeCommand({ type: 'applyPatch', patch: patch(), agent: 'Codex', model: 'gpt-5.5' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r).toMatchObject({ applied: false, revision: doc.project.revision, projectId: fixtureProject.id });
    expect(r.proposal).toMatchObject({ agent: 'Codex', model: 'gpt-5.5', source: 'mcp', status: 'pending', summary: 'Bigger headline', baseRevision: doc.project.revision });
    expect(r.changes?.map((c) => c.path)).toEqual(['props.fontSize']);
    expect(useEditor.getState().doc).toBe(doc);
    expect(useEditor.getState().requests).toHaveLength(1);
    // The review opens by itself, and the agent sees the pending proposal.
    expect(useProposals.getState().open).toBe(true);
    expect(editorContext()).toMatchObject({ autoApply: false, proposal: { id: r.proposal!.id, status: 'pending' }, proposalLog: [] });

    expect(useProposals.getState().apply().ok).toBe(true);
    expect(headline().props.fontSize).toBe(120);
    expect(useEditor.getState().doc.project.revision).toBe(doc.project.revision + 1);
    expect(useEditor.getState().doc.revisions.at(-1)).toMatchObject({ source: 'ai', label: 'Codex: Bigger headline' });
    expect(useEditor.getState().requests).toHaveLength(0);
    expect(editorContext()).toMatchObject({ proposal: null, proposalLog: [{ id: r.proposal!.id, status: 'applied', revision: doc.project.revision + 1 }] });
  });

  it("mode 'propose' proposes even with Auto-apply on", async () => {
    useProposals.setState({ autoApply: true });
    const doc = useEditor.getState().doc;
    const r = await handleBridgeCommand({ type: 'applyPatch', patch: patch(), mode: 'propose' });
    expect(r.ok && r.applied).toBe(false);
    expect(r.ok && r.proposal?.agent).toBe('Claude Code');
    expect(useEditor.getState().doc).toBe(doc);
  });

  it('rejects stale, out-of-scope and locked patches without creating a proposal', async () => {
    const doc = useEditor.getState().doc;
    const stale = await handleBridgeCommand({ type: 'applyPatch', patch: patch({ baseRevision: doc.project.revision - 1 }) });
    expect(!stale.ok && stale.error.code).toBe('STALE');
    const scope = await handleBridgeCommand({ type: 'applyPatch', patch: patch({ targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_sub' }] }) });
    expect(!scope.ok && scope.error.code).toBe('OUT_OF_SCOPE');
    useEditor.getState().run({ type: 'setSceneLock', sceneId: 'scn_intro', locked: true });
    const locked = await handleBridgeCommand({ type: 'applyPatch', patch: patch() });
    expect(!locked.ok && locked.error.code).toBe('LOCKED');
    expect(useProposals.getState()).toMatchObject({ proposal: null, open: false });
    expect(editorContext().proposal).toBeNull();
  });

  it('proposes instead of committing when Auto-apply is switched off while the patch waits for a drag', async () => {
    useProposals.setState({ autoApply: true });
    useEditor.getState().setTransient({ sceneId: 'scn_intro', element: headline() });
    const doc = useEditor.getState().doc;
    const pending = handleBridgeCommand({ type: 'applyPatch', patch: patch() });
    await new Promise((r) => setTimeout(r, 20));
    useProposals.setState({ autoApply: false });
    useEditor.getState().setTransient(null);
    const r = await pending;
    expect(r.ok && r.applied).toBe(false);
    expect(r.ok && r.proposal?.status).toBe('pending');
    expect(useEditor.getState().doc).toBe(doc);
    expect(headline().props.fontSize).toBe(104);
  });

  it('waits for a drag to finish before opening the review, and keeps it minimised if the drag never ends', async () => {
    vi.useFakeTimers();
    useEditor.getState().setTransient({ sceneId: 'scn_intro', element: headline() });
    const pending = handleBridgeCommand({ type: 'applyPatch', patch: patch() });
    await vi.advanceTimersByTimeAsync(6000);
    const r = await pending;
    expect(r.ok && r.proposal?.status).toBe('pending');
    expect(useProposals.getState().open).toBe(false);
  });
});

describe('applyPatch document session', () => {
  const reopen = () => useEditor.getState().loadDocument(createDocState(structuredClone(fixtureProject)), { kind: 'server', id: fixtureProject.id });

  for (const autoApply of [true, false]) {
    it(`rejects a patch for an earlier session of the same project at the same revision (Auto-apply ${autoApply ? 'on' : 'off'})`, async () => {
      useProposals.setState({ autoApply });
      const session = useEditor.getState().docSession;
      reopen();
      expect(useEditor.getState().docSession).not.toBe(session);
      const doc = useEditor.getState().doc;
      const r = await handleBridgeCommand({ type: 'applyPatch', patch: patch(), docSession: session });
      expect(!r.ok && r.error.code).toBe('STALE');
      expect(!r.ok && r.error.message).toMatch(/document session/i);
      expect(useEditor.getState().doc).toBe(doc);
      expect(useProposals.getState().proposal).toBeNull();
    });

    it(`rechecks the session after waiting for a drag (Auto-apply ${autoApply ? 'on' : 'off'})`, async () => {
      useProposals.setState({ autoApply });
      const session = useEditor.getState().docSession;
      useEditor.getState().setTransient({ sceneId: 'scn_intro', element: headline() });
      const pending = handleBridgeCommand({ type: 'applyPatch', patch: patch(), docSession: session });
      await new Promise((r) => setTimeout(r, 20));
      reopen();
      useEditor.getState().setTransient(null);
      const r = await pending;
      expect(!r.ok && r.error.code).toBe('STALE');
      expect(headline().props.fontSize).toBe(104);
      expect(useProposals.getState().proposal).toBeNull();
    });
  }

  it('accepts a patch for the current session', async () => {
    useProposals.setState({ autoApply: true });
    const r = await handleBridgeCommand({ type: 'applyPatch', patch: patch(), docSession: useEditor.getState().docSession });
    expect(r.ok && r.applied).toBe(true);
  });
});

describe('pointing at agent changes', () => {
  beforeEach(() => useProposals.setState({ autoApply: true }));

  it('selects the changed element and moves the playhead onto it when it is off screen', async () => {
    const st = useEditor.getState();
    st.seek(300); // Product scene: the headline is not on screen
    const toasts = st.toasts.length;
    const r = await handleBridgeCommand({ type: 'applyPatch', patch: patch() });
    expect(r.ok).toBe(true);
    const after = useEditor.getState();
    expect(after.selection).toEqual({ sceneId: 'scn_intro', elementId: 'el_intro_headline', elementIds: ['el_intro_headline'] });
    expect(after.playhead).toBe(20 + 15);
    // Agent changes show in the chat's agent status line, not as toasts.
    expect(after.toasts.length).toBe(toasts);
  });

  it('leaves the playhead alone when the element is already visible', async () => {
    const st = useEditor.getState();
    st.seek(100);
    await handleBridgeCommand({ type: 'applyPatch', patch: patch() });
    const after = useEditor.getState();
    expect(after.playhead).toBe(100);
    expect(after.selection.elementId).toBe('el_intro_headline');
  });
});

describe('openProject', () => {
  it('refuses to discard unsaved changes unless told to', async () => {
    useEditor.getState().run({ type: 'updateProject', changes: { name: 'Edited' } });
    expect(editorContext().dirty).toBe(true);
    const r = await handleBridgeCommand({ type: 'openProject', projectId: 'prj_other' });
    expect(!r.ok && r.error.code).toBe('UNSAVED_CHANGES');
    expect(useEditor.getState().doc.project.name).toBe('Edited');
  });

  it('keeps a History copy of the person\u2019s unsaved changes before an agent\u2019s discardUnsaved open', async () => {
    useEditor.getState().run({ type: 'updateProject', changes: { name: 'Edited' } });
    const other: ProjectFile = { format: 'mge.project/1', project: { ...structuredClone(fixtureProject), id: 'prj_other', name: 'Other', revision: 7 }, revisions: [], savedAt: new Date(0).toISOString() };
    const fetchMock = vi.fn(async (path: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === 'PUT' ? { ok: true, savedAt: new Date().toISOString() } : path.endsWith('/journal') ? [] : other), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await handleBridgeCommand({ type: 'openProject', projectId: 'prj_other', discardUnsaved: true });
    expect(r.ok).toBe(true);
    const calls = (fetchMock.mock.calls as unknown as [string, RequestInit | undefined][]).map(([path, init]) => [path, init?.method ?? 'GET']);
    expect(calls[0]).toEqual([`/api/projects/${fixtureProject.id}?autosave=1`, 'PUT']);
    expect(useEditor.getState().doc.project.name).toBe('Other');
  });

  it('doesn\u2019t discard anything when the History copy of the unsaved changes fails', async () => {
    useEditor.getState().run({ type: 'updateProject', changes: { name: 'Edited' } });
    globalThis.fetch = vi.fn(async (_path: string, init?: RequestInit) => init?.method === 'PUT'
      ? new Response(JSON.stringify({ error: { code: 'PROTOCOL', message: 'disk full' } }), { status: 400, headers: { 'content-type': 'application/json' } })
      : new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
    const r = await handleBridgeCommand({ type: 'openProject', projectId: 'prj_other', discardUnsaved: true });
    expect(r).toMatchObject({ ok: false, error: { code: 'SAVE_FAILED' } });
    expect(useEditor.getState().doc.project.name).toBe('Edited');
  });

  it('doesn\u2019t discard an edit the person makes while the History copy is being written', async () => {
    useEditor.getState().run({ type: 'updateProject', changes: { name: 'Edited' } });
    const other: ProjectFile = { format: 'mge.project/1', project: { ...structuredClone(fixtureProject), id: 'prj_other', name: 'Other', revision: 7 }, revisions: [], savedAt: new Date(0).toISOString() };
    globalThis.fetch = vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'PUT') useEditor.getState().run({ type: 'updateProject', changes: { name: 'Typed during the copy' } });
      return new Response(JSON.stringify(init?.method === 'PUT' ? { ok: true, savedAt: new Date().toISOString() } : path.endsWith('/journal') ? [] : other), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const r = await handleBridgeCommand({ type: 'openProject', projectId: 'prj_other', discardUnsaved: true });
    expect(r.ok).toBe(false);
    expect(useEditor.getState().doc.project.name).toBe('Typed during the copy');
  });

  it('doesn\u2019t switch projects over an edit the person makes while the project loads', async () => {
    const other: ProjectFile = { format: 'mge.project/1', project: { ...structuredClone(fixtureProject), id: 'prj_other', name: 'Other', revision: 7 }, revisions: [], savedAt: new Date(0).toISOString() };
    globalThis.fetch = vi.fn(async (path: string) => {
      if (!path.endsWith('/journal')) useEditor.getState().run({ type: 'updateProject', changes: { name: 'Typed meanwhile' } });
      return new Response(JSON.stringify(path.endsWith('/journal') ? [] : other), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    const r = await handleBridgeCommand({ type: 'openProject', projectId: 'prj_other' });
    expect(r.ok).toBe(false);
    expect(useEditor.getState().doc.project.name).toBe('Typed meanwhile');
  });

  it('opens a saved project', async () => {
    const other: ProjectFile = { format: 'mge.project/1', project: { ...structuredClone(fixtureProject), id: 'prj_other', name: 'Other', revision: 7 }, revisions: [], savedAt: new Date(0).toISOString() };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(other), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
    const r = await handleBridgeCommand({ type: 'openProject', projectId: 'prj_other' });
    expect(r.ok && r.projectId).toBe('prj_other');
    expect(useEditor.getState().doc.project.name).toBe('Other');
    expect(editorContext()).toMatchObject({ projectId: 'prj_other', revision: 7, dirty: false, origin: 'server' });
  });
});

describe('save', () => {
  const saveAndPaths = async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true, savedAt: new Date().toISOString() }), { status: 200, headers: { 'content-type': 'application/json' } }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const r = await handleBridgeCommand({ type: 'save' });
    expect(r.ok).toBe(true);
    return (fetchMock.mock.calls as unknown as [string, RequestInit][]).map(([path, init]) => [path, init.method]);
  };

  it('saves only an agent\u2019s changes as the agent\u2019s (?by=agent), not an autosave', async () => {
    const st = useEditor.getState();
    const next = structuredClone(st.doc);
    next.project.name = 'Renamed by the agent';
    st.replaceDoc(next, { byAgent: true });
    expect(await saveAndPaths()).toEqual([[`/api/projects/${fixtureProject.id}?by=agent`, 'PUT']]);
    expect(editorContext().dirty).toBe(false);
  });

  it('saves the person\u2019s unsaved edit as theirs even when an agent asked for the save', async () => {
    useEditor.getState().run({ type: 'updateProject', changes: { name: 'Edited' } });
    expect(await saveAndPaths()).toEqual([[`/api/projects/${fixtureProject.id}`, 'PUT']]);
    expect(editorContext().dirty).toBe(false);
  });
});

describe('focus', () => {
  it('selects an element in another scene and moves the playhead into it', async () => {
    const target = useEditor.getState().doc.project.scenes[1].elements[0].id;
    const r = await handleBridgeCommand({ type: 'focus', elementId: target });
    expect(r.ok).toBe(true);
    const st = useEditor.getState();
    expect(st.selection.sceneId).toBe('scn_product');
    expect(st.selection.elementId).toBe(target);
    expect(st.playhead).toBeGreaterThanOrEqual(210);
  });

  it('rejects a frame outside the requested scene and unknown ids', async () => {
    const outside = await handleBridgeCommand({ type: 'focus', sceneId: 'scn_outro', frame: 0 });
    expect(!outside.ok && outside.error.code).toBe('INVALID');
    const missing = await handleBridgeCommand({ type: 'focus', elementId: 'el_nope' });
    expect(!missing.ok && missing.error.code).toBe('NOT_FOUND');
  });
});

/** An event stream the test drives: it emits named events and records whether it was closed. */
class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static made: FakeEventSource[] = [];
  readyState = FakeEventSource.OPEN;
  onerror: (() => void) | null = null;
  onmessage: ((e: MessageEvent) => void) | null = null;
  private listeners = new Map<string, ((e: MessageEvent) => void)[]>();
  constructor(readonly url: string) {
    FakeEventSource.made.push(this);
  }
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(type: string, data: unknown = {}) {
    for (const fn of this.listeners.get(type) ?? []) fn({ data: JSON.stringify(data) } as MessageEvent);
  }
}

describe('the event stream watchdog', () => {
  let stop: () => void = () => undefined;
  const down = async (_url: RequestInfo | URL, _init?: RequestInit) => new Response('null', { status: 503 });
  const fetchMock = vi.fn(down);
  beforeEach(() => {
    vi.useFakeTimers();
    FakeEventSource.made = [];
    vi.stubGlobal('EventSource', FakeEventSource);
    fetchMock.mockReset();
    fetchMock.mockImplementation(down);
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => {
    stop();
    vi.unstubAllGlobals();
  });

  const latest = () => FakeEventSource.made.at(-1)!;
  const jobSyncs = () => fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/generation/jobs?')).length;

  it('reconnects after 40 s without any event, then reports state and re-syncs jobs on the new hello', async () => {
    stop = startAgentBridge();
    expect(FakeEventSource.made).toHaveLength(1);
    latest().emit('hello', { clientId: 'c1' });
    expect(useAgentLink.getState().status).toBe('connected');
    const syncsBefore = jobSyncs();

    // Pings (every 15 s from the server) keep it; so does any other event.
    await vi.advanceTimersByTimeAsync(SILENT_STREAM_MS - 1_000);
    latest().emit('ping');
    await vi.advanceTimersByTimeAsync(SILENT_STREAM_MS - 1_000);
    latest().emit('activity', { agent: 'Claude Code', label: 'Reading the project' });
    await vi.advanceTimersByTimeAsync(SILENT_STREAM_MS - 1_000);
    expect(FakeEventSource.made).toHaveLength(1);

    // The server restarted and the stream hangs silent: closed and replaced.
    const dead = latest();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(dead.readyState).toBe(FakeEventSource.CLOSED);
    expect(FakeEventSource.made).toHaveLength(2);
    expect(useAgentLink.getState().status).toBe('connecting');
    // A late error from the dead stream changes nothing.
    dead.onerror?.();
    expect(useAgentLink.getState().status).toBe('connecting');

    latest().emit('hello', { clientId: 'c2' });
    await vi.advanceTimersByTimeAsync(0);
    expect(useAgentLink.getState().status).toBe('connected');
    expect(jobSyncs()).toBe(syncsBefore + 1);
    expect(fetchMock.mock.calls.some(([url, init]) => url === '/api/editor/state' && String(init?.body).includes('"clientId":"c2"'))).toBe(true);
  });

  it('runs only while the tab is unlocked; a failing stream checks the session once and a lock stops it', async () => {
    const sessionChecks = () => fetchMock.mock.calls.filter(([url, init]) => url === '/api/session' && !init?.method).length;
    fetchMock.mockImplementation(async (url) =>
      String(url) === '/api/session' ? new Response(JSON.stringify({ editor: false }), { headers: { 'content-type': 'application/json' } }) : new Response('null', { status: 503 }),
    );
    useSession.setState({ editor: false, error: null });
    stop = whileUnlocked(startAgentBridge);
    expect(FakeEventSource.made).toHaveLength(0);

    useSession.setState({ editor: true });
    expect(FakeEventSource.made).toHaveLength(1);
    latest().emit('hello', { clientId: 'c1' });

    // The server restarted: the stream errors, again and again (401s), and the session is asked once.
    latest().onerror?.();
    latest().onerror?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(sessionChecks()).toBe(1);
    expect(useSession.getState().editor).toBe(false);
    expect(latest().readyState).toBe(FakeEventSource.CLOSED);
    await vi.advanceTimersByTimeAsync(SILENT_STREAM_MS * 2);
    expect(FakeEventSource.made).toHaveLength(1);
  });

  it("carries this tab's secret: in the stream's URL, and as the header on what it posts", async () => {
    fetchMock.mockImplementation(async (url) =>
      String(url) === '/api/session' ? new Response(JSON.stringify({ editor: true, tabSecret: 'tab/1+x' }), { headers: { 'content-type': 'application/json' } }) : new Response('null', { status: 503 }),
    );
    expect(await claim('tok')).toBeNull();
    stop = startAgentBridge();
    expect(latest().url).toBe('/api/editor/events?tab=tab%2F1%2Bx');
    latest().emit('hello', { clientId: 'c1' });
    await vi.advanceTimersByTimeAsync(0);
    const state = fetchMock.mock.calls.find(([url]) => url === '/api/editor/state');
    expect(state?.[1]?.headers).toEqual({ 'Content-Type': 'application/json', 'X-MGE-Tab': 'tab/1+x' });
  });

  it('a stream that never says hello is replaced too; stopping ends the watch', async () => {
    stop = startAgentBridge();
    await vi.advanceTimersByTimeAsync(SILENT_STREAM_MS);
    expect(FakeEventSource.made).toHaveLength(2);
    stop();
    await vi.advanceTimersByTimeAsync(SILENT_STREAM_MS * 3);
    expect(FakeEventSource.made).toHaveLength(2);
    expect(latest().readyState).toBe(FakeEventSource.CLOSED);
  });
});
