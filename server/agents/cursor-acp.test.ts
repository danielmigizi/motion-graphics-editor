// Cursor's two native transports against a stand-in cursor-agent (a real child
// process): print mode with --auto-review when Auto-apply is on, ACP with the
// editor's Allow/Deny when it is off. Print lines replay __fixtures__ captured
// from cursor-agent 2026.09.18 (or the same shape); the ACP side answers only
// the methods the provider uses, in the shapes cursor-agent returned live
// (session/new: modes.currentModeId "agent", parameterized model ids).

import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCursorProvider } from './cursor';
import type { AgentEvent, AgentProvider, AgentTurn } from './types';

const fixtures = join(__dirname, '__fixtures__');
const opts = { rootDir: '', serverPort: 7001, webPort: 7000 };
let dir: string;
beforeAll(async () => {
  // realpath: macOS's temp dir is a symlink (/var → /private/var).
  dir = await realpath(await mkdtemp(join(tmpdir(), 'mge-cursor-')));
  opts.rootDir = dir;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});
let number = 0;

const LISTING = 'Available models\n\nauto - Auto (default)\ngpt-x-high - GPT X High\nother - Other\n';

/** A stand-in cursor-agent: --list-models, print mode (-p) and ACP (`acp`), logging argv and every ACP message it receives. */
async function fake(options: Record<string, unknown> = {}) {
  const bin = join(dir, `cursor-${++number}`);
  const log = `${bin}.jsonl`;
  await writeFile(
    bin,
    `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const options = ${JSON.stringify(options)};
const log = (value) => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + '\\n');
process.on('SIGTERM', () => { log({ signal: 'SIGTERM' }); process.exit(0); });
const argv = process.argv.slice(2);
log({ argv, cwd: process.cwd(), key: process.env.CURSOR_API_KEY ?? null });
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
if (argv[0] === '--list-models') {
  process.stdout.write(${JSON.stringify(LISTING)});
} else if (argv.includes('-p')) {
  if (options.printFixture) process.stdout.write(fs.readFileSync(options.printFixture));
  else if (options.printStderr) { process.stderr.write(fs.readFileSync(options.printStderr)); process.exitCode = 1; }
  else {
    const session = flag('--resume') ?? 'chat-print';
    const line = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
    line({ type: 'system', subtype: 'init', session_id: session, model: 'Composer 2.5', permissionMode: 'default' });
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi' }] }, session_id: session, timestamp_ms: 1 });
    line({ type: 'assistant', message: { content: [{ type: 'text', text: ' there' }] }, session_id: session, timestamp_ms: 2 });
    line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Hi there' }] }, session_id: session, model_call_id: 'm1', timestamp_ms: 3 });
    const call = { mcpToolCall: { args: { name: 'raw-server_name-tool__x', args: { q: 1 }, providerIdentifier: 'raw-server_name', toolName: 'tool__x' } } };
    line({ type: 'tool_call', subtype: 'started', call_id: 'c1', tool_call: call, session_id: session });
    line({ type: 'tool_call', subtype: 'completed', call_id: 'c1', tool_call: call, session_id: session });
    line({ type: 'result', subtype: 'success', is_error: false, result: 'Hi there', session_id: session });
  }
} else if (argv.at(-1) === 'acp') {
  acp();
} else {
  process.stderr.write('unexpected arguments');
  process.exitCode = 2;
}

function acp() {
  const send = (value) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\\n');
  let next = 900;
  let promptId;
  const pending = new Map();
  const request = (method, params) => new Promise((resolve) => { const id = ++next; pending.set(id, resolve); send({ id, method, params }); });
  const update = (sessionId, value) => send({ method: 'session/update', params: { sessionId, update: value } });
  const available = options.available ?? [{ modelId: 'default[]', name: 'Auto' }];
  readline.createInterface({ input: process.stdin }).on('line', (text) => {
    const message = JSON.parse(text);
    log(message);
    if (!message.method) { pending.get(message.id)?.(message); pending.delete(message.id); return; }
    if (message.method === 'session/cancel') {
      if (!options.ignoreCancel && promptId !== undefined) send({ id: promptId, result: { stopReason: 'cancelled' } });
      return;
    }
    if (message.id === undefined) return;
    const reply = (result) => send({ id: message.id, result });
    const fail = (error) => send({ id: message.id, error: { code: -32000, message: error } });
    if (message.method === 'initialize') return reply({ protocolVersion: 1, agentCapabilities: { loadSession: options.loadSession ?? true, promptCapabilities: { image: options.images ?? true } }, authMethods: [] });
    if (message.method === 'session/new') return reply({ sessionId: 'chat-acp', modes: { currentModeId: 'agent', availableModes: [{ id: 'agent', name: 'Agent' }] }, models: { currentModelId: options.newModel ?? 'default[]', availableModels: available } });
    if (message.method === 'session/load') {
      const id = message.params.sessionId;
      // The chat's history comes back as updates before the answer.
      update(id, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'OLD QUESTION' } });
      update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'REPLAYED' } });
      update(id, { sessionUpdate: 'tool_call', toolCallId: 'old-call', title: 'Old', kind: 'read' });
      return reply({ models: { currentModelId: options.loadedModel ?? 'default[]', availableModels: available } });
    }
    if (message.method === 'session/set_model') return options.setModelFails ? fail('model unavailable') : reply({});
    if (message.method === 'session/prompt') return void prompt(message);
    fail('Method not found');
  });

  async function prompt(message) {
    promptId = message.id;
    const id = message.params.sessionId;
    update('foreign', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FOREIGN' } });
    update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Hello' } });
    update(id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'THINKING' } });
    update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: ' world' } });
    const mcp = { toolCallId: 'mcp-1', title: 'raw-server_name-tool__x', kind: 'other', status: 'pending', rawInput: { providerIdentifier: 'raw-server_name', toolName: 'tool__x', args: { q: 1 } } };
    update(id, { sessionUpdate: 'tool_call', ...mcp });
    update(id, { sessionUpdate: 'tool_call_update', ...mcp, status: 'completed' });
    update(id, { sessionUpdate: 'tool_call', ...mcp });
    const command = { toolCallId: 'cmd-1', title: '\`printf MGE\`', kind: 'execute', rawInput: { command: 'printf MGE' } };
    update(id, { sessionUpdate: 'tool_call', ...command });
    if (options.permission) {
      const choices = options.permissionOptions ?? [
        { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
        { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'never', name: 'Always reject', kind: 'reject_always' },
        { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
      ];
      const answer = await request('session/request_permission', { sessionId: id, toolCall: command, options: choices });
      log({ permission: answer.result });
    }
    for (const method of options.requests ?? []) {
      const answer = await request(method, { sessionId: id, toolCallId: 'x' });
      log({ request: method, answer: answer.result ?? { error: answer.error.message } });
    }
    if (options.hang) return;
    if (options.exit) { process.stderr.write('acp crashed'); process.exit(3); }
    update(id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '!' } });
    send({ id: message.id, result: { stopReason: options.stopReason ?? 'end_turn' } });
  }
}
`,
  );
  await chmod(bin, 0o755);
  const entries = async (): Promise<any[]> =>
    (await readFile(log, 'utf8').catch(() => ''))
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  return {
    bin,
    entries,
    /** The turn processes (not the --list-models lookup). */
    calls: async () => (await entries()).filter((e) => e.argv && e.argv[0] !== '--list-models'),
    received: async (method: string) => (await entries()).filter((e) => e.method === method),
  };
}

