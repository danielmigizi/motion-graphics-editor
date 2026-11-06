// Shared by every agent provider: the chat instructions (one text for all
// CLIs), the motion-editor MCP server they connect to, a child environment
// without API keys, running a CLI that prints one JSON event per line, and
// turning a failed turn's error text into a plain reason with what to do.

import { execFile, spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentProviderId, ProviderInfo, ProviderState } from '../../src/core/api-contract';
import type { AgentEvent, FailureKind } from './types';
import { configDir } from '../generation/config';

/** Credentials/settings and the dev log's editor login link, including existing symlink targets. */
export function protectedPaths(rootDir: string, env = process.env): string[] {
  const paths = new Set<string>();
  for (const path of [resolve(configDir(env)), resolve(join(rootDir, '.mge')), ...(env.MGE_EDITOR_LINK_FILE ? [resolve(env.MGE_EDITOR_LINK_FILE)] : [])]) {
    paths.add(path);
    try { paths.add(realpathSync(path)); } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return [...paths];
}

/**
 * Browser profiles hold the editor's session cookie and tab storage (and every
 * other site's logins), and their caches. Only the ones present on this machine, so the rules stay short;
 * the `~/.config` ones follow XDG_CONFIG_HOME.
 */
const CONFIG_PROFILES = ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'google-chrome-canary', 'chromium', 'BraveSoftware', 'microsoft-edge', 'microsoft-edge-beta', 'microsoft-edge-dev', 'vivaldi', 'opera', 'mozilla'];
const HOME_PROFILES = [
  '.mozilla', 'snap/firefox', 'snap/chromium', 'snap/brave', '.var/app/org.mozilla.firefox', '.var/app/com.google.Chrome', '.var/app/org.chromium.Chromium', '.var/app/com.brave.Browser', '.var/app/com.microsoft.Edge',
  '.var/app/com.vivaldi.Vivaldi', '.var/app/com.opera.Opera',
  'Library/Application Support/Google/Chrome', 'Library/Application Support/Google/Chrome Beta', 'Library/Application Support/Google/Chrome Dev', 'Library/Application Support/Google/Chrome Canary',
  'Library/Application Support/Microsoft Edge Beta', 'Library/Application Support/Microsoft Edge Dev', 'Library/Application Support/Chromium', 'Library/Application Support/Firefox', 'Library/Application Support/BraveSoftware',
  'Library/Application Support/Microsoft Edge', 'Library/Application Support/Vivaldi', 'Library/Application Support/com.operasoftware.Opera', 'Library/Application Support/Arc',
  'Library/Safari', 'Library/Cookies', 'Library/Containers/com.apple.Safari',
  'Library/Caches/Google/Chrome', 'Library/Caches/Google/Chrome Beta', 'Library/Caches/Google/Chrome Dev', 'Library/Caches/Google/Chrome Canary', 'Library/Caches/Chromium', 'Library/Caches/Firefox', 'Library/Caches/BraveSoftware', 'Library/Caches/Microsoft Edge', 'Library/Caches/com.apple.Safari',
];
/** Browser HTTP caches can hold responses, `~/.cache` ones follow XDG_CACHE_HOME. */
const CACHE_PROFILES = ['google-chrome', 'google-chrome-beta', 'google-chrome-unstable', 'google-chrome-canary', 'chromium', 'mozilla', 'BraveSoftware', 'microsoft-edge', 'microsoft-edge-beta', 'microsoft-edge-dev', 'vivaldi', 'opera'];

export function browserProfilePaths(env = process.env): string[] {
  const home = env.HOME || homedir();
  const config = env.XDG_CONFIG_HOME || join(home, '.config');
  const cache = env.XDG_CACHE_HOME || join(home, '.cache');
  const paths = new Set<string>();
  for (const p of [...HOME_PROFILES.map((d) => join(home, d)), ...CONFIG_PROFILES.map((d) => join(config, d)), ...CACHE_PROFILES.map((d) => join(cache, d))]) {
    if (!existsSync(p)) continue;
    paths.add(p);
    try { paths.add(realpathSync(p)); } catch { /* listed already */ }
  }
  return [...paths];
}

/**
 * The session D-Bus socket: through it Secret Service (the Linux keyring that
 * holds the fal key when there is one) answers any same-user process while the
 * keyring is unlocked. Codex's sandbox otherwise reaches it. Abstract-namespace
 * buses have no path and can't be denied this way (SECURITY.md).
 */
