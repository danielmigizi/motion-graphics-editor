// Document state: current project + undo/redo + revision log.
//
// Semantics:
// - Every committed change (execute, undo, redo, rollback, applied patch)
//   produces a NEW revision = previous + 1. Revisions never go backwards, so a
//   patch based on an older revision is detectably stale even after undo.
// - A batch command is one undo step and one revision.
// - Every revision record carries the refs it touched. Undo/redo/rollback
//   records carry the refs that actually changed between the two documents
//   (so `touchedSince` stays precise for patch reconcile).

import { applyCommand, compositionDependencies, dedupeTouched, renderedAssetEqual, sceneAssetIds } from './commands';
import { deepEqual, diffProjects } from './diff';
import { parseProjectFile, validateProject } from './validate';
import type {
  Command,
  CommandSource,
  DocResult,
  DocState,
  Project,
  ProjectFile,
  RevisionRecord,
  RevisionSource,
  Scene,
  TouchedRef,
  UndoEntry,
} from './types';

export const MAX_REVISIONS = 100;
export const MAX_UNDO = 200;
/** Revision records written into a saved ProjectFile. */
export const SAVED_REVISIONS = 30;

export function createDocState(project: Project, revisions: RevisionRecord[] = []): DocState {
  const log = revisions.length
    ? revisions
    : [{ revision: project.revision, label: 'Opened', source: 'load' as const, touched: [], snapshot: project, at: Date.now() }];
  return { project, undoStack: [], redoStack: [], revisions: log };
}

function commit(state: DocState, next: Project, label: string, source: RevisionSource, touched: TouchedRef[]): DocState {
  const revision = state.project.revision + 1;
  const project = { ...next, revision };
  const record: RevisionRecord = { revision, label, source, touched, snapshot: project, at: Date.now() };
  return { ...state, project, revisions: [...state.revisions, record].slice(-MAX_REVISIONS) };
}

function pushUndo(stack: UndoEntry[], entry: UndoEntry): UndoEntry[] {
  return [...stack, entry].slice(-MAX_UNDO);
}

/** Refs whose content differs between two documents (ID-based). Scene order changes are project-level. */
export function touchedBetween(before: Project, after: Project): TouchedRef[] {
  const out: TouchedRef[] = [];
  for (const c of diffProjects(before, after)) {
    if (c.kind === 'marker' || c.kind === 'project' || (c.kind === 'scene' && c.path === 'order')) out.push({ kind: 'project' });
    else if (c.kind === 'scene' && c.sceneId) out.push({ kind: 'scene', sceneId: c.sceneId });
    else if (c.kind === 'element' && c.sceneId && c.elementId) out.push({ kind: 'element', sceneId: c.sceneId, elementId: c.elementId });
  }
  for (const id of new Set([...Object.keys(before.compositions), ...Object.keys(after.compositions)])) {
    if (!deepEqual(before.compositions[id], after.compositions[id])) out.push({ kind: 'composition', compositionId: id });
  }
  if (before.assets !== after.assets) {
    for (const id of new Set([...Object.keys(before.assets), ...Object.keys(after.assets)])) {
      if (!deepEqual(before.assets[id], after.assets[id])) out.push({ kind: 'asset', assetId: id });
    }
  }
  if (before.audio !== after.audio) {
    const b = new Map(before.audio.map((c) => [c.id, c]));
    const a = new Map(after.audio.map((c) => [c.id, c]));
    for (const id of new Set([...b.keys(), ...a.keys()])) {
      if (!deepEqual(b.get(id), a.get(id))) out.push({ kind: 'audio', clipId: id });
    }
  }
  return dedupeTouched(out);
}

export function commandLabel(command: Command): string {
  return command.type === 'batch' ? command.label : command.type;
}

/**
 * Commit an already-validated next project as one revision and one undo step.
 * Used by execute() and by patch application (which validates via checkPatch).
 */
export function commitChange(state: DocState, next: Project, label: string, source: CommandSource, touched: TouchedRef[]): DocState {
  const committed = commit(state, next, label, source, touched);
  return {
    ...committed,
    undoStack: pushUndo(state.undoStack, {
      label,
      beforeRevision: state.project.revision,
      afterRevision: committed.project.revision,
      before: state.project,
      after: committed.project,
    }),
    redoStack: [],
  };
}

export function execute(state: DocState, command: Command, source: CommandSource = 'user', label?: string): DocResult {
  const r = applyCommand(state.project, command, { source });
  if (!r.ok) return r;
  // A command that changes nothing (same value, same index) commits no revision and no undo step.
  if (r.project === state.project || diffProjects(state.project, r.project).length === 0) return { ok: true, state };
  return { ok: true, state: commitChange(state, r.project, label ?? commandLabel(command), source, r.touched) };
}

export const canUndo = (s: DocState) => s.undoStack.length > 0;
export const canRedo = (s: DocState) => s.redoStack.length > 0;

export function undo(state: DocState): DocState {
  const entry = state.undoStack[state.undoStack.length - 1];
  if (!entry) return state;
  const next = commit(state, entry.before, `Undo ${entry.label}`, 'undo', touchedBetween(state.project, entry.before));
  return { ...next, undoStack: state.undoStack.slice(0, -1), redoStack: [...state.redoStack, entry] };
}

export function redo(state: DocState): DocState {
  const entry = state.redoStack[state.redoStack.length - 1];
  if (!entry) return state;
  const next = commit(state, entry.after, `Redo ${entry.label}`, 'redo', touchedBetween(state.project, entry.after));
  return { ...next, redoStack: state.redoStack.slice(0, -1), undoStack: pushUndo(state.undoStack, entry) };
}

