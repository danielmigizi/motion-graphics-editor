// Editor chat: one conversation per project with the user's coding agent.
// Messages queue while a turn runs; each turn's reply streams to the editor as
// `chat` events. Conversations persist in chats/<projectId>.json.
//
// The user picks the agent and model per conversation. Each agent keeps its
// own session; when an agent's session missed part of the conversation (it is
// new, or another agent answered in between), its next prompt starts with a
// short transcript of what it missed.
//
// Agents run in the project's own workspace folder (workspacesDir/<projectId>,
// outside the repo), where they can keep downloads, scripts and research. A
// session started in another folder (before workspaces, or after the folder
// moved) is not resumed: the CLIs keep sessions per folder.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentProviderId, ChatAttachment, ChatContext, ChatEvent, ChatMessage, ChatPart, ChatSettings, ChatState, ProposalSummary, SendChatRequest } from '../src/core/api-contract';
import type { CommandError } from '../src/core/types';
import { newId } from '../src/core/ids';
import { formatTimecode } from '../src/core/timing';
import type { ProviderRegistry } from './agents/registry';

interface AgentSession {
  id: string;
  /** Model the session last ran with. */
  model: string;
  /** Last message this session has seen (its own latest reply). */
  seen: string | null;
  /** Workspace folder the session runs in (unset: started before workspaces, in the repo). */
  workspace?: string;
}

interface Conversation {
  projectId: string;
  /** Unset until the user picks one: the registry's default then. */
  provider?: AgentProviderId;
  model: string;
  /** Cursor's ACP and print interfaces use separate native session stores. */
  sessions: Partial<Record<AgentProviderId | 'cursor:auto' | 'cursor:manual', AgentSession>>;
  lastTurnAt?: Partial<Record<AgentProviderId, number>>;
  messages: ChatMessage[];
}

interface Live {
  conv: Conversation;
  abort: AbortController | null;
  /** Saves run one at a time per conversation. */
  saving: Promise<void>;
}

export interface ChatManagerOptions {
  chatsDir: string;
  publicDir: string;
  /** Parent of the per-project workspace folders agents run in (default <tmp>/mge-workspaces). */
  workspacesDir?: string;
  providers: ProviderRegistry;
  /** Delivers `chat` events to the editor (EditorBridge.broadcast). */
  emit: (event: ChatEvent) => void;
  askPermission?: (request: { projectId: string; provider: AgentProviderId; action: string; detail?: string; signal: AbortSignal }) => Promise<boolean>;
  /** Frames per second for timecodes in prompts (default 30). */
  fps?: (projectId: string) => number;
  proposalLog?: (projectId: string) => ProposalSummary[];
}

export type SettingsResult = { ok: true; state: ChatState } | { ok: false; status: 400 | 409; error: CommandError };

const TOOL_LABELS: Record<string, string> = {
  editor_get_context: 'Checking what you are looking at',
  editor_get_project: 'Reading the project',
  editor_guide: 'Reading the editor guide',
  editor_apply_patch: 'Editing',
  editor_propose_patch: 'Proposing an edit',
  editor_proposal_status: 'Checking your proposal',
  editor_propose_outline: 'Proposing an outline',
  editor_permission_prompt: 'Asking your permission',
  editor_write_project: 'Rebuilding the project',
  editor_render_frame: 'Looking at frames',
  editor_preview_patch: 'Previewing an edit',
  editor_render_contact_sheet: 'Looking at a contact sheet',
  editor_critique: 'Critiquing motion',
  editor_export_revision: 'Exporting your revision',
  editor_inspect_job: 'Checking export progress',
  editor_cancel_job: 'Cancelling an export',
  editor_focus: 'Pointing something out',
  editor_save: 'Saving',
  editor_import_asset: 'Importing a file',
  editor_search_audio: 'Searching free music',
  editor_inspect_audio: 'Checking a track',
  editor_add_audio: 'Adding music',
  editor_list_credits: 'Listing audio credits',
  editor_scan_brand: 'Scanning a brand kit',
  editor_analyze_reference: 'Analysing a reference video',
  editor_build_template: 'Building a template',
  editor_build_motion: 'Building motion',
  editor_list_cut_cards: 'Browsing cut cards',
  editor_build_cut: 'Building a cut card',
  editor_open: 'Opening the editor',
  Read: 'Reading a file',
  // Claude Code's built-in tools.
  Bash: 'Running a command',
  Write: 'Writing a file',
  Edit: 'Editing a file',
  MultiEdit: 'Editing a file',
  NotebookEdit: 'Editing a notebook',
  Glob: 'Looking for files',
  Grep: 'Searching files',
  WebSearch: 'Searching the web',
  WebFetch: 'Reading a web page',
  Skill: 'Using a skill',
  Task: 'Starting a subagent',
  Agent: 'Starting a subagent',
  ToolSearch: 'Loading tools',
  TodoWrite: 'Planning',
  // Codex, Cursor and OpenCode.
  command_execution: 'Running a command',
  shell: 'Running a command',
  file_change: 'Editing a file',
  edit: 'Editing a file',
  write: 'Writing a file',
  delete: 'Deleting a file',
  grep: 'Searching files',
  glob: 'Looking for files',
  ls: 'Looking for files',
  web_search: 'Searching the web',
  webSearch: 'Searching the web',
  webFetch: 'Reading a web page',
  collab_tool_call: 'Starting a subagent',
  image_generation: 'Making an image',
};

