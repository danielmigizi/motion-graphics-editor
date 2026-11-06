// Proposal review state, kept apart from the document store. An agent edit (or
// a pasted patch) waits here as a proposal: the review renders the current
// document and the candidate side by side, and nothing reaches `useEditor`'s
// document, history, saves or autosave until the user Applies it, which
// re-checks against the latest document and commits ONE revision.
//
// One pending proposal per project. A newer proposal from the same agent (or a
// pasted patch) replaces it; another agent gets PROPOSAL_PENDING. Every
// outcome (applied, cancelled, stale, replaced) goes into `log`, which the
// agent bridge reports as EditorContext.proposalLog. The log stays in memory:
// agents receive outcomes through context or their next chat turn.

import { api, ApiRequestError, errorText } from './api';
import { validateProposal } from '../core/savedProposal';
import { newId } from '../core/ids';
import { create } from 'zustand';
import type { BridgeError, ProposalSource, ProposalStatus, ProposalSummary } from '../core/api-contract';
import { applyPatch, isSceneTarget } from '../core/patch';
import { checkProposal, listNames, targetName, type Proposal, type ProposalCheck } from '../core/proposal';
import { sceneStartFrame } from '../core/timing';
import type { AiPatch, ChangeEntry, Project } from '../core/types';
import { useRecovery } from './persistence';
import { useEditor, type Selection } from './store';
import { openExport } from './ExportPopover';

export type ReviewView = 'proposed' | 'current' | 'split';

/** Decided proposals kept for the agent (newest first). */
export const PROPOSAL_LOG_SIZE = 10;

/** Who a pasted patch is credited to. */
export const PASTED_BY = 'You';
/** Who a take placed from the Takes panel ("Use this take") is credited to: the person, like a pasted patch, worded as a take. */
export const TAKE_BY = 'You (generated take)';

/** The person's own proposal (a pasted patch or a generated take): there is no agent to ask, and its review is enough. */
export const byYou = (agent: string) => agent === PASTED_BY || agent === TAKE_BY;

const AUTO_APPLY_KEY = 'mge.autoApply';
function readAutoApply(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem(AUTO_APPLY_KEY) === 'true';
  } catch {
    return false;
  }
}

export interface ProposeOptions {
  agent: string;
  model?: string;
  source: ProposalSource;
  /** Rebase a patch written against an older revision when none of its targets changed since. */
  reconcile?: boolean;
}

export type ProposeResult = { ok: true; summary: ProposalSummary; replaced?: ProposalSummary; diff: ChangeEntry[] } | { ok: false; error: BridgeError };

export type ApplyResult = { ok: true; revision: number } | { ok: false; error: BridgeError };

interface ProposalsState {
  /** The proposal on show: pending while `check` is ready, otherwise kept only to explain why it can't apply. */
  proposal: Proposal | null;
  /** Latest checkProposal result against the open document. */
  check: ProposalCheck | null;
  /** The review takes over the stage. */
  open: boolean;
  view: ReviewView;
  /** Decided proposals, newest first. */
  log: ProposalSummary[];
  /** Agent edits apply at once (chat panel switch, off by default). */
  autoApply: boolean;
  /** Where the user was before the review opened; Cancel and Back to editing return there. */
  returnTo: { selection: Selection; playhead: number; docSession: string } | null;
  /** The pending proposal the current one replaced, for a short note in the review. */
  replaced: ProposalSummary | null;

  propose: (patch: AiPatch, opts: ProposeOptions) => ProposeResult;
  apply: () => ApplyResult;
  /** Decline the pending proposal, or dismiss one that went stale. */
  cancel: () => void;
  openReview: () => void;
  /** Back to editing: the proposal stays pending. */
  closeReview: () => void;
  setView: (view: ReviewView) => void;
  setAutoApply: (on: boolean) => void;
}

const proposalId = () => newId('prop');

/** The bridge's view of a proposal. */
export function summary(p: Proposal, status: ProposalStatus = 'pending', extra: Partial<ProposalSummary> = {}): ProposalSummary {
  return {
    id: p.id,
    projectId: p.projectId,
    agent: p.agent,
    ...(p.model ? { model: p.model } : {}),
    source: p.source,
    summary: p.patch.summary,
    baseRevision: p.patch.baseRevision,
    status,
    createdAt: p.createdAt,
    ...extra,
  };
}

