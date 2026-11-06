import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createDocState } from '../core/history';
import { project } from '../core/__fixtures__/schema2Project';
import type { Asset } from '../core/types';
import { uploadAsset } from './assets';
import { uploadMusic } from './SettingsDialog';
import { useEditor } from './store';

vi.mock('./assets', async (original) => ({ ...await original<typeof import('./assets')>(), uploadAsset: vi.fn() }));

const fields: Omit<Asset, 'id'> = { kind: 'audio', name: 'Music.wav', src: 'assets/music.wav', mimeType: 'audio/wav', durationInFrames: 200 };
const st = () => useEditor.getState();

beforeEach(() => {
  vi.mocked(uploadAsset).mockReset();
  st().loadDocument(createDocState(project()), { kind: 'sample' });
  useEditor.setState({ toasts: [] });
});

describe('Settings music uploads', () => {
  it('drops a pending upload after another document session opens, even for the same project id', async () => {
    let finish!: (value: typeof fields) => void;
    vi.mocked(uploadAsset).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const pending = uploadMusic(null);
    st().loadDocument(createDocState(project()), { kind: 'sample' });
    const before = st().doc;
    finish(fields);
    expect(await pending).toBe(false);
    expect(st().doc).toBe(before);
    expect(st().doc.project.audio).toEqual([]);
    expect(st().doc.project.assets).toEqual({});
    expect(st().toasts.at(-1)).toMatchObject({ tone: 'info', message: expect.stringContaining('another project is open') });
  });

  it('adds or replaces music in one undo step when the session stays open', async () => {
    vi.mocked(uploadAsset).mockResolvedValue(fields);
    const before = st().doc;
    expect(await uploadMusic(null)).toBe(true);
    const bed = st().doc.project.audio[0];
    expect(st().doc.project.assets[bed.assetId].name).toBe(fields.name);
    expect(st().doc.undoStack).toHaveLength(before.undoStack.length + 1);
    expect(await uploadMusic(bed)).toBe(true);
    expect(st().doc.project.audio).toHaveLength(1);
    expect(st().doc.project.audio[0].id).toBe(bed.id);
    expect(st().doc.project.audio[0].assetId).not.toBe(bed.assetId);
    st().undo();
    expect(st().doc.project.audio).toEqual([bed]);
    st().undo();
    expect(st().doc.project).toEqual({ ...before.project, revision: st().doc.project.revision });
  });

  it('leaves the document alone when the file picker is cancelled', async () => {
    vi.mocked(uploadAsset).mockResolvedValueOnce(null);
    const before = st().doc;
    expect(await uploadMusic(null)).toBe(false);
    expect(st().doc).toBe(before);
  });
});
