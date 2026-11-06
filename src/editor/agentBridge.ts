// Agent bridge, editor side (contract: src/core/api-contract.ts). Keeps an
// event stream open to the local server, reports what the user is looking at,
// and runs agent commands against the store. Agent patches go through the same
// core checks as pasted ones (stale, scope, locks, validation). With Auto-apply
// off (the default) they become proposals the user reviews (proposals.ts);
// with it on they land at once as one undo step.

import { askPermission, cancelPermission } from './permissions';
import { create } from 'zustand';
import { EDITOR_TAB_PARAM, type AgentActivity, type BridgeCommand, type BridgeEnvelope, type BridgeReply, type ChatEvent, type EditorContext, type EditorStateReport, type ProposalSource } from '../core/api-contract';
import { withTab } from './api';
import { applyChatEvent, loadChat, openedByAgent, providerLabel, useChat } from './chat';
import { outlineSummary, receiveOutline, useCreate } from './createFlow';
import { diffProjects } from '../core/diff';
import { isUntouched } from '../core/newProject';
import { formatSeconds, outlineSeconds } from '../core/outline';
import { applyPatch, isSceneTarget } from '../core/patch';
import { projectDurationInFrames, sceneStartFrame } from '../core/timing';
import type { AiPatch, Project } from '../core/types';
import { onlyAgentChangesSinceSave, openFromServer, saveToServer, useSaving } from './persistence';
import { agentChangeBlocked, PASTED_BY, pendingSummary, pointAtChange, TAKE_BY, useProposals } from './proposals';
import { useEditor, whenEditorIdle } from './store';
import { applyGenerationEntry, loadGenerations } from './generations';
import { GENERATION_JOB_EVENT, type GenerationJob } from '../core/generationStudio';
import { applyGenerationJob, syncGenerationJobs, watchGenerationProject } from './generateStore';
import { openExport } from './ExportPopover';
import { markLocked, refresh as refreshSession, tabSecret } from './session';

export type AgentLinkStatus = 'connecting' | 'connected' | 'offline';

export const useAgentLink = create<{ status: AgentLinkStatus; activity: AgentActivity | null }>(() => ({ status: 'connecting', activity: null }));

const ACTIVITY_SHOWN_MS = 4000;
let activityTimer: ReturnType<typeof setTimeout> | null = null;

/** Show what the agent is doing for a few seconds. */
export function showAgentActivity(activity: AgentActivity) {
  useAgentLink.setState({ activity });
  if (activityTimer) clearTimeout(activityTimer);
  activityTimer = setTimeout(() => useAgentLink.setState({ activity: null }), ACTIVITY_SHOWN_MS);
}

const IDLE_WAIT_MS = 5000;

export function editorContext(): EditorContext {
  const s = useEditor.getState();
  const proposals = useProposals.getState();
  return {
    docSession: s.docSession,
    projectId: s.doc.project.id,
    projectName: s.doc.project.name,
    revision: s.doc.project.revision,
    dirty: s.doc.project.revision !== s.cleanRevision,
    untouched: isUntouched(s.doc.project),
    origin: s.origin.kind,
    selection: { ...s.selection },
    playhead: s.playhead,
    playing: s.playing,
    editMode: s.editMode,
    requests: s.requests,
    autoApply: proposals.autoApply,
    proposal: pendingSummary(),
    proposalLog: proposals.log,
    outline: outlineSummary(),
  };
}

/** Wait until no drag is in progress, so an agent change never yanks an element out from under the pointer. */
const waitUntilIdle = () => whenEditorIdle(IDLE_WAIT_MS);

/** Agent changes arrive from Claude Code in a terminal unless the MCP server says otherwise. */
const DEFAULT_AGENT = 'Claude Code';

