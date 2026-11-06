import { describe, expect, it } from 'vitest';
import { pathControlBounds, pathData, svgNumber, trimDash } from './path';

describe('pathData', () => {
  it('draws straight segments when no handles are set', () => {
    expect(pathData([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], false)).toBe('M0 0 L100 0 L100 50');
  });
  it('uses the out handle of the start node and the in handle of the end node', () => {
    expect(pathData([{ x: 0, y: 300, out: { x: 200, y: 300 } }, { x: 600, y: 100, in: { x: 400, y: 100 } }], false)).toBe('M0 300 C200 300 400 100 600 100');
  });
  it('puts a missing handle on its node so one-sided curves stay cubic', () => {
    expect(pathData([{ x: 0, y: 0, out: { x: 10, y: 20 } }, { x: 30, y: 0 }], false)).toBe('M0 0 C10 20 30 0 30 0');
    expect(pathData([{ x: 0, y: 0 }, { x: 30, y: 0, in: { x: 20, y: 20 } }], false)).toBe('M0 0 C0 0 20 20 30 0');
  });
  it('closes straight with Z, and curved with a closing cubic first', () => {
    const tri = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 5, y: 8 }];
    expect(pathData(tri, true)).toBe('M0 0 L10 0 L5 8 Z');
    expect(pathData([{ x: 0, y: 0, in: { x: -5, y: 5 } }, { x: 10, y: 0 }], true)).toBe('M0 0 L10 0 C10 0 -5 5 0 0 Z');
  });
  it('handles degenerate input and formats numbers deterministically', () => {
    expect(pathData([], true)).toBe('');
    expect(pathData([{ x: 1, y: 2 }], true)).toBe('M1 2');
    expect(pathData([{ x: 0.1 + 0.2, y: -0.0001 }, { x: 1e-9, y: 2 / 3 }], false)).toBe('M0.3 0 L0 0.667');
    expect(svgNumber(-0.0004)).toBe('0');
    expect(svgNumber(1 / 3, 6)).toBe('0.333333');
  });
  it('bounds every node and handle', () => {
    expect(pathControlBounds([{ x: 10, y: 10, out: { x: -20, y: 40 } }, { x: 50, y: 0, in: { x: 60, y: -5 } }])).toEqual({ x: -20, y: -5, width: 80, height: 45 });
  });
});

describe('trimDash (pathLength = 1)', () => {
  it('draws the whole stroke without a dash at full range', () => {
    expect(trimDash(0, 1, 0)).toEqual({ visible: true });
    expect(trimDash(0, 1, 0.37)).toEqual({ visible: true });
  });
  it('hides the stroke when the range is empty', () => {
    expect(trimDash(0, 0, 0)).toEqual({ visible: false });
    expect(trimDash(0.4, 0.4, 0.2)).toEqual({ visible: false });
  });
  it('draws [start, end] as one dash of a period-1 pattern', () => {
    expect(trimDash(0, 0.25, 0)).toEqual({ visible: true, dashArray: '0.25 0.75', dashOffset: '0' });
    expect(trimDash(0.2, 0.5, 0)).toEqual({ visible: true, dashArray: '0.3 0.7', dashOffset: '-0.2' });
  });
  it('treats start > end as the same range', () => {
    expect(trimDash(0.5, 0.2, 0)).toEqual(trimDash(0.2, 0.5, 0));
  });
  it('shifts by the offset and wraps past the end', () => {
    // Visible run 0.8..1.1 → wraps to 0..0.1; the dash pattern repeats with period 1, so both parts draw.
    expect(trimDash(0.6, 0.9, 0.2)).toEqual({ visible: true, dashArray: '0.3 0.7', dashOffset: '-0.8' });
    expect(trimDash(0, 0.5, 1)).toEqual(trimDash(0, 0.5, 0));
    expect(trimDash(0, 0.5, -0.25)).toEqual({ visible: true, dashArray: '0.5 0.5', dashOffset: '-0.75' });
  });
  it('clamps out-of-range trims and keeps dash lengths summing to the period', () => {
    expect(trimDash(-1, 2, 0)).toEqual({ visible: true });
    const d = trimDash(0.123456789, 0.987654321, 0);
    if (!d.visible || !d.dashArray) throw new Error('expected a dash');
    const [a, b] = d.dashArray.split(' ').map(Number);
    expect(a + b).toBeCloseTo(1, 6);
  });
});