/** Editor tool prefixes: Claude `mcp__motion-editor__`, Codex `mcp__motion_editor__`, Cursor `motion-editor-`. */
const EDITOR_TOOL_PREFIX = /^(mcp__motion[-_]editor__|motion-editor-)/;

export function toolLabel(name: string, input: unknown): string {
  const short = name.replace(EDITOR_TOOL_PREFIX, '');
  const i = (input ?? {}) as Record<string, unknown>;
  if (short === 'Skill' && typeof i.skill === 'string') return `Using the skill “${i.skill}”`;
  if (short === 'WebSearch' && typeof i.query === 'string') return `Searching the web for “${i.query.slice(0, 80)}”`;
  // Another MCP server's tool (Claude Code names them mcp__<server>__<tool>).
  const mcp = short === name ? /^mcp__(.+?)__([^_].*)$/.exec(name) : null;
  if (mcp) return `${mcp[1].replace(/^claude_ai_/, '').replace(/_/g, ' ')}: ${mcp[2].replace(/_/g, ' ')}`;
  const base = TOOL_LABELS[short] ?? short;
  if ((short === 'editor_apply_patch' || short === 'editor_propose_patch') && typeof i.summary === 'string') return `${base}: ${i.summary}`;
  if (short === 'editor_render_frame' && Array.isArray(i.frames)) return `${base} ${(i.frames as number[]).join(', ')}`;
  return base;
}

const VALID_ID = /^[A-Za-z0-9_-]{1,128}$/;
const TRANSCRIPT_MESSAGES = 12;
const TRANSCRIPT_CHARS = 600;

const clip = (s: string) => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > TRANSCRIPT_CHARS ? `${t.slice(0, TRANSCRIPT_CHARS)}…` : t;
};

/** The recent conversation as plain text (user text and assistant text only). */
export function transcript(messages: ChatMessage[], agentLabel: (id: AgentProviderId | undefined) => string): string {
  const lines: string[] = [];
  for (const m of messages.slice(-TRANSCRIPT_MESSAGES)) {
    const text = m.role === 'user' ? (m.text ?? '') : (m.parts ?? []).map((p) => (p.type === 'text' ? p.text : '')).join(' ');
    if (clip(text)) lines.push(`${m.role === 'user' ? 'User' : agentLabel(m.provider)}: ${clip(text)}`);
  }
  if (!lines.length) return '';
  return ['[Earlier in this conversation]', ...lines, '[End of earlier messages]', '', ''].join('\n');
}

export class ChatManager {
  private live = new Map<string, Live>();
  constructor(private readonly opts: ChatManagerOptions) {}

  private file(projectId: string) {
    return join(this.opts.chatsDir, `${projectId}.json`);
  }

