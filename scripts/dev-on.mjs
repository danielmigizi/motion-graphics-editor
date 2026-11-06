// Start the editor + local server on given ports, detached, for parallel
// checkouts side by side:  node scripts/dev-on.mjs <webPort> <serverPort>
// Logs to .mge/dev-<webPort>.log. Stop with: fuser -k <webPort>/tcp <serverPort>/tcp
import { spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { join } from 'node:path';

const [web, server] = process.argv.slice(2).map(Number);
if (!web || !server) {
  console.error('usage: node scripts/dev-on.mjs <webPort> <serverPort>');
  process.exit(2);
}
const root = fileURLToPath(new URL('..', import.meta.url));
mkdirSync(join(root, '.mge'), { recursive: true });
const log = join(root, '.mge', `dev-${web}.log`);
const fd = openSync(log, 'a');
// The editor link goes to a 0600 file in the config directory (agents are denied it), never to this log.
const linkFile = process.env.MGE_EDITOR_LINK_FILE || join(process.env.MGE_CONFIG_DIR || join(homedir(), '.config', 'motion-editor'), `editor-link-${server}`);
const child = spawn('npm', ['run', 'dev'], { cwd: root, detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, MGE_WEB_PORT: String(web), MGE_SERVER_PORT: String(server), MGE_EDITOR_LINK_FILE: linkFile } });
child.unref();
const deadline = Date.now() + 60000;
const up = async (url) => { try { return (await fetch(url, { signal: AbortSignal.timeout(1500) })).status < 500; } catch { return false; } };
while (Date.now() < deadline) {
  if ((await up(`http://127.0.0.1:${server}/api/health`)) && (await up(`http://localhost:${web}/`))) {
    console.log(`editor http://localhost:${web}/  server http://127.0.0.1:${server}  log ${log}  editor link in ${linkFile}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 500));
}
console.error(`did not start within 60 s; see ${log}`);
process.exit(1);