const decided = (p: Proposal, status: Exclude<ProposalStatus, 'pending'>, extra: Partial<ProposalSummary> = {}) => summary(p, status, { decidedAt: Date.now(), ...extra });

const logged = (log: ProposalSummary[], entry: ProposalSummary) => [entry, ...log].slice(0, PROPOSAL_LOG_SIZE);

/** "Codex's proposal" / "Your pasted patch" / "Your generated take". */
export function whose(agent: string): string {
  return agent === PASTED_BY ? 'Your pasted patch' : agent === TAKE_BY ? 'Your generated take' : `${agent}’s proposal`;
}

const isPending = (s: Pick<ProposalsState, 'proposal' | 'check'>) => !!s.proposal && s.check?.status === 'ready';

/** The pending proposal for the bridge, or null. */
export function pendingSummary(): ProposalSummary | null {
  const s = useProposals.getState();
  return isPending(s) ? summary(s.proposal!) : null;
}

/** Plain-words reason a proposal can no longer apply, for the agent (names and ids). */
export function staleReason(check: Exclude<ProposalCheck, { status: 'ready' }>, project: Project): string {
  if (check.status === 'stale' && check.conflicts?.length) {
    const names = listNames(check.conflicts.map((t) => targetName(project, t)));
    const ids = check.conflicts.map((t) => (!isSceneTarget(t) ? 'audio:project' : t.elementId ? `${t.sceneId}/${t.elementId}` : t.sceneId)).join(', ');
    return `${names} changed after it was proposed (${ids}).`;
  }
  return check.error.message;
}

const ANOTHER_PROJECT = 'Another project was opened.';

/** The document session whose saved proposal is being restored: agents wait until it is back. */
let restoring: string | null = null;
/**
 * Document sessions whose saved proposal could not be loaded for a passing reason (server
 * down or failing): agents can't take its slot. A retry runs at most every 5 s, and the
 * person sees one toast per session.
 */
const restoreFailed = new Set<string>();
let lastRetry = 0;
const toasted = new Set<string>();
/** Pasted patches whose saved copy the server confirmed: only those are safe to leave behind on a switch. */
const confirmed = new Set<string>();

/**
 * Why an agent may not change the document right now, or null. Agents wait while a
 * saved proposal is being restored, and while the person's own pasted patch or
 * generated take waits for review (an agent change could make it stale and drop it).
 */
export function agentChangeBlocked(): { code: 'PROPOSAL_PENDING'; message: string; hint: string } | null {
  const st = useEditor.getState();
  if (restoring === st.docSession) return { code: 'PROPOSAL_PENDING', message: 'The editor is still restoring a saved proposal for this project.', hint: 'Try again in a moment (editor_proposal_status).' };
  if (restoreFailed.has(st.docSession)) {
    // Try loading it again; once it is back (or known to be absent) agents may go on.
    if (Date.now() - lastRetry > 5000) {
      lastRetry = Date.now();
      void restoreServerProposal();
    }
    return { code: 'PROPOSAL_PENDING', message: 'The editor could not load this project\u2019s saved proposal yet, so it won\u2019t replace it.', hint: 'Try again in a moment.' };
  }
  const s = useProposals.getState();
  // Pending or gone stale, the person's own patch on this document stays on show (and saved) until they
  // dismiss it. One left over from another project is kept safe only if the server has its copy
  // (it returns with that project); otherwise it still blocks, so a new proposal can't replace it.
  if (s.proposal && s.proposal.source === 'paste' && (s.proposal.docSession === st.docSession || !confirmed.has(s.proposal.id))) {
    return { code: 'PROPOSAL_PENDING', message: `${whose(s.proposal.agent)} is waiting for the user’s review.`, hint: 'Wait until the user applies or cancels it (editor_proposal_status), then try again.' };
  }
  return null;
}

/**
 * A pending proposal can no longer apply: log it, and keep it on show to explain why.
 * Opening another project (which an agent can do) keeps its saved copy on the server:
 * it belongs to its own project and comes back when that project is opened again.
 */
