// Shared child environments never inherit the generation studio's credentials.

import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { agentDeniedPaths, browserProfilePaths, childEnv, desktopSocketPaths, editorMcpServer, protectedPaths, sessionBusPaths } from './shared';

afterEach(() => vi.unstubAllEnvs());
it('removes all fal credentials and the editor link, including extra overrides', () => {
  vi.stubEnv('FAL_KEY', 'fal-sentinel');
  vi.stubEnv('FAL_KEY_ID', 'id-sentinel');
  vi.stubEnv('FAL_KEY_SECRET', 'secret-sentinel');
  vi.stubEnv('MGE_EDITOR_LINK', 'link-sentinel');
  expect(childEnv([])).not.toHaveProperty('MGE_EDITOR_LINK');
  const env = childEnv([], { FAL_KEY: 'override', MGE_EDITOR_LINK: 'override', KEEP_ME: 'yes' });
  expect(env).not.toHaveProperty('FAL_KEY');
  expect(env).not.toHaveProperty('FAL_KEY_ID');
  expect(env).not.toHaveProperty('FAL_KEY_SECRET');
  expect(env).not.toHaveProperty('MGE_EDITOR_LINK');
  expect(env.KEEP_ME).toBe('yes');
});

it('protects absolute config and .mge (dev logs) paths even before they exist, without trailing slashes', () => {
  expect(protectedPaths('/r/', { MGE_CONFIG_DIR: '/c/' })).toEqual(['/c', '/r/.mge']);
  expect(protectedPaths('/r', { HOME: '/user' })).toEqual(['/user/.config/motion-editor', '/r/.mge']);
  expect(protectedPaths('relative-root', { MGE_CONFIG_DIR: 'relative-config/' })).toEqual([resolve('relative-config'), resolve('relative-root/.mge')]);
});

it('protects both symlink spellings and resolved targets for the config directory and the .mge folder', async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'mge-protected-')));
  try {
    const config = join(dir, 'private');
    const alias = join(dir, 'config-alias');
    const logs = join(dir, 'logs-elsewhere');
    await mkdir(config);
    await mkdir(logs);
    await writeFile(join(logs, 'dev.log'), 'fixture');
    await symlink(config, alias, 'dir');
    await symlink(logs, join(dir, '.mge'), 'dir');
    expect(protectedPaths(dir, { MGE_CONFIG_DIR: `${alias}/` })).toEqual([alias, config, join(dir, '.mge'), logs]);
    expect(protectedPaths(dir, { MGE_CONFIG_DIR: config })).toEqual([config, join(dir, '.mge'), logs]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('denies agents the browser profiles present on this machine, with the editor paths', () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'mge-home-')));
  try {
    mkdirSync(join(home, '.mozilla'), { recursive: true });
    mkdirSync(join(home, '.config', 'google-chrome'), { recursive: true });
    expect(browserProfilePaths({ HOME: home })).toEqual([join(home, '.mozilla'), join(home, '.config', 'google-chrome')]);
    expect(agentDeniedPaths('/r', { HOME: home, MGE_CONFIG_DIR: '/c' })).toEqual(expect.arrayContaining(['/c', '/r/.mge', join(home, '.mozilla'), join(home, '.config', 'google-chrome')]));
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

it('denies agents the session D-Bus socket (the keyring), found from the bus address or the runtime dir', () => {
  const run = mkdtempSync(join(tmpdir(), 'mge-run-'));
  try {
    writeFileSync(join(run, 'bus'), '');
    expect(sessionBusPaths({ DBUS_SESSION_BUS_ADDRESS: `unix:path=${join(run, 'bus')},guid=x` })).toEqual([join(run, 'bus')]);
    expect(sessionBusPaths({ XDG_RUNTIME_DIR: run })).toEqual([join(run, 'bus')]);
    expect(sessionBusPaths({ DBUS_SESSION_BUS_ADDRESS: 'unix:abstract=/tmp/dbus-x' })).toEqual([]);
  } finally {
    rmSync(run, { recursive: true, force: true });
  }
});

it('denies desktop and terminal endpoints in a fake environment, including symlink targets', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'mge-desktop-')));
  try {
    const runtime = join(root, 'runtime'); await mkdir(runtime);
    const authority = join(root, '.Xauthority'); await writeFile(authority, 'cookie');
    const screen = join(root, '.screen'); await mkdir(screen);
    const target = join(root, 'terminal-target'); await mkdir(target);
    await symlink(target, join(runtime, 'tmux-private'));
    await writeFile(join(runtime, 'wayland-0'), 'socket fixture');
    await writeFile(join(runtime, 'unrelated'), 'safe');
    const env = { HOME: root, XDG_RUNTIME_DIR: runtime };
    const paths = desktopSocketPaths(env);
    expect(paths).toEqual(expect.arrayContaining([authority, screen, join(runtime, 'wayland-0'), join(runtime, 'tmux-private'), target]));
    expect(paths).not.toContain(join(runtime, 'unrelated'));
    expect(agentDeniedPaths('/repo', env)).toEqual(expect.arrayContaining(paths));
    const custom = join(root, 'custom-authority'); await symlink(authority, custom);
    expect(desktopSocketPaths({ ...env, XAUTHORITY: custom })).toEqual(expect.arrayContaining([custom, authority]));
    expect(desktopSocketPaths({ HOME: join(root, 'missing'), XDG_RUNTIME_DIR: join(root, 'missing') })).not.toContain(join(root, 'missing', '.Xauthority'));
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('passes the server private-path environment explicitly to MCP processes', () => {
  vi.stubEnv('MGE_CONFIG_DIR', '/server/config');
  vi.stubEnv('XDG_CONFIG_HOME', '/server/xdg');
  vi.stubEnv('MGE_EDITOR_LINK_FILE', '/server/link');
  const env = editorMcpServer({ rootDir: '/repo', serverPort: 7001, webPort: 7000 }, 'Test Agent').env;
  expect(env).toMatchObject({ MGE_CONFIG_DIR: '/server/config', XDG_CONFIG_HOME: '/server/xdg', MGE_EDITOR_LINK_FILE: '/server/link' });
});

it('denies the tmux server this editor runs under, a custom tmux folder and SCREENDIR', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mge-tmux-'));
  try {
    mkdirSync(join(dir, 'custom'), { recursive: true });
    writeFileSync(join(dir, 'custom', 'sock'), '');
    mkdirSync(join(dir, 'tmp', `tmux-${process.getuid?.() ?? 0}`), { recursive: true });
    mkdirSync(join(dir, 'screens'), { recursive: true });
    const paths = desktopSocketPaths({ HOME: dir, TMUX: `${join(dir, 'custom', 'sock')},123,0`, TMUX_TMPDIR: join(dir, 'tmp'), SCREENDIR: join(dir, 'screens') });
    expect(paths).toEqual(expect.arrayContaining([join(dir, 'custom', 'sock'), join(dir, 'tmp', `tmux-${process.getuid?.() ?? 0}`), join(dir, 'screens')]));
    // A custom socket's folder (it could be /tmp or home) is not denied wholesale.
    expect(paths).not.toContain(join(dir, 'custom'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
