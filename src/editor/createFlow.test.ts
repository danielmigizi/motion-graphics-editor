// New video in the editor: the brief sent from the chat, the outline as a
// bridge command, and approval filling the open blank project (or creating a
// new one beside open work) and handing it to the agent. The local server is
// a fetch stub; no agent runs.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import type { ChatAttachment, ChatMessage, ChatState, OutlineDraft } from '../core/api-contract';
import { createDocState } from '../core/history';
import { blankProject } from '../core/newProject';
import { updateOutlineScene } from '../core/outline';
import { editorContext, handleBridgeCommand } from './agentBridge';
import { clearAutosave, readAutosave } from './doc';
import { useChat } from './chat';
import { approveOutline, briefRoles, chooseMusic, declineOutline, draftOutline, editOutline, freshBrief, openNewVideo, removeMusicFile, requestComposerFocus, setMusic, useCreate } from './createFlow';
import { useLayout } from './layout';
import { useProposals } from './proposals';
import { useEditor } from './store';

const realFetch = globalThis.fetch;

// Browser recovery writes need storage (as in persistence.test.ts).
const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  },
});

const draft: OutlineDraft = {
  title: 'Relay in 30 seconds',
  scenes: [
    { name: 'Hook', purpose: 'Name the pain', durationSeconds: 4 },
    { name: 'Product', purpose: 'Show the brief', durationSeconds: 18, templateHints: ['featureCallout'] },
    { name: 'Outro', purpose: 'Call to action', durationSeconds: 8 },
  ],
};

const logo: ChatAttachment = { kind: 'svg', name: 'relay.svg', src: 'assets/uploads/u_1.svg', mimeType: 'image/svg+xml' };
const shot: ChatAttachment = { kind: 'image', name: 'screen.png', src: 'assets/uploads/u_2.png', mimeType: 'image/png', width: 1600, height: 1000 };
/** A distinct track per test: beats are cached per file. */
const track = (n: string): ChatAttachment => ({ kind: 'audio', name: `${n}.wav`, src: `assets/uploads/u_${n}.wav`, mimeType: 'audio/wav', durationSeconds: 40 });

interface Call {
  method: string;
  path: string;
  body: unknown;
}
let calls: Call[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const chatState = (projectId: string): ChatState => ({ projectId, provider: 'claude', model: '', busy: false, messages: [] });
const messages = () => calls.filter((c) => c.path.endsWith('/messages'));
const textOf = (c: Call) => (c.body as { text: string }).text;

const BLANK = 'prj_blank';
function openBlankProject() {
  useEditor.getState().loadDocument(createDocState(blankProject({ project: BLANK, scene: 'scn_blank' })), { kind: 'new' });
  useChat.setState({ projectId: BLANK, confirmed: BLANK, messages: [] });
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ method, path, body });
    if (method === 'PUT' && path.startsWith('/api/projects/')) return json({ ok: true, savedAt: '2026-10-13T12:00:00.000Z' });
    // A 120 BPM track: downbeats every 60 frames from frame 8.
    if (path.startsWith('/api/assets/beats?')) return json({ src: 'assets/uploads/u_song.wav', durationSeconds: 40, fps: 30, durationInFrames: 1200, bpm: 120, confidence: 0.6, beats: [8, 23, 38, 53, 68], downbeats: [8, 68, 128, 188, 248, 308, 368, 428], strong: [8], onsets: [8, 23] });
    const chat = /^\/api\/chat\/([^/]+)(\/\w+)?$/.exec(path);
    if (chat && chat[2] === '/messages') {
      const message: ChatMessage = { id: `m${calls.length}`, role: 'user', at: 1, status: 'queued', text: (body as { text: string }).text };
      return json(message);
    }
    if (chat) return json(chatState(chat[1]));
    return json({ error: { code: 'NOT_FOUND', message: `no stub for ${method} ${path}` } }, 404);
  }) as typeof fetch;
  useEditor.getState().loadDocument(createDocState(structuredClone(fixtureProject)), { kind: 'server', id: fixtureProject.id });
  useEditor.setState({ toasts: [] });
  useChat.setState({ projectId: fixtureProject.id, messages: [], busy: false, provider: 'claude', model: '', confirmed: fixtureProject.id, providers: [] });
  useCreate.setState({ dialog: null, step: 'idle', brief: { ...freshBrief(), brief: 'Launch video for Relay', targetSeconds: 30 }, outlineFirst: true, request: null, noOutline: false, outline: null, status: null, agent: null, targetSeconds: 30, projectId: null, approving: false });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  clearAutosave();
  useProposals.getState().setAutoApply(false);
});

