// Every provider and the registry, against stand-in executables that replay
// event lines captured from the real CLIs (__fixtures__/: codex-cli 0.160.1,
// cursor-agent 2026.09.18, opencode 1.18.29 — opencode-bad-model.jsonl is real
// output; opencode-turn.jsonl is built from OpenCode's source format because
// no OpenCode provider was signed in). Also failure classification and ?refresh=1.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, symlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentProviderId, ProviderInfo } from '../../src/core/api-contract';
import { createApp } from '../app';
import { ChatManager } from '../chat';
import { createProjectStore } from '../projects';
import { RenderManager } from '../renders';
import { createClaudeProvider, parseClaudeAuthStatus } from './claude';
import { createCodexProvider, mcpServersOverride } from './codex';
import { createCursorProvider, parseCursorModels, writeCursorWorkspace } from './cursor';
import { createOpenCodeProvider, OPENCODE_AGENT, openCodeAgentProblems, openCodeConfig, openCodeConfigProblems, openCodeParser, parseOpenCodeModels } from './opencode';
import { ProviderRegistry } from './registry';
import { agentInstructions, classifyAgentFailure, explainFailures, protectedPaths, runJsonLines, SIGN_IN } from './shared';
import type { AgentEvent, AgentProvider, AgentTurn } from './types';

const fixtures = join(__dirname, '__fixtures__');
let dir: string;
beforeAll(async () => {
  // realpath: macOS's temp dir is a symlink (/var → /private/var) and the providers report resolved paths.
  dir = await realpath(await mkdtemp(join(tmpdir(), 'mge-agents-')));
  opts.rootDir = dir;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Call {
  argv: string[];
  cwd: string;
  env: Record<string, string | null>;
}

/** A stand-in CLI: logs each call, answers `responses[argv.join(' ')]`, else replays fixture files. */
async function fake(name: string, opts: { stdout?: string; stderr?: string; code?: number; responses?: Record<string, { out: string; code?: number }> }) {
  const bin = join(dir, name);
  const log = `${bin}.calls.jsonl`;
  await writeFile(
    bin,
    `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
const env = {};
for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'FAL_KEY', 'FAL_KEY_ID', 'FAL_KEY_SECRET', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_PERMISSION', 'OPENCODE_DISABLE_PROJECT_CONFIG', 'OPENCODE_PURE', 'GROK_CLAUDE_MCPS_ENABLED']) env[k] = process.env[k] ?? null;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd(), env }) + '\\n');
const r = ${JSON.stringify(opts.responses ?? {})}[argv.join(' ')];
if (r) { process.stdout.write(r.out); process.exit(r.code ?? 0); }
${opts.stdout ? `process.stdout.write(fs.readFileSync(${JSON.stringify(join(fixtures, opts.stdout))}));` : ''}
${opts.stderr ? `process.stderr.write(fs.readFileSync(${JSON.stringify(join(fixtures, opts.stderr))}));` : ''}
process.exitCode = ${opts.code ?? 0};
`,
  );
  await chmod(bin, 0o755);
  return { bin, calls: async (): Promise<Call[]> => {
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Call);
    for (const call of calls) for (const key of ['FAL_KEY', 'FAL_KEY_ID', 'FAL_KEY_SECRET']) expect(call.env[key]).toBeNull();
    return calls;
  } };
}

const turn = (t: Partial<AgentTurn> = {}): AgentTurn => ({ prompt: 'hello', sessionId: null, model: '', images: [], workspace: tmpdir(), signal: new AbortController().signal, ...t });

async function collect(p: AgentProvider, t: AgentTurn) {
  const events: AgentEvent[] = [];
  for await (const e of p.run(t)) events.push(e);
  return events;
}

/** Runs with API keys set, to prove they are not passed on. */
async function withKeys<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CURSOR_API_KEY', 'ANTHROPIC_API_KEY', 'XAI_API_KEY', 'FAL_KEY', 'FAL_KEY_ID', 'FAL_KEY_SECRET'];
  const prev = keys.map((k) => process.env[k]);
  for (const k of keys) process.env[k] = 'sk-should-not-leak';
  try {
    return await fn();
  } finally {
    keys.forEach((k, i) => (prev[i] === undefined ? delete process.env[k] : (process.env[k] = prev[i])));
  }
}

/** rootDir is the temp dir: Codex runs there. */
const opts = { rootDir: '', serverPort: 7001, webPort: 7000 };
const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
const configs = (argv: string[]) => argv.flatMap((a, i) => (argv[i - 1] === '-c' ? [a] : []));
/** The turn itself, not the MCP server listing the provider runs first. */
const turnCall = (calls: Call[]) => calls.find((c) => c.argv[0] !== 'mcp')!;

it('every provider removes fal credentials inherited from the server', async () => {
  await withKeys(async () => {
    for (const [id, create] of [
      ['claude', createClaudeProvider], ['codex', createCodexProvider], ['cursor', createCursorProvider],
      ['opencode', createOpenCodeProvider],
    ] as const) {
      const cli = await fake(`fal-env-${id}`, { responses: { '--version': { out: '1.0' } } });
      await create({ ...opts, bin: cli.bin }).status();
      const calls = await cli.calls();
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) for (const key of ['FAL_KEY', 'FAL_KEY_ID', 'FAL_KEY_SECRET']) expect(call.env[key]).toBeNull();
    }
  });
});

