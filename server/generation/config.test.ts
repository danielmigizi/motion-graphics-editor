// Settings and credential persistence use temporary directories only.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GENERATION_SETTINGS } from '../../src/core/generationStudio';
import { checkKeyShape, configDir, createKeyStore, GenerationSettingsStore, SettingsError, systemKeychain, type Keychain } from './config';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));

const dirs: string[] = [];
async function tempDir() {
  const dir = await mkdtemp(join(tmpdir(), 'mge-generation-config-'));
  dirs.push(dir);
  return dir;
}

function fakeKeychain(available = true, initial: string | null = null): Keychain {
  let saved = initial;
  return {
    get: vi.fn(async () => saved),
    set: vi.fn(async (key) => { if (available) saved = key; return available; }),
    remove: vi.fn(async () => { saved = null; }),
  };
}

afterEach(async () => {
  vi.resetAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('generation settings', () => {
  it('uses the per-user config directory or the explicit override', () => {
    expect(configDir({ HOME: '/example/home' })).toBe('/example/home/.config/motion-editor');
    expect(configDir({ MGE_CONFIG_DIR: '/example/config' })).toBe('/example/config');
  });

  it('returns independent defaults for missing and corrupt files', async () => {
    const dir = await tempDir();
    const store = new GenerationSettingsStore({ dir });
    const defaults = await store.get();
    expect(defaults).toEqual(DEFAULT_GENERATION_SETTINGS);
    defaults.policy = 'draft';
    defaults.routeOverrides['music.bed'] = 'mutated';
    expect(await store.get()).toEqual(DEFAULT_GENERATION_SETTINGS);
    for (const corrupt of ['{broken', '[]', '{"policy":"invalid"}', '{"unknown":true}']) {
      await writeFile(join(dir, 'generation-settings.json'), corrupt);
      expect(await store.get()).toEqual(DEFAULT_GENERATION_SETTINGS);
    }
  });

  it('merges stored partial settings with defaults', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'generation-settings.json'), '{"dailyBudgetUsd":12}');
    expect(await new GenerationSettingsStore({ dir }).get()).toEqual({ ...DEFAULT_GENERATION_SETTINGS, dailyBudgetUsd: 12 });
  });

  it('merges and persists updates privately, including concurrent patches', async () => {
    const dir = await tempDir();
    const store = new GenerationSettingsStore({ dir });
    await store.update({ dailyBudgetUsd: 0, gptImageReserveUsd: 10 });
    await Promise.all([store.update({ policy: 'draft' }), store.update({ confirmOverUsd: 1000, skipCardForOwnClicks: false })]);
    const expected = { dismissedSuggestions: [], routeOverrides: {}, dailyBudgetUsd: 0, gptImageReserveUsd: 10, policy: 'draft', confirmOverUsd: 1000, skipCardForOwnClicks: false };
    expect(await store.get()).toEqual(expected);
    expect(JSON.parse(await readFile(join(dir, 'generation-settings.json'), 'utf8'))).toEqual(expected);
    expect((await stat(join(dir, 'generation-settings.json'))).mode & 0o777).toBe(0o600);
  });

  it('serializes set and clear override edits without losing concurrent settings', async () => {
    const store = new GenerationSettingsStore({ dir: await tempDir() });
    await Promise.all([store.setRouteOverride('image.generate', 'seedream-5-pro'), store.setRouteOverride('image.typography', 'seedream-5-pro'), store.update({ policy: 'balanced' })]);
    expect((await store.get()).routeOverrides).toEqual({ 'image.generate': 'seedream-5-pro', 'image.typography': 'seedream-5-pro' });
    await store.setRouteOverride('image.generate', null);
    expect(await store.get()).toMatchObject({ policy: 'balanced', routeOverrides: { 'image.typography': 'seedream-5-pro' } });
    await expect(store.setRouteOverride('missing', null)).rejects.toMatchObject({ path: 'routeOverrides.missing' });
    await expect(store.setRouteOverride('image.generate', undefined)).rejects.toMatchObject({ path: 'routeOverrides.image.generate' });
  });

  it.each([
    [null, ''], [[], ''], ['settings', ''], [1, ''],
    [{ unknown: true }, 'unknown'],
    [{ dailyBudgetUsd: -1 }, 'dailyBudgetUsd'], [{ dailyBudgetUsd: 1001 }, 'dailyBudgetUsd'],
    [{ dailyBudgetUsd: '5' }, 'dailyBudgetUsd'], [{ dailyBudgetUsd: NaN }, 'dailyBudgetUsd'],
    [{ confirmOverUsd: -1 }, 'confirmOverUsd'], [{ confirmOverUsd: 1001 }, 'confirmOverUsd'],
    [{ confirmOverUsd: Infinity }, 'confirmOverUsd'], [{ confirmOverUsd: null }, 'confirmOverUsd'],
    [{ gptImageReserveUsd: -1 }, 'gptImageReserveUsd'], [{ gptImageReserveUsd: 11 }, 'gptImageReserveUsd'],
    [{ gptImageReserveUsd: '0.5' }, 'gptImageReserveUsd'], [{ gptImageReserveUsd: NaN }, 'gptImageReserveUsd'],
    [{ skipCardForOwnClicks: 1 }, 'skipCardForOwnClicks'], [{ skipCardForOwnClicks: undefined }, 'skipCardForOwnClicks'],
    [{ routeOverrides: null }, 'routeOverrides'], [{ routeOverrides: [] }, 'routeOverrides'],
    [{ routeOverrides: { missing: 'eleven-music-2.5' } }, 'routeOverrides.missing'],
    [{ routeOverrides: { 'music.bed': 'missing' } }, 'routeOverrides.music.bed'],
    [{ routeOverrides: { 'music.bed': 'seedream-5-pro' } }, 'routeOverrides.music.bed'],
    [{ routeOverrides: { 'music.bed': null } }, 'routeOverrides.music.bed'],
    [{ routeOverrides: { 'music.bed': 'toString' } }, 'routeOverrides.music.bed'],
    [JSON.parse('{"routeOverrides":{"__proto__":"seedream-5-pro"}}'), 'routeOverrides.__proto__'],
    [{ policy: 'fast' }, 'policy'], [{ policy: null }, 'policy'],
    [JSON.parse('{"__proto__":true}'), '__proto__'],
  ])('rejects invalid patch %j at %s', async (patch, path) => {
    const store = new GenerationSettingsStore({ dir: await tempDir() });
    await expect(store.update(patch)).rejects.toBeInstanceOf(SettingsError);
    await expect(store.update(patch)).rejects.toMatchObject({ path });
    expect(await store.get()).toEqual(DEFAULT_GENERATION_SETTINGS);
  });
});