/** Roll the document back to the content of an earlier revision, as a new revision (undoable). */
export function restoreRevision(state: DocState, revision: number): DocResult {
  const rec = state.revisions.find((r) => r.revision === revision);
  if (!rec) return { ok: false, error: { code: 'NOT_FOUND', message: `Revision ${revision} is not in history`, hint: 'Only the most recent revisions are kept.' } };
  return restoreSnapshot(state, rec.snapshot, `Rollback to r${revision}`);
}

/** Restore external snapshot through the same validation, scene locks and undo path as rollback. */
export function restoreSnapshot(state: DocState, target: Project, label: string): DocResult {
  if (target.id !== state.project.id) {
    return {
      ok: false,
      error: {
        code: 'PROJECT_MISMATCH',
        message: `Snapshot belongs to project ${target.id}, not the open project ${state.project.id}; it cannot be restored.`,
      },
    };
  }
  const valid = validateProject(target);
  if (!valid.ok) return { ok: false, error: { ...valid.error, message: `Snapshot cannot be restored: ${valid.error.message}` } };
  const blocked = lockedScenesChangedBy(state.project, target);
  if (blocked.length) {
    const names = blocked.map((sc) => `"${sc.name}" (${sc.id})`).join(', ');
    return {
      ok: false,
      error: {
        code: 'LOCKED',
        message: `${label} would change locked scene${blocked.length > 1 ? 's' : ''} ${names}. Unlock ${blocked.length > 1 ? 'them' : 'it'} first, then roll back.`,
        hint: 'Approved scenes are locked; unlock the scene in the editor, then retry.',
      },
    };
  }
  const touched = touchedBetween(state.project, target);
  const next = commit(state, target, label, 'rollback', touched);
  return {
    ok: true,
    state: {
      ...next,
      undoStack: pushUndo(state.undoStack, { label, beforeRevision: state.project.revision, afterRevision: next.project.revision, before: state.project, after: next.project }),
      redoStack: [],
    },
  };
}

/**
 * Scenes locked in `current` whose rendered content would differ in `target`:
 * the scene's own fields, elements and lock flag, its anchored audio clips,
 * and the rendered content (all but `name`) of every asset its elements or
 * anchored clips reference.
 * (Scene order is not part of a lock: moving a locked scene is allowed.)
 */
export function lockedScenesChangedBy(current: Project, target: Project): Scene[] {
  const out: Scene[] = [];
  for (const scene of current.scenes) {
    if (!scene.locked) continue;
    const other = target.scenes.find((s) => s.id === scene.id);
    let changed = !other || !deepEqual(scene, other);
    if (!changed) {
      const anchored = (p: Project) => p.audio.filter((c) => c.sceneId === scene.id).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      changed = !deepEqual(anchored(current), anchored(target));
    }
    if (!changed) {
      for (const assetId of sceneAssetIds(current, scene)) {
        if (!renderedAssetEqual(current.assets[assetId], target.assets[assetId])) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) {
      changed = current.width !== target.width || current.height !== target.height || current.fps !== target.fps;
      for (const id of compositionDependencies(current, scene.elements)) if (!deepEqual(current.compositions[id], target.compositions[id])) changed = true;
    }
    if (changed) out.push(scene);
  }
  return out;
}

/**
 * Union of refs touched by every revision after `revision` (exclusive) up to
 * the current one. Returns null when the log no longer reaches back that far
 * (or `revision` is in the future) — callers must then treat everything as
 * possibly changed.
 */
export function touchedSince(state: DocState, revision: number): TouchedRef[] | null {
  const current = state.project.revision;
  if (!Number.isInteger(revision) || revision > current) return null;
  if (revision === current) return [];
  const byRev = new Map(state.revisions.map((r) => [r.revision, r]));
  // The base revision itself must be in the log: the oldest record has no
  // verified predecessor (after a load or log trimming), so what it changed
  // cannot be trusted for reconcile.
  if (!byRev.has(revision)) return null;
  const out: TouchedRef[] = [];
  for (let r = revision + 1; r <= current; r++) {
    const rec = byRev.get(r);
    // A 'load' record has no knowledge of what changed before the document was opened.
    if (!rec || rec.source === 'load') return null;
    out.push(...rec.touched);
  }
  return dedupeTouched(out);
}

/** Snapshot for saving to disk: current project plus the last SAVED_REVISIONS revision records. */
export function serializeDoc(state: DocState): ProjectFile {
  return {
    format: 'mge.project/1',
    project: state.project,
    revisions: state.revisions.slice(-SAVED_REVISIONS),
    savedAt: new Date().toISOString(),
  };
}

/**
 * Validate a ProjectFile and open it. Undo/redo start empty; the revision log
 * is kept. parseProjectFile has already checked history consistency (same
 * project id, record.revision === snapshot.revision, strictly increasing,
 * ≤ current, last record matches the project). Stored `touched` lists are
 * never trusted: each record's refs are recomputed from the previous loaded
 * snapshot; the first loaded record (and any record after a gap) has no
 * verified predecessor and gets none, and touchedSince refuses to reconcile
 * across it.
 */
export function loadDoc(file: unknown): DocResult {
  const parsed = parseProjectFile(file);
  if (!parsed.ok) return parsed;
  const { project } = parsed.value;
  const revisions: RevisionRecord[] = parsed.value.revisions.map((rec, i, all) => {
    const prev = all[i - 1];
    const touched = prev && prev.revision === rec.revision - 1 ? touchedBetween(prev.snapshot, rec.snapshot) : [];
    return { ...rec, touched };
  });
  const last = revisions[revisions.length - 1];
  if (!last || last.revision !== project.revision) {
    revisions.push({ revision: project.revision, label: 'Opened', source: 'load', touched: [], snapshot: project, at: Date.now() });
  }
  return { ok: true, state: createDocState(project, revisions.slice(-MAX_REVISIONS)) };
}
