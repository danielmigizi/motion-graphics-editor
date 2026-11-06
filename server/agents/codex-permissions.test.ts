// Exercise the permission handshake without an executable or model connection.
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { codexTmp as codexTmpPath, createCodexProvider, ensureCodexTmp, otherAgentFolders, realProfile, sandboxPaths } from './codex';
import type { AgentEvent } from './types';

const runtime = vi.hoisted(() => ({
  argv: [] as string[],
  requests: [] as { method: string; params: Record<string, unknown> }[],
  profile: { id: 'motion_editor' } as { id: string } | null,
}));
vi.mock('./json-rpc', async importOriginal => {
  const actual = await importOriginal<typeof import('./json-rpc')>();
  return { ...actual, JsonRpcPeer: class {
    constructor(_bin: string, argv: string[]) { runtime.argv = argv; }
    async request(method: string, params: Record<string, unknown>) {
      runtime.requests.push({ method, params });
      if (method === 'thread/start' || method === 'thread/resume') return {
        thread: { id: 'thread-one' }, model: 'test', approvalPolicy: params.approvalPolicy,
        approvalsReviewer: params.approvalsReviewer, sandbox: { type: 'workspaceWrite', networkAccess: true },
        ...(runtime.profile ? { activePermissionProfile: runtime.profile } : {}),
      };
      if (method === 'turn/start') return { turn: { id: 'turn-one', status: 'completed', items: [] } };
      return { data: [] };
    }
    notify() {}
    close() {}
  } };
});
beforeEach(() => {
  runtime.argv = [];
  runtime.requests = [];
  runtime.profile = { id: 'motion_editor' };
  vi.stubEnv('MGE_CONFIG_DIR', '/c');
});
afterEach(() => vi.unstubAllEnvs());

async function run(sessionId: string | null, autoApply = false) {
  const events: AgentEvent[] = [];
  const provider = createCodexProvider({ rootDir: '/r', serverPort: 7001, webPort: 7000 });
  for await (const event of provider.run({ sessionId, autoApply, prompt: 'hello', model: '', images: [], workspace: '/workspace', signal: new AbortController().signal })) events.push(event);
  return events;
}

it.each([null, 'thread-one'])('keeps the private-path profile through the Codex handshake (session %s)', async sessionId => {
  for (const autoApply of [false, true]) {
    runtime.requests = [];
    expect((await run(sessionId, autoApply)).at(-1)).toMatchObject({ isError: false });
    expect(runtime.argv).toEqual(expect.arrayContaining(['default_permissions="motion_editor"', 'permissions.motion_editor.network.enabled=true']));
    const filesystem = runtime.argv.find(arg => arg.startsWith('permissions.motion_editor.filesystem='))!;
    for (const entry of ['"/"="read"', '":workspace_roots"="write"', `${JSON.stringify(realpathSync(tmpdir()))}="read"`, `${JSON.stringify(realpathSync('/tmp'))}="read"`, `${JSON.stringify(join(realpathSync(tmpdir()), 'mge-codex-tmp-7001'))}="write"`, '"/c"="none"', '"/r/.mge"="none"']) expect(filesystem).toContain(entry);
    expect(runtime.argv.join(' ')).not.toMatch(/sandbox_mode|sandbox_workspace_write/);
    const thread = runtime.requests.find(request => request.method === (sessionId ? 'thread/resume' : 'thread/start'))!.params;
    expect(thread).toMatchObject({ approvalPolicy: 'on-request', approvalsReviewer: autoApply ? 'auto_review' : 'user' });
    expect(thread).not.toHaveProperty('sandbox');
    expect(thread).not.toHaveProperty('config');
    expect(runtime.requests.find(request => request.method === 'turn/start')!.params).not.toHaveProperty('sandboxPolicy');
  }
});

it.each([null, { id: 'other' }])('refuses to start a Codex turn without confirmed profile provenance (%j)', async profile => {
  runtime.profile = profile;
  expect((await run(null)).at(-1)).toMatchObject({ isError: true, error: "Codex could not apply the editor's permission profile (motion_editor). Update Codex CLI." });
  expect(runtime.requests.some(request => request.method === 'turn/start')).toBe(false);
});

it('keeps only this turn’s workspace writable: sibling workspaces and other agents’ run folders are read-only, the temp folder stays writable', () => {
  expect(otherAgentFolders('/home/u/.motion-graphics-editor/workspaces/repo-1/prj_a', 7001)).toEqual({
    '/home/u/.motion-graphics-editor/workspaces/repo-1': 'read',
    [join(tmpdir(), 'mge-opencode-7001')]: 'read',
    '/home/u/.motion-graphics-editor/workspaces/repo-1/prj_a': 'write',
  });
  expect(otherAgentFolders(join(tmpdir(), 'prj_b'), 7001)).not.toHaveProperty(tmpdir());
});

it('gives the sandbox real paths: a symlinked parent (/var/run → /run) would stop bubblewrap from starting the turn', async () => {
  const { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } = await import('node:fs');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mge-sandbox-paths-')));
  try {
    mkdirSync(join(dir, 'run', 'screen'), { recursive: true });
    symlinkSync(join(dir, 'run'), join(dir, 'var-run'));
    expect(sandboxPaths([join(dir, 'run', 'screen'), join(dir, 'var-run', 'screen'), join(dir, 'missing')])).toEqual([join(dir, 'run', 'screen'), join(dir, 'missing')]);
    // A path that doesn't exist yet, under a symlinked parent (macOS /var → /private/var): the parent's real path.
    expect(sandboxPaths([join(dir, 'var-run', 'not-yet', '.git')])).toEqual([join(dir, 'run', 'not-yet', '.git')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('resolves every profile path to its real path (later entries still win) and keeps special keys', async () => {
  const { mkdtempSync, mkdirSync, symlinkSync, realpathSync, rmSync } = await import('node:fs');
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mge-real-profile-')));
  try {
    mkdirSync(join(dir, 'real', 'ws'), { recursive: true });
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    expect(realProfile({ ':workspace_roots': 'write', [join(dir, 'link')]: 'read', [join(dir, 'link', 'ws')]: 'write', [join(dir, 'real')]: 'none' }))
      .toEqual({ ':workspace_roots': 'write', [join(dir, 'real', 'ws')]: 'write', [join(dir, 'real')]: 'none' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps Codex’s temp folder private: made 0700, and one that isn’t a plain folder of yours is refused', async () => {
  const { lstatSync, rmSync, symlinkSync, mkdtempSync } = await import('node:fs');
  const port = 40000 + Math.floor(Math.random() * 20000);
  const dir = ensureCodexTmp(port);
  try {
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const target = mkdtempSync(join(tmpdir(), 'mge-elsewhere-'));
  symlinkSync(target, codexTmpPath(port));
  try {
    expect(() => ensureCodexTmp(port)).toThrow(/isn't private to you/);
  } finally { rmSync(codexTmpPath(port), { force: true }); rmSync(target, { recursive: true, force: true }); }
});
