import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createCodexProvider } from './codex';
import { JsonRpcPeer } from './json-rpc';
import type { AgentEvent, AgentTurn } from './types';

let directory: string;
beforeAll(async () => { directory = await realpath(await mkdtemp(join(tmpdir(), 'mge-codex-native-'))); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
let number = 0;

/** A real child process implementing only the native app-server protocol we use. */
async function fake(options: Record<string, unknown> = {}) {
  const bin = join(directory, `codex-${++number}`);
  const log = `${bin}.jsonl`;
  await writeFile(bin, `#!/usr/bin/env node
const fs = require('node:fs');
const readline = require('node:readline');
const options = ${JSON.stringify(options)};
const log = value => fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + '\\n');
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
log({ argv: process.argv.slice(2), cwd: process.cwd(), keys: [process.env.OPENAI_API_KEY ?? null, process.env.CODEX_API_KEY ?? null] });
process.on('SIGTERM', () => { log({ terminated: true }); process.exit(0); });
let session = 'thread-one';
let pending = new Map();
let id = 500;
const request = (method, params) => new Promise(resolve => { const key = ++id; pending.set(key, resolve); send({ id: key, method, params }); });
const notification = (method, params) => send({ method, params: { threadId: session, turnId: 'turn-one', ...params } });
const text = () => {
  notification('item/agentMessage/delta', { itemId: 'a', delta: 'Hello' });
  notification('item/agentMessage/delta', { itemId: 'a', delta: ' world' });
  notification('item/completed', { item: { id: 'a', type: 'agentMessage', text: 'Hello world!' } });
  notification('item/completed', { item: { id: 'a', type: 'agentMessage', text: 'Hello world!' } });
  notification('item/completed', { item: { id: 'b', type: 'agentMessage', text: 'Done.' } });
};
async function flow() {
  const base = { threadId: session, turnId: 'turn-one', itemId: 'approval' };
  if (options.approvals) {
    for (const method of options.approvals) {
      if (method === 'item/fileChange/requestApproval' && !options.unknownFile) notification('item/started', { item: { type: 'fileChange', id: 'approval', changes: options.nativeChanges ?? (options.filePaths ?? ['/outside/clip.ts']).map(path => ({ path, kind: { type: 'update' }, diff: 'change' })) } });
      const waiting = request(method, { ...base, command: 'echo safe', availableDecisions: options.availableDecisions, questions: options.questions, permissions: { network: { enabled: true }, fileSystem: { read: ['/tmp/read'], write: ['/tmp/write'] }, unsupported: 'never-grant' }, ...(options.foreignApproval ? { threadId: 'foreign' } : {}), ...(options.requestDetails ?? {}) });
      if (options.completeDuringApproval) setTimeout(() => notification('turn/completed', { turn: { id: 'turn-one', status: 'completed', items: [] } }), 10);
      if (options.notifyWhileWaiting) notification('item/agentMessage/delta', { itemId: 'waiting', delta: 'Approval transport alive' });
      const value = await waiting;
      log({ approval: method, value });
    }
  }
  if (options.hang) return;
  if (options.malformed) { process.stdout.write('not-json\\n'); return; }
  if (options.exit) { process.stderr.write('native connection lost'); process.exit(7); }
  notification('item/agentMessage/delta', { threadId: 'foreign', itemId: 'bad', delta: 'FOREIGN' });
  notification('item/agentMessage/delta', { turnId: 'old-turn', itemId: 'bad', delta: 'OLD' });
  const item = { id: 'mcp', type: 'mcpToolCall', server: 'raw-name_with__bits', tool: 'search__models', arguments: { category: 'test' } };
  notification('item/started', { item });
  notification('item/completed', { item });
  notification('item/started', { item: { id: 'cmd', type: 'commandExecution', command: 'echo safe', cwd: process.cwd() } });
  text();
  notification('turn/completed', { turn: { id: 'old-turn', status: 'completed', items: [] } });
  notification('turn/completed', { turn: { id: 'turn-one', status: options.failed ? 'failed' : 'completed', error: options.failed ? { message: 'model failed' } : null, items: [{ id: 'b', type: 'agentMessage', text: 'Done.' }] } });
}
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const message = JSON.parse(line);
  log(message);
  if (!message.method) { pending.get(message.id)?.(message); pending.delete(message.id); return; }
  if (message.id === undefined) return;
  let result = {};
  if (message.method === 'initialize') result = { userAgent: 'fake-codex' };
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    if (options.badThread) result = { thread: {} };
    else {
      session = message.params.threadId ?? session;
      result = { thread: { id: session }, model: message.params.model ?? 'actual-default', approvalPolicy: options.badPolicy ? 'never' : message.params.approvalPolicy, approvalsReviewer: options.badReviewer ? 'user' : message.params.approvalsReviewer, sandbox: { type: options.badSandbox ? 'dangerFullAccess' : 'workspaceWrite', networkAccess: !options.noNetwork }, ...(options.noProfile ? {} : { activePermissionProfile: { id: options.badProfile ? 'other' : 'motion_editor' } }) };
    }
  }
  if (message.method === 'turn/interrupt') {
    if (options.ignoreInterrupt) return;
    send({ id: message.id, result: {} });
    notification('turn/completed', { turn: { id: 'turn-one', status: 'interrupted', error: null, items: [] } });
    return;
  }
  if (message.method === 'skills/list') {
    if (options.discoveryFailure) { send({ id: message.id, error: { message: 'skill discovery failed' } }); return; }
    result = { data: [{ cwd: process.cwd(), skills: [{ name: 'enabled-skill', enabled: true }, { name: 'disabled-skill', enabled: false }], errors: options.skillErrors ? [{ message: 'unreadable' }] : [] }] };
  }
  if (message.method === 'mcpServerStatus/list') {
    if (options.discoveryFailure) { send({ id: message.id, error: { message: 'MCP discovery failed' } }); return; }
    const next = message.params.cursor;
    if (!next && options.mcpDelayMs) await new Promise(resolve => setTimeout(resolve, options.mcpDelayMs));
    result = { data: [{ name: next ? 'second-server' : 'raw-name_with__bits', runtimeStatus: next ? 'failed' : 'connected', tools: next ? {} : { search: {} }, toolsError: options.toolsError ? 'catalog failed' : null }], nextCursor: next ? null : 'page-two' };
  }
  if (message.method === 'turn/start') {
    if (options.badTurn) result = { turn: {} };
    else result = { turn: { id: 'turn-one', status: 'inProgress', items: [] } };
    if (options.earlyEvents) text();
    send({ id: message.id, result });
    setTimeout(flow, 20);
    return;
  }
  send({ id: message.id, result });
});
`);
  await chmod(bin, 0o755);
  return { bin, calls: async (): Promise<any[]> => (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line)) };
}

function turn(overrides: Partial<AgentTurn> = {}): AgentTurn {
  return { prompt: 'hello', sessionId: null, model: '', images: [], workspace: directory, signal: new AbortController().signal, ...overrides };
}
function provider(bin: string) { return createCodexProvider({ bin, rootDir: directory, serverPort: 7001, webPort: 7000 }); }
async function collect(bin: string, message: AgentTurn = turn()) {
  const events: AgentEvent[] = [];
  for await (const event of provider(bin).run(message)) events.push(event);
  return events;
}
const lastInfo = (events: AgentEvent[]) => events.filter(event => event.type === 'session-info').at(-1);
const approvalReplies = async (fakeServer: Awaited<ReturnType<typeof fake>>) => (await fakeServer.calls()).filter(call => call.approval).map(call => call.value);

describe('Codex native app-server harness', () => {
  it('initializes, starts with native auto-review, strips keys, and preserves editor MCP merge', async () => {
    const server = await fake();
    const originalOpenai = process.env.OPENAI_API_KEY;
    const originalCodex = process.env.CODEX_API_KEY;
    process.env.OPENAI_API_KEY = 'must-not-leak'; process.env.CODEX_API_KEY = 'must-not-leak';
    let events: AgentEvent[];
    try { events = await collect(server.bin, turn({ autoApply: true, model: 'gpt-6.1-sol', images: ['/tmp/image.png'] })); }
    finally {
      if (originalOpenai === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalOpenai;
      if (originalCodex === undefined) delete process.env.CODEX_API_KEY; else process.env.CODEX_API_KEY = originalCodex;
    }
    const calls = await server.calls();
    expect(calls[0].keys).toEqual([null, null]);
    expect(calls[0].cwd).toBe(await import('node:fs').then(fs => fs.realpathSync(directory)));
    expect(calls[0].argv[0]).toBe('app-server');
    expect(calls[0].argv.some((arg: string) => arg.startsWith('mcp_servers={"motion-editor"='))).toBe(true);
    expect(calls.find(call => call.method === 'initialize').params.capabilities.experimentalApi).toBe(true);
    expect(calls.find(call => call.method === 'initialized')).toBeDefined();
    expect(calls.find(call => call.method === 'thread/start').params.developerInstructions.length).toBeGreaterThan(100);
    expect(calls.find(call => call.method === 'thread/start').params.cwd).toBe(directory);
    expect(calls.find(call => call.method === 'thread/start').params).toMatchObject({ model: 'gpt-6.1-sol', approvalsReviewer: 'auto_review', approvalPolicy: 'on-request' });
    expect(calls.find(call => call.method === 'turn/start').params).toMatchObject({ input: [{ type: 'text', text: 'hello', text_elements: [] }, { type: 'localImage', path: '/tmp/image.png' }], approvalPolicy: 'on-request', approvalsReviewer: 'auto_review' });
    expect(lastInfo(events!)).toMatchObject({ info: { permissionMode: 'codex-auto-review', permissionSource: 'reported', model: 'gpt-6.1-sol' } });
    expect(events!.at(-1)).toEqual({ type: 'done', isError: false, nativeCompleted: true });
  });

  it.each([null, 'existing-thread'])('applies the named profile with every protected path denied and no legacy policy overrides (session %s)', async sessionId => {
    const configDir = join(directory, `private-${sessionId ?? 'new'}`);
    const configAlias = `${configDir}-alias`;
    await mkdir(configDir);
    await symlink(configDir, configAlias, 'dir');
    const server = await fake();
    vi.stubEnv('MGE_CONFIG_DIR', configAlias);
    try { expect((await collect(server.bin, turn({ sessionId }))).at(-1)).toMatchObject({ isError: false }); }
    finally { vi.unstubAllEnvs(); }
    const calls = await server.calls();
    const argv: string[] = calls[0].argv;
    expect(argv).toContain('default_permissions="motion_editor"');
    expect(argv).toContain('permissions.motion_editor.network.enabled=true');
    const filesystem = argv.find(arg => arg.startsWith('permissions.motion_editor.filesystem='))!;
    expect(filesystem).toContain('"/"="read"');
    expect(filesystem).toContain('":workspace_roots"="write"');
    // The shared temp folder is read-only (trusted caches live there); Codex writes its own TMPDIR.
    expect(filesystem).toContain(`${JSON.stringify(await realpath(tmpdir()))}="read"`);
    expect(filesystem).toContain(`${JSON.stringify(await realpath('/tmp'))}="read"`);
    expect(filesystem).toMatch(/mge-codex-tmp-\d+"="write"/);
    // The sandbox gets real paths (an alias's symlinked parent would stop bubblewrap).
    for (const path of new Set([await realpath(configAlias), join(directory, '.mge')])) {
      expect(filesystem).toContain(`${JSON.stringify(path)}="none"`);
    }
    // Other agents' config in the shared workspace is read-only to Codex.
    for (const name of ['.cursor', '.claude', '.mcp.json']) expect(filesystem).toMatch(new RegExp(`${name.replace('.', '\\.')}"="read"`));
    expect(argv.join(' ')).not.toMatch(/sandbox_mode|sandbox_workspace_write/);
    const thread = calls.find(call => call.method === (sessionId ? 'thread/resume' : 'thread/start')).params;
    expect(thread).not.toHaveProperty('sandbox');
    expect(thread).not.toHaveProperty('config');
    expect(calls.find(call => call.method === 'turn/start').params).not.toHaveProperty('sandboxPolicy');
  });

  it.each(['noProfile', 'badProfile'])('fails closed before turn/start when the editor profile is unconfirmed (%s)', async property => {
    const server = await fake({ [property]: true });
    expect((await collect(server.bin)).at(-1)).toMatchObject({ type: 'done', isError: true, error: "Codex could not apply the editor's permission profile (motion_editor). Update Codex CLI." });
    expect((await server.calls()).some(call => call.method === 'turn/start')).toBe(false);
  });

  it('resumes the same thread across models and explicitly applies this message manual mode', async () => {
    const server = await fake();
    const events = await collect(server.bin, turn({ sessionId: 'existing-thread', model: 'next-model', autoApply: false }));
    const calls = await server.calls();
    expect(calls.some(call => call.method === 'thread/start')).toBe(false);
    expect(calls.find(call => call.method === 'thread/resume').params).toMatchObject({ threadId: 'existing-thread', model: 'next-model', approvalPolicy: 'on-request', approvalsReviewer: 'user' });
    expect(calls.find(call => call.method === 'turn/start').params).toMatchObject({ threadId: 'existing-thread', approvalsReviewer: 'user', approvalPolicy: 'on-request' });
    expect(lastInfo(events)).toMatchObject({ info: { sessionId: 'existing-thread', model: 'next-model', permissionMode: 'codex-manual' } });
  });

  it('reports enabled skills and paginated thread runtime MCP data, separately from actual MCP use', async () => {
    const server = await fake();
    const events = await collect(server.bin);
    expect(lastInfo(events)).toMatchObject({ info: { tools: [], skillUsageReported: false, skills: ['enabled-skill'], mcpServers: [{ name: 'raw-name_with__bits', status: 'connected', tools: 1 }, { name: 'second-server', status: 'failed', tools: 0 }] } });
    const discovery = (await server.calls()).filter(call => call.method === 'mcpServerStatus/list');
    expect(discovery.map(call => call.params)).toEqual([{ threadId: 'thread-one', limit: 100, detail: 'toolsAndAuthOnly' }, { threadId: 'thread-one', cursor: 'page-two', limit: 100, detail: 'toolsAndAuthOnly' }]);
    expect(events.filter(event => event.type === 'tool' && event.mcpServer)).toEqual([{ type: 'tool', name: 'mcp__raw-name_with__bits__search__models', input: { category: 'test' }, mcpServer: 'raw-name_with__bits', mcpTool: 'search__models' }]);
  });

  it('preserves a runtime MCP catalog that arrives after a quick model turn and the former 3s deadline', async () => {
    const server = await fake({ mcpDelayMs: 3200 });
    const request = vi.spyOn(JsonRpcPeer.prototype, 'request');
    try {
      const events = await collect(server.bin);
      expect(lastInfo(events)).toMatchObject({ info: { mcpServers: [{ name: 'raw-name_with__bits', status: 'connected', tools: 1 }, { name: 'second-server', status: 'failed', tools: 0 }] } });
      expect(events.at(-1)).toEqual({ type: 'done', isError: false, nativeCompleted: true });
      const timeouts = request.mock.calls.filter(call => call[0] === 'mcpServerStatus/list').map(call => call[2]!);
      expect(timeouts).toHaveLength(2);
      expect(timeouts[0]).toBeGreaterThan(14000);
      expect(timeouts[0]).toBeLessThanOrEqual(15000);
      expect(timeouts[1]).toBeGreaterThan(3000);
      expect(timeouts[1]).toBeLessThan(timeouts[0]);
    } finally { request.mockRestore(); }
  }, 10000);

  it('keeps failed discoveries unknown and still completes the actual turn', async () => {
    const server = await fake({ discoveryFailure: true });
    const events = await collect(server.bin);
    expect(lastInfo(events)).toMatchObject({ info: { skillUsageReported: false } });
    if (lastInfo(events)?.type === 'session-info') {
      expect(lastInfo(events)!.info.skills).toBeUndefined();
      expect(lastInfo(events)!.info.mcpServers).toBeUndefined();
    }
    expect(events.at(-1)).toEqual({ type: 'done', isError: false, nativeCompleted: true });
  });

  it('keeps a known runtime state but omits an unavailable tool count', async () => {
    const server = await fake({ toolsError: true, skillErrors: true });
    const events = await collect(server.bin);
    const info = lastInfo(events);
    expect(info).toMatchObject({ info: { mcpServers: [{ name: 'raw-name_with__bits', status: 'connected' }, { name: 'second-server', status: 'failed' }] } });
    if (info?.type === 'session-info') { expect(info.info.mcpServers?.[0].tools).toBeUndefined(); expect(info.info.skills).toBeUndefined(); }
  });

  it('streams text with completed-item fallback, without duplicates or unrelated thread/turn content', async () => {
    const server = await fake();
    const events = await collect(server.bin);
    expect(events.filter(event => event.type === 'text').map(event => event.text).join('')).toBe('Hello world!\n\nDone.');
    expect(events.filter(event => event.type === 'tool')).toHaveLength(2);
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
  });

  it('buffers notifications preceding the turn/start response', async () => {
    const server = await fake({ earlyEvents: true });
    const events = await collect(server.bin);
    // The fake repeats deltas later, so only the completed-item suffix should deduplicate.
    expect(events.filter(event => event.type === 'text').map(event => event.text).join('')).toContain('Hello world!\n\nDone.');
    expect(events.at(-1)).toEqual({ type: 'done', isError: false, nativeCompleted: true });
  });

  it('forwards manual commands and file approvals; allows once without session grants', async () => {
    const server = await fake({ approvals: ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'] });
    const askPermission = vi.fn(async () => true);
    const events = await collect(server.bin, turn({ askPermission }));
    expect(askPermission).toHaveBeenCalledTimes(2);
    expect(await approvalReplies(server)).toEqual([{ id: 501, result: { decision: 'accept' } }, { id: 502, result: { decision: 'accept' } }]);
    expect(events.at(-1)).toEqual({ type: 'done', isError: false, nativeCompleted: true });
  });

  it('keeps reading native notifications while a manual approval is pending', async () => {
    const server = await fake({ approvals: ['item/commandExecution/requestApproval'], notifyWhileWaiting: true });
    let reply!: (value: boolean) => void;
    const events: AgentEvent[] = [];
    for await (const event of provider(server.bin).run(turn({ askPermission: () => new Promise<boolean>(resolve => { reply = resolve; }) }))) {
      events.push(event);
      if (event.type === 'text' && event.text.includes('Approval transport alive')) reply(true);
    }
    expect((await approvalReplies(server))[0].result).toEqual({ decision: 'accept' });
    expect(events.at(-1)).toEqual({ type: 'done', isError: false, nativeCompleted: true });
  });

  it('names native changed paths and grantRoot in file approval action and detail', async () => {
    const server = await fake({ approvals: ['item/fileChange/requestApproval'], filePaths: ['/outside/one.ts', '/outside/two.ts'], requestDetails: { grantRoot: '/outside' } });
    const askPermission = vi.fn(async () => true);
    await collect(server.bin, turn({ askPermission }));
    expect(askPermission).toHaveBeenCalledWith('Change files: /outside/one.ts, /outside/two.ts; requested write root: /outside', expect.stringContaining('"paths": ['));
    expect((await approvalReplies(server))[0].result).toEqual({ decision: 'accept' });
  });

  it('names both source and destination for native moved-file approval', async () => {
    const server = await fake({ approvals: ['item/fileChange/requestApproval'], nativeChanges: [{ path: '/outside/old.ts', kind: { type: 'update', move_path: '/outside/new.ts' }, diff: 'move' }] });
    const askPermission = vi.fn(async () => true);
    await collect(server.bin, turn({ askPermission }));
    expect(askPermission).toHaveBeenCalledWith('Change files: /outside/old.ts, /outside/new.ts', expect.stringContaining('/outside/new.ts'));
  });

  it('denies an unknown file-change item without an unnamed permission prompt', async () => {
    const server = await fake({ approvals: ['item/fileChange/requestApproval'], unknownFile: true });
    const askPermission = vi.fn(async () => true);
    await collect(server.bin, turn({ askPermission }));
    expect(askPermission).not.toHaveBeenCalled();
    expect((await approvalReplies(server))[0].result).toEqual({ decision: 'decline' });
  });

  it('states terminal input, network host and additional permission grants honestly', async () => {
    const server = await fake({ approvals: ['item/commandExecution/requestApproval'], requestDetails: { kind: 'writeStdin', networkApprovalContext: { host: 'example.test', protocol: 'https' }, additionalPermissions: { fileSystem: { write: ['/outside'] }, network: { enabled: true } } } });
    const askPermission = vi.fn(async () => true);
    await collect(server.bin, turn({ askPermission }));
    const [action, detail] = askPermission.mock.calls[0] as unknown as [string, string];
    expect(action).toContain('Send input to an existing terminal');
    expect(action).toContain('Allow network access to example.test (https)');
    expect(action).toContain('Grant additional permissions:');
    expect(action).toContain('/outside');
    expect(detail).toContain('"kind": "writeStdin"');
  });

  it.each(['missing', 'denied', 'throws', 'foreign'] as const)('fails closed on %s manual permission', async mode => {
    const server = await fake({ approvals: ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'], foreignApproval: mode === 'foreign' });
    const askPermission = mode === 'missing' ? undefined : vi.fn(async () => { if (mode === 'throws') throw new Error('UI missing'); return mode === 'foreign'; });
    await collect(server.bin, turn({ askPermission }));
    expect((await approvalReplies(server)).map(value => value.result)).toEqual([{ decision: 'decline' }, { decision: 'decline' }]);
    if (mode === 'foreign') expect(askPermission).not.toHaveBeenCalled();
  });

  it('does not grant acceptForSession when one-time acceptance is unavailable', async () => {
    const server = await fake({ approvals: ['item/commandExecution/requestApproval'], availableDecisions: ['acceptForSession', 'cancel'] });
    const askPermission = vi.fn(async () => true);
    await collect(server.bin, turn({ askPermission }));
    expect(askPermission).not.toHaveBeenCalled();
    expect((await approvalReplies(server))[0].result).toEqual({ decision: 'decline' });
  });

  it('times out a stalled permission prompt with denial while transport remains responsive', async () => {
    const server = await fake({ approvals: ['item/commandExecution/requestApproval'] });
    const timer = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: (...args: any[]) => void, delay?: number, ...args: any[]) => timer(callback, delay === 120000 ? 10 : delay, ...args)) as typeof setTimeout);
    try {
      await collect(server.bin, turn({ askPermission: () => new Promise(() => {}) }));
      expect((await approvalReplies(server))[0].result).toEqual({ decision: 'decline' });
    } finally { spy.mockRestore(); }
  });

  it('grants only requested permission categories, scoped to this turn', async () => {
    const server = await fake({ approvals: ['item/permissions/requestApproval'] });
    await collect(server.bin, turn({ askPermission: async () => true }));
    expect((await approvalReplies(server))[0].result).toEqual({ scope: 'turn', permissions: { network: { enabled: true }, fileSystem: { read: ['/tmp/read'], write: ['/tmp/write'] } } });
  });

  it('denies extra permissions without a callback and declines MCP elicitation', async () => {
    const server = await fake({ approvals: ['item/permissions/requestApproval', 'mcpServer/elicitation/request'] });
    await collect(server.bin);
    expect((await approvalReplies(server)).map(value => value.result)).toEqual([{ permissions: {}, scope: 'turn' }, { action: 'decline', content: null, _meta: null }]);
  });

  it('rejects unknown server requests with a protocol error rather than hanging', async () => {
    const server = await fake({ approvals: ['future/unknown'] });
    const events = await collect(server.bin);
    expect((await approvalReplies(server))[0].error).toBeDefined();
    expect(events.at(-1)).toEqual({ type: 'done', isError: false, nativeCompleted: true });
  });

  const nativeQuestion = (labels = ['Accept', 'Decline', 'Cancel']) => ({ id: 'connector-approval', header: 'App permission', question: 'Allow the connected app to perform this action?', isOther: false, isSecret: false, options: labels.map(label => ({ label, description: `${label} this action` })) });

  it.each(['Accept', 'Approve', 'Allow'])('forwards native connector approval with exact %s option to manual UI', async label => {
    const server = await fake({ approvals: ['item/tool/requestUserInput'], questions: [nativeQuestion([label, 'Decline', 'Cancel'])] });
    const askPermission = vi.fn(async () => true);
    const events = await collect(server.bin, turn({ askPermission }));
    expect(askPermission).toHaveBeenCalledWith(expect.stringContaining(`choose "${label}" once`), expect.stringContaining('Allow the connected app to perform this action?'));
    expect((await approvalReplies(server))[0].result).toEqual({ answers: { 'connector-approval': { answers: [label] } } });
    expect(events.at(-1)).toEqual({ type: 'done', isError: false, nativeCompleted: true });
  });

  it.each([true, false])('offers only one-time native Allow when session/always alternatives are present (allow=%s)', async allow => {
    const server = await fake({ approvals: ['item/tool/requestUserInput'], questions: [nativeQuestion(['Allow', 'Allow for this session', "Allow and don't ask me again", 'Cancel'])] });
    const askPermission = vi.fn(async () => allow);
    await collect(server.bin, turn({ askPermission }));
    expect(askPermission).toHaveBeenCalledWith(expect.stringContaining('choose "Allow" once'), expect.stringContaining('Allow for this session'));
    expect((await approvalReplies(server))[0].result).toEqual({ answers: { 'connector-approval': { answers: [allow ? 'Allow' : 'Cancel'] } } });
  });

  it.each(['missing', 'denied', 'foreign'] as const)('declines native connector approvals on %s permission', async mode => {
    const server = await fake({ approvals: ['item/tool/requestUserInput'], questions: [nativeQuestion()], foreignApproval: mode === 'foreign' });
    const askPermission = mode === 'missing' ? undefined : vi.fn(async () => mode === 'foreign');
    await collect(server.bin, turn({ askPermission }));
    expect((await approvalReplies(server))[0].result).toEqual({ answers: { 'connector-approval': { answers: ['Decline'] } } });
    if (mode === 'foreign') expect(askPermission).not.toHaveBeenCalled();
  });

  it('declines a connector approval that resolves after the native turn completed', async () => {
    const server = await fake({ approvals: ['item/tool/requestUserInput'], questions: [nativeQuestion()], completeDuringApproval: true, mcpDelayMs: 100 });
    const events = await collect(server.bin, turn({ askPermission: () => new Promise(resolve => setTimeout(() => resolve(true), 30)) }));
    expect((await approvalReplies(server))[0].result).toEqual({ answers: { 'connector-approval': { answers: ['Decline'] } } });
    expect(events.at(-1)).toEqual({ type: 'done', isError: false, nativeCompleted: true });
  });

  it.each([
    { questions: undefined },
    { questions: [{ ...nativeQuestion(), isSecret: true }] },
    { questions: [{ ...nativeQuestion(), isOther: true }] },
    { questions: [{ ...nativeQuestion(), options: null }] },
    { questions: [nativeQuestion(['Always allow', 'Decline'])] },
    { questions: [nativeQuestion(['Accept', 'Approve', 'Decline'])] },
    { questions: [nativeQuestion(['Red', 'Blue'])] },
  ])('skips unsupported structured input without guessing a general or secret answer', async ({ questions }) => {
    const server = await fake({ approvals: ['item/tool/requestUserInput'], questions });
    const askPermission = vi.fn(async () => true);
    const events = await collect(server.bin, turn({ askPermission }));
    expect(askPermission).not.toHaveBeenCalled();
    expect((await approvalReplies(server))[0].result).toEqual({ answers: {} });
    expect(events.filter(event => event.type === 'text').map(event => event.text).join('')).toContain('That prompt was skipped; send your answer in chat.');
    expect(events.at(-1)).toEqual({ type: 'done', isError: false, nativeCompleted: true });
  });

  it.each(['badPolicy', 'badReviewer', 'badSandbox', 'noNetwork', 'badThread', 'badTurn'] as const)('rejects %s instead of claiming the mode worked', async property => {
    const server = await fake({ [property]: true });
    const events = await collect(server.bin, turn({ autoApply: true }));
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: true });
    if (property !== 'badTurn') expect((await server.calls()).some(call => call.method === 'turn/start')).toBe(false);
  });

  it.each(['malformed', 'exit', 'failed'] as const)('reports %s native failures', async property => {
    const server = await fake({ [property]: true });
    const events = await collect(server.bin);
    expect(events.at(-1)).toMatchObject({ type: 'done', isError: true });
  });

  it('sends native turn/interrupt before shutting down the child on Stop', async () => {
    const server = await fake({ hang: true });
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const event of provider(server.bin).run(turn({ signal: controller.signal }))) {
      events.push(event);
      if (event.type === 'session-info' && event.info.skills) controller.abort();
    }
    await new Promise(resolve => setTimeout(resolve, 30));
    const calls = await server.calls();
    const interrupt = calls.findIndex(call => call.method === 'turn/interrupt');
    const terminated = calls.findIndex(call => call.terminated);
    expect(interrupt).toBeGreaterThan(-1);
    expect(calls[interrupt].params).toEqual({ threadId: 'thread-one', turnId: 'turn-one' });
    expect(terminated).toBeGreaterThan(interrupt);
    expect(events.at(-1)).toEqual({ type: 'done', isError: true, error: 'Stopped.' });
  });

  it('bounds native interruption grace when the server never acknowledges Stop', async () => {
    const server = await fake({ hang: true, ignoreInterrupt: true });
    const controller = new AbortController();
    const started = Date.now();
    const events: AgentEvent[] = [];
    for await (const event of provider(server.bin).run(turn({ signal: controller.signal }))) {
      events.push(event);
      if (event.type === 'session-info' && event.info.skills) controller.abort();
    }
    expect(Date.now() - started).toBeLessThan(4500);
    expect((await server.calls()).some(call => call.method === 'turn/interrupt')).toBe(true);
    expect(events.at(-1)).toEqual({ type: 'done', isError: true, error: 'Stopped.' });
  }, 10000);

  it('preserves native success when Stop only ends a metadata join after the model completed', async () => {
    const server = await fake({ mcpDelayMs: 200 });
    const controller = new AbortController();
    const events: AgentEvent[] = [];
    for await (const event of provider(server.bin).run(turn({ signal: controller.signal }))) {
      events.push(event);
      if (event.type === 'text' && event.text.includes('Done.')) setTimeout(() => controller.abort(), 30);
    }
    expect((await server.calls()).some(call => call.method === 'turn/interrupt')).toBe(false);
    expect(events.at(-1)).toEqual({ type: 'done', isError: false, nativeCompleted: true });
    expect(controller.signal.aborted).toBe(true);
  });

  it('cancels the native process and cannot accept a late approval callback', async () => {
    const server = await fake({ approvals: ['item/commandExecution/requestApproval'], hang: true });
    const controller = new AbortController();
    let allow: ((value: boolean) => void) | undefined;
    const events = await collect(server.bin, turn({ signal: controller.signal, askPermission: () => new Promise<boolean>(resolve => { allow = resolve; controller.abort(); }) }));
    allow?.(true);
    expect(events.at(-1)).toEqual({ type: 'done', isError: true, error: 'Stopped.' });
    expect((await approvalReplies(server)).every(reply => reply.result?.decision !== 'accept')).toBe(true);
    expect((await server.calls()).some(call => call.method === 'turn/interrupt')).toBe(true);
  });
});
