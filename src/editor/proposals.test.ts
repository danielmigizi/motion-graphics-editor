// Proposal review against the real stores: nothing reaches the document until
// Apply, which commits one revision; Cancel changes nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import { createDocState } from '../core/history';
import { PATCH_PROTOCOL, type AiPatch, type Project } from '../core/types';
import { editorContext, handleBridgeCommand } from './agentBridge';
import { api, ApiRequestError } from './api';
import { byYou, PASTED_BY, TAKE_BY, useProposals, whose } from './proposals';
import { useEditor } from './store';

const patch = (over: Partial<AiPatch> = {}): AiPatch => ({
  protocol: PATCH_PROTOCOL,
  projectId: fixtureProject.id,
  baseRevision: useEditor.getState().doc.project.revision,
  summary: 'Bigger headline',
  targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }],
  commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 120 } } }],
  ...over,
});

const subPatch = (over: Partial<AiPatch> = {}) =>
  patch({
    summary: 'Warmer subhead',
    targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_sub' }],
    commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_sub', changes: { props: { color: '#FFD8A8' } } }],
    ...over,
  });

const find = (p: Project, sceneId: string, elementId: string) => p.scenes.find((s) => s.id === sceneId)!.elements.find((e) => e.id === elementId)!;
const headline = () => find(useEditor.getState().doc.project, 'scn_intro', 'el_intro_headline');
const propose = (p: AiPatch, agent = 'Codex') => useProposals.getState().propose(p, { agent, source: 'mcp' });

afterEach(() => vi.restoreAllMocks());

beforeEach(() => {
  // No saved proposal for the open project (as the server answers: 404).
  vi.spyOn(api, 'getProposal').mockRejectedValue(new ApiRequestError('No proposal', undefined, undefined, 404));
  useEditor.getState().loadDocument(createDocState(structuredClone(fixtureProject)), { kind: 'server', id: fixtureProject.id });
  useProposals.setState({ proposal: null, check: null, open: false, view: 'proposed', log: [], returnTo: null, replaced: null, autoApply: false });
});

describe('propose, apply, cancel', () => {
  it('proposing and opening the review leave the document, history, save state and requests alone', () => {
    const st = useEditor.getState();
    st.selectElement('scn_intro', 'el_intro_headline');
    st.addRequest('Make it bigger');
    const before = useEditor.getState();
    const r = propose(patch());
    expect(r.ok).toBe(true);
    useProposals.getState().openReview();
    const after = useEditor.getState();
    expect(after.doc).toBe(before.doc);
    expect(after.cleanRevision).toBe(before.cleanRevision);
    expect(after.requests).toBe(before.requests);
    expect(headline().props.fontSize).toBe(104);
    const { check } = useProposals.getState();
    expect(check?.status === 'ready' && find(check.candidate, 'scn_intro', 'el_intro_headline').props.fontSize).toBe(120);
  });

  it('Apply commits exactly one AI revision and one undo step; Undo restores the original', () => {
    const doc = useEditor.getState().doc;
    propose(patch());
    const r = useProposals.getState().apply();
    expect(r).toEqual({ ok: true, revision: doc.project.revision + 1 });
    const after = useEditor.getState().doc;
    expect(after.revisions.length).toBe(doc.revisions.length + 1);
    expect(after.undoStack.length).toBe(doc.undoStack.length + 1);
    expect(after.revisions.at(-1)).toMatchObject({ source: 'ai', label: 'Codex: Bigger headline' });
    expect(headline().props.fontSize).toBe(120);
    expect(useProposals.getState()).toMatchObject({ proposal: null, open: false });
    expect(useProposals.getState().log[0]).toMatchObject({ status: 'applied', revision: doc.project.revision + 1, agent: 'Codex' });

    useEditor.getState().undo();
    expect(headline().props.fontSize).toBe(104);
  });

  it('Cancel makes no revision, keeps requests, logs the decline and returns to where the user was', () => {
    const st = useEditor.getState();
    st.seek(300);
    st.selectElement('scn_product', 'el_product_card');
    st.addRequest('Untouched');
    const doc = useEditor.getState().doc;
    propose(patch());
    useProposals.getState().openReview();
    // The review moves the shared playhead into the change.
    useEditor.getState().seek(40);
    expect(useEditor.getState().selection.sceneId).toBe('scn_intro');

    useProposals.getState().cancel();
    const after = useEditor.getState();
    expect(after.doc).toBe(doc);
    expect(after.requests.map((q) => q.instruction)).toEqual(['Untouched']);
    expect(after.playhead).toBe(300);
    expect(after.selection).toEqual({ sceneId: 'scn_product', elementId: 'el_product_card', elementIds: ['el_product_card'] });
    expect(useProposals.getState()).toMatchObject({ proposal: null, open: false, returnTo: null });
    expect(useProposals.getState().log[0]).toMatchObject({ status: 'cancelled', summary: 'Bigger headline' });
  });

  it('Back to editing keeps the proposal pending and returns to where the user was', () => {
    useEditor.getState().seek(300);
    propose(patch());
    useProposals.getState().openReview();
    useEditor.getState().seek(40);
    useProposals.getState().closeReview();
    expect(useEditor.getState().playhead).toBe(300);
    expect(useProposals.getState().open).toBe(false);
    expect(editorContext().proposal?.status).toBe('pending');
  });
});