  private async conv(projectId: string): Promise<Live> {
    if (!VALID_ID.test(projectId)) throw new Error(`Invalid project id "${projectId}".`);
    let l = this.live.get(projectId);
    if (l) return l;
    let conv: Conversation = { projectId, model: '', sessions: {}, messages: [] };
    try {
      const saved = JSON.parse(await readFile(this.file(projectId), 'utf8')) as Conversation & { sessionId?: string | null };
      // Conversations from before agent choice had one Claude Code session.
      const { sessionId, ...rest } = saved;
      conv = { ...rest, model: rest.model ?? '', sessions: rest.sessions ?? (sessionId ? { claude: { id: sessionId, model: '', seen: rest.messages.at(-1)?.id ?? null } } : {}) };
      // A turn cut off by a server restart can never finish.
      for (const m of conv.messages) {
        if (m.status === 'running' || m.status === 'queued') {
          m.status = 'error';
          m.error = 'Interrupted (the editor server restarted).';
        }
      }
    } catch {
      // New conversation.
    }
    l = { conv, abort: null, saving: Promise.resolve() };
    this.live.set(projectId, l);
    return l;
  }

  private persist(conv: Conversation): Promise<void> {
    const l = this.live.get(conv.projectId);
    const write = async () => {
      await mkdir(this.opts.chatsDir, { recursive: true });
      const tmp = `${this.file(conv.projectId)}.tmp`;
      await writeFile(tmp, JSON.stringify(conv));
      await rename(tmp, this.file(conv.projectId));
    };
    if (!l) return write();
    const next = l.saving.then(write, write);
    l.saving = next.catch(() => undefined);
    return next;
  }

  private busy(l: Live) {
    return l.abort !== null;
  }

  private emit(l: Live, message: ChatMessage) {
    this.opts.emit({ projectId: l.conv.projectId, busy: this.busy(l), message: structuredClone(message) });
  }

  /** The agent and model the next turn uses. */
  private async settings(conv: Conversation): Promise<ChatSettings> {
    if (conv.provider) return { provider: conv.provider, model: conv.model };
    return { provider: await this.opts.providers.defaultProvider(), model: '' };
  }

  async state(projectId: string): Promise<ChatState> {
    const l = await this.conv(projectId);
    return { projectId, ...(await this.settings(l.conv)), busy: this.busy(l), messages: l.conv.messages };
  }

  /** POST /api/chat/:projectId/settings: pick the agent and model for the next turns. */
  async setSettings(projectId: string, s: { provider: string; model: string }): Promise<SettingsResult> {
    const l = await this.conv(projectId);
    const invalid = (message: string, path: string): SettingsResult => ({ ok: false, status: 400, error: { code: 'INVALID', message, path } });
    const provider = this.opts.providers.get(s.provider);
    if (!provider) return invalid(`Unknown agent "${s.provider}". Pick one from GET /api/chat/providers.`, 'provider');
    const busy: SettingsResult = { ok: false, status: 409, error: { code: 'PROTOCOL', message: 'Wait for the current reply to finish (or stop it) before switching agent or model.' } };
    if (this.busy(l)) return busy;
    const info = await this.opts.providers.info(provider.id)!;
    if (!info.available) return invalid(`${info.label} isn't available: ${info.detail}`, 'provider');
    if (s.model !== '' && !info.models.some((m) => m.id === s.model)) return invalid(`${info.label} has no model "${s.model}".`, 'model');
    // A turn may have started while the status was checked.
    if (this.busy(l)) return busy;
    l.conv.provider = provider.id;
    l.conv.model = s.model;
    await this.persist(l.conv);
    return { ok: true, state: await this.state(projectId) };
  }

  async send(projectId: string, req: SendChatRequest): Promise<ChatMessage> {
    const l = await this.conv(projectId);
    const message: ChatMessage = {
      id: newId('req').replace('req_', 'msg_'),
      role: 'user',
      at: Date.now(),
      status: 'queued',
      text: req.text.trim(),
      ...(req.attachments?.length ? { attachments: req.attachments } : {}),
      ...(req.context ? { context: req.context } : {}),
      // Kept on the message, so a queued one runs with the switch as it was when sent.
      autoApply: req.autoApply === true,
    };
    l.conv.messages.push(message);
    await this.persist(l.conv);
    this.emit(l, message);
    if (!this.busy(l)) void this.runQueue(l);
    return message;
  }

  async cancel(projectId: string) {
    const l = await this.conv(projectId);
    l.abort?.abort();
    // Drop anything still waiting too: "stop" means stop.
    for (const m of l.conv.messages) {
      if (m.status === 'queued') {
        m.status = 'cancelled';
        this.emit(l, m);
      }
    }
    await this.persist(l.conv);
  }

