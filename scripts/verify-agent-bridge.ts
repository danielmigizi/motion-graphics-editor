// End-to-end check of the agent bridge with nothing faked: a real MCP client
// launches mcp/server.ts over stdio, the MCP server starts the editor and local
// server, headless Chrome opens the editor, and every tool's effect is checked
// in the live page.
//
//   npm run verify:agent -- [--out <dir>] [--web-port 5417] [--server-port 5418] [--chat]
//
// For running servers, pass --editor-link <url> or set MGE_EDITOR_LINK.
// --chat also drives the in-editor chat with the real Claude Code (uses the
// logged-in subscription): a text request and an image attachment.
//
// Use ports nothing else listens on: the dev servers it starts keep running
// afterwards (stop them with the printed command). The test project it creates
// is deleted at the end. DEBUG_BRIDGE=1 logs the page's bridge traffic.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { chromium, type Page } from 'playwright-core';
import { deepEqual } from '../src/core/diff';
import { exampleProject } from '../src/core/guide';
import { createProjectStore } from '../server/projects';
import { redactEditorSecrets, requiredBridgeToolsPresent } from './bridge-verification';
import { configDir } from '../server/generation/config';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const rootDir = fileURLToPath(new URL('..', import.meta.url));
const webPort = opt('web-port', '5417');
const serverPort = opt('server-port', '5418');
const outDir = resolve(opt('out', join(rootDir, 'renders', 'verify-agent')));
const suppliedEditorLink = opt('editor-link', process.env.MGE_EDITOR_LINK ?? '');
const editorUrl = `http://localhost:${webPort}/`;
const projectId = `prj_e2e_${Date.now().toString(36)}`;

type ToolContent = { type: string; text?: string; data?: string };
let step = 0;
function ok(msg: string) {
  console.log(`  ✓ ${++step}. ${redactEditorSecrets(msg)}`);
}
function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`FAILED: ${redactEditorSecrets(msg)}`);
}

async function state<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(`(() => { const s = window.__mge.getState(); return (${fn})(s); })()`) as Promise<T>;
}

