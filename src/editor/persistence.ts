// Save / Open / Import / Export and autosave recovery.

import { create } from 'zustand';
import { createDocState } from '../core/history';
import { newId } from '../core/ids';
import { blankProject, DEFAULT_FORMAT, formatOf, type ProjectFormat } from '../core/newProject';
import type { DocState, Project, ProjectFile } from '../core/types';
import { sampleProject } from '../sample/sampleProject';
import { api, ApiRequestError, errorText, ServerDownError, SERVER_DOWN_MESSAGE } from './api';
import { pickFile } from './assets';
import { clearAutosave, loadDoc, readAutosave, serializeDoc, writeAutosave, type Autosave } from './doc';
import { useSession } from './session';
import { useEditor, type DocOrigin } from './store';

export const useRecovery = create<{ offer: Autosave | null; saved: ProjectFile | null }>(() => ({ offer: null, saved: null }));

/** After opening a project, offer an autosave of the same project with a newer revision. */
export function checkRecovery(opened: Project, saved: ProjectFile | null = null) {
  useRecovery.setState({ saved });
  const a = readAutosave();
  if (a && a.file.project.id === opened.id && a.file.project.revision > opened.revision) useRecovery.setState({ offer: a });
  else useRecovery.setState({ offer: null });
}

export function acceptRecovery() {
  const offer = useRecovery.getState().offer;
  if (!offer) return;
  const r = loadDoc(offer.file);
  useRecovery.setState({ offer: null });
  if (!r.ok) {
    useEditor.getState().toast({ tone: 'error', message: `Could not recover: ${r.error.message}`, hint: r.error.hint });
    return;
  }
  const st = useEditor.getState();
  // Keep the origin: recovered edits of a server project still save back to it.
  st.loadDocument(r.state, st.origin);
  // Recovered edits are unsaved relative to the opened file, and they are the person's.
  useEditor.setState((s) => ({ cleanRevision: -1, userEdits: s.userEdits + 1 }));
  st.toast({ tone: 'success', message: `Recovered unsaved changes (r${r.state.project.revision}).` });
}

export function discardRecovery() {
  useRecovery.setState({ offer: null });
  clearAutosave();
}

// ---------------------------------------------------------------------------
// Autosave
//
// The debounce timer writes the document that scheduled it, tagged with its
// docSession — never whatever happens to be open when it fires. Opening,
// importing, recovering or loading the sample (anything that changes
// docSession) FLUSHES the pending autosave for the old document first, so no
// edit is lost and the new document never lands in the recovery slot by
// accident.
// ---------------------------------------------------------------------------

interface PendingAutosave {
  session: string;
  doc: DocState;
  timer: ReturnType<typeof setTimeout>;
}

let pending: PendingAutosave | null = null;

function writePending(p: PendingAutosave) {
  const st = useEditor.getState();
  // Already saved at (or past) this revision while the timer was pending.
  if (st.docSession === p.session && st.cleanRevision >= p.doc.project.revision) return;
  writeAutosave(p.doc, p.session);
}

/** Write the pending autosave now (for the document that scheduled it) and cancel its timer. */
export function flushAutosave() {
  const p = pending;
  if (!p) return;
  clearTimeout(p.timer);
  pending = null;
  writePending(p);
}

function cancelAutosaveUpTo(session: string, revision: number) {
  if (pending && pending.session === session && pending.doc.project.revision <= revision) {
    clearTimeout(pending.timer);
    pending = null;
  }
}

/** Debounced (~1 s) autosave of edits. Paused while a recovery offer is pending. */
export function startAutosave(): () => void {
  const unsubscribe = useEditor.subscribe((s, prev) => {
    if (s.docSession !== prev.docSession) {
      // A different document was opened: persist the old one's pending edits now.
      flushAutosave();
      return;
    }
    if (s.doc === prev.doc) return;
    if (useRecovery.getState().offer) return;
    if (s.doc.project.revision === s.cleanRevision) return;
    if (pending) clearTimeout(pending.timer);
    const p: PendingAutosave = {
      session: s.docSession,
      doc: s.doc,
      timer: setTimeout(() => {
        if (pending === p) pending = null;
        writePending(p);
      }, 1000),
    };
    pending = p;
  });
  const onHide = () => flushAutosave();
  if (typeof window !== 'undefined') window.addEventListener('pagehide', onHide);
  return () => {
    unsubscribe();
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', onHide);
    flushAutosave();
  };
}

// ---------------------------------------------------------------------------
// Save
//
// The document (session, project id, revision, file) is captured when Save is
// pressed. Saves run one at a time so replies cannot arrive out of order. A
// reply only affects the document that was saved, and only if that document
// is still open: it is marked clean up to the saved revision (later edits stay
// dirty), and only recovery data of that same document at or below the saved
// revision is cleared.
// ---------------------------------------------------------------------------

