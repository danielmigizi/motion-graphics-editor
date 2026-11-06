// Codex runs through its native stdio App Server under the user's ChatGPT login.
// Approval requests stay native: auto-review when Auto-apply is on, and the
// editor's Allow/Deny prompt otherwise. A named permission profile keeps
// workspace writes and network access while denying the editor's protected paths.
// Session catalogs come from the active runtime; tool calls keep native MCP identity.

import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { ChatSessionInfo, ModelOption } from '../../src/core/api-contract';
import type { AgentEvent, AgentProvider, AgentTurn, ProviderStatus } from './types';
import { agentInstructions, childEnv, editorMcpServer, explainFailures, probe, agentDeniedPaths, providerInfo, type ProviderOptions } from './shared';

import { AsyncQueue, JsonRpcPeer } from './json-rpc';

export type CodexProviderOptions = ProviderOptions;

/** Model ids confirmed with a real `codex exec -m <id>` turn on a ChatGPT login. */
const CODEX_MODELS: ModelOption[] = [
  { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol' },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra' },
];

const env = () => childEnv(['OPENAI_API_KEY', 'CODEX_API_KEY']);

const EDITOR_SERVER = 'motion-editor';

const codexHome = () => process.env.CODEX_HOME ?? join(homedir(), '.codex');

/** A JSON value as TOML (strings, arrays, inline tables) for `-c key=value`. */
export function toToml(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(toToml).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}=${toToml(x)}`).join(',')}}`;
  return JSON.stringify(v);
}

/** The model in ~/.codex/config.toml, for the Default label. */
function configuredModel(): string | null {
  try {
    const toml = readFileSync(join(codexHome(), 'config.toml'), 'utf8');
    return /^model\s*=\s*"([^"]+)"/m.exec(toml)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * The `mcp_servers` override: the editor's server, enabled. Codex merges it
 * key by key into the configured servers, so the user's own servers stay as
 * configured.
 */
export function mcpServersOverride(editor: object): string {
  return `mcp_servers=${toToml({ [EDITOR_SERVER]: { ...editor, enabled: true } })}`;
}

/** turn.failed / error messages are often a JSON API error; show its message. */
function errorText(message: unknown): string {
  const s = String(message ?? 'Codex reported an error');
  try {
    const parsed = JSON.parse(s) as { error?: { message?: string } };
    return parsed.error?.message ?? s;
  } catch {
    return s;
  }
}

/**
 * Other agents' config in the shared workspace stays read-only to Codex: Cursor runs with
 * --trust and would start whatever MCP server .cursor/ names, outside any sandbox, and a
 * planted .git (hooks, core.fsmonitor) would run when Claude Code or Cursor calls git there.
 * Instruction files other agents read (AGENTS.md, CLAUDE.md, .cursorrules) are read-only too.
 */
export function agentConfigReadOnly(workspace: string): Record<string, 'read'> {
  return Object.fromEntries(['.cursor', '.claude', '.mcp.json', '.git', 'AGENTS.md', 'CLAUDE.md', '.cursorrules'].map((name) => [join(workspace, name), 'read' as const]));
}

/**
 * Only this turn's workspace is writable: the folder holding every project's workspace
 * and the other agents' run folders (OpenCode) are read-only, so a turn can't
 * plant files where another agent will run.
 */
/**
 * Codex's own temp folder (its TMPDIR). The shared temp folder is read-only to it:
 * trusted processes keep caches there (tsx compiles the editor's own server and MCP
 * code into /tmp/tsx-<uid>), and a planted entry would run outside the sandbox.
 */
/**
 * The sandbox masks paths with bind mounts, which can't go through a symlinked parent
 * (/var/run → /run): existing paths are given as their real path, once.
 */
export function sandboxPaths(paths: string[]): string[] {
  return [...new Set(paths.map(realPathOf))];
}

/** The real path, or for a path that doesn't exist yet, its nearest existing parent's real path plus the rest. */
function realPathOf(path: string): string {
  try { return realpathSync(path); } catch { /* not there yet */ }
  const parent = dirname(path);
  return parent === path ? path : join(realPathOf(parent), basename(path));
}

/** Every path key as its real path (later entries win, as in the profile); `:special` keys stay. */
export function realProfile(entries: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [path, mode] of Object.entries(entries)) {
    const key = path.startsWith(':') ? path : sandboxPaths([path])[0];
    delete out[key];
    out[key] = mode;
  }
  return out;
}

