// Claude Code provider: one `claude -p` process per chat turn, resumed by
// session id, streaming JSON events. Runs under the user's own Claude Code
// login (ANTHROPIC_API_KEY is removed from its environment so a stray key
// never switches billing to the API), in the project's workspace folder
// (turn.workspace, outside the repo), with uploads in public/ added as a
// readable folder.
//
// Full toolset, like Claude Code in a terminal: built-in tools (shell, edits,
// web search and fetch, subagents, skills), plugins and every MCP server and
// claude.ai connector the user has. The user's own permission rules apply;
// anything they don't allow is asked in the editor through the editor's
// permission prompt (--permission-prompt-tool), whose card names the action.
// The editor's own tools are pre-allowed.
//
// Permission mode per turn: "default" (Manual: it asks before acting), or
// Claude Code's own "auto" mode when the user sent the message with
// Auto-apply on (its classifier reviews actions instead of asking; explicit
// ask rules still ask, through the same permission prompt). Never anything
// that skips permissions.
//
// Model changes keep the session: --model applies per invocation, also with
// --resume.
//
// Sign-in state comes from `claude auth status` (JSON with `loggedIn`); a
// Claude Code too old to have that command is treated as signed in, as before.
//
// Every turn is fail-closed on its init event: nothing the CLI streams is
// accepted before it, and the process is killed before the model can act if
// the tool list is not a list of names or the permission mode is not the one
// the editor passed (Claude Code starts in Manual when auto mode isn't
// available, and a mode other than those two might not ask). Events other
// than model activity that come before init (rate-limit notices, hooks) are
// ignored. The init's session details (model, mode, MCP servers, skills) go to
// the chat as a `session-info` event.

import { join } from 'node:path';
import type { ChatSessionInfo } from '../../src/core/api-contract';
import { EDITOR_MCP_SERVER, mcpToolPrefix } from '../../src/core/generation';
import type { AgentEvent, AgentProvider, AgentTurn, ProviderStatus } from './types';
import { agentInstructions, childEnv, editorMcpServer, explainFailures, probe, protectedPathPatterns, agentDeniedPaths, providerInfo, runJsonLines, type ProviderOptions } from './shared';

export type ClaudeProviderOptions = ProviderOptions;

