// Preview sources for video files: the ready-proxy cache (outside the
// document) for the preview, the original for rendering; and looped video
// volume that follows element time.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { COMPONENTS } from '../core/components';
import type { Asset, Element, Project } from '../core/types';
import type { MediaComponents } from '../runtime';
import { Readiness } from '../runtime/readiness';
import { RuntimeRoot } from '../runtime/RuntimeRoot';

const env = { isRendering: false };
const videoCalls: Record<string, unknown>[] = [];
const audioCalls: Record<string, unknown>[] = [];

// The host's media slots record what the composition asks them to play.
const media: MediaComponents = {
  Video: (p) => (videoCalls.push(p as unknown as Record<string, unknown>), null),
  Audio: (p) => (audioCalls.push(p as unknown as Record<string, unknown>), null),
};
const hosted = (node: React.ReactElement) =>
  renderToStaticMarkup(
    React.createElement(RuntimeRoot, {
      frame: 0,
      config: { width: 1920, height: 1080, fps: 30, durationInFrames: 900 },
      environment: { isRendering: env.isRendering, isPlayer: !env.isRendering },
      delay: new Readiness(),
      media,
      children: node,
    }),
  );

const { VideoElement, videoVolumeAt } = await import('./elements/VideoElement');
const { AudioTrack } = await import('./AudioTrack');
const { clearPreviewProxies, setPreviewProxy, videoPreviewSrc } = await import('./previewProxies');

const asset: Asset = { id: 'ast_v', kind: 'video', name: 'clip.mp4', src: 'assets/uploads/u_v.mp4', mimeType: 'video/mp4', durationInFrames: 30 };
const element = (props: Record<string, unknown> = {}, extra: Partial<Element> = {}): Element => ({
  id: 'el_v', type: 'video', name: 'Clip', startFrame: 0, durationInFrames: 90, visible: true,
  transform: { x: 0, y: 0, width: 640, height: 360, rotation: 0, scale: 1, opacity: 1 },
  props: { ...COMPONENTS.video.defaultProps, assetId: 'ast_v', ...props }, tracks: [], ...extra,
} as Element);

const renderVideo = (a: Asset = asset, el = element()) => {
  videoCalls.length = 0;
  hosted(React.createElement(VideoElement, { element: el, localFrame: 0, width: 640, height: 360, assets: { [a.id]: a }, assetBaseUrl: '/', fps: 30 }));
  return videoCalls[0];
};

afterEach(() => {
  clearPreviewProxies();
  env.isRendering = false;
});

describe('video sources', () => {
  it('the preview plays a ready proxy from the cache; rendering always plays the original', () => {
    expect(renderVideo().src).toBe('/assets/uploads/u_v.mp4');
    setPreviewProxy('assets/uploads/u_v.mp4', 'assets/uploads/u_v.proxy.mp4');
    expect(renderVideo().src).toBe('/assets/uploads/u_v.proxy.mp4');
    env.isRendering = true;
    expect(renderVideo().src).toBe('/assets/uploads/u_v.mp4');
  });

  it('a proxySrc stored by an older document is still read (preview only); a self-pointing one is ignored', () => {
    expect(videoPreviewSrc({ src: 'a.mp4', proxySrc: 'a.proxy.mp4' }, false)).toBe('a.proxy.mp4');
    expect(videoPreviewSrc({ src: 'a.mp4', proxySrc: 'a.mp4' }, false)).toBe('a.mp4');
    expect(videoPreviewSrc({ src: 'a.mp4', proxySrc: 'a.proxy.mp4' }, true)).toBe('a.mp4');
    setPreviewProxy('a.mp4', 'a.proxy-new.mp4');
    expect(videoPreviewSrc({ src: 'a.mp4', proxySrc: 'a.proxy.mp4' }, false)).toBe('a.proxy-new.mp4');
    setPreviewProxy('a.mp4', null);
    expect(videoPreviewSrc({ src: 'a.mp4' }, false)).toBe('a.mp4');
  });

  it('detached video audio follows the same rule', () => {
    const project = { assets: { ast_v: asset }, audio: [{ id: 'aud_1', assetId: 'ast_v', name: 'Clip audio', startFrame: 0, durationInFrames: 30, trimStartFrames: 0, volume: 1, fadeInFrames: 0, fadeOutFrames: 0 }], scenes: [] } as unknown as Project;
    const audioSrc = () => {
      audioCalls.length = 0;
      hosted(React.createElement(AudioTrack, { project, assetBaseUrl: '/' }));
      return audioCalls[0]?.src;
    };
    setPreviewProxy('assets/uploads/u_v.mp4', 'assets/uploads/u_v.proxy.mp4');
    expect(audioSrc()).toBe('/assets/uploads/u_v.proxy.mp4');
    env.isRendering = true;
    expect(audioSrc()).toBe('/assets/uploads/u_v.mp4');
  });
});

// i7 #5: the volume callback runs in element time, not the source's.
describe('looped video volume', () => {
  it('follows the element’s lifetime (extend), whatever the source length', () => {
    const ramp = element({ loop: true }, { propTracks: [{ key: 'props.volume', keyframes: [{ frame: 0, value: 0, easing: 'linear' }, { frame: 90, value: 1, easing: 'linear' }] }] } as Partial<Element>);
    const props = renderVideo(asset, ramp);
    expect(props.loop).toBe(true);
    // Element frame 75 of a 1 s source looping through 3 s: 75/90, not the wrapped frame 15's 15/90.
    const volume = props.volume as (f: number) => number;
    expect(volume(75)).toBeCloseTo(75 / 90, 5);
    expect(videoVolumeAt(ramp, 75)).toBeCloseTo(0.833, 3);
  });
});
