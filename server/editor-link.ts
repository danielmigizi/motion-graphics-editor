import { randomBytes } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';

/** Replace the link atomically, without following an existing file's symlink or mode. */
export async function writeEditorLink(path: string, link: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('MGE_EDITOR_LINK_FILE must be an absolute path.');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomBytes(16).toString('hex')}.tmp`;
  try {
    await writeFile(temporary, `${link}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }
}