/** Create Codex's temp folder, or refuse one that isn't private to this user (another account could have made it). */
export function ensureCodexTmp(serverPort: number): string {
  const dir = codexTmp(serverPort);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid())) {
    throw new Error(`Codex's temp folder ${dir} isn't private to you. Remove it and try again.`);
  }
  if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700);
  return dir;
}

export function codexTmp(serverPort: number): string {
  return join(tmpdir(), `mge-codex-tmp-${serverPort}`);
}

export function otherAgentFolders(workspace: string, serverPort: number): Record<string, 'read' | 'write'> {
  const parent = dirname(workspace);
  // A workspace directly in a writable root (the temp folder, home) leaves that root as it is.
  const shared = [tmpdir(), '/tmp', '/', homedir()].includes(parent);
  return {
    ...(shared ? {} : { [parent]: 'read' as const }),
    [join(tmpdir(), `mge-opencode-${serverPort}`)]: 'read',
    [workspace]: 'write',
  };
}

export function createCodexProvider(opts: CodexProviderOptions): AgentProvider {
  const bin = opts.bin ?? process.env.MGE_CODEX_BIN ?? 'codex';
  const args = (turn: AgentTurn): string[] => [
    'app-server',
    '-c', 'default_permissions="motion_editor"',
    '-c', `permissions.motion_editor.filesystem=${toToml(realProfile({ '/': 'read', ':workspace_roots': 'write', [tmpdir()]: 'read', '/tmp': 'read', [codexTmp(opts.serverPort)]: 'write', ...otherAgentFolders(turn.workspace, opts.serverPort), ...agentConfigReadOnly(turn.workspace), ...Object.fromEntries(agentDeniedPaths(opts.rootDir).map(path => [path, 'none'])) }))}`,
    '-c', 'permissions.motion_editor.network.enabled=true',
    '-c', 'approval_policy="on-request"',
    '-c', `approvals_reviewer="${turn.autoApply === true ? 'auto_review' : 'user'}"`,
    '-c', 'web_search="live"',
    '-c', mcpServersOverride({ ...editorMcpServer(opts, 'Codex', turn.model), cwd: opts.rootDir, default_tools_approval_mode: 'approve' }),
  ];

  return {
    id: 'codex',
    label: 'Codex',
    resumesAcrossModels: true,

    async status(): Promise<ProviderStatus> {
      const configured = configuredModel();
      const models = [{ id: '', label: configured ? `Default (${configured})` : 'Default' }, ...CODEX_MODELS];
      const info = (state: Parameters<typeof providerInfo>[2], detail: string) => providerInfo('codex', 'Codex', state, detail, models);
      const [v, login] = await Promise.all([probe(bin, ['--version'], env()), probe(bin, ['login', 'status'], env())]);
      if (!v.ok) return v.missing ? info('not-installed', 'Codex CLI is not installed (the `codex` command was not found). Install it, run `codex login`, then check again.') : info('error', `Codex did not start: ${v.out.slice(0, 200)}`);
      if (!login.ok || !/logged in/i.test(login.out) || /not logged in/i.test(login.out)) return info('signed-out', `${v.out.split('\n')[0]} is installed but not signed in. Run \`codex login\` in a terminal, then check again.`);
      return info('ready', `${v.out.split('\n')[0]} · ${login.out.split('\n')[0]}`);
    },

    run(turn: AgentTurn): AsyncIterable<AgentEvent> {
      return explainFailures('codex', runTurn(turn));
    },
  };

  async function* runTurn(turn: AgentTurn): AsyncIterable<AgentEvent> {
    const queue = new AsyncQueue<AgentEvent>();
    const reviewer = turn.autoApply === true ? 'auto_review' : 'user';
    let threadId: string | null = null;
    let activeTurnId: string | null = null;
    let finished = false;
    let turnCompleted = false;
    let completedError: string | undefined;
    let nativeCompletedBeforeStop = false;
    let stopping = false;
    const connection = new AbortController();
    let resolveTurnEnded!: () => void;
    const turnEnded = new Promise<void>(resolve => { resolveTurnEnded = resolve; });
    let startingTurn = false;
    let pendingNotifications: { method: string; params: unknown }[] = [];
    let lastError: string | undefined;
    let sessionInfo: ChatSessionInfo | null = null;
    let catalogs: Promise<void> = Promise.resolve();
    let turnReady!: () => void;
    const turnInitialized = new Promise<void>(resolve => { turnReady = resolve; });
    const tools = new Set<string>();
    const fileChanges = new Map<string, string[]>();
    const messageText = new Map<string, string>();
    let previousMessage: string | null = null;
    let peer!: JsonRpcPeer;

    const complete = (error?: string) => {
      if (finished) return;
      finished = true;
      resolveTurnEnded();
      turnReady();
      const outcome = turnCompleted ? completedError : error;
      queue.push({ type: 'done', isError: !!outcome, ...(outcome ? { error: outcome } : {}), ...(nativeCompletedBeforeStop ? { nativeCompleted: true } : {}) });
      queue.end();
      peer?.close();
    };
    const isActive = (params: Record<string, unknown>, allowNoTurn = false) => !finished && !turnCompleted && !turn.signal.aborted &&
      params.threadId === threadId && !!threadId && (params.turnId === activeTurnId || (allowNoTurn && params.turnId === null));
    const publishInfo = () => { if (sessionInfo && !finished) queue.push({ type: 'session-info', info: { ...sessionInfo } }); };

    const emitItem = (value: unknown, completed: boolean) => {
      const item = object(value);
      if (!item || typeof item.id !== 'string') return;
      if (item.type === 'agentMessage') {
        if (completed && typeof item.text === 'string') {
          const streamed = messageText.get(item.id) ?? '';
          // A completed item is a fallback; append only an unstreamed suffix.
          if (!streamed || item.text.startsWith(streamed)) appendText(item.id, item.text.slice(streamed.length));
        }
        return;
      }
      if (item.type === 'fileChange') {
        fileChanges.delete(item.id);
        if (Array.isArray(item.changes) && item.changes.every((change: unknown) => typeof object(change)?.path === 'string' && object(change)!.path.length > 0)) {
          const paths = item.changes.flatMap((change: { path: string; kind?: unknown }) => {
            const destination = object(change.kind)?.move_path;
            return [change.path, ...(typeof destination === 'string' && destination ? [destination] : [])];
          });
          fileChanges.set(item.id, [...new Set<string>(paths)]);
        }
      }
      if (tools.has(item.id)) return;
      let event: AgentEvent | undefined;
      if (item.type === 'mcpToolCall' && typeof item.server === 'string' && typeof item.tool === 'string') {
        event = { type: 'tool', name: `mcp__${item.server}__${item.tool}`, input: item.arguments ?? {}, mcpServer: item.server, mcpTool: item.tool };
      } else if (item.type === 'commandExecution') {
        event = { type: 'tool', name: 'command_execution', input: { command: item.command, cwd: item.cwd } };
      } else if (item.type === 'fileChange') {
        event = { type: 'tool', name: 'file_change', input: { changes: item.changes } };
      } else if (item.type === 'webSearch') {
        event = { type: 'tool', name: 'web_search', input: { action: item.action } };
      } else if (item.type === 'dynamicToolCall' && typeof item.tool === 'string') {
        event = { type: 'tool', name: item.tool, input: item.arguments ?? {} };
      } else if (item.type === 'collabAgentToolCall' && typeof item.tool === 'string') {
        event = { type: 'tool', name: item.tool, input: { prompt: item.prompt, model: item.model } };
      }
      if (event) { tools.add(item.id); queue.push(event); }
    };
    const appendText = (id: string, text: string) => {
      if (!text) return;
      const separator = previousMessage && previousMessage !== id ? '\n\n' : '';
      previousMessage = id;
      messageText.set(id, (messageText.get(id) ?? '') + text);
      queue.push({ type: 'text', text: separator + text });
    };
    const notification = (method: string, value: unknown) => {
      const params = object(value);
      if (!params || finished) return;
      if (startingTurn && !activeTurnId && params.threadId === threadId) {
        if (pendingNotifications.length >= 1000) throw new Error('Codex sent too many notifications before starting the turn.');
        pendingNotifications.push({ method, params });
        return;
      }
      if (method === 'turn/completed') {
        const result = object(params.turn);
        if (turnCompleted || params.threadId !== threadId || !result || result.id !== activeTurnId) return;
        turnCompleted = true;
        resolveTurnEnded();
        if (Array.isArray(result.items)) result.items.forEach(item => emitItem(item, true));
        const status = result.status;
        const detail = object(result.error);
        const error = status === 'completed' ? undefined : errorText(detail?.message ?? lastError ?? `Codex turn ${String(status)}.`);
        completedError = turn.signal.aborted ? 'Stopped.' : error;
        nativeCompletedBeforeStop = status === 'completed' && !turn.signal.aborted;
        // Capture the model outcome before waiting for runtime catalog discovery.
        // Stop can end the metadata join without changing an already completed reply.
        if (stopping) complete(completedError);
        else void catalogs.finally(() => complete(completedError));
      } else if (!isActive(params)) {
        return;
      } else if (method === 'item/agentMessage/delta' && typeof params.itemId === 'string' && typeof params.delta === 'string') {
        appendText(params.itemId, params.delta);
      } else if (method === 'item/started' || method === 'item/completed') {
        emitItem(params.item, method === 'item/completed');
      } else if (method === 'error') {
        const error = object(params.error);
        lastError = errorText(error?.message);
      }
    };
    const permission = async (action: string, params: Record<string, unknown>): Promise<boolean> => {
      if (!isActive(params) || !turn.askPermission) return false;
      // A missing UI or stalled prompt cannot leave an approval open indefinitely.
      let timer: ReturnType<typeof setTimeout> | undefined;
      let abort: (() => void) | undefined;
      try {
        return await Promise.race([
          Promise.resolve().then(() => turn.askPermission!(action, JSON.stringify(params, null, 2))).then(value => value === true),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), 120000); }),
          turnEnded.then(() => false),
          new Promise<boolean>(resolve => { abort = () => resolve(false); turn.signal.addEventListener('abort', abort, { once: true }); }),
        ]) && isActive(params);
      } catch { return false; }
      finally {
        if (timer) clearTimeout(timer);
        if (abort) turn.signal.removeEventListener('abort', abort);
      }
    };
    const serverRequest = async (method: string, value: unknown): Promise<unknown> => {
      const params = object(value) ?? {};
      if (startingTurn && !activeTurnId && params.threadId === threadId) await turnInitialized;
      if (method === 'item/commandExecution/requestApproval') {
        const canAccept = !Array.isArray(params.availableDecisions) || params.availableDecisions.includes('accept');
        const knownKind = params.kind === undefined || params.kind === 'command' || params.kind === 'writeStdin';
        const allow = canAccept && knownKind && await permission(commandApprovalLabel(params), params);
        return { decision: allow ? 'accept' : 'decline' };
      }
      if (method === 'item/fileChange/requestApproval') {
        const paths = typeof params.itemId === 'string' ? fileChanges.get(params.itemId) : undefined;
        if (!paths?.length) return { decision: 'decline' };
        const grant = typeof params.grantRoot === 'string' && params.grantRoot ? `; requested write root: ${params.grantRoot}` : '';
        return { decision: await permission(`Change files: ${paths.join(', ')}${grant}`, { ...params, paths }) ? 'accept' : 'decline' };
      }
      if (method === 'item/permissions/requestApproval') {
        const allow = await permission('Grant the requested permissions for this turn', params);
        const requested = object(params.permissions) ?? {};
        // Copy only the explicitly requested categories, never grant a session or amend a policy.
        const permissions: Record<string, unknown> = {};
        if (allow) for (const key of ['network', 'fileSystem']) if (object(requested[key])) permissions[key] = requested[key];
        return { permissions, scope: 'turn' };
      }
      if (method === 'mcpServer/elicitation/request') return { action: 'decline', content: null, _meta: null };
      if (method === 'item/tool/requestUserInput') {
        const question = nativeApprovalQuestion(params.questions);
        if (question) {
          const allow = await permission(`Codex approval: ${question.question} (choose "${question.accept}" once)`, params);
          return { answers: { [question.id]: { answers: [allow ? question.accept : question.decline] } } };
        }
        if (isActive(params)) queue.push({ type: 'text', text: '\n\nCodex requested structured input this editor cannot collect. That prompt was skipped; send your answer in chat.\n\n' });
        return { answers: {} };
      }
      throw new Error(`Unsupported Codex server request: ${method}`);
    };

    const stop = () => {
      if (finished) return;
      if (turnCompleted) { complete(completedError); return; }
      if (stopping) return;
      stopping = true;
      void (async () => {
        const deadline = Date.now() + 3000;
        if (startingTurn && !activeTurnId) await boundedWait(turnInitialized, Math.max(1, deadline - Date.now()));
        if (!finished && !turnCompleted && threadId && activeTurnId) {
          // Let Codex persist its interruption marker and clean up exec sessions
          // before falling back to the transport's process shutdown.
          const interrupt = peer.request('turn/interrupt', { threadId, turnId: activeTurnId }, Math.max(1, deadline - Date.now())).catch(() => undefined);
          await boundedWait(Promise.all([interrupt, turnEnded]), Math.max(1, deadline - Date.now()));
        }
        complete('Stopped.');
      })();
    };

    try {
      const privateTmp = ensureCodexTmp(opts.serverPort);
      peer = new JsonRpcPeer(bin, args(turn), { cwd: turn.workspace, env: { ...env(), TMPDIR: privateTmp }, signal: connection.signal,
        onNotification: notification, onRequest: serverRequest,
        onClose: error => complete(turn.signal.aborted ? 'Stopped.' : error.message),
      });
      turn.signal.addEventListener('abort', stop, { once: true });
      if (turn.signal.aborted) stop();
      void (async () => {
        try {
          if (finished || stopping) return;
          await peer.request('initialize', { clientInfo: { name: 'motion_graphics_editor', title: 'Motion Graphics Editor', version: '0.1.0' }, capabilities: { experimentalApi: true, requestAttestation: false } }, 15000);
          peer.notify('initialized', {});
          const policy = { approvalPolicy: 'on-request', approvalsReviewer: reviewer };
          const started = object(await peer.request(turn.sessionId ? 'thread/resume' : 'thread/start', {
            ...(turn.sessionId ? { threadId: turn.sessionId, excludeTurns: true } : { developerInstructions: agentInstructions(opts.rootDir, { fullToolset: true }) }),
            ...policy, cwd: turn.workspace, ...(turn.model ? { model: turn.model } : {}),
          }, 30000));
          const thread = object(started?.thread);
          const sandbox = object(started?.sandbox);
          if (!started || !thread || typeof thread.id !== 'string' || typeof started.model !== 'string') throw new Error('Codex returned an invalid thread response. Update Codex CLI and retry.');
          if (started.approvalPolicy !== 'on-request' || started.approvalsReviewer !== reviewer || sandbox?.type !== 'workspaceWrite' || sandbox.networkAccess !== true) {
            throw new Error(`Codex could not use the requested permission mode (on-request / ${reviewer} / workspace-write with network). Update Codex CLI or check managed permission settings.`);
          }
          if (object(started.activePermissionProfile)?.id !== 'motion_editor') {
            throw new Error("Codex could not apply the editor's permission profile (motion_editor). Update Codex CLI.");
          }
          if (turn.signal.aborted || finished) return;
          threadId = thread.id;
          queue.push({ type: 'session', sessionId: thread.id });
          sessionInfo = { sessionId: thread.id, model: started.model, permissionMode: reviewer === 'auto_review' ? 'codex-auto-review' : 'codex-manual', permissionSource: 'reported', skillUsageReported: false, tools: [] };
          publishInfo();
          startingTurn = true;
          const response = object(await peer.request('turn/start', {
            threadId, input: [{ type: 'text', text: turn.prompt, text_elements: [] }, ...turn.images.map(path => ({ type: 'localImage', path }))],
            ...policy, cwd: turn.workspace, ...(turn.model ? { model: turn.model } : {}),
          }, 30000));
          const result = object(response?.turn);
          if (!result || typeof result.id !== 'string') throw new Error('Codex returned an invalid turn response.');
          activeTurnId = result.id;
          startingTurn = false;
          turnReady();
          catalogs = discover(peer, threadId, turn.workspace, info => {
            if (sessionInfo) { sessionInfo = { ...sessionInfo, ...info }; publishInfo(); }
          });
          const buffered = pendingNotifications;
          pendingNotifications = [];
          buffered.forEach(event => notification(event.method, event.params));
          if (result.status === 'completed' || result.status === 'failed' || result.status === 'interrupted') notification('turn/completed', { threadId, turn: result });
        } catch (error) { complete(turn.signal.aborted ? 'Stopped.' : (error instanceof Error ? error.message : String(error))); }
      })();
      yield* queue;
    } finally { finished = true; resolveTurnEnded(); turn.signal.removeEventListener('abort', stop); peer?.close(); }
  }
}