describe('revalidation', () => {
  it('stays ready after an unrelated user edit, and the candidate keeps that edit', () => {
    propose(patch());
    useEditor.getState().run({ type: 'updateElement', sceneId: 'scn_outro', elementId: 'el_outro_url', changes: { props: { text: 'relay.dev' } } });
    const { check } = useProposals.getState();
    expect(check?.status).toBe('ready');
    if (check?.status !== 'ready') return;
    expect(find(check.candidate, 'scn_outro', 'el_outro_url').props.text).toBe('relay.dev');
    expect(find(check.candidate, 'scn_intro', 'el_intro_headline').props.fontSize).toBe(120);

    const r = useProposals.getState().apply();
    expect(r.ok).toBe(true);
    expect(find(useEditor.getState().doc.project, 'scn_outro', 'el_outro_url').props.text).toBe('relay.dev');
    expect(headline().props.fontSize).toBe(120);
  });

  it('goes stale when the user edits a target: logged for the agent, never applied over the user’s work', () => {
    const r = propose(patch());
    useEditor.getState().run({ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 90 } } });
    const s = useProposals.getState();
    expect(s.check?.status).toBe('stale');
    expect(s.proposal?.id).toBe(r.ok && r.summary.id); // still on show, to explain why
    expect(s.log[0]).toMatchObject({ status: 'stale' });
    expect(s.log[0].reason).toContain('Headline in “Intro” changed after it was proposed');
    expect(editorContext().proposal).toBeNull();

    const doc = useEditor.getState().doc;
    const applied = s.apply();
    expect(applied.ok).toBe(false);
    expect(useEditor.getState().doc).toBe(doc);
    expect(headline().props.fontSize).toBe(90);
  });

  it('goes stale when another project is opened', () => {
    propose(patch());
    useEditor.getState().loadDocument(createDocState({ ...structuredClone(fixtureProject), id: 'prj_other' }), { kind: 'server', id: 'prj_other' });
    expect(useProposals.getState().check?.status).toBe('stale');
    expect(useProposals.getState().log[0]).toMatchObject({ status: 'stale', reason: 'Another project was opened.' });
  });

  it('a stale proposal is only dismissed: no second log entry', () => {
    propose(patch());
    useEditor.getState().run({ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 90 } } });
    useProposals.getState().cancel();
    expect(useProposals.getState().proposal).toBeNull();
    expect(useProposals.getState().log.map((l) => l.status)).toEqual(['stale']);
  });
});