describe('fal key storage', () => {
  const key = 'fal_SENTINEL_1234567890abcdef';

  it('saves to the keychain and removes a stale file', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'fal-key'), 'old-file-key');
    const keychain = fakeKeychain();
    const store = createKeyStore({ dir, keychain, env: {} });
    expect(await store.set(` ${key}\n`)).toBe('keychain');
    expect(keychain.set).toHaveBeenCalledWith(key);
    expect(await store.get()).toEqual({ key, source: 'keychain' });
    await expect(readFile(join(dir, 'fal-key'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('falls back to a 0600 file in a 0700 directory and clears a stale keychain copy', async () => {
    const dir = join(await tempDir(), 'config');
    await mkdir(dir, { mode: 0o755 });
    await writeFile(join(dir, 'fal-key'), 'old-key', { mode: 0o644 });
    const keychain = fakeKeychain(false, 'stale-keychain-key');
    const store = createKeyStore({ dir, keychain, env: {} });
    expect(await store.set(key)).toBe('file');
    expect(keychain.remove).toHaveBeenCalledOnce();
    expect(await readFile(join(dir, 'fal-key'), 'utf8')).toBe(key);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, 'fal-key'))).mode & 0o777).toBe(0o600);
    expect(await store.get()).toEqual({ key, source: 'file' });
  });

  it('prefers keychain over file over env, and removal leaves env visible', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'fal-key'), 'file-key');
    const keychain = fakeKeychain(true, 'keychain-key');
    const env = { FAL_KEY: 'env-key' };
    const store = createKeyStore({ dir, keychain, env });
    expect(await store.get()).toEqual({ key: 'keychain-key', source: 'keychain' });
    await keychain.remove();
    expect(await store.get()).toEqual({ key: 'file-key', source: 'file' });
    await store.remove();
    expect(await store.get()).toEqual({ key: 'env-key', source: 'env' });
    expect(await store.status()).toEqual({ configured: true, source: 'env', last4: '-key' });
    expect(keychain.remove).toHaveBeenCalledTimes(2);
    expect(env.FAL_KEY).toBe('env-key');
    delete (env as NodeJS.ProcessEnv).FAL_KEY;
    expect(await store.get()).toBeNull();
    expect(await store.status()).toEqual({ configured: false });
  });

  it('masks status and never serializes the key', async () => {
    const store = createKeyStore({ dir: await tempDir(), keychain: fakeKeychain(true, key), env: {} });
    const status = await store.status();
    expect(status).toEqual({ configured: true, source: 'keychain', last4: 'cdef' });
    expect(JSON.stringify(status)).not.toContain(key);
    expect(JSON.stringify(status)).not.toContain(key.slice(0, -4));
  });

  it('refuses malformed keys before writing and skips malformed stored keys', async () => {
    const dir = await tempDir();
    const keychain = fakeKeychain(true, 'bad key');
    await writeFile(join(dir, 'fal-key'), 'bad\0key');
    const store = createKeyStore({ dir, keychain, env: { FAL_KEY: key } });
    await expect(store.set('bad key')).rejects.toThrow('whitespace');
    expect(keychain.set).not.toHaveBeenCalled();
    expect(await store.get()).toEqual({ key, source: 'env' });
  });
});