// Native run/resume, policy, event and failure cases live in codex-app-server.test.ts.
describe('Codex provider', () => {
  it('names only the editor in the server override (the user’s servers stay as configured)', () => {
    expect(mcpServersOverride({ command: 'npx' })).toBe('mcp_servers={"motion-editor"={"command"="npx","enabled"=true}}');
  });

  it('is available only when installed and signed in; Default shows the configured model', async () => {
    const codexHome = join(dir, 'codex-home');
    await rm(codexHome, { recursive: true, force: true });
    await mkdir(codexHome, { recursive: true });
    await writeFile(join(codexHome, 'config.toml'), 'model = "gpt-test"\n');
    const prev = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const ok = await fake('codex-ok', { responses: { '--version': { out: 'codex-cli 0.160.1\n' }, 'login status': { out: 'Logged in using ChatGPT\n' } } });
      const st = await createCodexProvider({ ...opts, bin: ok.bin }).status();
      expect(st).toMatchObject({ id: 'codex', available: true, detail: 'codex-cli 0.160.1 · Logged in using ChatGPT' });
      expect(st.models[0]).toEqual({ id: '', label: 'Default (gpt-test)' });
      expect(st.models.map((m) => m.id)).toEqual(['', 'gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-astra']);

      const out = await fake('codex-out', { responses: { '--version': { out: 'codex-cli 0.160.1\n' }, 'login status': { out: 'Not logged in\n', code: 1 } } });
      expect(await createCodexProvider({ ...opts, bin: out.bin }).status()).toMatchObject({ available: false, detail: expect.stringContaining('codex login') });
      expect(await createCodexProvider({ ...opts, bin: join(dir, 'nope') }).status()).toMatchObject({ available: false, detail: expect.stringContaining('not installed') });
    } finally {
      if (prev === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prev;
    }
  });
});

/** A project workspace folder, as the chat manager creates it. */
async function cursorWorkspace(name: string) {
  const ws = join(dir, 'workspaces', name);
  await mkdir(ws, { recursive: true });
  return ws;
}