let saving: Promise<void> | null = null;

/**
 * Save the open document. `quiet`: no success toast, and a server project is
 * written to its recovery journal rather than its file (the editor's autosave).
 * `canonical` forces the file. A `new` project is always written to its file:
 * the first save is what creates it on the server. `byAgent`: an agent asked
 * for it (agentBridge `save`), or the server autosave carries only an agent's
 * Auto-apply patches; this tab sends it, but the server files it as the
 * agent's, not the user's.
 */
export function saveToServer(opts: { quiet?: boolean; canonical?: boolean; byAgent?: boolean } = {}): Promise<void> {
  const st = useEditor.getState();
  const session = st.docSession;
  const file = serializeDoc(st.doc);
  const save = { autosave: !!opts.quiet && !opts.canonical && st.origin.kind !== 'new', byAgent: !!opts.byAgent };
  const edits = st.userEdits;
  const prev = saving;
  // Start immediately when idle; otherwise after the in-flight save settles.
  const run = prev ? prev.then(() => performSave(session, file, !!opts.quiet, save, edits)) : performSave(session, file, !!opts.quiet, save, edits);
  const tracked: Promise<void> = run.finally(() => {
    if (saving === tracked) saving = null;
  });
  saving = tracked;
  return tracked;
}

/** True while a save is in flight (for the "Saving…" indicator). */
export const useSaving = create<{ saving: boolean; failed: boolean; message: string | null }>(() => ({ saving: false, failed: false, message: null }));

useEditor.subscribe((state, prev) => {
  if (state.docSession !== prev.docSession) useSaving.setState({ failed: false, message: null });
});

type SaveKind = { autosave: boolean; byAgent: boolean };

/**
 * The person's edit count (store.ts userEdits) in the document `session` at
 * its last successful save. A document that hasn't saved since it opened
 * compares with 0, where loadDocument starts the count.
 */
let savedEdits = { session: '', userEdits: 0 };

/** Every change since this document's last save was an agent's Auto-apply patch: the person changed nothing. */
export function onlyAgentChangesSinceSave(st: { docSession: string; userEdits: number }): boolean {
  return st.userEdits === (savedEdits.session === st.docSession ? savedEdits.userEdits : 0);
}

async function performSave(session: string, file: ProjectFile, quiet: boolean, save: SaveKind, edits: number): Promise<void> {
  useSaving.setState({ saving: true });
  try {
    await performSaveInner(session, file, quiet, save, edits);
  } finally {
    useSaving.setState({ saving: false });
  }
}

async function performSaveInner(session: string, file: ProjectFile, quiet: boolean, save: SaveKind, edits: number): Promise<void> {
  const st = useEditor.getState();
  const revision = file.project.revision;
  try {
    const r = await api.saveProject(file, save);
    const stillOpen = useEditor.getState().markSavedIfCurrent(session, { ...file, savedAt: r.savedAt });
    if (stillOpen) {
      // Saves run one at a time, so this is the newest of its document.
      savedEdits = { session, userEdits: edits };
      const a = readAutosave();
      if (a && a.session === session && a.file.project.id === file.project.id && a.file.project.revision <= revision) clearAutosave();
      cancelAutosaveUpTo(session, revision);
    }
    if (stillOpen) useSaving.setState({ failed: false, message: null });
    if (!quiet) st.toast({ tone: 'success', message: `Saved “${file.project.name}” at r${revision}.` });
  } catch (e) {
    if (useEditor.getState().docSession !== session) return;
    const alreadyFailing = useSaving.getState().failed;
    useSaving.setState({ failed: true, message: errorText(e).message });
    // A failing autosave reports once, not on every edit.
    if (quiet && alreadyFailing) return;
    if (e instanceof ServerDownError) st.toast({ tone: 'error', message: SERVER_DOWN_MESSAGE, hint: 'Your work is autosaved in this browser. Use Export JSON to keep a file copy.' });
    else st.toast({ tone: 'error', message: `Save failed: ${errorText(e).message}`, hint: errorText(e).hint });
  }
}

// ---------------------------------------------------------------------------
// Server autosave
//
// Projects that live on the local server (opened from it, or written there by
// the agent) save themselves ~1.5 s after the last change, quietly, while the
// tab is not locked (session.ts). The browser autosave above stays as the
// crash-recovery net.
// ---------------------------------------------------------------------------

const SERVER_AUTOSAVE_MS = 1500;

/**
 * Origins that autosave to the server once changed. A `new` project is
 * created there by its first save (which flips its origin to `server`); an
 * untouched one never is, because its revision still equals cleanRevision.
 */
