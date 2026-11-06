// Plain-language activity feed derived from revision history: who changed
// what, newest first. Pure, so it is easy to test and cheap to recompute.
// Proposals the user declined, or that went out of date, are listed too
// (applied ones already are, as revisions).

import type { ProposalSummary } from '../core/api-contract';
import type { GenerationEntry } from '../core/generation';
import type { DocState, Project, RevisionRecord, TouchedRef } from '../core/types';

export interface ActivityItem {
  key: string;
  /** The revision it made; absent for a proposal that was not applied. */
  revision?: number;
  /** "You", or the agent that made the change (e.g. "Codex"). */
  who: string;
  /** Made by an agent rather than by hand. */
  byAgent: boolean;
  text: string;
  at: number;
  /** The newest change on the undo stack: the feed offers ↶ for it. */
  undoable: boolean;
  /** A proposal that changed nothing: declined by the user, or out of date. */
  notApplied?: boolean;
  /** Generation activity: requested, approved, denied, blocked by the limit, imported. */
  generation?: GenerationEntry['kind'];
}

const RAW_LABELS: Record<string, string> = {
  updateElement: 'Edited',
  setKeyframe: 'Animated',
  removeKeyframe: 'Removed a keyframe on',
  addElement: 'Added',
  removeElement: 'Removed',
  moveElement: 'Reordered',
  updateScene: 'Edited scene',
  setSceneLock: 'Changed approval of',
  addScene: 'Added scene',
  removeScene: 'Removed scene',
  moveScene: 'Moved scene',
  updateProject: 'Renamed the project',
  addAsset: 'Added a file',
  replaceAsset: 'Replaced a file',
  addAudioClip: 'Added audio',
  updateAudioClip: 'Edited audio',
  removeAudioClip: 'Removed audio',
};

function nameOf(ref: TouchedRef | undefined, projects: Project[]): string | null {
  if (!ref) return null;
  for (const p of projects) {
    if (ref.kind === 'element') {
      const el = p.scenes.find((s) => s.id === ref.sceneId)?.elements.find((e) => e.id === ref.elementId);
      if (el) return `“${el.name}”`;
    }
    if (ref.kind === 'scene') {
      const sc = p.scenes.find((s) => s.id === ref.sceneId);
      if (sc) return `“${sc.name}”`;
    }
  }
  return null;
}

function describe(rec: RevisionRecord, previous: Project | undefined, preferPrevious = false): string {
  const undo = /^(Undo|Redo) (.*)$/.exec(rec.label);
  if (undo && (rec.source === 'undo' || rec.source === 'redo')) {
    return `${undo[1] === 'Undo' ? 'Undid' : 'Redid'}: ${describe({ ...rec, label: undo[2], source: 'user' }, previous, true)}`;
  }
  if (rec.source === 'ai') return agentLabel(rec.label).text;
  const verb = RAW_LABELS[rec.label];
  const ref = rec.touched.find((t) => t.kind === 'element') ?? rec.touched.find((t) => t.kind === 'scene');
  if (!verb) {
    // Editor labels ("Set size", "Nudge element") name the action, not the thing; add it.
    if (rec.label.includes('“')) return rec.label;
    const thing = nameOf(ref, previous ? [rec.snapshot, previous] : [rec.snapshot]);
    return thing ? `${rec.label} · ${thing}` : rec.label;
  }
  // Removed things only exist in the snapshot before the change; an undo is
  // named as the thing looked before it was undone.
  const order = previous ? (preferPrevious ? [previous, rec.snapshot] : [rec.snapshot, previous]) : [rec.snapshot];
  const name = nameOf(ref, order);
  return name ? `${verb} ${name}` : verb;
}

/**
 * Agent revisions are labelled "<agent>: <summary>" (e.g. "Codex: Bluer
 * background"); a patch the user pasted and applied is "You: …"; older pasted
 * patches and revisions use "AI: …" and are credited to "Agent".
 */