export function sessionBusPaths(env = process.env): string[] {
  const fromAddress = /(?:^|;)unix:path=([^,;]+)/.exec(env.DBUS_SESSION_BUS_ADDRESS ?? '')?.[1];
  const candidates = [fromAddress, env.XDG_RUNTIME_DIR ? join(env.XDG_RUNTIME_DIR, 'bus') : undefined];
  return [...new Set(candidates.filter((p): p is string => !!p && existsSync(p)))];
}

/** Every path an editor-launched agent is denied: the editor's private paths, browser profiles and the session bus. */
export function agentDeniedPaths(rootDir: string, env = process.env): string[] {
  return [...new Set([...protectedPaths(rootDir, env), ...browserProfilePaths(env), ...sessionBusPaths(env), ...desktopSocketPaths(env)])];
}

/** Filesystem endpoints that can drive the user's desktop or terminals. */
export function desktopSocketPaths(env = process.env): string[] {
  const home = env.HOME || homedir();
  const candidates = ['/tmp/.X11-unix', env.XAUTHORITY || join(home, '.Xauthority'),
    `/tmp/tmux-${process.getuid?.() ?? 0}`, '/run/screen', '/var/run/screen', join(home, '.screen')];
  // The tmux server this editor runs under, a custom tmux socket folder, and screen's.
  const tmuxSocket = env.TMUX?.split(',')[0];
  // Its folder too when it is tmux's own per-user folder; a custom socket (-S /tmp/x) denies just itself.
  if (tmuxSocket) candidates.push(tmuxSocket, ...(/^tmux-\d+$/.test(basename(dirname(tmuxSocket))) ? [dirname(tmuxSocket)] : []));
  if (env.TMUX_TMPDIR) candidates.push(join(env.TMUX_TMPDIR, `tmux-${process.getuid?.() ?? 0}`));
  if (env.SCREENDIR) candidates.push(env.SCREENDIR);
  if (env.XDG_RUNTIME_DIR) {
    try {
      candidates.push(...readdirSync(env.XDG_RUNTIME_DIR).filter(name => /^(wayland-|tmux-|at-spi$)/.test(name)).map(name => join(env.XDG_RUNTIME_DIR!, name)));
    } catch { /* No runtime directory on this platform. */ }
  }
  const paths = new Set<string>();
  for (const path of candidates) {
    if (!existsSync(path)) continue;
    paths.add(resolve(path));
    try { paths.add(realpathSync(path)); } catch { /* Listed already. */ }
  }
  return [...paths];
}

/** Cover the path itself and descendants, including symlink targets with arbitrary names. */
export function protectedPathPatterns(paths: string[]): string[] {
  return paths.flatMap(path => [path, `${path === '/' ? '' : path}/**`]);
}

export interface ProviderOptions {
  rootDir: string;
  /** The editor server's port (the MCP server talks to it). */
  serverPort: number;
  webPort: number;
  /** Executable; default the CLI's name on PATH (or its MGE_*_BIN env override). */
  bin?: string;
}

export const CHAT_PROMPT = `
You are working inside the motion graphics editor's own chat panel. The user
reads your replies in a narrow side panel next to the live preview, so:
- Keep replies short: a sentence or two about what you changed, then stop.
- Edits normally become proposals the user reviews; Auto-apply applies them immediately only when enabled.
- When the tool says proposed, say "I've proposed …, review it in the editor" rather than "I changed …".
- Don't stack edits on an unapplied proposal unless asked: a newer proposal replaces your pending one.
- Never paste JSON, ids or code into replies; describe changes in plain words.
- Act directly on requests; ask a question only when the request is genuinely ambiguous.
- Messages may include an [Editor context] line (what the user is pointing at)
  and [Attachments] (files the user dropped in, already uploaded, with a ready
  asset object). Look at image attachments before using them (open the file
  at the path given, or the image attached to the message).
- A message may start with [Earlier in this conversation]: the recent chat
  before you joined it (another agent may have answered). Carry on from there.
- Change the video only through the motion-editor tools (editor_*), never by
  editing project files.
`;

/** For agents that run with their full toolset. */
const FULL_TOOLSET_PROMPT = `
- You run in this project's own workspace folder (your working directory). You
  have your full toolset there: web search and fetch, the shell, file edits,
  skills, plugins, subagents and the user's MCP servers. Some actions may ask
  the user in the editor first; if one is declined, don't retry it another way.
- To use a file you downloaded or made, import it with editor_import_asset
  { path } (or { url } for an https link) and place it.
- Keep downloads, scripts and research in the workspace folder, not in the
  editor's own folders.
`;

