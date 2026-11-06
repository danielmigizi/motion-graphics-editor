// OpenCode provider: one `opencode run --format json` process per chat turn,
// continued with `--session <id>`, under whatever the user signed OpenCode in
// with (`opencode auth login`, or its free models). The editor never reads or
// passes on OpenCode's credentials.
//
// Checked against OpenCode 1.18.29 (its CLI help, its bundled config schema
// and source, `opencode debug config` / `opencode debug agent`, and two error
// turns that never reached a model):
//
// Each turn runs in a small private folder outside the repo (OS temp folder,
// one per server port), with its config passed in OPENCODE_CONFIG_CONTENT,
// which OpenCode merges after the user's global, OPENCODE_CONFIG and project
// configs. That config
//   - defines the agent `motion-editor-chat` (also the default agent, so an
//     unknown --agent cannot fall back to the unrestricted `build` agent)
//     whose permissions are `"*": "deny"` then `"motion-editor_*": "allow"`.
//     OpenCode evaluates permissions last-match-wins and appends an agent's
//     own rules after the global ones, so every built-in tool (bash, edit,
//     write, read, glob, grep, webfetch, websearch, task, skill…) and every
//     other MCP or plugin tool is denied and hidden from the model;
//   - also sets the global permission to `"*": "deny"`;
//   - registers the motion-editor MCP server and disables every other MCP
//     server the user configured (`enabled: false`, by name, from
//     `opencode debug config`).
// The environment drops OPENCODE_CONFIG / OPENCODE_CONFIG_DIR /
// OPENCODE_PERMISSION, skips project configs and Claude Code files
// (CLAUDE.md, ~/.claude/skills), and `--pure` skips external plugins. `run`
// rejects any permission that would need asking (we never pass --auto).
//
// Because user, managed or organisation configs could still change the
// result, the provider checks it before running: `opencode debug agent
// motion-editor-chat` must resolve to rules that deny every built-in tool and
// any other server's tools, and `opencode debug config` must show every other
// MCP server disabled. Otherwise OpenCode is reported `unsupported` and never
// runs.
//
// Image attachments go as `-f <file>`: OpenCode reads files the user attached
// itself (the read permission applies to the model's own tool calls).
//
// Event stream (`--format json`, verified from the CLI source and real error
// output): one JSON object per line, `{ type, timestamp, sessionID, … }` with
// type `text` (a whole text part), `tool_use` (a finished tool call: part.tool,
// part.state.input/status), `step_start`/`step_finish`, `reasoning` and
// `error` (`error.name`, `error.data.message`). There is no final event: the
// CLI exits 0 when the turn is done, 1 after an error.

import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ModelOption } from '../../src/core/api-contract';
import type { AgentEvent, AgentProvider, AgentTurn, ProviderStatus } from './types';
import { agentInstructions, cached, childEnv, editorMcpServer, explainFailures, probe, protectedPathPatterns, agentDeniedPaths, providerInfo, runJsonLines, type ProviderOptions } from './shared';

export interface OpenCodeProviderOptions extends ProviderOptions {
  /** Where turns run; default <tmp>/mge-opencode-<serverPort>. */
  workspaceDir?: string;
}

export const OPENCODE_AGENT = 'motion-editor-chat';
const EDITOR_SERVER = 'motion-editor';

/** Permissions that must resolve to "deny" for every pattern, plus stand-ins for other servers' and plugins' tools. */
const MUST_DENY = ['bash', 'edit', 'write', 'patch', 'apply_patch', 'read', 'glob', 'grep', 'list', 'task', 'webfetch', 'websearch', 'codesearch', 'skill', 'todowrite', 'todoread', 'lsp', 'multiedit', 'other-server_some_tool', 'plugin_tool'];

/** Environment variables that would load other config or permissions into the run. */
const STRIP = ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_PERMISSION'];

export interface OpenCodeRule {
  permission: string;
  pattern: string;
  action: 'allow' | 'deny' | 'ask' | string;
}

/** The per-run config: the restricted agent, deny-all permissions, only the editor's MCP server enabled. */
export function openCodeConfig(opts: ProviderOptions, otherServers: string[] = []) {
  const server = editorMcpServer(opts, 'OpenCode');
  const off = Object.fromEntries(otherServers.filter((n) => n !== EDITOR_SERVER).map((n) => [n, { enabled: false }]));
  // Explicit private-path rules, followed by deny-all to retain the resolved-agent gate.
  const privateFiles: Record<string, 'deny'> = { ...Object.fromEntries(protectedPathPatterns(agentDeniedPaths(opts.rootDir)).map(path => [path, 'deny' as const])), '*': 'deny' };
  return {
    $schema: 'https://opencode.ai/config.json',
    default_agent: OPENCODE_AGENT,
    share: 'disabled',
    autoupdate: false,
    permission: { '*': 'deny', read: privateFiles, edit: privateFiles },
    mcp: {
      ...off,
      // Absolute node + tsx, started in the repo (the turn itself runs in the private folder).
      [EDITOR_SERVER]: { type: 'local', command: [process.execPath, join(opts.rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), join(opts.rootDir, 'mcp', 'server.ts')], cwd: opts.rootDir, environment: server.env, enabled: true },
    },
    agent: {
      [OPENCODE_AGENT]: {
        mode: 'primary',
        description: 'The motion graphics editor chat: changes the video only through the motion-editor tools.',
        prompt: agentInstructions(opts.rootDir),
        permission: { '*': 'deny', [`${EDITOR_SERVER}_*`]: 'allow', read: privateFiles, edit: privateFiles },
      },
    },
  };
}

