import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { configDir } from '../server/generation/config';
import { LocalEditor } from './local';

vi.mock('node:child_process', () => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock('../server/generation/config', () => ({ configDir: vi.fn() }));

let root: string;
let local: LocalEditor;
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), 'mge-local-'));
  vi.mocked(configDir).mockReturnValue(join(root, 'private'));
  vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as unknown as ReturnType<typeof spawn>);
  vi.mocked(spawnSync).mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
  local = new LocalEditor({ rootDir: root, serverPort: 5918, webPort: 5917, openBrowser: true });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('private editor link handoff', () => {
  it('passes a private link file to MCP-started servers so the link stays out of dev.log', async () => {
    vi.spyOn(local, 'serverUp').mockResolvedValueOnce(false).mockResolvedValue(true);
    vi.spyOn(local, 'webUp').mockResolvedValueOnce(false).mockResolvedValue(true);
    expect((await local.ensureRunning()).started).toEqual(['dev']);
    expect(spawn).toHaveBeenCalledWith('npm', ['run', 'dev'], expect.objectContaining({
      env: expect.objectContaining({ MGE_EDITOR_LINK_FILE: join(root, 'private', 'editor-link-5918') }),
    }));
  });

  it('opens the private link and ignores an attacker-controlled link in dev.log', async () => {
    await mkdir(join(root, 'private'));
    await mkdir(join(root, '.mge'));
    await writeFile(local.editorLinkFile, 'http://localhost:5917/?session=private-secret\n');
    await writeFile(join(root, '.mge', 'dev.log'), '[server] editor link: http://localhost:5917/?session=attacker');
    expect(local.openBrowser()).toBe(true);
    expect(spawn).toHaveBeenCalledWith(expect.any(String), ['http://localhost:5917/?session=private-secret'], { detached: true, stdio: 'ignore' });
  });

  it('never falls back to reading a token from dev.log when the private file is absent', async () => {
    await mkdir(join(root, '.mge'));
    await writeFile(join(root, '.mge', 'dev.log'), '[server] editor link: http://localhost:5917/?session=attacker');
    expect(local.openBrowser()).toBe(true);
    expect(spawn).toHaveBeenCalledWith(expect.any(String), [local.editorUrl], { detached: true, stdio: 'ignore' });
  });
});
