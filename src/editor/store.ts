// Editor state. The document lives in `doc` (core DocState) and only ever
// changes through core commands (`run`), undo/redo, rollback, or loading a
// whole new document. Everything else here is view state.

import { create } from 'zustand';
import { createDocState, redo as coreRedo, restoreRevision, restoreSnapshot, undo as coreUndo } from '../core/history';
import { newId } from '../core/ids';
import { locateFrame, projectDurationInFrames } from '../core/timing';
import type { AnimatableProperty, Command, CommandError, DocState, EditRequest, Element, PathNode, ProjectFile } from '../core/types';
import type { Checkpoint } from '../core/api-contract';
import { parseProjectFile } from '../core/validate';
import { blankProject } from '../core/newProject';
import { FIT_VIEW, type StageView } from './canvasView';
import { executeCommand } from './doc';
import { isTransformTrack, type KeyRef } from './keyframes';
import type { WorkArea } from './timelineView';

export type EditMode = 'layout' | 'animate';
/** A secondary panel shown as a dialog over the stage (Sheets.tsx): Connect agents. Export is a popover from the header (ExportPopover.tsx). */
export type Sheet = 'connect';
export type ServerStatus = 'unknown' | 'up' | 'down';

export interface Toast {
  id: number;
  tone: 'error' | 'info' | 'success';
  message: string;
  hint?: string;
  path?: string;
}

/** `new`: a blank project made here, not on the server until its first change is autosaved there. */
export type DocOrigin = { kind: 'new' } | { kind: 'sample' } | { kind: 'server'; id: string } | { kind: 'file'; name: string } | { kind: 'recovered' };

export interface Selection {
  sceneId: string | null;
  /** Primary selection: what the inspector, popover and keying act on. Always one of elementIds when set. */
  elementId: string | null;
  /** Every selected element of the scene, primary included. */
  elementIds: string[];
}

/** Canvas tool (advanced editor): Select, or the Pen drawing new paths. */
export type CanvasTool = 'select' | 'pen';

/** Node editing of one path element. `nodes`: the selected node indices. */
export interface PathEditState {
  sceneId: string;
  elementId: string;
  nodes: number[];
}

/** The pen's path being drawn: composition pixels, to be added inside `parentId` (null = the scene's top level). */
export interface PenDraft {
  sceneId: string;
  parentId: string | null;
  nodes: PathNode[];
}

/** Live, uncommitted preview of elements while dragging (never in history). */
export interface TransientElement {
  sceneId: string;
  element: Element;
  /** Further elements moved by the same gesture (multi-selection). */
  others?: Element[];
}

/**
 * A live pointer gesture previewed outside `transient` (timeline bars, keys,
 * markers, audio clips, the curve editor, path tools). `stale()`: the
 * document changed or another one opened since the gesture began, so its
 * commit (built from what it captured then) must be dropped. `end()` is
 * idempotent.
 */
export interface GestureHandle {
  stale: () => boolean;
  end: () => void;
}

interface EditorState {
  doc: DocState;
  origin: DocOrigin;
  /** Revision the document had when it was opened/saved — used for dirty state and autosave. */
  cleanRevision: number;
  /**
   * Identifies one opened document. Changes on every loadDocument (open, import,
   * recover, new sample) so async work (saves, autosave timers) started for one
   * document never applies its effects to another.
   */
  docSession: string;
  /**
   * Who changed the document: how many of its changes in this document
   * session the person made (an edit, undo/redo, rollback, a restored
   * checkpoint, a proposal they applied). An agent's Auto-apply patch
   * (replaceDoc with `byAgent`) leaves it alone, so a document change that
   * doesn't move it was an agent's. Starts at 0 on every loadDocument.
   */
  userEdits: number;
  savedAt: string | null;
  selection: Selection;
  /** Selected keys of the selected element (advanced timeline). */
  selectedKeyframes: KeyRef[];
  /** Derived: the first selected transform key. Kept for code written before multi-key selection. */
  selectedKeyframe: { property: AnimatableProperty; frame: number } | null;
  playhead: number;
  /** Bumped when the UI (not the player) moves the playhead, so the player seeks. */
  seekNonce: number;
  playing: boolean;
  /** Timeline in/out range (view state for this document session; null = whole project). */
  workArea: WorkArea | null;
  /** Playback loops the work area. */
  loopWorkArea: boolean;
  editMode: EditMode;
  requests: EditRequest[];
  /** The expanded timeline (Timeline.tsx) is open under the stage. */
  timelineOpen: boolean;
  /** The inspector column is open for the scene itself (no element selected). An element selection always opens it. */
  sceneInspectorOpen: boolean;
  toasts: Toast[];
  transient: TransientElement | null;
  /** Live gestures registered with beginGesture; the agent bridge waits for none (and no transient). */
  gestures: number;
  server: ServerStatus;
  openDialog: boolean;
  /** Asset srcs the local server reported as missing on disk. */
  missingSrc: string[];
  /** The dialog open over the stage through `setSheet`, if any. */
  sheet: Sheet | null;
  /** Stage zoom and pan (view state: not in the document, not in history). */
  view: StageView;
  /** Space is held over the stage: dragging pans instead of editing. */
  handTool: boolean;
  tool: CanvasTool;
  pathEdit: PathEditState | null;
  penDraft: PenDraft | null;