/** For agents still limited to the editor's tools. */
const EDITOR_ONLY_PROMPT = `
- You cannot run commands or edit files here.
`;

/** The motion-video skill body (frontmatter stripped), so every agent follows the same workflow. */
export function skillText(rootDir: string): string {
  try {
    return readFileSync(join(rootDir, '.claude', 'skills', 'motion-video', 'SKILL.md'), 'utf8').replace(/^---[\s\S]*?---\s*/, '');
  } catch {
    return '';
  }
}

/** Everything an agent should know before its first turn. */
export function agentInstructions(rootDir: string, opts: { fullToolset?: boolean } = {}): string {
  return `${CHAT_PROMPT}${opts.fullToolset ? FULL_TOOLSET_PROMPT : EDITOR_ONLY_PROMPT}\n${skillText(rootDir)}`;
}

/**
 * The motion-editor MCP server (mcp/server.ts, run from rootDir), pointed at
 * this editor's ports. `agentLabel` names the agent in the editor's toasts and
 * Activity feed for every change it makes.
 */
/**
 * tsx arguments for the editor's MCP server. Agents start it in their workspace, which
 * another agent can write: so the repo's own tsconfig (never one found in the workspace)
 * and no shared compile cache.
 */
export function editorMcpArgs(rootDir: string): string[] {
  return [join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'), '--tsconfig', join(rootDir, 'tsconfig.json'), '--no-cache', join(rootDir, 'mcp', 'server.ts')];
}

export function editorMcpServer(opts: ProviderOptions, agentLabel: string, model?: string) {
  return {
    // Absolute node + tsx: agents run in the project's workspace folder, not the repo.
    command: process.execPath,
    args: editorMcpArgs(opts.rootDir),
    // TMPDIR: the server's own, not an agent's (Codex's private temp folder is writable by Codex; a dev server the MCP
    // starts would keep its tsx cache there).
    env: { MGE_OPEN_BROWSER: '0', MGE_SERVER_PORT: String(opts.serverPort), MGE_WEB_PORT: String(opts.webPort), MGE_AGENT_LABEL: agentLabel, TMPDIR: tmpdir(), ...(model ? { MGE_AGENT_MODEL: model } : {}),
      ...Object.fromEntries(['MGE_CONFIG_DIR', 'XDG_CONFIG_HOME', 'MGE_EDITOR_LINK_FILE'].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]])) },
  };
}

/** Child environment without provider-specific keys, fal credentials, or the script-only editor link. */
export function childEnv(strip: string[], extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, ...extra };
  for (const k of [...strip, 'FAL_KEY', 'FAL_KEY_ID', 'FAL_KEY_SECRET', 'MGE_EDITOR_LINK']) delete env[k];
  return env;
}

/** Runs a short status command (version, login check); never rejects. `out` is stdout and stderr together. */
export function probe(bin: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 10000, cwd?: string): Promise<{ ok: boolean; missing: boolean; out: string; stdout: string }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: timeoutMs, env, cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      const missing = (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';
      resolve({ ok: !err, missing, out: `${stdout}\n${stderr}`.trim(), stdout: String(stdout) });
    });
  });
}

/** Caches an async value for `ttlMs`; concurrent callers share one load. `invalidate()` makes the next call load again. */
export function cached<T>(ttlMs: number, load: () => Promise<T>): (() => Promise<T>) & { invalidate(): void } {
  let value: Promise<T> | null = null;
  let at = 0;
  const get = () => {
    if (!value || Date.now() - at > ttlMs) {
      at = Date.now();
      const v = load();
      value = v;
      v.catch(() => {
        if (value === v) value = null;
      });
    }
    return value;
  };
  return Object.assign(get, {
    invalidate() {
      value = null;
    },
  });
}