async function workspace() {
  const ws = join(dir, 'workspaces', `ws-${++number}`);
  await mkdir(ws, { recursive: true });
  return ws;
}

const turn = (t: Partial<AgentTurn> = {}): AgentTurn => ({ prompt: 'hello', sessionId: null, model: '', images: [], workspace: tmpdir(), signal: new AbortController().signal, ...t });

async function collect(p: AgentProvider, t: AgentTurn) {
  const events: AgentEvent[] = [];
  for await (const e of p.run(t)) events.push(e);
  return events;
}

const textOf = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'text' ? [e.text] : [])).join('');
const infoOf = (events: AgentEvent[]) => events.flatMap((e) => (e.type === 'session-info' ? [e.info] : []));
const flag = (argv: string[], name: string) => argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined;
const INSTRUCTIONS = /^\[Instructions for this chat\][\s\S]*motion graphics editor[\s\S]*\n\nhello$/;
const UNSAFE = ['--force', '-f', '--yolo', '--sandbox'];

async function withKey<T>(fn: () => Promise<T>): Promise<T> {
  const prev = process.env.CURSOR_API_KEY;
  process.env.CURSOR_API_KEY = 'sk-should-not-leak';
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = prev;
  }
}

describe('Auto-apply on: print mode with Cursor’s Auto-review', () => {
  it('runs native --auto-review (never --force) in the workspace without the API key; the first turn carries the instructions', async () => {
    const f = await fake();
    const ws = await workspace();
    const events = await withKey(() => collect(createCursorProvider({ ...opts, bin: f.bin }), turn({ workspace: ws, autoApply: true })));
    const [call] = await f.calls();
    expect(call.key).toBeNull();
    expect(call.cwd).toBe(ws);
    const a: string[] = call.argv;
    expect(a.slice(0, 5)).toEqual(['-p', '--output-format', 'stream-json', '--stream-partial-output', '--auto-review']);
    expect(a).toEqual(expect.arrayContaining(['--approve-mcps', '--trust']));
    expect(flag(a, '--workspace')).toBe(ws);
    for (const other of [...UNSAFE, 'acp', '--resume', '--model']) expect(a).not.toContain(other);
    expect(a.at(-2)).toBe('--');
    expect(a.at(-1)).toMatch(INSTRUCTIONS);
    // Deltas once (the whole-message repeat is skipped); the MCP call keeps Cursor's own server and tool names.
    expect(events).toEqual([
      { type: 'session', sessionId: 'chat-print' },
      { type: 'session-info', info: { sessionId: 'chat-print', model: 'Composer 2.5', permissionMode: 'cursor-auto-review', permissionSource: 'configured', skillUsageReported: false, tools: [] } },
      { type: 'text', text: 'Hi' },
      { type: 'text', text: ' there' },
      { type: 'tool', name: 'mcp__raw-server_name__tool__x', input: { q: 1 }, mcpServer: 'raw-server_name', mcpTool: 'tool__x' },
      { type: 'session', sessionId: 'chat-print' },
      { type: 'done', isError: false },
    ]);
    // Cursor reports no catalogs: they stay unknown rather than empty.
    const info = infoOf(events)[0];
    expect('skills' in info || 'mcpServers' in info).toBe(false);
    const mcp = JSON.parse(await readFile(join(ws, '.cursor', 'mcp.json'), 'utf8'));
    expect(mcp.mcpServers['motion-editor'].env).toMatchObject({ MGE_AGENT_LABEL: 'Cursor Agent', MGE_SERVER_PORT: '7001' });
  });

  it('maps recorded turns: deltas once, tools named, schema lookups skipped, MCP identity as Cursor reported it', async () => {
    const f = await fake({ printFixture: join(fixtures, 'cursor-turn.jsonl') });
    const events = await collect(createCursorProvider({ ...opts, bin: f.bin }), turn({ workspace: await workspace(), autoApply: true }));
    expect(textOf(events)).toBe(
      "I'll call the editor context tool, write `probe-delete-me.txt`, and run `ls`, then report each result in one line." +
        '1. `editor_get_context` returned: no editor is connected.\n2. Creating `probe-delete-me.txt` failed: write blocked by permissions configuration.\n3. `ls` failed: command blocked by permissions configuration.',
    );
    const tools = events.filter((e): e is Extract<AgentEvent, { type: 'tool' }> => e.type === 'tool');
    expect(tools.map((e) => e.name)).toEqual(['edit', 'shell', 'mcp__motion-editor__editor_get_context', 'edit', 'shell']);
    expect(tools[2]).toMatchObject({ mcpServer: 'motion-editor', mcpTool: 'editor_get_context' });
    expect(events.slice(0, 2)).toEqual([
      { type: 'session', sessionId: 'a4374459-5aab-4ead-850f-b35b93b7c93b' },
      { type: 'session-info', info: { sessionId: 'a4374459-5aab-4ead-850f-b35b93b7c93b', model: 'Grok 4.7 256K High', permissionMode: 'cursor-auto-review', permissionSource: 'configured', skillUsageReported: false, tools: [] } },
    ]);
    expect(events.at(-1)).toEqual({ type: 'done', isError: false });

    const force = await fake({ printFixture: join(fixtures, 'cursor-force-turn.jsonl') });
    const resumed = await collect(createCursorProvider({ ...opts, bin: force.bin }), turn({ workspace: await workspace(), autoApply: true, sessionId: '42457c32-d797-46ec-b399-acad3f0543ba' }));
    expect(resumed.flatMap((e) => (e.type === 'tool' ? [e.name] : []))).toEqual(['webSearch', 'shell', 'edit', 'shell', 'grep']);
    expect(textOf(resumed)).toContain('note.txt:** Created in the working directory');
    expect(resumed[0]).toEqual({ type: 'session', sessionId: '42457c32-d797-46ec-b399-acad3f0543ba' });
    expect(resumed.at(-1)).toEqual({ type: 'done', isError: false });
  });

  it('resumes with --resume and --model, without repeating the instructions', async () => {
    const f = await fake();
    const ws = await workspace();
    await collect(createCursorProvider({ ...opts, bin: f.bin }), turn({ workspace: ws, autoApply: true, sessionId: 'chat_1', model: 'composer-2.5-fast' }));
    const a: string[] = (await f.calls())[0].argv;
    expect(flag(a, '--resume')).toBe('chat_1');
    expect(flag(a, '--model')).toBe('composer-2.5-fast');
    expect(flag(a, '--workspace')).toBe(ws);
    expect(a).toEqual(expect.arrayContaining(['--auto-review', '--approve-mcps', '--trust']));
    for (const other of UNSAFE) expect(a).not.toContain(other);
    expect(a.slice(-2)).toEqual(['--', 'hello']);
  });

  it('turns a CLI failure (stderr, exit 1, no result) into a short error', async () => {
    const f = await fake({ printStderr: join(fixtures, 'cursor-bad-model.stderr') });
    const events = await collect(createCursorProvider({ ...opts, bin: f.bin }), turn({ workspace: await workspace(), autoApply: true, model: 'no-such-model-xyz' }));
    expect(events).toHaveLength(1);
    const done = events[0] as Extract<AgentEvent, { type: 'done' }>;
    expect(done.isError).toBe(true);
    expect(done.error).toMatch(/^Cursor Agent exited \(1\) without finishing\. Cannot use this model: no-such-model-xyz/);
    expect(done.error!.length).toBeLessThan(400);
  });
});

