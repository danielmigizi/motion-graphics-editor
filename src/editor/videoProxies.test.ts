// i7 #2: a proxy finishing in the background is recorded outside the document,
// so it never adds an undo step or clears the redo stack.

import { beforeEach, describe, expect, it } from 'vitest';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import { createDocState } from '../core/history';
import type { Asset, Project } from '../core/types';
import { clearPreviewProxies, previewProxyFor } from '../composition/previewProxies';
import { useEditor } from './store';
import { applyProxyStatuses, previewState, useVideoProxyStatus } from './videoProxies';

const video: Asset = { id: 'ast_rec', kind: 'video', name: 'rec.mp4', src: 'assets/uploads/u_rec.mp4', mimeType: 'video/mp4', durationInFrames: 90 };

beforeEach(() => {
  const p = structuredClone(fixtureProject) as Project;
  p.assets.ast_rec = video;
  useEditor.getState().loadDocument(createDocState(p), { kind: 'server', id: p.id });
  clearPreviewProxies();
  useVideoProxyStatus.setState({ bySrc: {} });
});

describe('background proxies', () => {
  it('a ready proxy keeps the redo stack and the next undo, and does not touch the document', () => {
    const st = useEditor.getState();
    const logo = Object.keys(st.doc.project.assets).find((id) => id !== 'ast_rec')!;
    expect(st.run({ type: 'replaceAsset', assetId: logo, changes: { name: 'Renamed' } })).toBe(true);
    useEditor.getState().undo();
    const before = useEditor.getState().doc;
    expect(before.redoStack).toHaveLength(1);

    const again = applyProxyStatuses([
      [video.src, { status: 'ready', proxySrc: 'assets/uploads/u_rec.proxy.mp4', reasons: ['larger than 1080p'] }],
      ['assets/uploads/u_other.mp4', { status: 'pending', reasons: [] }],
      ['assets/uploads/u_down.mp4', null],
    ]);
    expect(again).toEqual(['assets/uploads/u_other.mp4', 'assets/uploads/u_down.mp4']);

    const after = useEditor.getState().doc;
    expect(after).toBe(before);
    expect(after.project.assets.ast_rec.proxySrc).toBeUndefined();
    expect(previewProxyFor(video.src)).toBe('assets/uploads/u_rec.proxy.mp4');
    expect(previewState(video, useVideoProxyStatus.getState().bySrc[video.src]).kind).toBe('proxy');
    // Redo still redoes the user's edit.
    useEditor.getState().redo();
    expect(useEditor.getState().doc.project.assets[logo].name).toBe('Renamed');
  });

  it('shows preparing / failed / original from the status', () => {
    expect(previewState(video, { status: 'pending', reasons: ['few keyframes'] })).toEqual({ kind: 'preparing', text: 'Preparing preview… (few keyframes)' });
    expect(previewState(video, { status: 'failed', error: 'boom', reasons: [] }).kind).toBe('failed');
    expect(previewState(video, { status: 'none', reasons: [] }).kind).toBe('original');
    expect(previewState(video, { status: 'ready', proxySrc: 'assets/uploads/u_rec.proxy.mp4', reasons: [] }).kind).toBe('proxy');
  });
});
