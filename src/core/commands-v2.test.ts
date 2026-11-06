import { describe, expect, it } from 'vitest';
import { composition, element, project } from './__fixtures__/schema2Project';
import { evaluateElementWorld, worldCorners } from './animation';
import { applyCommand } from './commands';
import { diffProjects } from './diff';
import { createDocState, execute, redo, restoreRevision, touchedBetween, undo } from './history';
import { checkPatch } from './patch';
import { validateProject } from './validate';
import type { AiPatch, Command, Element, Project } from './types';

function apply(p: Project, command: Command) { const r=applyCommand(p,command,{source:'user'}); if(!r.ok) throw new Error(`${r.error.path}: ${r.error.message}`); return r; }
function state(p: Project, command: Command) { const r=execute(createDocState(p),command); if(!r.ok) throw new Error(`${r.error.path}: ${r.error.message}`); return r.state; }
const el = (p: Project,id='a') => p.scenes[0].elements.find(e=>e.id===id)!;
const sceneId='s';
const instance = (id: string,cid: string) => element(id,'instance',{props:{compositionId:cid,timeOffset:0,loop:false}});
const curve={type:'cubicBezier' as const,x1:0.2,y1:0,x2:0.8,y2:1};

const newCommands: Command[] = [
  {type:'setPropertyKeyframe',sceneId,elementId:'a',key:'props.cornerRadius',frame:10,value:40,easing:curve},
  {type:'removePropertyKeyframe',sceneId,elementId:'a',key:'props.cornerRadius',frame:0},
  {type:'setParent',sceneId,elementId:'a',parentId:'g'},
  {type:'groupElements',sceneId,elementIds:['a','b'],group:{id:'new',name:'Group'}},
  {type:'ungroup',sceneId,groupId:'g'},
  {type:'addComposition',composition:composition('new')},
  {type:'updateComposition',compositionId:'c',changes:{name:'Renamed'}},
  {type:'removeComposition',compositionId:'c'},
  {type:'setMarker',marker:{id:'new',frame:20,label:'Beat'}},
  {type:'removeMarker',markerId:'m'},
  {type:'changeFormat',width:500,height:300,fps:60,conversion:{layout:'scale',timing:'keepSeconds'}},
];
const base = () => {
  const p=project([element('a','shape',{propTracks:[{key:'props.cornerRadius',keyframes:[{frame:0,value:24,easing:'linear'}]}]}),element('b','text'),element('g','group'),element('child','shape',{parentId:'g'})]);
  p.compositions.c=composition('c'); p.markers=[{id:'m',frame:0,label:'Start'}]; return p;
};

