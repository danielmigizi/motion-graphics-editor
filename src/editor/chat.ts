// Editor chat state: the open project's conversation with the user's coding
// agent. Loaded over HTTP, then kept current by `chat` events on the editor
// event stream (see agentBridge.ts).

import { create } from 'zustand';
import type { AgentProviderId, ChatAttachment, ChatContext, ChatEvent, ChatMessage, ChatState, ModelOption, ProviderInfo } from '../core/api-contract';
import { api, ApiRequestError, errorText, withTab } from './api';
import { useProposals } from './proposals';
import { useEditor } from './store';

interface ChatStore {
  projectId: string | null;
  messages: ChatMessage[];
  busy: boolean;
  /** Every agent the server knows about, signed in or not. */
  providers: ProviderInfo[];
  /** The agent and model this conversation uses ('' = the agent's default model). */
  provider: AgentProviderId;
  model: string;
  /** A settings change is in flight. */
  switching: boolean;
  loaded: boolean;
  /** The project whose agent and model came from the server (until then the picker shows a guess). */
  confirmed: string | null;
  /** Name of the conversation's project (for the "stays with" banner). */
  projectName: string;
  /**
   * Another project opened in the editor while this conversation's turn was
   * running: the chat stays on its own project (so the agent's reply is not
   * lost) until the user follows the open one (followOpenProject).
   * `by`: the agent that opened it, when it was an agent.
   */
  held: { projectId: string; name: string; by?: string } | null;
}

export const useChat = create<ChatStore>(() => ({ projectId: null, messages: [], busy: false, providers: [], provider: 'claude', model: '', switching: false, loaded: false, confirmed: null, projectName: '', held: null }));

/** Bumped when the chat switches project: answers to requests made before then are dropped. */
let generation = 0;

/** Whether a request made for `projectId` at `gen` still belongs to the open chat. */
const stillCurrent = (projectId: string, gen: number) => gen === generation && useChat.getState().projectId === projectId;

const FALLBACK_LABELS: Record<AgentProviderId, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode' };

/** Display name of an agent, even before the provider list has loaded. */
export function providerLabel(providers: ProviderInfo[], id: AgentProviderId): string {
  return providers.find((p) => p.id === id)?.label ?? FALLBACK_LABELS[id] ?? id;
}

/** Display name of a model; unknown ids are shown as-is. */
export function modelLabel(providers: ProviderInfo[], id: AgentProviderId, model: string | undefined): string {
  const found = providers.find((p) => p.id === id)?.models.find((m) => m.id === (model ?? ''));
  return found?.label ?? (model || 'Default');
}

export type ProviderStatusKind = 'available' | 'signed-out' | 'missing' | 'unsupported';

/**
 * Whether an agent can answer, is missing entirely, needs signing in, or
 * cannot be limited to the editor's tools. From its `state`; servers older
 * than that field only say available or not, so the detail text decides.
 */
export function providerStatus(p: ProviderInfo): ProviderStatusKind {
  switch (p.state) {
    case 'ready':
      return 'available';
    case 'not-installed':
      return 'missing';
    case 'signed-out':
      return 'signed-out';
    case 'unsupported':
    case 'error':
      return 'unsupported';
  }
  if (p.available) return 'available';
  return /not installed|not found|no such file|ENOENT/i.test(p.detail) ? 'missing' : 'signed-out';
}

/** Assistant messages answered by a different agent or model than the assistant message before them. */
export function attributedMessages(messages: ChatMessage[]): Set<string> {
  const out = new Set<string>();
  let prev: string | null = null;
  for (const m of messages) {
    if (m.role !== 'assistant' || !m.provider) continue;
    const key = `${m.provider}/${m.model ?? ''}`;
    if (key !== prev) out.add(m.id);
    prev = key;
  }
  return out;
}

/**
 * Auto-apply goes with each message as it was when sent (Claude Code's
 * permission mode for that turn). While a reply runs or messages wait, this is
 * the Auto-apply they were sent with when it differs from the switch now
 * (`on`), else null: flipping the switch then changes only later messages.
 */