async function main() {
  await mkdir(outDir, { recursive: true });
  const client = new Client({ name: 'verify-agent-bridge', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: 'npx',
      args: ['--no-install', 'tsx', 'mcp/server.ts'],
      cwd: rootDir,
      env: { ...process.env, MGE_WEB_PORT: webPort, MGE_SERVER_PORT: serverPort, MGE_OPEN_BROWSER: '0' } as Record<string, string>,
      stderr: 'ignore',
    }),
  );
  const call = async (name: string, a: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: a }, undefined, { timeout: 180000 })) as { content: ToolContent[]; isError?: boolean };
    const text = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
    return { ...r, text };
  };

  const tools = (await client.listTools()).tools.map((t) => t.name).sort();
  check(requiredBridgeToolsPresent(tools), `missing required tools; got ${tools.join(', ')}`);
  ok(`MCP server lists ${tools.length} tools`);

  const serverWasRunning = await fetch(`http://127.0.0.1:${serverPort}/api/health`).then(() => true, () => false);
  const opened = await call('editor_open');
  if (!serverWasRunning) {
    check(!opened.isError && /no browser tab is connected/.test(opened.text), `editor_open without a browser: ${opened.text}`);
    ok(`editor_open started the editor and reports no tab yet`);
  } else {
    // An editor that was already running may have its unlocked tab open: it approves a minted --editor-link.
    check(!opened.isError, `editor_open on a running editor: ${opened.text}`);
    ok(`editor_open found the running editor`);
  }

  const browser = await chromium.launch({ channel: 'chrome' });
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    if (process.env.DEBUG_BRIDGE) {
      page.on('request', (r) => {
        if (r.url().includes('/api/editor/')) console.log('   [page]', r.method(), redactEditorSecrets(r.url().replace(editorUrl, '/')), redactEditorSecrets(r.postData() ?? '').slice(0, 120));
      });
      page.on('console', (m) => console.log('   [console]', m.type(), redactEditorSecrets(m.text()).slice(0, 200)));
    }
    // These flows check immediate application; the proposal review flow has its own checks.
    await page.addInitScript(() => localStorage.setItem('mge.autoApply', 'true'));
    // MCP stores the editor link outside the agent-readable dev log.
    const link = suppliedEditorLink || (!serverWasRunning
      ? (await readFile(join(configDir(), `editor-link-${serverPort}`), 'utf8')).trim()
      : undefined);
    check(link, 'Pass --editor-link <url> or MGE_EDITOR_LINK when using running servers.');
    await page.goto(link);
    if (serverWasRunning) {
      // A minted link: the unlocked tab asks to allow this browser. Show the pairing code to compare (never the link).
      const code = await page.waitForSelector('.pairing-code', { timeout: 10000 }).then((el) => el.textContent(), () => null);
      if (code) console.log(`   Allow this browser in the unlocked editor tab only if its card shows the code ${code}.`);
    }
    // Up to the claim's own approval window when a person has to allow it.
    await page.waitForSelector('[data-testid="agent-link-status"].up', { timeout: serverWasRunning ? 135000 : 30000 });
    ok('editor tab shows the agent link as connected');
    check(await page.isVisible('[data-testid="editor"]'), 'the editor shell is on screen');
    check(await page.isVisible('[data-testid="chat-input"]'), 'the chat column is always visible');
    ok('the editor opens with the chat beside the stage');

    const reopened = await call('editor_open');
    check(/Editor connected/.test(reopened.text), reopened.text);
    ok('editor_open now reports the connected tab');

    const draft = { ...exampleProject(), id: projectId, name: 'E2E bridge draft' };
    const written = await call('editor_write_project', { project: draft });
    check(!written.isError, written.text);
    await page.waitForFunction(`window.__mge.getState().doc.project.id === '${projectId}'`, undefined, { timeout: 10000 });
    ok('editor_write_project saved the draft and the editor opened it');
    const savedPath = join(rootDir, 'projects', `${projectId}.json`);
    const explicitBeforeEdits = await readFile(savedPath, 'utf8');

    const ctx = JSON.parse((await call('editor_get_context')).text);
    check(ctx.project?.id === projectId && ctx.scenes?.[0]?.elements[0]?.id === 'el_headline', `context describes the draft: ${JSON.stringify(ctx.project)}`);
    ok(`editor_get_context sees ${ctx.project.id} at r${ctx.project.revision}`);
    await page.waitForSelector('[data-testid="agent-link-status"].busy', { timeout: 3000 });
    ok('the Claude status shows that Claude is looking at the project');

    const patched = await call('editor_apply_patch', {
      baseRevision: ctx.project.revision,
      summary: 'Sharper headline',
      targets: [{ sceneId: 'scn_open', elementId: 'el_headline' }],
      commands: [{ type: 'updateElement', sceneId: 'scn_open', elementId: 'el_headline', changes: { props: { text: 'Patched live by the agent', fontSize: 120 } } }],
    });
    check(!patched.isError && /Applied as r/.test(patched.text), patched.text);
    const live = await state<{ text: string; fontSize: number }>(page, "s => s.doc.project.scenes[0].elements[0].props");
    check(live.text === 'Patched live by the agent' && live.fontSize === 120, `page shows the patch: ${JSON.stringify(live)}`);
    await page.waitForSelector('[data-testid="agent-status"] >> text=Sharper headline', { timeout: 5000 });
    check((await state<string | null>(page, 's => s.selection.elementId')) === 'el_headline', 'the changed element is selected');
    await page.waitForSelector('[data-testid="inspector"]', { timeout: 3000 });
    await page.screenshot({ path: join(outDir, 'after-patch.png') });
    ok('editor_apply_patch changed the document, shows in the agent status line, and selects what changed (the inspector opens)');

    // Move focus out of any field without clicking the canvas (an empty-canvas click deselects).
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press('Control+z');
    check((await state<string>(page, 's => s.doc.project.scenes[0].elements[0].props.text')) === 'Ship the brief, not the backlog', 'undo reverts the agent patch');
    await page.keyboard.press('Control+Shift+z');
    check((await state<string>(page, 's => s.doc.project.scenes[0].elements[0].props.text')) === 'Patched live by the agent', 'redo re-applies it');
    ok('the agent patch is one undo step in the editor (undo + redo)');

    const field = page.locator('[data-testid="inspector-text"]');
    await field.click();
    await field.fill('Edited by hand in the inspector');
    await page.keyboard.press('Control+Enter');
    check((await state<string>(page, 's => s.doc.project.scenes[0].elements[0].props.text')) === 'Edited by hand in the inspector', 'inspector text edit committed');
    await page.waitForSelector('[data-testid="agent-status"] >> text=Set text · “Headline”', { timeout: 3000 });
    await page.waitForSelector('[data-testid="agent-status"] >> text=You', { timeout: 3000 });
    ok('editing text in the inspector column works and shows as "You" in the agent status line');

    await page.waitForSelector('[data-testid="save-status"] >> text=Saved', { timeout: 6000 });
    const projects = createProjectStore(join(rootDir, 'projects'));
    const latest = (await projects.journal(projectId))[0];
    check(latest, 'autosave created a journal entry');
    const entry = await projects.journalEntry(projectId, latest.id);
    const liveProject = await state<typeof draft>(page, 's => s.doc.project');
    check(entry?.file.project.revision === liveProject.revision, 'latest journal entry has the live revision');
    check(deepEqual(entry.file.project, liveProject), 'latest journal entry contains the live project');
    check(await readFile(savedPath, 'utf8') === explicitBeforeEdits, 'autosave preserved the explicit saved file');
    ok(`autosave journal contains live r${liveProject.revision} and preserves the explicit saved file`);

    await page.click('[data-testid="approve-scn_open"]');
    check((await state<boolean>(page, 's => s.doc.project.scenes[0].locked')) === true, 'scene approved');
    const blocked = await call('editor_apply_patch', {
      baseRevision: await state<number>(page, 's => s.doc.project.revision'),
      summary: 'Should be blocked',
      targets: [{ sceneId: 'scn_open', elementId: 'el_headline' }],
      commands: [{ type: 'updateElement', sceneId: 'scn_open', elementId: 'el_headline', changes: { props: { fontSize: 90 } } }],
    });
    check(blocked.isError && /\[LOCKED\]/.test(blocked.text), blocked.text);
    await page.click('[data-testid="approve-scn_open"]');
    check((await state<boolean>(page, 's => s.doc.project.scenes[0].locked')) === false, 'scene reopened');
    ok('the ✓ in the scene strip approves a scene, and Claude cannot change it until reopened');

    const stale = await call('editor_apply_patch', {
      baseRevision: ctx.project.revision,
      summary: 'Stale',
      targets: [{ sceneId: 'scn_open', elementId: 'el_headline' }],
      commands: [{ type: 'updateElement', sceneId: 'scn_open', elementId: 'el_headline', changes: { props: { fontSize: 90 } } }],
    });
    check(stale.isError && /\[STALE\]/.test(stale.text), stale.text);
    ok('a patch based on an old revision is rejected as STALE');

    await page.evaluate(`window.__mge.getState().selectElement('scn_open', 'el_headline')`);
    // Notes left through the editor's advanced queue still reach the agent.
    await page.evaluate(`window.__mge.getState().addRequest('Make it warmer')`);
    await new Promise((r) => setTimeout(r, 500));
    const withReq = JSON.parse((await call('editor_get_context')).text);
    check(withReq.notes.length === 1 && withReq.notes[0].instruction === 'Make it warmer', 'queued request visible to the agent');
    const answered = await call('editor_apply_patch', {
      baseRevision: withReq.project.revision,
      summary: 'Warmer headline',
      targets: [withReq.notes[0].target],
      commands: [{ type: 'updateElement', sceneId: 'scn_open', elementId: 'el_headline', changes: { props: { color: '#FFD8A8' } } }],
    });
    check(!answered.isError, answered.text);
    check((await state<number>(page, 's => s.requests.length')) === 0, 'request cleared after the patch answered it');
    ok('a note from the editor reaches the agent and clears once answered');

    await page.evaluate(`window.__mge.getState().selectElement('scn_open', null)`);
    const focused = await call('editor_focus', { elementId: 'el_headline' });
    check(!focused.isError, focused.text);
    check((await state<string | null>(page, 's => s.selection.elementId')) === 'el_headline', 'editor selected the element');
    ok(`editor_focus selected the element (${focused.text})`);

    const t0 = Date.now();
    const frames = await call('editor_render_frame', { frames: [10, 60] });
    check(!frames.isError, frames.text);
    const images = frames.content.filter((c) => c.type === 'image');
    check(images.length === 2, 'two images returned');
    for (const [i, img] of images.entries()) {
      const buf = Buffer.from(img.data!, 'base64');
      check(buf.subarray(1, 4).toString() === 'PNG' && buf.readUInt32BE(16) === 960 && buf.readUInt32BE(20) === 540, 'PNG at 960x540');
      await writeFile(join(outDir, `frame-${i}.png`), buf);
    }
    ok(`editor_render_frame returned 2 real 960×540 frames in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

    if (args.includes('--chat')) {
      await page.evaluate(`window.__mge.getState().selectElement('scn_open', null)`);
      const t1 = Date.now();
      await page.fill('[data-testid="chat-input"]', 'Change the background colour of this scene to #1E3A8A.');
      await page.click('[data-testid="chat-send"]');
      await page.waitForSelector('.c-agent.done, .c-agent.error', { timeout: 240000 });
      const err1 = await page.locator('.c-agent.error .c-error').allTextContents();
      check(err1.length === 0, `chat turn failed: ${err1.join(' ')}`);
      check((await state<string>(page, 's => s.doc.project.scenes[0].backgroundColor')).toUpperCase() === '#1E3A8A', 'chat changed the scene background');
      await page.screenshot({ path: join(outDir, 'chat-turn.png') });
      ok(`chat: a typed request was carried out by Claude Code in ${((Date.now() - t1) / 1000).toFixed(0)} s`);

      const t2 = Date.now();
      await page.setInputFiles('[data-testid="chat-file"]', join(rootDir, 'public', 'assets', 'product-screenshot.png'));
      await page.waitForSelector('.c-composer .c-attach', { timeout: 15000 });
      await page.fill('[data-testid="chat-input"]', 'Add the attached image to this scene as a small image in the top-right corner.');
      await page.click('[data-testid="chat-send"]');
      await page.waitForFunction(`document.querySelectorAll('.c-agent.done, .c-agent.error').length >= 2`, undefined, { timeout: 240000 });
      const err2 = await page.locator('.c-agent.error .c-error').allTextContents();
      check(err2.length === 0, `chat turn failed: ${err2.join(' ')}`);
      const imgs = await state<number>(page, "s => s.doc.project.scenes[0].elements.filter(e => e.type === 'image').length");
      check(imgs >= 1, 'chat added the attached image');
      await page.screenshot({ path: join(outDir, 'chat-attachment.png') });
      ok(`chat: an attached image was added to the scene in ${((Date.now() - t2) / 1000).toFixed(0)} s`);
      const chatFile = join(rootDir, 'chats', `${projectId}.json`);
      if (existsSync(chatFile)) await rm(chatFile);
    }

    // Templates and presets reach agents as ready patches built against the live project.
    const built = await call('editor_build_template', { template: 'backdrop', sceneId: 'scn_open', params: { kind: 'grid' } });
    check(!built.isError, built.text);
    const builtPatch = JSON.parse(built.text.trim().split('\n').at(-1)!);
    check(builtPatch.baseRevision === (await state<number>(page, 's => s.doc.project.revision')), `built against the live revision: ${builtPatch.baseRevision}`);
    const placed = await call('editor_apply_patch', builtPatch);
    check(!placed.isError && /Applied as r/.test(placed.text), placed.text);
    check((await state<string>(page, "s => s.doc.project.scenes[0].elements[0].name")) === 'Backdrop texture', 'the backdrop sits under the scene');
    const moved = await call('editor_build_motion', { preset: 'pulse', sceneId: 'scn_open', elementIds: ['el_headline'] });
    check(!moved.isError, moved.text);
    const pulsed = await call('editor_apply_patch', JSON.parse(moved.text.trim().split('\n').at(-1)!));
    check(!pulsed.isError && /Applied as r/.test(pulsed.text), pulsed.text);
    ok('editor_build_template / editor_build_motion returned patches the editor applied as is');

    const saved = await call('editor_save');
    check(!saved.isError, saved.text);
    check((await state<boolean>(page, 's => s.doc.project.revision === s.cleanRevision')) === true, 'editor marked clean');
    const explicitlySaved = JSON.parse(await readFile(savedPath, 'utf8')) as { project: typeof draft };
    const savedLiveProject = await state<typeof draft>(page, 's => s.doc.project');
    check(explicitlySaved.project.revision === savedLiveProject.revision, 'editor_save wrote the updated revision to the explicit saved file');
    check(deepEqual(explicitlySaved.project, savedLiveProject), 'editor_save wrote the live project');
    ok(`editor_save wrote r${savedLiveProject.revision} to the explicit saved file: ${saved.text}`);
  } finally {
    await browser.close();
    await client.close();
    const file = join(rootDir, 'projects', `${projectId}.json`);
    if (existsSync(file)) await rm(file);
    await rm(join(rootDir, 'projects', `${projectId}.journal`), { recursive: true, force: true });
  }
  console.log(`\nAll ${step} checks passed. Screenshots and frames: ${outDir}`);
  console.log(`Dev servers on :${webPort}/:${serverPort} are still running; stop them with: fuser -k ${webPort}/tcp ${serverPort}/tcp`);
}

main().catch((e) => {
  console.error(redactEditorSecrets(e instanceof Error ? e.message : String(e)));
  process.exit(1);
});