  run: (command: Command, label?: string) => boolean;
  undo: () => void;
  redo: () => void;
  rollback: (revision: number) => CommandError | null;
  restoreCheckpoint: (checkpoint: Checkpoint) => CommandError | null;
  /** `byAgent`: an agent's patch committed by Auto-apply (agentBridge.ts), not the person's change. */
  replaceDoc: (doc: DocState, opts?: { byAgent?: boolean }) => void;
  loadDocument: (doc: DocState, origin: DocOrigin, savedAt?: string | null) => void;
  /**
   * Mark `file` (a completed save) as the clean state — only when `session` is
   * still the open document. Returns whether it applied.
   */
  markSavedIfCurrent: (session: string, file: ProjectFile) => boolean;
  select: (sel: Partial<Selection>) => void;
  selectElement: (sceneId: string, elementId: string | null) => void;
  /** Shift-click: add the element (it becomes primary) or take it out of the selection. */
  toggleElement: (sceneId: string, elementId: string) => void;
  /** Replace the selection; `primary` defaults to the last id. */
  selectMany: (sceneId: string, elementIds: string[], primary?: string | null) => void;
  selectKeyframe: (k: { property: AnimatableProperty; frame: number } | null) => void;
  selectKeyframes: (keys: KeyRef[]) => void;
  setWorkArea: (area: WorkArea | null) => void;
  setLoopWorkArea: (on: boolean) => void;
  seek: (frame: number) => void;
  syncPlayhead: (frame: number) => void;
  setPlaying: (playing: boolean) => void;
  setEditMode: (mode: EditMode) => void;
  setTimelineOpen: (open: boolean) => void;
  setSceneInspectorOpen: (open: boolean) => void;
  setTransient: (t: TransientElement | null) => void;
  /** Register a pointer gesture at its start; end it when it finishes however it finishes. */
  beginGesture: () => GestureHandle;
  setServer: (s: ServerStatus) => void;
  setOpenDialog: (open: boolean) => void;
  setSheet: (sheet: Sheet | null) => void;
  setView: (view: StageView) => void;
  setHandTool: (on: boolean) => void;
  /** Switching tools drops an unfinished pen path (PathEditor's setCanvasTool finishes it first) and leaves node editing for the pen. The pen clears the key selection (Delete / Backspace are its keys now). */
  setTool: (tool: CanvasTool) => void;
  /** Entering node editing clears the key selection (Delete / Backspace remove nodes now). */
  setPathEdit: (pathEdit: PathEditState | null) => void;
  setPenDraft: (draft: PenDraft | null) => void;
  addRequest: (instruction: string) => boolean;
  removeRequest: (id: string) => void;
  clearRequests: (ids: string[]) => void;
  toast: (t: Omit<Toast, 'id'>) => void;
  dismissToast: (id: number) => void;
}

let toastSeq = 1;
let sessionSeq = 0;
const sessionPrefix = Math.random().toString(36).slice(2, 8);
export const newDocSession = () => `${sessionPrefix}-${++sessionSeq}`;

