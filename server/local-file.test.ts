import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readAgentFile, PRIVATE_FILE_MESSAGE } from './local-file';
import { protectedPaths } from './agents/shared';

vi.mock('node:fs/promises', async importOriginal => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return { ...original, open: vi.fn(original.open), statfs: vi.fn(original.statfs), realpath: vi.fn(original.realpath) };
});

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(join(tmpdir(), 'mge-local-file-'));
  await fs.mkdir(join(root, 'config'));
  vi.stubEnv('MGE_CONFIG_DIR', join(root, 'config'));
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await fs.rm(root, { recursive: true, force: true }); });

describe('local file policy', () => {
  it('refuses a workspace symlink into private config without revealing its name', async () => {
    const secret = join(root, 'config/key.png');
    await fs.writeFile(secret, 'secret');
    const alias = join(root, 'harmless.png');
    await fs.symlink(secret, alias);
    await expect(readAgentFile(alias, root)).rejects.toThrow(PRIVATE_FILE_MESSAGE);
    await expect(readAgentFile(secret, root)).rejects.toThrow(PRIVATE_FILE_MESSAGE);
    await fs.mkdir(join(root, 'config-other'));
    await fs.writeFile(join(root, 'config-other/ok.png'), 'ok');
    expect((await readAgentFile(join(root, 'config-other/ok.png'), root)).toString()).toBe('ok');
  });
  it('refuses a hard link to a private file (nothing to resolve, so it is refused by its link count)', async () => {
    const secret = join(root, 'config/key.mp3');
    await fs.writeFile(secret, 'secret');
    const alias = join(root, 'song.mp3');
    await fs.link(secret, alias);
    await expect(readAgentFile(alias, root)).rejects.toThrow(PRIVATE_FILE_MESSAGE);
  });

  it('protects an editor link outside the config dir, including aliases', async () => {
    const link = join(root, 'external-link.png');
    await fs.writeFile(link, 'link-token');
    vi.stubEnv('MGE_EDITOR_LINK_FILE', link);
    expect(protectedPaths(root)).toContain(link);
    const alias = join(root, 'alias.png'); await fs.symlink(link, alias);
    await expect(readAgentFile(alias, root)).rejects.toThrow(PRIVATE_FILE_MESSAGE);
  });
  it('refuses final-component symlink swaps between stat and open', async () => {
    const path = join(root, 'allowed.png'); await fs.writeFile(path, 'allowed');
    const target = join(root, 'config/key.png'); await fs.writeFile(target, 'secret');
    const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      await fs.unlink(path); await fs.symlink(target, path);
      return original(...args);
    });
    await expect(readAgentFile(path, root)).rejects.toThrow();
  });
  it('refuses inode replacement between stat and open', async () => {
    const path = join(root, 'allowed.png'); await fs.writeFile(path, 'allowed');
    const replacement = join(root, 'replacement.png'); await fs.writeFile(replacement, 'other');
    const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      await fs.rename(replacement, path); return original(...args);
    });
    await expect(readAgentFile(path, root)).rejects.toThrow(PRIVATE_FILE_MESSAGE);
  });

  it.skipIf(process.platform !== 'linux')('refuses a file whose open descriptor really points into private config (a parent folder swapped mid-check)', async () => {
    // Every path check sees an ordinary file; only the descriptor's own path tells the truth.
    const secret = join(root, 'config/key.mp3'); await fs.writeFile(secret, 'secret');
    const path = join(root, 'song.mp3'); await fs.writeFile(path, 'decoy');
    const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).realpath;
    vi.mocked(fs.realpath).mockImplementation(async (p, ...rest) => (String(p).startsWith('/proc/self/fd/') ? secret : original(p, ...(rest as []))) as never);
    await expect(readAgentFile(path, root)).rejects.toThrow(PRIVATE_FILE_MESSAGE);
    vi.mocked(fs.realpath).mockImplementation(original as never);
    expect((await readAgentFile(path, root)).toString()).toBe('decoy');
  });
});

it.skipIf(process.platform !== 'linux')('refuses /proc/self/environ through a workspace symlink before opening it', async () => {
  const alias = join(root, 'innocent.png'); await fs.symlink('/proc/self/environ', alias);
  const opened = vi.mocked(fs.open); opened.mockClear();
  await expect(readAgentFile(alias, root)).rejects.toThrow(PRIVATE_FILE_MESSAGE);
  expect(opened).not.toHaveBeenCalled();
});
it('refuses non-files and regular files on a pseudo filesystem', async () => {
  await expect(readAgentFile(root, root)).rejects.toThrow(PRIVATE_FILE_MESSAGE);
  const path = join(root, 'mounted.png'); await fs.writeFile(path, 'private');
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).statfs;
  const info = await original(path);
  vi.mocked(fs.statfs).mockResolvedValueOnce({ ...info, type: 0x9fa0 });
  await expect(readAgentFile(path, root)).rejects.toThrow(PRIVATE_FILE_MESSAGE);
});
it('checks the opened descriptor is a regular file and closes it on refusal', async () => {
  const path = join(root, 'allowed.png'); await fs.writeFile(path, 'allowed');
  const original = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;
  const handle = await original(path, 'r');
  const info = await handle.stat();
  vi.spyOn(handle, 'stat').mockResolvedValueOnce(Object.assign(info, { isFile: () => false }));
  const close = vi.spyOn(handle, 'close');
  vi.mocked(fs.open).mockResolvedValueOnce(handle);
  await expect(readAgentFile(path, root)).rejects.toThrow(PRIVATE_FILE_MESSAGE);
  expect(close).toHaveBeenCalledOnce();
});