function markStale(p: Proposal, check: Exclude<ProposalCheck, { status: 'ready' }>, reason: string) {
  // The person's own pasted patch or generated take keeps its saved copy until they discard it:
  // an agent's save or reload must not be able to throw it away.
  if (reason !== ANOTHER_PROJECT && p.source !== 'paste') forgetProposal(p);
  useProposals.setState((s) => ({ check, log: logged(s.log, decided(p, 'stale', { reason })) }));
}

const anotherProject = (): Exclude<ProposalCheck, { status: 'ready' }> => ({ status: 'stale', error: { code: 'STALE', message: ANOTHER_PROJECT } });

export const useProposals = create<ProposalsState>()((set, get) => {
  /** Return to where the user was before the review, if it is still the same document. */
  const restore = (returnTo: ProposalsState['returnTo']) => {
    const st = useEditor.getState();
    st.setPlaying(false);
    if (!returnTo || returnTo.docSession !== st.docSession) return;
    st.seek(returnTo.playhead);
    const { sceneId, elementId } = returnTo.selection;
    const now = useEditor.getState();
    // seek() selected the scene at the playhead; restore the element if it is still there.
    if (!sceneId || now.selection.sceneId !== sceneId) return;
    const still = !!elementId && !!now.doc.project.scenes.find((s) => s.id === sceneId)?.elements.some((e) => e.id === elementId);
    now.selectElement(sceneId, still ? elementId : null);
  };

  return {
    proposal: null,
    check: null,
    open: false,
    // The review opens on Current and Proposed side by side.
    view: 'split',
    log: [],
    autoApply: readAutoApply(),
    returnTo: null,
    replaced: null,

    propose: (patch, { agent, model, source, reconcile = false }) => {
      const st = useEditor.getState();
      const s = get();
      const pending = isPending(s) ? s.proposal! : null;
      if (source !== 'paste') {
        const blocked = agentChangeBlocked();
        if (blocked) return { ok: false, error: blocked };
      }
      // An agent may replace only its own pending proposal, never one the person pasted or a generated take.
      if (pending && source !== 'paste' && (pending.agent !== agent || pending.source === 'paste')) {
        return {
          ok: false,
          error: {
            code: 'PROPOSAL_PENDING',
            message: `${whose(pending.agent)} is waiting for the user’s review.`,
            hint: 'Wait until the user applies or cancels it (editor_proposal_status), then try again.',
          },
        };
      }
      const p: Proposal = { id: proposalId(), projectId: patch.projectId, docSession: st.docSession, patch, agent, ...(model ? { model } : {}), source, reconcile, createdAt: Date.now() };
      const check = checkProposal(st.doc, p);
      // Invalid, locked, wrong-project, out-of-scope and stale patches never become a candidate.
      if (check.status !== 'ready') return { ok: false, error: check.error };
      // Accepted: from now on, edits elsewhere rebase it and an edit to a target makes it stale.
      const stored: Proposal = { ...p, reconcile: true };
      const replaced = pending ? decided(pending, 'replaced', { reason: agent === TAKE_BY ? 'Replaced by a generated take' : source === 'paste' ? 'Replaced by a pasted patch' : `Replaced by a newer proposal from ${agent}` }) : undefined;
      if (pending) forgetProposal(pending);
      persistProposal(stored);
      set({ proposal: stored, check, replaced: replaced ?? null, log: replaced ? logged(s.log, replaced) : s.log });
      return { ok: true, summary: summary(stored), ...(replaced ? { replaced } : {}), diff: check.diff };
    },

    apply: () => {
      const { proposal, check: shown } = get();
      if (!proposal) return { ok: false, error: { code: 'NOT_FOUND', message: 'There is no proposal to apply.' } };
      // Once out of date it stays that way: it was already reported to the agent as stale.
      if (shown?.status !== 'ready') return { ok: false, error: shown?.error ?? { code: 'STALE', message: 'This proposal is out of date.' } };
      const st = useEditor.getState();
      if (st.docSession !== proposal.docSession) {
        const gone = anotherProject();
        markStale(proposal, gone, ANOTHER_PROJECT);
        return { ok: false, error: gone.error };
      }
      // Re-check against the latest document: nothing may slip in between review and apply.
      const check = checkProposal(st.doc, proposal);
      if (check.status !== 'ready') {
        markStale(proposal, check, staleReason(check, st.doc.project));
        return { ok: false, error: check.error };
      }
      const r = applyPatch(st.doc, proposal.patch, { reconcile: proposal.reconcile, actor: proposal.agent });
      if (!r.ok) return { ok: false, error: r.error };
      const revision = r.state.project.revision;
      forgetProposal(proposal);
      // Clear first, so the document change below never re-checks an applied proposal.
      set({ proposal: null, check: null, open: false, returnTo: null, replaced: null, log: logged(get().log, decided(proposal, 'applied', { revision })) });
      st.setPlaying(false);
      st.replaceDoc(r.state);
      const targets = proposal.patch.targets.filter(isSceneTarget);
      const done = st.requests.filter((q) => targets.some((t) => t.sceneId === q.sceneId && (!t.elementId || t.elementId === q.elementId))).map((q) => q.id);
      if (done.length) st.clearRequests(done);
      pointAtChange(proposal.patch);
      st.toast({
        tone: 'success',
        message: `Applied “${proposal.patch.summary}” as r${revision}.`,
        hint: `Undo with ⌘Z${done.length ? ` · cleared ${done.length} matching request${done.length > 1 ? 's' : ''}` : ''}`,
      });
      return { ok: true, revision };
    },

    cancel: () => {
      const s = get();
      if (!s.proposal) return;
      forgetProposal(s.proposal);
      set({
        proposal: null,
        check: null,
        open: false,
        returnTo: null,
        replaced: null,
        // A stale one was logged when it went stale; dismissing it says nothing new.
        log: isPending(s) ? logged(s.log, decided(s.proposal, 'cancelled')) : s.log,
      });
      if (s.open) restore(s.returnTo);
    },

    openReview: () => {
      // A sheet or the Export popover would cover the review.
      useEditor.getState().setSheet(null);
      openExport(false);
      const s = get();
      if (!s.proposal || s.open) return;
      const st = useEditor.getState();
      set({ open: true, returnTo: { selection: { ...st.selection }, playhead: st.playhead, docSession: st.docSession } });
    },

    closeReview: () => {
      const s = get();
      if (!s.open) return;
      set({ open: false, returnTo: null });
      restore(s.returnTo);
    },

    setView: (view) => set({ view }),

    setAutoApply: (autoApply) => {
      try {
        localStorage.setItem(AUTO_APPLY_KEY, String(autoApply));
      } catch {
        // Preference only.
      }
      set({ autoApply });
    },
  };
});

