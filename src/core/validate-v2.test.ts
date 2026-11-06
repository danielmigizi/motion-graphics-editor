import { describe, expect, it } from 'vitest';
import { composition, element, project } from './__fixtures__/schema2Project';
import { COMPONENTS, FONT_FAMILIES } from './components';
import { CommandSchema, PaintSchema, PathNodeSchema } from './schema';
import { validateProject } from './validate';
import type { Element, Project } from './types';

function invalid(p: Project, path: string) { expect(validateProject(p)).toMatchObject({ok:false,error:{code:'INVALID',path}}); }
const gradient = () => ({ type:'linear', angle:45, stops:[{offset:0,color:'#000'},{offset:1,color:'rgba(255,255,255,0.5)'}] });
const keyed = (value: number|string|boolean) => [{frame:0,value,easing:'linear' as const},{frame:10,value,easing:'hold' as const}];

describe('v2 registry and shape validation', () => {
  it('accepts defaults for paths, groups and instances', () => {
    const p = project([element('path','path'),element('group','group'),element('instance','instance',{props:{compositionId:'comp',timeOffset:0,loop:false}})]);
    p.compositions.comp=composition('comp'); expect(validateProject(p).ok).toBe(true); expect(FONT_FAMILIES).toContain('Fraunces');
  });
  it('preserves optional reveal fields on older documents', () => {
    const el=element('t','text'); for (const key of ['revealStagger','revealOrder','revealEasing']) delete el.props[key];
    expect(validateProject(project([el])).ok).toBe(true);
    expect(COMPONENTS.text.defaultProps).toMatchObject({revealStagger:2,revealOrder:'forward',revealEasing:'easeOut'});
  });
  it.each(['charStagger','lineStagger','charFadeUp','scaleIn','blurIn'])('accepts reveal %s', reveal => {
    const el=element('t','text'); el.props.reveal=reveal; expect(validateProject(project([el])).ok).toBe(true);
  });
  it('keeps paint/node/command objects strict', () => {
    expect(PaintSchema.safeParse({...gradient(),junk:1}).success).toBe(false);
    expect(PathNodeSchema.safeParse({x:1,y:2,in:{x:1,y:2,junk:true}}).success).toBe(false);
    expect(CommandSchema.safeParse({type:'setParent',sceneId:'s',elementId:'a',parentId:null,unknown:true}).success).toBe(false);
    expect(CommandSchema.safeParse({type:'changeFormat',width:100,height:100,fps:30,conversion:{layout:'scale',timing:'keepFrames',extra:true}}).success).toBe(false);
  });
  it('checks gradient stops and node shapes with paths', () => {
    const p=project([element('path','path')]); p.scenes[0].elements[0].props.fill=gradient(); expect(validateProject(p).ok).toBe(true);
    (p.scenes[0].elements[0].props.fill as ReturnType<typeof gradient>).stops[1].offset=2; invalid(p,'scenes[0].elements[0].props.fill.stops[1].offset');
    p.scenes[0].elements[0].props.fill='none'; p.scenes[0].elements[0].props.nodes=[{x:1,y:0},{x:'bad',y:0}]; invalid(p,'scenes[0].elements[0].props.nodes[1].x');
  });
});