describe('v2 commands and history', () => {
  it.each(newCommands.map(command=>[command.type,command] as const))('%s is undoable and redoable in one revision', (_,command) => {
    const p=base(), s=state(p,command); expect(s.project.revision).toBe(2); expect(s.undoStack).toHaveLength(1); expect(validateProject(s.project).ok).toBe(true);
    const undone=undo(s); expect({...undone.project,revision:1}).toEqual(p); const redone=redo(undone); expect({...redone.project,revision:2}).toEqual(s.project);
    const refs=s.revisions.at(-1)!.touched;
    if(command.type.includes('Composition')) expect(refs).toEqual([{kind:'composition',compositionId:command.type==='addComposition'?'new':'c'}]);
    else if(command.type==='changeFormat') expect(refs).toEqual([{kind:'project'},{kind:'scene',sceneId:'s'}]);
    else if(['setMarker','removeMarker'].includes(command.type)) expect(refs).toEqual([{kind:'project'}]);
  });
  it.each(newCommands.filter(c=>'sceneId' in c || c.type==='changeFormat').map(c=>[c.type,c] as const))('%s respects locked scenes', (_,command) => {
    const p=base(); p.scenes[0].locked=true;
    expect(applyCommand(p,command,{source:'user'})).toMatchObject({ok:false,error:{code:'LOCKED'}});
  });
  it('property keys insert sorted, replace easing only when specified, and remove empty tracks', () => {
    let p=project();
    p=apply(p,{type:'setPropertyKeyframe',sceneId,elementId:'a',key:'props.cornerRadius',frame:20,value:50,easing:curve}).project;
    p=apply(p,{type:'setPropertyKeyframe',sceneId,elementId:'a',key:'props.cornerRadius',frame:0,value:5,easing:'hold'}).project;
    p=apply(p,{type:'setPropertyKeyframe',sceneId,elementId:'a',key:'props.cornerRadius',frame:20,value:80}).project;
    expect(el(p).propTracks![0].keyframes).toEqual([{frame:0,value:5,easing:'hold'},{frame:20,value:80,easing:curve}]);
    p=apply(p,{type:'removePropertyKeyframe',sceneId,elementId:'a',key:'props.cornerRadius',frame:20}).project;
    p=apply(p,{type:'removePropertyKeyframe',sceneId,elementId:'a',key:'props.cornerRadius',frame:0}).project; expect(el(p).propTracks).toBeUndefined();
    expect(applyCommand(p,{type:'removePropertyKeyframe',sceneId,elementId:'a',key:'props.cornerRadius',frame:0},{source:'user'})).toMatchObject({ok:false,error:{code:'NOT_FOUND',path:'frame'}});
  });
  it('removes group descendants and clears users of removed mask sources atomically', () => {
    const p=project([element('g','group'),element('nested','group',{parentId:'g'}),element('mask','shape',{parentId:'nested'}),element('child','shape',{parentId:'nested'}),element('source'),element('target','text',{mask:{sourceId:'source',mode:'alpha'}})]);
    const r=apply(p,{type:'removeElement',sceneId,elementId:'g'}); expect(r.project.scenes[0].elements.map(e=>e.id)).toEqual(['source','target']);
    expect(r.touched).toHaveLength(4); const next=apply(r.project,{type:'removeElement',sceneId,elementId:'source'}); expect(el(next.project,'target').mask).toBeUndefined(); expect(next.touched).toHaveLength(2);
  });
  it('merges effects and clears effects/mask/blend with null, preserving tracks', () => {
    let p=project(); const first=apply(p,{type:'updateElement',sceneId,elementId:'b',changes:{blendMode:'screen',effects:{blur:5,contrast:2},mask:{sourceId:'a',mode:'alpha'}}}); p=first.project;
    p=apply(p,{type:'updateElement',sceneId,elementId:'b',changes:{effects:{blur:null,brightness:1.2}}}).project; expect(el(p,'b').effects).toEqual({contrast:2,brightness:1.2});
    p=apply(p,{type:'updateElement',sceneId,elementId:'b',changes:{effects:null,blendMode:null,mask:null}}).project;
    expect(el(p,'b').effects).toBeUndefined(); expect(el(p,'b').blendMode).toBeUndefined(); expect(el(p,'b').mask).toBeUndefined();
  });
  it('setParent keeps world geometry at local frame zero through rotated/scaled nesting', () => {
    const root=element('root','group',{startFrame:5,durationInFrames:95,transform:{x:100,y:100,width:200,height:100,rotation:90,scale:2,opacity:1}});
    const g=element('g','group',{parentId:'root',startFrame:5,transform:{x:20,y:30,width:80,height:60,rotation:30,scale:0.5,opacity:1}});
    const child=element('a','shape',{startFrame:20,durationInFrames:80,transform:{x:300,y:200,width:80,height:60,rotation:15,scale:1.3,opacity:1},tracks:[{property:'x',keyframes:[{frame:0,value:10,easing:'linear'}]},{property:'scale',keyframes:[{frame:0,value:1.2,easing:'linear'}]}]});
    const p=project([root,g,child]); const before=evaluateElementWorld(p.scenes[0].elements,child,20);
    const next=apply(p,{type:'setParent',sceneId,elementId:'a',parentId:'g'}).project; const after=evaluateElementWorld(next.scenes[0].elements,el(next),20);
    expect(el(next).startFrame).toBe(10); expect(after.localFrame).toBe(0); expect(after.rotation).toBeCloseTo(before.rotation); expect(after.scale).toBeCloseTo(before.scale);
    expect(Math.abs(after.x-before.x)).toBeLessThanOrEqual(0.71); expect(Math.abs(after.y-before.y)).toBeLessThanOrEqual(0.71);
    const detached=apply(next,{type:'setParent',sceneId,elementId:'a',parentId:null}).project; expect(el(detached).startFrame).toBe(20);
    const restored=evaluateElementWorld(detached.scenes[0].elements,el(detached),20); expect(Math.abs(restored.x-before.x)).toBeLessThanOrEqual(1); expect(Math.abs(restored.y-before.y)).toBeLessThanOrEqual(1);
    expect(el(next).tracks).toBe(child.tracks);
  });
  it('setParent rejects cycles, late parents and singular transforms; keepWorld:false uses current local values', () => {
    const p=project([element('g','group'),element('a','group',{parentId:'g'})]);
    expect(applyCommand(p,{type:'setParent',sceneId,elementId:'g',parentId:'a'},{source:'user'})).toMatchObject({ok:false,error:{path:'parentId'}});
    el(p,'g').startFrame=10; el(p,'a').parentId=undefined;
    expect(applyCommand(p,{type:'setParent',sceneId,elementId:'a',parentId:'g'},{source:'user'})).toMatchObject({ok:false,error:{path:'parentId'}});
    el(p,'g').startFrame=0; el(p,'g').tracks=[{property:'scale',keyframes:[{frame:0,value:0,easing:'linear'}]}];
    expect(applyCommand(p,{type:'setParent',sceneId,elementId:'a',parentId:'g'},{source:'user'})).toMatchObject({ok:false,error:{path:'parentId'}});
    el(p,'g').tracks=[]; const moved=apply(p,{type:'setParent',sceneId,elementId:'a',parentId:'g',keepWorld:false}).project; expect(el(moved).transform).toEqual(el(p).transform);
  });
  it('group/ungroup preserves placement and timing, fits world boxes, and inserts at the topmost child', () => {
    const a=element('a','shape',{startFrame:10,durationInFrames:90}), b=element('b','text',{startFrame:20,durationInFrames:80,transform:{x:200,y:100,width:100,height:50,rotation:90,scale:1,opacity:1}});
    const p=project([a,element('other'),b]); const boxes=[worldCorners(p.scenes[0].elements,a,10),worldCorners(p.scenes[0].elements,b,20)].flat();
    const grouped=apply(p,{type:'groupElements',sceneId,elementIds:['a','b'],group:{id:'g',name:'Group'}}).project;
    expect(grouped.scenes[0].elements.map(e=>e.id)).toEqual(['a','other','g','b']);
    expect(el(grouped,'g')).toMatchObject({startFrame:10,durationInFrames:90,transform:{x:Math.min(...boxes.map(p=>p.x)),y:Math.min(...boxes.map(p=>p.y))}});
    expect(el(grouped,'b').startFrame).toBe(10);
    for(const child of [a,b]) { const before=worldCorners(p.scenes[0].elements,child,child.startFrame), after=worldCorners(grouped.scenes[0].elements,el(grouped,child.id),child.startFrame); after.forEach((point,i)=>{expect(point.x).toBeCloseTo(before[i].x);expect(point.y).toBeCloseTo(before[i].y);}); }
    const restored=apply(grouped,{type:'ungroup',sceneId,groupId:'g'}).project; expect(restored.scenes[0].elements).toEqual([p.scenes[0].elements[1],a,b]);
  });
  it('nested group/ungroup keeps the existing parent and world placement', () => {
    const root=element('root','group',{transform:{x:100,y:100,width:200,height:200,rotation:90,scale:2,opacity:1}});
    const a=element('a','shape',{parentId:'root'}), b=element('b','shape',{parentId:'root',startFrame:10,durationInFrames:90});
    const p=project([root,a,b]); const grouped=apply(p,{type:'groupElements',sceneId,elementIds:['a','b'],group:{id:'g',name:'Nested'}}).project;
    expect(el(grouped,'g').parentId).toBe('root');
    const restored=apply(grouped,{type:'ungroup',sceneId,groupId:'g'}).project;
    for(const id of ['a','b']) {const before=evaluateElementWorld(p.scenes[0].elements,el(p,id),id==='a'?0:10),after=evaluateElementWorld(restored.scenes[0].elements,el(restored,id),id==='a'?0:10);expect(after.x).toBeCloseTo(before.x);expect(after.y).toBeCloseTo(before.y);expect(after.rotation).toBeCloseTo(before.rotation);}
  });
  it('rejects different parents, missing children, duplicate children and ungrouping a non-group', () => {
    const p=base();
    for(const ids of [['a','a'],['a','missing'],['a','child']]) expect(applyCommand(p,{type:'groupElements',sceneId,elementIds:ids,group:{id:'new',name:'Group'}},{source:'user'}).ok).toBe(false);
    expect(applyCommand(p,{type:'ungroup',sceneId,groupId:'a'},{source:'user'})).toMatchObject({ok:false,error:{path:'groupId'}});
  });
  it('protects referenced compositions and transitive locked instance dependencies', () => {
    const p=project([instance('i','c')]); p.compositions.c=composition('c',[instance('nested','d')]); p.compositions.d=composition('d');
    expect(applyCommand(p,{type:'removeComposition',compositionId:'d'},{source:'user'})).toMatchObject({ok:false,error:{code:'INVALID',path:'compositionId'}});
    p.scenes[0].locked=true; expect(applyCommand(p,{type:'updateComposition',compositionId:'d',changes:{name:'Changed'}},{source:'user'})).toMatchObject({ok:false,error:{code:'LOCKED'}});
    expect(applyCommand(p,{type:'removeComposition',compositionId:'d'},{source:'user'})).toMatchObject({ok:false,error:{code:'LOCKED'}});
    expect(applyCommand(p,{type:'addComposition',composition:composition('c')},{source:'user'})).toMatchObject({ok:false,error:{path:'composition.id'}});
    expect(applyCommand(p,{type:'updateComposition',compositionId:'missing',changes:{}},{source:'user'})).toMatchObject({ok:false,error:{code:'NOT_FOUND'}});
  });
  it('sorts and replaces markers and rejects missing marker removal', () => {
    let p=project(); for(const [id,frame] of [['late',40],['early',5],['late',10]] as const) p=apply(p,{type:'setMarker',marker:{id,frame,label:id}}).project;
    expect(p.markers.map(m=>[m.id,m.frame])).toEqual([['early',5],['late',10]]);
    expect(applyCommand(p,{type:'removeMarker',markerId:'missing'},{source:'user'})).toMatchObject({ok:false,error:{code:'NOT_FOUND',path:'markerId'}});
  });
  it('diff/history reports all new fields, compositions and markers', () => {
    const p=base(), next=apply(p,{type:'batch',label:'V2',commands:[
      {type:'setParent',sceneId,elementId:'a',parentId:'g'}, {type:'setParent',sceneId,elementId:'b',parentId:'g'},
      {type:'updateElement',sceneId,elementId:'a',changes:{blendMode:'screen',effects:{blur:5}}},
      {type:'updateElement',sceneId,elementId:'b',changes:{mask:{sourceId:'a',mode:'alpha'}}},
      {type:'setPropertyKeyframe',sceneId,elementId:'a',key:'props.cornerRadius',frame:0,value:30},
      {type:'updateComposition',compositionId:'c',changes:{elements:[element('ce')]}},
      {type:'setMarker',marker:{id:'m',frame:5,label:'Moved'}},
    ]}).project;
    const differences=diffProjects(p,next);
    for(const path of ['parentId','blendMode','effects','mask','propTracks.props.cornerRadius']) expect(differences.some(c=>c.path===path)).toBe(true);
    expect(differences.some(c=>c.kind==='composition')).toBe(true); expect(differences.some(c=>c.kind==='marker')).toBe(true);
    expect(touchedBetween(p,next)).toEqual(expect.arrayContaining([{kind:'project'},{kind:'composition',compositionId:'c'}]));
    const s=state(p,{type:'updateComposition',compositionId:'c',changes:{name:'Edit'}}); expect(undo(s).revisions.at(-1)!.touched).toEqual([{kind:'composition',compositionId:'c'}]);
  });
});

