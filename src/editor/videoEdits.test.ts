import { describe, expect, it } from 'vitest';
import { element, project as baseProject } from '../core/__fixtures__/schema2Project';
import { applyCommand } from '../core/commands';
import { COMPONENTS } from '../core/components';
import type { Asset, Element } from '../core/types';
import { previewCommand } from './simpleTimelineEdits';
import { hasRealProxy, videoSpanChanges, inPointChanges, insertVideoCommands, loopChanges, outPointChanges, replacementChanges, sourceRange, speedChanges, videoElementFor } from './videoEdits';
import { previewState } from './videoProxies';

const rec: Asset = { id: 'ast_rec', kind: 'video', name: 'Screen Recording.mov', src: 'assets/uploads/u_r.mov', mimeType: 'video/quicktime', width: 2880, height: 1800, durationInFrames: 900, fps: 60, hasAudio: true };
const setup = (props: Record<string, unknown> = {}, over: Partial<Element> = {}) => {
  const p = baseProject([]);
  p.scenes[0].durationInFrames = 600;
  p.assets.ast_rec = rec;
  const el = element('v', 'video', { durationInFrames: 300, props: { ...COMPONENTS.video.defaultProps, assetId: 'ast_rec', ...props }, ...over });
  p.scenes[0].elements.push(el);
  return { p, scene: p.scenes[0], el };
};

describe('video editor helpers', () => {
  it('a new video is half the frame wide with its aspect, centred, as long as scene and file allow', () => {
    const p = baseProject([]);
    p.scenes[0].durationInFrames = 2000;
    const el = videoElementFor(p, p.scenes[0], rec, 10);
    expect(el).toMatchObject({ type: 'video', name: 'Screen Recording', startFrame: 10, durationInFrames: 900, transform: { width: 500, height: 313, x: 250, y: 144 } });
    expect(el.props).toMatchObject({ assetId: 'ast_rec', trimStartFrames: 0, playbackRate: 1 });
    expect(videoElementFor(p, { ...p.scenes[0], durationInFrames: 100 }, rec, 40).durationInFrames).toBe(60);
  });

  it('insert is one batch that validates', () => {
    const p = baseProject([]);
    const { command } = insertVideoCommands(p, p.scenes[0], rec, 0);
    const r = applyCommand(p, command, { source: 'user' });
    expect(r.ok).toBe(true);
  });

  it('in/out trims keep the start; the in-point keeps the out-point', () => {
    const { p, scene, el } = setup({ trimStartFrames: 100, playbackRate: 2 }, { durationInFrames: 200 });
    expect(sourceRange(el, p.assets)).toMatchObject({ in: 100, out: 500, length: 900, rate: 2 });
    expect(inPointChanges(scene, el, p.assets, 300)).toEqual({ durationInFrames: 100, props: { trimStartFrames: 300 } });
    expect(outPointChanges(scene, el, p.assets, 900)).toEqual({ durationInFrames: 400 });
    // Scene room: the element starts at 0 in a 600-frame scene.
    expect(outPointChanges(scene, el, p.assets, 5000)).toEqual({ durationInFrames: 400 });
    expect(inPointChanges(scene, el, p.assets, 100)).toBeNull();
  });

  it('timeline drags of a video bar trim its source (both timelines)', () => {
    const { p, el } = setup({ trimStartFrames: 100, playbackRate: 2 }, { startFrame: 20, durationInFrames: 200 });
    expect(videoSpanChanges(p, el, { start: 30, dur: 190 }, 'start')).toEqual({ startFrame: 30, durationInFrames: 190, props: { trimStartFrames: 120 } });
    expect(videoSpanChanges(p, el, { start: 20, dur: 900 }, 'end')).toEqual({ durationInFrames: 400 });
    const c = previewCommand(p, { kind: 'element', sceneId: 's', elementId: 'v', mode: 'start', start: 30, dur: 190 });
    expect(c?.command).toEqual({ type: 'updateElement', sceneId: 's', elementId: 'v', changes: { startFrame: 30, durationInFrames: 190, props: { trimStartFrames: 120 } } });
  });

  it('speed and loop keep the element inside its source', () => {
    const { p, el } = setup({ trimStartFrames: 600 });
    expect(speedChanges(el, p.assets, 2)).toEqual({ durationInFrames: 150, props: { playbackRate: 2 } });
    expect(loopChanges({ ...el, durationInFrames: 500, props: { ...el.props, loop: true } }, p.assets, false)).toEqual({ props: { loop: false }, durationInFrames: 300 });
  });

  it('replacing a video file drops its old proxy; preview state reads the proxy status', () => {
    const withProxy = { ...rec, proxySrc: 'assets/uploads/u_r.proxy.mp4' };
    const { name: _n, ...file } = { ...rec, name: 'new.mp4', src: 'assets/uploads/u_new.mp4' };
    expect(replacementChanges(withProxy, { ...file, name: 'new.mp4' })).toMatchObject({ src: 'assets/uploads/u_new.mp4', proxySrc: 'assets/uploads/u_new.mp4' });
    expect(replacementChanges(rec, { ...file, name: 'new.mp4' })).not.toHaveProperty('proxySrc');
    expect(hasRealProxy(withProxy)).toBe(true);
    expect(hasRealProxy({ ...rec, proxySrc: rec.src })).toBe(false);
    expect(previewState(withProxy, undefined).kind).toBe('proxy');
    expect(previewState(rec, { status: 'pending', reasons: ['larger than 1080p'] })).toEqual({ kind: 'preparing', text: 'Preparing preview… (larger than 1080p)' });
    expect(previewState(rec, { status: 'failed', error: 'boom', reasons: [] }).kind).toBe('failed');
    expect(previewState(rec, { status: 'none', reasons: [] }).kind).toBe('original');
  });
});
