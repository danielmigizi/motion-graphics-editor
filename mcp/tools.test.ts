// MCP tool handlers against the real local server app and a fake editor tab.

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BridgeReply, EditorContext, FrameIdentity, ProposalSummary, RenderJob, RenderManifest } from '../src/core/api-contract';
import { fixtureProject } from '../src/core/__fixtures__/fixtureProject';
import { exampleProject } from '../src/core/guide';
import { createDocState, loadDoc } from '../src/core/history';
import type { ProjectFile } from '../src/core/types';
import { createApp } from '../server/app';
import { EditorSession } from '../server/session';
import { createKeyStore, GenerationSettingsStore } from '../server/generation/config';
import { createFalClient } from '../server/generation/fal';
import { cachedGenerationKeys, createGenerationService, type GenerationService } from '../server/generation/jobs';
import { GenerationRecords } from '../server/generation/records';
import { GenerationLog } from '../server/generation-log';
import { JOB_KINDS } from '../src/core/generationStudio';
import { MODELS, modelsResponse } from '../src/core/generationRoutes';
import { newId } from '../src/core/ids';
import { EditorBridge } from '../server/bridge';
import { OpenverseError } from '../server/openverse';
import { createProjectStore } from '../server/projects';
import { RenderManager } from '../server/renders';
import { OPENVERSE_NOTICE } from '../src/core/openverseLicense';
import type { OpenverseAudioHit, OpenverseImportResponse, OpenverseSearchResponse } from '../src/core/api-contract';
import { projectHash } from '../server/manifest';
import { connectFakeEditor, contextFor, type FakeEditor } from '../server/testing/fakeEditor';
import { LocalApiError, LocalEditor } from './local';
import { createHandlers, describeContext, schemas, type ToolResult } from './tools';
import { z } from 'zod';
import { wav } from '../scripts/make-sfx';

// Smallest valid PNG (1×1).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const session = new EditorSession({ token: 'mcp-test' });
const credentials = session.claim('mcp-test')!;
const cookie = `${session.cookieName}=${credentials.sessionId}`;
const tabSecret = credentials.tabSecret;
let root: string;
let server: Server;
let port: number;
let h: ReturnType<typeof createHandlers>;
let generation: GenerationService;
let holdGeneration = false;
const GENERATION_KEY = 'fal_LEAKSENTINEL_mcp_0123456789';
const bridge = new EditorBridge({ timeoutMs: 2000, heartbeatMs: 60000 });
const editors: FakeEditor[] = [];

const ovHit: OpenverseAudioHit = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Calm pad',
  creator: 'Ada',
  durationSeconds: 24,
  license: 'cc0',
  licenseVersion: '1.0',
  attribution: '"Calm pad" by Ada is licensed under CC0.',
  category: 'music',
  previewUrl: 'https://cdn.example.com/calm.mp3',
  foreignLandingUrl: 'https://www.jamendo.com/track/1',
  tags: ['ambient'],
};
const ovNcId = '22222222-2222-4222-8222-222222222222';
const fakeOpenverse = {
  searchAudio: async (): Promise<OpenverseSearchResponse> => ({
    results: [ovHit],
    page: 1,
    pageCount: 1,
    resultCount: 1,
    authenticated: false,
    notice: OPENVERSE_NOTICE,
  }),
  getAudio: async (id: string): Promise<OpenverseAudioHit> => {
    if (id.includes('2222') || id === ovNcId) throw new OpenverseError('License "by-nc-sa" is not allowed. This editor only uses CC0 and CC BY (no NC, SA, ND, or other terms).', { status: 403, code: 'LICENSE' });
    return ovHit;
  },
  importAudio: async (): Promise<OpenverseImportResponse> => ({
    src: 'assets/uploads/openverse/11111111-1111-4111-8111-111111111111.mp3',
    name: ovHit.title,
    mimeType: 'audio/mpeg',
    kind: 'audio',
    durationSeconds: 24,
    cached: false,
    work: ovHit,
    notice: OPENVERSE_NOTICE,
  }),
  status: () => ({ authenticated: false, apiBase: 'https://api.openverse.org/v1', notice: OPENVERSE_NOTICE }),
};

const textOf = (r: ToolResult) => r.content.filter((c) => c.type === 'text').map((c) => (c as { text: string }).text).join('\n');
const patchArgs = {
  baseRevision: fixtureProject.revision,
  summary: 'Bigger headline',
  targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }],
  commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 120 } } }],
};
const outlineArgs = {
  title: 'Relay in 30 seconds',
  scenes: [
    { name: 'Hook', purpose: 'Name the pain', durationSeconds: 4, onScreenText: 'Nobody reads release notes' },
    { name: 'Product', purpose: 'Show the brief', durationSeconds: 18, templateHints: ['featureCallout'] },
    { name: 'Outro', purpose: 'Call to action', durationSeconds: 8 },
  ],
};
const proposal = (over: Partial<ProposalSummary> = {}): ProposalSummary => ({
  id: 'proposal_1', projectId: fixtureProject.id, agent: 'Claude Code', source: 'mcp', summary: 'Bigger headline',
  baseRevision: fixtureProject.revision, status: 'pending', createdAt: 1000, ...over,
});

/** Fake editor that really opens projects from the server, like the editor's openFromServer. */
const connect = async (project = fixtureProject, dirty = false) => {
  const ed = await connectFakeEditor(port, project, { Cookie: cookie, 'X-MGE-Tab': tabSecret }, async (cmd, self) => {
    if (cmd.type === 'askPermission') return { ok: true, message: self.permissionDecision };
    if (cmd.type === 'openProject') {
      const res = await fetch(`http://127.0.0.1:${port}/api/projects/${cmd.projectId}`);
      const r = loadDoc((await res.json()) as ProjectFile);
      if (!r.ok) return { ok: false, error: r.error };
      self.doc = r.state;
      self.docSession = `opened-${cmd.projectId}-${Date.now()}`;
      return { ok: true, revision: r.state.project.revision, projectId: r.state.project.id };
    }
    if (cmd.type === 'applyPatch') {
      const { applyPatch } = await import('../src/core/patch');
      const r = applyPatch(self.doc, cmd.patch, { reconcile: cmd.reconcile });
      if (!r.ok) return { ok: false, error: r.error };
      self.doc = r.state;
      return { ok: true, revision: r.state.project.revision, projectId: r.state.project.id, changes: [] };
    }
    return { ok: true, revision: self.doc.project.revision, projectId: self.doc.project.id, message: 'ok' };
  });
  if (dirty) await ed.report({ dirty: true });
  editors.push(ed);
  return ed;
};

