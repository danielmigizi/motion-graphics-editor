// The runtime's time containers, readiness registry and media timing.

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { useFrame } from './context';
import { frameIndexAt, videoSourceSeconds } from './hostContext';
import { NATIVE_MEDIA } from './media';
import { Readiness } from './readiness';
import { RuntimeRoot } from './RuntimeRoot';
import { HoldFrame, TimeSpan } from './TimeSpan';

const Frame: React.FC<{ id: string }> = ({ id }) => React.createElement('i', { 'data-id': id }, useFrame());
const at = (frame: number, node: React.ReactNode) =>
  renderToStaticMarkup(
    React.createElement(RuntimeRoot, {
      frame,
      config: { width: 100, height: 100, fps: 30, durationInFrames: 300 },
      environment: { isRendering: true, isPlayer: false },
      delay: new Readiness(),
      media: NATIVE_MEDIA,
      children: node,
    }),
  );

describe('TimeSpan and HoldFrame', () => {
  const tree = React.createElement(
    React.Fragment,
    null,
    React.createElement(Frame, { id: 'root' }),
    React.createElement(TimeSpan, { from: 10, durationInFrames: 20, layout: 'none' }, React.createElement(Frame, { id: 'a' }), React.createElement(TimeSpan, { from: 5, layout: 'none' }, React.createElement(Frame, { id: 'b' }))),
  );

  it('re-bases nested frames and mounts children only inside [from, from + duration)', () => {
    expect(at(9, tree)).toBe('<i data-id="root">9</i>');
    expect(at(12, tree)).toBe('<i data-id="root">12</i><i data-id="a">2</i>');
    expect(at(16, tree)).toBe('<i data-id="root">16</i><i data-id="a">6</i><i data-id="b">1</i>');
    expect(at(30, tree)).toBe('<i data-id="root">30</i>');
  });

  it('HoldFrame pins the frame its subtree sees, nested Sequences included', () => {
    expect(at(0, React.createElement(HoldFrame, { frame: 16 }, tree))).toBe('<i data-id="root">16</i><i data-id="a">6</i><i data-id="b">1</i>');
    expect(at(50, React.createElement(TimeSpan, { from: 40, layout: 'none' }, React.createElement(HoldFrame, { frame: 3 }, React.createElement(Frame, { id: 'f' }))))).toBe('<i data-id="f">3</i>');
  });

  it('the default layout wraps children in an absolute fill', () => {
    expect(at(0, React.createElement(TimeSpan, null, 'x'))).toContain('position:absolute');
  });
});

describe('Readiness', () => {
  it('settles once every handle is continued, and rejects on cancel', async () => {
    const r = new Readiness();
    const a = r.delayRender('a');
    const b = r.delayRender('b');
    let settled = false;
    const p = r.settled(1000).then(() => (settled = true));
    r.continueRender(a);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(r.labels()).toEqual(['b']);
    r.continueRender(b);
    await p;
    expect(settled).toBe(true);
    const c = new Readiness();
    c.delayRender('font');
    const failed = c.settled(1000);
    c.cancelRender(new Error('font missing'));
    await expect(failed).rejects.toThrow('font missing');
  });

  it('times out naming what it waited for', async () => {
    const r = new Readiness();
    r.delayRender('Loading image x.png');
    await expect(r.settled(10)).rejects.toThrow(/x\.png/);
  });
});

describe('video timing', () => {
  it('picks the last frame starting at or before the requested time', () => {
    const pts = [0, 1 / 30, 2 / 30, 3 / 30];
    expect(frameIndexAt(pts, 0)).toBe(0);
    expect(frameIndexAt(pts, 1 / 30)).toBe(1);
    expect(frameIndexAt(pts, 1.5 / 30)).toBe(1);
    expect(frameIndexAt(pts, 10)).toBe(3);
    expect(frameIndexAt(pts, -1)).toBe(0);
    expect(frameIndexAt([], 0)).toBe(-1);
  });

  it('maps a local frame through trim, rate and loop like src/core/video.ts', () => {
    expect(videoSourceSeconds({ frame: 30, fps: 30, trimBefore: 15, playbackRate: 2, loop: false })).toBeCloseTo(75 / 30);
    // 1 s source, trimmed by 10 frames, looping: frame 25 → 10 + (25 % 20) = 15.
    expect(videoSourceSeconds({ frame: 25, fps: 30, trimBefore: 10, playbackRate: 1, loop: true, sourceDurationInFrames: 30 })).toBeCloseTo(15 / 30);
  });
});