/** Aliases checked with `claude -p --model <id>` (opus → Opus 5.5, sonnet → Sonnet 5.5, haiku → Haiku 5.5). */
export const CLAUDE_MODELS = [
  { id: '', label: 'Default' },
  { id: 'opus', label: 'Opus' },
  { id: 'sonnet', label: 'Sonnet' },
  { id: 'haiku', label: 'Haiku' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
];

const env = () => childEnv(['ANTHROPIC_API_KEY']);

const EDITOR_SERVER = EDITOR_MCP_SERVER;
const EDITOR_PREFIX = `${mcpToolPrefix(EDITOR_SERVER)}__`;

/** The permission modes the editor runs Claude Code in. */
export type ClaudePermissionMode = 'default' | 'auto';

/** Auto-apply on: Claude Code's auto mode; off (or unknown): default, where it asks. */
export function claudePermissionMode(autoApply: boolean | undefined): ClaudePermissionMode {
  return autoApply === true ? 'auto' : 'default';
}

/** The `claude -p` arguments for one turn. */
export function claudeArgs(turn: Pick<AgentTurn, 'prompt' | 'model' | 'sessionId' | 'autoApply'>, o: { mcpConfig: string; instructions: string; publicDir: string; protectedPaths: string[] }): string[] {
  // Bash rules are a speed bump: a reworded command gets through. The hard
  // boundaries are the server's editor session and the prepaid fal key cap; see SECURITY.md.
  const deny = [
    ...protectedPathPatterns(o.protectedPaths).flatMap(path => [`Read(/${path})`, `Edit(/${path})`]),
    ...o.protectedPaths.map(path => `Bash(*${path}*)`),
    'Bash(*.config/motion-editor*)', 'Bash(*secret-tool*)', 'Bash(*find-generic-password*)',
  ];
  return [
    '-p',
    turn.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--mcp-config',
    o.mcpConfig,
    '--settings',
    JSON.stringify({ permissions: { deny } }),
    // Only the user's own settings: the workspace is shared with other agents, and a
    // project .claude/settings.json written there (for example by Codex) must not add
    // allow rules or hooks to this turn.
    '--setting-sources',
    'user',
    // Explicit, so a defaultMode in the user's Claude Code settings can't change it (the init check still verifies it).
    '--permission-mode',
    claudePermissionMode(turn.autoApply),
    '--permission-prompt-tool',
    `${EDITOR_PREFIX}editor_permission_prompt`,
    '--allowedTools',
    `${EDITOR_PREFIX}*`,
    // Uploads and attachments live in the editor's public/ folder, outside the workspace.
    '--add-dir',
    o.publicDir,
    '--append-system-prompt',
    o.instructions,
    ...(turn.model ? ['--model', turn.model] : []),
    ...(turn.sessionId ? ['--resume', turn.sessionId] : []),
  ];
}

/**
 * The fail-closed gate on the CLI's `system`/`init` event: the tool list must
 * be reported, every entry a string, and the permission mode must be exactly
 * the one the editor passed (`expected`; "default" unless Auto-apply asked for
 * "auto"). A failure stops the turn.
 */
export function checkInitTools(init: { tools?: unknown; permissionMode?: unknown }, expected: ClaudePermissionMode = 'default'): { ok: true } | { ok: false; message: string } {
  const raw = init.tools;
  if (!Array.isArray(raw) || !raw.every((t): t is string => typeof t === 'string')) {
    return { ok: false, message: 'Claude Code did not report its tools as a list of names, so the editor could not check them. The editor stopped the turn; nothing ran.' };
  }
  if (init.permissionMode !== expected) {
    const mode = init.permissionMode === undefined ? 'no permission mode' : `permission mode “${String(init.permissionMode)}”`;
    if (expected === 'auto') {
      // Claude Code starts in Manual ("default") when auto mode isn't available to the session.
      return {
        ok: false,
        message: `Auto-apply is on, so the editor asked Claude Code for auto mode, but it started with ${mode}. The editor stopped the turn; nothing ran. Auto mode may not be available here: it needs a model that supports it, no Claude Code setting that turns it off (disableAutoMode), and it can be off on Anthropic’s side (a session where it was refused keeps it off; New chat starts a fresh one). Turn Auto-apply off to continue with Claude Code asking you first, or pick another model.`,
      };
    }
    return { ok: false, message: `Claude Code started with ${mode}, so its actions might not ask you first. The editor stopped the turn; nothing ran. Remove the default permission mode from your Claude Code settings.` };
  }
  return { ok: true };
}

const isName = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200;

/** The reported MCP server a tool belongs to (Claude Code names them mcp__<server>__<tool>); the longest prefix wins. */
export function mcpServerOf(tool: string, servers: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const s of servers) {
    if (tool.startsWith(`${mcpToolPrefix(s)}__`) && (!best || mcpToolPrefix(s).length > mcpToolPrefix(best).length)) best = s;
  }
  return best;
}

/**
 * The session details of an init event, for the chat: session id, model,
 * permission mode, MCP servers (name, status, how many tools), skills, and the
 * remaining tool names. Only names and statuses: no cwd, plugin
 * paths, API key source or anything else the event carries. Fields the event
 * lacks stay absent.
 */