export function sentWithOtherAutoApply(messages: ChatMessage[], on: boolean): boolean | null {
  const running = messages.find((m) => m.role === 'assistant' && m.status === 'running');
  // The server names a reply after its message (`<id>_r`).
  const sent = running && messages.find((m) => m.role === 'user' && `${m.id}_r` === running.id);
  const pending = [...(sent ? [sent] : []), ...messages.filter((m) => m.role === 'user' && m.status === 'queued')];
  const other = pending.find((m) => (m.autoApply === true) !== on);
  return other ? other.autoApply === true : null;
}

/** The server's state of `projectId`'s conversation. */
function applyState(projectId: string, s: ChatState) {
  // Older servers send no provider/model: that is Claude Code on its default model.
  useChat.setState({ messages: s.messages, busy: s.busy, provider: s.provider ?? 'claude', model: s.model ?? '', confirmed: projectId });
}

/** The project the chat talks about: its own (which may differ from the open one while held), else the open one. */
const chatProjectId = () => useChat.getState().projectId ?? useEditor.getState().doc.project.id;

export async function loadChat(projectId = useEditor.getState().doc.project.id) {
  const open = useEditor.getState().doc.project;
  if (useChat.getState().projectId !== projectId) {
    generation++;
    useChat.setState({ projectId, messages: [], busy: false, loaded: false, confirmed: null, projectName: open.id === projectId ? open.name : '', held: null });
  } else if (!useChat.getState().projectName && open.id === projectId) useChat.setState({ projectName: open.name });
  const gen = generation;
  try {
    const s = await api.getChat(projectId);
    if (stillCurrent(projectId, gen)) {
      applyState(projectId, s);
      useChat.setState({ loaded: true });
    }
  } catch {
    if (stillCurrent(projectId, gen)) useChat.setState({ loaded: true });
  }
}

/**
 * Re-check which agents are installed and signed in. Keeps the last list when
 * the server can't be reached. `force` makes the server check every agent now
 * instead of answering from its ~30 s cache (after the user signed in).
 */
export async function loadProviders(opts: { force?: boolean } = {}) {
  try {
    useChat.setState({ providers: opts.force ? await refreshedProviders() : await api.chatProviders() });
  } catch {
    // Offline: the picker keeps showing what it last knew.
  }
}

/** GET /api/chat/providers?refresh=1 (each agent's status command runs again, so it can take a while). */
async function refreshedProviders(): Promise<ProviderInfo[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const res = await fetch('/api/chat/providers?refresh=1', withTab({ signal: ctrl.signal }));
    if (!res.ok) throw new Error(`Server answered ${res.status}`);
    return (await res.json()) as ProviderInfo[];
  } finally {
    clearTimeout(timer);
  }
}

/** Switch the conversation to another agent and/or model. */
export async function setChatSettings(provider: AgentProviderId, model: string): Promise<boolean> {
  const st = useChat.getState();
  const projectId = chatProjectId();
  // Nothing to do only when the server already said so for this project.
  if (st.confirmed === projectId && st.projectId === projectId && st.provider === provider && st.model === model) return true;
  const gen = generation;
  useChat.setState({ switching: true });
  try {
    const s = await api.setChatSettings(projectId, { provider, model });
    if (stillCurrent(projectId, gen)) applyState(projectId, s);
    return true;
  } catch (e) {
    const name = `${providerLabel(st.providers, provider)} · ${modelLabel(st.providers, provider, model)}`;
    // A server from before agent switching has no settings route.
    const outdated = e instanceof ApiRequestError && e.status === 404 && !e.hint;
    useEditor.getState().toast({
      tone: 'error',
      message: `Could not switch to ${name}: ${outdated ? 'this local server can’t switch agents yet.' : errorText(e).message}`,
      hint: outdated ? 'Update and restart it (npm run dev).' : errorText(e).hint,
    });
    return false;
  } finally {
    useChat.setState({ switching: false });
  }
}

