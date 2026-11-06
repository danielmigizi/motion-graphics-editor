// Test helper: a stand-in for an editor tab on the agent bridge. Opens the
// event stream over plain HTTP, reports state, and answers commands with a
// handler — the real editor runs the same core applyPatch.

import { request as httpRequest, type ClientRequest, type IncomingMessage } from 'node:http';
import type { BridgeCommand, BridgeEnvelope, BridgeReply, EditorContext, ProposalSummary } from '../../src/core/api-contract';
import { newId } from '../../src/core/ids';
import { applyPatch } from '../../src/core/patch';
import { diffProjects } from '../../src/core/diff';
import { createDocState } from '../../src/core/history';
import type { DocState, Project } from '../../src/core/types';

export interface FakeEditor {
  clientId: string;
  docSession: string;
  doc: DocState;
  commands: BridgeCommand[];
  autoApply: boolean;
  permissionDecision: 'allowed' | 'denied' | 'timeout';
  proposal: ProposalSummary | null;
  proposalLog: ProposalSummary[];
  report(context?: Partial<EditorContext>): Promise<number>;
  close(): void;
}

function post(port: number, path: string, body: unknown, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path, headers: { 'Content-Type': 'application/json', ...headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

export function contextFor(doc: DocState, extra: Partial<EditorContext> = {}): EditorContext {
  return {
    docSession: 's-1',
    projectId: doc.project.id,
    projectName: doc.project.name,
    revision: doc.project.revision,
    dirty: false,
    untouched: false,
    origin: 'server',
    selection: { sceneId: doc.project.scenes[0]?.id ?? null, elementId: null },
    playhead: 0,
    playing: false,
    editMode: 'layout',
    requests: [],
    autoApply: false,
    proposal: null,
    proposalLog: [],
    ...extra,
  };
}

/**
 * Connect a fake editor. Auto-apply is on for legacy tests; turn it off to
 * exercise proposals. Pass `handle` to override command replies.
 */
export function connectFakeEditor(port: number, project: Project, auth: { Cookie: string; 'X-MGE-Tab': string }, handle?: (cmd: BridgeCommand, ed: FakeEditor) => BridgeReply | Promise<BridgeReply>): Promise<FakeEditor> {
  return new Promise((resolve, reject) => {
    let req: ClientRequest;
    const ed: FakeEditor = {
      clientId: '',
      docSession: newId('req'),
      doc: createDocState(project),
      commands: [],
      autoApply: true,
      permissionDecision: 'allowed',
      proposal: null,
      proposalLog: [],
      report: (context = {}) => {
        if (context.docSession !== undefined) ed.docSession = context.docSession;
        if (context.autoApply !== undefined) ed.autoApply = context.autoApply;
        if (context.proposal !== undefined) ed.proposal = context.proposal;
        if (context.proposalLog !== undefined) ed.proposalLog = context.proposalLog;
        return post(port, '/api/editor/state', { clientId: ed.clientId, context: contextFor(ed.doc, { docSession: ed.docSession, autoApply: ed.autoApply, proposal: ed.proposal, proposalLog: ed.proposalLog, ...context }), project: ed.doc.project }, auth);
      },
      close: () => req.destroy(),
    };
    const fallback = (cmd: BridgeCommand): BridgeReply => {
      if (cmd.type === 'askPermission') return { ok: true, message: ed.permissionDecision };
      if (cmd.type !== 'applyPatch') return { ok: true, revision: ed.doc.project.revision, projectId: ed.doc.project.id };
      const before = ed.doc.project;
      const r = applyPatch(ed.doc, cmd.patch, { reconcile: cmd.reconcile });
      if (!r.ok) return { ok: false, error: r.error };
      if (cmd.mode === 'propose' || !ed.autoApply) {
        const replaced = ed.proposal ? { ...ed.proposal, status: 'replaced' as const, reason: 'A newer proposal took its place.', decidedAt: Date.now() } : undefined;
        ed.proposal = {
          id: newId('req'), projectId: before.id, agent: cmd.agent ?? 'Claude Code', model: cmd.model,
          source: 'mcp', summary: cmd.patch.summary, baseRevision: cmd.patch.baseRevision, status: 'pending', createdAt: Date.now(),
        };
        if (replaced) ed.proposalLog.unshift(replaced);
        return { ok: true, applied: false, revision: before.revision, projectId: before.id, proposal: ed.proposal, replaced, changes: diffProjects(before, r.state.project) };
      }
      ed.doc = r.state;
      return { ok: true, applied: true, revision: r.state.project.revision, projectId: r.state.project.id, changes: diffProjects(before, r.state.project) };
    };
    req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path: `/api/editor/events?tab=${encodeURIComponent(auth['X-MGE-Tab'])}`, headers: { Cookie: auth.Cookie } }, (res: IncomingMessage) => {
      if (res.statusCode !== 200) return reject(new Error(`event stream answered ${res.statusCode}`));
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (!event || !data) continue;
          if (event === 'hello') {
            ed.clientId = (JSON.parse(data) as { clientId: string }).clientId;
            void ed.report().then(() => resolve(ed), reject);
          } else if (event === 'command') {
            const { id, command } = JSON.parse(data) as BridgeEnvelope;
            ed.commands.push(command);
            void Promise.resolve(handle ? handle(command, ed) : fallback(command)).then(async (reply) => {
              await post(port, `/api/editor/replies/${id}`, reply, auth);
              await ed.report();
            });
          }
        }
      });
    });
    req.on('error', (e) => {
      if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e);
    });
    req.end();
  });
}