describe('MCP tools over HTTP', () => {
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'mge-mcp-'));
    const configDir = join(root, 'generation');
    const keys = cachedGenerationKeys(createKeyStore({ dir: configDir, env: {}, keychain: { get: async () => null, set: async () => false, remove: async () => undefined } }));
    const prices = Object.fromEntries(Object.values(MODELS).flatMap((model) => Object.values(model.endpoints).map((endpoint) => [endpoint, model.price])));
    let sequence = 0;
    const fetchFake: typeof fetch = async (raw, init) => {
      const url = new URL(String(raw));
      const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
      if (url.pathname.endsWith('/models/pricing')) return json({ prices: (url.searchParams.get('endpoint_id') ?? '').split(',').map((id) => ({ endpoint_id: id, unit_price: prices[id]?.usd ?? 0.025, unit: prices[id]?.unit ?? 'units', currency: 'USD' })) });
      if (url.pathname.endsWith('/models/billing-events')) return json({ detail: 'Billing permission is unavailable.' }, 403);
      if (init?.method === 'POST') {
        const id = `request_${++sequence}`;
        return json({ request_id: id, status_url: `https://queue.fal.run/requests/${id}/status`, response_url: `https://queue.fal.run/requests/${id}`, cancel_url: `https://queue.fal.run/requests/${id}/cancel` });
      }
      if (url.pathname.endsWith('/cancel')) return json({});
      if (url.pathname.endsWith('/status')) return json({ status: holdGeneration ? 'IN_PROGRESS' : 'COMPLETED' });
      return json({ images: [{ url: 'https://cdn.example.com/kite.png', width: 1, height: 1 }], seed: 42 });
    };
    const fal = createFalClient({ key: async () => (await keys.get())?.key ?? null, fetch: fetchFake, env: {} });
    generation = createGenerationService({ fal, keys, records: new GenerationRecords({ dir: configDir }), settings: new GenerationSettingsStore({ dir: configDir }),
      log: new GenerationLog({ dir: configDir }), publicDir: join(root, 'public'), project: () => bridge.state().project, emit: () => undefined,
      askPermission: async (ask, signal) => {
        const reply = await bridge.send({ type: 'askPermission', requestId: newId('req'), ...ask }, undefined, signal);
        return reply.ok && reply.message === 'allowed' ? 'allowed' : 'denied';
      },
      falFactory: (opts) => createFalClient({ ...opts, fetch: fetchFake, env: {} }),
      importOptions: { lookup: async () => [{ address: '93.184.216.34', family: 4 }], connect: async () => ({ status: 200, headers: {}, body: Readable.from([PNG]) }), probe: async () => null }, pollMs: 1,
    });
    await generation.setKey(GENERATION_KEY);
    const brandHtml = Buffer.from(`<!doctype html><html><head>
      <title>Acme Solar</title>
      <style>:root { --bg: #f5f4f0; --primary: #58ad80; --text: #15171c; }</style>
    </head><body><header><svg class="logo" xmlns="http://www.w3.org/2000/svg"><circle cx="2" cy="2" r="1"/></svg></header></body></html>`);
    const app = createApp({
      session,
      generation,
      publicDir: join(root, 'public'),
      rendersDir: join(root, 'renders'),
      projects: createProjectStore(join(root, 'projects')),
      renders: new RenderManager({ rendersDir: join(root, 'renders'), renderer: async () => undefined }),
      bridge,
      openverse: fakeOpenverse,
      urlImport: {
        lookup: async () => [{ address: '93.184.216.34', family: 4 }],
        connect: async () => ({ status: 200, headers: { 'content-type': 'text/html', 'content-length': String(brandHtml.length) }, body: Readable.from([brandHtml]) }),
      },
      renderStill: async ({ outputPath }) => writeFile(outputPath, PNG),
      renderContactSheet: async ({ outputPath }) => writeFile(outputPath, PNG),
    });
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', () => resolve());
      server.once('error', reject);
    });
    port = (server.address() as AddressInfo).port;
    h = createHandlers(new LocalEditor({ rootDir: root, serverPort: port, webPort: 1, openBrowser: false }));
  });

  afterEach(async () => {
    if (generation) {
      for (const job of generation.list()) await generation.cancel(job.id);
      await generation.updateSettings({ dailyBudgetUsd: 5 });
      holdGeneration = false;
    }
    editors.splice(0).forEach((e) => e.close());
    await new Promise((r) => setTimeout(r, 30));
  });

  afterAll(async () => {
    bridge.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  });

  describe('reading', () => {
    it('explains how to recover when no editor is connected', async () => {
      const r = await h.editor_get_context();
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/editor_open/);
    });

    it('describes the selection, playhead and notes', async () => {
      const ed = await connect();
      await ed.report({
        selection: { sceneId: 'scn_intro', elementId: 'el_intro_headline' },
        playhead: 118,
        requests: [{ id: 'req_1', sceneId: 'scn_intro', elementId: 'el_intro_headline', instruction: 'Punchier', frame: 118 }],
      });
      const ctx = JSON.parse(textOf(await h.editor_get_context()));
      expect(ctx.project).toMatchObject({ id: 'prj_sample', revision: fixtureProject.revision, unsavedChanges: false });
      expect(ctx.playhead).toMatchObject({ frame: 118, timecode: '0:03:28', sceneId: 'scn_intro', sceneFrame: 118 });
      expect(ctx.selection.element).toMatchObject({ id: 'el_intro_headline', elementFrame: 98 });
      expect(ctx.notes[0]).toMatchObject({ instruction: 'Punchier', elementName: 'Headline', target: { sceneId: 'scn_intro', elementId: 'el_intro_headline' } });
      expect(ctx.scenes.map((s: { id: string }) => s.id)).toEqual(['scn_intro', 'scn_product', 'scn_outro']);
    });

    it('includes proposal settings and at most five outcomes, omitting missing legacy fields', async () => {
      const ed = await connect();
      const log = Array.from({ length: 7 }, (_, i) => proposal({ id: `p_${i}`, status: 'cancelled', decidedAt: 2000 }));
      await ed.report({ autoApply: false, proposal: proposal(), proposalLog: log });
      const ctx = JSON.parse(textOf(await h.editor_get_context()));
      expect(ctx).toMatchObject({ autoApply: false, proposal: proposal(), recentProposals: log.slice(0, 5) });
      await ed.report({ proposal: null });
      expect(JSON.parse(textOf(await h.editor_get_context())).proposal).toBeNull();
      const state = bridge.state();
      const legacy = { ...state.context! };
      Reflect.deleteProperty(legacy, 'autoApply');
      Reflect.deleteProperty(legacy, 'proposal');
      Reflect.deleteProperty(legacy, 'proposalLog');
      const described = describeContext({ ...state, context: legacy, project: fixtureProject }, 'http://editor');
      for (const key of ['autoApply', 'proposal', 'recentProposals']) expect(described).not.toHaveProperty(key);
    });
  });

  describe('editing', () => {
    it('applies a patch and reports the new revision', async () => {
      const ed = await connect();
      const r = await h.editor_apply_patch({
        baseRevision: fixtureProject.revision,
        summary: 'Bigger headline',
        targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }],
        commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 120 } } }],
      });
      expect(r.isError).toBeUndefined();
      expect(textOf(r)).toContain(`Applied as r${fixtureProject.revision + 1}`);
      expect(ed.doc.project.scenes[0].elements.find((e) => e.id === 'el_intro_headline')?.props.fontSize).toBe(120);
      expect(ed.commands[0]).toMatchObject({ type: 'applyPatch', agent: 'Claude Code', mode: 'auto' });
    });

    it('reports explicit applied replies as well as legacy revision replies', async () => {
      const ed = await connectFakeEditor(port, fixtureProject, { Cookie: cookie, 'X-MGE-Tab': tabSecret });
      editors.push(ed);
      expect(textOf(await h.editor_apply_patch(patchArgs))).toMatch(/Applied as r\d+ \(1 change\)/);
    });

    it('reports proposed and replaced edits without committing them', async () => {
      const ed = await connectFakeEditor(port, fixtureProject, { Cookie: cookie, 'X-MGE-Tab': tabSecret });
      editors.push(ed);
      await ed.report({ autoApply: false });
      const result = textOf(await h.editor_apply_patch(patchArgs));
      expect(result).toContain(`proposal ${ed.proposal!.id}, based on r${fixtureProject.revision}`);
      expect(result).toContain('Nothing has changed in the project yet.');
      expect(result).toContain('editor_proposal_status or editor_get_context');
      expect(result).toContain('→ 120');
      expect(result).not.toContain('Applied as');
      const replaced = textOf(await h.editor_apply_patch({ ...patchArgs, summary: 'Even bigger headline' }));
      expect(replaced).toContain('Replaced your earlier pending proposal "Bigger headline".');
      expect(ed.doc.project).toEqual(fixtureProject);
    });

    it('always sends propose mode, even with Auto-apply enabled', async () => {
      const ed = await connectFakeEditor(port, fixtureProject, { Cookie: cookie, 'X-MGE-Tab': tabSecret });
      editors.push(ed);
      expect(textOf(await h.editor_propose_patch({ ...patchArgs, reconcile: true }))).toContain('Proposed — awaiting');
      expect(ed.commands[0]).toMatchObject({ mode: 'propose', reconcile: true });
      expect(ed.doc.project).toEqual(fixtureProject);
    });

    it('passes the MCP model credit into both patch commands', async () => {
      vi.stubEnv('MGE_AGENT_MODEL', 'gpt-test');
      vi.stubEnv('MGE_AGENT_LABEL', 'Codex');
      vi.resetModules();
      try {
        const { createHandlers: withModel } = await import('./tools');
        const ed = await connectFakeEditor(port, fixtureProject, { Cookie: cookie, 'X-MGE-Tab': tabSecret });
        editors.push(ed);
        const credited = withModel(new LocalEditor({ rootDir: root, serverPort: port, webPort: 1, openBrowser: false }));
        await credited.editor_propose_patch(patchArgs);
        await credited.editor_apply_patch(patchArgs);
        expect(ed.commands).toHaveLength(2);
        for (const cmd of ed.commands) expect(cmd).toMatchObject({ model: 'gpt-test', agent: 'Codex' });
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    });

    it('proposes an outline for the user to review without creating anything', async () => {
      const ed = await connect();
      const r = await h.editor_propose_outline(outlineArgs);
      expect(r.isError, textOf(r)).toBeUndefined();
      expect(textOf(r)).toContain(`Outline proposed — awaiting the user's review in the editor ("Relay in 30 seconds": 3 scenes, 30 s)`);
      expect(textOf(r)).toContain('editor_get_context (field "outline"');
      expect(ed.commands).toEqual([{ type: 'proposeOutline', agent: 'Claude Code', outline: { title: outlineArgs.title, scenes: outlineArgs.scenes } }]);
      expect(ed.doc.project).toEqual(fixtureProject);
    });

    it('surfaces editor rejections with code and hint', async () => {
      await connect();
      const r = await h.editor_apply_patch({
        baseRevision: fixtureProject.revision,
        summary: 'Sneaky',
        targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }],
        commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_sub', changes: { name: 'x' } }],
      });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('[OUT_OF_SCOPE]');
    });
  });

  describe('editor_proposal_status', () => {
    it('formats pending and every decided status, with ids, credits and ISO decision times', async () => {
      const ed = await connect();
      await ed.report({ proposal: proposal(), proposalLog: [
        proposal({ id: 'p_applied', status: 'applied', revision: 14, decidedAt: 2000 }),
        proposal({ id: 'p_cancelled', status: 'cancelled', decidedAt: 3000 }),
        proposal({ id: 'p_stale', status: 'stale', reason: 'The title changed.', decidedAt: 4000 }),
        proposal({ id: 'p_replaced', status: 'replaced', reason: 'Newer edit.', decidedAt: 5000 }),
      ] });
      const result = textOf(await h.editor_proposal_status({}));
      for (const line of ['proposal_1 (Claude Code) "Bigger headline" [pending]', "Still waiting for the user's review", 'Applied by the user as r14', 'Declined by the user (cancelled)', 'Stale: The title changed.', 'Replaced: Newer edit.', 'decidedAt 1970-01-01T00:00:02.000Z']) expect(result).toContain(line);
      const found = textOf(await h.editor_proposal_status({ proposalId: 'p_applied' }));
      expect(found).toContain('Applied by the user as r14');
      expect(found).not.toContain('p_cancelled');
      expect(textOf(await h.editor_proposal_status({ proposalId: 'missing' }))).toContain('Proposal missing was not found');
      expect(ed.commands).toEqual([]);
    });

    it('explains when no proposals have been reported', async () => {
      await connect();
      expect(textOf(await h.editor_proposal_status({}))).toContain('No pending proposal or recent proposal outcomes');
    });
  });

  describe('editor_write_project', () => {
    it('rejects an invalid project with the failing path', async () => {
      const bad = exampleProject();
      bad.scenes[0].elements[0].durationInFrames = 9999;
      const r = await h.editor_write_project({ project: bad as never });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('scenes[0].elements[0].durationInFrames');
    });

    it('saves and opens a new draft, then refuses to overwrite it silently', async () => {
      const ed = await connect();
      const draft = { ...exampleProject(), id: 'prj_draft_one' };
      const r = await h.editor_write_project({ project: draft as never });
      expect(textOf(r)).toContain('Saved and opened');
      expect(ed.doc.project.id).toBe('prj_draft_one');

      const again = await h.editor_write_project({ project: draft as never });
      expect(again.isError).toBe(true);
      expect(textOf(again)).toContain('overwrite: true');

      // Overwriting bumps the revision past the open document's, so old patches go stale.
      await ed.report();
      const over = await h.editor_write_project({ project: { ...draft, name: 'Draft v2' } as never, overwrite: true });
      expect(textOf(over)).toContain('Saved and opened');
      expect(ed.doc.project.name).toBe('Draft v2');
      expect(ed.doc.project.revision).toBe(2);
    });

    it('asks through the fake editor and never writes or opens after denial', async () => {
      const ed = await connect(fixtureProject, true);
      ed.permissionDecision = 'denied';
      const draft = { ...exampleProject(), id: 'prj_denied_draft' };
      const r = await h.editor_write_project({ project: draft as never, discardUnsaved: true });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('The user declined:');
      expect(ed.commands.map((c) => c.type)).toEqual(['askPermission']);
      expect(ed.doc.project.id).toBe(fixtureProject.id);
      const saved = await fetch(`http://127.0.0.1:${port}/api/projects/${draft.id}`);
      expect(saved.status).toBe(404);
    });

    it('will not replace a document with unsaved changes', async () => {
      await connect(fixtureProject, true);
      const r = await h.editor_write_project({ project: { ...exampleProject(), id: 'prj_draft_two' } as never });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/unsaved changes/);
    });
  });

  describe('looking and importing', () => {
    it('returns rendered frames as images', async () => {
      await connect();
      const r = await h.editor_render_frame({ frames: [0, 300] });
      const images = r.content.filter((c) => c.type === 'image');
      expect(images).toHaveLength(2);
      expect(Buffer.from((images[0] as { data: string }).data, 'base64').equals(PNG)).toBe(true);
      expect(textOf(r)).toContain('scene "Product"');
      expect(textOf(r)).toContain(`committed, r${fixtureProject.revision}, hash ${projectHash(fixtureProject).slice(0, 12)}, renderer`);
      expect((await h.editor_render_frame({ frames: [100000] })).isError).toBe(true);
    });

    it('uploads a local file and returns an asset object a patch accepts', async () => {
      const ed = await connect();
      const r = await h.editor_import_asset({ path: join(repoRoot, 'public/assets/logo.svg'), name: 'Logo' });
      expect(r.isError).toBeUndefined();
      const asset = JSON.parse(textOf(r).slice(textOf(r).indexOf('{')));
      expect(asset).toMatchObject({ kind: 'svg', name: 'Logo', mimeType: 'image/svg+xml' });
      expect(asset.id).toMatch(/^ast_/);
      expect(asset.src).toMatch(/^assets\/uploads\//);
      const applied = await h.editor_apply_patch({
        baseRevision: fixtureProject.revision,
        summary: 'Use the new logo',
        targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_logo' }],
        commands: [
          { type: 'addAsset', asset },
          { type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_logo', changes: { props: { assetId: asset.id } } },
        ],
      });
      expect(applied.isError).toBeUndefined();
      expect(ed.doc.project.assets[asset.id]).toMatchObject({ kind: 'svg' });
    });
  });

  describe('fal generation tools', () => {
    const outputs: ToolResult[] = [];
    const capture = (result: ToolResult) => { outputs.push(result); return result; };
    const generate = () => h.editor_generate({ job: 'image.cutout', prompt: 'A paper kite', settings: { aspectRatio: '1:1' } });

    it('lists every job kind, prices and configured status without key details', async () => {
      const result = capture(await h.editor_generation_models());
      expect(result.isError).toBeUndefined();
      const body = textOf(result);
      for (const job of JOB_KINDS) expect(body).toContain(job);
      expect(JOB_KINDS).toHaveLength(18);
      expect(body).toContain('Key configured: yes (configured)');
      expect(body).toMatch(/Route version:.*\nActive policy: quality\nToday's spend:.*daily budget/);
      expect(body).toContain('Default:');
      expect(body).toContain('Alternatives:');
      expect(body).not.toContain('last4');
      expect(body).not.toContain('6789');
    });

    it('requires an open project for generation and project job status', async () => {
      for (const result of [capture(await generate()), capture(await h.editor_generation_status({}))]) {
        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe('Open a project in the editor first (editor_open).');
      }
    });

    it('asks permission with an estimate, queues takes, and exposes completed asset ids without placing them', async () => {
      const editor = await connect();
      const result = capture(await generate());
      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toMatch(/Queued as gjob_/);
      expect(textOf(result)).toContain('editor_propose_patch (never without a proposal)');
      expect(editor.commands.find((command) => command.type === 'askPermission')).toMatchObject({ generation: { provider: 'fal', estimateUsd: 0.5 } });
      const id = /Job: (gjob_\S+)/.exec(textOf(result))![1];
      await vi.waitFor(() => expect(generation.get(id)?.status).toBe('done'), { timeout: 4000, interval: 5 });
      const asset = generation.get(id)!.outputs[0];
      const status = capture(await h.editor_generation_status({ jobId: id }));
      expect(status.isError).toBeUndefined();
      expect(textOf(status)).toContain('Status: done');
      expect(textOf(status)).toContain('Elapsed:');
      expect(textOf(status)).toContain('Estimate:');
      expect(textOf(status)).toContain('Actual cost:');
      expect(textOf(status)).toContain(`"id": "${asset.id}"`);
      expect(textOf(status)).toContain(`${asset.name} (image, 1×1); delivered: no`);
      expect(editor.doc.project.assets).not.toHaveProperty(asset.id);
      expect(editor.commands.some((command) => command.type === 'applyPatch')).toBe(false);
      expect(textOf(capture(await h.editor_generation_status({})))).toContain(id);
      generation.delivered(id);
      expect(textOf(capture(await h.editor_generation_status({ jobId: id })))).toContain('delivered: yes');
      const other = await connectFakeEditor(port, { ...structuredClone(fixtureProject), id: 'prj_other' }, { Cookie: cookie, 'X-MGE-Tab': tabSecret });
      editors.push(other);
      expect(textOf(capture(await h.editor_generation_status({})))).toBe('No generation jobs for the open project.');
    });

    it('reports declined permission', async () => {
      const editor = await connect();
      editor.permissionDecision = 'denied';
      const result = capture(await generate());
      expect(result.isError).toBeUndefined();
      expect(textOf(result)).toContain('Status: denied');
      expect(textOf(result)).toContain('The user declined:');
    });

    it('returns the server budget refusal without asking permission', async () => {
      const editor = await connect();
      await generation.updateSettings({ dailyBudgetUsd: 0 });
      const result = capture(await generate());
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain('over your $0.00 daily budget. Raise it in Settings › Generation.');
      expect(editor.commands.some((command) => command.type === 'askPermission')).toBe(false);
    });

    it('cancels a running job and reports missing jobs and invalid requests', async () => {
      await connect();
      holdGeneration = true;
      const result = capture(await generate());
      const id = /Job: (gjob_\S+)/.exec(textOf(result))![1];
      await vi.waitFor(() => expect(generation.get(id)?.status).toBe('running'), { interval: 5 });
      const cancelled = capture(await h.editor_cancel_generation({ jobId: id }));
      expect(cancelled.isError).toBeUndefined();
      expect(textOf(cancelled)).toContain('Status: cancelled');
      expect(textOf(capture(await h.editor_generation_status({ jobId: id })))).toContain('Status: cancelled');
      for (const missing of [capture(await h.editor_generation_status({ jobId: 'missing' })), capture(await h.editor_cancel_generation({ jobId: 'missing' }))]) {
        expect(missing.isError).toBe(true);
        expect(textOf(missing)).toBe('Generation job not found.');
      }
      const invalid = capture(await h.editor_generate({ job: 'image.cutout', prompt: '' }));
      expect(invalid.isError).toBe(true);
      expect(textOf(invalid)).toContain('prompt');
    });

    it('returns a clear no-key refusal', async () => {
      await connect();
      await generation.removeKey();
      try {
        const result = capture(await generate());
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain('No fal key is set. Add one in Settings › Generation.');
      } finally {
        await generation.setKey(GENERATION_KEY);
      }
    });

    it('keeps the sentinel key out of every captured tool output', () => {
      expect(outputs.length).toBeGreaterThan(15);
      for (const result of outputs) expect(textOf(result)).not.toContain(GENERATION_KEY);
    });
  });

  describe('Openverse audio tools', () => {
    it('search → add bed → list credits (agent-style sequence)', async () => {
      const ed = await connect();
      const search = await h.editor_search_audio({ query: 'calm ambient', kind: 'music', mood: 'calm', durationSeconds: 24 });
      expect(search.isError).toBeUndefined();
      const found = JSON.parse(textOf(search));
      expect(found.results[0]).toMatchObject({ id: ovHit.id, license: 'cc0', title: 'Calm pad' });
      expect(found.notice).toContain('Made with Openverse');
      expect(found.license).toMatch(/CC0 and CC BY/);

      const added = await h.editor_add_audio({ id: found.results[0].id, role: 'music', replaceExisting: true });
      expect(added.isError).toBeUndefined();
      expect(textOf(added)).toMatch(/Music bed/);
      expect(textOf(added)).toContain('Made with Openverse');
      const bed = Object.values(ed.doc.project.assets).find((a) => a.provenance?.source === 'openverse');
      expect(bed).toMatchObject({ kind: 'audio', provenance: { license: { spdxOrCc: 'cc0', openverseId: ovHit.id } } });
      expect(ed.doc.project.audio.some((c) => c.assetId === bed!.id && !c.sceneId)).toBe(true);
      expect(ed.doc.project.audio.some((c) => c.id === 'aud_music')).toBe(false);

      const credits = JSON.parse(textOf(await h.editor_list_credits()));
      expect(credits.madeWithOpenverse).toBe(true);
      expect(credits.lines.some((l: string) => l.includes('Ada'))).toBe(true);
      expect(credits.file).toContain('Made with Openverse');
    });

    it('refuses a non-CC0/CC BY work on inspect', async () => {
      await connect();
      const r = await h.editor_inspect_audio({ id: ovNcId });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/CC0 and CC BY|not allowed/i);
    });
  });

  describe('brand kit and reference video', () => {
    it('scans a mocked page and returns a style overlay without proposing', async () => {
      const r = await h.editor_scan_brand({ url: 'https://acme.test/about' });
      expect(r.isError).toBeUndefined();
      const body = JSON.parse(textOf(r));
      expect(body.kit).toMatchObject({ domain: 'acme.test', title: 'Acme Solar' });
      expect(body.kit.style.colors.accent).toBe('#4c9b71');
      expect(body.kit.logo?.kind).toBe('inline-svg');
      expect(body.apply.targets).toEqual([{ style: 'project' }]);
      expect(body.apply.commands.some((c: { type: string }) => c.type === 'setStyle')).toBe(true);
    });

    it('analyses a tiny local fixture and never imports it', async () => {
      const { execFileSync } = await import('node:child_process');
      const { mediaTool } = await import('../server/media-tools');
      const clip = join(root, 'tiny.mp4');
      const tool = mediaTool('ffmpeg');
      execFileSync(tool.cmd, [
        '-v', 'error', '-y',
        '-f', 'lavfi', '-i', 'color=c=0x58ad80:s=64x48:r=10:d=0.5',
        '-f', 'lavfi', '-i', 'color=c=0x0a1528:s=64x48:r=10:d=0.5',
        '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
        '-map', '[v]', '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        clip,
      ], { cwd: tool.cwd, env: tool.env });
      const r = await h.editor_analyze_reference({ path: clip });
      expect(r.isError).toBeUndefined();
      const body = JSON.parse(textOf(r));
      expect(body.specs).toMatchObject({ width: 64, height: 48 });
      expect(body.notice).toMatch(/absolute value/);
      expect(body.artifacts.some((a: { kind: string }) => a.kind === 'contact-sheet')).toBe(true);
      expect(body.source.resolvedPath).toBe(await realpath(clip));
    });
  });

  describe('audio and beats', () => {
    /** A 100 BPM click track (a beat every 0.6 s = 18 frames at 30 fps from frame 0), 48 kHz WAV. */
    const clicks = (seconds: number) => {
      const out = new Float32Array(seconds * 48000);
      for (let k = 0; k * 0.6 < seconds; k++) {
        const s0 = Math.round(k * 0.6 * 48000);
        for (let i = 0; i < 2400 && s0 + i < out.length; i++) out[s0 + i] += Math.sin(i / 4) * (k % 4 === 0 ? 0.9 : 0.5) * Math.exp(-i / 480);
      }
      return wav(out);
    };

    it('editor_get_beats maps the music bed’s beats onto the timeline through its trim and measures scene cuts', async () => {
      await mkdir(join(root, 'public', 'assets'), { recursive: true });
      await writeFile(join(root, 'public', 'assets', 'clicks.wav'), clicks(30));
      const project = structuredClone(fixtureProject);
      project.assets.ast_music = { ...project.assets.ast_music, src: 'assets/clicks.wav', durationInFrames: 900 };
      // The bed starts at frame 6 and skips the first 12 source frames.
      project.audio[0] = { ...project.audio[0], startFrame: 6, trimStartFrames: 12 };
      await connect(project);
      const r = await h.editor_get_beats({});
      expect(r.isError).toBeUndefined();
      const report = JSON.parse(textOf(r));
      expect(report.source).toMatchObject({ clipId: 'aud_music', assetId: 'ast_music', projectFrames: [6, 6 + 720 - 1], trimStartFrames: 12 });
      expect(report.frames).toBe('project');
      expect(Math.abs(report.tempo.bpm - 100)).toBeLessThanOrEqual(2);
      // Source beats at 18, 36, … become project frames 6 + (18 − 12) = 12, 30, 48, …
      expect(report.beats.slice(0, 3).map((f: number) => Math.round((f - 12) / 18))).toEqual([0, 1, 2]);
      for (const f of report.beats.slice(0, 10)) expect(Math.abs(((f - 12) % 18 + 18) % 18 < 9 ? (f - 12) % 18 : ((f - 12) % 18) - 18)).toBeLessThanOrEqual(1);
      expect(report.sceneCuts.map((c: { sceneId: string }) => c.sceneId)).toEqual(['scn_product', 'scn_outro']);
      expect(report.sceneCuts[0]).toMatchObject({ startFrame: 210 });
      expect(typeof report.sceneCuts[0].offBeatBy).toBe('number');
      expect(report.markers).toEqual(project.markers.map((m) => ({ frame: m.frame, label: m.label })));

      // An unplaced asset reports source frames; a bad clip id says which clips exist.
      const raw = JSON.parse(textOf(await h.editor_get_beats({ assetId: 'ast_music' })));
      expect(raw.frames).toBe('source');
      expect(raw.beats[0]).toBeLessThanOrEqual(1);
      const missing = await h.editor_get_beats({ clipId: 'aud_nope' });
      expect(missing.isError).toBe(true);
      expect(textOf(missing)).toContain('aud_music "Music bed"');
    });

    it('proposes an audio patch with the project-audio target, refused as OUT_OF_SCOPE without it', async () => {
      const ed = await connect();
      const bed = { type: 'updateAudioClip', clipId: 'aud_music', changes: { volume: 0.4, fadeOutFrames: 60 } };
      const wrong = await h.editor_apply_patch({ baseRevision: fixtureProject.revision, summary: 'Quieter music', targets: [{ sceneId: 'scn_intro' }], commands: [bed] });
      expect(wrong.isError).toBe(true);
      expect(textOf(wrong)).toContain('OUT_OF_SCOPE');
      const ok = await h.editor_apply_patch({ baseRevision: fixtureProject.revision, summary: 'Quieter music', targets: [{ audio: 'project' }], commands: [bed] });
      expect(ok.isError).toBeUndefined();
      expect(ed.doc.project.audio[0]).toMatchObject({ volume: 0.4, fadeOutFrames: 60 });
    });
  });

  describe('preview and contact sheets over HTTP', () => {
    it('previews candidate images without sending commands or changing a pending proposal', async () => {
      const ed = await connect();
      await ed.report({ proposal: proposal() });
      const result = await h.editor_preview_patch({ ...patchArgs, frames: [0, 100], docSession: ed.docSession });
      expect(result.isError).toBeUndefined();
      expect(result.content.filter((c) => c.type === 'image')).toHaveLength(2);
      expect(textOf(result)).toContain('Uncommitted preview of your patch (not applied, not proposed)');
      expect(textOf(result)).toContain('→ 120');
      expect(textOf(result)).toContain('proposal/preview, base r1');
      expect(ed.commands).toEqual([]);
      expect(ed.doc.project).toEqual(fixtureProject);
      expect(ed.proposal).toEqual(proposal());
    });

    it('returns one labelled contact sheet with default scene samples', async () => {
      const ed = await connect();
      const result = await h.editor_render_contact_sheet({});
      expect(result.isError).toBeUndefined();
      expect(result.content.filter((c) => c.type === 'image')).toHaveLength(1);
      for (const frame of [52, 157, 277, 412, 540, 660]) expect(textOf(result)).toContain(`Frame ${frame} (`);
      expect(textOf(result)).toContain(`committed, r1, hash ${projectHash(fixtureProject).slice(0, 12)}`);
      expect(ed.commands).toEqual([]);
    });

    it('rejects an old document session before apply or propose bridge commands', async () => {
      const ed = await connect();
      const context = JSON.parse(textOf(await h.editor_get_context()));
      expect(context).toMatchObject({ contract: 'mge.tools/2', docSession: ed.docSession });
      await ed.report({ docSession: 'reopened' });
      for (const handler of [h.editor_apply_patch, h.editor_propose_patch]) {
        const result = await handler({ ...patchArgs, docSession: context.docSession });
        expect(result.isError).toBe(true);
        expect(textOf(result)).toBe('STALE_SESSION: the editor opened another document since you read it; re-read context');
      }
      expect(ed.commands).toEqual([]);
    });
  });
});

