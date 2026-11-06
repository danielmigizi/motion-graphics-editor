// Advanced-timeline extras for video bars: the soundtrack's waveform drawn
// across the part of the source the bar plays (so trimming visibly slides
// the sound), and the bar's source-range label.

import { useEffect, useRef, useState } from 'react';
import { videoPreviewSrc } from '../composition/previewProxies';
import { framesToSeconds, resolveAssetUrl } from '../core/timing';
import type { Asset } from '../core/types';
import { useResolvedScheme } from './theme';
import { drawWaveform, usePeaks } from './waveform';
import { useVideoProxyStatus } from './videoProxies';
import { hasRealProxy } from './videoEdits';

/** "src 1.00–4.50 s (2×)" */
export function sourceRangeLabel(trim: number, dur: number, rate: number, fps: number): string {
  const s = (f: number) => framesToSeconds(f, fps).toFixed(2);
  return `src ${s(trim)}–${s(trim + dur * rate)} s${rate !== 1 ? ` (${rate}×)` : ''}`;
}

/**
 * Waveform of a video bar: element frames [visA, visB) (the visible slice)
 * map to source frames trim + f × rate. Decodes the proxy when there is one;
 * skips large originals still waiting for their proxy. Drawn in the panel
 * colour (styles.css .tl-vwave), which the theme flips, so a theme change
 * draws it again.
 */
export function VideoBarWave({ asset, fps, trim, rate, dur, left, ppf, winStart, winEnd, gain }: { asset: Asset; fps: number; trim: number; rate: number; dur: number; left: number; ppf: number; winStart: number; winEnd: number; gain: number }) {
  const scheme = useResolvedScheme();
  const pending = useVideoProxyStatus((s) => s.bySrc[asset.src]?.status === 'pending');
  const url = asset.hasAudio === false || (pending && !hasRealProxy(asset)) ? null : resolveAssetUrl('/', videoPreviewSrc(asset, false));
  const peaks = usePeaks(url, fps);
  const ref = useRef<HTMLCanvasElement>(null);
  const [box, setBox] = useState('');
  const visA = Math.max(0, Math.min(dur, (winStart - left) / ppf));
  const visB = Math.max(0, Math.min(dur, (winEnd - left) / ppf));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox(`${el.clientWidth}x${el.clientHeight}`));
    ro.observe(el);
    return () => ro.disconnect();
  }, [url]);
  useEffect(() => {
    const el = ref.current;
    if (!el || !peaks || !box || visB <= visA) return;
    drawWaveform(el, peaks, trim + visA * rate, trim + visB * rate, () => gain);
  }, [peaks, box, trim, rate, visA, visB, gain, scheme]);
  if (!url) return null;
  return <canvas ref={ref} className="tl-vwave" style={{ left: visA * ppf, width: Math.max(0, visB - visA) * ppf }} aria-hidden data-ready={peaks ? 'true' : undefined} />;
}