describe('format conversion', () => {
  const formatted = () => {
    const shape=element('a','shape',{startFrame:10,durationInFrames:90,tracks:[{property:'x',keyframes:[{frame:1,value:20,easing:'linear'},{frame:2,value:40,easing:'linear'}]},{property:'y',keyframes:[{frame:2,value:50,easing:'linear'}]}]});
    const text=element('b','text',{propTracks:[{key:'props.fontSize',keyframes:[{frame:10,value:100,easing:'linear'}]}]});
    const p=project([shape,text,element('path','path'),element('g','group'),element('child','shape',{parentId:'g'})]);
    p.compositions.c=composition('c',[element('ce')]); p.scenes[0].transitionIn={type:'zoom',durationInFrames:20};
    p.assets.audio={id:'audio',kind:'audio',name:'Audio',src:'assets/audio.wav',mimeType:'audio/wav',durationInFrames:100};
    p.audio=[{id:'clip',assetId:'audio',name:'Clip',sceneId:'s',startFrame:10,trimStartFrames:20,durationInFrames:50,volume:0.5,fadeInFrames:10,fadeOutFrames:20}];
    p.markers=[{id:'marker',frame:99,label:'End'}]; return p;
  };
  it('scale/keepSeconds converts geometry, keyed offsets, font, path nodes, audio, markers, transitions and compositions', () => {
    const p=formatted(); const next=apply(p,{type:'changeFormat',width:2000,height:900,fps:60,conversion:{layout:'scale',timing:'keepSeconds'}}).project;
    expect(next).toMatchObject({width:2000,height:900,fps:60}); expect(el(next).transform).toMatchObject({x:20,y:30,width:120,height:90}); expect(el(next).props.cornerRadius).toBe(24);
    expect(el(next).startFrame).toBe(20); expect(el(next).durationInFrames).toBe(180);
    expect(el(next).tracks[0].keyframes).toMatchObject([{frame:2,value:40},{frame:4,value:80}]); expect(el(next).tracks[1].keyframes[0]).toMatchObject({frame:4,value:75});
    expect(el(next,'b').props.fontSize).toBe(144); expect(el(next,'b').props.revealDurationInFrames).toBe(40); expect(el(next,'b').propTracks![0].keyframes[0]).toMatchObject({frame:20,value:150});
    expect(el(next,'path').props.nodes).toEqual([{x:0,y:450,out:{x:300,y:450}},{x:900,y:150,in:{x:600,y:150}}]);
    expect(next.audio[0]).toMatchObject({startFrame:20,trimStartFrames:40,durationInFrames:100,fadeInFrames:20,fadeOutFrames:40}); expect(next.assets.audio.durationInFrames).toBe(200);
    expect(next.markers[0].frame).toBe(198); expect(next.scenes[0].transitionIn.durationInFrames).toBe(40); expect(next.compositions.c).toMatchObject({width:900,height:600,durationInFrames:200});
    expect(validateProject(next).ok).toBe(true);
  });
  it('fit/keepFrames uses a uniform scale, centres scene roots, and keeps frame values', () => {
    const p=formatted(),next=apply(p,{type:'changeFormat',width:2000,height:600,fps:60,conversion:{layout:'fit',timing:'keepFrames'}}).project;
    expect(el(next).transform).toMatchObject({x:510,y:20,width:80,height:60}); expect(el(next,'child').transform).toMatchObject({x:10,y:20});
    expect(next.scenes[0].durationInFrames).toBe(100); expect(next.markers).toEqual(p.markers); expect(next.audio).toEqual(p.audio); expect(el(next).tracks).toEqual(el(p).tracks);
    expect(next.compositions.c.elements[0].transform).toMatchObject({x:10,y:20});
  });
  it('none keeps all pixel geometry and keepSeconds still retimes', () => {
    const p=formatted(),next=apply(p,{type:'changeFormat',width:500,height:500,fps:15,conversion:{layout:'none',timing:'keepSeconds'}}).project;
    expect(el(next).transform).toEqual(el(p).transform); expect(el(next,'path').props.nodes).toEqual(el(p,'path').props.nodes); expect(el(next,'b').props.fontSize).toBe(el(p,'b').props.fontSize);
    expect(next.scenes[0].durationInFrames).toBe(50); expect(next.audio[0].durationInFrames).toBe(25);
  });
  it('downsampling coalesces colliding keyframes and preserves positive lifetimes and final markers', () => {
    const p=formatted(),next=apply(p,{type:'changeFormat',width:1000,height:600,fps:1,conversion:{layout:'none',timing:'keepSeconds'}}).project;
    expect(el(next).tracks[0].keyframes).toMatchObject([{frame:0,value:40}]); expect(next.markers[0].frame).toBe(2); expect(next.scenes[0].durationInFrames).toBe(3); expect(validateProject(next).ok).toBe(true);
  });
  it('does not accept invalid format dimensions or fps', () => {
    const p=formatted(); for(const [key,value] of [['width',0],['height',1.5],['fps',121]] as const) expect(applyCommand(p,{type:'changeFormat',width:500,height:300,fps:30,[key]:value,conversion:{layout:'none',timing:'keepFrames'}},{source:'user'})).toMatchObject({ok:false,error:{path:key}});
  });
});