describe('key shape', () => {
  it.each([undefined, null, 4, '', '  \n', 'key with spaces', 'key\tvalue', 'key\nvalue', 'x'.repeat(513), 'key\0value', 'clé', 'key\x7f'])('rejects %j without echoing it', (raw) => {
    const result = checkKeyShape(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0);
  });

  it('trims surrounding whitespace and accepts printable ASCII up to 512 characters', () => {
    expect(checkKeyShape(' \n fal_valid:abcd-1234 \t')).toEqual({ ok: true, key: 'fal_valid:abcd-1234' });
    expect(checkKeyShape('x'.repeat(512))).toEqual({ ok: true, key: 'x'.repeat(512) });
  });
});

describe('system keychain commands', () => {
  function commandResult(output = '', code = 0, failed = false) {
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough() });
    let input = '';
    child.stdin.on('data', (chunk) => { input += String(chunk); });
    spawn.mockImplementationOnce(() => {
      queueMicrotask(() => {
        if (failed) child.emit('error', Object.assign(new Error('unavailable'), { code: 'ENOENT' }));
        else {
          child.stdout.end(output);
          child.emit('close', code);
        }
      });
      return child;
    });
    return () => input;
  }

  it.each(['linux', 'darwin'] as const)('uses the specified %s commands with a timeout', async (platform) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...original, value: platform });
    try {
      const keychain = systemKeychain();
      commandResult('stored-key\n');
      expect(await keychain.get()).toBe('stored-key');
      const readInput = commandResult();
      expect(await keychain.set('secret-key')).toBe(true);
      commandResult();
      await keychain.remove();
      const commands = spawn.mock.calls.map(([command, args]) => [command, args]);
      expect(commands).toEqual(platform === 'linux' ? [
        ['secret-tool', ['lookup', 'service', 'motion-editor', 'account', 'fal']],
        ['secret-tool', ['store', '--label=Motion editor fal key', 'service', 'motion-editor', 'account', 'fal']],
        ['secret-tool', ['clear', 'service', 'motion-editor', 'account', 'fal']],
      ] : [
        ['security', ['find-generic-password', '-s', 'motion-editor', '-a', 'fal', '-w']],
        ['security', ['-i']],
        ['security', ['delete-generic-password', '-s', 'motion-editor', '-a', 'fal']],
      ]);
      expect(readInput()).toBe(platform === 'linux' ? 'secret-key' : 'add-generic-password -U -s motion-editor -a fal -w "secret-key"\n');
      expect(JSON.stringify(commands)).not.toContain('secret-key');
      for (const call of spawn.mock.calls) expect(call[2]).toMatchObject({ timeout: 10_000 });
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });

  it('quotes macOS stdin keys containing quotes and backslashes without exposing argv', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...original, value: 'darwin' });
    try {
      const key = String.raw`fal_"quote\slash'`;
      const input = commandResult();
      expect(await systemKeychain().set(key)).toBe(true);
      expect(spawn.mock.calls[0].slice(0, 2)).toEqual(['security', ['-i']]);
      expect(JSON.stringify(spawn.mock.calls)).not.toContain(key);
      expect(input()).toBe(String.raw`add-generic-password -U -s motion-editor -a fal -w "fal_\"quote\\slash'"` + '\n');
    } finally { Object.defineProperty(process, 'platform', original); }
  });

  it.each([false, true])('treats nonzero exit or spawn error (%s) as unavailable', async (failed) => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { ...original, value: 'linux' });
    try {
      const keychain = systemKeychain();
      commandResult('', 1, failed);
      expect(await keychain.get()).toBeNull();
      commandResult('', 1, failed);
      expect(await keychain.set('secret-key')).toBe(false);
      commandResult('', 1, failed);
      await expect(keychain.remove()).resolves.toBeUndefined();
      spawn.mockImplementationOnce(() => { throw new Error('spawn rejected the arguments'); });
      expect(await keychain.set('secret-key')).toBe(false);
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });
});


