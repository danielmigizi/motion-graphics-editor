import { afterEach, describe, expect, it, vi } from 'vitest';
import v1 from '../core/__fixtures__/v1-project.json';
import { duplicateScene, loadDoc, readAutosave } from './doc';
import { element, project } from '../core/__fixtures__/schema2Project';
import { validateProject } from '../core/validate';

const file=()=>({format:'mge.project/1',project:structuredClone(v1),revisions:[],savedAt:'2026-01-01T00:00:00Z'});
afterEach(()=>vi.unstubAllGlobals());

describe('editor document migration',()=>{
  it('imports a legacy file and returns a migrated file envelope',()=>{
    const raw=file(); const loaded=loadDoc(raw);
    expect(loaded.ok).toBe(true); if(!loaded.ok)return;
    expect(loaded.file.project.schemaVersion).toBe(3); expect(loaded.state.project.scenes).toEqual(raw.project.scenes); expect(loaded.file.revisions.every(r=>r.snapshot.schemaVersion===3)).toBe(true);
  });
  it('upgrades localStorage recovery before returning its metadata',()=>{
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({file:file(),at:123,session:'old'})});
    const recovered=readAutosave(); expect(recovered).toMatchObject({at:123,session:'old',file:{project:{schemaVersion:3,compositions:{},markers:[]}}});
    expect(recovered!.file.project.scenes).toEqual(v1.scenes);
  });
  it('does not offer invalid or newer recovery files',()=>{
    const raw=file(); raw.project.schemaVersion=99;
    vi.stubGlobal('localStorage',{getItem:()=>JSON.stringify({file:raw,at:123})}); expect(readAutosave()).toBeNull();
  });
  it('duplicates groups and masks with remapped internal IDs',()=>{
    const scene=project([element('g','group'),element('source','shape',{parentId:'g'}),element('target','text',{parentId:'g',mask:{sourceId:'source',mode:'alpha'}})]).scenes[0];
    const copy=duplicateScene(scene); const [group,source,target]=copy.elements;
    expect(source.parentId).toBe(group.id); expect(target.parentId).toBe(group.id); expect(target.mask!.sourceId).toBe(source.id);
    expect(scene.elements[1].parentId).toBe('g'); const p=project(scene.elements); p.scenes.push(copy); expect(validateProject(p).ok).toBe(true);
  });
});
