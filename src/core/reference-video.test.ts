import { describe, expect, it } from 'vitest';
import { contactSheetPages, fastWindows, holdWindows, motionEnergy, paletteFromRgb, REFERENCE_NOTICE, shotsFromCuts } from './reference-video';

describe('reference-video helpers', () => {
  it('builds a shot list from scene cuts with time and frame ranges', () => {
    expect(shotsFromCuts([1.0, 2.5], 4, 10)).toEqual([
      { index: 1, startSeconds: 0, endSeconds: 1, startFrame: 0, endFrame: 9 },
      { index: 2, startSeconds: 1, endSeconds: 2.5, startFrame: 10, endFrame: 24 },
      { index: 3, startSeconds: 2.5, endSeconds: 4, startFrame: 25, endFrame: 39 },
    ]);
    expect(shotsFromCuts([], 2, 30)).toEqual([{ index: 1, startSeconds: 0, endSeconds: 2, startFrame: 0, endFrame: 59 }]);
  });

  it('finds holds and fast windows from per-frame energy', () => {
    const energy = [0, 0.2, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.3, 0.4, 0.5, 0.4, 0.01];
    expect(holdWindows(energy, 10, 0.02, 8)).toEqual([{ startFrame: 2, endFrame: 10, startSeconds: 0.2, endSeconds: 1 }]);
    expect(fastWindows(energy, 10, 0.2, 3)).toEqual([{ startFrame: 11, endFrame: 14, startSeconds: 1.1, endSeconds: 1.4 }]);
  });

  it('measures motion energy and a deterministic palette', () => {
    const a = Uint8Array.from([10, 10, 10, 10]);
    const b = Uint8Array.from([20, 10, 10, 10]);
    expect(motionEnergy([a, b])[1]).toBeCloseTo((10 / 4) / 255, 3);
    const pixels = Uint8Array.from([
      0x10, 0x20, 0x30, 0x10, 0x20, 0x30, 0x10, 0x20, 0x30,
      0xf0, 0x00, 0x00, 0xf1, 0x02, 0x03,
    ]);
    expect(paletteFromRgb(pixels, 2)).toEqual(['#102030', '#f00000']);
    expect(contactSheetPages(50)).toEqual({ pages: 3, tilesPerPage: 24 });
    expect(REFERENCE_NOTICE).toMatch(/absolute value/);
  });
});
