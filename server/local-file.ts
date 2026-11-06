import { constants, realpathSync } from 'node:fs';
import { open, realpath, stat, statfs } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { agentDeniedPaths } from './agents/shared';

export const PRIVATE_FILE_MESSAGE = "That file is in a private location the editor's agents can't use.";
export class PrivateFileError extends Error {
  constructor() { super(PRIVATE_FILE_MESSAGE); }
}
export function isDeniedPath(resolved: string, rootDir: string, env = process.env): boolean {
  const pseudoRoots = ['/proc', '/sys', '/dev'].flatMap(path => {
    try { return [path, realpathSync(path)]; } catch { return [path]; }
  });
  return [...pseudoRoots, ...agentDeniedPaths(rootDir, env)].some(path => resolved === resolve(path) || resolved.startsWith(resolve(path) + sep));
}

// Linux pseudo files can claim to be regular files; also reject mounts outside
// their usual locations. tmpfs remains usable for ordinary temporary files.
const PSEUDO_FILESYSTEMS = new Set([
  0x9fa0, 0x62656572, 0x1cd1, // proc, sysfs, devpts
  0x27e0eb, 0x63677270, // cgroup, cgroup2
  0x64626720, 0x74726163, 0x73636673, 0x62656570, // debug, trace, security, config
  0xcafe4a11, 0x19800202, // BPF, POSIX message queues
  0x50495045, 0x534f434b, 0x09041934, // pipes, sockets, anonymous inodes
  0x6165676c, 0x42494e4d, // persistent firmware logs, binary format handlers
]);

/** Resolve before checking policy, then pin the inode while consuming its bytes. */
export async function openAgentFile(path: string, rootDir: string, env = process.env) {
  const resolved = await realpath(path);
  if (isDeniedPath(resolved, rootDir, env)) throw new PrivateFileError();
  const expected = await stat(resolved);
  // A hard link to a private file has no symlink to resolve: refuse files with more than one name.
  if (!expected.isFile() || expected.nlink > 1 || PSEUDO_FILESYSTEMS.has((await statfs(resolved)).type)) throw new PrivateFileError();
  const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') throw new PrivateFileError();
    throw error;
  });
  try {
    const actual = await file.stat();
    // Re-resolve parents as well: O_NOFOLLOW only protects the final component.
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino || await realpath(resolved) !== resolved
      || PSEUDO_FILESYSTEMS.has((await statfs(resolved)).type)) throw new PrivateFileError();
    // A folder above the file can be swapped for a symlink and back between these checks.
    // On Linux, ask where the open descriptor really points and check that path too.
    const opened = await realpath(`/proc/self/fd/${file.fd}`).catch(() => null);
    if (opened !== null && (opened !== resolved || isDeniedPath(opened, rootDir, env))) throw new PrivateFileError();
    return { file, resolved, info: actual };
  } catch (error) { await file.close(); throw error; }
}
export async function readAgentFile(path: string, rootDir: string, env = process.env): Promise<Buffer> {
  const { file } = await openAgentFile(path, rootDir, env);
  try { return await file.readFile(); } finally { await file.close(); }
}