describe('v2 patch scope and composition reconciliation', () => {
  const patch=(p:Project,command:Command,elementId?:string):AiPatch=>({protocol:'mge.patch/1',projectId:p.id,baseRevision:p.revision,summary:'Edit',targets:[{sceneId:'s',...(elementId?{elementId}:{})}],commands:[command]});
  it.each(newCommands.filter(c=>['setPropertyKeyframe','removePropertyKeyframe','setParent'].includes(c.type)).map(c=>[c.type,c] as const))('%s accepts element/scene targets and rejects other element targets', (_,command) => {
    const p=base(); expect(checkPatch(createDocState(p),patch(p,command,'a')).ok).toBe(true); expect(checkPatch(createDocState(p),patch(p,command)).ok).toBe(true);
    expect(checkPatch(createDocState(p),patch(p,command,'b'))).toMatchObject({ok:false,error:{code:'OUT_OF_SCOPE',path:'commands[0]'}});
  });
  it.each(newCommands.filter(c=>['groupElements','ungroup'].includes(c.type)).map(c=>[c.type,c] as const))('%s requires a scene target', (_,command) => {
    const p=base(); expect(checkPatch(createDocState(p),patch(p,command)).ok).toBe(true); expect(checkPatch(createDocState(p),patch(p,command,'a'))).toMatchObject({ok:false,error:{code:'OUT_OF_SCOPE'}});
  });
  it.each(newCommands.filter(c=>['addComposition','updateComposition','removeComposition','setMarker','removeMarker','changeFormat'].includes(c.type)).map(c=>[c.type,c] as const))('%s remains excluded from AI patches', (_,command) => {
    const p=base(); expect(checkPatch(createDocState(p),patch(p,command))).toMatchObject({ok:false,error:{code:'OUT_OF_SCOPE'}});
  });
  it('reconcile detects referenced composition edits and rollback protects locked instances', () => {
    const p=project([instance('i','c')]); p.compositions.c=composition('c');
    const command:Command={type:'updateElement',sceneId:'s',elementId:'i',changes:{name:'Instance'}};
    const s=state(p,{type:'updateComposition',compositionId:'c',changes:{name:'Changed'}});
    expect(checkPatch(s,patch(p,command,'i'),{reconcile:true})).toMatchObject({ok:false,error:{code:'STALE'}});
    const locked=execute(s,{type:'setSceneLock',sceneId:'s',locked:true}); if(!locked.ok) throw new Error(locked.error.message);
    // The target keeps the lock, so this check isolates composition changes.
    const target={...p,scenes:locked.state.project.scenes}; locked.state.revisions[0]={...locked.state.revisions[0],snapshot:target};
    expect(restoreRevision(locked.state,1)).toMatchObject({ok:false,error:{code:'LOCKED'}});
  });
});

