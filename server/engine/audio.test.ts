import { describe, expect, it } from 'vitest';
import type { FrameMedia } from '../../src/render/protocol';
import { videoSegments } from './audio';

const at = (entries: [number, FrameMedia['videos']][]) => new Map(entries.map(([f, videos]) => [f, { videos }]));
const v = (key: string, time: number, volume = 1, playbackRate = 1) => ({ key, src: 'a.mp4', time, playbackRate, volume });

describe('videoSegments', () => {
  it('joins consecutive frames that advance the source by playbackRate / fps', () => {
    const segs = videoSegments(at([[10, [v('k', 1)]], [11, [v('k', 1 + 2 / 30, 0.5, 2)]], [12, [v('k', 1 + 4 / 30, 0.5, 2)]]]), 30);
    // Frame 10 plays at 1×, so the 2× run starts a new segment at frame 11.
    expect(segs.map((s) => [s.from, s.volumes.length, s.playbackRate])).toEqual([[10, 1, 1], [11, 2, 2]]);
  });

  it('starts a new segment when the source jumps (a loop) or the video leaves the screen', () => {
    const segs = videoSegments(at([[0, [v('k', 0)]], [1, [v('k', 1 / 30)]], [2, [v('k', 0)]], [5, [v('k', 0.1)]]]), 30);
    expect(segs.map((s) => [s.from, s.sourceStart, s.volumes.length])).toEqual([[0, 0, 2], [2, 0, 1], [5, 0.1, 1]]);
  });

  it('drops silent segments and keeps videos apart by key', () => {
    const segs = videoSegments(at([[0, [v('a', 0, 0), v('b', 0)]], [1, [v('a', 1 / 30, 0), v('b', 1 / 30)]]]), 30);
    expect(segs).toHaveLength(1);
    expect(segs[0].volumes).toEqual([1, 1]);
  });
});
