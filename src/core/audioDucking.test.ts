import { describe, expect, it } from 'vitest';
import { envelopeAt, trimEnvelope } from './audioDucking';

describe('trimEnvelope', () => {
  const curve = [{ frame: 0, value: 1 }, { frame: 30, value: 0.2 }, { frame: 60, value: 0.2 }, { frame: 90, value: 1 }];
  it('interpolates both boundaries and rebases retained interior points without mutation', () => {
    const copy = structuredClone(curve);
    const trimmed = trimEnvelope(curve, 15, 75)!;
    expect(trimmed.map((p) => p.frame)).toEqual([0, 15, 45, 60]);
    for (let f = 0; f <= 60; f++) expect(envelopeAt(trimmed, f)).toBeCloseTo(envelopeAt(curve, f + 15));
    expect(curve).toEqual(copy);
    expect(trimmed[1]).not.toBe(curve[1]);
  });
  it('holds endpoint gain when extending before or after the original clip', () => {
    expect(trimEnvelope([{ frame: 0, value: 0.4 }, { frame: 30, value: 0.8 }], -15, 45)).toEqual([{ frame: 0, value: 0.4 }, { frame: 15, value: 0.4 }, { frame: 45, value: 0.8 }, { frame: 60, value: 0.8 }]);
  });
  it('handles absent, empty, single-point and zero-length envelopes', () => {
    expect(trimEnvelope(undefined, 10, 20)).toBeUndefined();
    expect(trimEnvelope([], 10, 20)).toEqual([]);
    expect(trimEnvelope([{ frame: 20, value: 0.6 }], 0, 10)).toEqual([{ frame: 0, value: 0.6 }, { frame: 10, value: 0.6 }]);
    const zero = trimEnvelope(curve, 30, 30)!;
    expect(zero).toHaveLength(1);
    expect(zero[0].frame).toBe(0);
    expect(zero[0].value).toBeCloseTo(0.2);
  });
});