describe('v2 command edge cases',()=>{
  it('keeps groups and masks together when grouping both siblings',()=>{
    const p=project([element('a'),element('b','text',{mask:{sourceId:'a',mode:'alpha'}})]);
    const grouped=apply(p,{type:'groupElements',sceneId:'s',elementIds:['a','b'],group:{id:'g',name:'Masked'}}).project;
    expect(el(grouped,'b').mask).toEqual({sourceId:'a',mode:'alpha'});
    const ungrouped=apply(grouped,{type:'ungroup',sceneId:'s',groupId:'g'}).project;
    expect(ungrouped.scenes[0].elements).toEqual(p.scenes[0].elements);
  });
  it('scales nested positions and keyed offsets by their respective axis ratios',()=>{
    const child=element('child','shape',{parentId:'g',tracks:[{property:'x',keyframes:[{frame:0,value:10,easing:'linear'}]}]});
    const p=project([element('g','group'),child]);
    const next=apply(p,{type:'changeFormat',width:2000,height:900,fps:30,conversion:{layout:'scale',timing:'keepFrames'}}).project;
    expect(el(next,'child').transform).toMatchObject({x:20,y:30,width:120,height:90}); expect(el(next,'child').tracks[0].keyframes[0].value).toBe(20);
  });
  it('preserves lock protection when replacing an asset rendered through a nested composition',()=>{
    const p=project([instance('i','c')]); p.assets.logo={id:'logo',kind:'svg',name:'Logo',src:'assets/logo.svg',mimeType:'image/svg+xml'};
    p.compositions.c=composition('c',[instance('nested','d')]); p.compositions.d=composition('d',[element('logoElement','logo',{props:{assetId:'logo',fit:'contain'}})]); p.scenes[0].locked=true;
    expect(applyCommand(p,{type:'replaceAsset',assetId:'logo',changes:{src:'assets/replaced.svg'}},{source:'user'})).toMatchObject({ok:false,error:{code:'LOCKED'}});
  });
  it('supports every requested animatable registry field via validated property commands',()=>{
    const p=project([element('text','text'),element('shape','shape'),element('path','path'),element('card','uiCard'),element('chat','chatBubble'),element('image','image',{props:{assetId:'img',fit:'cover',cornerRadius:16,shadow:true}})]);
    p.assets.img={id:'img',kind:'image',name:'Image',src:'assets/image.png',mimeType:'image/png'};
    el(p,'shape').props.stroke='#fff';
    const cases:[string,string,number|string][]=[['text','fontSize',100],['text','letterSpacing',1],['text','color','#fff'],['shape','fill','#fff'],['shape','stroke','#fff'],['shape','strokeWidth',10],['shape','cornerRadius',20],['path','strokeWidth',20],['path','trimStart',0.1],['path','trimEnd',0.5],['path','trimOffset',0.2],['card','accentColor','#fff'],['card','background','#fff'],['card','textColor','#fff'],['chat','bubbleColor','#fff'],['chat','textColor','#fff'],['image','cornerRadius',20]];
    for(const [id,key,value] of cases) expect(applyCommand(p,{type:'setPropertyKeyframe',sceneId:'s',elementId:id,key:`props.${key}`,frame:0,value},{source:'user'}).ok,`${id}.${key}`).toBe(true);
  });
});