/** Minimal runtime checks keep malformed or older app-server data from becoming a claimed catalog. */
function object(value: unknown): Record<string, any> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null;
}

function commandApprovalLabel(params: Record<string, unknown>): string {
  const actions = [params.kind === 'writeStdin' ? 'Send input to an existing terminal' : 'Run a terminal command'];
  if (typeof params.command === 'string' && params.command) actions[0] += `: ${params.command}`;
  const network = object(params.networkApprovalContext);
  if (network) actions.push(`Allow network access to ${typeof network.host === 'string' ? network.host : 'the requested host'}${typeof network.protocol === 'string' ? ` (${network.protocol})` : ''}`);
  if (object(params.additionalPermissions)) actions.push(`Grant additional permissions: ${JSON.stringify(params.additionalPermissions)}`);
  return actions.join('\n');
}

async function boundedWait(value: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await Promise.race([value, new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); })]); }
  finally { if (timer) clearTimeout(timer); }
}

/** Connector approvals use these exact native option labels, never persistent grants. */
function nativeApprovalQuestion(value: unknown): { id: string; question: string; accept: string; decline: string } | null {
  if (!Array.isArray(value) || value.length !== 1) return null;
  const question = object(value[0]);
  if (!question || typeof question.id !== 'string' || !question.id || typeof question.question !== 'string' || !question.question || question.isSecret !== false || question.isOther !== false || !Array.isArray(question.options)) return null;
  const labels = question.options.map((option: unknown) => object(option)?.label);
  const oneTimeOrDenial = /^(Accept|Approve|Allow|Decline|Deny|Reject|Cancel)$/i;
  const persistent = /^(?:(?:Accept|Approve|Allow) for this session|(?:Accept|Approve|Allow) and don't ask me again|Always (?:accept|approve|allow))$/i;
  if (labels.some((label: unknown) => typeof label !== 'string' || (!oneTimeOrDenial.test(label) && !persistent.test(label)))) return null;
  const accept = labels.filter((label: string) => /^(Accept|Approve|Allow)$/i.test(label));
  const decline = labels.filter((label: string) => /^(Decline|Deny|Reject)$/i.test(label));
  const cancel = labels.find((label: string) => /^Cancel$/i.test(label));
  if (accept.length !== 1 || (!decline.length && !cancel)) return null;
  return { id: question.id, question: question.question, accept: accept[0], decline: decline[0] ?? cancel };
}

async function discover(peer: JsonRpcPeer, threadId: string, cwd: string, publish: (info: Partial<ChatSessionInfo>) => void): Promise<void> {
  await Promise.allSettled([
    (async () => {
      const response = object(await peer.request('skills/list', { cwds: [cwd] }, 3000));
      if (!Array.isArray(response?.data)) return;
      const entry = response.data.find((value: unknown) => {
        const path = object(value)?.cwd;
        if (typeof path !== 'string') return false;
        try { return realpathSync(path) === realpathSync(cwd); } catch { return path === cwd; }
      });
      if (!entry || !Array.isArray(entry.skills) || !Array.isArray(entry.errors) || entry.errors.length) return;
      if (entry.skills.some((skill: unknown) => !object(skill) || typeof object(skill)?.name !== 'string' || typeof object(skill)?.enabled !== 'boolean')) return;
      publish({ skills: [...new Set<string>(entry.skills.filter((skill: any) => skill.enabled).map((skill: any) => skill.name))] });
    })(),
    (async () => {
      const servers: NonNullable<ChatSessionInfo['mcpServers']> = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      // Runtime MCP startup can outlast a short text turn. Fetch only tools/auth,
      // avoiding resource-list calls, with one bounded deadline across all pages.
      const deadline = Date.now() + 15000;
      do {
        const response = object(await peer.request('mcpServerStatus/list', { threadId, ...(cursor ? { cursor } : {}), limit: 100, detail: 'toolsAndAuthOnly' }, Math.max(1, deadline - Date.now())));
        if (!Array.isArray(response?.data) || (response.nextCursor !== null && typeof response.nextCursor !== 'string')) return;
        for (const value of response.data) {
          const server = object(value);
          if (!server || typeof server.name !== 'string' || (server.runtimeStatus !== null && typeof server.runtimeStatus !== 'string') || !object(server.tools)) return;
          servers.push({ name: server.name, status: server.runtimeStatus ?? 'unknown', ...(!server.toolsError ? { tools: Object.keys(server.tools).length } : {}) });
        }
        cursor = response.nextCursor ?? undefined;
        if (cursor && (cursors.has(cursor) || Date.now() >= deadline)) return;
        if (cursor) cursors.add(cursor);
      } while (cursor);
      publish({ mcpServers: servers });
    })(),
  ]);
}
