// What happens to studio takes after they arrive: placed in the video,
// replaced by something else, or deleted. The tracker diffs each document
// change and reports the implied outcomes to the local server, which keeps
// them on the job's record (Balanced routing learns from them later). Only
// studio takes count: provenance.requestId 'gjob_…'. Undo and redo are not
// decisions about a take, and neither is an agent's Auto-apply patch, so
// they report nothing; the server keeps one of each
// event per take. Auditions and ratings are reported where they happen
// (TakesPanel.tsx).

import { COMPONENTS } from '../core/components';
import type { OutcomeReport } from '../core/generationStudio';
import { takeUsage } from '../core/takeUsage';
import type { DocState, Element, Project } from '../core/types';
import { api } from './api';
import { useEditor } from './store';

/** Studio takes in `project`: asset id → job id. */
function studioTakes(project: Project): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of Object.values(project.assets)) {
    const job = a.provenance?.requestId;
    if (job?.startsWith('gjob_')) m.set(a.id, job);
  }
  return m;
}

/** Every place an asset shows: an element's asset field (in a scene or a reusable component) or an audio clip → the asset there. */
function placements(project: Project): Map<string, string> {
  const m = new Map<string, string>();
  const scan = (where: string, elements: Element[]) => {
    for (const el of elements) {
      for (const f of COMPONENTS[el.type]?.fields ?? []) {
        const id = el.props[f.key];
        if (f.kind === 'asset' && typeof id === 'string' && id) m.set(`${where}${el.id}/${f.key}`, id);
      }
    }
  };
  for (const s of project.scenes) scan('', s.elements);
  for (const [id, c] of Object.entries(project.compositions)) scan(`component:${id}/`, c.elements);
  for (const c of project.audio) if (c.assetId) m.set(`audio:${c.id}`, c.assetId);
  return m;
}

/**
 * Outcome events implied by a project change, for studio takes only. Pure.
 * - deleted: the take left the project (and nothing else is said about it).
 * - used: the take went into the video, having been in it nowhere.
 * - replaced: a place that showed the take now shows another asset (any job's
 *   take, an upload) and the take is in the video nowhere else.
 */
export function outcomeEvents(prev: Project, next: Project): OutcomeReport[] {
  const before = studioTakes(prev);
  const after = studioTakes(next);
  if (!before.size && !after.size) return [];
  const usedBefore = takeUsage(prev);
  const usedAfter = takeUsage(next);
  const out: OutcomeReport[] = [];

  for (const [assetId, jobId] of before) if (!after.has(assetId)) out.push({ jobId, assetId, event: 'deleted' });

  for (const [assetId, jobId] of after) {
    if ((usedBefore.get(assetId) ?? 0) === 0 && (usedAfter.get(assetId) ?? 0) > 0) out.push({ jobId, assetId, event: 'used' });
  }

  const now = placements(next);
  const replaced = new Set<string>();
  for (const [place, assetId] of placements(prev)) {
    const jobId = after.get(assetId);
    const shown = now.get(place);
    if (!jobId || replaced.has(assetId) || !shown || shown === assetId) continue;
    if ((usedBefore.get(assetId) ?? 0) > 0 && (usedAfter.get(assetId) ?? 0) === 0) {
      replaced.add(assetId);
      out.push({ jobId, assetId, event: 'replaced' });
    }
  }
  return out;
}

/** The change is an undo (the top undo entry moved to the redo stack) or a redo (the reverse). */
export function isUndoOrRedo(prev: DocState, next: DocState): boolean {
  const undid = next.redoStack.length === prev.redoStack.length + 1 && next.redoStack.at(-1) === prev.undoStack.at(-1);
  const redid = next.redoStack.length === prev.redoStack.length - 1 && next.undoStack.at(-1) === prev.redoStack.at(-1);
  return undid || redid;
}

/**
 * Subscribes to the open document; posts outcomeEvents with api.reportOutcome (fire-and-forget, errors ignored). Returns the unsubscribe.
 * Skips document loads/switches (a different project id, or a new docSession), undo and redo, and an agent's Auto-apply patch: outcomes
 * feed the scoreboard and route suggestions, which learn from the person's choices only (a proposal they apply counts as theirs).
 */
export function installOutcomeTracker(): () => void {
  return useEditor.subscribe((s, prev) => {
    if (s.doc.project === prev.doc.project) return;
    if (s.docSession !== prev.docSession || s.doc.project.id !== prev.doc.project.id) return;
    // The person's changes count in store.userEdits; a change that leaves it alone was an agent's.
    if (s.userEdits === prev.userEdits) return;
    if (isUndoOrRedo(prev.doc, s.doc)) return;
    for (const report of outcomeEvents(prev.doc.project, s.doc.project)) void api.reportOutcome(report).catch(() => undefined);
  });
}