describe('Auto-apply off: ACP with the editor’s Allow/Deny', () => {
  it('starts a native ACP chat (no --force, no --auto-review), streams its text and tools once, and reports what it configured', async () => {
    const f = await fake({ newModel: 'composer-2.5[fast=false]' });
    const ws = await workspace();
    const events = await withKey(() => collect(createCursorProvider({ ...opts, bin: f.bin }), turn({ workspace: ws })));
    const [call] = await f.calls();
    expect(call.key).toBeNull();
    expect(call.cwd).toBe(ws);
    expect(call.argv).toEqual(['--approve-mcps', '--trust', '--workspace', ws, 'acp']);
    for (const other of [...UNSAFE, '--auto-review', '-p']) expect(call.argv).not.toContain(other);
    const [init] = await f.received('initialize');
    expect(init.jsonrpc).toBe('2.0');
    expect(init.params).toMatchObject({ protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } });
    expect((await f.received('session/new'))[0].params).toEqual({ cwd: ws, mcpServers: [] });
    const [prompt] = await f.received('session/prompt');
    expect(prompt.params.sessionId).toBe('chat-acp');
    expect(prompt.params.prompt).toHaveLength(1);
    expect(prompt.params.prompt[0].text).toMatch(INSTRUCTIONS);
    // Another session's update and the agent's thoughts are not the reply; a repeated tool call is one step.
    expect(events).toEqual([
      { type: 'session', sessionId: 'chat-acp' },
      { type: 'session-info', info: { sessionId: 'chat-acp', model: 'composer-2.5[fast=false]', permissionMode: 'cursor-manual', permissionSource: 'configured', skillUsageReported: false, tools: [] } },
      { type: 'text', text: 'Hello' },
      { type: 'text', text: ' world' },
      { type: 'tool', name: 'mcp__raw-server_name__tool__x', input: { q: 1 }, mcpServer: 'raw-server_name', mcpTool: 'tool__x' },
      { type: 'tool', name: 'shell', input: { command: 'printf MGE' } },
      { type: 'text', text: '!' },
      { type: 'done', isError: false },
    ]);
    const info = infoOf(events)[0];
    expect('skills' in info || 'mcpServers' in info).toBe(false);
  });

  const asked: { action: string; detail?: string }[] = [];
  const cases: [string, Record<string, unknown>, AgentTurn['askPermission'], unknown, boolean][] = [
    ['allow answers the one-time allow, never “always”', {}, async () => true, { outcome: { outcome: 'selected', optionId: 'once' } }, true],
    ['deny answers the one-time reject', {}, async () => false, { outcome: { outcome: 'selected', optionId: 'reject' } }, true],
    ['a failing prompt denies', {}, async () => { throw new Error('editor gone'); }, { outcome: { outcome: 'selected', optionId: 'reject' } }, true],
    ['no editor prompt denies', {}, undefined, { outcome: { outcome: 'selected', optionId: 'reject' } }, false],
    ['only “always” on offer: never asks, rejects', { permissionOptions: [{ optionId: 'always', kind: 'allow_always' }, { optionId: 'reject', kind: 'reject_once' }] }, async () => true, { outcome: { outcome: 'selected', optionId: 'reject' } }, false],
    ['multiple-choice input is not treated as a tool approval', { permissionOptions: [{ optionId: 'first', kind: 'allow_once' }, { optionId: 'second', kind: 'allow_once' }, { optionId: '__ask_question_skip__', kind: 'reject_once' }] }, async () => true, { outcome: { outcome: 'selected', optionId: '__ask_question_skip__' } }, false],
    ['no one-time reject on offer: a denial cancels', { permissionOptions: [{ optionId: 'once', kind: 'allow_once' }, { optionId: 'never', kind: 'reject_always' }] }, async () => false, { outcome: { outcome: 'cancelled' } }, true],
  ];
  it.each(cases)('permission: %s', async (_name, extra, askPermission, expected, asks) => {
    asked.length = 0;
    const f = await fake({ permission: true, ...extra });
    const ask = askPermission && ((action: string, detail?: string) => (asked.push({ action, detail }), askPermission(action, detail)));
    const events = await collect(createCursorProvider({ ...opts, bin: f.bin }), turn({ workspace: await workspace(), askPermission: ask }));
    expect((await f.entries()).find((e) => 'permission' in e)?.permission).toEqual(expected);
    expect(asked.length).toBe(asks ? 1 : 0);
    if (asks) {
      expect(asked[0].action).toBe('Run a terminal command: `printf MGE`');
      expect(JSON.parse(asked[0].detail!)).toEqual({ kind: 'execute', input: { command: 'printf MGE' } });
    }
    expect(events.at(-1)).toEqual({ type: 'done', isError: false });
  });

  it('Stop while Cursor waits for an answer ends the turn and never allows', async () => {
    const f = await fake({ permission: true, hang: true });
    const controller = new AbortController();
    let action = '';
    const events = await collect(
      createCursorProvider({ ...opts, bin: f.bin }),
      turn({
        workspace: await workspace(),
        signal: controller.signal,
        askPermission: (a) => {
          action = a;
          controller.abort();
          return new Promise(() => {});
        },
      }),
    );
    expect(action).toContain('printf MGE');
    expect(events.at(-1)).toEqual({ type: 'done', isError: true, error: 'Stopped.' });
    expect((await f.entries()).filter((e) => e.permission?.outcome?.optionId === 'once')).toHaveLength(0);
    const entries = await f.entries();
    expect(entries.find(e => e.method === 'session/cancel')?.params).toEqual({ sessionId: 'chat-acp' });
    const cancelled = entries.findIndex(e => e.method === 'session/cancel');
    const terminated = entries.findIndex(e => e.signal === 'SIGTERM');
    if (terminated !== -1) expect(terminated).toBeGreaterThan(cancelled);
  });

  it('bounds native cancellation when Cursor never acknowledges it', async () => {
    const f = await fake({ permission: true, hang: true, ignoreCancel: true });
    const controller = new AbortController();
    const events = await collect(createCursorProvider({ ...opts, bin: f.bin }), turn({ workspace: await workspace(), signal: controller.signal, askPermission: async () => { controller.abort(); return false; } }));
    expect((await f.received('session/cancel'))).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: 'done', isError: true, error: 'Stopped.' });
  }, 10000);

  it('a turn stopped before it starts never starts Cursor', async () => {
    const f = await fake();
    const controller = new AbortController();
    controller.abort();
    expect(await collect(createCursorProvider({ ...opts, bin: f.bin }), turn({ workspace: await workspace(), signal: controller.signal }))).toEqual([{ type: 'done', isError: true, error: 'Stopped.' }]);
    expect(await f.calls()).toHaveLength(0);
  });

  it('continues the chat with session/load, ignoring the history it replays', async () => {
    const f = await fake();
    const ws = await workspace();
    const events = await collect(createCursorProvider({ ...opts, bin: f.bin }), turn({ workspace: ws, sessionId: 'chat-1' }));
    expect((await f.received('session/new'))).toHaveLength(0);
    expect((await f.received('session/load'))[0].params).toEqual({ sessionId: 'chat-1', cwd: ws, mcpServers: [] });
    expect((await f.received('session/prompt'))[0].params.prompt).toEqual([{ type: 'text', text: 'hello' }]);
    expect(events[0]).toEqual({ type: 'session', sessionId: 'chat-1' });
    expect(textOf(events)).toBe('Hello world!');
    expect(events.some((e) => e.type === 'tool' && e.name === 'Read')).toBe(false);
  });

  it('resumes each transport using that native store’s session id', async () => {
    const f = await fake();
    const provider = createCursorProvider({ ...opts, bin: f.bin });
    const ws = await workspace();
    const first = await collect(provider, turn({ workspace: ws }));
    expect(first[0]).toEqual({ type: 'session', sessionId: 'chat-acp' });
    const second = await collect(provider, turn({ workspace: ws, autoApply: true }));
    const third = await collect(provider, turn({ workspace: ws, sessionId: 'chat-acp' }));
    const fourth = await collect(provider, turn({ workspace: ws, sessionId: 'chat-print', autoApply: true }));
    const calls = await f.calls();
    expect(calls.map((c) => (c.argv.includes('-p') ? `print ${flag(c.argv, '--resume')}` : c.argv.at(-1)))).toEqual(['acp', 'print undefined', 'acp', 'print chat-print']);
    expect((await f.received('session/load'))[0].params.sessionId).toBe('chat-acp');
    expect([first, second, third, fourth].map((e) => [infoOf(e)[0].sessionId, infoOf(e)[0].permissionMode])).toEqual([
      ['chat-acp', 'cursor-manual'],
      ['chat-print', 'cursor-auto-review'],
      ['chat-acp', 'cursor-manual'],
      ['chat-print', 'cursor-auto-review'],
    ]);
  });

  it('a selected model: a new chat lets Cursor resolve it; a loaded chat is switched to it, or the turn fails', async () => {
    // Cursor's ACP ids are parameterized; names do not match the CLI labels here, so only what Cursor resolved earlier can match.
    const f = await fake({ newModel: 'gpt-x[effort=high]', loadedModel: 'old[x]', available: [{ modelId: 'gpt-x[effort=high]', name: 'Renamed' }, { modelId: 'old[x]', name: 'Old' }] });
    const provider = createCursorProvider({ ...opts, bin: f.bin });
    const ws = await workspace();
    const created = await collect(provider, turn({ workspace: ws, model: 'gpt-x-high' }));
    const argv: string[] = (await f.calls())[0].argv;
    expect(flag(argv, '--model')).toBe('gpt-x-high');
    expect(argv.indexOf('--model')).toBeLessThan(argv.indexOf('acp'));
    expect(infoOf(created)[0].model).toBe('gpt-x[effort=high]');
    expect(await f.received('session/set_model')).toHaveLength(0);

    const loaded = await collect(provider, turn({ workspace: ws, model: 'gpt-x-high', sessionId: 'chat-1' }));
    expect((await f.received('session/set_model')).map((m) => m.params)).toEqual([{ sessionId: 'chat-1', modelId: 'gpt-x[effort=high]' }]);
    expect(infoOf(loaded)[0].model).toBe('gpt-x[effort=high]');

    // A fresh server run knows nothing it resolved before: unconfirmed, the turn fails instead of running on the old model.
    const unknown = await collect(createCursorProvider({ ...opts, bin: f.bin }), turn({ workspace: ws, model: 'gpt-x-high', sessionId: 'chat-1' }));
    expect(unknown).toEqual([{ type: 'done', isError: true, error: 'Cursor Agent could not confirm that this chat continues on GPT X High. Pick the model again, or press New chat.', failure: 'unknown' }]);
    expect(await f.received('session/prompt')).toHaveLength(2);
  });

  it('matches a loaded chat’s model by its label, switches Auto back, and fails when Cursor refuses the switch', async () => {
    const available = [{ modelId: 'default[]', name: 'Auto' }, { modelId: 'gpt-x[effort=high]', name: 'GPT X High' }, { modelId: 'old[x]', name: 'Old' }];
    const f = await fake({ loadedModel: 'old[x]', available });
    const ws = await workspace();
    const byLabel = await collect(createCursorProvider({ ...opts, bin: f.bin }), turn({ workspace: ws, model: 'gpt-x-high', sessionId: 'chat-1' }));
    expect(infoOf(byLabel)[0].model).toBe('gpt-x[effort=high]');
    const auto = await collect(createCursorProvider({ ...opts, bin: f.bin }), turn({ workspace: ws, model: '', sessionId: 'chat-1' }));
    expect(infoOf(auto)[0].model).toBe('default[]');
    expect((await f.received('session/set_model')).map((m) => m.params.modelId)).toEqual(['gpt-x[effort=high]', 'default[]']);
    // Already on the selected model: nothing to switch.
    const same = await fake({ loadedModel: 'gpt-x[effort=high]', available });
    await collect(createCursorProvider({ ...opts, bin: same.bin }), turn({ workspace: ws, model: 'gpt-x-high', sessionId: 'chat-1' }));
    expect(await same.received('session/set_model')).toHaveLength(0);

    const refused = await fake({ loadedModel: 'old[x]', available, setModelFails: true });
    const events = await collect(createCursorProvider({ ...opts, bin: refused.bin }), turn({ workspace: ws, model: 'gpt-x-high', sessionId: 'chat-1' }));
    expect(events).toEqual([{ type: 'done', isError: true, error: 'Cursor Agent could not switch this chat to GPT X High: model unavailable', failure: 'unknown' }]);
    expect(await refused.received('session/prompt')).toHaveLength(0);
  });

  it('sends image attachments as ACP image blocks when Cursor accepts images', async () => {
    const png = join(dir, 'u_1.png');
    const svg = join(dir, 'u_2.svg');
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]));
    await writeFile(svg, '<svg/>');
    const f = await fake();
    await collect(createCursorProvider({ ...opts, bin: f.bin }), turn({ workspace: await workspace(), images: [png, svg, join(dir, 'missing.png')] }));
    const [prompt] = await f.received('session/prompt');
    expect(prompt.params.prompt.slice(1)).toEqual([{ type: 'image', mimeType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]).toString('base64') }]);

    const textOnly = await fake({ images: false });
    await collect(createCursorProvider({ ...opts, bin: textOnly.bin }), turn({ workspace: await workspace(), images: [png] }));
    expect((await textOnly.received('session/prompt'))[0].params.prompt).toHaveLength(1);
  });

  it('declines Cursor’s plan and question prompts, refuses requests it does not support, and carries on', async () => {
    const f = await fake({ requests: ['cursor/create_plan', 'cursor/ask_question', 'fs/read_text_file', 'terminal/create'] });
    const events = await collect(createCursorProvider({ ...opts, bin: f.bin }), turn({ workspace: await workspace() }));
    const answers = Object.fromEntries((await f.entries()).filter((e) => e.request).map((e) => [e.request, e.answer]));
    expect(answers['cursor/create_plan']).toMatchObject({ outcome: { outcome: 'rejected' } });
    expect(answers['cursor/ask_question']).toMatchObject({ outcome: { outcome: 'skipped' } });
    expect(answers['fs/read_text_file']).toEqual({ error: 'Client could not complete the request.' });
    expect(answers['terminal/create']).toEqual({ error: 'Client could not complete the request.' });
    expect(events.at(-1)).toEqual({ type: 'done', isError: false });
  });

  it('ends with Cursor’s stop reason, or the closed connection’s error', async () => {
    const run = async (options: Record<string, unknown>, t: Partial<AgentTurn> = {}) => {
      const f = await fake(options);
      return (await collect(createCursorProvider({ ...opts, bin: f.bin }), turn({ workspace: await workspace(), ...t }))).at(-1);
    };
    expect(await run({ stopReason: 'refusal' })).toEqual({ type: 'done', isError: true, error: 'Cursor Agent stopped: it declined this request.', failure: 'unknown' });
    expect(await run({ stopReason: 'cancelled' })).toEqual({ type: 'done', isError: true, error: 'Stopped.' });
    expect(await run({ exit: true })).toMatchObject({ type: 'done', isError: true, error: expect.stringContaining('acp crashed') });
    expect(await run({ loadSession: false }, { sessionId: 'chat-1' })).toMatchObject({ isError: true, error: expect.stringContaining('cannot continue a chat over ACP') });
  });
});