describe('new video', () => {
  it('opens chat before notifying composer-focus subscribers', () => {
    useLayout.getState().setChatOpen(false);
    const before = useCreate.getState().composerFocus;
    const seen: boolean[] = [];
    const unsubscribe = useCreate.subscribe((s, prev) => {
      if (s.composerFocus !== prev.composerFocus) seen.push(useLayout.getState().chatOpen);
    });
    try {
      requestComposerFocus();
      expect(useCreate.getState().composerFocus).toBe(before + 1);
      expect(seen).toEqual([true]);
    } finally {
      unsubscribe();
    }
  });

  it('opens a blank project in the current format and focuses the composer', async () => {
    useLayout.getState().setChatOpen(false);
    const focus = useCreate.getState().composerFocus;
    await openNewVideo();
    const st = useEditor.getState();
    expect(st.doc.project.id).not.toBe(fixtureProject.id);
    expect(st.doc.project).toMatchObject({ width: fixtureProject.width, height: fixtureProject.height, fps: fixtureProject.fps, scenes: [{ elements: [] }] });
    expect(st.origin).toEqual({ kind: 'new' });
    expect(useCreate.getState()).toMatchObject({ dialog: null, composerFocus: focus + 1, brief: { brief: '', targetSeconds: 30 } });
    expect(useLayout.getState().chatOpen).toBe(true);
    // The new video has its own conversation.
    expect(useChat.getState().projectId).toBe(st.doc.project.id);
    expect(calls.some((c) => c.method === 'GET' && c.path === `/api/chat/${st.doc.project.id}`)).toBe(true);
  });

  it('saves the outgoing project’s latest edits first, drops its pending outline, and follows the new chat even mid-turn', async () => {
    // Project A: edited (its autosave has not fired), its agent mid-answer, an outline pending for it.
    expect(useEditor.getState().run({ type: 'updateProject', changes: { name: 'A, edited' } })).toBe(true);
    await handleBridgeCommand({ type: 'proposeOutline', outline: draft, agent: 'Claude Code' });
    useChat.setState({ busy: true });
    expect(useCreate.getState().status).toBe('pending');

    await openNewVideo();
    const st = useEditor.getState();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe(`/api/projects/${fixtureProject.id}?autosave=1`);
    expect((put?.body as { project: { name: string } }).project.name).toBe('A, edited');
    expect(st.origin).toEqual({ kind: 'new' });
    expect(useCreate.getState()).toMatchObject({ outline: null, status: null, step: 'idle', request: null });
    expect(editorContext().outline ?? null).toBeNull();
    expect(useChat.getState()).toMatchObject({ projectId: st.doc.project.id, held: null });
  });

  it('keeps the outgoing project open when its edits cannot be saved', async () => {
    expect(useEditor.getState().run({ type: 'updateProject', changes: { name: 'A, edited' } })).toBe(true);
    const stub = globalThis.fetch;
    let puts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return stub(input, init);
      puts++;
      return json({ error: { code: 'DISK', message: 'Disk full' } }, 500);
    }) as typeof fetch;
    expect(await openNewVideo()).toBe(false);
    const st = useEditor.getState();
    expect(st.doc.project).toMatchObject({ id: fixtureProject.id, name: 'A, edited' });
    expect(puts).toBe(2);
    expect(st.toasts.at(-1)).toMatchObject({ tone: 'error', message: '“A, edited” could not be saved, so it stays open.' });
  });

  it('does nothing when the user opened another project while the outgoing save was running', async () => {
    expect(useEditor.getState().run({ type: 'updateProject', changes: { name: 'A, edited' } })).toBe(true);
    const stub = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') await gate;
      return stub(input, init);
    }) as typeof fetch;
    const opening = openNewVideo();
    const other = { ...structuredClone(fixtureProject), id: 'prj_c', name: 'C, opened meanwhile' };
    useEditor.getState().loadDocument(createDocState(other), { kind: 'server', id: 'prj_c' });
    release();
    expect(await opening).toBe(false);
    expect(useEditor.getState().doc.project).toMatchObject({ id: 'prj_c', name: 'C, opened meanwhile' });
  });

  it('does nothing when another project was opened in the same tick, even with nothing to save', async () => {
    // The open project is clean; a queued change (an agent opening a project) lands while New video yields.
    const other = { ...structuredClone(fixtureProject), id: 'prj_c', name: 'C, opened meanwhile' };
    queueMicrotask(() => useEditor.getState().loadDocument(createDocState(other), { kind: 'server', id: 'prj_c' }));
    expect(await openNewVideo()).toBe(false);
    expect(useEditor.getState().doc.project).toMatchObject({ id: 'prj_c', name: 'C, opened meanwhile' });
  });

  it('a brief whose project changed while its track was analysed goes nowhere', async () => {
    openBlankProject();
    const stub = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('/api/assets/beats?')) await gate;
      return stub(input, init);
    }) as typeof fetch;
    const sending = draftOutline({ text: 'Launch video for Relay', attachments: [track('late')], outlineFirst: true });
    useEditor.getState().loadDocument(createDocState(structuredClone(fixtureProject)), { kind: 'server', id: fixtureProject.id });
    release();
    expect(await sending).toBe(false);
    expect(messages()).toEqual([]);
    expect(useCreate.getState().step).toBe('idle');
  });

  it('tags the logo and the music bed among a brief’s attachments', () => {
    expect(briefRoles([shot, logo, track('a'), track('b')])).toEqual({ logo: 1, music: 2 });
    expect(briefRoles([shot])).toEqual({ logo: 0 });
    expect(briefRoles([])).toEqual({});
  });
});