const onServer = (kind: DocOrigin['kind']) => kind === 'server' || kind === 'new';

export function startServerAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    const s = useEditor.getState();
    if (timer) clearTimeout(timer);
    timer = null;
    if (!onServer(s.origin.kind) || s.doc.project.revision === s.cleanRevision || useRecovery.getState().offer) return;
    const session = s.docSession;
    timer = setTimeout(() => {
      timer = null;
      const now = useEditor.getState();
      if (now.docSession !== session || !onServer(now.origin.kind) || now.doc.project.revision === now.cleanRevision) return;
      // The recovery journal (?autosave=1) is the user's: a locked tab would only collect 401s.
      // Its browser autosave still runs, and Save still writes the file. (A `new` project's
      // first save writes its file, which a locked tab may.)
      if (now.origin.kind === 'server' && useSession.getState().editor === false) return;
      // Only an agent's Auto-apply patches since the last save: the server files them as the agent's, not the person's.
      void saveToServer({ quiet: true, byAgent: onlyAgentChangesSinceSave(now) });
    }, SERVER_AUTOSAVE_MS);
  };
  const unsubscribe = useEditor.subscribe((s, prev) => {
    if (s.doc !== prev.doc || s.origin !== prev.origin) schedule();
  });
  // A save skipped while the tab was locked goes out once it unlocks.
  const unsubscribeSession = useSession.subscribe((s, prev) => {
    if (s.editor === true && prev.editor !== true) schedule();
  });
  return () => {
    unsubscribe();
    unsubscribeSession();
    if (timer) clearTimeout(timer);
  };
}

/**
 * Open a new blank project (one empty scene) in `format`, by default the open
 * project's. It is not on the server until its first change (origin `new`);
 * an untouched blank project is never worth an unsaved-changes prompt.
 */
export function openBlank(format: ProjectFormat = formatOf(useEditor.getState().doc.project)): void {
  const st = useEditor.getState();
  flushAutosave();
  // Size and frame rate carry over; the plate is always the Paper pack's, which the blank project's style expects.
  const project = blankProject({ project: newId('prj'), scene: newId('scn') }, { ...format, backgroundColor: DEFAULT_FORMAT.backgroundColor });
  st.loadDocument(createDocState(project), { kind: 'new' });
  st.setOpenDialog(false);
  useRecovery.setState({ offer: null, saved: null });
}

export function openSample() {
  const st = useEditor.getState();
  st.loadDocument(createDocState(sampleProject), { kind: 'sample' });
  st.setOpenDialog(false);
  checkRecovery(sampleProject);
}

/** `status`: the server's HTTP status when it answered with an error (404: no such project). */
export type OpenResult = { ok: true } | { ok: false; message: string; hint?: string; status?: number };

/**
 * `quiet`: no toast when the project cannot be fetched (boot falls back to a
 * blank project instead). `unlessChanged`: do not replace the open document if
 * it is no longer this one (edits made while the fetch was in flight stay).
 */
export async function openFromServer(id: string, opts: { quiet?: boolean; unlessChanged?: DocState } = {}): Promise<OpenResult> {
  const st = useEditor.getState();
  try {
    const openingSession = st.docSession;
    const [file, journal] = await Promise.all([api.getProject(id), api.listJournal(id).catch((e) => {
      if (!opts.quiet) st.toast({ tone: 'error', message: `Could not check recovery journal: ${errorText(e).message}` });
      return [];
    })]);
    // Only the person's own History entries are offered back as their unsaved work (agent copies end in -a).
    // The newest of the person's own entries that is ahead of the saved file (a later baseline copy may be older).
    const newest = Array.isArray(journal) ? journal.find((entry) => !entry.id.endsWith('-a') && entry.revision > file.project.revision) : undefined;
    let recovered: Autosave | null = null;
    if (newest && newest.revision > file.project.revision) {
      try {
        const entry = await api.getJournalEntry(id, newest.id);
        if (entry.file.project.id === id && entry.file.project.revision > file.project.revision) recovered = { file: entry.file, at: Date.parse(entry.createdAt) };
      } catch (e) { st.toast({ tone: 'error', message: `Could not read recovery journal: ${errorText(e).message}` }); }
    }
    if (useEditor.getState().docSession !== openingSession) return { ok: false, message: 'Another document was opened while this project was loading.' };
    if (opts.unlessChanged && useEditor.getState().doc !== opts.unlessChanged) return { ok: false, message: 'The open document changed while this project was loading.' };
    const r = loadDoc(file);
    if (!r.ok) {
      st.toast({ tone: 'error', message: `Could not open: ${r.error.message}`, hint: r.error.hint, path: r.error.path });
      return { ok: false, message: r.error.message, hint: r.error.hint };
    }
    st.loadDocument(r.state, { kind: 'server', id }, r.file.savedAt);
    st.setOpenDialog(false);
    checkRecovery(r.state.project, r.file);
    const local = useRecovery.getState().offer;
    if (recovered && (!local || recovered.file.project.revision > local.file.project.revision)) useRecovery.setState({ offer: recovered });
    return { ok: true };
  } catch (e) {
    if (!opts.quiet) st.toast({ tone: 'error', message: errorText(e).message, hint: errorText(e).hint });
    return { ok: false, ...errorText(e), status: e instanceof ApiRequestError ? e.status : undefined };
  }
}