describe('v2 conversion and reconciliation precision',()=>{
  it('layout none preserves fractional base coordinates exactly',()=>{
    const p=project(); el(p).transform.x=10.25; el(p).transform.y=20.75;
    const next=apply(p,{type:'changeFormat',width:800,height:800,fps:30,conversion:{layout:'none',timing:'keepFrames'}}).project;
    expect(el(next).transform).toBe(el(p).transform);
  });
  it('unrelated composition edits do not conflict with a sibling element target',()=>{
    const p=project([element('a'),instance('i','c')]); p.compositions.c=composition('c');
    const s=state(p,{type:'updateComposition',compositionId:'c',changes:{name:'Changed'}});
    const patch:AiPatch={protocol:'mge.patch/1',projectId:p.id,baseRevision:p.revision,summary:'Rename',targets:[{sceneId:'s',elementId:'a'}],commands:[{type:'updateElement',sceneId:'s',elementId:'a',changes:{name:'Changed'}}]};
    expect(checkPatch(s,patch,{reconcile:true}).ok).toBe(true);
  });
});

describe('entrance animation reparenting',()=>{
  it('preserves a child whose scale animation starts at zero',()=>{
    const group=element('g','group',{transform:{x:100,y:100,width:200,height:100,rotation:90,scale:2,opacity:1}});
    const child=element('a','shape',{tracks:[{property:'scale',keyframes:[{frame:0,value:0,easing:'linear'},{frame:10,value:1,easing:'linear'}]}]});
    const p=project([group,child]), next=apply(p,{type:'setParent',sceneId:'s',elementId:'a',parentId:'g'}).project;
    const before=evaluateElementWorld(p.scenes[0].elements,child,0),after=evaluateElementWorld(next.scenes[0].elements,el(next),0);
    expect(after.scale).toBe(0); expect(after.x).toBeCloseTo(before.x); expect(after.y).toBeCloseTo(before.y);
    expect(el(next).transform.scale).toBe(0.5);
    expect(evaluateElementWorld(next.scenes[0].elements,el(next),10).scale).toBeCloseTo(1);
  });
  it('ungroup preserves static ancestor opacity even when a child fades in from zero',()=>{
    const group=element('g','group'); group.transform.opacity=0.5;
    const child=element('a','shape',{parentId:'g',tracks:[{property:'opacity',keyframes:[{frame:0,value:0,easing:'linear'},{frame:10,value:1,easing:'linear'}]}]});
    const p=project([group,child]), next=apply(p,{type:'ungroup',sceneId:'s',groupId:'g'}).project;
    expect(el(next).transform.opacity).toBe(0.5);
    for(const frame of [0,5,10]) expect(evaluateElementWorld(next.scenes[0].elements,el(next),frame).opacity).toBe(evaluateElementWorld(p.scenes[0].elements,child,frame).opacity);
  });
});

