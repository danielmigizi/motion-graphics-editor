// The editor's client for the server's beat analysis (GET /api/assets/beats):
// tempo and bar starts for the Assets panel and the New video brief. Cached
// per src and frame rate for the session; a failure (server down, file not
// decodable) resolves null and is retried on the next ask.

import { useEffect, useState } from 'react';
import type { BeatsResponse } from '../core/beats';
import { withTab } from './api';

const cache = new Map<string, Promise<BeatsResponse | null>>();
const done = new Map<string, BeatsResponse | null>();
const key = (src: string, fps: number) => `${fps}|${src}`;

export function fetchBeats(src: string, fps: number): Promise<BeatsResponse | null> {
  const k = key(src, fps);
  let p = cache.get(k);
  if (!p) {
    p = fetch(`/api/assets/beats?src=${encodeURIComponent(src)}&fps=${fps}`, withTab())
      .then(async (res) => (res.ok ? ((await res.json()) as BeatsResponse) : null))
      .catch(() => null);
    cache.set(k, p);
    void p.then((r) => {
      done.set(k, r);
      if (!r) cache.delete(k);
    });
  }
  return p;
}

/** Beats of an audio file once analysed (null while loading, or when it fails). */
export function useBeats(src: string | null, fps: number): BeatsResponse | null {
  const k = src ? key(src, fps) : '';
  const [state, setState] = useState<{ k: string; r: BeatsResponse | null }>(() => ({ k, r: done.get(k) ?? null }));
  useEffect(() => {
    if (!src) return;
    let live = true;
    void fetchBeats(src, fps).then((r) => live && setState({ k, r }));
    return () => {
      live = false;
    };
  }, [src, fps, k]);
  return state.k === k ? state.r : (done.get(k) ?? null);
}

/** "≈120 BPM", or null when there is no steady pulse. */
export const bpmText = (b: BeatsResponse | null) => (b?.bpm ? `≈${Math.round(b.bpm)} BPM` : null);