describe('proposal handlers without HTTP', () => {
  const localWith = (reply: BridgeReply, extra: Partial<EditorContext> = {}) => {
    const local = new LocalEditor({ rootDir: '/tmp', serverPort: 1, webPort: 1, openBrowser: false });
    const state = { connected: true, project: fixtureProject, context: contextFor(createDocState(fixtureProject), extra), updatedAt: null };
    const command = vi.spyOn(local, 'command').mockResolvedValue(reply);
    vi.spyOn(local, 'state').mockResolvedValue(state);
    return { local, command, handlers: createHandlers(local) };
  };
  const applied = { ok: true as const, applied: true, revision: 14, projectId: fixtureProject.id, changes: [] };

  it('distinguishes applied, legacy, proposed and replaced replies and sends explicit modes', async () => {
    const explicit = localWith(applied);
    expect(textOf(await explicit.handlers.editor_apply_patch(patchArgs))).toBe('Applied as r14 (0 changes):\n');
    expect(explicit.command).toHaveBeenCalledWith(expect.objectContaining({ mode: 'auto', agent: 'Claude Code' }));
    const legacy = localWith({ ok: true, revision: 14, projectId: fixtureProject.id });
    expect(textOf(await legacy.handlers.editor_apply_patch(patchArgs))).toContain('Applied as r14');
    const pending = localWith({ ...applied, applied: false, proposal: proposal() });
    expect(textOf(await pending.handlers.editor_apply_patch(patchArgs))).toContain('Nothing has changed in the project yet.');
    const replacing = localWith({ ...applied, applied: false, proposal: proposal(), replaced: proposal({ summary: 'Earlier title', status: 'replaced' }) });
    const result = textOf(await replacing.handlers.editor_propose_patch(patchArgs));
    expect(result).toContain('Proposed — awaiting');
    expect(result).toContain('Replaced your earlier pending proposal "Earlier title".');
    expect(replacing.command).toHaveBeenCalledWith(expect.objectContaining({ mode: 'propose' }));
  });

  it('forwards the expected document session in both patch commands, and omits it when the agent passed none', async () => {
    const { handlers, command } = localWith(applied, { docSession: 'sess-1' });
    await handlers.editor_apply_patch({ ...patchArgs, docSession: 'sess-1' });
    await handlers.editor_propose_patch({ ...patchArgs, docSession: 'sess-1' });
    expect(command).toHaveBeenCalledTimes(2);
    for (const [cmd] of command.mock.calls) expect(cmd).toMatchObject({ type: 'applyPatch', docSession: 'sess-1' });
    command.mockClear();
    await handlers.editor_apply_patch(patchArgs);
    expect(command.mock.calls[0][0]).not.toHaveProperty('docSession');
  });

  it('validates outlines before sending them and reports the user\'s decision through context', async () => {
    const { handlers, command } = localWith({ ok: true, revision: 1, projectId: fixtureProject.id, message: 'awaiting' });
    const bad = await handlers.editor_propose_outline({ title: 'x', scenes: [{ name: 'A', purpose: '', durationSeconds: 120 }] });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain('Outline is invalid: scenes.0.durationSeconds');
    expect(command).not.toHaveBeenCalled();
    expect(textOf(await handlers.editor_propose_outline(outlineArgs))).toContain('Do not build or write any project until then.');
    expect(command).toHaveBeenCalledWith(expect.objectContaining({ type: 'proposeOutline', agent: 'Claude Code' }));
    const rejected = localWith({ ok: false, error: { code: 'INVALID', message: 'Outline rejected: no' } });
    expect(textOf(await rejected.handlers.editor_propose_outline(outlineArgs))).toContain('Outline failed: [INVALID] Outline rejected: no');

    const approved = { status: 'approved' as const, title: 'Relay', scenes: [{ id: 'ol_1', name: 'Hook', purpose: '', durationSeconds: 4, notes: 'Punchy' }], agent: 'Claude Code', targetSeconds: 30, projectId: 'prj_new' };
    const ctx = localWith({ ok: true, revision: 1, projectId: fixtureProject.id }, { outline: approved });
    expect(JSON.parse(textOf(await ctx.handlers.editor_get_context())).outline).toEqual(approved);
    expect(JSON.parse(textOf(await localWith({ ok: true, revision: 1, projectId: fixtureProject.id }).handlers.editor_get_context()))).not.toHaveProperty('outline');
  });

  it('does not report an applied:false reply without a proposal as committed', async () => {
    const { handlers } = localWith({ ...applied, applied: false });
    const result = await handlers.editor_apply_patch(patchArgs);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('did not confirm an applied edit or a proposal');
  });

  it('reads proposal statuses without issuing a command, including missing ids', async () => {
    const { handlers, command } = localWith(applied, { proposal: proposal(), proposalLog: [
      proposal({ id: 'applied', status: 'applied', revision: 14, decidedAt: 2000 }),
      proposal({ id: 'cancelled', status: 'cancelled', decidedAt: 3000 }),
      proposal({ id: 'stale', status: 'stale', reason: 'The title changed.', decidedAt: 4000 }),
      proposal({ id: 'replaced', status: 'replaced', reason: 'Newer edit.', decidedAt: 5000 }),
    ] });
    const result = textOf(await handlers.editor_proposal_status({}));
    for (const line of ['proposal_1 (Claude Code)', 'Still waiting', 'Applied by the user as r14', 'Declined by the user (cancelled)', 'Stale: The title changed.', 'Replaced: Newer edit.', 'decidedAt 1970-01-01T00:00:02.000Z']) expect(result).toContain(line);
    expect(textOf(await handlers.editor_proposal_status({ proposalId: 'applied' }))).not.toContain('Declined');
    expect(textOf(await handlers.editor_proposal_status({ proposalId: 'missing' }))).toContain('was not found');
    expect(command).not.toHaveBeenCalled();
  });

  it('describes proposal settings and omits fields older editors do not report', async () => {
    const log = Array.from({ length: 7 }, (_, i) => proposal({ id: `p_${i}`, status: 'cancelled' }));
    const { handlers, local } = localWith(applied, { autoApply: false, proposal: null, proposalLog: log });
    expect(JSON.parse(textOf(await handlers.editor_get_context()))).toMatchObject({ autoApply: false, proposal: null, recentProposals: log.slice(0, 5) });
    const state = await local.state();
    for (const key of ['autoApply', 'proposal', 'proposalLog']) Reflect.deleteProperty(state.context!, key);
    const result = JSON.parse(textOf(await handlers.editor_get_context()));
    for (const key of ['autoApply', 'proposal', 'recentProposals']) expect(result).not.toHaveProperty(key);
  });

  it('forwards model and agent credit from the MCP environment', async () => {
    vi.stubEnv('MGE_AGENT_MODEL', 'gpt-test');
    vi.stubEnv('MGE_AGENT_LABEL', 'Codex');
    vi.resetModules();
    try {
      const { createHandlers: credited } = await import('./tools');
      const { local, command } = localWith(applied);
      await credited(local).editor_apply_patch(patchArgs);
      await credited(local).editor_propose_patch(patchArgs);
      expect(command).toHaveBeenCalledTimes(2);
      for (const [cmd] of command.mock.calls) expect(cmd).toMatchObject({ model: 'gpt-test', agent: 'Codex' });
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
    }
  });
});

