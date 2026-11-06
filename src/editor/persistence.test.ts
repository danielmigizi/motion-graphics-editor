// Save/autosave races: a save reply or an autosave timer must only affect the
// document that started it. Uses the real store/persistence modules with an
// in-memory localStorage and a controllable fetch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import { createDocState } from '../core/history';
import type { Project } from '../core/types';
import { executeCommand, readAutosave, writeAutosave } from './doc';
import { onlyAgentChangesSinceSave, openFromServer, acceptRecovery, bootProject, discardRecovery, LAST_FORMAT_KEY, LAST_PROJECT_KEY, openBlank, openSample, useRecovery, saveToServer, startAutosave, startServerAutosave, useSaving } from './persistence';
import { editorContext } from './agentBridge';
import { isUntouched } from '../core/newProject';
import { useSession } from './session';
import { useEditor } from './store';

const storage = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
    removeItem: (k: string) => void storage.delete(k),
  },
});

let replies: Array<() => void> = [];
/** Paths of the saves (PUTs) the stub received, in order. */
let saved: string[] = [];
const realFetch = globalThis.fetch;

function project(id = 'prj_sample', revision = 1): Project {
  return { ...structuredClone(fixtureProject), id, revision };
}

function edit(text: string) {
  expect(useEditor.getState().run({ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { text } } })).toBe(true);
}

const rev = () => useEditor.getState().doc.project.revision;
const dirty = () => useEditor.getState().doc.project.revision !== useEditor.getState().cleanRevision;

let stop: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  storage.clear();
  useRecovery.setState({ offer: null, saved: null });
  useSaving.setState({ saving: false, failed: false, message: null });
  replies = [];
  saved = [];
  // Saves wait for the test to answer them; reads (e.g. the pending-proposal
  // check when a server document opens) find nothing.
  globalThis.fetch = (async (path: string, init?: RequestInit) => {
    if (!init?.method || init.method === 'GET') return new Response(JSON.stringify({ error: { message: 'Not found' } }), { status: 404, headers: { 'content-type': 'application/json' } });
    saved.push(path);
    return new Promise<Response>((resolve) => {
      replies.push(() => resolve(new Response(JSON.stringify({ ok: true, savedAt: new Date().toISOString() }), { headers: { 'content-type': 'application/json' } })));
    });
  }) as typeof fetch;
  useEditor.getState().loadDocument(createDocState(project()), { kind: 'sample' });
  stop = startAutosave();
});

afterEach(() => {
  stop();
  vi.useRealTimers();
  globalThis.fetch = realFetch;
});