it('drops stale overrides and dismissals without changing budgets or valid settings, logging once', async () => {
  const dir = await tempDir();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const store = new GenerationSettingsStore({ dir });
  await writeFile(join(dir, 'generation-settings.json'), JSON.stringify({ dailyBudgetUsd: 1, confirmOverUsd: 0.2, policy: 'balanced',
    routeOverrides: { 'image.generate': 'retired', 'image.typography': 'seedream-5-pro', missing: 'seedream-5-pro' },
    dismissedSuggestions: ['image.generate:retired', 'image.generate:seedream-5-pro', 5, 'music.bed:seedream-5-pro'] }));
  const expected = { dailyBudgetUsd: 1, confirmOverUsd: 0.2, policy: 'balanced', routeOverrides: { 'image.typography': 'seedream-5-pro' }, dismissedSuggestions: ['image.generate:seedream-5-pro'] };
  expect(await store.get()).toMatchObject(expected);
  expect(await store.get()).toMatchObject(expected);
  expect(warn).toHaveBeenCalledOnce();
  warn.mockRestore();
});
it('serializes and validates suggestion dismissals with settings updates', async () => {
  const store = new GenerationSettingsStore({ dir: await tempDir() });
  await Promise.all([store.dismissSuggestion('image.generate', 'seedream-5-pro'), store.dismissSuggestion('image.typography', 'seedream-5-pro'), store.update({ dailyBudgetUsd: 1 })]);
  await store.dismissSuggestion('image.generate', 'seedream-5-pro');
  expect(await store.get()).toMatchObject({ dailyBudgetUsd: 1, dismissedSuggestions: ['image.generate:seedream-5-pro', 'image.typography:seedream-5-pro'] });
  await expect(store.update({ dismissedSuggestions: ['bad'] })).rejects.toMatchObject({ path: 'dismissedSuggestions[0]' });
  await expect(store.dismissSuggestion('music.bed', 'seedream-5-pro')).rejects.toBeInstanceOf(SettingsError);
});