// Serialise writes per project: a delayed PUT must finish before its DELETE,
// and replacing a proposal must delete the older one before saving the newer one.
const writes = new Map<string, Promise<void>>();
const persisted = new Set<string>();
let proposalVersion = 0;
useProposals.subscribe((s, prev) => {
  if (s.proposal !== prev.proposal || s.check?.status !== prev.check?.status) proposalVersion++;
});

function enqueue(projectId: string, work: () => Promise<unknown>): Promise<void> {
  const previous = writes.get(projectId);
  const run = (previous ?? Promise.resolve()).then(work).then(() => undefined).catch((e) => {
    useEditor.getState().toast({ tone: 'error', message: `Could not persist proposal: ${errorText(e).message}` });
  });
  writes.set(projectId, run);
  void run.then(() => { if (writes.get(projectId) === run) writes.delete(projectId); });
  return run;
}

function persistProposal(p: Proposal) {
  if (useEditor.getState().origin.kind !== 'server') return;
  persisted.add(p.id);
  void enqueue(p.projectId, async () => { await api.saveProposal(p); confirmed.add(p.id); });
}

function forgetProposal(p: Proposal) {
  if (!persisted.delete(p.id)) return;
  void enqueue(p.projectId, () => api.deleteProposal(p.projectId));
}

/**
 * Resolves once no recovery offer is pending or another document has opened.
 * Settles a microtask after the decision, so a Recover (which clears the offer
 * and then loads the recovered document) has already changed the session.
 */
function recoveryDecided(session: string): Promise<void> {
  const decided = () => !useRecovery.getState().offer || useEditor.getState().docSession !== session;
  if (decided()) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (!decided()) return;
      stopRecovery();
      stopEditor();
      resolve();
    };
    const stopRecovery = useRecovery.subscribe(check);
    const stopEditor = useEditor.subscribe(check);
  });
}