describe('format frame arithmetic',()=>{
  it('rounds starts and durations independently, retaining clipped children',()=>{
    const p=project([element('g','group'),element('a','shape',{parentId:'g',startFrame:1,durationInFrames:1})]);
    const next=apply(p,{type:'changeFormat',width:1000,height:600,fps:45,conversion:{layout:'none',timing:'keepSeconds'}}).project;
    expect(el(next)).toMatchObject({startFrame:2,durationInFrames:2});
  });
});

describe('setKeyframe with a custom curve', () => {
  it('accepts a cubic-bezier easing on transform tracks', async () => {
    const { CommandSchema } = await import('./schema');
    const { applyCommand } = await import('./commands');
    const { fixtureProject } = await import('./__fixtures__/fixtureProject');
    const p = structuredClone(fixtureProject);
    const scene = p.scenes[0];
    const el = scene.elements[0];
    const easing = { type: 'cubicBezier' as const, x1: 0.3, y1: 1.9, x2: 0.5, y2: 0.8 };
    const cmd = { type: 'setKeyframe' as const, sceneId: scene.id, elementId: el.id, property: 'x' as const, frame: 0, value: 10, easing };
    expect(CommandSchema.safeParse(cmd).success).toBe(true);
    const r = applyCommand(p, cmd, { source: 'user' });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.project.scenes[0].elements[0].tracks.find((t) => t.property === 'x')?.keyframes[0].easing).toEqual(easing);
  });
});