/** Apply a streamed update: add or replace one message. */
export function applyChatEvent(e: ChatEvent) {
  const st = useChat.getState();
  if (e.projectId !== st.projectId) return;
  const i = st.messages.findIndex((m) => m.id === e.message.id);
  const messages = i >= 0 ? st.messages.map((m, j) => (j === i ? e.message : m)) : [...st.messages, e.message];
  useChat.setState({ messages, busy: e.busy });
}

export async function sendChat(text: string, attachments: ChatAttachment[], context?: ChatContext): Promise<boolean> {
  // The conversation on screen, even while another project is open (held).
  const projectId = chatProjectId();
  // The switch as it is now goes with the message: Claude Code runs its turn in auto mode when on.
  const autoApply = useProposals.getState().autoApply;
  try {
    const m = await api.sendChat(projectId, { text, attachments, context, autoApply });
    applyChatEvent({ projectId, busy: useChat.getState().busy, message: m });
    return true;
  } catch (e) {
    useEditor.getState().toast({ tone: 'error', message: `Could not send: ${errorText(e).message}`, hint: errorText(e).hint });
    return false;
  }
}

export async function cancelChat() {
  await api.cancelChat(chatProjectId()).catch(() => undefined);
}

export async function resetChat() {
  const projectId = chatProjectId();
  const gen = generation;
  try {
    const s = await api.resetChat(projectId);
    // The user may have opened another project meanwhile.
    if (stillCurrent(projectId, gen)) applyState(projectId, s);
  } catch (e) {
    useEditor.getState().toast({ tone: 'error', message: errorText(e).message });
  }
}

/** What the user is pointing at right now, as chat context. */
export function currentContext(): ChatContext | undefined {
  const { doc, selection, playhead } = useEditor.getState();
  const scene = doc.project.scenes.find((s) => s.id === selection.sceneId);
  if (!scene) return undefined;
  const el = selection.elementId ? scene.elements.find((e) => e.id === selection.elementId) : undefined;
  return { sceneId: scene.id, ...(el ? { elementId: el.id } : {}), frame: playhead, label: el ? `${el.name} · ${scene.name}` : `Scene “${scene.name}”` };
}

/** Set by the agent bridge around an agent's openProject, so the banner can say who opened it. */
let opener: string | undefined;

/** Run `open` (an agent opening a project) with `agent` named as the opener. */
export async function openedByAgent<T>(agent: string, open: () => Promise<T>): Promise<T> {
  opener = agent;
  try {
    return await open();
  } finally {
    opener = undefined;
  }
}

/**
 * The editor opened another project. Idle: the chat follows it. While a turn
 * is running: the chat stays with its own project (the agent's reply is still
 * coming, and it may be the agent that opened the project) and remembers the
 * open one in `held`, for the banner and followOpenProject. Opening the
 * chat's own project again clears `held`.
 */
export function onProjectOpened(projectId: string, name: string, by = opener) {
  const st = useChat.getState();
  if (st.projectId === projectId) {
    if (st.held) useChat.setState({ held: null });
    return;
  }
  if (st.projectId && (st.busy || st.held)) {
    useChat.setState({ held: { projectId, name, ...(by ? { by } : {}) } });
    return;
  }
  void loadChat(projectId);
}

/** The banner while the chat is held on its project (null when it is not). */
export function heldBanner(st: Pick<ChatStore, 'held' | 'projectName' | 'busy'>): { text: string; action: string } | null {
  if (!st.held) return null;
  const opened = `${st.held.by ? `${st.held.by} opened` : 'The editor opened'} “${st.held.name}”`;
  const own = st.projectName ? `“${st.projectName}”` : 'the project it started in';
  return {
    text: st.busy ? `${opened} — this conversation stays with ${own} while the reply finishes.` : `${opened} — this conversation stays with ${own}.`,
    action: 'Show this project’s chat',
  };
}