/** The child environment for a run with `config`. */
export function openCodeEnv(config: object): NodeJS.ProcessEnv {
  return {
    ...childEnv(STRIP),
    OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
    OPENCODE_DISABLE_PROJECT_CONFIG: '1',
    OPENCODE_DISABLE_CLAUDE_CODE: '1',
    OPENCODE_DISABLE_EXTERNAL_SKILLS: '1',
    OPENCODE_DISABLE_AUTOUPDATE: '1',
    OPENCODE_DISABLE_SHARE: '1',
    OPENCODE_PURE: '1',
  };
}

/** OpenCode's wildcard: `*` any run of characters, `?` one, everything else literal. */
function wildcard(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's');
}

/** The rule OpenCode applies to a permission (its last match), if any. */
function lastRule(rules: OpenCodeRule[], permission: string): OpenCodeRule | undefined {
  return rules.findLast((r) => wildcard(r.permission).test(permission));
}

/**
 * Why a resolved agent (`opencode debug agent <name>` output) is not limited
 * to the editor's tools: every listed permission must end in a deny for all
 * patterns, and the editor's tools must be allowed. Empty when it is.
 */
export function openCodeAgentProblems(agent: unknown): string[] {
  const rules = (agent as { permission?: unknown } | null)?.permission;
  if (!Array.isArray(rules)) return ['OpenCode did not report the chat agent’s permissions.'];
  const problems: string[] = [];
  for (const p of MUST_DENY) {
    const r = lastRule(rules as OpenCodeRule[], p);
    if (r?.action !== 'deny' || r.pattern !== '*') problems.push(`its "${p}" permission resolves to "${r ? `${r.action} ${r.pattern}` : 'ask'}", not "deny".`);
  }
  if (lastRule(rules as OpenCodeRule[], `${EDITOR_SERVER}_editor_get_context`)?.action !== 'allow') problems.push('the editor tools are not allowed.');
  return problems;
}

/** Why a resolved config (`opencode debug config` output) still loads other MCP servers, or would pick another agent. */
export function openCodeConfigProblems(config: unknown): string[] {
  const c = config as { mcp?: Record<string, { enabled?: boolean }>; default_agent?: unknown } | null;
  if (!c || typeof c !== 'object') return ['OpenCode did not report its configuration.'];
  const problems: string[] = [];
  const on = Object.entries(c.mcp ?? {}).filter(([n, s]) => n !== EDITOR_SERVER && s?.enabled !== false);
  if (on.length) problems.push(`other MCP servers would still load (${on.map(([n]) => n).join(', ')}).`);
  if (c.default_agent !== OPENCODE_AGENT) problems.push('its default agent is not the editor chat agent.');
  return problems;
}

/** `opencode models` lines ("provider/model"); the configured default first. */
export function parseOpenCodeModels(out: string, configured: string | null): ModelOption[] {
  const models: ModelOption[] = [{ id: '', label: configured ? `Default (${configured})` : 'Default' }];
  for (const line of out.replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    const m = /^([\w.@-]+)\/(\S+)$/.exec(line.trim());
    if (m) models.push({ id: line.trim(), label: `${m[2]} (${m[1]})` });
  }
  return models;
}

const parseJson = (s: string): unknown => {
  try {
    return JSON.parse(s);
  } catch {
    // Startup lines before the JSON: take the outermost object.
    const i = s.indexOf('{');
    const j = s.lastIndexOf('}');
    try {
      return i >= 0 && j > i ? JSON.parse(s.slice(i, j + 1)) : null;
    } catch {
      return null;
    }
  }
};

/** An OpenCode tool name as the chat labels it: the editor's MCP tools in Claude's `mcp__motion-editor__<tool>` form. */
function toolName(tool: unknown): string {
  const t = String(tool ?? 'tool');
  return t.startsWith(`${EDITOR_SERVER}_`) ? `mcp__${EDITOR_SERVER}__${t.slice(EDITOR_SERVER.length + 1)}` : t;
}

/** Maps `opencode run --format json` lines to agent events; `end` gives the turn's end when the CLI exits. */
export function openCodeParser() {
  let session: string | null = null;
  let afterText = false;
  let lastError: string | null = null;
  return {
    parse(e: any): { events: AgentEvent[] } {
      const events: AgentEvent[] = [];
      if (typeof e?.sessionID === 'string' && e.sessionID !== session) {
        session = e.sessionID;
        events.push({ type: 'session', sessionId: e.sessionID });
      }
      const part = e?.part;
      if (e?.type === 'text' && part?.text) {
        // Text parts arrive whole; separate consecutive ones like paragraphs.
        events.push({ type: 'text', text: afterText ? `\n\n${part.text}` : part.text });
        afterText = true;
      } else if (e?.type === 'tool_use' && part) {
        events.push({ type: 'tool', name: toolName(part.tool), input: part.state?.input ?? {} });
        afterText = false;
      } else if (e?.type === 'error') {
        const err = e.error ?? {};
        const msg = String(err.data?.message ?? err.message ?? err.name ?? 'OpenCode reported an error');
        lastError = lastError ? `${lastError} ${msg}` : msg;
      }
      return { events };
    },
    end(code: number | null): AgentEvent | null {
      if (lastError) return { type: 'done', isError: true, error: lastError };
      if (code === 0) return { type: 'done', isError: false };
      return null;
    },
  };
}