  /**
   * A fresh conversation with the same agent and model. A turn still running
   * is stopped and finishes in the background without touching the fresh
   * conversation, so it is not busy.
   */
  async reset(projectId: string): Promise<ChatState> {
    const l = await this.conv(projectId);
    l.abort?.abort();
    l.conv = { projectId, provider: l.conv.provider, model: l.conv.model, sessions: {}, messages: [] };
    await this.persist(l.conv);
    return { ...(await this.state(projectId)), busy: false };
  }

  /** The prompt the agent sees for one user message. */
  buildPrompt(projectId: string, m: ChatMessage): string {
    const lines = [m.text ?? ''];
    const fps = this.opts.fps?.(projectId) ?? 30;
    const ctx: ChatContext | undefined = m.context;
    if (ctx) {
      const target = ctx.elementId ? `element ${ctx.elementId} in scene ${ctx.sceneId}` : `scene ${ctx.sceneId}`;
      lines.push('', `[Editor context] Project ${projectId}. The user is pointing at "${ctx.label}" (${target}) at frame ${ctx.frame} (${formatTimecode(ctx.frame, fps)}).`);
    } else {
      lines.push('', `[Editor context] Project ${projectId}.`);
    }
    if (m.attachments?.length) {
      lines.push('', '[Attachments] Uploaded to the editor; not yet in the project:');
      for (const a of m.attachments) lines.push(`- "${a.name}" (${a.kind}) at ${join(this.opts.publicDir, a.src)}. Asset object: ${JSON.stringify(assetFor(a, fps))}`);
    }
    return lines.join('\n');
  }

  private async runQueue(l: Live) {
    for (;;) {
      const next = l.conv.messages.find((m) => m.role === 'user' && m.status === 'queued');
      if (!next) return;
      await this.runTurn(l, next);
    }
  }

  /** Messages the agent's session has not seen, before `user` (answered or answering, not dropped). */
  private missed(conv: Conversation, user: ChatMessage, session: AgentSession | null): ChatMessage[] {
    const msgs = conv.messages;
    const from = session?.seen ? msgs.findIndex((m) => m.id === session.seen) + 1 : 0;
    return msgs.slice(from).filter((m) => m !== user && m.status !== 'queued' && !(m.role === 'user' && m.status === 'cancelled'));
  }

  private proposalUpdates(conv: Conversation, agentLabel: string, lastTurnAt: number): string {
    const proposals = (this.opts.proposalLog?.(conv.projectId) ?? []).filter((p) =>
      p.projectId === conv.projectId && p.agent === agentLabel && (p.status === 'pending' ? p.createdAt : (p.decidedAt ?? 0)) > lastTurnAt,
    );
    if (!proposals.length) return '';
    const lines = proposals.map((p) => {
      const outcome = p.status === 'applied' ? `applied by the user as r${p.revision}`
        : p.status === 'cancelled' ? 'declined by the user (cancelled)'
        : p.status === 'stale' ? `stale — ${p.reason ?? 'the targets changed'}`
        : p.status === 'replaced' ? `replaced — ${p.reason ?? 'a newer proposal took its place'}`
        : "still waiting for the user's review";
      return `- "${p.summary}": ${outcome}`;
    });
    return ['[Your proposals since your last turn]', ...lines, '', ''].join('\n');
  }

  private async runTurn(l: Live, user: ChatMessage) {
    const abort = new AbortController();
    l.abort = abort;
    user.status = 'done';
    // The turn belongs to this conversation (its messages and sessions). A
    // reset replaces it, even while the agent is being picked below; the turn
    // then never writes to, or sends events about, the fresh one.
    const conv = l.conv;
    const current = () => l.conv === conv;
    const emit = (m: ChatMessage) => current() && this.emit(l, m);
    const { provider: providerId, model } = await this.settings(conv);
    const provider = this.opts.providers.get(providerId)!;
    const sessions = conv.sessions;
    const sessionKey = providerId === 'cursor' ? (user.autoApply === true ? 'cursor:auto' : 'cursor:manual') : providerId;
    // Older Cursor sessions came from the print interface; ACP cannot load them.
    const known = sessions[sessionKey] ?? (sessionKey === 'cursor:auto' ? sessions.cursor : undefined);
    const workspace = join(this.opts.workspacesDir ?? join(tmpdir(), 'mge-workspaces'), conv.projectId);
    // A session continues unless the model changed and the CLI cannot switch models mid-session,
    // or it ran in another folder (the CLIs keep sessions per folder).
    const session = known && known.workspace === workspace && (known.model === model || provider.resumesAcrossModels) ? known : null;
    const earlier = transcript(this.missed(conv, user, session), (id) => this.opts.providers.get(id ?? '')?.label ?? 'Assistant');

    const reply: ChatMessage = { id: `${user.id}_r`, role: 'assistant', at: Date.now(), status: 'running', parts: [], provider: providerId, model };
    const proposals = this.proposalUpdates(conv, provider.label, conv.lastTurnAt?.[providerId] ?? 0);
    conv.messages.push(reply);
    emit(user);
    emit(reply);
    if (current()) await this.persist(conv).catch(() => undefined);

    const parts = reply.parts as ChatPart[];
    let pending: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (pending) clearTimeout(pending);
      pending = null;
      emit(reply);
    };
    // Text deltas arrive fast; send at most ~10 updates a second.
    const soon = () => {
      if (!pending) pending = setTimeout(flush, 100);
    };
    const images = (user.attachments ?? []).filter((a) => a.kind === 'image').map((a) => join(this.opts.publicDir, a.src));