describe('save completion', () => {
  it('keeps newer recovery data and stays dirty when edits landed during the save', async () => {
    edit('saved r2');
    const save = saveToServer();
    edit('unsaved r3');
    vi.advanceTimersByTime(1100);
    expect(readAutosave()?.file.project.revision).toBe(3);
    replies.shift()!();
    await save;
    expect(readAutosave()?.file.project.revision).toBe(3);
    expect(useEditor.getState().cleanRevision).toBe(2);
    expect(dirty()).toBe(true);
    expect(useEditor.getState().origin).toEqual({ kind: 'server', id: 'prj_sample' });
  });

  it('clears recovery data of the same document at or below the saved revision', async () => {
    edit('r2');
    vi.advanceTimersByTime(1100);
    expect(readAutosave()?.file.project.revision).toBe(2);
    const save = saveToServer();
    replies.shift()!();
    await save;
    expect(readAutosave()).toBeNull();
    expect(dirty()).toBe(false);
  });

  it('cancels a pending autosave the save already covers', async () => {
    edit('r2');
    const save = saveToServer();
    replies.shift()!();
    await save;
    vi.advanceTimersByTime(1100);
    expect(readAutosave()).toBeNull();
  });

  it('does not touch a different project opened while the save was in flight', async () => {
    edit('r2');
    const save = saveToServer();
    useEditor.getState().loadDocument(createDocState(project('prj_other', 2)), { kind: 'file', name: 'other.json' });
    replies.shift()!();
    await save;
    const st = useEditor.getState();
    expect(st.doc.project.id).toBe('prj_other');
    expect(st.origin).toEqual({ kind: 'file', name: 'other.json' });
    expect(st.cleanRevision).toBe(2);
  });

  it('does not mark a reopened copy of the same project clean', async () => {
    edit('r2');
    const save = saveToServer();
    useEditor.getState().loadDocument(createDocState(project('prj_sample', 1)), { kind: 'sample' });
    edit('other session r2');
    vi.advanceTimersByTime(1100);
    replies.shift()!();
    await save;
    expect(dirty()).toBe(true);
    expect(readAutosave()?.file.project.scenes[0].elements.find((e) => e.id === 'el_intro_headline')?.props.text).toBe('other session r2');
  });

  it('runs saves one at a time, in order', async () => {
    edit('r2');
    const a = saveToServer();
    edit('r3');
    const b = saveToServer();
    expect(replies.length).toBe(1);
    replies.shift()!();
    await a;
    expect(useEditor.getState().cleanRevision).toBe(2);
    await vi.waitFor(() => expect(replies.length).toBe(1));
    replies.shift()!();
    await b;
    expect(useEditor.getState().cleanRevision).toBe(3);
    expect(dirty()).toBe(false);
  });
});

describe('autosave timer', () => {
  it('writes the document that scheduled it and flushes it when another document opens', () => {
    edit('unsaved A');
    writeAutosave(useEditor.getState().doc);
    edit('unsaved A again');
    const editedRevision = rev();
    useEditor.getState().loadDocument(createDocState(project('prj_other')), { kind: 'file', name: 'other.json' });
    // Flushed immediately for project A, including the latest edit.
    expect(readAutosave()?.file.project.id).toBe('prj_sample');
    expect(readAutosave()?.file.project.revision).toBe(editedRevision);
    vi.advanceTimersByTime(1100);
    expect(readAutosave()?.file.project.id).toBe('prj_sample');
    expect(readAutosave()?.file.project.revision).toBe(editedRevision);
  });

  it('never writes a clean, newly opened document over the recovery slot', () => {
    edit('A r2');
    vi.advanceTimersByTime(1100);
    useEditor.getState().loadDocument(createDocState(project('prj_other', 7)), { kind: 'file', name: 'other.json' });
    vi.advanceTimersByTime(5000);
    expect(readAutosave()?.file.project.id).toBe('prj_sample');
    expect(readAutosave()?.file.project.revision).toBe(2);
  });
});

