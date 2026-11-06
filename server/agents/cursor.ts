// Cursor Agent provider, under the user's Cursor login (CURSOR_API_KEY is
// removed so a stray key never replaces it). Auto-apply, as it was when the
// message was sent, picks one of Cursor's two native transports per turn:
//
//   on:  `cursor-agent -p --output-format stream-json --auto-review`. Cursor's
//        own Auto-review decides on actions; print mode cannot ask the editor.
//        Its init event still says permissionMode "default", so the mode is
//        reported as configured, not as what Cursor ran.
//   off: `cursor-agent acp` (Agent Client Protocol). Cursor's permission
//        requests come to the editor's Allow/Deny prompt and are answered with
//        the one-time option Cursor offered, never "always". ACP ignores
//        --auto-review (it still asks), so answering its requests automatically
//        would bypass Cursor's check: the editor never does that.
//
// Cursor keeps print and ACP chats in separate native stores. ChatManager
// resumes one session per mode and passes across messages the other missed,
// so the editor conversation continues when the switch changes. Neither uses --force, --yolo or a
// sandbox override; the user's sandbox setting still applies. --approve-mcps
// starts every MCP server, --trust skips the workspace trust prompt.
//
// Cursor reads a workspace's MCP servers and permissions from its .cursor/
// folder, and starts MCP servers without the agent's environment, so each
// turn writes into the workspace:
//   .cursor/mcp.json — the motion-editor server with this editor's ports;
//   .cursor/cli.json — allow motion-editor tools, carrying the user's
//   global permissions plus denies for the editor's private paths
//   and keychain helper. The user's own MCP servers remain configured.
//
// There is no system-prompt flag: the instructions are prepended to the first
// prompt of each session. Model changes keep the chat: `--resume <id> --model
// <other>` in print mode; over ACP the loaded chat is switched with
// session/set_model, or the turn fails rather than silently keep the old model.
// Cursor reports no skill or MCP catalog and no skill use, so those stay unknown.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { extname, join } from 'node:path';
import { permissionTimeoutMs, type ChatSessionInfo, type ModelOption } from '../../src/core/api-contract';
import type { AgentEvent, AgentProvider, AgentTurn, ProviderStatus } from './types';
import { agentInstructions, cached, childEnv, editorMcpServer, explainFailures, probe, protectedPathPatterns, agentDeniedPaths, providerInfo, runJsonLines, type ProviderOptions } from './shared';
import { AsyncQueue, JsonRpcPeer } from './json-rpc';

export type CursorProviderOptions = ProviderOptions;

const env = () => childEnv(['CURSOR_API_KEY']);

const EDITOR_SERVER = 'motion-editor';

/** A turn can run for a long time; Stop (abort) ends it sooner. */
const PROMPT_TIMEOUT_MS = 6 * 60 * 60_000;

/** Images the model can read, sent as ACP image blocks when Cursor accepts them (other files go by path in the prompt). */
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** A permission card shows the request's input; an edit's whole new file would not fit. */
const MAX_DETAIL = 4000;

/** `cursor-agent --list-models` lines ("id - Label"); Auto becomes the default ('' = Cursor's own choice). */
export function parseCursorModels(out: string): ModelOption[] {
  const models: ModelOption[] = [{ id: '', label: 'Auto' }];
  for (const line of out.split('\n')) {
    const m = /^(\S+) - (.+)$/.exec(line.replace(/[​-‍﻿]/g, '').trim());
    if (!m || m[1] === 'auto') continue;
    models.push({ id: m[1], label: m[2].replace(/\s+/g, ' ').trim() });
  }
  return models;
}

/** Where cursor-agent keeps its global cli-config.json: CURSOR_DATA_DIR, else ~/.cursor. */
const cursorDataDir = () => process.env.CURSOR_DATA_DIR?.trim() || join(homedir(), '.cursor');

/**
 * The user's global Cursor permission rules (~/.cursor/cli-config.json, or
 * CURSOR_DATA_DIR). Cursor replaces, rather than merges, a permission array
 * that a workspace cli.json defines, so the workspace file must carry the
 * user's own rules to keep them in force.
 */