// Native ACP run/resume and approval cases live in cursor-acp.test.ts.
describe('Cursor provider', () => {
  it('preserves the user’s Cursor rules and adds protected path and keychain denies to the workspace file', async () => {
    const workspace = await cursorWorkspace('cursor-ws-full');
    // The user's own global rules (Cursor replaces a workspace-defined permission array, so they must travel along).
    const dataDir = join(dir, 'cursor-data');
    await mkdir(dataDir, { recursive: true });
    await writeFile(join(dataDir, 'cli-config.json'), JSON.stringify({ permissions: { allow: ['Read(**)'], deny: ['Mcp(some-connector:*)'] }, version: 1 }));
    const prevData = process.env.CURSOR_DATA_DIR;
    process.env.CURSOR_DATA_DIR = dataDir;
    vi.stubEnv('XDG_CONFIG_HOME', join(dir, 'server-xdg'));
    vi.stubEnv('MGE_CONFIG_DIR', join(dir, 'server-config'));
    vi.stubEnv('MGE_EDITOR_LINK_FILE', join(dir, 'server-link'));
    const expectedProtectedPaths = protectedPaths(opts.rootDir);
    try {
      writeCursorWorkspace(workspace, opts);
    } finally {
      if (prevData === undefined) delete process.env.CURSOR_DATA_DIR;
      else process.env.CURSOR_DATA_DIR = prevData;
      vi.unstubAllEnvs();
    }

    // The .cursor/ files are written into the workspace: the editor's server on this editor's ports, allowed; the user's
    // own global rules carried along, plus the editor's private-path denies.
    const cli = JSON.parse(await readFile(join(workspace, '.cursor', 'cli.json'), 'utf8'));
    expect(cli.permissions.allow).toEqual(['Read(**)', 'Mcp(motion-editor:*)']);
    expect(cli.permissions.deny[0]).toBe('Mcp(some-connector:*)');
    for (const path of expectedProtectedPaths) {
      expect(cli.permissions.deny).toEqual(expect.arrayContaining([`Read(${path})`, `Write(${path})`, `Read(${path}/**)`, `Write(${path}/**)`]));
    }
    expect(cli.permissions.deny).toContain('Shell(secret-tool)');
    const mcp = JSON.parse(await readFile(join(workspace, '.cursor', 'mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['motion-editor']);
    expect(mcp.mcpServers['motion-editor']).toEqual({ command: process.execPath, // The repo's own tsconfig and no shared tsx cache: the workspace (another agent can write it) has no say.
      args: [join(dir, 'node_modules/tsx/dist/cli.mjs'), '--tsconfig', join(dir, 'tsconfig.json'), '--no-cache', join(dir, 'mcp/server.ts')], env: { MGE_OPEN_BROWSER: '0', MGE_SERVER_PORT: '7001', MGE_WEB_PORT: '7000', MGE_AGENT_LABEL: 'Cursor Agent', TMPDIR: tmpdir(), XDG_CONFIG_HOME: join(dir, 'server-xdg'), MGE_CONFIG_DIR: join(dir, 'server-config'), MGE_EDITOR_LINK_FILE: join(dir, 'server-link') } });
  });

  it('removes planted workspace hooks, rules and configuration symlinks', async () => {
    const workspace = await cursorWorkspace('cursor-planted');
    await mkdir(join(workspace, '.cursor/rules'), { recursive: true });
    await writeFile(join(workspace, '.cursor/rules/planted.mdc'), 'malicious instructions');
    await writeFile(join(workspace, '.cursor/hooks.json'), '{"hooks":{}}');
    const target = join(dir, 'cursor-symlink-target.json'); await writeFile(target, 'untouched');
    await symlink(target, join(workspace, '.cursor/cli.json'));
    writeCursorWorkspace(workspace, opts);
    expect((await readdir(join(workspace, '.cursor'))).sort()).toEqual(['cli.json', 'mcp.json']);
    expect(await readFile(target, 'utf8')).toBe('untouched');
    expect(JSON.parse(await readFile(join(workspace, '.cursor/cli.json'), 'utf8')).permissions.deny).toContain('Shell(secret-tool)');
  });

  it('lists models from --list-models, Auto first as the default', async () => {
    const models = parseCursorModels(await readFile(join(fixtures, 'cursor-list-models.txt'), 'utf8'));
    expect(models[0]).toEqual({ id: '', label: 'Auto' });
    expect(models.some((m) => m.id === 'auto')).toBe(false);
    expect(models).toContainEqual({ id: 'composer-2.5-fast', label: 'Composer 2.5 Fast' });
    // Zero-width characters and double spaces in labels are cleaned up.
    expect(models).toContainEqual({ id: 'grok-4.7-low-fast', label: 'Grok 4.7 Low Fast' });
    expect(models.length).toBeGreaterThan(50);
  });

  it('is available when signed in, with the model list', async () => {
    const listing = await readFile(join(fixtures, 'cursor-list-models.txt'), 'utf8');
    const f = await fake('cursor-ok', { responses: { '--version': { out: '2026.09.18-9a7762b\n' }, status: { out: '✓ Logged in as someone@example.com\n' }, '--list-models': { out: listing } } });
    const st = await createCursorProvider({ ...opts, bin: f.bin }).status();
    expect(st).toMatchObject({ id: 'cursor', available: true, detail: 'Cursor Agent 2026.09.18-9a7762b · Logged in as someone@example.com' });
    expect(st.models[0]).toEqual({ id: '', label: 'Auto' });
    const out = await fake('cursor-out', { responses: { '--version': { out: '2026.09.18\n' }, status: { out: 'Not logged in\n', code: 1 } } });
    expect(await createCursorProvider({ ...opts, bin: out.bin }).status()).toMatchObject({ available: false, detail: expect.stringContaining('cursor-agent login') });
  });

});

describe('agent instructions', () => {
  it('tell only full-toolset agents (Claude Code) about the workspace and the full toolset', () => {
    const full = agentInstructions(process.cwd(), { fullToolset: true });
    expect(full).toContain('full toolset');
    expect(full).toContain('editor_import_asset');
    expect(full).not.toContain('You cannot run commands');
    const limited = agentInstructions(process.cwd());
    expect(limited).toContain('You cannot run commands or edit files here.');
    expect(limited).not.toContain('full toolset');
  });
});

describe('runJsonLines', () => {
  it('does not start a CLI for a turn that was already stopped', async () => {
    const f = await fake('never-started', { stdout: 'codex-turn.jsonl' });
    const abort = new AbortController();
    abort.abort();
    const events: AgentEvent[] = [];
    for await (const e of runJsonLines('Test', f.bin, [], { cwd: dir, env: process.env, signal: abort.signal, loginHint: '' }, () => ({ events: [] }))) events.push(e);
    expect(events).toEqual([{ type: 'done', isError: true, error: 'Stopped.' }]);
    await expect(f.calls()).rejects.toThrow(/ENOENT/);
  });
});

describe('ProviderRegistry', () => {
  const stub = (id: AgentProvider['id'], available: boolean, counter: { n: number }): AgentProvider => ({
    id,
    label: id,
    resumesAcrossModels: true,
    status: async (): Promise<ProviderInfo> => {
      counter.n++;
      return { id, label: id, available, detail: '', models: [{ id: '', label: 'Default' }] };
    },
    run: async function* () {
      yield { type: 'done', isError: false };
    },
  });

  it('lists every provider in order, caches status, and defaults to the first available', async () => {
    const n = { n: 0 };
    const r = new ProviderRegistry([stub('claude', false, n), stub('codex', true, n), stub('cursor', true, n), stub('opencode', false, n)]);
    expect((await r.list()).map((p) => [p.id, p.available])).toEqual([
      ['claude', false],
      ['codex', true],
      ['cursor', true],
      ['opencode', false],
    ]);
    expect(await r.defaultProvider()).toBe('codex');
    await r.list();
    expect(n.n).toBe(4);
    expect(r.get('cursor')?.id).toBe('cursor');
    expect(r.get('gemini')).toBeUndefined();
  });

  it('prefers Claude Code when it is available', async () => {
    const n = { n: 0 };
    expect(await new ProviderRegistry([stub('claude', true, n), stub('codex', true, n)]).defaultProvider()).toBe('claude');
  });
});

describe('provider state', () => {
  it('Claude Code: ready with how it is signed in, signed-out from `claude auth status`, not-installed', async () => {
    const auth = (loggedIn: boolean) => JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', subscriptionType: loggedIn ? 'max' : null, email: 'someone@example.com' });
    const ok = await fake('claude-ok', { responses: { '--version': { out: '2.1.296 (Claude Code)\n' }, 'auth status': { out: auth(true) } } });
    expect(await createClaudeProvider({ ...opts, bin: ok.bin }).status()).toMatchObject({ state: 'ready', available: true, detail: '2.1.296 (Claude Code) · signed in (claude.ai, max)', signIn: { command: 'claude auth login' } });
    const out = await fake('claude-out', { responses: { '--version': { out: '2.1.296 (Claude Code)\n' }, 'auth status': { out: auth(false), code: 1 } } });
    expect(await createClaudeProvider({ ...opts, bin: out.bin }).status()).toMatchObject({ state: 'signed-out', available: false, detail: expect.stringContaining('claude auth login') });
    // A Claude Code without `auth status` (prints help, not JSON) is taken as signed in, as before.
    const old = await fake('claude-old', { responses: { '--version': { out: '1.0.0 (Claude Code)\n' } } });
    expect(await createClaudeProvider({ ...opts, bin: old.bin }).status()).toMatchObject({ state: 'ready', detail: '1.0.0 (Claude Code)' });
    expect(await createClaudeProvider({ ...opts, bin: join(dir, 'no-claude') }).status()).toMatchObject({ state: 'not-installed', available: false });
    expect(parseClaudeAuthStatus('Usage: claude auth')).toBeNull();
    // The email in the status output is never shown.
    expect(JSON.stringify(await createClaudeProvider({ ...opts, bin: ok.bin }).status())).not.toContain('example.com');
  });

  it('Codex and Cursor: ready / signed-out / not-installed', async () => {
    const ok = await fake('codex-state-ok', { responses: { '--version': { out: 'codex-cli 0.160.1\n' }, 'login status': { out: 'Logged in using ChatGPT\n' } } });
    expect(await createCodexProvider({ ...opts, bin: ok.bin }).status()).toMatchObject({ state: 'ready', signIn: { command: 'codex login' } });
    const out = await fake('codex-state-out', { responses: { '--version': { out: 'codex-cli 0.160.1\n' }, 'login status': { out: 'Not logged in\n', code: 1 } } });
    expect(await createCodexProvider({ ...opts, bin: out.bin }).status()).toMatchObject({ state: 'signed-out' });
    expect(await createCodexProvider({ ...opts, bin: join(dir, 'no-codex') }).status()).toMatchObject({ state: 'not-installed' });

    const cur = await fake('cursor-state-out', { responses: { '--version': { out: '2026.09.18\n' }, status: { out: 'Not logged in\n', code: 1 } } });
    expect(await createCursorProvider({ ...opts, bin: cur.bin }).status()).toMatchObject({ state: 'signed-out', signIn: { command: 'cursor-agent login' } });
    expect(await createCursorProvider({ ...opts, bin: join(dir, 'no-cursor') }).status()).toMatchObject({ state: 'not-installed' });
  });

  it('every provider names its sign-in command and docs', () => {
    expect(Object.fromEntries(Object.entries(SIGN_IN).map(([id, s]) => [id, s.command]))).toEqual({ claude: 'claude auth login', codex: 'codex login', cursor: 'cursor-agent login', opencode: 'opencode auth login' });
    for (const s of Object.values(SIGN_IN)) expect(s.docsUrl).toMatch(/^https:\/\//);
  });
});

/**
 * A stand-in `opencode` that resolves OPENCODE_CONFIG_CONTENT the way OpenCode
 * 1.18 does for what the provider checks: MCP servers merge by name over the
 * user's, and an agent's rules are OpenCode's defaults, then the global
 * permission, then the agent's own (user keys first, ours overriding values in
 * place, as its deep merge does). `run` logs and replays a fixture.
 */
async function fakeOpenCode(name: string, o: { userMcp?: Record<string, object>; userAgentPermission?: Record<string, string>; models?: string; stdout?: string; code?: number; failDebug?: boolean } = {}) {
  const bin = join(dir, name);
  const log = `${bin}.calls.jsonl`;
  await writeFile(
    bin,
    `#!/usr/bin/env node
const fs = require('fs');
const argv = process.argv.slice(2);
const env = {};
for (const k of Object.keys(process.env)) if (k.startsWith('OPENCODE_') && k !== 'OPENCODE_CONFIG_CONTENT') env[k] = process.env[k];
for (const k of ['FAL_KEY', 'FAL_KEY_ID', 'FAL_KEY_SECRET']) env[k] = process.env[k] ?? null;
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv, cwd: process.cwd(), env }) + '\\n');
const c = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
const o = ${JSON.stringify(o)};
const cmd = argv.filter((a) => a !== '--pure').join(' ');
if (cmd === '--version') { console.log('1.18.29'); process.exit(0); }
if (o.failDebug && cmd.startsWith('debug')) { console.error('boom'); process.exit(1); }
if (cmd === 'debug config') {
  const mcp = { ...(o.userMcp || {}) };
  for (const [n, s] of Object.entries(c.mcp || {})) mcp[n] = { ...(mcp[n] || {}), ...s };
  console.log(JSON.stringify({ $schema: 'x', model: 'opencode/free-model', mcp, default_agent: c.default_agent, permission: c.permission, username: 'u' }, null, 2));
  process.exit(0);
}
if (cmd.startsWith('debug agent ')) {
  const name = argv[2];
  const rules = (obj) => Object.entries(obj || {}).flatMap(([p, a]) => typeof a === 'string' ? [{ permission: p, action: a, pattern: '*' }] : Object.entries(a).map(([pat, act]) => ({ permission: p, pattern: pat, action: act })));
  const own = { ...(o.userAgentPermission || {}) };
  for (const [k, v] of Object.entries(((c.agent || {})[name] || {}).permission || {})) own[k] = v;
  const permission = [{ permission: '*', action: 'allow', pattern: '*' }, { permission: 'read', action: 'allow', pattern: '*' }, ...rules(c.permission), ...rules(own), { permission: 'external_directory', pattern: '/tmp/opencode/*', action: 'allow' }];
  console.log(JSON.stringify({ name, mode: 'primary', permission, options: {} }));
  process.exit(0);
}
if (cmd === 'models') { process.stdout.write(o.models ?? 'opencode/big-pickle\\nanthropic/claude-sonnet-5-5\\n'); process.exit(0); }
if (argv[0] === 'run') {
  ${o.stdout ? `process.stdout.write(fs.readFileSync(${JSON.stringify(join(fixtures, o.stdout))}));` : ''}
  process.exitCode = ${o.code ?? 0};
}
`,
  );
  await chmod(bin, 0o755);
  return { bin, calls: async (): Promise<Call[]> => {
    const calls = (await readFile(log, 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Call);
    for (const call of calls) for (const key of ['FAL_KEY', 'FAL_KEY_ID', 'FAL_KEY_SECRET']) expect(call.env[key]).toBeNull();
    return calls;
  } };
}

describe('OpenCode provider', () => {
  const ws = (n: string) => join(dir, `opencode-ws-${n}`);

  it('runs only the restricted agent with the editor server, disables the user’s servers, and maps the event stream', async () => {
    const f = await fakeOpenCode('opencode-turn', { userMcp: { linear: { type: 'remote', url: 'https://mcp.linear.app' } }, stdout: 'opencode-turn.jsonl' });
    const p = createOpenCodeProvider({ ...opts, bin: f.bin, workspaceDir: ws('turn') });
    const events = await withKeys(() => collect(p, turn({ images: [join(dir, 'public/assets/uploads/u_1.png')], model: 'opencode/big-pickle' })));
    expect(events).toEqual([
      { type: 'session', sessionId: 'ses_ec9d0fdd0ffeVjTjMqRu86Kb73' },
      { type: 'text', text: "I'll check what you're looking at." },
      { type: 'tool', name: 'mcp__motion-editor__editor_get_context', input: {} },
      { type: 'tool', name: 'bash', input: { command: 'ls' } },
      { type: 'text', text: 'No editor is connected yet.' },
      { type: 'done', isError: false },
    ]);
    const calls = await f.calls();
    const run = calls.find((c) => c.argv[0] === 'run')!;
    expect(run.cwd).toBe(ws('turn'));
    expect(run.argv.slice(0, 6)).toEqual(['run', '--format', 'json', '--pure', '--agent', OPENCODE_AGENT]);
    expect(flag(run.argv, '-m')).toBe('opencode/big-pickle');
    expect(flag(run.argv, '-f')).toBe(join(dir, 'public/assets/uploads/u_1.png'));
    expect(run.argv).not.toContain('--auto');
    expect(run.argv).not.toContain('--session');
    expect(run.argv.slice(-2)).toEqual(['--', 'hello']);
    // Other config sources are cut off; plugins and project config skipped.
    expect(run.env).toMatchObject({ OPENCODE_DISABLE_PROJECT_CONFIG: '1', OPENCODE_PURE: '1', OPENCODE_DISABLE_CLAUDE_CODE: '1' });
    for (const k of ['OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_PERMISSION']) expect(run.env[k]).toBeUndefined();

    const config = openCodeConfig({ ...opts }, ['linear']);
    expect(config.mcp).toMatchObject({ linear: { enabled: false }, 'motion-editor': { type: 'local', enabled: true, environment: { MGE_SERVER_PORT: '7001', MGE_WEB_PORT: '7000', MGE_AGENT_LABEL: 'OpenCode' } } });
    expect(config.agent[OPENCODE_AGENT].permission).toMatchObject({ '*': 'deny', 'motion-editor_*': 'allow' });
    expect(config).toMatchObject({ default_agent: OPENCODE_AGENT, permission: { '*': 'deny' }, share: 'disabled' });
    expect(config.agent[OPENCODE_AGENT].prompt).toContain('motion graphics editor');
  });

  it('adds private path denies globally and to the OpenCode agent while retaining deny-all', () => {
    const config = openCodeConfig(opts);
    for (const permission of [config.permission, config.agent[OPENCODE_AGENT].permission]) {
      for (const tool of ['read', 'edit'] as const) {
        expect(permission[tool]['*']).toBe('deny');
        for (const path of protectedPaths(opts.rootDir)) {
          expect(permission[tool][path]).toBe('deny');
          expect(permission[tool][`${path}/**`]).toBe('deny');
        }
        expect(Object.keys(permission[tool]).at(-1)).toBe('*');
      }
    }
  });

  it('continues the session with --session and the chosen model', async () => {
    const f = await fakeOpenCode('opencode-resume', { stdout: 'opencode-turn.jsonl' });
    await collect(createOpenCodeProvider({ ...opts, bin: f.bin, workspaceDir: ws('resume') }), turn({ sessionId: 'ses_1', model: 'anthropic/claude-sonnet-5-5' }));
    const run = (await f.calls()).find((c) => c.argv[0] === 'run')!;
    expect(flag(run.argv, '--session')).toBe('ses_1');
    expect(flag(run.argv, '-m')).toBe('anthropic/claude-sonnet-5-5');
  });

  it('reports a real error event (exit 1) as the turn’s error', async () => {
    const f = await fakeOpenCode('opencode-bad', { stdout: 'opencode-bad-model.jsonl', code: 1 });
    const events = await collect(createOpenCodeProvider({ ...opts, bin: f.bin, workspaceDir: ws('bad') }), turn({ model: 'opencode/no-such-model-xyz' }));
    expect(events).toEqual([
      { type: 'session', sessionId: 'ses_ec9d0fdd0ffeVjTjMqRu86Kb73' },
      { type: 'done', isError: true, error: 'Unexpected server error. Check server logs for details.', failure: 'unknown' },
    ]);
  });

  it('is ready with its models when the config resolves to the restricted agent', async () => {
    const f = await fakeOpenCode('opencode-ok', { userMcp: { linear: { type: 'local', command: ['x'] } } });
    const st = await createOpenCodeProvider({ ...opts, bin: f.bin, workspaceDir: ws('ok') }).status();
    expect(st).toMatchObject({ id: 'opencode', state: 'ready', available: true, detail: 'OpenCode 1.18.29 · 2 models', signIn: { command: 'opencode auth login' } });
    expect(st.models).toEqual([
      { id: '', label: 'Default (opencode/free-model)' },
      { id: 'opencode/big-pickle', label: 'big-pickle (opencode)' },
      { id: 'anthropic/claude-sonnet-5-5', label: 'claude-sonnet-5-5 (anthropic)' },
    ]);
  });

  it('is signed-out without models, not-installed without the CLI', async () => {
    const f = await fakeOpenCode('opencode-nomodels', { models: '' });
    expect(await createOpenCodeProvider({ ...opts, bin: f.bin, workspaceDir: ws('nomodels') }).status()).toMatchObject({ state: 'signed-out', detail: expect.stringContaining('opencode auth login') });
    expect(await createOpenCodeProvider({ ...opts, bin: join(dir, 'no-opencode'), workspaceDir: ws('none') }).status()).toMatchObject({ state: 'not-installed' });
  });

  it('is unsupported, and never runs, when the user’s config defeats the restriction or cannot be checked', async () => {
    // A user-defined agent of the same name whose keys come first: its "bash" allow ends up last.
    const f = await fakeOpenCode('opencode-defeated', { userAgentPermission: { 'motion-editor_*': 'allow', '*': 'allow', bash: 'allow' }, stdout: 'opencode-turn.jsonl' });
    const p = createOpenCodeProvider({ ...opts, bin: f.bin, workspaceDir: ws('defeated') });
    expect(await p.status()).toMatchObject({ state: 'unsupported', available: false, detail: expect.stringContaining('"bash" permission') });
    expect(await collect(p, turn())).toEqual([{ type: 'done', isError: true, error: expect.stringContaining('could not be limited'), failure: 'unknown' }]);
    expect((await f.calls()).filter((c) => c.argv[0] === 'run')).toEqual([]);

    const broken = await fakeOpenCode('opencode-nodebug', { failDebug: true, stdout: 'opencode-turn.jsonl' });
    const q = createOpenCodeProvider({ ...opts, bin: broken.bin, workspaceDir: ws('nodebug') });
    expect(await q.status()).toMatchObject({ state: 'unsupported' });
    expect((await broken.calls()).filter((c) => c.argv[0] === 'run')).toEqual([]);
  });

  it('checks resolved agents and configs', () => {
    const rules = (...r: [string, string, string?][]) => ({ permission: r.map(([permission, action, pattern = '*']) => ({ permission, action, pattern })) });
    expect(openCodeAgentProblems(rules(['*', 'allow'], ['*', 'deny'], ['motion-editor_*', 'allow'], ['external_directory', 'allow', '/tmp/x/*']))).toEqual([]);
    // A later allow for a pattern, or no deny at all.
    expect(openCodeAgentProblems(rules(['*', 'deny'], ['motion-editor_*', 'allow'], ['bash', 'allow', 'git *'])).join(' ')).toContain('"bash"');
    expect(openCodeAgentProblems(rules(['*', 'allow'], ['motion-editor_*', 'allow'])).length).toBeGreaterThan(5);
    // Every tool of another server, and plugin tools, too.
    expect(openCodeAgentProblems(rules(['*', 'deny'], ['motion-editor_*', 'allow'], ['other-*', 'allow'])).join(' ')).toContain('other-server_some_tool');
    expect(openCodeAgentProblems(rules(['*', 'deny']))).toEqual(['the editor tools are not allowed.']);
    expect(openCodeAgentProblems(null)).toHaveLength(1);

    expect(openCodeConfigProblems({ mcp: { 'motion-editor': { enabled: true }, linear: { enabled: false } }, default_agent: OPENCODE_AGENT })).toEqual([]);
    expect(openCodeConfigProblems({ mcp: { 'motion-editor': {}, linear: { type: 'remote' } }, default_agent: OPENCODE_AGENT })).toEqual(['other MCP servers would still load (linear).']);
    expect(openCodeConfigProblems({ mcp: {}, default_agent: 'build' })).toEqual(['its default agent is not the editor chat agent.']);
    expect(parseOpenCodeModels('\x1b[0mopencode/big-pickle\nnot a model\n', null)).toEqual([{ id: '', label: 'Default' }, { id: 'opencode/big-pickle', label: 'big-pickle (opencode)' }]);
  });

  it('parser: whole text parts as paragraphs, session once, errors joined, exit 0 is done', () => {
    const p = openCodeParser();
    expect(p.parse({ type: 'text', sessionID: 's1', part: { text: 'One.' } }).events).toEqual([{ type: 'session', sessionId: 's1' }, { type: 'text', text: 'One.' }]);
    expect(p.parse({ type: 'text', sessionID: 's1', part: { text: 'Two.' } }).events).toEqual([{ type: 'text', text: '\n\nTwo.' }]);
    expect(p.parse({ type: 'step_finish', sessionID: 's1', part: {} }).events).toEqual([]);
    expect(p.end(0)).toEqual({ type: 'done', isError: false });
    expect(p.end(1)).toBeNull();
    p.parse({ type: 'error', sessionID: 's1', error: { name: 'ProviderAuthError', data: { message: 'No API key for anthropic' } } });
    expect(p.end(1)).toEqual({ type: 'done', isError: true, error: 'No API key for anthropic' });
  });
});

describe('failure classification', () => {
  // [provider, text the CLI printed, expected kind]
  const TABLE: [AgentProviderId, string, string][] = [
    ['claude', 'Invalid API key · Please run /login', 'login-expired'],
    ['claude', 'OAuth token has expired. Please obtain a new token or refresh your existing token.', 'login-expired'],
    ['claude', 'Not logged in · Please run /login', 'login-expired'],
    ['claude', 'Claude AI usage limit reached|1791920000', 'plan-limit'],
    ['claude', '5-hour limit reached ∙ resets 3pm', 'plan-limit'],
    ['claude', 'Credit balance is too low', 'plan-limit'],
    ['claude', 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"Number of request tokens has exceeded your per-minute rate limit"}}', 'rate-limited'],
    ['claude', 'API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}', 'rate-limited'],
    ['claude', 'No conversation found with session ID: 3c1e…', 'account-changed'],
    ['claude', 'API Error: Connection error. (cause: getaddrinfo ENOTFOUND api.anthropic.com)', 'network'],
    ['codex', 'Codex exited (1) without finishing. Not logged in', 'login-expired'],
    ['codex', 'unexpected status 401 Unauthorized: Missing bearer or basic authentication in header', 'login-expired'],
    ['codex', 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.', 'login-expired'],
    ['codex', "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), or try again in 2 days 3 hours 4 minutes.", 'plan-limit'],
    ['codex', 'exceeded retry limit, last status: 429 Too Many Requests', 'rate-limited'],
    ['codex', 'stream disconnected before completion: error sending request for url (https://chatgpt.com/backend-api/codex/responses)', 'network'],
    ['codex', 'thread/resume failed: no rollout found for thread id 019a…', 'account-changed'],
    ['cursor', "Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.", 'login-expired'],
    ['cursor', "You've hit your usage limit for this billing cycle", 'plan-limit'],
    ['cursor', 'Error: read ECONNRESET', 'network'],
    ['opencode', 'ProviderAuthError: No API key found for provider anthropic', 'login-expired'],
    ['opencode', 'AI_APICallError: insufficient_quota: You exceeded your current quota', 'plan-limit'],
    ['opencode', 'Session not found', 'account-changed'],
    ['opencode', 'Rate limit exceeded. Please slow down.', 'rate-limited'],
    ['opencode', 'fetch failed', 'network'],
    ['codex', "The 'no-such-model-xyz' model is not supported when using Codex with a ChatGPT account.", 'unknown'],
  ];

  it.each(TABLE)('%s: %s → %s', (provider, text, kind) => {
    expect(classifyAgentFailure(text, provider).kind).toBe(kind);
  });

  it('says what happened and what to do, with the sign-in command for login problems', () => {
    expect(classifyAgentFailure('Not logged in', 'codex')).toEqual({ kind: 'login-expired', message: 'Codex is signed out.', hint: 'Run `codex login` in a terminal, then send again.' });
    expect(classifyAgentFailure("You've hit your usage limit. Try again in 2 days 3 hours.", 'codex').hint).toBe('Try again in 2 days 3 hours. Wait for it to reset or pick another agent, then send again.');
    expect(classifyAgentFailure('5-hour limit reached ∙ resets 3pm', 'claude').hint).toMatch(/^Resets 3pm\. /);
    expect(classifyAgentFailure('No conversation found with session ID: x', 'claude').hint).toContain('New chat');
    expect(classifyAgentFailure('Something odd', 'cursor')).toEqual({ kind: 'unknown', message: 'Something odd', hint: '' });
  });

  it('turns a failed turn into "<message> <hint>" with its kind; stopped turns stay as they were', async () => {
    async function* events(...e: AgentEvent[]) {
      yield* e;
    }
    const out: AgentEvent[] = [];
    for await (const e of explainFailures('codex', events({ type: 'text', text: 'Hi' }, { type: 'done', isError: true, error: 'unexpected status 401 Unauthorized' }))) out.push(e);
    expect(out).toEqual([
      { type: 'text', text: 'Hi' },
      { type: 'done', isError: true, error: 'Codex is signed out. Run `codex login` in a terminal, then send again.', failure: 'login-expired' },
    ]);
    const stopped: AgentEvent[] = [];
    for await (const e of explainFailures('codex', events({ type: 'done', isError: true, error: 'Stopped.' }))) stopped.push(e);
    expect(stopped).toEqual([{ type: 'done', isError: true, error: 'Stopped.' }]);
  });

  it('a real CLI failure (Codex turn.failed) arrives explained', async () => {
    const f = await fake('codex-401', { stdout: 'codex-failed.jsonl', code: 1 });
    // codex-failed.jsonl carries a model error (unknown): passed on unchanged.
    expect((await collect(createCodexProvider({ ...opts, bin: f.bin }), turn())).at(-1)).toMatchObject({ failure: 'unknown' });
    const h = await fake('cursor-auth', { stderr: 'cursor-signed-out.stderr', code: 1 });
    const events = await collect(createCursorProvider({ ...opts, bin: h.bin }), turn({ workspace: await cursorWorkspace('cursor-ws-auth') }));
    expect(events).toEqual([{ type: 'done', isError: true, error: 'Cursor Agent is signed out. Run `cursor-agent login` in a terminal, then send again.', failure: 'login-expired' }]);
  });
});

describe('status invalidation', () => {
  const counting = (id: AgentProviderId, counter: Record<string, number>, run?: AgentProvider['run']): AgentProvider => ({
    id,
    label: id,
    resumesAcrossModels: true,
    status: async (): Promise<ProviderInfo> => {
      counter[id] = (counter[id] ?? 0) + 1;
      return { id, label: id, available: true, state: 'ready', detail: `check ${counter[id]}`, models: [{ id: '', label: 'Default' }] };
    },
    run:
      run ??
      async function* () {
        yield { type: 'done', isError: false };
      },
  });

  it('invalidate(id) re-checks one provider; invalidateAll() every one', async () => {
    const n: Record<string, number> = {};
    const r = new ProviderRegistry([counting('claude', n), counting('codex', n)]);
    await r.list();
    await r.list();
    expect(n).toEqual({ claude: 1, codex: 1 });
    r.invalidate('codex');
    expect((await r.list()).map((p) => p.detail)).toEqual(['check 1', 'check 2']);
    r.invalidate('nope');
    r.invalidateAll();
    await r.list();
    expect(n).toEqual({ claude: 2, codex: 3 });
  });

  it('a turn that fails signed out invalidates that agent’s status; other failures do not', async () => {
    const n: Record<string, number> = {};
    let failure: AgentEvent = { type: 'done', isError: true, error: 'Codex is signed out.', failure: 'login-expired' };
    const r = new ProviderRegistry([
      counting('codex', n, async function* () {
        yield failure;
      }),
    ]);
    const chat = new ChatManager({ chatsDir: join(dir, 'inval-chats'), publicDir: join(dir, 'public'), providers: r, emit: () => undefined });
    const done = async () => {
      for (let i = 0; i < 100 && (await chat.state('prj_inval')).busy; i++) await new Promise((res) => setTimeout(res, 10));
    };
    await r.list();
    expect(n.codex).toBe(1);
    await chat.send('prj_inval', { text: 'hi' });
    await done();
    // Checked again once (the next status request after the failure), not served from the 30 s cache.
    expect(n.codex).toBe(2);
    expect((await chat.state('prj_inval')).messages.at(-1)).toMatchObject({ status: 'error', error: 'Codex is signed out.' });

    failure = { type: 'done', isError: true, error: 'Something odd', failure: 'unknown' };
    await chat.send('prj_inval', { text: 'again' });
    await done();
    await r.list();
    expect(n.codex).toBe(2);
  });

  it('GET /api/chat/providers?refresh=1 asks for fresh status; without it, cached', async () => {
    const n: Record<string, number> = {};
    const r = new ProviderRegistry([counting('claude', n)]);
    const seen: (boolean | undefined)[] = [];
    const root = join(dir, 'refresh-app');
    const app = createApp({
      publicDir: join(root, 'public'),
      rendersDir: join(root, 'renders'),
      projects: createProjectStore(join(root, 'projects')),
      renders: new RenderManager({ rendersDir: join(root, 'renders'), renderer: async () => undefined }),
      chatProviders: (o) => {
        seen.push(o?.refresh);
        if (o?.refresh) r.invalidateAll();
        return r.list();
      },
    });
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const get = async (q = '') => ((await (await fetch(`${base}/api/chat/providers${q}`)).json()) as ProviderInfo[])[0].detail;
      expect(await get()).toBe('check 1');
      expect(await get()).toBe('check 1');
      expect(await get('?refresh=1')).toBe('check 2');
      expect(await get('?refresh=0')).toBe('check 2');
      expect(seen).toEqual([false, false, true, false]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});


describe('Claude permission callback wiring', () => {
  it('passes the editor permission prompt tool, pre-allows only the editor and runs in the turn\'s workspace', async () => {
    const f = await fake('claude-permission', {});
    const workspace = await mkdtemp(join(tmpdir(), 'mge-ws-'));
    await collect(createClaudeProvider({ ...opts, bin: f.bin }), turn({ workspace }));
    const call = turnCall(await f.calls());
    expect(flag(call.argv, '--permission-prompt-tool')).toBe('mcp__motion-editor__editor_permission_prompt');
    expect(flag(call.argv, '--allowedTools')).toBe('mcp__motion-editor__*');
    expect(flag(call.argv, '--add-dir')).toBe(join(opts.rootDir, 'public'));
    expect(call.argv).not.toContain('--tools');
    expect(call.cwd).toBe(await realpath(workspace));
  });
});