function clampFrame(doc: DocState, frame: number): number {
  const total = projectDurationInFrames(doc.project);
  return Math.max(0, Math.min(Math.round(frame), Math.max(0, total - 1)));
}

/** Deduplicated ids with the primary among them; the primary falls back to the last id. */
function normalizeSelection(sceneId: string | null, ids: readonly string[], primary: string | null): Selection {
  const elementIds = [...new Set(ids)];
  if (primary && !elementIds.includes(primary)) elementIds.push(primary);
  return { sceneId, elementId: primary ?? elementIds[elementIds.length - 1] ?? null, elementIds };
}

/** Node editing ends when its path is gone (undo, delete, another document); selected indices stay in range. */
export function reconcilePathEdit(doc: DocState, pe: PathEditState | null): PathEditState | null {
  if (!pe) return null;
  const el = doc.project.scenes.find((s) => s.id === pe.sceneId)?.elements.find((e) => e.id === pe.elementId);
  if (!el || el.type !== 'path') return null;
  const count = Array.isArray(el.props.nodes) ? el.props.nodes.length : 0;
  const nodes = pe.nodes.filter((i) => i < count);
  return nodes.length === pe.nodes.length ? pe : { ...pe, nodes };
}

/** Keep selection valid after a document change (deleted scene/element, etc.). */
export function reconcileSelection(doc: DocState, playhead: number, sel: Selection): Selection {
  const loc = locateFrame(doc.project, playhead);
  const sceneId = loc?.scene.id ?? null;
  if (!sceneId) return { sceneId: null, elementId: null, elementIds: [] };
  if (sel.sceneId !== sceneId) return { sceneId, elementId: null, elementIds: [] };
  const scene = doc.project.scenes.find((s) => s.id === sceneId);
  const live = (id: string | null) => !!id && !!scene?.elements.some((e) => e.id === id);
  const elementIds = (sel.elementIds ?? []).filter(live);
  const next = normalizeSelection(sceneId, elementIds, live(sel.elementId) ? sel.elementId : null);
  // Unchanged selections keep their identity so subscribers don't re-render.
  return next.elementId === sel.elementId && next.elementIds.join() === (sel.elementIds ?? []).join() ? sel : next;
}

/** Key selection plus its derived single-key view (`selectedKeyframe`). */
function keySelection(keys: KeyRef[]): Pick<EditorState, 'selectedKeyframes' | 'selectedKeyframe'> {
  const first = keys.find((k) => isTransformTrack(k.track));
  return { selectedKeyframes: keys, selectedKeyframe: first && isTransformTrack(first.track) ? { property: first.track, frame: first.frame } : null };
}
const NO_KEYS = keySelection([]);

// A placeholder until bootProject (persistence.ts) opens the last project or a
// blank one, so nothing ever renders the sample before boot.
const initialDoc = createDocState(blankProject({ project: 'prj_boot', scene: 'scn_boot' }));