/** "Show this project's chat": leave the held conversation for the open project's. */
export function followOpenProject() {
  const open = useEditor.getState().doc.project;
  useChat.setState({ held: null });
  if (useChat.getState().projectId !== open.id) void loadChat(open.id);
}

/** Keep the chat on the open project (see onProjectOpened). Returns a stop function. */
export function startChatSync(): () => void {
  void loadProviders();
  void loadChat();
  return useEditor.subscribe((s, prev) => {
    if (s.doc.project.id !== prev.doc.project.id) onProjectOpened(s.doc.project.id, s.doc.project.name);
    else if (s.doc.project.name !== prev.doc.project.name && s.doc.project.id === useChat.getState().projectId) useChat.setState({ projectName: s.doc.project.name });
  });
}

// ---------------------------------------------------------------------------
// Model search (agents like Cursor offer hundreds of models)
// ---------------------------------------------------------------------------

/** Every word of the query appears in the model's label or id (case-insensitive). */
export function modelMatches(m: ModelOption, query: string): boolean {
  const hay = `${m.label} ${m.id}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((w) => hay.includes(w));
}

// ---------------------------------------------------------------------------
// Replies: a small, safe Markdown subset. Agents write paragraphs, **bold**,
// *italic*, `code`, lists, and the odd heading, rule or fenced block. This
// parses that into a tree the panel renders as React nodes (never as HTML);
// any other syntax stays plain text.
// ---------------------------------------------------------------------------

export type MdInline = { type: 'text' | 'code'; text: string } | { type: 'strong' | 'em'; children: MdInline[] } | { type: 'br' };

export interface MdListItem {
  content: MdInline[];
  /** Nested lists. */
  children: MdBlock[];
}

export type MdBlock =
  | { type: 'paragraph' | 'heading'; content: MdInline[] }
  | { type: 'code'; text: string }
  | { type: 'rule' }
  | { type: 'list'; ordered: boolean; start: number; items: MdListItem[] };

const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const FENCE = /^ *(```|~~~)/;
const HEADING = /^ {0,3}#{1,6}\s+(.+?)(?:\s+#+)?\s*$/;
const RULE = /^ {0,3}([-*_])(?: *\1){2,} *$/;
const ESCAPABLE = /[\\`*_{}[\]()#+\-.!>~|]/;

const indentOf = (line: string) => line.length - line.trimStart().length;
const isSpace = (c: string | undefined) => c === undefined || /\s/.test(c);
const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);

export function parseMarkdown(text: string): MdBlock[] {
  const lines = text
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/^\t+/, (t) => '    '.repeat(t.length)));
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: 'paragraph', content: inlineLines(para) });
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE.exec(line);
    if (!line.trim()) {
      flush();
      i++;
    } else if (fence) {
      flush();
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i].trimStart().startsWith(fence[1]); i++) body.push(lines[i]);
      blocks.push({ type: 'code', text: body.join('\n') });
      i++; // the closing fence
    } else if (RULE.test(line)) {
      flush();
      blocks.push({ type: 'rule' });
      i++;
    } else if (HEADING.test(line)) {
      flush();
      blocks.push({ type: 'heading', content: parseInline(HEADING.exec(line)![1]) });
      i++;
    } else if (LIST_ITEM.test(line)) {
      // In chat a list may follow its lead-in line directly ("I changed:\n- …").
      flush();
      const list = parseList(lines, i);
      blocks.push(list.block);
      i = list.next;
    } else {
      para.push(line.trim());
      i++;
    }
  }
  flush();
  return blocks;
}

/** One list starting at `start`: its items, their indented continuation lines and nested lists. */
function parseList(lines: string[], start: number): { block: MdBlock; next: number } {
  const first = LIST_ITEM.exec(lines[start])!;
  const base = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items: { lines: string[]; children: MdBlock[] }[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      // A blank line ends the list unless more of it follows.
      let j = i + 1;
      while (j < lines.length && !lines[j].trim()) j++;
      const next = lines[j];
      if (next === undefined || indentOf(next) < base || (indentOf(next) < base + 2 && !LIST_ITEM.test(next))) break;
      i = j;
      continue;
    }
    const m = LIST_ITEM.exec(line);
    const indent = indentOf(line);
    const item = items[items.length - 1];
    if (m && indent >= base + 2 && item) {
      const nested = parseList(lines, i);
      item.children.push(nested.block);
      i = nested.next;
    } else if (m && indent >= base && /\d/.test(m[2]) === ordered) {
      items.push({ lines: [m[3]], children: [] });
      i++;
    } else if (!m && indent >= base + 2 && item) {
      item.lines.push(line.trim());
      i++;
    } else {
      break;
    }
  }
  return {
    block: { type: 'list', ordered, start: ordered ? parseInt(first[2], 10) : 1, items: items.map((it) => ({ content: inlineLines(it.lines), children: it.children })) },
    next: i,
  };
}

/** Lines of one paragraph or item: kept as line breaks, the way chat replies are written. */
function inlineLines(lines: string[]): MdInline[] {
  return lines.flatMap((l, i) => (i ? [{ type: 'br' } as MdInline, ...parseInline(l)] : parseInline(l)));
}

/** Index of the next run of exactly `n` × `ch` at or after `from`, or -1. */
function findRun(s: string, ch: string, n: number, from: number): number {
  for (let j = s.indexOf(ch, from); j >= 0; j = s.indexOf(ch, j + 1)) {
    let k = j;
    while (s[k] === ch) k++;
    if (k - j === n) return j;
    j = k - 1;
  }
  return -1;
}

export function parseInline(s: string): MdInline[] {
  const out: MdInline[] = [];
  let text = '';
  const push = (node: MdInline) => {
    if (text) out.push({ type: 'text', text });
    text = '';
    out.push(node);
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && ESCAPABLE.test(s[i + 1] ?? '')) {
      text += s[i + 1];
      i += 2;
      continue;
    }
    if (c === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      const close = findRun(s, '`', n, i + n);
      if (close > i + n) {
        const code = s.slice(i + n, close);
        push({ type: 'code', text: /^ .* $/.test(code) && code.trim() ? code.slice(1, -1) : code });
        i = close + n;
      } else {
        text += s.slice(i, i + n);
        i += n;
      }
      continue;
    }
    const span = c === '*' || c === '_' ? emphasis(s, i) : null;
    if (span) {
      push(span.node);
      i = span.end;
      continue;
    }
    text += c;
    i++;
  }
  if (text) out.push({ type: 'text', text });
  return out;
}

