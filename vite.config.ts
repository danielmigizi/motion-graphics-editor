import { defineConfig, searchForWorkspaceRoot } from 'vite';
import react from '@vitejs/plugin-react';
import { devServerGuard, PRIVATE_DEV_FOLDERS } from './src/core/devServerGuard';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';

// Editor UI on :5317. The local render/persistence server runs on :5318
// (override both with MGE_WEB_PORT / MGE_SERVER_PORT for parallel worktrees).
const serverPort = Number(process.env.MGE_SERVER_PORT ?? 5318);
const webPort = Number(process.env.MGE_WEB_PORT ?? 5317);

export default defineConfig({
  plugins: [devServerGuard(__dirname), react()],
  // Only these pages are app entries; never scan or watch agent worktrees,
  // render output or saved projects (they would invalidate the dep cache).
  optimizeDeps: {
    entries: ['index.html', 'capture.html'],
  },
  server: {
    watch: {
      // Anchored to this checkout: a worktree itself lives under another checkout's .claude/.
      ignored: [`${resolve(__dirname, '.claude')}/**`, '**/renders/**', '**/projects/**', '**/.engine-bundle/**', '**/.engine-cache/**', '**/.mge/**', '**/mcp/**', '**/chats/**'],
    },
    // A worktree may symlink node_modules from another checkout; allow its real
    // path too, or fonts load as fallbacks and preview no longer matches export.
    // Anchored to this checkout: a bare **/dist/** would also deny node_modules/*/dist (Vite's own client, React).
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', ...PRIVATE_DEV_FOLDERS.map(folder => `${resolve(__dirname, folder)}/**`)], allow: [searchForWorkspaceRoot(process.cwd()), realpathSync(resolve(__dirname, 'node_modules'))] },
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${serverPort}`,
        changeOrigin: true,
        // Vite logs a failed proxy request's URL; the event stream's carries the tab secret (?tab=).
        // This listener runs before Vite's own and redacts it (SECURITY.md).
        configure: (proxy) => {
          proxy.on('error', (_err, _req, res) => {
            const req = 'req' in res ? (res as { req: { url?: string } }).req : undefined;
            if (req?.url) req.url = req.url.replace(/([?&](?:tab|session)=)[^&#]*/gi, '$1[redacted]');
          });
        },
      },
      // Uploads land in public/ after Vite started; Vite only learns about new
      // public files through its watcher, so serve them from the server that wrote them.
      '/assets/uploads': `http://127.0.0.1:${serverPort}`,
      '/renders': `http://127.0.0.1:${serverPort}`,
    },
  },
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'index.html'),
        capture: resolve(__dirname, 'capture.html'),
      },
    },
  },
});