/** Auto-apply: commit now as one undo step. Call once the editor is idle. */
function runPatch(patch: AiPatch, reconcile: boolean, agent: string): BridgeReply {
  const st = useEditor.getState();
  const before = st.doc.project;
  const r = applyPatch(st.doc, patch, { reconcile, actor: agent });
  if (!r.ok) return { ok: false, error: r.error };
  // The agent's change, not the person's: autosave files it as the agent's, outcomes ignore it (store.ts userEdits).
  st.replaceDoc(r.state, { byAgent: true });
  const done = st.requests.filter((q) => patch.targets.filter(isSceneTarget).some((t) => t.sceneId === q.sceneId && (!t.elementId || t.elementId === q.elementId))).map((q) => q.id);
  if (done.length) st.clearRequests(done);
  const revision = r.state.project.revision;
  pointAtChange(patch);
  // No toast: the change is the newest item in the chat's agent status line (AgentStatus.tsx).
  return { ok: true, applied: true, revision, projectId: r.state.project.id, changes: diffProjects(before, r.state.project) };
}

/** A chat agent's edit arrives while its turn runs; anything else came through the MCP server directly. */
function sourceOf(agent: string): ProposalSource {
  const chat = useChat.getState();
  return chat.busy && providerLabel(chat.providers, chat.provider) === agent ? 'chat' : 'mcp';
}

/** Review first: the document is untouched until the user applies the proposal. */
function proposePatch(patch: AiPatch, reconcile: boolean, agent: string, model: string | undefined, idle: boolean): BridgeReply {
  const r = useProposals.getState().propose(patch, { agent, model, source: sourceOf(agent), reconcile });
  if (!r.ok) return { ok: false, error: r.error };
  if (idle) useProposals.getState().openReview();
  const st = useEditor.getState();
  return {
    ok: true,
    applied: false,
    revision: st.doc.project.revision,
    projectId: st.doc.project.id,
    proposal: r.summary,
    ...(r.replaced ? { replaced: r.replaced } : {}),
    changes: r.diff,
  };
}

function focus(cmd: Extract<BridgeCommand, { type: 'focus' }>): BridgeReply {
  const st = useEditor.getState();
  const project: Project = st.doc.project;
  let scene = cmd.sceneId ? project.scenes.find((s) => s.id === cmd.sceneId) : undefined;
  if (cmd.sceneId && !scene) return { ok: false, error: { code: 'NOT_FOUND', message: `Scene ${cmd.sceneId} does not exist.`, path: 'sceneId' } };
  if (cmd.elementId && !scene) scene = project.scenes.find((s) => s.elements.some((e) => e.id === cmd.elementId));
  const element = cmd.elementId ? scene?.elements.find((e) => e.id === cmd.elementId) : undefined;
  if (cmd.elementId && !element) return { ok: false, error: { code: 'NOT_FOUND', message: `Element ${cmd.elementId} does not exist${scene ? ` in scene "${scene.name}"` : ''}.`, path: 'elementId' } };

  let frame = cmd.frame;
  if (frame === undefined && scene) {
    const start = sceneStartFrame(project, scene.id);
    // Land a little after the element appears, so its entrance has started.
    frame = element ? start + element.startFrame + Math.min(15, element.durationInFrames - 1) : start;
  }
  if (frame !== undefined) {
    const total = projectDurationInFrames(project);
    if (!Number.isInteger(frame) || frame < 0 || frame >= total) {
      return { ok: false, error: { code: 'INVALID', message: `frame must be an integer from 0 to ${total - 1}.`, path: 'frame' } };
    }
    // A sheet or the Export popover would cover what the agent is pointing at; only a valid focus moves them aside.
    st.setSheet(null);
    openExport(false);
    st.seek(frame);
  }
  if (scene) {
    if (useEditor.getState().selection.sceneId !== scene.id) {
      return { ok: false, error: { code: 'INVALID', message: `Frame ${frame} is not inside scene "${scene.name}".`, path: 'frame', hint: 'Omit frame to jump to the scene, or pick a frame inside it.' } };
    }
    // Selecting an element opens the inspector column beside the preview.
    st.selectElement(scene.id, element?.id ?? null);
  }
  const after = useEditor.getState();
  return { ok: true, revision: after.doc.project.revision, projectId: after.doc.project.id, message: `Playhead at frame ${after.playhead}.` };
}