export const useEditor = create<EditorState>()((set, get) => ({
  doc: initialDoc,
  origin: { kind: 'new' },
  cleanRevision: initialDoc.project.revision,
  docSession: newDocSession(),
  userEdits: 0,
  savedAt: null,
  selection: { sceneId: initialDoc.project.scenes[0]?.id ?? null, elementId: null, elementIds: [] },
  ...NO_KEYS,
  playhead: 0,
  seekNonce: 0,
  playing: false,
  workArea: null,
  loopWorkArea: false,
  editMode: 'layout',
  requests: [],
  timelineOpen: false,
  sceneInspectorOpen: false,
  toasts: [],
  transient: null,
  gestures: 0,
  server: 'unknown',
  openDialog: false,
  missingSrc: [],
  sheet: null,
  view: FIT_VIEW,
  handTool: false,
  tool: 'select',
  pathEdit: null,
  penDraft: null,

  run: (command, label) => {
    const r = executeCommand(get().doc, command, label);
    if (!r.ok) {
      get().toast({ tone: 'error', message: r.error.message, hint: r.error.hint, path: r.error.path });
      return false;
    }
    const { playhead, selection } = get();
    const playheadNext = clampFrame(r.state, playhead);
    set({ doc: r.state, userEdits: get().userEdits + 1, playhead: playheadNext, selection: reconcileSelection(r.state, playheadNext, selection), transient: null, pathEdit: reconcilePathEdit(r.state, get().pathEdit) });
    return true;
  },
  undo: () => {
    const { doc } = get();
    if (!doc.undoStack.length) return;
    get().replaceDoc(coreUndo(doc));
  },
  redo: () => {
    const { doc } = get();
    if (!doc.redoStack.length) return;
    get().replaceDoc(coreRedo(doc));
  },
  rollback: (revision) => {
    const r = restoreRevision(get().doc, revision);
    if (!r.ok) return r.error;
    get().replaceDoc(r.state);
    return null;
  },
  restoreCheckpoint: (checkpoint) => {
    const parsed = parseProjectFile(checkpoint.file);
    if (!parsed.ok) return parsed.error;
    const r = restoreSnapshot(get().doc, parsed.value.project, `Restore checkpoint “${checkpoint.name}”`);
    if (!r.ok) return r.error;
    get().replaceDoc(r.state);
    return null;
  },
  replaceDoc: (doc, opts) => {
    const { playhead, selection, userEdits } = get();
    const p = clampFrame(doc, playhead);
    set({ doc, userEdits: opts?.byAgent ? userEdits : userEdits + 1, playhead: p, seekNonce: get().seekNonce + 1, selection: reconcileSelection(doc, p, selection), ...NO_KEYS, transient: null, pathEdit: reconcilePathEdit(doc, get().pathEdit) });
  },
  loadDocument: (doc, origin, savedAt = null) => {
    set({
      doc,
      origin,
      sheet: null,
      sceneInspectorOpen: false,
      cleanRevision: doc.project.revision,
      docSession: newDocSession(),
      userEdits: 0,
      savedAt,
      playhead: 0,
      seekNonce: get().seekNonce + 1,
      playing: false,
      selection: { sceneId: doc.project.scenes[0]?.id ?? null, elementId: null, elementIds: [] },
      ...NO_KEYS,
      workArea: null,
      transient: null,
      requests: [],
      view: FIT_VIEW,
      tool: 'select',
      pathEdit: null,
      penDraft: null,
    });
  },
  markSavedIfCurrent: (session, file) => {
    // A save reply for a document that is no longer open changes nothing here.
    if (get().docSession !== session || get().doc.project.id !== file.project.id) return false;
    // Only mark clean up to the saved revision: later edits stay dirty.
    set({ cleanRevision: file.project.revision, savedAt: file.savedAt, origin: { kind: 'server', id: file.project.id } });
    return true;
  },
  select: (sel) => {
    const merged = { ...get().selection, ...sel };
    // Setting only the primary (e.g. { elementId: null }) selects just that element.
    const ids = sel.elementIds ?? (sel.elementId !== undefined ? (sel.elementId ? [sel.elementId] : []) : merged.elementIds);
    set({ selection: normalizeSelection(merged.sceneId, ids, merged.elementId), ...NO_KEYS });
  },
  selectElement: (sceneId, elementId) => set({ selection: { sceneId, elementId, elementIds: elementId ? [elementId] : [] }, ...NO_KEYS }),
  toggleElement: (sceneId, elementId) => {
    const sel = get().selection;
    if (sel.sceneId !== sceneId) return get().selectElement(sceneId, elementId);
    if (!sel.elementIds.includes(elementId)) return set({ selection: normalizeSelection(sceneId, [...sel.elementIds, elementId], elementId), ...NO_KEYS });
    const rest = sel.elementIds.filter((id) => id !== elementId);
    set({ selection: normalizeSelection(sceneId, rest, sel.elementId === elementId ? null : sel.elementId), ...NO_KEYS });
  },
  selectMany: (sceneId, elementIds, primary = null) => set({ selection: normalizeSelection(sceneId, elementIds, primary), ...NO_KEYS }),
  selectKeyframe: (k) => set(keySelection(k ? [{ track: k.property, frame: k.frame }] : [])),
  selectKeyframes: (keys) => set(keySelection(keys)),
  setWorkArea: (workArea) => set({ workArea }),
  setLoopWorkArea: (loopWorkArea) => set({ loopWorkArea }),
  seek: (frame) => {
    const { doc, selection } = get();
    const p = clampFrame(doc, frame);
    set({ playhead: p, seekNonce: get().seekNonce + 1, selection: reconcileSelection(doc, p, selection) });
  },
  syncPlayhead: (frame) => {
    const { doc, selection, playhead } = get();
    if (frame === playhead) return;
    set({ playhead: frame, selection: reconcileSelection(doc, frame, selection) });
  },
  setPlaying: (playing) => set({ playing }),
  setEditMode: (editMode) => set({ editMode }),
  setTimelineOpen: (timelineOpen) => set({ timelineOpen }),
  setSceneInspectorOpen: (sceneInspectorOpen) => set({ sceneInspectorOpen }),
  setTransient: (transient) => set({ transient }),
  beginGesture: () => {
    const { docSession } = get();
    const revision = get().doc.project.revision;
    let live = true;
    set({ gestures: get().gestures + 1 });
    return {
      stale: () => get().docSession !== docSession || get().doc.project.revision !== revision,
      end: () => {
        if (!live) return;
        live = false;
        set({ gestures: Math.max(0, get().gestures - 1) });
      },
    };
  },
  setServer: (server) => {
    if (get().server !== server) set({ server });
  },
  setOpenDialog: (openDialog) => set({ openDialog }),
  setSheet: (sheet) => set({ sheet }),
  setView: (view) => set({ view }),
  setHandTool: (handTool) => {
    if (get().handTool !== handTool) set({ handTool });
  },
  setTool: (tool) => set({ tool, penDraft: null, pathEdit: tool === 'pen' ? null : get().pathEdit, ...(tool === 'pen' ? NO_KEYS : {}) }),
  setPathEdit: (pathEdit) => set({ pathEdit, ...(pathEdit && pathEdit.elementId !== get().pathEdit?.elementId ? NO_KEYS : {}) }),
  setPenDraft: (penDraft) => set({ penDraft }),
  addRequest: (instruction) => {
    const text = instruction.trim();
    const { selection, playhead } = get();
    if (!text || !selection.sceneId) return false;
    const req: EditRequest = { id: newId('req'), sceneId: selection.sceneId, elementId: selection.elementId ?? undefined, instruction: text, frame: playhead };
    set({ requests: [...get().requests, req] });
    return true;
  },
  removeRequest: (id) => set({ requests: get().requests.filter((r) => r.id !== id) }),
  clearRequests: (ids) => set({ requests: get().requests.filter((r) => !ids.includes(r.id)) }),
  toast: (t) => {
    const id = toastSeq++;
    const toasts = get().toasts;
    // The same message already on screen is refreshed in place (new id, new
    // timer) rather than stacked; the old id's timer then finds nothing.
    const same = toasts.findIndex((x) => x.tone === t.tone && x.message === t.message);
    set({ toasts: same >= 0 ? toasts.map((x, i) => (i === same ? { ...t, id } : x)) : [...toasts.slice(-3), { ...t, id }] });
    setTimeout(() => get().dismissToast(id), t.tone === 'error' ? 8000 : 4000);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
}));

// Derived helpers ------------------------------------------------------------

/** A stage drag (transient preview) or a registered timeline / curve / path gesture is live. */
export const editorBusy = (s: EditorState = useEditor.getState()) => !!s.transient || s.gestures > 0;

/**
 * Resolves true once no drag is in progress, so a change from outside (an
 * agent patch, delivered takes) never yanks an element out from under the
 * pointer. With `timeoutMs`, resolves false if the gesture outlasts it.
 */
export function whenEditorIdle(timeoutMs?: number): Promise<boolean> {
  if (!editorBusy()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = timeoutMs === undefined ? null : setTimeout(() => {
      unsubscribe();
      resolve(false);
    }, timeoutMs);
    const unsubscribe = useEditor.subscribe((s) => {
      if (editorBusy(s)) return;
      if (timer) clearTimeout(timer);
      unsubscribe();
      resolve(true);
    });
  });
}

export function useCurrentScene() {
  return useEditor((s) => s.doc.project.scenes.find((sc) => sc.id === s.selection.sceneId) ?? null);
}
