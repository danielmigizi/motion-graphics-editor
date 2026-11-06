// Audio waveforms for both timelines: the asset is decoded in the browser
// (Web Audio decodeAudioData), reduced to peaks once per asset URL and frame
// rate (cached), and drawn on a canvas; plus the onset detector behind
// "Mark beats". The peak, column and onset math is pure and deterministic for
// a given decoded signal.

import { createElement, useEffect, useRef, useState, type CSSProperties } from 'react';
import { clipVolumeAt } from '../composition/AudioTrack';
import { computePeaks, type Peaks } from '../core/beats';
import type { AudioClip } from '../core/types';

// The pure peak and onset math lives in src/core/beats.ts (the server's beats
// endpoint uses the same code); re-exported here for the timelines.
export { computePeaks, detectOnsets, frameEnergy, peakFrames, PEAKS_PER_FRAME, type OnsetOptions, type Peaks } from '../core/beats';

/**
 * Reduce the peaks covering source frames [from, to) to `columns` values
 * (max per column): what one canvas column draws. Past the end is silence.
 */
export function peakColumns(peaks: Peaks, from: number, to: number, columns: number): Float32Array {
  const out = new Float32Array(Math.max(0, Math.floor(columns)));
  const span = (to - from) / Math.max(1, out.length);
  for (let c = 0; c < out.length; c++) {
    const i0 = Math.max(0, Math.floor((from + c * span) * peaks.perFrame));
    const i1 = Math.min(peaks.data.length, Math.max(i0 + 1, Math.ceil((from + (c + 1) * span) * peaks.perFrame)));
    let m = 0;
    for (let i = i0; i < i1; i++) if (peaks.data[i] > m) m = peaks.data[i];
    out[c] = m;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Decoding (browser) — cached per URL and fps
// ---------------------------------------------------------------------------

const pending = new Map<string, Promise<Peaks | null>>();
const ready = new Map<string, Peaks | null>();
const cacheKey = (url: string, fps: number) => `${fps}|${url}`;

/** Decode an audio URL into peaks. Resolves null when the file is missing or cannot be decoded. */
export function loadPeaks(url: string, fps: number): Promise<Peaks | null> {
  const key = cacheKey(url, fps);
  let p = pending.get(key);
  if (!p) {
    p = (async () => {
      try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const bytes = await res.arrayBuffer();
        // An offline context decodes without starting audio output (no user gesture needed).
        const audio = await new OfflineAudioContext(1, 1, 44100).decodeAudioData(bytes);
        const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
        return computePeaks(channels, audio.sampleRate, fps);
      } catch {
        return null;
      }
    })();
    void p.then((v) => ready.set(key, v));
    pending.set(key, p);
  }
  return p;
}

/** Peaks for an audio URL once decoded (null while loading or when it fails). */
export function usePeaks(url: string | null, fps: number): Peaks | null {
  const key = url ? cacheKey(url, fps) : '';
  const [state, setState] = useState<{ key: string; peaks: Peaks | null }>(() => ({ key, peaks: ready.get(key) ?? null }));
  useEffect(() => {
    if (!url) return;
    let live = true;
    void loadPeaks(url, fps).then((peaks) => live && setState({ key, peaks }));
    return () => {
      live = false;
    };
  }, [url, fps, key]);
  return state.key === key ? state.peaks : (ready.get(key) ?? null);
}

/**
 * Draw source frames [from, to) across the canvas (sized to its CSS box at
 * the device pixel ratio), mirrored about the middle, in the canvas's CSS
 * `color`. `gainAt(sourceFrame)` scales each column (clip volume and fades).
 */
export function drawWaveform(canvas: HTMLCanvasElement, peaks: Peaks, from: number, to: number, gainAt?: (sourceFrame: number) => number): void {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = getComputedStyle(canvas).color;
  const cols = peakColumns(peaks, from, to, w);
  const mid = h / 2;
  const span = (to - from) / w;
  for (let c = 0; c < w; c++) {
    const gain = gainAt ? gainAt(from + (c + 0.5) * span) : 1;
    const half = Math.max(0.5 * dpr, cols[c] * gain * (mid - dpr));
    ctx.fillRect(c, mid - half, 1, half * 2);
  }
}

/**
 * A clip's waveform: draws clip frames [from, to) (clip-relative, so the
 * advanced timeline can draw only the visible slice) of the clip's source,
 * scaled by its volume and fades, into a canvas sized by CSS. Colour comes
 * from the canvas's CSS `color`.
 */
export function ClipWaveform({ url, fps, clip, from, to, className, style }: { url: string | null; fps: number; clip: AudioClip; from: number; to: number; className?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const peaks = usePeaks(url, fps);
  const [box, setBox] = useState('');
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox(`${el.clientWidth}x${el.clientHeight}`));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const el = ref.current;
    if (!el || !peaks || !box) return;
    drawWaveform(el, peaks, clip.trimStartFrames + from, clip.trimStartFrames + to, (src) => clipVolumeAt(clip, src - clip.trimStartFrames));
  }, [peaks, box, clip, from, to]);
  return createElement('canvas', { ref, className, style, 'aria-hidden': true, 'data-ready': peaks ? 'true' : undefined });
}