/** Run one agent command against the store. */
export async function handleBridgeCommand(command: BridgeCommand): Promise<BridgeReply> {
  const st = useEditor.getState();
  switch (command.type) {
    case 'askPermission':
      return askPermission(command);
    case 'applyPatch': {
      const agent = command.agent?.trim() || DEFAULT_AGENT;
      // The person's own labels can't be borrowed by a caller of the bridge.
      if (agent === PASTED_BY || agent === TAKE_BY) {
        return { ok: false, error: { code: 'INVALID', message: `"${agent}" is the person's own label; name the agent instead.` } };
      }
      const reconcile = command.reconcile === true;
      // Never change the document or pop the review up mid-gesture. Everything
      // below is decided after the wait: the user may have reopened the
      // document or switched Auto-apply off meanwhile.
      const idle = await waitUntilIdle();
      const session = useEditor.getState().docSession;
      if (command.docSession !== undefined && command.docSession !== session) {
        return {
          ok: false,
          error: {
            code: 'STALE',
            message: `The editor opened another document session (${session}) since this patch was made for ${command.docSession}.`,
            hint: 'Re-read context (editor_get_context) and rebuild the patch.',
          },
        };
      }
      if (command.mode !== 'propose' && useProposals.getState().autoApply) {
        // Auto-apply skips the review, not the person's pending patch or a restore in progress.
        const blocked = agentChangeBlocked();
        if (blocked) return { ok: false, error: blocked };
        if (!idle) return { ok: false, error: { code: 'EDITOR_BUSY', message: 'The user is dragging something in the editor.', hint: 'Try again in a moment.' } };
        return runPatch(command.patch, reconcile, agent);
      }
      // If a drag never ends, the proposal waits behind the stage pill.
      return proposePatch(command.patch, reconcile, agent, command.model?.trim() || undefined, idle);
    }

    case 'openProject': {
      const ctx = editorContext();
      if (ctx.dirty && !command.discardUnsaved) {
        return {
          ok: false,
          error: {
            code: 'UNSAVED_CHANGES',
            message: `The editor has unsaved changes to "${ctx.projectName}" (r${ctx.revision}).`,
            hint: 'Save first (editor_save), or ask the user before discarding them.',
          },
        };
      }
      // An agent asked to discard unsaved changes: keep a History copy first (filed by who made them),
      // and don't discard anything if that copy couldn't be written.
      // The document as it stands when the agent asked: edits the person makes after this (during
      // the History copy or while the project loads) stop the switch.
      const before = useEditor.getState();
      const asked = before.doc;
      if (ctx.dirty && command.discardUnsaved && before.origin.kind === 'server') {
        await saveToServer({ quiet: true, byAgent: onlyAgentChangesSinceSave(before) });
        if (useEditor.getState().docSession !== before.docSession) {
          return { ok: false, error: { code: 'STALE', message: 'The editor opened another document while this request waited.', hint: 'Re-read context (editor_get_context) and decide again.' } };
        }
        if (useSaving.getState().failed) {
          return { ok: false, error: { code: 'SAVE_FAILED', message: 'The editor could not keep a History copy of the unsaved changes, so it did not discard them.', hint: 'Ask the user to save, then try again.' } };
        }
      }
      // Named as the opener: a chat mid-turn stays on its conversation and says who opened what.
      const r = await openedByAgent(command.agent?.trim() || DEFAULT_AGENT, () => openFromServer(command.projectId, { unlessChanged: asked }));
      if (!r.ok) return { ok: false, error: { code: 'NOT_FOUND', message: r.message, hint: r.hint } };
      const after = useEditor.getState();
      after.toast({ tone: 'info', message: `${command.agent?.trim() || DEFAULT_AGENT} opened “${after.doc.project.name}”.` });
      return { ok: true, revision: after.doc.project.revision, projectId: after.doc.project.id };
    }

    case 'focus':
      return focus(command);

    case 'save': {
      const revision = st.doc.project.revision;
      const session = st.docSession;
      // This tab sends it, but the agent asked: filed as the agent's save, unless the person
      // has changed something since the last save (then it holds their edit and is theirs).
      await saveToServer({ byAgent: onlyAgentChangesSinceSave(st) });
      const after = useEditor.getState();
      if (after.docSession === session && after.cleanRevision >= revision) {
        return { ok: true, revision, projectId: after.doc.project.id, message: `Saved at r${revision}.` };
      }
      return { ok: false, error: { code: 'SAVE_FAILED', message: 'Saving to the local server failed.', hint: 'See the error toast in the editor.' } };
    }

    case 'proposeOutline': {
      const r = receiveOutline(command.outline, command.agent?.trim() || DEFAULT_AGENT);
      if (!r.ok) return { ok: false, error: { code: 'INVALID', message: `Outline rejected: ${r.message}`, ...(r.path ? { path: r.path } : {}) } };
      const n = r.outline.scenes.length;
      return {
        ok: true,
        revision: st.doc.project.revision,
        projectId: st.doc.project.id,
        message: `Outline "${r.outline.title}" (${n} scene${n === 1 ? '' : 's'}, ${formatSeconds(outlineSeconds(r.outline))}) is awaiting the user's review.`,
      };
    }

    default:
      return { ok: false, error: { code: 'PROTOCOL', message: `Unknown bridge command ${(command as { type?: string }).type}.` } };
  }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const REPORT_EVERY_MS = 200;
const RECONNECT_MS = 4000;
/**
 * The server sends a `ping` every 10 s. A stream silent this long is dead
 * even if the browser has not noticed (a restarted server behind the dev
 * proxy can leave it hanging open): close it and connect again.
 */
export const SILENT_STREAM_MS = 25_000;

async function post(path: string, body: unknown): Promise<boolean> {
  const sentAt = Date.now();
  try {
    const res = await fetch(path, withTab({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    // The bridge is the user's: a locked tab (the server restarted) gets 401s here (session.ts).
    if (res.status === 401) markLocked(sentAt);
    return res.ok;
  } catch {
    return false;
  }
}

/** Connect to the local server's agent bridge. Returns a stop function. */
export function startAgentBridge(): () => void {
  if (typeof EventSource === 'undefined') return () => undefined;
  let stopped = false;
  let es: EventSource | null = null;
  let clientId: string | null = null;
  let lastProject: Project | null = null;
  let reportTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let silenceTimer: ReturnType<typeof setTimeout> | null = null;
  // Document commands run one at a time; permission requests wait independently.
  let queue: Promise<void> = Promise.resolve();
  // A failing stream asks once whether the tab is still unlocked (a restarted server forgets
  // sessions, and the stream's 401 says nothing more than "error"); again only when that check
  // could not reach the server, and again after the next hello.
  let checkedSession = false;

  const report = async () => {
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = null;
    if (!clientId) return;
    const project = useEditor.getState().doc.project;
    const body: EditorStateReport = { clientId, context: editorContext() };
    if (project !== lastProject) body.project = project;
    const ok = await post('/api/editor/state', body);
    if (ok && body.project) lastProject = body.project;
    if (!ok) lastProject = null;
  };

  const scheduleReport = () => {
    if (!reportTimer) reportTimer = setTimeout(() => void report(), REPORT_EVERY_MS);
  };

  /** Any event (hello, ping, a command, chat, a job …) proves the stream alive; silence past SILENT_STREAM_MS reconnects. */
  const heard = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      silenceTimer = null;
      useAgentLink.setState({ status: 'offline' });
      clientId = null;
      // The ordinary way in: a new stream, whose hello reports state and syncs jobs again.
      connect();
    }, SILENT_STREAM_MS);
  };

  const connect = () => {
    if (stopped) return;
    // Never two streams: a watchdog reconnect replaces the old one and any retry already scheduled.
    es?.close();
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    useAgentLink.setState({ status: 'connecting' });
    // An event stream cannot send headers: this tab's secret rides in the URL (read on each connect: an unlock may have replaced it).
    const secret = tabSecret();
    const source = new EventSource(secret ? `/api/editor/events?${EDITOR_TAB_PARAM}=${encodeURIComponent(secret)}` : '/api/editor/events');
    es = source;
    heard();
    // Every listener first notes that the stream is alive.
    const on = (type: string, fn: (e: MessageEvent) => void) => source.addEventListener(type, (e) => {
      heard();
      fn(e as MessageEvent);
    });
    source.onmessage = heard;
    on('ping', () => undefined);
    on('hello', (e) => {
      clientId = (JSON.parse(e.data) as { clientId: string }).clientId;
      lastProject = null;
      checkedSession = false;
      useAgentLink.setState({ status: 'connected' });
      void report();
      // Catch up on chat updates missed while disconnected (on the chat's own project while it is held).
      void loadChat(useChat.getState().projectId ?? undefined);
      // And on generation jobs that finished meanwhile: their takes are delivered now.
      void syncGenerationJobs();
    });
    on('chat', (e) => applyChatEvent(JSON.parse(e.data) as ChatEvent));
    on('permission-cancel', (e) => cancelPermission((JSON.parse(e.data) as { requestId: string }).requestId));
    on('activity', (e) => showAgentActivity(JSON.parse(e.data) as AgentActivity));
    on('generation', (e) => applyGenerationEntry(JSON.parse(e.data)));
    on(GENERATION_JOB_EVENT, (e) => applyGenerationJob(JSON.parse(e.data) as GenerationJob));
    void loadGenerations();
    on('command', (e) => {
      const { id, command } = JSON.parse(e.data) as BridgeEnvelope;
      const run = async () => {
        let reply: BridgeReply;
        try {
          reply = await handleBridgeCommand(command);
        } catch (err) {
          reply = { ok: false, error: { code: 'PROTOCOL', message: `The editor failed to run ${command.type}: ${err instanceof Error ? err.message : String(err)}` } };
        }
        // Report first, so an agent reading context right after the reply sees the result.
        await report();
        await post(`/api/editor/replies/${encodeURIComponent(id)}`, reply);
      };
      // Permission decisions wait independently: a second request must be
      // denied immediately, and must never queue behind the first prompt.
      if (command.type === 'askPermission') void run();
      else queue = queue.then(run);
    });
    source.onerror = () => {
      // A stream already replaced (the watchdog moved on) says nothing about the new one.
      if (es !== source) return;
      useAgentLink.setState({ status: 'offline' });
      clientId = null;
      if (!checkedSession) {
        checkedSession = true;
        void refreshSession().then((editor) => {
          if (editor === null) checkedSession = false;
        });
      }
      // EventSource retries by itself after a dropped stream, but gives up for
      // good on an error response (e.g. the server is down behind the proxy).
      if (source.readyState === EventSource.CLOSED && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          connect();
        }, RECONNECT_MS);
      }
    };
  };

  const unsubscribe = useEditor.subscribe((s, prev) => {
    if (
      s.doc !== prev.doc ||
      s.selection !== prev.selection ||
      s.playhead !== prev.playhead ||
      s.playing !== prev.playing ||
      s.requests !== prev.requests ||
      s.cleanRevision !== prev.cleanRevision ||
      s.docSession !== prev.docSession ||
      s.editMode !== prev.editMode
    ) {
      scheduleReport();
    }
  });
  // Proposal outcomes reach the agent through the next report.
  const unsubscribeProposals = useProposals.subscribe((s, prev) => {
    if (s.proposal !== prev.proposal || s.check !== prev.check || s.log !== prev.log || s.autoApply !== prev.autoApply) scheduleReport();
  });
  // So do outline edits and decisions.
  const unsubscribeOutline = useCreate.subscribe((s, prev) => {
    if (s.outline !== prev.outline || s.status !== prev.status || s.projectId !== prev.projectId) scheduleReport();
  });
  // Opening another project fetches its generation jobs.
  const unwatchGeneration = watchGenerationProject();

  connect();
  return () => {
    stopped = true;
    unsubscribe();
    unsubscribeProposals();
    unsubscribeOutline();
    unwatchGeneration();
    if (reportTimer) clearTimeout(reportTimer);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    if (silenceTimer) clearTimeout(silenceTimer);
    es?.close();
  };
}