describe('server autosave', () => {
  it('quietly saves a server project shortly after the last edit', async () => {
    useEditor.getState().loadDocument(createDocState(project()), { kind: 'server', id: 'prj_sample' });
    const stopServer = startServerAutosave();
    try {
      const toasts = useEditor.getState().toasts.length;
      edit('one');
      edit('two');
      await vi.advanceTimersByTimeAsync(1000);
      expect(replies).toHaveLength(0); // still debouncing
      await vi.advanceTimersByTimeAsync(600);
      expect(replies).toHaveLength(1);
      expect(useSaving.getState().saving).toBe(true);
      replies[0]();
      await vi.advanceTimersByTimeAsync(0);
      expect(dirty()).toBe(false);
      expect(useSaving.getState().saving).toBe(false);
      expect(useEditor.getState().toasts.length).toBe(toasts);
    } finally {
      stopServer();
    }
  });

  it('never autosaves projects that are not on the server', async () => {
    const stopServer = startServerAutosave();
    try {
      edit('sample edit');
      await vi.advanceTimersByTimeAsync(3000);
      expect(replies).toHaveLength(0);
      expect(dirty()).toBe(true);
    } finally {
      stopServer();
    }
  });

  it('sends the save it skipped while locked as soon as the tab unlocks, with no further edit', async () => {
    useEditor.getState().loadDocument(createDocState(project()), { kind: 'server', id: 'prj_sample' });
    useSession.setState({ editor: false });
    const stopServer = startServerAutosave();
    try {
      edit('while locked');
      await vi.advanceTimersByTimeAsync(3000);
      expect(saved).toEqual([]);
      useSession.setState({ editor: true });
      await vi.advanceTimersByTimeAsync(1600);
      expect(saved).toEqual(['/api/projects/prj_sample?autosave=1']);
      replies[0]();
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      stopServer();
      useSession.setState({ editor: null, error: null });
    }
  });

  it('is skipped while the tab is locked (the browser autosave and Save still run), and resumes once unlocked', async () => {
    useEditor.getState().loadDocument(createDocState(project()), { kind: 'server', id: 'prj_sample' });
    useSession.setState({ editor: false });
    const stopServer = startServerAutosave();
    try {
      edit('locked');
      await vi.advanceTimersByTimeAsync(3000);
      expect(saved).toEqual([]);
      expect(useSaving.getState().failed).toBe(false);
      expect(readAutosave()?.file.project.revision).toBe(2);
      void saveToServer();
      expect(saved).toEqual(['/api/projects/prj_sample']);
      replies[0]();
      await vi.advanceTimersByTimeAsync(0);

      useSession.setState({ editor: true });
      edit('unlocked');
      await vi.advanceTimersByTimeAsync(1600);
      expect(saved).toEqual(['/api/projects/prj_sample', '/api/projects/prj_sample?autosave=1']);
      replies[1]();
      await vi.advanceTimersByTimeAsync(0);
      expect(dirty()).toBe(false);
    } finally {
      stopServer();
      useSession.setState({ editor: null, error: null });
    }
  });

  it('files changes as the agent’s only when every change since the last save was an agent’s Auto-apply patch', async () => {
    /** What agentBridge runPatch does with Auto-apply on: the agent's change, committed in this tab. */
    const agentEdit = (text: string) => {
      const st = useEditor.getState();
      const r = executeCommand(st.doc, { type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { text } } });
      if (!r.ok) throw new Error(r.error.message);
      st.replaceDoc(r.state, { byAgent: true });
    };
    const autosaved = async () => {
      await vi.advanceTimersByTimeAsync(1600);
      replies.shift()!();
      await vi.advanceTimersByTimeAsync(0);
      expect(dirty()).toBe(false);
      return saved.shift();
    };
    useEditor.getState().loadDocument(createDocState(project()), { kind: 'server', id: 'prj_sample' });
    useSession.setState({ editor: true });
    const stopServer = startServerAutosave();
    try {
      agentEdit('agent one');
      agentEdit('agent two');
      expect(await autosaved()).toBe('/api/projects/prj_sample?autosave=1&by=agent');

      edit('mine');
      expect(await autosaved()).toBe('/api/projects/prj_sample?autosave=1');

      agentEdit('agent three');
      expect(await autosaved()).toBe('/api/projects/prj_sample?autosave=1&by=agent');

      // The person's edit and an agent's in one autosave: the person's, so nothing of theirs lands in the agent ring.
      edit('mine again');
      agentEdit('agent four');
      expect(await autosaved()).toBe('/api/projects/prj_sample?autosave=1');

      // The person's undo of an agent's change is the person's change.
      agentEdit('agent five');
      useEditor.getState().undo();
      expect(await autosaved()).toBe('/api/projects/prj_sample?autosave=1');

      // Another document starts over: only the agent has touched it.
      useEditor.getState().loadDocument(createDocState(project('prj_other')), { kind: 'server', id: 'prj_other' });
      saved = [];
      agentEdit('agent in another');
      expect(await autosaved()).toBe('/api/projects/prj_other?autosave=1&by=agent');
    } finally {
      stopServer();
      useSession.setState({ editor: null, error: null });
    }
  });
});


