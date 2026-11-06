// The generation outcome tracker: which document changes count as a studio
// take being used, replaced or deleted.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import { createDocState } from '../core/history';
import { PATCH_PROTOCOL, type AiPatch, type Asset, type AssetProvenance, type Project } from '../core/types';
import { handleBridgeCommand } from './agentBridge';
import { api } from './api';
import { installOutcomeTracker, outcomeEvents } from './generationOutcomes';
import { useProposals } from './proposals';
import { useEditor } from './store';

const studio = (requestId: string, createdAt: number): AssetProvenance => ({ source: 'generated', provider: 'fal', requestId, createdAt, model: 'Seedream 5.0 Pro', providerRefs: { job: 'image.plate', modelId: 'seedream-5-pro' } });
const image = (id: string, provenance: AssetProvenance): Asset => ({ id, kind: 'image', name: `${id}.png`, src: `assets/uploads/${id}.png`, mimeType: 'image/png', width: 1600, height: 1000, provenance });

/**
 * The fixture with a studio job of two plates (take A shown by the product
 * screenshot element, take B unplaced), and an agent's take from before the
 * studio (request 'req_old') that is in use too.
 */
function project(): Project {
  const p = structuredClone(fixtureProject) as Project;
  p.assets.ast_a = image('ast_a', studio('gjob_1', 100));
  p.assets.ast_b = image('ast_b', studio('gjob_1', 110));
  p.assets.ast_old = image('ast_old', { source: 'generated', provider: 'fal', requestId: 'req_old', createdAt: 50 });
  p.assets.ast_old2 = image('ast_old2', { source: 'generated', provider: 'fal', requestId: 'req_old', createdAt: 60 });
  showIn(p, 'el_product_image', 'ast_a');
  showIn(p, 'el_hero_image', 'ast_old', 'scn_intro');
  return p;
}

/** Point an image element at `assetId` (adding the element to `sceneId` if it is not there). */
function showIn(p: Project, elementId: string, assetId: string, sceneId = 'scn_product') {
  const scene = p.scenes.find((s) => s.id === sceneId)!;
  const el = p.scenes.flatMap((s) => s.elements).find((e) => e.id === elementId);
  if (el) el.props = { ...el.props, assetId };
  else {
    const like = structuredClone(p.scenes.find((s) => s.id === 'scn_product')!.elements.find((e) => e.id === 'el_product_image')!);
    scene.elements.push({ ...like, id: elementId, startFrame: 0, durationInFrames: 200, props: { ...like.props, assetId } });
  }
}

const change = (edit: (p: Project) => void) => {
  const prev = project();
  const next = structuredClone(prev);
  edit(next);
  return outcomeEvents(prev, next);
};