export function createOpenCodeProvider(opts: OpenCodeProviderOptions): AgentProvider {
  const bin = opts.bin ?? process.env.MGE_OPENCODE_BIN ?? 'opencode';
  const workspace = opts.workspaceDir ?? join(tmpdir(), `mge-opencode-${opts.serverPort}`);

  /**
   * The run's config and whether OpenCode resolves it to an agent limited to
   * the editor's tools. Rechecked every minute (new servers are disabled soon).
   */
  const prepare = cached(60_000, async () => {
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const resolve = (args: string[], config: object) => probe(bin, [...args, '--pure'], openCodeEnv(config), 30000, workspace);
    // The user's MCP servers, as OpenCode resolves them for a run here.
    const first = await resolve(['debug', 'config'], openCodeConfig(opts));
    const resolved = parseJson(first.stdout) as { mcp?: Record<string, unknown>; model?: unknown } | null;
    const others = Object.keys(resolved?.mcp ?? {}).filter((n) => n !== EDITOR_SERVER);
    const config = openCodeConfig(opts, others);
    const [agent, check] = await Promise.all([resolve(['debug', 'agent', OPENCODE_AGENT], config), resolve(['debug', 'config'], config)]);
    const problems = first.ok && agent.ok && check.ok ? [...openCodeAgentProblems(parseJson(agent.stdout)), ...openCodeConfigProblems(parseJson(check.stdout))] : ['OpenCode could not show its resolved configuration (`opencode debug config` / `debug agent` failed).'];
    return { config, problems, model: typeof resolved?.model === 'string' ? resolved.model : null };
  });
  const models = async (p: Awaited<ReturnType<typeof prepare>>) => {
    const r = await probe(bin, ['models', '--pure'], openCodeEnv(p.config), 30000, workspace);
    return parseOpenCodeModels(r.ok ? r.stdout : '', p.model);
  };

  const args = (turn: AgentTurn): string[] => [
    'run',
    '--format',
    'json',
    '--pure',
    '--agent',
    OPENCODE_AGENT,
    ...(turn.model ? ['-m', turn.model] : []),
    ...(turn.sessionId ? ['--session', turn.sessionId] : []),
    ...turn.images.flatMap((p) => ['-f', p]),
    '--',
    turn.prompt,
  ];

  const unsupported = (problems: string[]) => `OpenCode could not be limited to the editor’s tools, so the chat won’t run it: ${problems.join(' ')}`;

  async function* runTurn(turn: AgentTurn): AsyncIterable<AgentEvent> {
    const p = await prepare();
    if (p.problems.length) {
      yield { type: 'done', isError: true, error: unsupported(p.problems) };
      return;
    }
    const parser = openCodeParser();
    yield* runJsonLines('OpenCode', bin, args(turn), { cwd: workspace, env: openCodeEnv(p.config), signal: turn.signal, loginHint: 'Run `opencode auth login` in a terminal to sign in.', onExit: (code) => parser.end(code) }, (e) => parser.parse(e));
  }

  return {
    id: 'opencode',
    label: 'OpenCode',
    // The model is chosen per prompt (`-m` with `--session`).
    resumesAcrossModels: true,

    async status(): Promise<ProviderStatus> {
      const info = (state: Parameters<typeof providerInfo>[2], detail: string, list: ModelOption[] = [{ id: '', label: 'Default' }]) => providerInfo('opencode', 'OpenCode', state, detail, list);
      const v = await probe(bin, ['--version'], childEnv(STRIP));
      if (!v.ok) return v.missing ? info('not-installed', 'OpenCode is not installed (the `opencode` command was not found). Install it, run `opencode auth login`, then check again.') : info('error', `OpenCode did not start: ${v.out.slice(0, 200)}`);
      const version = `OpenCode ${v.out.split('\n')[0].trim()}`;
      // A status check (itself cached by the registry) always re-resolves: the user may just have changed something.
      prepare.invalidate();
      const p = await prepare();
      if (p.problems.length) return info('unsupported', unsupported(p.problems));
      const list = await models(p);
      // No model at all: no provider is signed in (OpenCode's free models need none).
      if (list.length < 2) return info('signed-out', `${version} is installed but has no models to use. Run \`opencode auth login\` in a terminal, then check again.`);
      return info('ready', `${version} · ${list.length - 1} models`, list);
    },

    run(turn: AgentTurn): AsyncIterable<AgentEvent> {
      return explainFailures('opencode', runTurn(turn));
    },
  };
}