/** The last non-empty stderr lines, clipped, for error messages. */
export function stderrTail(stderr: string, lines = 2, max = 300): string {
  const t = stderr.split('\n').map((l) => l.trim()).filter(Boolean).slice(-lines).join(' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * Runs one CLI turn. `parse` maps each JSON line to agent events and reports
 * when the CLI finished the turn itself; if it exits without finishing, the
 * turn ends with an error built from its stderr. Killed on abort; never
 * started when the turn was already stopped.
 */
export async function* runJsonLines(
  label: string,
  bin: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal: AbortSignal;
    loginHint: string;
    /**
     * For CLIs whose last event does not say the turn is over (OpenCode just
     * exits): the turn's end when the CLI exits without `finished`. Returning
     * null keeps the default error.
     */
    onExit?: (code: number | null, stderr: string) => AgentEvent | null;
  },
  parse: (line: any) => { events: AgentEvent[]; finished?: boolean },
): AsyncIterable<AgentEvent> {
  if (opts.signal.aborted) {
    yield { type: 'done', isError: true, error: 'Stopped.' };
    return;
  }
  const child = spawn(bin, args, { cwd: opts.cwd, env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] });
  const onAbort = () => child.kill('SIGTERM');
  opts.signal.addEventListener('abort', onAbort);
  let stderr = '';
  // Generous: an error can be one long line (Cursor lists every model), and its start matters.
  child.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-65536)));
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  const spawnError = new Promise<Error>((resolve) => child.on('error', resolve));

  let finished = false;
  try {
    for await (const line of createInterface({ input: child.stdout })) {
      let e: unknown;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      const r = parse(e);
      if (r.finished) finished = true;
      yield* r.events;
    }
    const code = await Promise.race([exited, spawnError]);
    if (opts.signal.aborted) {
      if (!finished) yield { type: 'done', isError: true, error: 'Stopped.' };
    } else if (code instanceof Error) {
      yield { type: 'done', isError: true, error: `Could not start ${label}: ${code.message}` };
    } else if (!finished) {
      const end = opts.onExit?.(code, stderr);
      const hint = /log ?in|auth|credential|sign in/i.test(stderr) ? ` ${opts.loginHint}` : '';
      yield end ?? { type: 'done', isError: true, error: `${label} exited (${code}) without finishing.${hint} ${stderrTail(stderr)}`.trim() };
    }
  } finally {
    opts.signal.removeEventListener('abort', onAbort);
    if (child.exitCode === null) child.kill('SIGTERM');
  }
}

// ---------------------------------------------------------------------------
// Signing in, and why a turn failed
// ---------------------------------------------------------------------------

/**
 * How each agent's user signs in, in their own terminal. The editor only
 * shows the command: the CLI keeps its own tokens and the editor never reads,
 * copies or relays them.
 */
export const SIGN_IN: Record<AgentProviderId, { command: string; docsUrl: string }> = {
  claude: { command: 'claude auth login', docsUrl: 'https://code.claude.com/docs/en/setup' },
  codex: { command: 'codex login', docsUrl: 'https://developers.openai.com/codex/cli' },
  cursor: { command: 'cursor-agent login', docsUrl: 'https://cursor.com/docs/cli/overview' },
  opencode: { command: 'opencode auth login', docsUrl: 'https://opencode.ai/docs/cli/' },
};

/** A provider's status: `available` follows `state`. */
export function providerInfo(id: AgentProviderId, label: string, state: ProviderState, detail: string, models: ProviderInfo['models']): ProviderInfo {
  return { id, label, available: state === 'ready', state, detail, signIn: SIGN_IN[id], models };
}

type KnownFailure = Exclude<FailureKind, 'unknown'>;

/**
 * Error text each CLI prints (stderr, or its error event) per failure kind,
 * checked in this order: the first kind with a matching pattern wins. Common
 * patterns apply to every agent; the per-agent rows are phrases that agent
 * is known to print (and that the common rows would miss or misfile).
 */