describe('one pending proposal per project', () => {
  it('a different agent gets PROPOSAL_PENDING', async () => {
    propose(patch(), 'Codex');
    const r = await handleBridgeCommand({ type: 'applyPatch', patch: subPatch(), agent: 'Cursor' });
    expect(!r.ok && r.error.code).toBe('PROPOSAL_PENDING');
    expect(!r.ok && r.error.message).toBe('Codex’s proposal is waiting for the user’s review.');
    expect(useProposals.getState().proposal?.agent).toBe('Codex');
  });

  it('a newer proposal from the same agent replaces the older one', async () => {
    const first = propose(patch(), 'Codex');
    const r = await handleBridgeCommand({ type: 'applyPatch', patch: subPatch(), agent: 'Codex' });
    expect(r.ok).toBe(true);
    if (!r.ok || !first.ok) return;
    expect(r.replaced).toMatchObject({ id: first.summary.id, status: 'replaced' });
    expect(useProposals.getState().proposal?.patch.summary).toBe('Warmer subhead');
    expect(useProposals.getState().replaced?.id).toBe(first.summary.id);
    expect(useProposals.getState().log[0]).toMatchObject({ id: first.summary.id, status: 'replaced', reason: 'Replaced by a newer proposal from Codex' });
  });

  it('a pasted patch replaces any pending proposal', () => {
    const first = propose(patch(), 'Codex');
    const r = useProposals.getState().propose(subPatch(), { agent: PASTED_BY, source: 'paste' });
    expect(r.ok && r.summary).toMatchObject({ agent: 'You', source: 'paste' });
    expect(useProposals.getState().log[0]).toMatchObject({ id: first.ok && first.summary.id, status: 'replaced', reason: 'Replaced by a pasted patch' });
  });

  it('a generated take from the Takes panel is the user’s own, worded as a take, and replaces like a pasted patch', () => {
    const first = propose(patch(), 'Codex');
    const r = useProposals.getState().propose(subPatch(), { agent: TAKE_BY, source: 'paste' });
    expect(r.ok && r.summary).toMatchObject({ agent: TAKE_BY, source: 'paste' });
    expect(useProposals.getState().log[0]).toMatchObject({ id: first.ok && first.summary.id, status: 'replaced', reason: 'Replaced by a generated take' });
    expect(whose(TAKE_BY)).toBe('Your generated take');
    expect(whose(PASTED_BY)).toBe('Your pasted patch');
    expect([byYou(TAKE_BY), byYou(PASTED_BY), byYou('Codex')]).toEqual([true, true, false]);
  });

  it('an agent can\u2019t replace the person\u2019s pasted proposal, even under the same label', () => {
    const pasted = useProposals.getState().propose(subPatch(), { agent: PASTED_BY, source: 'paste' });
    expect(pasted.ok).toBe(true);
    for (const agent of ['Codex', PASTED_BY]) {
      const r = useProposals.getState().propose(patch(), { agent, source: 'mcp' });
      expect(r).toMatchObject({ ok: false, error: { code: 'PROPOSAL_PENDING' } });
    }
    expect(useProposals.getState().proposal?.source).toBe('paste');
  });

  it('invalid, locked, wrong-project and out-of-scope patches never become pending', () => {
    const bad = [
      patch({ commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: -1 } } }] }),
      patch({ projectId: 'prj_other' }),
      patch({ targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_sub' }] }),
    ];
    for (const p of bad) expect(propose(p).ok).toBe(false);
    useEditor.getState().run({ type: 'setSceneLock', sceneId: 'scn_intro', locked: true });
    const locked = propose(patch());
    expect(!locked.ok && locked.error.code).toBe('LOCKED');
    expect(useProposals.getState()).toMatchObject({ proposal: null, check: null, open: false, log: [] });
  });

  it('a stale pasted patch needs Reconcile, which rebases it when no target changed', () => {
    const p = patch();
    useEditor.getState().run({ type: 'updateProject', changes: { name: 'Renamed' } });
    const stale = useProposals.getState().propose(p, { agent: PASTED_BY, source: 'paste' });
    expect(!stale.ok && stale.error.code).toBe('STALE');
    const reconciled = useProposals.getState().propose(p, { agent: PASTED_BY, source: 'paste', reconcile: true });
    expect(reconciled.ok).toBe(true);
  });
});

describe('Auto-apply', () => {
  it('on: agent edits apply immediately as one revision, with no proposal', async () => {
    useProposals.getState().setAutoApply(true);
    const doc = useEditor.getState().doc;
    const r = await handleBridgeCommand({ type: 'applyPatch', patch: patch(), agent: 'Codex' });
    expect(r.ok && r.applied).toBe(true);
    expect(useEditor.getState().doc.project.revision).toBe(doc.project.revision + 1);
    expect(useProposals.getState().proposal).toBeNull();
    expect(editorContext().autoApply).toBe(true);
  });

  it("on: mode 'propose' still proposes", async () => {
    useProposals.getState().setAutoApply(true);
    const doc = useEditor.getState().doc;
    const r = await handleBridgeCommand({ type: 'applyPatch', patch: patch(), mode: 'propose' });
    expect(r.ok && r.applied).toBe(false);
    expect(useEditor.getState().doc).toBe(doc);
  });

  it('on: a stale agent patch is still refused', async () => {
    useProposals.getState().setAutoApply(true);
    const base = useEditor.getState().doc.project.revision;
    useEditor.getState().run({ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 90 } } });
    const r = await handleBridgeCommand({ type: 'applyPatch', patch: patch({ baseRevision: base }), reconcile: true });
    expect(!r.ok && r.error.code).toBe('STALE');
    expect(headline().props.fontSize).toBe(90);
  });
});
