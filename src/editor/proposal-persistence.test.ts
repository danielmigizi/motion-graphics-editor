import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import { createDocState } from '../core/history';
import type { Proposal } from '../core/proposal';
import { PATCH_PROTOCOL, type ProjectFile } from '../core/types';
import { api, ApiRequestError } from './api';
import { acceptRecovery, discardRecovery, useRecovery } from './persistence';
import { useProposals } from './proposals';
import { useEditor, type DocOrigin } from './store';

const savedProposal = (): Proposal => ({
  id: 'prop_saved', projectId: fixtureProject.id, docSession: 'before-restart', agent: 'Cursor', source: 'mcp', reconcile: true, createdAt: 1000,
  patch: { protocol: PATCH_PROTOCOL, projectId: fixtureProject.id, baseRevision: fixtureProject.revision, summary: 'Bigger headline', targets: [{ sceneId: 'scn_intro', elementId: 'el_intro_headline' }], commands: [{ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 120 } } }] },
});
const open = (origin: DocOrigin = { kind: 'server', id: fixtureProject.id }) => useEditor.getState().loadDocument(createDocState(structuredClone(fixtureProject)), origin);
const missing = () => new ApiRequestError('No proposal', undefined, undefined, 404);
const drain = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

beforeEach(() => {
  vi.spyOn(api, 'getProposal').mockRejectedValue(missing());
  vi.spyOn(api, 'saveProposal').mockResolvedValue({ ok: true, savedAt: '2026-10-13T00:00:00Z' });
  vi.spyOn(api, 'deleteProposal').mockResolvedValue({ ok: true });
  useProposals.setState({ proposal: null, check: null, open: false, log: [], returnTo: null, replaced: null });
  useRecovery.setState({ offer: null, saved: null });
  open({ kind: 'sample' });
});
afterEach(async () => {
  useProposals.getState().cancel();
  await drain();
  vi.restoreAllMocks();
});

