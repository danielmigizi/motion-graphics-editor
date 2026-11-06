// Agent bridge relay (see src/core/api-contract.ts). The editor tab holds the
// document; this keeps an event stream open to it, forwards agent commands,
// waits for the editor's reply, and remembers the context it last reported.

import { permissionTimeoutMs } from '../src/core/api-contract';
import type { Response } from 'express';
import type { AgentActivity, BridgeCommand, BridgeReply, EditorContext, EditorStateReport, EditorStateResponse } from '../src/core/api-contract';
import type { Project } from '../src/core/types';

interface Client {
  id: string;
  res: Response;
  heartbeat: ReturnType<typeof setInterval>;
}

interface Pending {
  resolve: (reply: BridgeReply) => void;
  timer: ReturnType<typeof setTimeout>;
  cancel?: (message?: string) => void;
  clientId?: string;
  projectId?: string;
}

export interface EditorBridgeOptions {
  /** How long a command waits for the editor's reply. Default 20 s. */
  timeoutMs?: number;
  /** SSE keep-alive interval. Default 10 s. */
  heartbeatMs?: number;
}

const COMMAND_ACTIVITY: Record<BridgeCommand['type'], string> = {
  applyPatch: 'editing',
  openProject: 'opening a project',
  focus: 'pointing something out',
  save: 'saving',
  askPermission: 'waiting for your permission',
  proposeOutline: 'proposing an outline',
};

let seq = 0;
const nextId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${(++seq).toString(36)}`;

export class EditorBridge {
  private clients: Client[] = [];
  private pending = new Map<string, Pending>();
  private context: EditorContext | null = null;
  private project: Project | null = null;
  private updatedAt: string | null = null;
  private readonly timeoutMs: number;
  private readonly heartbeatMs: number;

  constructor(opts: EditorBridgeOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 20000;
    this.heartbeatMs = opts.heartbeatMs ?? 10000;
  }

  /** The tab that receives commands: the most recently connected one. */
  private get active(): Client | undefined {
    return this.clients[this.clients.length - 1];
  }

  get connected(): boolean {
    return this.clients.length > 0;
  }

  /** Take over `res` as an SSE stream for one editor tab. */
  connect(res: Response): string {
    const id = nextId('ed');
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const client: Client = { id, res, heartbeat: setInterval(() => this.write(client, 'ping', {}), this.heartbeatMs) };
    // A newly active tab has not reported its project yet. Never reuse the
    // previous tab's project to route an approval to this one.
    this.clearContext();
    for (const pending of this.pending.values()) pending.cancel?.('Another editor tab became active.');
    this.clients.push(client);
    this.write(client, 'hello', { clientId: id });
    res.on('close', () => {
      clearInterval(client.heartbeat);
      if (this.active === client) this.clearContext();
      this.clients = this.clients.filter((c) => c !== client);
      for (const pending of this.pending.values()) if (pending.clientId === id) pending.cancel?.('The editor tab closed.');
    });
    return id;
  }

  private write(client: Client, event: string, data: unknown) {
    if (client.res.destroyed || client.res.writableEnded) return;
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  private clearContext() {
    this.context = null;
    this.project = null;
    this.updatedAt = null;
  }

  /** Record a state report. Reports from tabs that are not the active one are ignored. */
  report(r: EditorStateReport): boolean {
    if (this.active?.id !== r.clientId) return false;
    for (const pending of this.pending.values()) if (pending.projectId && pending.projectId !== r.context.projectId) pending.cancel?.('The editor opened another project.');
    this.context = r.context;
    if (r.project) this.project = r.project;
    this.updatedAt = new Date().toISOString();
    return true;
  }

  state(): EditorStateResponse {
    return { connected: this.connected, context: this.context, project: this.project, updatedAt: this.updatedAt };
  }

  /** Tell the active editor what the agent is doing (status only; never waits). */
  notify(activity: AgentActivity) {
    const client = this.active;
    if (client) this.write(client, 'activity', activity);
  }

  /** Send an event to every open editor tab. */
  broadcast(event: string, data: unknown) {
    for (const c of this.clients) this.write(c, event, data);
  }

  /** Send a command to the active editor and wait for its reply. */
  send(command: BridgeCommand, timeoutMs = command.type === 'askPermission' ? permissionTimeoutMs(command.timeoutMs) : this.timeoutMs, signal?: AbortSignal): Promise<BridgeReply> {
    const client = this.active;
    if (!client || signal?.aborted) {
      return Promise.resolve({
        ok: false,
        error: { code: 'EDITOR_NOT_CONNECTED', message: 'No editor is open.', hint: 'Open the editor in a browser (editor_open), then try again.' },
      });
    }
    const id = nextId('cmd');
    this.write(client, 'activity', { kind: 'editing', detail: COMMAND_ACTIVITY[command.type] } satisfies AgentActivity);
    return new Promise<BridgeReply>((resolve) => {
      const cleanup = () => signal?.removeEventListener('abort', onAbort);
      const cancel = (message = 'The agent stopped waiting for permission.') => {
        this.pending.delete(id);
        clearTimeout(timer);
        cleanup();
        if (command.type === 'askPermission') this.write(client, 'permission-cancel', { requestId: command.requestId });
        resolve({ ok: false, error: { code: 'CANCELLED', message } });
      };
      const onAbort = () => cancel(command.type === 'askPermission' ? 'The agent stopped waiting for permission.' : 'The agent cancelled the editor command.');
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        if (command.type === 'askPermission') this.write(client, 'permission-cancel', { requestId: command.requestId });
        resolve(command.type === 'askPermission' ? { ok: true, message: 'timeout' } : { ok: false, error: { code: 'TIMEOUT', message: `The editor did not answer within ${Math.round(timeoutMs / 1000)} s.`, hint: 'Check that the editor tab is open and not frozen.' } });
      }, timeoutMs);
      this.pending.set(id, { resolve: reply => { cleanup(); resolve(reply); }, timer, cancel, clientId: client.id, ...(command.type === 'askPermission' ? { projectId: this.context?.projectId } : {}) });
      signal?.addEventListener('abort', onAbort, { once: true });
      this.write(client, 'command', { id, command });
    });
  }

  /** Deliver the editor's reply to a waiting command. Returns false for unknown or expired ids. */
  reply(id: string, reply: BridgeReply): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(reply);
    return true;
  }

  close() {
    for (const pending of this.pending.values()) pending.cancel?.('The editor bridge closed.');
    this.pending.clear();
    for (const c of this.clients) {
      clearInterval(c.heartbeat);
      c.res.end();
    }
    this.clients = [];
    this.clearContext();
  }
}
