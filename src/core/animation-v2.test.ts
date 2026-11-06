import { describe, expect, it } from 'vitest';
import { element } from './__fixtures__/schema2Project';
import { easingFn, EASINGS, evaluateElement, evaluateElementWorld, evaluateKeyframes, evaluatePropertyTrack, invertMatrix, multiplyMatrices, resolvedEffects, resolvedProps, worldCorners } from './animation';
import { parseColor } from './color';
import type { EasingSpec, PropertyKeyframe } from './types';

const keys = (a: number|string|boolean, b: number|string|boolean, easing: EasingSpec = 'linear'): PropertyKeyframe[] => [{ frame: 0, value: a, easing }, { frame: 10, value: b, easing: 'linear' }];

describe('v2 easing and property evaluation', () => {
  it.each(Object.keys(EASINGS))('preset %s hits endpoints', name => {
    const fn = easingFn(name as keyof typeof EASINGS); expect(fn(0)).toBe(0); expect(fn(1)).toBe(1);
  });
  it('memoises custom CSS curves and solves x rather than using parameter t', () => {
    const curve = { type: 'cubicBezier' as const, x1: 0.42, y1: 0, x2: 1, y2: 1 };
    const fn = easingFn(curve);
    expect(fn).toBe(easingFn({ ...curve })); expect(fn(0.5)).toBeCloseTo(0.315357, 5);
    expect(fn(0)).toBe(0); expect(fn(1)).toBe(1);
    expect(easingFn({ type: 'cubicBezier', x1: 0.25, y1: 2, x2: 0.75, y2: 2 })(0.5)).toBeGreaterThan(1);
    expect(evaluateKeyframes(keys(0,10,curve) as {frame:number; value:number; easing:EasingSpec}[],5,0)).toBeCloseTo(3.15357,4);
  });
  it('hold steps at the exact keyframe including an interior key', () => {
    const frames = [...keys(1,5,'hold'), {frame:20,value:9,easing:'linear' as const}];
    expect(evaluateKeyframes(frames as {frame:number;value:number;easing:EasingSpec}[],9.99,0)).toBe(1);
    expect(evaluateKeyframes(frames as {frame:number;value:number;easing:EasingSpec}[],10,0)).toBe(5);
    expect(EASINGS.hold(0.999)).toBe(0);
  });
  it('resolves numerical properties/effects independently of transform tracks', () => {
    const el = element('t','text',{ propTracks: [{key:'props.fontSize',keyframes:keys(20,100)}, {key:'effects.blur',keyframes:keys(0,20)}], effects: {brightness:1.5}, tracks: [{property:'x',keyframes:[{frame:0,value:40,easing:'linear'}]}] });
    expect(resolvedProps(el,5).fontSize).toBe(60); expect(resolvedEffects(el,5)).toEqual({brightness:1.5,blur:10});
    expect(evaluatePropertyTrack(el,'effects.contrast',0)).toBe(1); expect(evaluatePropertyTrack(el,'effects.blur',-5)).toBe(0);
    expect(resolvedProps(el,100).fontSize).toBe(100); expect(el.props.fontSize).toBe(96);
    expect(evaluateElement(el,5).x).toBe(50);
  });
  it('interpolates colour in linear sRGB with alpha and all requested input syntaxes', () => {
    for (const [a,b] of [['#000','#fff'],['#000000','#FFFFFF'],['rgb(0, 0, 0)','rgba(255,255,255,1)']]) {
      const el = element('t','text',{propTracks:[{key:'props.color',keyframes:keys(a,b)}]});
      expect(resolvedProps(el,5).color).toBe('rgba(188, 188, 188, 1)');
    }
    const el = element('t','text',{propTracks:[{key:'props.color',keyframes:keys('#00000000','#ffffff80')}]});
    expect(resolvedProps(el,5).color).toBe('rgba(188, 188, 188, 0.25098)');
    expect(parseColor('rgba(1,2,3,2)')).toBeNull(); expect(parseColor('rgb(300,0,0)')).toBeNull();
  });
  it('holds boolean and select values until the next keyframe', () => {
    const el = element('t','text',{propTracks:[{key:'props.reveal',keyframes:keys('none','blurIn')},{key:'props.fontWeight',keyframes:keys(400,700)},{key:'props.testBoolean',keyframes:keys(false,true)}]});
    expect(resolvedProps(el,5)).toMatchObject({reveal:'none',fontWeight:400,testBoolean:false});
    expect(resolvedProps(el,10)).toMatchObject({reveal:'blurIn',fontWeight:700,testBoolean:true});
  });
});

describe('world geometry', () => {
  it('matches parentless evaluateElement exactly', () => {
    const el = element('a');
    for (const frame of [-1,0,50,100]) { const {worldMatrix, parentChainActive,...world} = evaluateElementWorld([el],el,frame); expect(world).toEqual(evaluateElement(el,frame)); expect(parentChainActive).toBe(true); expect(worldMatrix).toEqual([1,0,-0,1,10,20]); }
  });
  it('composes nested rotation, scale, opacity and parent-relative timing', () => {
    const root = element('root','group',{startFrame:10,durationInFrames:50,transform:{x:100,y:100,width:100,height:100,rotation:90,scale:2,opacity:0.5}});
    const group = element('g','group',{parentId:'root',startFrame:5,transform:{x:0,y:0,width:50,height:50,rotation:-90,scale:0.5,opacity:0.5}});
    const child = element('c','shape',{parentId:'g',startFrame:3,transform:{x:10,y:20,width:20,height:10,rotation:0,scale:1,opacity:0.8}});
    const elements = [root,group,child];
    const world = evaluateElementWorld(elements,child,18);
    expect(world).toMatchObject({localFrame:0,active:true,parentChainActive:true,rotation:0,scale:1,opacity:0.2});
    const corners = worldCorners(elements,child,18);
    expect(corners[0].x).toBeCloseTo(185); expect(corners[0].y).toBeCloseTo(95);
    expect(corners[2].x-corners[0].x).toBeCloseTo(20); expect(corners[2].y-corners[0].y).toBeCloseTo(10);
    expect(evaluateElementWorld(elements,child,17).active).toBe(false);
    expect(evaluateElementWorld(elements,child,60)).toMatchObject({active:false,parentChainActive:false});
    root.visible=false; expect(evaluateElementWorld(elements,child,20).active).toBe(false);
  });
  it('uses each parent local frame when evaluating animated parents', () => {
    const root = element('g','group',{startFrame:10,tracks:[{property:'x',keyframes:[{frame:0,value:0,easing:'linear'},{frame:10,value:100,easing:'linear'}]}]});
    const child = element('c','shape',{parentId:'g',startFrame:5});
    expect(evaluateElementWorld([root,child],child,20)).toMatchObject({x:120,y:40,localFrame:5});
  });
  it('fails clearly on invalid parent chains and singular inverses', () => {
    const el=element('a','group',{parentId:'a'}); expect(()=>evaluateElementWorld([el],el,0)).toThrow('cycle');
    el.parentId='missing'; expect(()=>evaluateElementWorld([el],el,0)).toThrow('Missing parent');
    expect(()=>invertMatrix([0,0,0,0,1,1])).toThrow('zero-scale');
    const m: [number,number,number,number,number,number]=[0,2,-2,0,20,30];
    const identity=multiplyMatrices(m,invertMatrix(m)); identity.forEach((v,i)=>expect(v).toBeCloseTo([1,0,0,1,0,0][i]));
  });
});