export function sessionInfo(init: Record<string, unknown>): ChatSessionInfo {
  const { session_id: sessionId, model, permissionMode, tools: rawTools, mcp_servers: rawServers, skills: rawSkills } = init;
  const tools = Array.isArray(rawTools) ? rawTools.filter(isName) : [];
  const servers = Array.isArray(rawServers)
    ? rawServers.flatMap((s: unknown) => (s && typeof s === 'object' && isName((s as { name?: unknown }).name) ? [s as { name: string; status?: unknown }] : []))
    : undefined;
  const names = servers?.map((s) => s.name) ?? [];
  const counts = new Map<string, number>();
  const rest: string[] = [];
  for (const t of tools) {
    const server = mcpServerOf(t, names);
    if (server) counts.set(server, (counts.get(server) ?? 0) + 1);
    else rest.push(t);
  }
  // Agent SDK: skills is a list of names; an object with a name is taken too.
  const nameOf = (s: unknown): string[] => (isName(s) ? [s] : s && typeof s === 'object' && isName((s as { name?: unknown }).name) ? [(s as { name: string }).name] : []);
  const skills = Array.isArray(rawSkills) ? rawSkills.flatMap(nameOf) : undefined;
  return {
    ...(isName(sessionId) ? { sessionId } : {}),
    ...(isName(model) ? { model } : {}),
    ...(isName(permissionMode) ? { permissionMode } : {}),
    tools: rest,
    ...(servers ? { mcpServers: servers.map((s) => ({ name: s.name, status: isName(s.status) ? s.status : 'unknown', tools: counts.get(s.name) ?? 0 })) } : {}),
    ...(skills ? { skills } : {}),
  };
}

