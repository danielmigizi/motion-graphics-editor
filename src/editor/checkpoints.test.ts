import { beforeEach, describe, expect, it } from 'vitest';
import { createDocState, serializeDoc } from '../core/history';
import type { Checkpoint } from '../core/api-contract';
import { fixtureProject } from '../core/__fixtures__/fixtureProject';
import { useEditor } from './store';

const checkpoint = (): Checkpoint => ({ id: 'cp_test', name: 'Approved', createdAt: new Date().toISOString(), revision: fixtureProject.revision, projectHash: '', file: serializeDoc(createDocState(structuredClone(fixtureProject))) });
beforeEach(() => useEditor.getState().loadDocument(createDocState(structuredClone(fixtureProject)), { kind: 'server', id: fixtureProject.id }));
describe('checkpoint restore', () => {
  it('appends one rollback revision, keeps history, and undo returns to the pre-restore document', () => {
    const cp = checkpoint();
    useEditor.getState().run({ type: 'updateProject', changes: { name: 'Edited' } });
    const before = useEditor.getState().doc;
    expect(useEditor.getState().restoreCheckpoint(cp)).toBeNull();
    const after = useEditor.getState().doc;
    expect(after.project.revision).toBe(before.project.revision + 1);
    expect(after.revisions).toHaveLength(before.revisions.length + 1);
    expect(after.undoStack).toHaveLength(before.undoStack.length + 1);
    expect(after.revisions.at(-1)).toMatchObject({ source: 'rollback', label: 'Restore checkpoint “Approved”' });
    useEditor.getState().undo();
    expect(useEditor.getState().doc.project).toEqual({ ...before.project, revision: after.project.revision + 1 });
  });
  it('refuses a different project and changes to locked scenes without adding history', () => {
    const cp = checkpoint();
    const other = checkpoint();
    other.file.project.id = 'other'; other.file.revisions = [];
    expect(useEditor.getState().restoreCheckpoint(other)?.code).toBe('PROJECT_MISMATCH');
    useEditor.getState().run({ type: 'setSceneLock', sceneId: fixtureProject.scenes[0].id, locked: true });
    const before = useEditor.getState().doc;
    expect(useEditor.getState().restoreCheckpoint(cp)?.code).toBe('LOCKED');
    expect(useEditor.getState().doc).toBe(before);
  });
});