describe('save failure banner state', () => {
  it('persists failures until retry succeeds', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'));
    edit('unsaved');
    await saveToServer();
    expect(useSaving.getState()).toMatchObject({ failed: true, saving: false });
    await vi.advanceTimersByTimeAsync(10000);
    expect(useSaving.getState().failed).toBe(true);
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, savedAt: new Date().toISOString() }), { headers: { 'content-type': 'application/json' } }));
    await saveToServer();
    expect(useSaving.getState()).toMatchObject({ failed: false, message: null });
  });
  it('sends autosave=1 and surfaces server autosave failure without losing recovery', async () => {
    useEditor.getState().loadDocument(createDocState(project()), { kind: 'server', id: 'prj_sample' });
    const fetch = vi.fn().mockRejectedValue(new Error('offline'));
    globalThis.fetch = fetch;
    const stopServer = startServerAutosave();
    try {
      edit('unsaved');
      await vi.advanceTimersByTimeAsync(1600);
      expect(fetch.mock.calls.map((c) => c[0])).toContain('/api/projects/prj_sample?autosave=1');
      expect(useSaving.getState().failed).toBe(true);
      expect(readAutosave()?.file.project.revision).toBe(2);
    } finally { stopServer(); }
  });
  it('does not attach an old session failure to a new document', async () => {
    let reject!: (e: Error) => void;
    globalThis.fetch = (() => new Promise<Response>((_resolve, rej) => { reject = rej; })) as typeof fetch;
    const save = saveToServer();
    useEditor.getState().loadDocument(createDocState(project('other')), { kind: 'sample' });
    reject(new Error('offline'));
    await save;
    expect(useSaving.getState().failed).toBe(false);
  });
});