// ---------------------------------------------------------------------------
// Landing
//
// The editor opens the server project it had open last, or a blank project in
// the last-used format. The sample is only ever opened from the Open dialog.
// Both are remembered in localStorage by the subscription below.
// ---------------------------------------------------------------------------

export const LAST_PROJECT_KEY = 'mge:lastProject';
export const LAST_FORMAT_KEY = 'mge:lastFormat';

function readKey(key: string): string | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeKey(key: string, value: string | null) {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage full or blocked: landing falls back to a blank project.
  }
}

function readLastFormat(): ProjectFormat {
  try {
    const f = JSON.parse(readKey(LAST_FORMAT_KEY) ?? 'null') as Partial<ProjectFormat> | null;
    const positive = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;
    if (f && positive(f.width) && positive(f.height) && positive(f.fps) && typeof f.backgroundColor === 'string') return formatOf(f as ProjectFormat);
  } catch {
    // Unreadable: use the default.
  }
  return DEFAULT_FORMAT;
}

useEditor.subscribe((s, prev) => {
  const opened = s.docSession !== prev.docSession;
  if (opened || s.origin !== prev.origin) {
    const o = s.origin;
    if (o.kind === 'server') writeKey(LAST_PROJECT_KEY, o.id);
    // A `new` project is remembered once its first save makes it `server`.
    else if (o.kind !== 'new') writeKey(LAST_PROJECT_KEY, null);
  }
  const p = s.doc.project;
  const q = prev.doc.project;
  if (opened || p.width !== q.width || p.height !== q.height || p.fps !== q.fps || p.backgroundColor !== q.backgroundColor) writeKey(LAST_FORMAT_KEY, JSON.stringify(formatOf(p)));
});

/**
 * What the editor opens on boot: the server project it had open last
 * (`'last'`), or else a blank project in the last-used format (`'blank'`).
 * A remembered project the server no longer has is forgotten; one that cannot
 * be reached (server down) stays remembered for the next boot.
 */
export async function bootProject(): Promise<'last' | 'blank' | 'kept'> {
  const { docSession: bootSession, doc: bootDoc } = useEditor.getState();
  const id = readKey(LAST_PROJECT_KEY);
  if (id) {
    const r = await openFromServer(id, { quiet: true, unlessChanged: bootDoc });
    if (r.ok) return 'last';
    if (r.status === 404) writeKey(LAST_PROJECT_KEY, null);
  }
  // Something was opened or changed while the remembered project was loading: keep it.
  const now = useEditor.getState();
  if (now.docSession !== bootSession || now.doc !== bootDoc) return 'kept';
  openBlank(readLastFormat());
  return 'blank';
}

export async function importJson() {
  const st = useEditor.getState();
  const file = await pickFile('.json,application/json');
  if (!file) return;
  let data: unknown;
  try {
    data = JSON.parse(await file.text());
  } catch (e) {
    st.toast({ tone: 'error', message: `“${file.name}” is not valid JSON.`, hint: e instanceof Error ? e.message : undefined });
    return;
  }
  const r = loadDoc(data);
  if (!r.ok) {
    st.toast({ tone: 'error', message: `Cannot import “${file.name}”: ${r.error.message}`, hint: r.error.hint, path: r.error.path });
    return;
  }
  st.loadDocument(r.state, { kind: 'file', name: file.name }, r.file.savedAt);
  st.toast({ tone: 'success', message: `Imported “${r.state.project.name}” (r${r.state.project.revision}).` });
  checkRecovery(r.state.project);
}

export function exportJson() {
  downloadProjectFile(serializeDoc(useEditor.getState().doc));
}

export function downloadRecoveryCopies() {
  const { offer, saved } = useRecovery.getState();
  if (saved) downloadProjectFile(saved, 'saved');
  if (offer) downloadProjectFile(offer.file, 'recovery');
}

export function downloadProjectFile(file: ProjectFile, suffix = '') {
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const slug = file.project.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project';
  a.href = url;
  a.download = `${slug}-r${file.project.revision}${suffix ? `-${suffix}` : ''}.mge.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