describe('outcomeEvents', () => {
  it('a studio take placed in the video is used', () => {
    expect(change((p) => showIn(p, 'el_second', 'ast_b'))).toEqual([{ jobId: 'gjob_1', assetId: 'ast_b', event: 'used' }]);
  });

  it('a second place for a take already in use is not a new use', () => {
    expect(change((p) => showIn(p, 'el_second', 'ast_a'))).toEqual([]);
  });

  it('swapping one take for another of the same job: one used, one replaced', () => {
    expect(change((p) => showIn(p, 'el_product_image', 'ast_b'))).toEqual([
      { jobId: 'gjob_1', assetId: 'ast_b', event: 'used' },
      { jobId: 'gjob_1', assetId: 'ast_a', event: 'replaced' },
    ]);
  });

  it('an upload going in where the take was replaces it', () => {
    expect(change((p) => showIn(p, 'el_product_image', 'ast_screenshot'))).toEqual([{ jobId: 'gjob_1', assetId: 'ast_a', event: 'replaced' }]);
  });

  it('a take of another job going in where the take was replaces it', () => {
    const events = change((p) => {
      p.assets.ast_c = image('ast_c', studio('gjob_2', 200));
      showIn(p, 'el_product_image', 'ast_c');
    });
    expect(events).toEqual([
      { jobId: 'gjob_2', assetId: 'ast_c', event: 'used' },
      { jobId: 'gjob_1', assetId: 'ast_a', event: 'replaced' },
    ]);
  });

  it('a take still shown somewhere else is not replaced', () => {
    const events = change((p) => {
      showIn(p, 'el_second', 'ast_a');
      showIn(p, 'el_product_image', 'ast_screenshot');
    });
    expect(events).toEqual([]);
  });

  it('taking a take out of the video with nothing in its place is not a replacement', () => {
    const events = change((p) => {
      const scene = p.scenes.find((s) => s.id === 'scn_product')!;
      scene.elements = scene.elements.filter((e) => e.id !== 'el_product_image');
    });
    expect(events).toEqual([]);
  });

  it('a take in an audio clip replaced by another sound', () => {
    const prev = project();
    prev.assets.ast_vo = { id: 'ast_vo', kind: 'audio', name: 'vo.mp3', src: 'assets/uploads/vo.mp3', mimeType: 'audio/mpeg', durationInFrames: 30, provenance: studio('gjob_3', 300) };
    const original = prev.audio[0].assetId;
    prev.audio[0] = { ...prev.audio[0], assetId: 'ast_vo' };
    const next = structuredClone(prev);
    next.audio[0] = { ...next.audio[0], assetId: original };
    expect(outcomeEvents(prev, next)).toEqual([{ jobId: 'gjob_3', assetId: 'ast_vo', event: 'replaced' }]);
  });

  it('a deleted take is deleted, once, and never replaced, even while in use', () => {
    const events = change((p) => {
      delete p.assets.ast_a;
      showIn(p, 'el_product_image', 'ast_b');
    });
    expect(events).toEqual([
      { jobId: 'gjob_1', assetId: 'ast_a', event: 'deleted' },
      { jobId: 'gjob_1', assetId: 'ast_b', event: 'used' },
    ]);
    expect(change((p) => delete p.assets.ast_b)).toEqual([{ jobId: 'gjob_1', assetId: 'ast_b', event: 'deleted' }]);
  });

  it('ignores takes that are not from the studio, and uploads', () => {
    expect(
      change((p) => {
        showIn(p, 'el_hero_image', 'ast_old2', 'scn_intro');
        delete p.assets.ast_old;
        delete p.assets.ast_logo;
      }),
    ).toEqual([]);
  });

  it('counts audio clips as uses', () => {
    const events = change((p) => {
      p.assets.ast_vo = { id: 'ast_vo', kind: 'audio', name: 'vo.mp3', src: 'assets/uploads/vo.mp3', mimeType: 'audio/mpeg', durationInFrames: 30, provenance: studio('gjob_3', 300) };
      p.audio[0] = { ...p.audio[0], assetId: 'ast_vo' };
    });
    expect(events).toEqual([{ jobId: 'gjob_3', assetId: 'ast_vo', event: 'used' }]);
  });
});