/** The skill a Skill tool call invokes (its `skill` input), or undefined. */
export function invokedSkill(name: string, input: unknown): string | undefined {
  if (name !== 'Skill') return undefined;
  const skill = (input as { skill?: unknown } | null)?.skill;
  return isName(skill) ? skill.replace(/^\//, '') : undefined;
}

export function createClaudeProvider(opts: ClaudeProviderOptions): AgentProvider {
  const bin = opts.bin ?? process.env.MGE_CLAUDE_BIN ?? 'claude';
  // Per turn, so the editor credits proposals to the model that made them.
  const mcpConfig = (model: string) => JSON.stringify({ mcpServers: { [EDITOR_SERVER]: editorMcpServer(opts, 'Claude Code', model) } });

  return {
    id: 'claude',
    label: 'Claude Code',
    resumesAcrossModels: true,

    async status(): Promise<ProviderStatus> {
      const info = (state: Parameters<typeof providerInfo>[2], detail: string) => providerInfo('claude', 'Claude Code', state, detail, CLAUDE_MODELS);
      const [v, auth] = await Promise.all([probe(bin, ['--version'], env()), probe(bin, ['auth', 'status'], env())]);
      if (!v.ok) {
        if (v.missing) return info('not-installed', 'Claude Code is not installed (the `claude` command was not found). Install it, run `claude auth login`, then check again.');
        return info('error', `Claude Code did not start: ${v.out.slice(0, 200)}`);
      }
      const version = v.out.split('\n')[0];
      const login = parseClaudeAuthStatus(auth.stdout);
      if (login?.loggedIn === false) return info('signed-out', `${version} is installed but not signed in. Run \`claude auth login\` in a terminal, then check again.`);
      return info('ready', login?.method ? `${version} · signed in (${login.method})` : version);
    },

    run(turn: AgentTurn): AsyncIterable<AgentEvent> {
      return explainFailures('claude', runTurn(turn));
    },
  };

  async function* runTurn(turn: AgentTurn): AsyncIterable<AgentEvent> {
    let streamedText = false;
    // The init gate kills the process through this signal; the user's Stop still does too.
    const local = new AbortController();
    const stop = () => local.abort();
    if (turn.signal.aborted) local.abort();
    turn.signal.addEventListener('abort', stop);
    let blocked = false;
    /** Nothing but other `system` events is accepted until a valid init has been checked. */
    let checked = false;
    const mode = claudePermissionMode(turn.autoApply);
    /** MCP servers the init reported, to tell which server a tool call goes to. */
    let servers: string[] = [];
    const stopTurn = (message: string) => {
      blocked = true;
      local.abort();
      return { events: [{ type: 'done', isError: true, error: message } satisfies AgentEvent], finished: true };
    };
    const args = claudeArgs(turn, { mcpConfig: mcpConfig(turn.model), instructions: agentInstructions(opts.rootDir, { fullToolset: true }), publicDir: join(opts.rootDir, 'public'), protectedPaths: agentDeniedPaths(opts.rootDir) });
    try {
      yield* runJsonLines('Claude Code', bin, args, { cwd: turn.workspace, env: env(), signal: local.signal, loginHint: 'Run `claude` once in a terminal to log in.' }, (e) => {
      const events: AgentEvent[] = [];
      if (blocked) return { events };
      if (e.type === 'system' && e.subtype === 'init') {
        const gate = checkInitTools(e, mode);
        if (!gate.ok) return stopTurn(gate.message);
        checked = true;
        if (e.session_id) events.push({ type: 'session', sessionId: e.session_id });
        const info = sessionInfo(e);
        servers = info.mcpServers?.map((s) => s.name) ?? [];
        events.push({ type: 'session-info', info });
        return { events };
      }
      if (!checked) {
        // The CLI failed before starting the model (signed out, bad flag): report it.
        if (e.type === 'result' && e.is_error) return { events: [{ type: 'done', isError: true, error: String(e.result ?? e.subtype ?? 'Claude reported an error') }], finished: true };
        // Model activity (or a finished turn) before a checked init stops the turn; anything
        // else (system notices, rate_limit_event, event types newer than this editor) is ignored.
        if (e.type === 'assistant' || e.type === 'user' || e.type === 'stream_event' || e.type === 'result') {
          return stopTurn(`Claude Code produced ${e.type === 'result' ? 'a result' : 'model activity'} before reporting its tools and permission mode, so the editor could not check them. The editor stopped the turn.`);
        }
        return { events };
      }
      if (e.type === 'stream_event') {
        const ev = e.event;
        if (ev?.type === 'message_start') streamedText = false;
        if (ev?.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          streamedText = true;
          events.push({ type: 'text', text: ev.delta.text });
        }
      } else if (e.type === 'assistant') {
        for (const block of e.message?.content ?? []) {
          if (block.type === 'tool_use') {
            const skill = invokedSkill(block.name, block.input);
            const mcpServer = typeof block.name === 'string' ? mcpServerOf(block.name, servers) : undefined;
            events.push({ type: 'tool', name: block.name, input: block.input, ...(skill ? { skill } : {}), ...(mcpServer ? { mcpServer } : {}) });
          }
          // Only if this message's text did not arrive as deltas.
          else if (block.type === 'text' && block.text && !streamedText) events.push({ type: 'text', text: block.text });
        }
      } else if (e.type === 'result') {
        if (e.session_id) events.push({ type: 'session', sessionId: e.session_id });
        events.push(e.is_error ? { type: 'done', isError: true, error: String(e.result ?? e.subtype ?? 'Claude reported an error') } : { type: 'done', isError: false });
        return { events, finished: true };
      }
      return { events };
      });
    } finally {
      turn.signal.removeEventListener('abort', stop);
    }
  }
}

/** `claude auth status` output (JSON): whether it is signed in, and how (claude.ai, console…). Null when it is not that JSON. */
export function parseClaudeAuthStatus(stdout: string): { loggedIn: boolean; method?: string } | null {
  try {
    const j = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown; subscriptionType?: unknown };
    if (typeof j.loggedIn !== 'boolean') return null;
    const method = [j.authMethod, j.subscriptionType].filter((x) => typeof x === 'string' && x).join(', ');
    return { loggedIn: j.loggedIn, ...(method ? { method } : {}) };
  } catch {
    return null;
  }
}
