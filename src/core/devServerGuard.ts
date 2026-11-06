import { realpathSync, statSync } from 'node:fs';
import { posix, relative as pathRelative, resolve, sep } from 'node:path';
import type { Plugin } from 'vite';

export const PRIVATE_DEV_FOLDERS = ['public/assets/uploads', '.mge', 'projects', 'chats', 'renders', '.engine-bundle', '.engine-cache', 'brand-kits', 'dist'];
export const PUBLIC_FILE_CSP = "sandbox; default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; media-src 'self'";

/** Use the wire spelling for proxy exceptions, and Vite's decoded spelling for files. */
export function devServerPath(rawUrl: string, rootDir: string): { denied: boolean; publicFile: string | null } {
  const raw = rawUrl.split(/[?#]/)[0];
  if (['/assets/uploads/', '/renders/', '/api/'].some(prefix => raw.startsWith(prefix))) return { denied: false, publicFile: null };
  let path: string;
  try { path = posix.normalize(decodeURIComponent(raw).replace(/\\/g, '/')); }
  catch { return { denied: true, publicFile: null }; }
  if (path.includes('\0')) return { denied: true, publicFile: null };
  const root = resolve(rootDir).replace(/\\/g, '/');
  if (path.toLowerCase().startsWith('/@fs/')) {
    const absolute = path.slice('/@fs'.length);
    if (absolute.toLowerCase() !== root.toLowerCase() && !absolute.toLowerCase().startsWith(root.toLowerCase() + '/')) return { denied: false, publicFile: null };
    path = absolute.slice(root.length) || '/';
  }
  const relative = path.replace(/^\/+/, '');
  // publicDir is also served without its /public prefix.
  const lower = relative.toLowerCase();
  const denied = [...PRIVATE_DEV_FOLDERS, 'assets/uploads'].some(folder => lower === folder || lower.startsWith(folder + '/'));
  if (denied) return { denied: true, publicFile: null };
  const publicRelative = lower.startsWith('public/') ? relative.slice(7) : relative;
  try {
    const publicRoot = realpathSync(resolve(rootDir, 'public'));
    const publicFile = realpathSync(resolve(publicRoot, publicRelative));
    if (!publicFile.startsWith(publicRoot + sep)) return { denied: false, publicFile: null };
    const canonical = pathRelative(publicRoot, publicFile).replace(/\\/g, '/').toLowerCase();
    if (canonical === 'assets/uploads' || canonical.startsWith('assets/uploads/')) return { denied: true, publicFile: null };
    return { denied: false, publicFile };
  } catch { return { denied: false, publicFile: null }; }
}

export function devServerGuard(rootDir: string): Plugin {
  return {
    name: 'private-local-files',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const decision = devServerPath(req.url ?? '/', rootDir);
        if (decision.denied) { res.statusCode = 404; res.end(); return; }
        if (decision.publicFile) {
          try {
            if (statSync(decision.publicFile).isFile()) {
              res.setHeader('Content-Security-Policy', PUBLIC_FILE_CSP);
              res.setHeader('X-Content-Type-Options', 'nosniff');
            }
          } catch { /* Let Vite answer missing files. */ }
        }
        next();
      });
    },
  };
}
