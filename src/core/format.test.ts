import { describe, expect, it } from 'vitest';
import { fixtureProject } from './__fixtures__/fixtureProject';
import { describeFormatChange } from './format';

const keep = { layout: 'scale', timing: 'keepSeconds' } as const;

describe('format change preview', () => {
  it('says what a frame-rate change does to time', () => {
    const p = describeFormatChange(fixtureProject, { width: 1920, height: 1080, fps: 60, conversion: keep });
    expect(p.summary).toBe('1920×1080 · 30 fps → 1920×1080 · 60 fps');
    expect(p.lines).toEqual(['A 24 s video at 30 fps becomes 24 s at 60 fps; every key moves to the matching time.']);
    const frames = describeFormatChange(fixtureProject, { width: 1920, height: 1080, fps: 60, conversion: { ...keep, timing: 'keepFrames' } });
    expect(frames.lines[0]).toBe('Frame numbers stay the same, so the 24 s video plays in 12 s at 60 fps — 2 times faster.');
    expect(frames.lines[1]).toMatch(/^Audio keeps its own speed/);
    const rounding = describeFormatChange(fixtureProject, { width: 1920, height: 1080, fps: 24, conversion: keep });
    expect(rounding.lines[0]).toBe('A 24 s video at 30 fps becomes 24 s at 24 fps; every key moves to the matching time.');
  });

  it('says what a size change does to layout', () => {
    const vertical = { width: 1080, height: 1920, fps: 30 };
    expect(describeFormatChange(fixtureProject, { ...vertical, conversion: keep }).lines[0]).toBe('Positions stretch to the new frame (×0.56 across, ×1.78 down); sizes and text scale ×0.56 so nothing distorts.');
    expect(describeFormatChange(fixtureProject, { ...vertical, conversion: { ...keep, layout: 'fit' } }).lines[0]).toBe('The whole picture scales ×0.56 and is centred; the background fills the top and bottom.');
    const pixels = describeFormatChange(fixtureProject, { ...vertical, conversion: { ...keep, layout: 'none' } });
    expect(pixels.lines[0]).toBe('Elements keep their pixel positions and sizes; the frame crops around them from the top-left.');
    expect(pixels.lines[1]).toMatch(/^\d+ elements will sit partly outside the frame\.$/);
    expect(describeFormatChange(fixtureProject, { width: 3840, height: 2160, fps: 30, conversion: keep }).lines).toEqual(['Everything scales ×2 to the new frame.']);
  });

  it('says when nothing changes, and when locks block it', () => {
    expect(describeFormatChange(fixtureProject, { width: 1920, height: 1080, fps: 30, conversion: keep })).toMatchObject({ changed: false, lines: ['Nothing changes.'] });
    const locked = { ...fixtureProject, scenes: fixtureProject.scenes.map((s, i) => ({ ...s, locked: i === 0 })) };
    expect(describeFormatChange(locked, { width: 1080, height: 1080, fps: 30, conversion: keep }).blocked).toBe('Unlock the approved scene “Intro” first: a format change touches every scene.');
    expect(describeFormatChange(fixtureProject, { width: 0, height: 1080, fps: 30, conversion: keep }).blocked).toMatch(/whole numbers/);
  });
});