export function userCursorPermissions(dataDir = cursorDataDir()): { allow: string[]; deny: string[] } {
  try {
    const raw = JSON.parse(readFileSync(join(dataDir, 'cli-config.json'), 'utf8')) as { permissions?: { allow?: unknown; deny?: unknown } };
    const rules = (v: unknown) => (Array.isArray(v) ? v.filter((r): r is string => typeof r === 'string') : []);
    return { allow: rules(raw.permissions?.allow), deny: rules(raw.permissions?.deny) };
  } catch {
    return { allow: [], deny: [] };
  }
}

/** Writes the turn's .cursor/ files into the workspace: the editor's MCP server, and the user's own permission rules plus permission to use the editor's tools. */
export function writeCursorWorkspace(dir: string, opts: ProviderOptions, model?: string) {
  const server = editorMcpServer(opts, 'Cursor Agent', model);
  // Recreate even the two files we own: a previous agent may have planted
  // symlinks, hooks, rules or other trusted workspace configuration here.
  rmSync(join(dir, '.cursor'), { recursive: true, force: true });
  mkdirSync(join(dir, '.cursor'), { recursive: true });
  // Absolute node + tsx: Cursor starts MCP servers in the workspace (not the repo) with its own environment.
  const mcp = { mcpServers: { [EDITOR_SERVER]: { command: process.execPath, args: server.args, env: server.env } } };
  const user = userCursorPermissions();
  const editorRule = `Mcp(${EDITOR_SERVER}:*)`;
  const deny = [...user.deny, ...protectedPathPatterns(agentDeniedPaths(opts.rootDir)).flatMap(path => [`Read(${path})`, `Write(${path})`]), 'Shell(secret-tool)'];
  const cli = { permissions: { allow: [...user.allow.filter((r) => r !== editorRule), editorRule], deny } };
  writeFileSync(join(dir, '.cursor', 'mcp.json'), JSON.stringify(mcp, null, 2));
  writeFileSync(join(dir, '.cursor', 'cli.json'), JSON.stringify(cli, null, 2));
}

function object(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : null;
}

/** The MCP server and tool exactly as Cursor names them on a call (providerIdentifier / toolName); never split from a combined name. */
function mcpIdentity(...candidates: unknown[]): { server: string; tool: string } | null {
  for (const c of candidates) {
    const o = object(c);
    if (o && typeof o.providerIdentifier === 'string' && o.providerIdentifier && typeof o.toolName === 'string' && o.toolName) return { server: o.providerIdentifier, tool: o.toolName };
  }
  return null;
}

type ToolEvent = Extract<AgentEvent, { type: 'tool' }>;

const mcpTool = (id: { server: string; tool: string }, input: unknown): ToolEvent => ({ type: 'tool', name: `mcp__${id.server}__${id.tool}`, input: input ?? {}, mcpServer: id.server, mcpTool: id.tool });

/** Print mode's tool-call kinds as tool names. */
function printTool(call: Record<string, any>): ToolEvent | null {
  const kind = Object.keys(call).find((k) => k.endsWith('ToolCall'));
  if (!kind || kind === 'getMcpToolsToolCall') return null; // looking up a tool's schema, not using it
  const args = call[kind]?.args ?? {};
  if (kind === 'mcpToolCall') {
    const id = mcpIdentity(args);
    return id ? mcpTool(id, args.args) : { type: 'tool', name: String(args.name ?? 'mcp'), input: args.args ?? {} };
  }
  if (kind === 'readToolCall') return { type: 'tool', name: 'Read', input: args };
  return { type: 'tool', name: kind.replace(/ToolCall$/, ''), input: {} };
}

/** ACP tool kinds as the tool names the chat labels. */
const ACP_TOOL_NAMES: Record<string, string> = { read: 'Read', edit: 'edit', delete: 'delete', move: 'move', search: 'grep', execute: 'shell', fetch: 'webFetch' };

function acpTool(update: Record<string, any>): ToolEvent {
  const raw = object(update.rawInput);
  const meta = object(update._meta);
  const id = mcpIdentity(raw, meta, ...Object.values(meta ?? {}));
  if (id) return mcpTool(id, raw?.args ?? raw);
  const title = typeof update.title === 'string' ? update.title.trim().slice(0, 80) : '';
  return { type: 'tool', name: ACP_TOOL_NAMES[update.kind] ?? (title || String(update.kind ?? 'tool')), input: raw ?? {} };
}

