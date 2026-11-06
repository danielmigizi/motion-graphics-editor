import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MouseEvent } from 'react';
import { createDocState } from '../core/history';
import { project } from '../core/__fixtures__/schema2Project';
import { actionById } from './actions';
import { closeContextMenu, openSceneMenu, useContextMenu } from './ContextMenu';
import { useEditor } from './store';

const st = () => useEditor.getState();
const event = () => ({ preventDefault: vi.fn(), stopPropagation: vi.fn(), clientX: 25, clientY: 50 }) as unknown as MouseEvent;

beforeEach(() => {
  const p = project();
  p.scenes.push({ ...p.scenes[0], id: 'second', name: 'Second', elements: [] });
  st().loadDocument(createDocState(p), { kind: 'sample' });
  st().setPlaying(true);
  closeContextMenu();
});

describe('scene context menu playback ownership', () => {
  it.each(['s', 'second'])('pauses before opening the menu on %s, including the current scene', (id) => {
    openSceneMenu(event(), id);
    expect(st().playing).toBe(false);
    expect(st().selection.sceneId).toBe(id);
    expect(useContextMenu.getState().open).toMatchObject({ kind: 'scene', x: 25, y: 50 });
    actionById('scene.lock')!.run();
    expect(st().doc.project.scenes.find((s) => s.id === id)!.locked).toBe(true);
    expect(st().doc.project.scenes.find((s) => s.id !== id)!.locked).toBe(false);
    actionById('scene.duplicate')!.run();
    const name = id === 's' ? 'Scene copy' : 'Second copy';
    expect(st().doc.project.scenes.some((s) => s.name === name)).toBe(true);
    closeContextMenu();
  });
});
