import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { ViteDevServer } from 'vite';
import { devServerGuard, devServerPath, PRIVATE_DEV_FOLDERS, PUBLIC_FILE_CSP } from './devServerGuard';

describe('Vite private file guard', () => {
  const root = '/repo/editor';
  it.each(['/PUBLIC/assets/UPLOADS/x', '/ASSETS/UPLOADS/x', '/PROJECTS/x', '/@FS//REPO/EDITOR/.MGE/dev.log', '/public/assets/uploads/x.svg', '/assets/%75ploads/x.svg', '/%61ssets/uploads/x.svg',
    '/@fs//repo/editor/public/assets/uploads/x.svg', '/@fs/%2Frepo/editor/public/assets/uploads/x.svg',
    '/public/assets/../assets/uploads/x.svg', '/.mge/dev.log', '/projects/p.json', '/chats/c.json',
    '/%72enders/r.html', '/@fs//repo/editor/renders/r.html', '/@fs//repo/editor/.mge/dev.log', '/bad%ZZ'])('refuses bypass %s', path => {
    expect(devServerPath(path, root).denied).toBe(true);
  });
  it('denies each private folder through root and @fs spellings', () => {
    for (const folder of PRIVATE_DEV_FOLDERS) {
      const encoded = folder.replace(/./, c => `%${c.charCodeAt(0).toString(16)}`);
      for (const path of [`/${encoded}/x`, `/@fs/${root}/${folder}/x`]) expect(devServerPath(path, root).denied, path).toBe(true);
    }
  });
  it.each(['/src/main.tsx', '/assets/logo.svg', '/node_modules/pkg/index.js', '/@vite/client',
    '/assets/uploads/u_x.png', '/renders/r.mp4', '/api/projects'])('allows legitimate request %s', path => {
    expect(devServerPath(path, root).denied).toBe(false);
  });
  it('installs an early middleware, blocks upload aliases, and sandboxes existing public files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mge-vite-'));
    try {
      await mkdir(join(dir, 'public/assets'), { recursive: true });
      await writeFile(join(dir, 'public/assets/logo.svg'), '<svg><script>bad()</script></svg>');
      const use = vi.fn();
      const plugin = devServerGuard(dir);
      (plugin.configureServer as Function)({ middlewares: { use } } as unknown as ViteDevServer);
      const middleware = use.mock.calls[0][0];
      const res = { setHeader: vi.fn(), end: vi.fn(), statusCode: 200 };
      const next = vi.fn();
      middleware({ url: '/assets/%75ploads/x.svg' }, res, next);
      expect(res.statusCode).toBe(404); expect(next).not.toHaveBeenCalled();
      middleware({ url: '/assets/logo.svg' }, res, next);
      expect(res.setHeader).toHaveBeenCalledWith('Content-Security-Policy', PUBLIC_FILE_CSP);
      expect(res.setHeader).toHaveBeenCalledWith('X-Content-Type-Options', 'nosniff');
      expect(next).toHaveBeenCalledOnce();
      res.setHeader.mockClear();
      middleware({ url: '/assets/missing.svg' }, res, next);
      expect(res.setHeader).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

it('uses canonical public paths for CSP, including case aliases and symlinks', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mge-public-realpath-'));
  try {
    await mkdir(join(dir, 'public/assets/uploads'), { recursive: true });
    await writeFile(join(dir, 'public/logo.svg'), '<svg/>');
    await writeFile(join(dir, 'public/assets/uploads/private.svg'), '<svg/>');
    await symlink(join(dir, 'public'), join(dir, 'public-alias'));
    await symlink(join(dir, 'public/assets/uploads'), join(dir, 'public/alias'));
    const canonical = await realpath(join(dir, 'public/logo.svg'));
    expect(devServerPath('/PUBLIC/logo.svg', dir)).toEqual({ denied: false, publicFile: canonical });
    expect(devServerPath('/public-alias/logo.svg', dir).publicFile).toBeNull();
    expect(devServerPath('/PUBLIC/alias/private.svg', dir).denied).toBe(true);
    const use = vi.fn();
    (devServerGuard(dir).configureServer as Function)({ middlewares: { use } });
    const res = { setHeader: vi.fn(), end: vi.fn() };
    use.mock.calls[0][0]({ url: '/PUBLIC/logo.svg' }, res, vi.fn());
    expect(res.setHeader).toHaveBeenCalledWith('Content-Security-Policy', PUBLIC_FILE_CSP);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