describe('journal recovery on open', () => {
  function recoveryFetch(savedRevision: number, journalRevision: number, entryId = '14-123') {
    const file = (revision: number) => ({ format: 'mge.project/1', project: project('prj_sample', revision), revisions: [], savedAt: new Date().toISOString() });
    globalThis.fetch = vi.fn(async (path: string) => {
      const body = path.endsWith('/journal') ? [{ id: entryId, revision: journalRevision, createdAt: new Date().toISOString() }] : path.endsWith(`/journal/${entryId}`) ? { id: entryId, revision: journalRevision, createdAt: new Date().toISOString(), file: file(journalRevision) } : file(savedRevision);
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  }
  it('offers the person\u2019s newer entry even when a later baseline copy (not newer than the file) sits above it', async () => {
    const file = (revision: number) => ({ format: 'mge.project/1', project: project('prj_sample', revision), revisions: [], savedAt: new Date().toISOString() });
    const later = new Date(Date.now() + 1000).toISOString();
    globalThis.fetch = vi.fn(async (path: string) => {
      const body = path.endsWith('/journal') ? [{ id: '1-200-u', revision: 1, createdAt: later }, { id: '2-100', revision: 2, createdAt: new Date().toISOString() }]
        : path.endsWith('/journal/2-100') ? { id: '2-100', revision: 2, createdAt: new Date().toISOString(), file: file(2) } : file(1);
      return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    expect(await openFromServer('prj_sample')).toEqual({ ok: true });
    expect(useRecovery.getState().offer?.file.project.revision).toBe(2);
  });
  it('never offers an agent\u2019s History copy (-a) back as the person\u2019s unsaved work', async () => {
    recoveryFetch(12, 14, '14-123-a');
    expect(await openFromServer('prj_sample')).toEqual({ ok: true });
    expect(rev()).toBe(12);
    expect(useRecovery.getState().offer).toBeNull();
  });
  it('offers newer journal content and recovers it as unsaved relative to the saved file', async () => {
    recoveryFetch(12, 14);
    expect(await openFromServer('prj_sample')).toEqual({ ok: true });
    expect(rev()).toBe(12);
    expect(useRecovery.getState().offer?.file.project.revision).toBe(14);
    expect(useRecovery.getState().saved?.project.revision).toBe(12);
    acceptRecovery();
    expect(rev()).toBe(14);
    expect(dirty()).toBe(true);
    expect(useEditor.getState().origin).toEqual({ kind: 'server', id: 'prj_sample' });
    // Recovered work is the person's: an agent-requested save or autosave files it as theirs.
    expect(onlyAgentChangesSinceSave(useEditor.getState())).toBe(false);
  });
  it('opens the saved document when recovery is declined and ignores older journal content', async () => {
    recoveryFetch(12, 14);
    await openFromServer('prj_sample');
    discardRecovery();
    expect(rev()).toBe(12);
    expect(useRecovery.getState().offer).toBeNull();
    recoveryFetch(15, 14);
    await openFromServer('prj_sample');
    expect(useRecovery.getState().offer).toBeNull();
    expect(rev()).toBe(15);
  });
  it('offers a newer browser copy ahead of an older journal entry', async () => {
    writeAutosave(createDocState(project('prj_sample', 16)));
    recoveryFetch(12, 14);
    await openFromServer('prj_sample');
    expect(useRecovery.getState().offer?.file.project.revision).toBe(16);
  });
});

describe('landing', () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const savedFile = (id: string) => ({ format: 'mge.project/1', project: project(id, 4), revisions: [], savedAt: new Date().toISOString() });
  const square = { width: 1080, height: 1080, fps: 25, backgroundColor: '#112233' };

  it('opens the remembered project when the server has it', async () => {
    storage.set(LAST_PROJECT_KEY, 'prj_last');
    const fetch = vi.fn(async (path: string) => (path.endsWith('/journal') ? json([]) : json(savedFile('prj_last'))));
    globalThis.fetch = fetch as unknown as typeof globalThis.fetch;
    expect(await bootProject()).toBe('last');
    expect(fetch.mock.calls[0][0]).toBe('/api/projects/prj_last');
    expect(useEditor.getState().origin).toEqual({ kind: 'server', id: 'prj_last' });
    expect(useEditor.getState().doc.project.id).toBe('prj_last');
    expect(storage.get(LAST_PROJECT_KEY)).toBe('prj_last');
  });

  it('opens a blank project in the remembered format and forgets a project the server no longer has', async () => {
    storage.set(LAST_PROJECT_KEY, 'prj_gone');
    storage.set(LAST_FORMAT_KEY, JSON.stringify(square));
    const toasts = useEditor.getState().toasts.length;
    globalThis.fetch = (async () => json({ error: { message: 'No project prj_gone' } }, 404)) as typeof fetch;
    expect(await bootProject()).toBe('blank');
    const st = useEditor.getState();
    expect(st.origin).toEqual({ kind: 'new' });
    // The remembered size and frame rate; the plate is always the blank project's own.
    expect(st.doc.project).toMatchObject({ width: square.width, height: square.height, fps: square.fps, backgroundColor: '#F7F6F2' });
    expect(storage.has(LAST_PROJECT_KEY)).toBe(false);
    expect(st.toasts.length).toBe(toasts);
  });

  it('keeps edits made to the placeholder while the remembered project was loading', async () => {
    storage.set(LAST_PROJECT_KEY, 'prj_last');
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    globalThis.fetch = (async (path: string) => {
      if (path.endsWith('/journal')) return json([]);
      await gate;
      return json(savedFile('prj_last'));
    }) as typeof fetch;
    const before = useEditor.getState().origin;
    const booting = bootProject();
    // An agent (or the user) changes the placeholder before the fetch answers.
    expect(useEditor.getState().run({ type: 'updateProject', changes: { name: 'Typed meanwhile' } })).toBe(true);
    release();
    expect(await booting).toBe('kept');
    const st = useEditor.getState();
    expect(st.doc.project.name).toBe('Typed meanwhile');
    expect(st.doc.project.id).not.toBe('prj_last');
    expect(st.origin).toEqual(before);
  });

  it('keeps remembering a project it could not reach while the server is down', async () => {
    storage.set(LAST_PROJECT_KEY, 'prj_last');
    globalThis.fetch = (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch;
    expect(await bootProject()).toBe('blank');
    expect(useEditor.getState().origin).toEqual({ kind: 'new' });
    expect(storage.get(LAST_PROJECT_KEY)).toBe('prj_last');
  });

  it('opens an untouched, clean blank project when nothing is remembered', async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch;
    expect(await bootProject()).toBe('blank');
    expect(fetch).not.toHaveBeenCalled();
    const st = useEditor.getState();
    expect(st.origin).toEqual({ kind: 'new' });
    expect(st.doc.project).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    expect(isUntouched(st.doc.project)).toBe(true);
    expect(editorContext()).toMatchObject({ origin: 'new', dirty: false, untouched: true });
  });

  it('remembers server documents and forgets them when the sample or a file is opened', async () => {
    useEditor.getState().loadDocument(createDocState(project('prj_a')), { kind: 'server', id: 'prj_a' });
    expect(storage.get(LAST_PROJECT_KEY)).toBe('prj_a');
    openSample();
    expect(storage.has(LAST_PROJECT_KEY)).toBe(false);
    useEditor.getState().loadDocument(createDocState(project('prj_b')), { kind: 'server', id: 'prj_b' });
    useEditor.getState().loadDocument(createDocState(project('prj_c')), { kind: 'file', name: 'c.json' });
    expect(storage.has(LAST_PROJECT_KEY)).toBe(false);
  });

  it('remembers the format of every loaded document and of format changes', () => {
    openBlank(square);
    // A blank project keeps the size and frame rate and starts on the Paper plate.
    expect(JSON.parse(storage.get(LAST_FORMAT_KEY)!)).toEqual({ ...square, backgroundColor: '#F7F6F2' });
    expect(useEditor.getState().run({ type: 'updateProject', changes: { backgroundColor: '#445566' } })).toBe(true);
    expect(JSON.parse(storage.get(LAST_FORMAT_KEY)!)).toEqual({ ...square, backgroundColor: '#445566' });
  });

  it('never autosaves an untouched new project, and creates it on the server after one edit', async () => {
    openBlank();
    const stopServer = startServerAutosave();
    try {
      await vi.advanceTimersByTimeAsync(5000);
      expect(replies).toHaveLength(0);
      expect(readAutosave()).toBeNull();
      const { sceneId } = useEditor.getState().selection;
      const id = useEditor.getState().doc.project.id;
      expect(useEditor.getState().run({ type: 'addElement', sceneId: sceneId!, element: { ...structuredClone(fixtureProject.scenes[0].elements.find((e) => e.id === 'el_intro_headline')!), id: 'el_new', startFrame: 0, durationInFrames: 30 } })).toBe(true);
      await vi.advanceTimersByTimeAsync(1600);
      expect(replies).toHaveLength(1);
      // The first save writes the project's file (not the recovery journal): that is what creates it.
      expect(saved).toEqual([`/api/projects/${id}`]);
      replies[0]();
      await vi.advanceTimersByTimeAsync(0);
      expect(useEditor.getState().origin).toEqual({ kind: 'server', id });
      // From here on, quiet saves go to the journal like any server project's.
      expect(useEditor.getState().run({ type: 'updateProject', changes: { name: 'Renamed' } })).toBe(true);
      await vi.advanceTimersByTimeAsync(1600);
      expect(saved).toEqual([`/api/projects/${id}`, `/api/projects/${id}?autosave=1`]);
      replies[1]();
      await vi.advanceTimersByTimeAsync(0);
      expect(dirty()).toBe(false);
      expect(storage.get(LAST_PROJECT_KEY)).toBe(id);
    } finally {
      stopServer();
    }
  });
});
