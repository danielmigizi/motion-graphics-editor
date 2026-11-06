// Local server: project persistence, asset uploads, static public/ + renders/,
// and MP4 export jobs. Port: MGE_SERVER_PORT (default 5318).

import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { DEFAULT_SERVER_PORT } from '../src/core/api-contract';
import { newId } from '../src/core/ids';
import { createApp } from './app';
import { EditorSession } from './session';
import { writeEditorLink } from './editor-link';
import { createProviders } from './agents/registry';
import { EditorBridge } from './bridge';
import { ChatManager } from './chat';
import { GenerationLog } from './generation-log';
import { configDir, createKeyStore, GenerationSettingsStore } from './generation/config';
import { createFalClient } from './generation/fal';
import { cachedGenerationKeys, createGenerationService } from './generation/jobs';
import { GenerationRecords } from './generation/records';
import { GENERATION_JOB_EVENT } from '../src/core/generationStudio';
import { createProjectStore } from './projects';
import { createNativeRenderer } from './engine/renderer';
import { describeRenderError } from './render-errors';
import { RenderManager } from './renders';
import { ProxyQueue } from './video';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const port = Number(process.env.MGE_SERVER_PORT ?? DEFAULT_SERVER_PORT);
const publicDir = join(rootDir, 'public');
const rendersDir = join(rootDir, 'renders');
// Chat agents work in a folder per project, outside the repo (so they can't edit the editor itself).
const workspacesDir = process.env.MGE_WORKSPACES_DIR ?? join(homedir(), '.motion-graphics-editor', 'workspaces', `${basename(rootDir)}-${createHash('sha256').update(rootDir).digest('hex').slice(0, 8)}`);

// Exports, stills and contact sheets: our render page in headless Chrome, piped into ffmpeg (docs/render-engine.md).
const renderer = createNativeRenderer({ rootDir, serverPort: port, publicDir });
const renders = new RenderManager({ rendersDir, rootDir, publicDir, renderer: renderer.render, describeError: describeRenderError });

await renders.load();

const webPort = Number(process.env.MGE_WEB_PORT ?? 5317);
const bridge = new EditorBridge();
// Today's generation activity: .mge/generation-log.json.
const generations = new GenerationLog({ dir: join(rootDir, '.mge') });
// Claude Code, Codex, Cursor Agent and OpenCode, each under the user's own login.
const agents = createProviders({ rootDir, serverPort: port, webPort });
const chat = new ChatManager({
  chatsDir: join(rootDir, 'chats'),
  publicDir,
  workspacesDir,
  providers: agents,
  emit: (event) => bridge.broadcast('chat', event),
  askPermission: async ({ projectId, provider, action, detail, signal }) => {
    // Never offer an approval on a different project's active editor.
    if (signal.aborted || bridge.state().context?.projectId !== projectId) return false;
    const reply = await bridge.send({ type: 'askPermission', requestId: newId('req'), agent: agents.get(provider)?.label ?? provider, action, detail }, undefined, signal);
    return !signal.aborted && bridge.state().context?.projectId === projectId && reply.ok && reply.message === 'allowed';
  },
  proposalLog: (projectId) => {
    const context = bridge.state().context;
    return context?.projectId === projectId ? [...(context.proposal ? [context.proposal] : []), ...(context.proposalLog ?? [])] : [];
  },
  fps: (projectId) => {
    const p = bridge.state().project;
    return p && p.id === projectId ? p.fps : 30;
  },
});

const generationDir = configDir();
const generationKeys = cachedGenerationKeys(createKeyStore({ dir: generationDir }));
const proxies = new ProxyQueue(publicDir);
const generation = createGenerationService({
  configDir: generationDir,
  renderStill: renderer.renderStill,
  requestProxy: (src) => proxies.request(src),
  fal: createFalClient({ key: async () => (await generationKeys.get())?.key ?? null }),
  keys: generationKeys,
  settings: new GenerationSettingsStore({ dir: generationDir }),
  records: new GenerationRecords({ dir: generationDir }),
  log: generations,
  publicDir,
  emit: (job) => bridge.broadcast(GENERATION_JOB_EVENT, job),
  project: () => bridge.state().project,
  askPermission: async ({ agent, action, generation: ask }, signal) => {
    if (!bridge.state().connected) return 'unavailable';
    const projectId = bridge.state().project?.id;
    const reply = await bridge.send({ type: 'askPermission', requestId: newId('req'), agent, action, generation: ask }, undefined, signal);
    if (signal?.aborted || bridge.state().project?.id !== projectId) return 'denied';
    return reply.ok && ['allowed', 'denied', 'timeout'].includes(reply.message ?? '') ? reply.message as 'allowed' | 'denied' | 'timeout' : 'unavailable';
  },
});

const session = new EditorSession({ port });
const app = createApp({
  session,
  extraOrigins: renderer.origins,
  proxies,
  generation,
  bridge,
  chat,
  generations,
  chatProviders: (o) => {
    if (o?.refresh) agents.invalidateAll();
    return agents.list();
  },
  publicDir,
  rootDir,
  webPort,
  serverPort: port,
  rendersDir,
  projects: createProjectStore(join(rootDir, 'projects')),
  renders,
  invalidateBundle: renderer.invalidateBundle,
  renderStill: renderer.renderStill,
  renderContactSheet: renderer.renderContactSheet,
});

// Loopback only: the server reads and writes local files and must not be
// reachable from other machines on the network.
const host = '127.0.0.1';

await generation.init();

const editorLink = `http://localhost:${webPort}/?session=${session.launchToken()}`;
const editorLinkFile = process.env.MGE_EDITOR_LINK_FILE;
if (editorLinkFile) await writeEditorLink(editorLinkFile, editorLink);

app.listen(port, host, (err?: Error) => {
  if (err) {
    console.error(`[server] failed to listen on ${host}:${port}: ${err.message}`);
    process.exit(1);
  }
  console.log(editorLinkFile ? `[server] editor link saved to ${editorLinkFile} (mode 0600)` : `[server] editor link: ${editorLink}`);
  console.log('[server] open that link once; it unlocks the fal key, generation settings and agents in that browser.');
  console.log(`[server] listening on http://${host}:${port} (public: ${publicDir})`);
});

// Endpoint discovery must not delay the loopback listener.
void generation.checkEndpoints().catch(() => console.warn('Could not check fal generation endpoints.'));