export const FAILURE_PATTERNS: { kind: KnownFailure; common: RegExp[]; perProvider: Partial<Record<AgentProviderId, RegExp[]>> }[] = [
  {
    kind: 'login-expired',
    common: [
      /not (logged|signed) in/i,
      /not authenticated/i,
      /authentication (required|failed)/i,
      /\bunauthori[sz]ed\b/i,
      /\b401\b/,
      /invalid (api[ -]?key|x-api-key|credentials)/i,
      /(api key|credentials?) (is |are )?(missing|not found|expired|invalid)/i,
      /no api key/i,
      /(access|oauth|auth|session) token (has )?(expired|was revoked|has been revoked|is invalid)/i,
      /token_expired|token_revoked|invalid_grant/i,
      /(log|sign) ?in again/i,
      /please (run )?\/?login/i,
      /re-?authenticate/i,
    ],
    perProvider: {
      claude: [/please run \/login/i, /oauth token (has expired|revoked)/i],
      codex: [/refresh token was already used/i, /access token could not be refreshed/i, /provided authentication token is expired/i],
      cursor: [/run '?(cursor-)?agent login'?/i],
      opencode: [/ProviderAuthError/, /run `?opencode auth login/i],
    },
  },
  {
    kind: 'account-changed',
    common: [/different account/i, /account (has )?changed/i, /no conversation found with session id/i, /\b(conversation|thread|session) (\S+ )?not found/i, /does not belong to (this|the current) (account|user|organization)/i],
    perProvider: {
      claude: [/organization (has been )?disabled/i],
      codex: [/no rollout found/i],
    },
  },
  {
    kind: 'plan-limit',
    common: [
      /usage limit/i,
      /(5-hour|weekly|monthly|daily|session|plan) limit/i,
      /hit your (usage )?limit/i,
      /\bquota\b|insufficient_quota/i,
      /credit balance/i,
      /(out of|insufficient|no remaining) (credits?|funds|balance)/i,
      /payment required|\b402\b|billing/i,
      /upgrade (your plan|to (pro|plus|max|team))/i,
      /subscription (has )?(expired|ended|is inactive|required)/i,
      /spend(ing)? limit/i,
    ],
    perProvider: {
      claude: [/claude ai usage limit reached/i],
      cursor: [/you've hit your (usage )?limit/i],
    },
  },
  {
    kind: 'rate-limited',
    common: [/rate.?limit/i, /too many requests/i, /\b429\b/, /overloaded/i, /\b529\b/, /resource.?exhausted/i, /slow down/i],
    perProvider: {},
  },
  {
    kind: 'network',
    common: [
      /ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH/,
      /socket hang up/i,
      /fetch failed/i,
      /network (error|is unreachable)/i,
      /getaddrinfo/i,
      /could not resolve host/i,
      /stream disconnected/i,
      /(unable|failed) to connect/i,
      /connection (reset|refused|timed out)/i,
    ],
    perProvider: {
      codex: [/error sending request/i],
    },
  },
];

const LABELS: Record<AgentProviderId, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor Agent', opencode: 'OpenCode' };

/** "Try again in 2 hours" / "resets 3pm" from a limit message, as a sentence. */
function resetPhrase(text: string): string {
  const m = /\b(try again (in|at|after) [^.|\n]{1,60}|resets? (in|at)? ?[^.|\n]{1,40}|available again [^.|\n]{1,40})/i.exec(text);
  if (!m) return '';
  const p = m[1].trim().replace(/[\s,;:]+$/, '');
  return `${p[0].toUpperCase()}${p.slice(1)}. `;
}

/**
 * What a failed turn's error text means, in the user's words: `message` says
 * what happened, `hint` what to do (with the sign-in command for login
 * problems). Unrecognised text is passed on as the message, without a hint.
 */
export function classifyAgentFailure(text: string, provider: AgentProviderId): { kind: FailureKind; message: string; hint: string } {
  const label = LABELS[provider] ?? provider;
  const signIn = SIGN_IN[provider]?.command ?? 'its login command';
  const kind = FAILURE_PATTERNS.find((row) => [...(row.perProvider[provider] ?? []), ...row.common].some((re) => re.test(text)))?.kind ?? 'unknown';
  switch (kind) {
    case 'login-expired':
      return { kind, message: `${label} is signed out.`, hint: `Run \`${signIn}\` in a terminal, then send again.` };
    case 'account-changed':
      return { kind, message: `${label} can't continue this conversation's session (it is gone, or belongs to another account).`, hint: `Press New chat to start a fresh session, or run \`${signIn}\` to sign in to the earlier account.` };
    case 'plan-limit':
      return { kind, message: `${label} has reached your plan's usage limit.`, hint: `${resetPhrase(text)}Wait for it to reset or pick another agent, then send again.` };
    case 'rate-limited':
      return { kind, message: `${label} is being rate limited.`, hint: `${resetPhrase(text)}Wait a minute, then send again.` };
    case 'network':
      return { kind, message: `${label} could not reach its servers.`, hint: 'Check your internet connection, then send again.' };
    default:
      return { kind: 'unknown', message: text, hint: '' };
  }
}

/** A turn's events with any failure explained (classifyAgentFailure); a stopped turn stays "Stopped.". */
export async function* explainFailures(provider: AgentProviderId, events: AsyncIterable<AgentEvent>): AsyncIterable<AgentEvent> {
  for await (const e of events) {
    if (e.type === 'done' && e.isError && e.error && e.error !== 'Stopped.') {
      const f = classifyAgentFailure(e.error, provider);
      yield { type: 'done', isError: true, error: f.hint ? `${f.message} ${f.hint}` : f.message, failure: f.kind };
    } else {
      yield e;
    }
  }
}