    try {
      await mkdir(workspace, { recursive: true, mode: 0o700 });
      // Messages saved before Auto-apply reached the agent have no flag: off.
      const turn = { prompt: proposals + earlier + this.buildPrompt(conv.projectId, user), sessionId: session?.id ?? null, model, autoApply: user.autoApply === true, images, workspace, signal: abort.signal,
        askPermission: async (action: string, detail?: string) => !abort.signal.aborted && current() && l.abort === abort && !!(await this.opts.askPermission?.({ projectId: conv.projectId, provider: providerId, action, detail, signal: abort.signal })) && !abort.signal.aborted && current() && l.abort === abort,
      };
      // Stopped (or reset) before the agent started: it never starts.
      if (!abort.signal.aborted) (conv.lastTurnAt ??= {})[providerId] = reply.at;
      const events = abort.signal.aborted ? [] : provider.run(turn);
      for await (const ev of events) {
        if (ev.type === 'session') sessions[sessionKey] = { id: ev.sessionId, model, seen: null, workspace };
        else if (ev.type === 'session-info') {
          reply.session = ev.info;
          flush();
        } else if (ev.type === 'text') {
          const last = parts[parts.length - 1];
          if (last?.type === 'text') last.text += ev.text;
          else parts.push({ type: 'text', text: ev.text });
          soon();
        } else if (ev.type === 'tool') {
          parts.push({ type: 'tool', name: ev.name, label: toolLabel(ev.name, ev.input), ...(ev.skill ? { skill: ev.skill } : {}), ...(ev.mcpServer ? { mcpServer: ev.mcpServer } : {}), ...(ev.mcpTool ? { mcpTool: ev.mcpTool } : {}) });
          flush();
        } else if (ev.type === 'done') {
          reply.status = abort.signal.aborted && !ev.nativeCompleted ? 'cancelled' : ev.isError ? 'error' : 'done';
          if (ev.isError && !abort.signal.aborted) reply.error = ev.error;
          if (ev.failure === 'login-expired' || ev.failure === 'account-changed') this.opts.providers.invalidate(providerId);
        }
      }
      if (reply.status === 'running') reply.status = abort.signal.aborted ? 'cancelled' : 'done';
    } catch (err) {
      reply.status = 'error';
      reply.error = err instanceof Error ? err.message : String(err);
    } finally {
      // A failed or completed process cannot leave a native approval card alive.
      abort.abort();
      // The session has now seen everything up to this reply.
      const s = sessions[sessionKey];
      if (s) s.seen = reply.id;
      if (current()) await this.persist(conv).catch(() => undefined);
      // Idle means the final conversation has been written. A new turn or
      // reopened manager must not race the preceding turn's final save.
      l.abort = null;
      flush();
    }
  }
}

/** An Asset object for an uploaded file, ready for addAsset / project.assets. */
export function assetFor(a: ChatAttachment, fps: number) {
  return {
    id: newId('ast'),
    kind: a.kind,
    name: a.name,
    src: a.src,
    mimeType: a.mimeType,
    ...(a.width ? { width: a.width } : {}),
    ...(a.height ? { height: a.height } : {}),
    ...(a.durationSeconds ? { durationInFrames: Math.max(1, Math.round(a.durationSeconds * fps)) } : {}),
  };
}