describe('persisted proposal review', () => {
  it('restores on server open into the new session, minimised and without changing the document', async () => {
    vi.mocked(api.getProposal).mockResolvedValue({ proposal: savedProposal(), savedAt: '2026-10-13T00:00:00Z' });
    open();
    const doc = useEditor.getState().doc;
    await drain();
    expect(useProposals.getState()).toMatchObject({ open: false, check: { status: 'ready' }, proposal: { id: 'prop_saved', docSession: useEditor.getState().docSession } });
    expect(useEditor.getState().doc).toBe(doc);
    expect(api.saveProposal).not.toHaveBeenCalled();
  });

  it('logs stale restoration with the specified reason and removes its saved file', async () => {
    vi.mocked(api.getProposal).mockResolvedValue({ proposal: savedProposal(), savedAt: '2026-10-13T00:00:00Z' });
    useEditor.getState().run({ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 90 } } });
    useEditor.getState().loadDocument(useEditor.getState().doc, { kind: 'server', id: fixtureProject.id });
    await drain();
    expect(useProposals.getState()).toMatchObject({ open: false, check: { status: 'stale' }, log: [{ status: 'stale', reason: 'The project changed since this was proposed' }] });
    expect(api.deleteProposal).toHaveBeenCalledWith(fixtureProject.id);
  });

  it.each(['apply', 'cancel'] as const)('deletes persisted proposal on %s', async (decision) => {
    open();
    await drain();
    expect(useProposals.getState().propose(savedProposal().patch, { agent: 'Codex', source: 'mcp' }).ok).toBe(true);
    await drain();
    expect(api.saveProposal).toHaveBeenCalledTimes(1);
    useProposals.getState()[decision]();
    await drain();
    expect(api.deleteProposal).toHaveBeenCalledWith(fixtureProject.id);
  });

  it('serialises replacement and deletion behind a pending save', async () => {
    open();
    await drain();
    let finish!: () => void;
    vi.mocked(api.saveProposal).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ ok: true, savedAt: 'now' }); }));
    const s = useProposals.getState();
    s.propose(savedProposal().patch, { agent: 'Codex', source: 'mcp' });
    await drain();
    s.propose(savedProposal().patch, { agent: 'Codex', source: 'mcp' });
    s.cancel();
    expect(api.deleteProposal).not.toHaveBeenCalled();
    finish();
    await drain();
    expect(api.saveProposal).toHaveBeenCalledTimes(2);
    expect(api.deleteProposal).toHaveBeenCalledTimes(2);
    const saves = vi.mocked(api.saveProposal).mock.invocationCallOrder;
    const deletes = vi.mocked(api.deleteProposal).mock.invocationCallOrder;
    expect(saves[0]).toBeLessThan(deletes[0]);
    expect(deletes[0]).toBeLessThan(saves[1]);
    expect(saves[1]).toBeLessThan(deletes[1]);
  });

  it('keeps the saved copy of the person\u2019s pasted patch when it goes stale (only they discard it)', async () => {
    open();
    await drain();
    useProposals.getState().propose(savedProposal().patch, { agent: 'You', source: 'paste' });
    await drain();
    useEditor.getState().run({ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 90 } } });
    await drain();
    expect(api.deleteProposal).not.toHaveBeenCalled();
    // While it is on show, stale or not, an agent's proposal can't take its saved slot.
    vi.mocked(api.saveProposal).mockClear();
    expect(useProposals.getState().propose(savedProposal().patch, { agent: 'Codex', source: 'mcp' })).toMatchObject({ ok: false, error: { code: 'PROPOSAL_PENDING' } });
    expect(api.saveProposal).not.toHaveBeenCalled();
    useProposals.getState().cancel();
    await drain();
    expect(api.deleteProposal).toHaveBeenCalledWith(fixtureProject.id);
  });

  it('deletes a proposal when a target edit makes it stale', async () => {
    open();
    await drain();
    useProposals.getState().propose(savedProposal().patch, { agent: 'Codex', source: 'mcp' });
    useEditor.getState().run({ type: 'updateElement', sceneId: 'scn_intro', elementId: 'el_intro_headline', changes: { props: { fontSize: 90 } } });
    await drain();
    expect(api.deleteProposal).toHaveBeenCalledWith(fixtureProject.id);
  });

  it('refuses an agent\u2019s proposal while the project\u2019s saved proposal is still being restored', async () => {
    let answer!: (v: { proposal: Proposal; savedAt: string }) => void;
    vi.mocked(api.getProposal).mockImplementation(() => new Promise((r) => { answer = r; }));
    open();
    await drain();
    const r = useProposals.getState().propose(savedProposal().patch, { agent: 'Codex', source: 'mcp' });
    expect(r).toMatchObject({ ok: false, error: { code: 'PROPOSAL_PENDING' } });
    expect(api.saveProposal).not.toHaveBeenCalled();
    answer({ proposal: { ...savedProposal(), agent: 'You', source: 'paste' }, savedAt: '2026-10-13T00:00:00Z' });
    await drain();
    expect(useProposals.getState().proposal?.source).toBe('paste');
  });

  it('a pasted patch with no confirmed saved copy (a sample document) still blocks agents after a switch', async () => {
    open({ kind: 'sample' });
    useProposals.getState().propose(savedProposal().patch, { agent: 'You', source: 'paste' });
    open();
    await drain();
    expect(useProposals.getState().propose(savedProposal().patch, { agent: 'Codex', source: 'mcp' })).toMatchObject({ ok: false, error: { code: 'PROPOSAL_PENDING' } });
  });

  it('opening a project with a saved proposal doesn\u2019t push out a pasted patch that has no saved copy', async () => {
    open({ kind: 'sample' });
    useProposals.getState().propose(savedProposal().patch, { agent: 'You', source: 'paste' });
    vi.mocked(api.getProposal).mockResolvedValue({ proposal: savedProposal(), savedAt: '2026-10-13T00:00:00Z' });
    open();
    await drain();
    expect(useProposals.getState().proposal?.source).toBe('paste');
  });

  it('a pasted patch left over from another project doesn\u2019t block agents in the project now open', async () => {
    open();
    await drain();
    useProposals.getState().propose(savedProposal().patch, { agent: 'You', source: 'paste' });
    await drain();
    open({ kind: 'server', id: 'prj_other' });
    await drain();
    expect(useProposals.getState().proposal?.source).toBe('paste');
    const other = { ...savedProposal().patch, projectId: fixtureProject.id };
    expect(useProposals.getState().propose(other, { agent: 'Codex', source: 'mcp' })).not.toMatchObject({ error: { code: 'PROPOSAL_PENDING' } });
    expect(api.deleteProposal).not.toHaveBeenCalled();
  });

  it('keeps agents off a saved proposal it couldn\u2019t load (not a 404), so they can\u2019t overwrite it', async () => {
    vi.mocked(api.getProposal).mockRejectedValue(new ApiRequestError('Server error', undefined, undefined, 500));
    open();
    await drain();
    expect(useProposals.getState().propose(savedProposal().patch, { agent: 'Codex', source: 'mcp' })).toMatchObject({ ok: false, error: { code: 'PROPOSAL_PENDING' } });
    expect(api.saveProposal).not.toHaveBeenCalled();
  });

  it('keeps the saved proposal when another project is opened (an agent can open one), so it returns with its project', async () => {
    open();
    await drain();
    useProposals.getState().propose(savedProposal().patch, { agent: 'Codex', source: 'mcp' });
    await drain();
    open({ kind: 'server', id: 'prj_other' });
    await drain();
    expect(useProposals.getState().log[0]).toMatchObject({ status: 'stale', reason: 'Another project was opened.' });
    expect(api.deleteProposal).not.toHaveBeenCalled();
  });

  it.each([{ kind: 'sample' }, { kind: 'file', name: 'project.json' }, { kind: 'recovered' }] as DocOrigin[])('never persists %j documents', async (origin) => {
    open(origin);
    useProposals.getState().propose(savedProposal().patch, { agent: 'Codex', source: 'mcp' });
    useProposals.getState().cancel();
    await drain();
    expect(api.getProposal).not.toHaveBeenCalled();
    expect(api.saveProposal).not.toHaveBeenCalled();
    expect(api.deleteProposal).not.toHaveBeenCalled();
  });

  describe('with a recovery offer pending (saved r1, recovered r2, proposal based on r2)', () => {
    const r2: ProjectFile = { format: 'mge.project/1', project: { ...structuredClone(fixtureProject), revision: fixtureProject.revision + 1 }, revisions: [], savedAt: new Date(0).toISOString() };
    const onR2 = (): Proposal => ({ ...savedProposal(), patch: { ...savedProposal().patch, baseRevision: r2.project.revision } });
    const openWithOffer = async () => {
      vi.mocked(api.getProposal).mockResolvedValue({ proposal: onR2(), savedAt: 'now' });
      // As openFromServer does: open the saved file, then offer recovery.
      open();
      useRecovery.setState({ offer: { file: r2, at: 0 } });
      await drain();
      expect(useProposals.getState().proposal).toBeNull();
      expect(api.deleteProposal).not.toHaveBeenCalled();
    };

    it('restores the proposal against the recovered document after Recover', async () => {
      await openWithOffer();
      acceptRecovery();
      await drain();
      expect(useEditor.getState().doc.project.revision).toBe(r2.project.revision);
      expect(useProposals.getState()).toMatchObject({ check: { status: 'ready' }, proposal: { id: 'prop_saved', docSession: useEditor.getState().docSession } });
      expect(api.deleteProposal).not.toHaveBeenCalled();
    });

    it('checks it against the saved document, and drops it as stale, after Discard', async () => {
      await openWithOffer();
      discardRecovery();
      await drain();
      expect(useProposals.getState()).toMatchObject({ check: { status: 'stale' }, proposal: { id: 'prop_saved' } });
      expect(api.deleteProposal).toHaveBeenCalledWith(fixtureProject.id);
    });
  });

  it('ignores a late restoration after another document opens', async () => {
    let finish!: () => void;
    vi.mocked(api.getProposal).mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve({ proposal: savedProposal(), savedAt: 'now' }); }));
    open();
    await drain();
    open({ kind: 'file', name: 'other.json' });
    finish();
    await drain();
    expect(useProposals.getState().proposal).toBeNull();
  });

  it('keeps review available and reports a failed persistence write', async () => {
    open();
    await drain();
    vi.mocked(api.saveProposal).mockRejectedValueOnce(new Error('disk full'));
    const result = useProposals.getState().propose(savedProposal().patch, { agent: 'Codex', source: 'mcp' });
    expect(result.ok).toBe(true);
    await drain();
    expect(useProposals.getState().check?.status).toBe('ready');
    expect(useEditor.getState().toasts.at(-1)?.message).toContain('disk full');
  });
});