describe('the brief, sent from the chat', () => {
  it('asks for an outline with the attachments: the image is the logo, the audio the music bed with its beats', async () => {
    openBlankProject();
    useCreate.setState({ brief: { ...freshBrief(), targetSeconds: 45 } });
    expect(await draftOutline({ text: '  Launch video for Relay  ', attachments: [shot, logo, track('song')], outlineFirst: true })).toBe(true);

    expect(calls.some((c) => c.path === '/api/assets/beats?src=assets%2Fuploads%2Fu_song.wav&fps=30')).toBe(true);
    const { brief } = useCreate.getState();
    expect(brief).toMatchObject({ brief: 'Launch video for Relay', targetSeconds: 45, width: 1920, height: 1080, fps: 30, provider: 'claude' });
    expect(brief.files.find((f) => f.id === brief.logoId)?.name).toBe('relay.svg');
    expect(brief.files.find((f) => f.id === brief.music?.fileId)?.name).toBe('song.wav');
    expect(brief.music?.tempo).toMatchObject({ bpm: 120, downbeatSeconds: [0.267, 2.267, 4.267, 6.267, 8.267, 10.267, 12.267, 14.267] });

    const sent = messages();
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe(`/api/chat/${BLANK}/messages`);
    const text = textOf(sent[0]);
    expect(text).toMatch(/^Plan a new video from this brief\. Draft an OUTLINE only/);
    expect(text).toContain('The open project is a blank one made for this video');
    expect(text).toContain('Brief: Launch video for Relay');
    expect(text).toContain('Target length: 45 s');
    expect(text).toContain('Logo: "relay.svg" (svg)');
    expect(text).toContain('Music: "song.wav" (40 s, ~120 BPM, a bar every 2 s)');
    expect(text).toContain('Call the `editor_propose_outline` tool once');
    expect((sent[0].body as { attachments: unknown[] }).attachments).toEqual([shot, logo, track('song')]);
    expect(useCreate.getState()).toMatchObject({ step: 'drafting', request: text, noOutline: false });

    // A turn that ends without an outline is noticed.
    useChat.setState({ busy: true, messages: [{ id: 'u', role: 'user', at: 1, status: 'done', text }, { id: 'a', role: 'assistant', at: 2, status: 'running', parts: [] }] });
    expect(useCreate.getState().noOutline).toBe(false);
    useChat.setState({ busy: false, messages: [{ id: 'u', role: 'user', at: 1, status: 'done', text }, { id: 'a', role: 'assistant', at: 2, status: 'done', parts: [{ type: 'text', text: 'Which product?' }] }] });
    expect(useCreate.getState().noOutline).toBe(true);
  });

  it('with "Outline first" off, asks the agent to build straight away and waits for no outline', async () => {
    openBlankProject();
    expect(await draftOutline({ text: 'An animated chart of Q3 growth', attachments: [], outlineFirst: false })).toBe(true);
    const text = textOf(messages()[0]);
    expect(text).toMatch(/^Brief: An animated chart of Q3 growth/);
    expect(text).toContain('Build this video now in the open project, which is blank and made for it (keep its id).');
    expect(text).not.toContain('editor_propose_outline');
    expect(useCreate.getState()).toMatchObject({ step: 'idle', request: null, noOutline: false });
  });

  it('sends nothing without words', async () => {
    openBlankProject();
    expect(await draftOutline({ text: '   ', attachments: [logo], outlineFirst: true })).toBe(false);
    expect(messages()).toEqual([]);
  });
});