describe('v2 semantic rules', () => {
  it.each(['missing','a'])('rejects non-group parent %s', parentId => { const p=project(); p.scenes[0].elements[1].parentId=parentId; invalid(p,'scenes[0].elements[1].parentId'); });
  it('rejects cycles and cross-tree parents while allowing clipped child timing', () => {
    const group=element('g','group',{durationInFrames:10}), child=element('a','shape',{parentId:'g',startFrame:90,durationInFrames:300});
    const p=project([group,child]); expect(validateProject(p).ok).toBe(true);
    group.parentId='nested'; const nested=element('nested','group',{parentId:'g'}); p.scenes[0].elements.push(nested); invalid(p,'scenes[0].elements[0].parentId');
    delete group.parentId; p.scenes[0].elements.pop(); p.compositions.other=composition('other',[element('gc','group')]); child.parentId='gc'; invalid(p,'scenes[0].elements[1].parentId');
  });
  it.each(['missing','self','type','parent','masked'])('rejects invalid mask source: %s', reason => {
    const source=element('mask'), target=element('target'); target.mask={sourceId:'mask',mode:'alpha'};
    const p=project([source,target,element('g','group')]);
    if(reason==='missing') target.mask.sourceId='missing'; if(reason==='self') target.mask.sourceId='target'; if(reason==='type') { source.type='text'; source.props=structuredClone(COMPONENTS.text.defaultProps); } if(reason==='parent') target.parentId='g'; if(reason==='masked') source.mask={sourceId:'target',mode:'alpha'};
    invalid(p, reason==='masked' ? 'scenes[0].elements[0].mask.sourceId' : 'scenes[0].elements[1].mask.sourceId');
  });
  it('accepts a sibling path mask and blend mode; rejects unknown blends', () => {
    const p=project([element('mask','path'),element('target','shape',{blendMode:'multiply',mask:{sourceId:'mask',mode:'inverted'}})]);
    expect(validateProject(p).ok).toBe(true); (p.scenes[0].elements[1] as unknown as {blendMode:string}).blendMode='unsupported'; invalid(p,'scenes[0].elements[1].blendMode');
  });
  it.each([['blur',201],['blur',-1],['brightness',3.1],['contrast',-1],['saturate',4]])('rejects effects.%s=%s', (key,value) => {
    const p=project(); p.scenes[0].elements[0].effects={[key]:value}; invalid(p,`scenes[0].elements[0].effects.${key}`);
  });
  it('checks shadow ranges and colours', () => {
    const p=project(); p.scenes[0].elements[0].effects={dropShadow:{x:-20,y:30,blur:200,color:'#fff'}}; expect(validateProject(p).ok).toBe(true);
    p.scenes[0].elements[0].effects!.dropShadow!.color='bad'; invalid(p,'scenes[0].elements[0].effects.dropShadow.color');
    p.scenes[0].elements[0].effects!.dropShadow!.color='#fff'; p.scenes[0].elements[0].effects!.dropShadow!.blur=201; invalid(p,'scenes[0].elements[0].effects.dropShadow.blur');
  });
  it.each([['props.fontSize',500],['props.fontSize',20.5],['props.color','wrong'],['props.reveal',true],['effects.blur',201],['effects.brightness',4],['effects.dropShadow',3],['transform.x',3],['props.fontSize.extra',3]])('rejects property key/value %s=%s', (key,value) => {
    const p=project([element('t','text',{propTracks:[{key,keyframes:keyed(value)}]})]);
    const fieldError=['props.fontSize','props.color','effects.blur','effects.brightness'].includes(key);
    invalid(p,`scenes[0].elements[0].propTracks[0].${fieldError ? 'keyframes[0].value':'key'}`);
  });
  it('rejects gradient and none colour tracks but accepts plain paint', () => {
    const el=element('a','shape',{propTracks:[{key:'props.fill',keyframes:keyed('#fff')}]}); const p=project([el]); expect(validateProject(p).ok).toBe(true);
    el.props.fill=gradient(); invalid(p,'scenes[0].elements[0].propTracks[0].key');
    el.props.fill='none'; invalid(p,'scenes[0].elements[0].propTracks[0].key');
  });
  it.each(['duplicateKey','duplicateFrame','unsorted','fractional','negative'])('rejects property track ordering: %s', reason => {
    const el=element('t','text',{propTracks:[{key:'props.fontSize',keyframes:keyed(20)}]}); const p=project([el]); const track=el.propTracks![0];
    if(reason==='duplicateKey') el.propTracks!.push({...track}); if(reason==='duplicateFrame') track.keyframes[1].frame=0;
    if(reason==='unsorted') track.keyframes.reverse(); if(reason==='fractional') track.keyframes[1].frame=1.5; if(reason==='negative') track.keyframes[1].frame=-1;
    invalid(p,`scenes[0].elements[0].propTracks[${reason==='duplicateKey'?1:0}].${reason==='duplicateKey'?'key':'keyframes[1].frame'}`);
  });
  it.each([['x1',-0.1],['x2',1.1],['y1',-2.1],['y2',3.1]])('checks bezier control %s', (key,value) => {
    const easing={type:'cubicBezier' as const,x1:0,y1:-2,x2:1,y2:3,[key]:value}; const el=element('a');
    el.type='shape'; el.props=structuredClone(COMPONENTS.shape.defaultProps); el.tracks=[{property:'x',keyframes:[{frame:0,value:0,easing}]}]; const p=project([el]); invalid(p,`scenes[0].elements[0].tracks[0].keyframes[0].easing.${key}`);
    el.tracks=[]; el.propTracks=[{key:'effects.blur',keyframes:[{frame:0,value:0,easing}]}]; invalid(p,`scenes[0].elements[0].propTracks[0].keyframes[0].easing.${key}`);
  });
  it('shares one ID space across scene and composition elements', () => {
    const p=project(); p.compositions.c=composition('c',[element('a')]); invalid(p,'compositions.c.elements[0].id');
  });
  it.each(['width','height','durationInFrames'])('checks composition %s', key => { const p=project(); p.compositions.c={...composition('c'),[key]:1.5}; invalid(p,`compositions.c.${key}`); });
  it('checks composition references, keys and cycles', () => {
    const p=project([element('i','instance',{props:{compositionId:'missing',timeOffset:0,loop:false}})]); invalid(p,'scenes[0].elements[0].props.compositionId');
    p.scenes[0].elements=[]; p.compositions.c=composition('different'); invalid(p,'compositions.c.id');
    p.compositions={c:composition('c',[element('i','instance',{props:{compositionId:'d',timeOffset:0,loop:false}})]),d:composition('d',[element('j','instance',{props:{compositionId:'c',timeOffset:0,loop:false}})])}; invalid(p,'compositions.d.elements[0].props.compositionId');
  });
  it.each(['range','fractional','duplicate','sorted','color'])('checks markers: %s', reason => {
    const p=project(); p.markers=[{id:'m',frame:5,label:'Beat'},{id:'n',frame:10,label:'Note'}];
    if(reason==='range') p.markers[1].frame=100; if(reason==='fractional') p.markers[1].frame=2.5; if(reason==='duplicate') p.markers[1].id='m'; if(reason==='sorted') p.markers[1].frame=1; if(reason==='color') p.markers[1].color='bad';
    invalid(p,`markers[1].${reason==='duplicate'?'id':reason==='color'?'color':'frame'}`);
  });
});

describe('nested shape error paths',()=>{
  it('points to a malformed custom control point and paint stop colour',()=>{
    const p=project();
    (p.scenes[0].elements[0] as unknown as {tracks:unknown[]}).tracks=[{property:'x',keyframes:[{frame:0,value:0,easing:{type:'cubicBezier',x1:'bad',y1:0,x2:1,y2:1}}]}];
    invalid(p,'scenes[0].elements[0].tracks[0].keyframes[0].easing.x1');
    p.scenes[0].elements[0].tracks=[]; p.scenes[0].elements[0].props.fill={type:'linear',angle:90,stops:[{offset:0,color:42},{offset:1,color:'#fff'}]};
    invalid(p,'scenes[0].elements[0].props.fill.stops[0].color');
  });
});