describe('versioned visual and export tools without HTTP', () => {
  let imageDir: string;
  let imagePath: string;
  const job = (extra: Partial<RenderJob> = {}): RenderJob => ({
    id: 'render_1', projectId: fixtureProject.id, projectRevision: fixtureProject.revision,
    status: 'rendering', progress: 0.5, renderedFrames: 360, encodedFrames: 180, totalFrames: 720,
    projectHash: projectHash(fixtureProject), rendererVersion: '4.test', createdAt: '2026-10-13T00:00:00.000Z',
    ...extra,
  });
  const manifest: RenderManifest = {
    format: 'mge.manifest/1', projectId: fixtureProject.id, projectRevision: fixtureProject.revision,
    projectHash: projectHash(fixtureProject), assets: [{ id: 'asset_1', src: 'logo.svg', sha256: null, bytes: null, missing: true }],
    fonts: [{ family: 'Inter', package: '@fontsource/inter', version: '5.test' }],
    renderer: { engine: 'native', version: 'native 4.test', node: 'test' }, code: { gitCommit: 'abcdef1234567890', dirty: false, compositionHash: 'composition' },
    createdAt: '2026-10-13T00:00:00.000Z',
  };
  const setup = (extra: Partial<EditorContext> = {}) => {
    const local = new LocalEditor({ rootDir: repoRoot, serverPort: 5318, webPort: 5317, openBrowser: false });
    const state = { connected: true, project: structuredClone(fixtureProject), context: contextFor(createDocState(fixtureProject), extra), updatedAt: null };
    vi.spyOn(local, 'state').mockResolvedValue(state);
    const command = vi.spyOn(local, 'command').mockResolvedValue({ ok: true, applied: true, revision: 2, projectId: fixtureProject.id });
    vi.spyOn(local, 'ensureRunning').mockResolvedValue({ started: [], logPath: '/tmp/dev.log' });
    const request = vi.spyOn(local, 'request').mockImplementation(async (method, path, body) => {
      if (path === '/api/generation/models') return modelsResponse('quality', { gptImageReserveUsd: 0.5 });
      if (path === '/api/generation/status') return { key: { configured: true }, settings: { dailyBudgetUsd: 5 }, spendTodayUsd: 0 };
      if (path === '/api/generation/jobs') return { job: { id: 'gjob_test', status: 'queued', model: 'gpt-image-2.5-flare', modelLabel: 'GPT Image 2.5 Flare', estimate: { usd: 0.5, basis: 'budget reserve' } } };
      if (path.startsWith('/api/generation/jobs?')) return [];
      if (path === '/api/generation/jobs/gjob_test/cancel') return { id: 'gjob_test', projectId: fixtureProject.id, status: 'cancelled', model: 'gpt-image-2.5-flare', modelLabel: 'GPT Image 2.5 Flare' };
      if (path === '/api/stills') {
        const input = body as { project: typeof fixtureProject; frame: number; proposalId?: string };
        const identity: FrameIdentity = { projectId: input.project.id, revision: input.project.revision, projectHash: projectHash(input.project), kind: input.proposalId ? 'proposal' : 'committed', proposalId: input.proposalId, frame: input.frame, rendererVersion: '4.test', compositionHash: 'composition' };
        return { path: imagePath, identity };
      }
      if (path === '/api/stills/contact-sheet') return { path: imagePath, frames: (body as { frames: number[] }).frames };
      if (path === '/api/renders/render_1/manifest') return manifest;
      if (path.endsWith('/cancel')) return job({ status: 'cancelled' });
      if (path === '/api/renders') return method === 'POST' ? job({ status: 'queued' }) : [job()];
      if (path === '/api/renders/render_1') return job({ status: 'done', progress: 1, outputUrl: '/renders/render_1.mp4' });
      if (path.startsWith('/api/projects/')) {
        if (method === 'GET') throw new LocalApiError(404, 'Project not found', null);
        return {};
      }
      if (path.startsWith('/api/assets/beats?')) return { src: 'assets/music-bed.wav', durationSeconds: 24, fps: 30, durationInFrames: 720, bpm: 120, confidence: 0.5, beats: [0, 15, 30], downbeats: [0], strong: [0], onsets: [0, 15, 30] };
      if (path === '/api/assets/import-local') return { kind: 'image', name: 'test.png', src: 'assets/test.png', mimeType: 'image/png' };
      if (path.startsWith('/api/openverse/audio/search')) return { results: [ovHit], page: 1, pageCount: 1, resultCount: 1, authenticated: false, notice: OPENVERSE_NOTICE };
      if (path.startsWith('/api/openverse/audio/') && method === 'GET') return { ...ovHit, notice: OPENVERSE_NOTICE };
      if (path === '/api/openverse/audio/import') return { src: 'assets/uploads/openverse/11111111-1111-4111-8111-111111111111.mp3', name: ovHit.title, mimeType: 'audio/mpeg', kind: 'audio', durationSeconds: 24, cached: false, work: ovHit, notice: OPENVERSE_NOTICE };
      if (path === '/api/brand/scan') {
        return {
          domain: 'acme.test', url: 'https://acme.test/', title: 'Acme Solar', stylesheetHrefs: [],
          colors: [{ hex: '#58ad80', role: 'accent', source: 'css-variable', rank: 10, count: 1 }],
          fonts: [{ family: 'Inter', weights: [400], availability: 'bundled', fallback: 'Inter', source: 'font-family' }],
          logo: { kind: 'inline-svg', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
          logoPath: 'assets/uploads/brand/acme.test/logo.svg',
          style: { id: 'custom', name: 'Acme Solar', fonts: { heading: 'Inter', body: 'Inter', mono: 'IBM Plex Mono' }, colors: { background: '#f5f4f0', surface: '#ffffff', text: '#15171c', muted: '#555b68', accent: '#58ad80' }, motion: { id: 'playful', timingScale: 0.9, staggerFrames: 5, overshoot: 0.12, enter: { type: 'cubicBezier', x1: 0.34, y1: 1.56, x2: 0.64, y2: 1 }, exit: { type: 'cubicBezier', x1: 0.36, y1: 0, x2: 0.66, y2: -0.56 } } },
          cached: false, fetchedAt: 1,
        };
      }
      if (path === '/api/reference/analyze') {
        return {
          source: { kind: 'file', input: '/tmp/tiny.mp4', resolvedPath: '/tmp/tiny.mp4' },
          specs: { width: 64, height: 48, fps: 10, durationSeconds: 1, frames: 10, hasAudio: true },
          sceneCuts: [{ timeSeconds: 0.5, frame: 5 }],
          shots: [{ index: 1, startSeconds: 0, endSeconds: 0.5, startFrame: 0, endFrame: 4, palette: ['#58ad80'] }, { index: 2, startSeconds: 0.5, endSeconds: 1, startFrame: 5, endFrame: 9, palette: ['#0a1528'] }],
          loudness: { integratedLufs: -20, lra: 1.5 },
          beats: { bpm: 120, confidence: 0.4, beats: [0], downbeats: [0], onsets: [0], strongHits: [0] },
          motion: { energy: [0, 0.2], fps: 8, holds: [], fast: [] },
          artifacts: [{ kind: 'contact-sheet', path: 'analysis/reference/abcd/contact_01.png', startSeconds: 0, endSeconds: 1, columns: 6, rows: 4 }],
          cached: false,
          notice: 'Analysis only. Do not import this reference’s media into a project. Rebuild it in the editor from the measurements, and give every correction as an absolute value (not “a bit tighter”).',
        };
      }
      throw new LocalApiError(404, `Render job missing: ${path}`, null);
    });
    return { local, state, command, request, handlers: createHandlers(local) };
  };

  beforeAll(async () => {
    imageDir = await mkdtemp(join(tmpdir(), 'mge-tools-unit-'));
    imagePath = join(imageDir, 'test.png');
    await writeFile(imagePath, PNG);
  });
  afterAll(async () => { await rm(imageDir, { recursive: true, force: true }); });

  it('directs the user to the private link file when no browser opens, without exposing a token', async () => {
    const { local, state, handlers } = setup();
    state.connected = false;
    vi.spyOn(local, 'openBrowser').mockReturnValue(false);
    vi.spyOn(local, 'waitForEditor').mockResolvedValue(false);
    const result = await handlers.editor_open({});
    expect(textOf(result)).toContain(`open the editor link stored in ${local.editorLinkFile}`);
    expect(textOf(result)).not.toContain('?session=');
  });

  it('forwards generation settings and the open project with a 330-second permission timeout', async () => {
    const { handlers, request } = setup();
    const args = z.object(schemas.generate).parse({
      job: 'image.edit', prompt: 'Warm light', model: 'gpt-image-2.5-flare', policy: 'quality', takes: 4, regenerateOf: 'gjob_previous',
      settings: { aspectRatio: '16:9', resolution: '2k', durationSeconds: 10, voice: 'Aria', languageCode: 'en', instrumental: true, loop: false, referenceAssetIds: ['ast_source'], maskAssetId: 'ast_mask', seed: 42 },
    });
    expect((await handlers.editor_generate(args)).isError).toBeUndefined();
    expect(request).toHaveBeenCalledWith('POST', '/api/generation/jobs', { ...args, projectId: fixtureProject.id, agent: 'Claude Code' }, undefined, 330_000);
    for (const takes of [0, 5, 1.5]) expect(z.object(schemas.generate).safeParse({ job: 'image.cutout', prompt: 'A kite', takes }).success).toBe(false);
    for (const job of JOB_KINDS) expect(z.object(schemas.generate).safeParse({ job, prompt: 'A take' }).success).toBe(true);
  });

  it('accepts and forwards video frames, pins, references and document settings', async () => {
    const { handlers, request } = setup();
    const settings = {
      videoResolution: '720p', durationSeconds: 10, start: { assetId: 'ast_image' }, end: { projectFrame: 300 },
      keyframes: [{ frame: { projectFrame: 0 }, atSeconds: 0 }, { frame: { assetId: 'ast_middle' }, atSeconds: 5 }, { frame: { projectFrame: 300 }, atSeconds: 10 }],
      referenceAssetIds: ['ast_image', 'ast_video'], documentUrl: 'https://example.com/brief.pdf', webUrl: 'https://example.com/page', seed: 42,
    };
    const args = z.object(schemas.generate).parse({ job: 'video.keyframes', prompt: 'Move across the scene', settings });
    expect(args.settings).toEqual(settings);
    expect((await handlers.editor_generate(args)).isError).toBeUndefined();
    expect(request).toHaveBeenCalledWith('POST', '/api/generation/jobs', { ...args, projectId: fixtureProject.id, agent: 'Claude Code' }, undefined, 330_000);
  });

  it.each([
    { videoResolution: '768p' }, { start: { projectFrame: -1 } }, { end: { projectFrame: 1.5 } },
    { start: { assetId: '' } }, { start: { assetId: 'image', projectFrame: 0 } },
    { keyframes: [] }, { keyframes: Array(11).fill({ frame: { projectFrame: 0 }, atSeconds: 0 }) },
    { keyframes: [{ frame: { projectFrame: 0 }, atSeconds: -1 }] },
    { keyframes: [{ frame: { projectFrame: 0 }, atSeconds: Infinity }] },
    { documentUrl: 'http://example.com/brief.pdf' }, { webUrl: 'not a URL' }, { webUrl: `https://example.com/${'a'.repeat(2000)}` },
  ])('rejects invalid video schema settings %#', (settings) => {
    expect(z.object(schemas.generate).safeParse({ job: 'video.generate', prompt: 'A take', settings }).success).toBe(false);
  });

  it('accepts and forwards scored music sections, tempo and per-scene narration', async () => {
    const { handlers, request } = setup();
    for (const args of [
      { job: 'music.scored', prompt: 'Warm, keys', settings: { score: [{ sceneIds: ['intro'], seconds: 3, styles: ['building'], label: 'Hook' }], bpm: 100 } },
      { job: 'voice.narration', prompt: '', takes: 2, settings: { lines: [{ sceneId: 'intro', text: 'Hello.' }, { sceneId: 'end', text: '' }] } },
    ]) {
      const parsed = z.object(schemas.generate).parse(args);
      expect(parsed).toEqual(args);
      expect((await handlers.editor_generate(parsed)).isError).toBeUndefined();
      expect(request).toHaveBeenCalledWith('POST', '/api/generation/jobs', { ...args, projectId: fixtureProject.id, agent: 'Claude Code' }, undefined, 330_000);
    }
  });

  it.each([
    { score: [] }, { score: Array(31).fill({ sceneIds: ['s'], seconds: 3, styles: [] }) },
    ...[2.9, 120.1, Infinity].map((seconds) => ({ score: [{ sceneIds: ['s'], seconds, styles: [] }] })),
    { score: Array(6).fill({ sceneIds: ['s'], seconds: 120, styles: [] }) },
    { score: [{ sceneIds: [], seconds: 3, styles: [] }] },
    { score: [{ sceneIds: ['s'], seconds: 3, styles: [2] }] },
    { bpm: 0 }, { bpm: Infinity }, { lines: [{ sceneId: '', text: 'Hello' }] }, { lines: [{ sceneId: 's', text: 3 }] },
  ])('rejects malformed score and narration schema settings %#', (settings) => {
    expect(z.object(schemas.generate).safeParse({ job: 'music.scored', prompt: 'Music', settings }).success).toBe(false);
  });

  it('appends scoreboard runs, keep rates, costs, small samples and suggestions after routes', async () => {
    const { handlers, request } = setup();
    const previous = request.getMockImplementation()!;
    request.mockImplementation(async (method, path, ...rest) => path === '/api/generation/scoreboard' ? {
      rows: [
        { job: 'image.generate', model: 'seedream-5-pro', modelLabel: 'Seedream 5.0 Pro', runs: 20, keepRate: 0.6, costPerKept: 0.11, smallSample: false },
        { job: 'image.generate', model: 'flux-3-image', modelLabel: 'FLUX 3 Image', runs: 2, keepRate: 1, costPerKept: 0.01, smallSample: true },
        { job: 'voice.line', model: 'eleven-v4', modelLabel: 'Eleven v4', runs: 20, keepRate: 0, costPerKept: null, smallSample: false },
      ], suggestions: [{ job: 'image.generate', kind: 'cheaper', reason: 'Seedream keeps 60% at $0.11 instead of $0.82.' }], overrides: {}, threshold: 20,
    } : previous(method, path, ...rest));
    const result = textOf(await handlers.editor_generation_models());
    expect(result).toContain('Seedream 5.0 Pro (seedream-5-pro): 20 runs; keep rate 60%; $0.11 per kept take');
    expect(result).toContain('FLUX 3 Image (flux-3-image): 2 runs; too few runs');
    expect(result).toContain('Eleven v4 (eleven-v4): 20 runs; keep rate 0%; no kept takes');
    expect(result).toContain('image.generate suggestion (cheaper): Seedream keeps 60% at $0.11 instead of $0.82.');
    expect(result.indexOf('20 runs')).toBeGreaterThan(result.indexOf('video.long —'));
  });

  it('silently skips scoreboard 404s on older servers and surfaces other scoreboard failures', async () => {
    const { handlers, request } = setup();
    const previous = request.getMockImplementation()!;
    const result = await handlers.editor_generation_models();
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).not.toContain('too few runs');
    expect(request).toHaveBeenCalledWith('GET', '/api/generation/scoreboard');
    request.mockImplementation(async (method, path, ...rest) => {
      if (path === '/api/generation/scoreboard') throw new LocalApiError(500, 'Scoreboard failed', null);
      return previous(method, path, ...rest);
    });
    const failed = await handlers.editor_generation_models();
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toContain('Scoreboard failed');
  });

  it('marks unavailable generation models and exposes only configured key status', async () => {
    const { handlers, request } = setup();
    const models = modelsResponse('quality', { gptImageReserveUsd: 0.5 });
    models.jobs[0].models[0].available = false;
    request.mockImplementation(async (_method, path) => path === '/api/generation/models' ? models : {
      key: { configured: false, last4: '6789', error: GENERATION_KEY }, settings: { dailyBudgetUsd: 5 }, spendTodayUsd: 1,
    });
    const result = textOf(await handlers.editor_generation_models());
    expect(result).toContain('[unavailable]');
    expect(result).toContain('Key configured: no');
    expect(result).toContain("Today's spend: $1.00 of $5.00");
    expect(result).not.toContain('6789');
    expect(result).not.toContain(GENERATION_KEY);
    expect(JSON.parse(result.slice(result.indexOf('{')))).toEqual(models);
  });

  it('renders locally checked candidates and labels each image with preview identity', async () => {
    const { handlers, state, request, command } = setup({ proposal: proposal() });
    const original = structuredClone(state);
    const result = await handlers.editor_preview_patch({ ...patchArgs, frames: [0, 100] });
    expect(result.isError).toBeUndefined();
    expect(textOf(result)).toContain('Uncommitted preview of your patch (not applied, not proposed)');
    expect(textOf(result)).toContain('→ 120');
    for (const frame of [0, 100]) expect(textOf(result)).toContain(`renderer 4.test, frame ${frame}`);
    expect(result.content.filter((c) => c.type === 'image')).toHaveLength(2);
    expect(request).toHaveBeenCalledTimes(2);
    for (const [, , body] of request.mock.calls) {
      expect(body).toMatchObject({ proposalId: 'preview', project: { revision: 1 } });
      const candidate = (body as { project: typeof fixtureProject }).project;
      expect(candidate.scenes[0].elements.find((e) => e.id === 'el_intro_headline')?.props.fontSize).toBe(120);
    }
    expect(command).not.toHaveBeenCalled();
    expect(state).toEqual(original);
    expect(textOf(result)).toContain('proposal/preview, base r1');
  });

  it('returns patch errors before rendering or sending bridge commands', async () => {
    const { handlers, request, command } = setup();
    const result = await handlers.editor_preview_patch({ ...patchArgs, commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_sub', changes: { name: 'outside scope' } }] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('Patch failed: [OUT_OF_SCOPE]');
    expect(request).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it('defaults preview to first/midpoint frames of touched scenes, including contactSheet:true', async () => {
    const { handlers, request, command } = setup();
    for (const extra of [{}, { contactSheet: true, frames: [20] }]) {
      const result = await handlers.editor_preview_patch({ ...patchArgs, ...extra });
      expect(result.content.filter((c) => c.type === 'image')).toHaveLength(1);
      expect(textOf(result)).toContain('proposal/preview, base r1');
      expect(textOf(result)).toContain('Frame 105 (0:03:15) — scene "Intro"');
      expect(request).toHaveBeenLastCalledWith('POST', '/api/stills/contact-sheet', expect.objectContaining({ frames: [0, 105] }));
    }
    expect(command).not.toHaveBeenCalled();
  });

  it('selects 25%/75% per scene for a committed sheet and accepts custom frames/layout', async () => {
    const { handlers, request } = setup();
    const result = await handlers.editor_render_contact_sheet({});
    expect(result.content.filter((c) => c.type === 'image')).toHaveLength(1);
    expect(textOf(result)).toContain(`committed, r1, hash ${projectHash(fixtureProject).slice(0, 12)}`);
    expect(textOf(result)).toContain('Frame 277 (0:09:07) — scene "Product"');
    expect(request).toHaveBeenLastCalledWith('POST', '/api/stills/contact-sheet', expect.objectContaining({ frames: [52, 157, 277, 412, 540, 660] }));
    await handlers.editor_render_contact_sheet({ frames: [5, 300], columns: 2, scale: 0.25 });
    expect(request).toHaveBeenLastCalledWith('POST', '/api/stills/contact-sheet', expect.objectContaining({ frames: [5, 300], columns: 2, scale: 0.25 }));
  });

  it('caps defaults for long projects and keeps samples inside short scenes', async () => {
    const { handlers, state, request } = setup();
    state.project.scenes = Array.from({ length: 20 }, (_, i) => ({ ...exampleProject().scenes[0], id: `scn_${i}`, elements: [], durationInFrames: 1 }));
    await handlers.editor_render_contact_sheet({});
    expect((request.mock.calls[0][2] as { frames: number[] }).frames).toEqual(Array.from({ length: 20 }, (_, i) => i));
    state.project.scenes.forEach((s) => { s.durationInFrames = 120; });
    await handlers.editor_render_contact_sheet({});
    expect((request.mock.calls[1][2] as { frames: number[] }).frames).toHaveLength(24);
  });

  it('rejects invalid frame selections before render requests', async () => {
    const { handlers, request } = setup();
    expect((await handlers.editor_preview_patch({ ...patchArgs, frames: [-1] })).isError).toBe(true);
    expect((await handlers.editor_render_frame({ frames: [720] })).isError).toBe(true);
    expect((await handlers.editor_render_contact_sheet({ frames: [] })).isError).toBe(true);
    expect((await handlers.editor_render_contact_sheet({ frames: Array(25).fill(1) })).isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect(z.object(schemas.contactSheet).safeParse({ columns: 7 }).success).toBe(false);
    expect(z.object(schemas.preview).safeParse({ frames: Array(9).fill(1) }).success).toBe(false);
    expect(z.object(schemas.critique).safeParse({ addBanned: ['x'.repeat(81)] }).success).toBe(false);
    expect(z.object(schemas.scanBrand).safeParse({ url: 'https://acme.test' }).success).toBe(true);
    expect(z.object(schemas.analyzeReference).safeParse({ path: '/tmp/a.mp4' }).success).toBe(true);
    expect(z.object(schemas.analyzeReference).safeParse({}).success).toBe(true);
  });

  it('critiques the live project with frame-tied findings and remembers addBanned', async () => {
    const { handlers, request } = setup();
    const first = JSON.parse(textOf(await handlers.editor_critique({})));
    expect(first.text).toMatch(/^Critique:/);
    expect(first.banned).toEqual(expect.arrayContaining(['purple-gradient', 'glow-orb']));
    expect(first.findings).toEqual(expect.any(Array));
    expect(first.findings.every((f: { frame: number }) => Number.isInteger(f.frame))).toBe(true);
    expect(request.mock.calls.some((c) => String(c[1]).startsWith('/api/assets/beats?'))).toBe(true);

    const second = JSON.parse(textOf(await handlers.editor_critique({ addBanned: ['neon-on-black'] })));
    expect(second.banned).toContain('neon-on-black');
    const ctx = JSON.parse(textOf(await handlers.editor_get_context()));
    expect(ctx.banned).toContain('neon-on-black');
  });

  it('critiques a patch candidate without proposing it', async () => {
    const { handlers, command } = setup();
    const result = JSON.parse(textOf(await handlers.editor_critique({ ...patchArgs })));
    expect(result.findings).toEqual(expect.any(Array));
    expect(result.scenes).toBe(1);
    expect(command).not.toHaveBeenCalled();
  });

  it('prepends a critique when proposing, not when applying', async () => {
    const { handlers, command } = setup();
    command.mockResolvedValueOnce({
      ok: true, proposal: proposal(), projectId: fixtureProject.id, revision: 1, changes: [],
    });
    const proposed = textOf(await handlers.editor_propose_patch(patchArgs));
    expect(proposed).toMatch(/^Critique:/);
    expect(proposed).toContain('Proposed — awaiting');
    const applied = textOf(await handlers.editor_apply_patch(patchArgs));
    expect(applied).toMatch(/^Applied as r2/);
    expect(applied).not.toContain('Critique:');
  });

  it('preserves plain HTTP conflict messages from the local client', async () => {
    const { local } = setup();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('This export is already done and cannot be cancelled.', { status: 409 }));
    try {
      // Use the actual client rather than setup's request spy.
      const client = new LocalEditor(local.cfg);
      await expect(client.request('POST', '/api/renders/done/cancel')).rejects.toMatchObject({ status: 409, message: 'This export is already done and cannot be cancelled.' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('labels committed frame images with the identity returned by the still API', async () => {
    const { handlers, request } = setup();
    request.mockResolvedValueOnce({ path: imagePath, identity: { kind: 'committed', revision: 9, projectHash: 'abcdef1234569999', rendererVersion: 'renderer-test', frame: 100 } });
    expect(textOf(await handlers.editor_render_frame({ frames: [100] }))).toContain('committed, r9, hash abcdef123456, renderer renderer-test, frame 100');
  });

  it('starts a committed export with the live document and returns its job identity', async () => {
    const { handlers, state, request, command } = setup({ dirty: true });
    const result = await handlers.editor_export_revision();
    expect(result.isError).toBeUndefined();
    expect(request).toHaveBeenCalledWith('POST', '/api/renders', { project: state.project });
    expect(textOf(result)).toContain(`job render_1 started for the live committed document at r1; projectHash ${projectHash(state.project)}`);
    expect(textOf(result)).toContain('Check progress with editor_inspect_job');
    expect(command).not.toHaveBeenCalled();
  });

  it('refuses exports while a proposal is pending without starting a render', async () => {
    const { handlers, request } = setup({ proposal: proposal() });
    const result = await handlers.editor_export_revision();
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain('PROPOSAL_PENDING');
    expect(textOf(result)).toContain('only the live committed document');
    expect(request).not.toHaveBeenCalled();
  });

  it('inspects a job with its absolute output URL and manifest summary', async () => {
    const { handlers, request } = setup();
    const result = await handlers.editor_inspect_job({ jobId: 'render_1' });
    for (const part of ['Job render_1: done, 100%', 'frames rendered 360/720, encoded 180/720', 'committed r1, projectHash', 'outputUrl: http://localhost:5318/renders/render_1.mp4', 'Manifest: 1 assets; fonts: Inter (5.test); renderer native 4.test; git commit abcdef123456']) expect(textOf(result)).toContain(part);
    expect(request).toHaveBeenCalledWith('GET', '/api/renders/render_1/manifest');
  });

  it('inspects only the newest five and reports failed, cancelled and interrupted jobs', async () => {
    const { handlers, request } = setup();
    const statuses = ['failed', 'cancelled', 'interrupted', 'rendering', 'queued', 'done'] as const;
    request.mockImplementation(async (_method, path) => {
      if (path === '/api/renders') return statuses.map((status, i) => job({ id: `render_${i}`, status, error: status === 'interrupted' ? 'Server restarted' : undefined }));
      return manifest;
    });
    const result = textOf(await handlers.editor_inspect_job({}));
    for (const status of statuses.slice(0, 5)) expect(result).toContain(status);
    expect(result).toContain('error: Server restarted');
    expect(result).not.toContain('Job render_5');
    expect(request).toHaveBeenCalledTimes(6);
  });

  it('allows inspection before a manifest exists and explains an empty job list', async () => {
    const { handlers, request } = setup();
    request.mockImplementation(async (_method, path) => {
      if (path.endsWith('/manifest')) throw new LocalApiError(404, 'No manifest', null);
      if (path === '/api/renders') return [];
      return job();
    });
    expect(textOf(await handlers.editor_inspect_job({ jobId: 'render_1' }))).toContain('Manifest: not available yet.');
    expect(textOf(await handlers.editor_inspect_job({}))).toContain('No export jobs');
  });

  it('cancels active jobs and reports 404/409 messages plainly', async () => {
    const { handlers, request } = setup();
    expect(textOf(await handlers.editor_cancel_job({ jobId: 'render_1' }))).toContain('Job render_1: cancelled, 50%; committed r1');
    expect(request).toHaveBeenCalledWith('POST', '/api/renders/render_1/cancel');
    for (const status of [404, 409]) {
      const message = status === 404 ? 'Render job "missing" does not exist.' : 'Cannot cancel a done render.';
      request.mockRejectedValueOnce(new LocalApiError(status, message, null));
      const result = await handlers.editor_cancel_job({ jobId: 'missing' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe(message);
    }
    const missing = await handlers.editor_inspect_job({ jobId: 'missing' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain('Render job missing');
    request.mockRejectedValueOnce(new LocalApiError(409, 'Export conflict', null));
    expect((await handlers.editor_export_revision()).isError).toBe(true);
  });

  it('rejects stale sessions before apply/propose/preview and accepts current sessions', async () => {
    const { handlers, command, request } = setup();
    const ctx = JSON.parse(textOf(await handlers.editor_get_context()));
    expect(ctx).toMatchObject({ contract: 'mge.tools/2', docSession: 's-1' });
    for (const handler of [handlers.editor_apply_patch, handlers.editor_propose_patch, handlers.editor_preview_patch]) {
      const result = await handler({ ...patchArgs, docSession: 'older' });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe('STALE_SESSION: the editor opened another document since you read it; re-read context');
    }
    expect(command).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
    expect((await handlers.editor_apply_patch({ ...patchArgs, docSession: ctx.docSession })).isError).toBeUndefined();
    expect(command).toHaveBeenCalledTimes(1);
  });

  it('adds unique request ids and known document metadata to every handler result', async () => {
    const { handlers } = setup();
    const args: Record<string, unknown> = {
      editor_open: {}, editor_apply_patch: patchArgs, editor_propose_patch: patchArgs, editor_preview_patch: patchArgs,
      editor_permission_prompt: { tool_name: 'Read', input: { file_path: '/tmp/example.txt' } },
      editor_proposal_status: {}, editor_write_project: { project: exampleProject() }, editor_render_frame: { frames: [0] },
      editor_render_contact_sheet: {}, editor_inspect_job: {}, editor_cancel_job: { jobId: 'render_1' },
      editor_focus: {}, editor_import_asset: { path: imagePath }, editor_propose_outline: outlineArgs, editor_get_beats: {},
      editor_build_template: { template: 'titleCard', sceneId: 'scn_intro' }, editor_list_cut_cards: {}, editor_build_cut: { card: 'hook.mask-rise-claim', sceneId: 'scn_intro' }, editor_build_motion: { preset: 'popIn', sceneId: 'scn_intro', elementIds: ['el_intro_logo'] },
      editor_search_audio: { query: 'calm ambient' }, editor_inspect_audio: { id: ovHit.id },
      editor_generate: { job: 'image.cutout', prompt: 'A kite' }, editor_generation_status: {}, editor_cancel_generation: { jobId: 'gjob_test' },
      editor_add_audio: { id: ovHit.id, role: 'music' }, editor_list_credits: {},
      editor_critique: {},
      editor_scan_brand: { url: 'https://acme.test/' },
      editor_analyze_reference: { path: '/tmp/tiny.mp4' },
    };
    const ids = new Set<string>();
    expect(Object.keys(handlers)).toHaveLength(35);
    for (const [name, handler] of Object.entries(handlers)) {
      const result = await (handler as (arg: unknown) => Promise<ToolResult>)(args[name]);
      expect(result.isError, name).toBeUndefined();
      const revision = name === 'editor_apply_patch' || name === 'editor_propose_patch' || name === 'editor_add_audio' ? 2 : 1;
      expect(result._meta, name).toMatchObject({ 'mge/contract': 'mge.tools/2', 'mge/requestId': expect.stringMatching(/^req_/), 'mge/projectId': fixtureProject.id, 'mge/revision': revision });
      if (name === 'editor_inspect_job' || name === 'editor_cancel_job') expect(result._meta).not.toHaveProperty('mge/docSession');
      else expect(result._meta).toHaveProperty('mge/docSession', 's-1');
      expect(ids.has(result._meta!['mge/requestId'])).toBe(false);
      ids.add(result._meta!['mge/requestId']);
    }
  });

  it('keeps snapshot identity when the live editor switches documents during a render', async () => {
    const { handlers, local, state } = setup();
    const other = { ...state, project: { ...state.project, id: 'prj_other', revision: 99 }, context: { ...state.context, docSession: 'new-session' } };
    vi.spyOn(local, 'state').mockResolvedValueOnce(state).mockResolvedValue(other);
    const result = await handlers.editor_preview_patch({ ...patchArgs, frames: [0] });
    expect(result._meta).toMatchObject({ 'mge/projectId': fixtureProject.id, 'mge/revision': 1, 'mge/docSession': 's-1' });
  });

  it('reports known job identity even when no editor is connected', async () => {
    const { handlers, local } = setup();
    vi.spyOn(local, 'state').mockResolvedValue({ connected: false, project: null, context: null, updatedAt: null });
    for (const result of [await handlers.editor_inspect_job({ jobId: 'render_1' }), await handlers.editor_cancel_job({ jobId: 'render_1' })]) {
      expect(result.isError).toBeUndefined();
      expect(result._meta).toMatchObject({ 'mge/projectId': fixtureProject.id, 'mge/revision': 1 });
      expect(result._meta).not.toHaveProperty('mge/docSession');
    }
  });

  it('retains contract metadata on failures and omits unknown document identity', async () => {
    const { handlers, local } = setup();
    vi.spyOn(local, 'state').mockRejectedValue(new Error('offline'));
    const result = await handlers.editor_get_context();
    expect(result.isError).toBe(true);
    expect(result._meta).toEqual({ 'mge/contract': 'mge.tools/2', 'mge/requestId': expect.stringMatching(/^req_/) });
    const guide = await handlers.editor_guide();
    expect(guide.isError).toBeUndefined();
    expect(guide._meta).toEqual({ 'mge/contract': 'mge.tools/2', 'mge/requestId': expect.stringMatching(/^req_/) });
    expect(guide._meta!['mge/requestId']).not.toBe(result._meta!['mge/requestId']);
  });

  it('scans a brand kit and proposes a reviewable setStyle overlay', async () => {
    const { handlers, request, command } = setup();
    command.mockResolvedValue({ ok: true, proposal: proposal({ summary: 'Apply brand kit from acme.test' }), projectId: fixtureProject.id, revision: fixtureProject.revision });
    const scanned = JSON.parse(textOf(await handlers.editor_scan_brand({ url: 'https://acme.test/' })));
    expect(scanned.kit.domain).toBe('acme.test');
    expect(scanned.apply.targets).toEqual([{ style: 'project' }]);
    expect(command).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('POST', '/api/brand/scan', { url: 'https://acme.test/', refresh: false });

    const proposed = await handlers.editor_scan_brand({ url: 'https://acme.test/', propose: true, backgrounds: true, docSession: 's-1' });
    expect(proposed.isError).toBeUndefined();
    expect(textOf(proposed)).toContain('Proposed — awaiting the user\'s review');
    expect(command).toHaveBeenCalledTimes(1);
    const sent = command.mock.calls[0][0] as { type: string; mode: string; patch: { targets: unknown[]; commands: { type: string }[] } };
    expect(sent.mode).toBe('propose');
    expect(sent.patch.targets).toEqual(expect.arrayContaining([{ style: 'project' }, { sceneId: 'scn_intro' }]));
    expect(sent.patch.commands.map((c) => c.type)).toEqual(expect.arrayContaining(['setStyle', 'addAsset', 'updateScene']));
  });

  it('analyses a reference without importing it and resolves artefact paths', async () => {
    const { handlers, request, command } = setup();
    const result = await handlers.editor_analyze_reference({ path: '/tmp/tiny.mp4' });
    expect(result.isError).toBeUndefined();
    expect(command).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledWith('POST', '/api/reference/analyze', { url: undefined, path: '/tmp/tiny.mp4', refresh: false });
    const body = JSON.parse(textOf(result));
    expect(body.notice).toMatch(/absolute value/);
    expect(body.artifacts[0].path).toContain('analysis/reference/abcd/contact_01.png');
    expect(body.shots).toHaveLength(2);
    expect((await handlers.editor_analyze_reference({})).isError).toBe(true);
    expect((await handlers.editor_analyze_reference({ path: '/tmp/a.mp4', url: 'https://example.com/a.mp4' })).isError).toBe(true);
  });
});