describe('the outline', () => {
  it('a proposed outline is pending, shown in the chat, and reported to agents', async () => {
    useCreate.setState({ step: 'drafting', request: 'x' });
    const reply = await handleBridgeCommand({ type: 'proposeOutline', outline: draft, agent: 'Codex' });
    expect(reply).toMatchObject({ ok: true, projectId: fixtureProject.id, message: `Outline "Relay in 30 seconds" (3 scenes, 30 s) is awaiting the user's review.` });
    expect(useCreate.getState()).toMatchObject({ dialog: null, step: 'review', status: 'pending', agent: 'Codex' });
    expect(editorContext().outline).toMatchObject({ status: 'pending', title: 'Relay in 30 seconds', agent: 'Codex', targetSeconds: 30, scenes: [{ id: 'ol_1', name: 'Hook' }, { id: 'ol_2' }, { id: 'ol_3' }] });
    expect(useEditor.getState().doc.project.id).toBe(fixtureProject.id); // nothing changed yet

    const bad = await handleBridgeCommand({ type: 'proposeOutline', outline: { title: '', scenes: [] } });
    expect(bad).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    expect(useCreate.getState().outline?.title).toBe('Relay in 30 seconds');
  });

  it('approval fills the open blank project in place, saves it, and asks the agent to build it in the same chat', async () => {
    openBlankProject();
    await draftOutline({ text: 'Launch video for Relay', attachments: [logo, track('bed')], outlineFirst: true });
    await handleBridgeCommand({ type: 'proposeOutline', outline: draft, agent: 'Claude Code' });
    editOutline((o) => updateOutlineScene({ ...o, title: 'Relay launch' }, 'ol_2', { durationSeconds: 16, notes: 'Use the screenshot' }));
    expect(await approveOutline()).toBe(true);

    const st = useEditor.getState();
    const project = st.doc.project;
    expect(project.id).toBe(BLANK);
    expect(project).toMatchObject({ name: 'Relay launch', width: 1920, height: 1080, fps: 30, revision: 2 });
    expect(project.scenes.map((s) => [s.name, s.durationInFrames, s.elements.length])).toEqual([['Hook', 120, 0], ['Product', 480, 0], ['Outro', 240, 0]]);
    expect(project.scenes.map((s) => s.id)).not.toContain('scn_blank');
    expect(Object.values(project.assets).map((a) => a.name).sort()).toEqual(['Logo (relay.svg)', 'bed.wav']);
    expect(project.audio).toEqual([expect.objectContaining({ name: 'Music bed', startFrame: 0, assetId: Object.values(project.assets).find((a) => a.kind === 'audio')!.id })]);
    expect(st.origin).toEqual({ kind: 'server', id: BLANK });
    expect(st.cleanRevision).toBe(2);

    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe(`/api/projects/${BLANK}`);
    const handover = messages().slice(1);
    expect(handover).toHaveLength(1);
    expect(handover[0].path).toBe(`/api/chat/${BLANK}/messages`);
    const text = textOf(handover[0]);
    expect(text).toMatch(new RegExp(`^I approved the outline "Relay launch"\\. The editor filled the open project "Relay launch" \\(${BLANK}\\) with 3 empty scenes at 1920×1080, 30 fps\\.`));
    expect(text).toContain(`"Product" — scene ${project.scenes[1].id}, 16 s (480 frames)`);
    expect(text).toContain('My notes: Use the screenshot');
    expect(text).toContain('A music bed already plays');
    // The same conversation: no other chat was loaded and no settings changed.
    expect(calls.filter((c) => c.path.endsWith('/settings') || (c.method === 'GET' && c.path.startsWith('/api/chat/')))).toEqual([]);

    expect(editorContext().outline).toMatchObject({ status: 'approved', projectId: BLANK, title: 'Relay launch' });
    expect(useCreate.getState()).toMatchObject({ dialog: null, step: 'idle', brief: { brief: '' } });
    expect(st.toasts.at(-1)).toMatchObject({ tone: 'success', message: expect.stringContaining('“Relay launch” has 3 scenes') });
  });

  it('with Auto-apply on, approval asks the agent to build every scene straight through instead of proposing each', async () => {
    openBlankProject();
    useProposals.getState().setAutoApply(true);
    await draftOutline({ text: 'Launch video for Relay', attachments: [], outlineFirst: true });
    await handleBridgeCommand({ type: 'proposeOutline', outline: draft, agent: 'Claude Code' });
    expect(await approveOutline()).toBe(true);

    const handover = messages().slice(1);
    expect(handover).toHaveLength(1);
    const text = textOf(handover[0]);
    expect(text).toMatch(/^I approved the outline "Relay in 30 seconds"\./);
    expect(text).toContain('Auto-apply is on: build every scene now, without stopping for review. Use `editor_apply_patch` per scene');
    expect(text).not.toContain('Propose one scene at a time');
    // The message runs in the agent's auto mode too, as any message sent with the switch on.
    expect((handover[0].body as { autoApply?: boolean }).autoApply).toBe(true);
    expect(useEditor.getState().toasts.at(-1)).toMatchObject({ tone: 'success', message: expect.stringContaining('is building all of it'), hint: expect.stringContaining('land as they are built') });
  });

  it('a filled project whose save failed stays dirty and recoverable, and the agent is still asked to build it', async () => {
    openBlankProject();
    const stub = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'PUT' ? json({ error: { code: 'DISK', message: 'Disk full' } }, 500) : stub(input, init))) as typeof fetch;
    await handleBridgeCommand({ type: 'proposeOutline', outline: draft, agent: 'Claude Code' });
    expect(await approveOutline()).toBe(true);
    const st = useEditor.getState();
    expect(st.doc.project.id).toBe(BLANK);
    expect(st.doc.project.scenes).toHaveLength(3);
    expect(st.origin).toEqual({ kind: 'new' });
    expect(st.doc.project.revision).toBe(2);
    expect(st.cleanRevision).toBe(1);
    expect(st.toasts.some((t) => t.tone === 'error' && t.message.includes('Disk full'))).toBe(true);
    expect(messages()).toHaveLength(1);
    // A browser recovery copy exists at once, not only after the next edit.
    expect(readAutosave()?.file.project).toMatchObject({ id: BLANK, revision: 2 });
  });

  it('a second outline after a one-scene fill whose save failed keeps that project: it is saved before the switch', async () => {
    openBlankProject();
    const stub = globalThis.fetch;
    let puts = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return stub(input, init);
      puts++;
      // The fill's save fails once; later saves succeed.
      return puts === 1 ? json({ error: { code: 'DISK', message: 'Disk full' } }, 500) : stub(input, init);
    }) as typeof fetch;
    const one: OutlineDraft = { title: 'One scene', scenes: [{ name: 'Only', purpose: 'All of it', durationSeconds: 6 }] };
    await handleBridgeCommand({ type: 'proposeOutline', outline: one, agent: 'Claude Code' });
    expect(await approveOutline()).toBe(true);
    expect(useEditor.getState()).toMatchObject({ origin: { kind: 'new' } });
    expect(useEditor.getState().doc.project.revision).not.toBe(useEditor.getState().cleanRevision);

    await handleBridgeCommand({ type: 'proposeOutline', outline: { ...one, title: 'Another' }, agent: 'Claude Code' });
    expect(await approveOutline()).toBe(true);
    // The outgoing one-scene project was written to its file before the switch (the failed first save never reached the stub).
    const outgoing = calls.filter((c) => c.method === 'PUT' && c.path === `/api/projects/${BLANK}`);
    expect(outgoing).toHaveLength(1);
    expect((outgoing[0].body as { project: { name: string } }).project.name).toBe('One scene');
    expect(puts).toBe(3);
    expect(useEditor.getState().doc.project.name).toBe('Another');
    expect(useEditor.getState().doc.project.id).not.toBe(BLANK);
  });

  it('creating beside open work does nothing when the user opened another project during the outgoing save', async () => {
    expect(useEditor.getState().run({ type: 'updateProject', changes: { name: 'A, edited' } })).toBe(true);
    const stub = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') await gate;
      return stub(input, init);
    }) as typeof fetch;
    await handleBridgeCommand({ type: 'proposeOutline', outline: draft, agent: 'Claude Code' });
    const approving = approveOutline();
    const other = { ...structuredClone(fixtureProject), id: 'prj_c', name: 'C, opened meanwhile' };
    useEditor.getState().loadDocument(createDocState(other), { kind: 'server', id: 'prj_c' });
    release();
    expect(await approving).toBe(false);
    expect(useEditor.getState().doc.project).toMatchObject({ id: 'prj_c', name: 'C, opened meanwhile' });
    expect(useCreate.getState().status).toBe('pending');
  });

  it('creating beside open work keeps that work open when it cannot be saved', async () => {
    expect(useEditor.getState().run({ type: 'updateProject', changes: { name: 'A, edited' } })).toBe(true);
    const stub = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => (init?.method === 'PUT' ? json({ error: { code: 'DISK', message: 'Disk full' } }, 500) : stub(input, init))) as typeof fetch;
    await handleBridgeCommand({ type: 'proposeOutline', outline: draft, agent: 'Claude Code' });
    expect(await approveOutline()).toBe(false);
    expect(useEditor.getState().doc.project).toMatchObject({ id: fixtureProject.id, name: 'A, edited' });
    expect(useEditor.getState().toasts.at(-1)).toMatchObject({ tone: 'error', message: '“A, edited” could not be saved, so it stays open.' });
    expect(messages()).toEqual([]);
  });

  it('a third outline after a created one-scene project creates another, and a reopened one-scene skeleton is not refilled', async () => {
    openBlankProject();
    const one: OutlineDraft = { title: 'One scene', scenes: [{ name: 'Only', purpose: 'All of it', durationSeconds: 6 }] };
    await handleBridgeCommand({ type: 'proposeOutline', outline: one, agent: 'Claude Code' });
    expect(await approveOutline()).toBe(true);
    await handleBridgeCommand({ type: 'proposeOutline', outline: { ...one, title: 'Second' }, agent: 'Claude Code' });
    expect(await approveOutline()).toBe(true);
    const second = useEditor.getState().doc.project;
    expect(second.name).toBe('Second');
    await handleBridgeCommand({ type: 'proposeOutline', outline: { ...one, title: 'Third' }, agent: 'Claude Code' });
    expect(await approveOutline()).toBe(true);
    expect(useEditor.getState().doc.project.id).not.toBe(second.id);
    // Reopened later (a new document session), the second skeleton is still work.
    useEditor.getState().loadDocument(createDocState(structuredClone(second)), { kind: 'server', id: second.id });
    await handleBridgeCommand({ type: 'proposeOutline', outline: { ...one, title: 'Fourth' }, agent: 'Claude Code' });
    expect(await approveOutline()).toBe(true);
    expect(useEditor.getState().doc.project.id).not.toBe(second.id);
  });

  it('a second outline after a one-scene fill creates a new project instead of refilling it', async () => {
    openBlankProject();
    const one: OutlineDraft = { title: 'One scene', scenes: [{ name: 'Only', purpose: 'All of it', durationSeconds: 6 }] };
    await handleBridgeCommand({ type: 'proposeOutline', outline: one, agent: 'Claude Code' });
    expect(await approveOutline()).toBe(true);
    expect(useEditor.getState().doc.project).toMatchObject({ id: BLANK, name: 'One scene' });
    await handleBridgeCommand({ type: 'proposeOutline', outline: { ...one, title: 'Another' }, agent: 'Claude Code' });
    expect(await approveOutline()).toBe(true);
    expect(useEditor.getState().doc.project.id).not.toBe(BLANK);
    expect(useEditor.getState().doc.project.name).toBe('Another');
  });

  it('approval beside open work creates, saves and opens a new project, then hands it over in its chat', async () => {
    await handleBridgeCommand({ type: 'proposeOutline', outline: draft, agent: 'Claude Code' });
    editOutline((o) => updateOutlineScene({ ...o, title: 'Relay launch' }, 'ol_2', { durationSeconds: 16, notes: 'Use the screenshot' }));
    expect(await approveOutline()).toBe(true);

    const st = useEditor.getState();
    const project = st.doc.project;
    expect(project.id).not.toBe(fixtureProject.id);
    expect(project).toMatchObject({ name: 'Relay launch', width: 1920, height: 1080, fps: 30 });
    expect(project.scenes.map((s) => [s.name, s.durationInFrames, s.elements.length])).toEqual([['Hook', 120, 0], ['Product', 480, 0], ['Outro', 240, 0]]);
    expect(st.origin).toEqual({ kind: 'server', id: project.id });
    expect(st.doc.project.revision).toBe(st.cleanRevision);
    expect(st.doc.undoStack).toHaveLength(0);

    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.path).toBe(`/api/projects/${project.id}`);
    expect((put.body as { project: { id: string } }).project.id).toBe(project.id);
    const handover = messages();
    expect(handover).toHaveLength(1);
    expect(handover[0].path).toBe(`/api/chat/${project.id}/messages`);
    const text = textOf(handover[0]);
    expect(text).toContain(`The editor created and opened the new project "Relay launch" (${project.id})`);
    expect(text).toContain(`"Product" — scene ${project.scenes[1].id}, 16 s (480 frames)`);

    expect(editorContext().outline).toMatchObject({ status: 'approved', projectId: project.id, title: 'Relay launch' });
    expect(st.toasts.at(-1)).toMatchObject({ tone: 'success', message: 'Created “Relay launch” with 3 empty scenes.' });
  });

  it('never sends the build prompt to a project the user opened while the filled one was saving', async () => {
    openBlankProject();
    const stub = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const saving = new Promise<void>((r) => { reached = r; });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        reached();
        await gate;
      }
      return stub(input, init);
    }) as typeof fetch;

    await handleBridgeCommand({ type: 'proposeOutline', outline: draft, agent: 'Claude Code' });
    const approving = approveOutline();
    await saving;
    expect(useEditor.getState().doc.project.id).toBe(BLANK);
    // The user opens another project before the save has answered.
    useEditor.getState().loadDocument(createDocState(structuredClone(fixtureProject)), { kind: 'server', id: fixtureProject.id });
    release();
    expect(await approving).toBe(true);

    expect(messages()).toEqual([]);
    expect(useEditor.getState().origin).toEqual({ kind: 'server', id: fixtureProject.id });
    expect(useEditor.getState().toasts.at(-1)).toMatchObject({ tone: 'success', message: expect.stringContaining('“Relay in 30 seconds” has 3 scenes'), hint: expect.stringContaining('Open “Relay in 30 seconds”') });
  });

  it('never sends the build prompt to a project the user opened while a created one’s chat was loading', async () => {
    const stub = globalThis.fetch;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let reached!: () => void;
    const loading = new Promise<void>((r) => { reached = r; });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if ((init?.method ?? 'GET') === 'GET' && /^\/api\/chat\/prj_/.test(path) && !path.includes(fixtureProject.id)) {
        reached();
        await gate;
      }
      return stub(input, init);
    }) as typeof fetch;

    await handleBridgeCommand({ type: 'proposeOutline', outline: draft, agent: 'Claude Code' });
    const approving = approveOutline();
    await loading;
    const created = useEditor.getState().doc.project.id;
    useEditor.getState().loadDocument(createDocState(structuredClone(fixtureProject)), { kind: 'server', id: fixtureProject.id });
    release();
    expect(await approving).toBe(true);

    expect(created).not.toBe(fixtureProject.id);
    expect(calls.filter((c) => c.path.endsWith('/messages') || c.path.endsWith('/settings'))).toEqual([]);
    expect(useEditor.getState().toasts.at(-1)).toMatchObject({ tone: 'success', message: expect.stringContaining('Created “Relay in 30 seconds”'), hint: expect.stringContaining('Open “Relay in 30 seconds”') });
  });

  it('decline only records the answer', async () => {
    await handleBridgeCommand({ type: 'proposeOutline', outline: draft });
    declineOutline();
    expect(editorContext().outline).toMatchObject({ status: 'declined', agent: 'Claude Code' });
    expect(useCreate.getState()).toMatchObject({ dialog: null, step: 'idle' });
    expect(useEditor.getState().doc.project.id).toBe(fixtureProject.id);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });
});

