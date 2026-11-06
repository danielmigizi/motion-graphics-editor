// Insert → Video…: the upload finishes in the document it started from, or not at all.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import { createDocState } from '../core/history';
import type { Asset, Project } from '../core/types';
import { uploadAsset } from './assets';
import { useEditor } from './store';
import { insertVideoFromFile } from './VideoAssetRow';

vi.mock('./assets', async (importOriginal) => ({ ...(await importOriginal<typeof import('./assets')>()), uploadAsset: vi.fn() }));

const fields: Omit<Asset, 'id'> = { kind: 'video', name: 'clip.mp4', src: 'assets/uploads/u_clip.mp4', mimeType: 'video/mp4', durationInFrames: 90, width: 1920, height: 1080, fps: 30, hasAudio: true };

const open = (p: Project) => useEditor.getState().loadDocument(createDocState(p), { kind: 'server', id: p.id });

beforeEach(() => {
  open(structuredClone(fixtureProject) as Project);
  useEditor.getState().selectElement('scn_intro', null);
  useEditor.setState({ toasts: [] });
});

/** Upload "completes" after `during` ran (e.g. the user switched projects meanwhile). */
const uploadAfter = (during: () => void) => vi.mocked(uploadAsset).mockImplementationOnce(async () => (during(), fields));

describe('insertVideoFromFile', () => {
  it('inserts into the scene it started from', async () => {
    uploadAfter(() => {});
    expect(await insertVideoFromFile()).toBe(true);
    const scene = useEditor.getState().doc.project.scenes.find((s) => s.id === 'scn_intro')!;
    expect(scene.elements.some((e) => e.type === 'video')).toBe(true);
  });

  it('does not insert into another project that has the same scene id', async () => {
    const other = { ...(structuredClone(fixtureProject) as Project), id: 'prj_other', name: 'Other' };
    uploadAfter(() => open(other));
    expect(await insertVideoFromFile()).toBe(false);
    const now = useEditor.getState().doc.project;
    expect(now.id).toBe('prj_other');
    expect(now.revision).toBe(other.revision);
    expect(now.scenes.find((s) => s.id === 'scn_intro')!.elements.some((e) => e.type === 'video')).toBe(false);
    expect(useEditor.getState().toasts.at(-1)?.message).toContain('another project is open');
  });

  it('does not insert after the same project was reopened (a new document session)', async () => {
    uploadAfter(() => open(structuredClone(fixtureProject) as Project));
    expect(await insertVideoFromFile()).toBe(false);
    expect(useEditor.getState().doc.project.scenes.find((s) => s.id === 'scn_intro')!.elements.some((e) => e.type === 'video')).toBe(false);
  });
});