/** What a permission request asks, in the editor's words. */
const ACTIONS: Record<string, string> = { read: 'Read files', edit: 'Change files', delete: 'Delete files', move: 'Move files', search: 'Search files', execute: 'Run a terminal command', fetch: 'Fetch from the web' };

function permissionAction(call: Record<string, any>): string {
  const id = mcpIdentity(object(call.rawInput), object(call._meta));
  if (id) return `Use ${id.tool} from the ${id.server} MCP server`;
  const title = typeof call.title === 'string' ? call.title.trim() : '';
  const base = ACTIONS[call.kind] ?? 'Use a tool';
  return title ? `${base}: ${title}` : base;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createCursorProvider(opts: CursorProviderOptions): AgentProvider {
  const bin = opts.bin ?? process.env.MGE_CURSOR_BIN ?? 'cursor-agent';
  const models = cached(5 * 60_000, async () => {
    const r = await probe(bin, ['--list-models'], env(), 20000);
    return r.ok ? parseCursorModels(r.out) : [{ id: '', label: 'Auto' }];
  });
  /** CLI model ids (from --list-models) → the ACP model ids Cursor resolved them to for a new chat, this server run. */
  const resolvedModels = new Map<string, string>();
  const firstPrompt = (turn: AgentTurn) => (turn.sessionId ? turn.prompt : `[Instructions for this chat]\n${agentInstructions(opts.rootDir, { fullToolset: true })}\n[End of instructions]\n\n${turn.prompt}`);
  const printArgs = (turn: AgentTurn): string[] => [
    '-p',
    '--output-format',
    'stream-json',
    '--stream-partial-output',
    '--auto-review',
    '--approve-mcps',
    '--trust',
    '--workspace',
    turn.workspace,
    ...(turn.model ? ['--model', turn.model] : []),
    ...(turn.sessionId ? ['--resume', turn.sessionId] : []),
    '--',
    firstPrompt(turn),
  ];
  // --model before the subcommand: Cursor resolves the CLI model id itself.
  const acpArgs = (turn: AgentTurn): string[] => ['--approve-mcps', '--trust', '--workspace', turn.workspace, ...(turn.model ? ['--model', turn.model] : []), 'acp'];

  return {
    id: 'cursor',
    label: 'Cursor Agent',
    resumesAcrossModels: true,

    async status(): Promise<ProviderStatus> {
      const info = (state: Parameters<typeof providerInfo>[2], detail: string, list = [{ id: '', label: 'Auto' }]) => providerInfo('cursor', 'Cursor Agent', state, detail, list);
      const [v, login] = await Promise.all([probe(bin, ['--version'], env()), probe(bin, ['status'], env())]);
      if (!v.ok) return v.missing ? info('not-installed', 'Cursor Agent is not installed (the `cursor-agent` command was not found). Install it, run `cursor-agent login`, then check again.') : info('error', `Cursor Agent did not start: ${v.out.slice(0, 200)}`);
      if (!login.ok || !/logged in/i.test(login.out) || /not logged in/i.test(login.out)) return info('signed-out', `Cursor Agent ${v.out.split('\n')[0]} is installed but not signed in. Run \`cursor-agent login\` in a terminal, then check again.`);
      return info('ready', `Cursor Agent ${v.out.split('\n')[0]} · ${login.out.replace(/^\W+/, '').split('\n')[0]}`, await models());
    },

    run(turn: AgentTurn): AsyncIterable<AgentEvent> {
      return explainFailures('cursor', turn.autoApply === true ? runPrint(turn) : runAcp(turn));
    },
  };

  /** Auto-apply on: print mode with Cursor's Auto-review. */
  async function* runPrint(turn: AgentTurn): AsyncIterable<AgentEvent> {
    writeCursorWorkspace(turn.workspace, opts, turn.model);
    // With --stream-partial-output, text arrives as deltas (timestamp_ms, no
    // model_call_id) and then once more as the whole message; skip the repeat.
    let streamed = '';
    yield* runJsonLines('Cursor Agent', bin, printArgs(turn), { cwd: turn.workspace, env: env(), signal: turn.signal, loginHint: 'Run `cursor-agent login` in a terminal to sign in.' }, (e) => {
      const events: AgentEvent[] = [];
      if (e.type === 'system' && e.subtype === 'init' && e.session_id) {
        events.push({ type: 'session', sessionId: e.session_id });
        // The init event says "default" even with --auto-review: the mode is the one the editor asked for.
        events.push({
          type: 'session-info',
          info: { sessionId: e.session_id, ...(typeof e.model === 'string' && e.model ? { model: e.model } : {}), permissionMode: 'cursor-auto-review', permissionSource: 'configured', skillUsageReported: false, tools: [] },
        });
      } else if (e.type === 'assistant') {
        const text = (e.message?.content ?? []).map((c: { text?: string }) => c.text ?? '').join('');
        const delta = e.timestamp_ms !== undefined && e.model_call_id === undefined;
        if (delta) {
          streamed += text;
          if (text) events.push({ type: 'text', text });
        } else {
          if (text && text !== streamed) events.push({ type: 'text', text });
          streamed = '';
        }
      } else if (e.type === 'tool_call' && e.subtype === 'started' && e.tool_call) {
        const tool = printTool(e.tool_call);
        if (tool) events.push(tool);
      } else if (e.type === 'result') {
        if (e.session_id) events.push({ type: 'session', sessionId: e.session_id });
        events.push(e.is_error ? { type: 'done', isError: true, error: String(e.result ?? e.subtype ?? 'Cursor reported an error') } : { type: 'done', isError: false });
        return { events, finished: true };
      }
      return { events };
    });
  }

  /** Auto-apply off: ACP, with Cursor's permission requests answered in the editor. */
  async function* runAcp(turn: AgentTurn): AsyncIterable<AgentEvent> {
    if (turn.signal.aborted) {
      yield { type: 'done', isError: true, error: 'Stopped.' };
      return;
    }
    writeCursorWorkspace(turn.workspace, opts, turn.model);
    const queue = new AsyncQueue<AgentEvent>();
    let sessionId: string | null = null;
    // session/load replays the chat's history as updates first: only our prompt's updates count.
    let prompting = false;
    let finished = false;
    let stopTimer: ReturnType<typeof setTimeout> | undefined;
    // Give ACP its native cancellation before closing the process.
    const connection = new AbortController();
    const tools = new Set<string>();
    let peer!: JsonRpcPeer;

    const complete = (error?: string) => {
      if (finished) return;
      finished = true;
      if (stopTimer) clearTimeout(stopTimer);
      queue.push({ type: 'done', isError: !!error, ...(error ? { error } : {}) });
      queue.end();
      peer?.close();
    };
    const stop = () => {
      if (finished || stopTimer) return;
      if (!prompting || !sessionId) return complete('Stopped.');
      peer.notify('session/cancel', { sessionId });
      stopTimer = setTimeout(() => complete('Stopped.'), 3000);
    };
    const isActive = (params: Record<string, unknown>) => !finished && !turn.signal.aborted && prompting && !!sessionId && params.sessionId === sessionId;

    const notification = (method: string, value: unknown) => {
      const params = object(value);
      if (method !== 'session/update' || !params || !isActive(params)) return;
      const update = object(params.update);
      if (update?.sessionUpdate === 'agent_message_chunk') {
        const content = object(update.content);
        if (content?.type === 'text' && typeof content.text === 'string' && content.text) queue.push({ type: 'text', text: content.text });
      } else if (update?.sessionUpdate === 'tool_call' && typeof update.toolCallId === 'string' && !tools.has(update.toolCallId)) {
        tools.add(update.toolCallId);
        queue.push(acpTool(update));
      }
    };

    /** The editor's answer; a missing prompt, an error, Stop, the timeout or a late answer all deny. */
    const ask = async (action: string, detail: string, params: Record<string, unknown>): Promise<boolean> => {
      if (!isActive(params) || !turn.askPermission) return false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        return (
          (await Promise.race([
            Promise.resolve().then(() => turn.askPermission!(action, detail)).then((value) => value === true),
            new Promise<boolean>((resolve) => {
              timer = setTimeout(() => resolve(false), permissionTimeoutMs());
            }),
            new Promise<boolean>((resolve) => {
              abort = () => resolve(false);
              turn.signal.addEventListener('abort', abort, { once: true });
            }),
          ])) && isActive(params)
        );
      } catch {
        return false;
      } finally {
        if (timer) clearTimeout(timer);
        if (abort) turn.signal.removeEventListener('abort', abort);
      }
    };

    const requestPermission = async (params: Record<string, any>) => {
      const options = (Array.isArray(params.options) ? params.options : []).map(object).filter((o): o is Record<string, any> => typeof o?.optionId === 'string');
      // Only the one-time options: an "always" answer would change Cursor's rules for later turns.
      // Cursor can also reuse request_permission for multiple-choice questions.
      // An Allow button cannot faithfully answer those; leave them unanswered.
      const once = options.filter((o) => o.kind === 'allow_once');
      const allowOnce = once.length === 1 && !options.some(o => o.optionId === '__ask_question_skip__') ? once[0] : undefined;
      const rejectOnce = options.find((o) => o.kind === 'reject_once');
      const call = object(params.toolCall) ?? {};
      const full = JSON.stringify({ ...(call.kind ? { kind: call.kind } : {}), ...(call.rawInput !== undefined ? { input: call.rawInput } : {}), ...(Array.isArray(call.locations) ? { locations: call.locations } : {}) }, null, 2);
      const detail = full.length > MAX_DETAIL ? `${full.slice(0, MAX_DETAIL)}…` : full;
      const allow = !!allowOnce && (await ask(permissionAction(call), detail, params));
      if (allow && isActive(params)) return { outcome: { outcome: 'selected', optionId: allowOnce!.optionId } };
      if (!isActive(params) || !rejectOnce) return { outcome: { outcome: 'cancelled' } };
      return { outcome: { outcome: 'selected', optionId: rejectOnce.optionId } };
    };

    const serverRequest = async (method: string, value: unknown): Promise<unknown> => {
      const params = object(value) ?? {};
      if (method === 'session/request_permission') return requestPermission(params);
      // Cursor's plan and question prompts need their own UI: decline them, so Cursor carries on in chat instead.
      if (/^_?cursor\/create_plan$/.test(method)) return { outcome: { outcome: 'rejected', reason: 'This editor cannot review plans. Describe the plan in your reply instead.' } };
      if (/^_?cursor\/ask_question$/.test(method)) return { outcome: { outcome: 'skipped', reason: 'This editor cannot show this question. Ask it in your reply instead.' } };
      // The editor offers no files or terminals of its own (initialize says so); anything else is refused.
      throw new Error(`Unsupported Cursor request: ${method}`);
    };

    try {
      peer = new JsonRpcPeer(bin, acpArgs(turn), {
        cwd: turn.workspace,
        env: env(),
        signal: connection.signal,
        jsonrpc: true,
        onNotification: notification,
        onRequest: serverRequest,
        onClose: (error) => complete(turn.signal.aborted ? 'Stopped.' : error.message),
      });
      turn.signal.addEventListener('abort', stop, { once: true });
      if (turn.signal.aborted) stop();
      void (async () => {
        try {
          const init = object(
            await peer.request(
              'initialize',
              { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'motion-graphics-editor', title: 'Motion Graphics Editor', version: '0.1.0' } },
              15000,
            ),
          );
          if (!init || init.protocolVersion !== 1) throw new Error('Cursor Agent answered with an ACP version this editor does not speak. Update Cursor Agent and retry.');
          const capabilities = object(init.agentCapabilities);
          if (turn.sessionId && capabilities?.loadSession !== true) throw new Error('This Cursor Agent cannot continue a chat over ACP. Update Cursor Agent, or press New chat.');

          let session: Record<string, any> | null;
          if (turn.sessionId) {
            session = object(await peer.request('session/load', { sessionId: turn.sessionId, cwd: turn.workspace, mcpServers: [] }, 60000));
            sessionId = turn.sessionId;
          } else {
            session = object(await peer.request('session/new', { cwd: turn.workspace, mcpServers: [] }, 30000));
            if (typeof session?.sessionId !== 'string' || !session.sessionId) throw new Error('Cursor Agent returned an invalid ACP session. Update Cursor Agent and retry.');
            sessionId = session.sessionId;
          }
          if (turn.signal.aborted || finished) return;
          const model = await chatModel(sessionId!, session);
          if (turn.signal.aborted || finished) return;
          queue.push({ type: 'session', sessionId: sessionId! });
          const info: ChatSessionInfo = { sessionId: sessionId!, ...(model ? { model } : {}), permissionMode: 'cursor-manual', permissionSource: 'configured', skillUsageReported: false, tools: [] };
          queue.push({ type: 'session-info', info });

          const prompt: Record<string, unknown>[] = [{ type: 'text', text: firstPrompt(turn) }];
          if (object(capabilities?.promptCapabilities)?.image === true) prompt.push(...imageBlocks(turn.images));
          prompting = true;
          const result = object(await peer.request('session/prompt', { sessionId, prompt }, PROMPT_TIMEOUT_MS));
          const stop = result?.stopReason;
          if (stop === 'end_turn') complete(turn.signal.aborted ? 'Stopped.' : undefined);
          else if (stop === 'cancelled') complete('Stopped.');
          else complete(`Cursor Agent stopped: ${stop === 'refusal' ? 'it declined this request' : stop === 'max_tokens' ? 'it reached its output limit' : stop === 'max_turn_requests' ? 'it reached its step limit' : `unexpected reason ${JSON.stringify(stop ?? null)}`}.`);
        } catch (error) {
          complete(turn.signal.aborted ? 'Stopped.' : errorMessage(error));
        }
      })();
      yield* queue;
    } finally {
      finished = true;
      if (stopTimer) clearTimeout(stopTimer);
      turn.signal.removeEventListener('abort', stop);
      peer?.close();
    }

    /**
     * The model the chat runs on (the ACP id Cursor reports). A new chat takes
     * the --model Cursor resolved; a loaded chat keeps its own until switched,
     * so the selected model is matched to Cursor's list (its id, the id Cursor
     * resolved it to earlier, or its label) and set. Unmatched, the turn fails.
     */
    async function chatModel(id: string, session: Record<string, any> | null): Promise<string | undefined> {
      const list = object(session?.models);
      const current = typeof list?.currentModelId === 'string' && list.currentModelId ? list.currentModelId : undefined;
      if (!turn.sessionId) {
        if (turn.model && current) resolvedModels.set(turn.model, current);
        return current;
      }
      const available = (Array.isArray(list?.availableModels) ? list.availableModels : []).map(object).filter((m): m is Record<string, any> => typeof m?.modelId === 'string');
      const wanted = turn.model || 'auto';
      const label = turn.model ? (await models()).find((m) => m.id === turn.model)?.label : 'Auto';
      const target =
        [wanted, resolvedModels.get(wanted)].find((m) => m && available.some((a) => a.modelId === m)) ?? (label ? available.find((a) => a.name === label)?.modelId : undefined);
      if (!target) {
        // Auto is Cursor's own choice: whatever the chat runs on is reported as it is.
        if (!turn.model) return current;
        throw new Error(`Cursor Agent could not confirm that this chat continues on ${label ?? turn.model}. Pick the model again, or press New chat.`);
      }
      if (target === current) return current;
      try {
        await peer.request('session/set_model', { sessionId: id, modelId: target }, 15000);
      } catch (error) {
        throw new Error(`Cursor Agent could not switch this chat to ${label ?? turn.model}: ${errorMessage(error)}`);
      }
      return target;
    }
  }
}

/** Image attachments as ACP image blocks; anything unreadable, too large or not an image stays a path in the prompt. */
function imageBlocks(paths: string[]): Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [];
  for (const path of paths) {
    const mimeType = IMAGE_TYPES[extname(path).toLowerCase()];
    if (!mimeType) continue;
    try {
      if (statSync(path).size > MAX_IMAGE_BYTES) continue;
      blocks.push({ type: 'image', mimeType, data: readFileSync(path).toString('base64') });
    } catch {
      // The prompt still names the file.
    }
  }
  return blocks;
}