describe('installOutcomeTracker', () => {
  let stop: (() => void) | null = null;
  afterEach(() => {
    stop?.();
    stop = null;
    vi.restoreAllMocks();
  });

  it('reports edits to the open document, but not opening another one', async () => {
    const report = vi.spyOn(api, 'reportOutcome').mockResolvedValue({ ok: true });
    useEditor.getState().loadDocument(createDocState(project()), { kind: 'new' });
    stop = installOutcomeTracker();

    expect(useEditor.getState().run({ type: 'updateElement', sceneId: 'scn_product', elementId: 'el_product_image', changes: { props: { assetId: 'ast_b' } } }, 'Use take B')).toBe(true);
    expect(report.mock.calls.map((c) => c[0])).toEqual([
      { jobId: 'gjob_1', assetId: 'ast_b', event: 'used' },
      { jobId: 'gjob_1', assetId: 'ast_a', event: 'replaced' },
    ]);

    // Another document (or the same one reopened) is a load, not an edit: nothing to report.
    report.mockClear();
    const other = project();
    other.assets = Object.fromEntries(Object.entries(other.assets).filter(([id]) => id !== 'ast_a' && id !== 'ast_b'));
    showIn(other, 'el_product_image', 'ast_screenshot');
    useEditor.getState().loadDocument(createDocState(other), { kind: 'new' });
    expect(report).not.toHaveBeenCalled();

    // A failing server is ignored.
    report.mockRejectedValue(new Error('down'));
    useEditor.getState().loadDocument(createDocState(project()), { kind: 'new' });
    expect(() => useEditor.getState().run({ type: 'updateElement', sceneId: 'scn_product', elementId: 'el_product_image', changes: { props: { assetId: 'ast_b' } } }, 'Use take B')).not.toThrow();
    expect(report).toHaveBeenCalledTimes(2);
    await Promise.resolve();
  });

  it('reports nothing for undo and redo, then reports the next edit', () => {
    const report = vi.spyOn(api, 'reportOutcome').mockResolvedValue({ ok: true });
    useEditor.getState().loadDocument(createDocState(project()), { kind: 'new' });
    stop = installOutcomeTracker();
    const st = () => useEditor.getState();

    // Use this take, then undo and redo it: the take was not un-used or replaced by a decision.
    st().run({ type: 'updateElement', sceneId: 'scn_product', elementId: 'el_product_image', changes: { props: { assetId: 'ast_b' } } }, 'Use take B');
    report.mockClear();
    st().undo();
    st().redo();
    st().undo();
    expect(report).not.toHaveBeenCalled();

    // Takes that arrived as one undo step and were undone are not deleted takes.
    const take = image('ast_new', studio('gjob_9', 900));
    st().run({ type: 'batch', label: 'Add 1 generated take', commands: [{ type: 'addAsset', asset: take }] }, 'Add 1 generated take');
    st().undo();
    expect(report).not.toHaveBeenCalled();

    // An ordinary edit after them is reported as usual.
    st().run({ type: 'updateElement', sceneId: 'scn_product', elementId: 'el_product_image', changes: { props: { assetId: 'ast_screenshot' } } }, 'Use the screenshot');
    expect(report.mock.calls.map((c) => c[0])).toEqual([{ jobId: 'gjob_1', assetId: 'ast_a', event: 'replaced' }]);
  });

  it('reports nothing for an agent’s Auto-apply patch; a proposal the person applies, and their own edits, still report', async () => {
    const report = vi.spyOn(api, 'reportOutcome').mockResolvedValue({ ok: true });
    const st = () => useEditor.getState();
    const shown = () => st().doc.project.scenes.flatMap((s) => s.elements).find((e) => e.id === 'el_product_image')!.props.assetId;
    const useTakeB = (): AiPatch => ({
      protocol: PATCH_PROTOCOL,
      projectId: st().doc.project.id,
      baseRevision: st().doc.project.revision,
      summary: 'Use take B',
      targets: [{ sceneId: 'scn_product', elementId: 'el_product_image' }],
      commands: [{ type: 'updateElement', sceneId: 'scn_product', elementId: 'el_product_image', changes: { props: { assetId: 'ast_b' } } }],
    });
    stop = installOutcomeTracker();
    try {
      // Auto-apply on: the agent's change lands in the document, but it is no decision of the person's.
      st().loadDocument(createDocState(project()), { kind: 'new' });
      useProposals.setState({ autoApply: true });
      expect(await handleBridgeCommand({ type: 'applyPatch', patch: useTakeB(), agent: 'Codex' })).toMatchObject({ ok: true, applied: true });
      expect(shown()).toBe('ast_b');
      expect(report).not.toHaveBeenCalled();

      // The person's own edit after it reports as usual.
      st().run({ type: 'updateElement', sceneId: 'scn_product', elementId: 'el_product_image', changes: { props: { assetId: 'ast_screenshot' } } }, 'Use the screenshot');
      expect(report.mock.calls.map((c) => c[0])).toEqual([{ jobId: 'gjob_1', assetId: 'ast_b', event: 'replaced' }]);

      // Auto-apply off: the same patch is a proposal, and applying it is the person's choice.
      report.mockClear();
      st().loadDocument(createDocState(project()), { kind: 'new' });
      useProposals.setState({ autoApply: false });
      expect(await handleBridgeCommand({ type: 'applyPatch', patch: useTakeB(), agent: 'Codex' })).toMatchObject({ ok: true, applied: false });
      expect(report).not.toHaveBeenCalled();
      expect(useProposals.getState().apply()).toMatchObject({ ok: true });
      expect(shown()).toBe('ast_b');
      expect(report.mock.calls.map((c) => c[0])).toEqual([
        { jobId: 'gjob_1', assetId: 'ast_b', event: 'used' },
        { jobId: 'gjob_1', assetId: 'ast_a', event: 'replaced' },
      ]);
    } finally {
      useProposals.setState({ proposal: null, check: null, open: false, autoApply: false });
    }
  });
});