/** Restore only into the document that requested it, without opening review. */
export async function restoreServerProposal(): Promise<void> {
  const opened = useEditor.getState();
  if (opened.origin.kind !== 'server') return;
  const projectId = opened.doc.project.id;
  const session = opened.docSession;
  const version = proposalVersion;
  restoring = session;
  try {
    await writes.get(projectId);
    const saved = await api.getProposal(projectId);
    // While recovery is on offer, the open document may not be the one the
    // user keeps: validate (and possibly delete) only against their choice.
    // Recover opens a new session, which restores the proposal itself.
    await recoveryDecided(session);
    const now = useEditor.getState();
    if (now.docSession !== session || now.origin.kind !== 'server' || proposalVersion !== version) return;
    const valid = validateProposal(saved.proposal, projectId);
    if (!valid.ok) throw new Error(valid.error.message);
    const p = { ...valid.proposal, docSession: session };
    restoreFailed.delete(session);
    // A pasted patch of the person's whose saved copy was never confirmed stays on show: this
    // project's saved proposal waits on the server (agents stay blocked by the paste meanwhile).
    const shown = useProposals.getState().proposal;
    if (shown && shown.source === 'paste' && !confirmed.has(shown.id)) return;
    persisted.add(p.id);
    confirmed.add(p.id);
    const check = checkProposal(now.doc, p);
    useProposals.setState({ proposal: p, check, open: false, returnTo: null, replaced: null });
    if (check.status !== 'ready') {
      const reason = 'The project changed since this was proposed';
      markStale(p, { status: 'stale', error: { code: 'STALE', message: reason } }, reason);
    }
  } catch (e) {
    if (e instanceof ApiRequestError && e.status === 404) {
      restoreFailed.delete(session);
      return;
    }
    // Anything but a confirmed absence keeps agents off the saved slot (an unreadable file is set aside
    // by the server and answers 404); the next agent attempt retries.
    if (useEditor.getState().docSession === session) restoreFailed.add(session);
    if (useEditor.getState().docSession === session && !toasted.has(session)) {
      toasted.add(session);
      useEditor.getState().toast({ tone: 'error', message: `Could not restore proposal: ${errorText(e).message}` });
    }
  } finally {
    if (restoring === session) restoring = null;
  }
}

/** Re-check pending edits and restore proposals when a server document opens. */
useEditor.subscribe((s, prev) => {
  const opened = s.docSession !== prev.docSession || s.doc.project.id !== prev.doc.project.id;
  if (s.doc === prev.doc && !opened) return;
  const { proposal, check } = useProposals.getState();
  if (proposal && check?.status === 'ready') {
    if (s.docSession !== proposal.docSession) markStale(proposal, anotherProject(), ANOTHER_PROJECT);
    else {
      const next = checkProposal(s.doc, proposal);
      if (next.status === 'ready') useProposals.setState({ check: next });
      else markStale(proposal, next, staleReason(next, s.doc.project));
    }
  }
  if (opened && s.origin.kind === 'server') void restoreServerProposal();
});

/**
 * Select what an agent patch changed so the user sees it: the targeted element
 * when there is exactly one, moving the playhead into it only if it is not on
 * screen. Never interrupts playback.
 */
export function pointAtChange(patch: AiPatch) {
  const st = useEditor.getState();
  const elementTargets = patch.targets.filter(isSceneTarget).filter((t) => t.elementId);
  if (st.playing || elementTargets.length !== 1 || patch.targets.length !== 1) return;
  const { sceneId, elementId } = elementTargets[0];
  const project = st.doc.project;
  const scene = project.scenes.find((s) => s.id === sceneId);
  const element = scene?.elements.find((e) => e.id === elementId);
  if (!scene || !element) return;
  const start = sceneStartFrame(project, scene.id);
  const local = st.playhead - start - element.startFrame;
  if (local < 0 || local >= element.durationInFrames) st.seek(start + element.startFrame + Math.min(15, element.durationInFrames - 1));
  useEditor.getState().selectElement(scene.id, element.id);
}