/** `**strong**` / `*em*` (or with `_`) opening at `i`, if it closes on the same line. */
function emphasis(s: string, i: number): { node: MdInline; end: number } | null {
  const ch = s[i];
  const n = s[i + 1] === ch ? 2 : 1;
  if (isSpace(s[i + n])) return null; // "2 * 3" and list-like stars stay text
  if (ch === '_' && isWord(s[i - 1])) return null; // snake_case stays text
  for (let j = i + n; j < s.length; j++) {
    if (s[j] === '\\') {
      j++;
      continue;
    }
    if (s[j] === '`') {
      // Delimiters inside a code span don't count.
      let m = 1;
      while (s[j + m] === '`') m++;
      const close = findRun(s, '`', m, j + m);
      j = (close > 0 ? close : j) + m - 1;
      continue;
    }
    if (s[j] !== ch) continue;
    let run = 1;
    while (s[j + run] === ch) run++;
    const closes = !isSpace(s[j - 1]) && j > i + n && !(ch === '_' && isWord(s[j + run]));
    if (n === 1 && run === 1 && closes) return { node: { type: 'em', children: parseInline(s.slice(i + 1, j)) }, end: j + 1 };
    // "***both***": a strong closes on the last two of a longer run.
    if (n === 2 && run >= 2 && closes) return { node: { type: 'strong', children: parseInline(s.slice(i + 2, j + run - 2)) }, end: j + run };
    j += run - 1;
  }
  return null;
}