export function agentLabel(label: string): { who: string; text: string } {
  const m = /^([^:\n]{1,40}):\s+([\s\S]*)$/.exec(label);
  if (!m) return { who: 'Agent', text: label };
  return { who: m[1] === 'AI' ? 'Agent' : m[1], text: m[2] };
}

export function activityItems(doc: DocState, limit = 40): ActivityItem[] {
  const top = doc.undoStack[doc.undoStack.length - 1];
  const undoableRevision = top ? top.afterRevision : null;
  const out: ActivityItem[] = [];
  for (let i = doc.revisions.length - 1; i >= 0 && out.length < limit; i--) {
    const rec = doc.revisions[i];
    if (rec.source === 'load') continue;
    const who = rec.source === 'ai' ? agentLabel(rec.label).who : 'You';
    out.push({
      key: `r${rec.revision}`,
      revision: rec.revision,
      who,
      byAgent: who !== 'You',
      text: describe(rec, doc.revisions[i - 1]?.snapshot),
      at: rec.at,
      undoable: rec.revision === undoableRevision,
    });
  }
  return out;
}

/** Declined and out-of-date proposals, merged into `items` by time (newest first). */
export function withProposals(items: ActivityItem[], log: ProposalSummary[], limit = 40): ActivityItem[] {
  const extra: ActivityItem[] = [];
  for (const p of log) {
    if (p.status !== 'cancelled' && p.status !== 'stale') continue;
    const pasted = p.agent === 'You';
    const at = p.decidedAt ?? p.createdAt;
    if (p.status === 'cancelled') {
      extra.push({ key: `p${p.id}`, who: 'You', byAgent: false, text: `Declined ${pasted ? 'a pasted patch' : `${p.agent}’s proposal`}: ${p.summary}`, at, undoable: false, notApplied: true });
    } else {
      extra.push({ key: `p${p.id}`, who: pasted ? 'You' : p.agent, byAgent: !pasted, text: `Proposal went out of date: ${p.summary}`, at, undoable: false, notApplied: true });
    }
  }
  if (!extra.length) return items;
  return [...items, ...extra].sort((a, b) => b.at - a.at).slice(0, limit);
}

/** "just now", "2 min ago", "1 h ago". */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.round(m / 60)} h ago`;
}

const by = (e: GenerationEntry) => (e.provider ? ` with ${e.provider}` : '');
const counted = (e: GenerationEntry) => (e.usedToday !== undefined && e.dailyLimit !== undefined ? ` (${e.usedToday} of ${e.dailyLimit} today)` : '');

/** One generation entry in the feed's words. Approvals and denials are the user's; requests and imports the agent's. */
export function generationItem(e: GenerationEntry): ActivityItem {
  const what = e.title.replace(/^Generate /, '');
  const base = { key: `g${e.id}`, at: e.at, undoable: false, generation: e.kind };
  switch (e.kind) {
    case 'requested':
      return { ...base, who: e.agent, byAgent: true, text: `Asked to generate ${what}${by(e)}${counted(e)}` };
    case 'approved':
      return { ...base, who: 'You', byAgent: false, text: `Approved a generation${by(e)}: ${what}${counted(e)}` };
    case 'denied':
      return { ...base, who: 'You', byAgent: false, notApplied: true, text: `Declined a generation${by(e)}: ${what}${e.reason && e.reason !== 'denied' ? ` (${e.reason})` : ''}` };
    case 'limit':
      return { ...base, who: e.agent, byAgent: true, notApplied: true, text: `Daily generation limit reached; not generated: ${what}${counted(e)}` };
    case 'imported':
      return { ...base, who: e.agent, byAgent: true, text: e.title };
  }
}

/** Generation entries merged into `items` by time (newest first). */
export function withGenerations(items: ActivityItem[], entries: GenerationEntry[], limit = 40): ActivityItem[] {
  if (!entries.length) return items;
  return [...items, ...entries.map(generationItem)].sort((a, b) => b.at - a.at).slice(0, limit);
}