describe('music bed', () => {
  it('removing the chosen track clears the choice and its beats', async () => {
    await chooseMusic({ id: 'ast_song', kind: 'audio', name: 'song.wav', src: 'assets/uploads/u_rm1.wav', mimeType: 'audio/wav' });
    setMusic({ snapToBeats: true, mood: 'calm' });
    removeMusicFile('ast_song');
    expect(useCreate.getState().brief.files).toEqual([]);
    expect(useCreate.getState().brief.music).toMatchObject({ mood: 'calm', snapToBeats: false });
    expect(useCreate.getState().brief.music?.fileId).toBeUndefined();
  });

  it('removing the chosen track of two makes the other the bed, with its beats', async () => {
    await chooseMusic({ id: 'ast_a', kind: 'audio', name: 'a.wav', src: 'assets/uploads/u_a.wav', mimeType: 'audio/wav' });
    await chooseMusic({ id: 'ast_b', kind: 'audio', name: 'b.wav', src: 'assets/uploads/u_b.wav', mimeType: 'audio/wav' });
    setMusic({ snapToBeats: true });
    await removeMusicFile('ast_b');
    const { brief } = useCreate.getState();
    expect(brief.files.map((f) => f.id)).toEqual(['ast_a']);
    expect(brief.music).toMatchObject({ fileId: 'ast_a', snapToBeats: false, tempo: { bpm: 120 } });
    expect(brief.music?.tempo?.downbeatSeconds.length).toBeGreaterThan(0);
  });
});
