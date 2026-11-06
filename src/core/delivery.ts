import type { DeliveryPreset } from './api-contract';

export const DELIVERY_PRESETS: { id: DeliveryPreset; label: string }[] = [
  { id: 'mp4-1080', label: 'MP4 · project size' },
  { id: 'mp4-720', label: 'MP4 · 720p' },
  { id: 'mp4-2160', label: 'MP4 · 2160p' },
  { id: 'webm-1080', label: 'WebM · project size' },
  { id: 'prores-1080', label: 'ProRes 4444 · project size' },
  { id: 'gif-480', label: 'GIF · 480p · half frame rate' },
];

export function deliverySettings(preset: DeliveryPreset = 'mp4-1080', height: number) {
  if (!DELIVERY_PRESETS.some((p) => p.id === preset)) throw new Error('Unknown delivery preset.');
  const scale = preset === 'mp4-720' ? 720 / height : preset === 'mp4-2160' ? 2160 / height : preset === 'gif-480' ? 480 / height : 1;
  if (preset === 'mp4-2160' && scale > 3) throw new Error('2160p export would upscale the project by more than 3×.');
  const codec = preset === 'webm-1080' ? 'vp9' as const : preset === 'prores-1080' ? 'prores' as const : preset === 'gif-480' ? 'gif' as const : 'h264' as const;
  return { codec, scale, everyNthFrame: codec === 'gif' ? 2 : 1, extension: codec === 'vp9' ? 'webm' : codec === 'prores' ? 'mov' : codec === 'gif' ? 'gif' : 'mp4' };
}

/** H.264 needs even scaled dimensions: the exporter shaves the composition first. */
export function deliveryDimensions(preset: DeliveryPreset | undefined, width: number, height: number) {
  const { codec, scale } = deliverySettings(preset, height);
  if (codec === 'h264') {
    while (Math.round(width * scale) % 2 !== 0) width--;
    while (Math.round(height * scale) % 2 !== 0) height--;
  }
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}
