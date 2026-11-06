import { describe, expect, it } from 'vitest';
import { DELIVERY_PRESETS } from '../core/delivery';
import { presetSpec, specLine } from './ExportPanel';

const HD = { width: 1920, height: 1080, fps: 30 };

const line = (preset: Parameters<typeof presetSpec>[0], project = HD) => {
  const r = presetSpec(preset, project);
  return r.ok ? specLine(r.spec) : r.reason;
};

describe('export presets: what each resolves to', () => {
  it('reads size, frame rate and file format for a 1080p project', () => {
    expect(DELIVERY_PRESETS.map((p) => line(p.id))).toEqual([
      '1920×1080 · 30 fps · MP4',
      '1280×720 · 30 fps · MP4',
      '3840×2160 · 30 fps · MP4',
      '1920×1080 · 30 fps · WebM',
      '1920×1080 · 30 fps · MOV',
      '853×480 · 15 fps · GIF',
    ]);
  });

  it('names the codecs and the frame step Advanced shows', () => {
    const gif = presetSpec('gif-480', HD);
    const prores = presetSpec('prores-1080', HD);
    expect(gif.ok && gif.spec).toMatchObject({ video: 'GIF', audio: 'None', everyNthFrame: 2 });
    expect(prores.ok && prores.spec).toMatchObject({ video: 'ProRes 4444', audio: 'PCM', everyNthFrame: 1, scale: 1 });
  });

  it('shaves an odd H.264 size to even, as the exporter does, and keeps fractional frame rates short', () => {
    expect(line('mp4-1080', { width: 1081, height: 607, fps: 29.97 })).toBe('1080×606 · 29.97 fps · MP4');
    expect(line('gif-480', { width: 1080, height: 1920, fps: 25 })).toBe('270×480 · 12.5 fps · GIF');
  });

  it('says why 2160p is out of reach for a small project instead of resolving it', () => {
    const r = presetSpec('mp4-2160', { width: 640, height: 360, fps: 30 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toMatch(/more than 3×/);
  });
});
