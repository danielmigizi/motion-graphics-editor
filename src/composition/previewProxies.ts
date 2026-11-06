// Preview proxies the server has ready, by asset src — kept OUTSIDE the
// document (and so outside undo/redo history): a proxy finishing in the
// background must never add an undo step or clear the redo stack. The editor
// fills it from GET /api/assets/proxy (src/editor/videoProxies.ts); the
// preview's video and audio sources read it. Rendering (exports, stills)
// never does: it always reads the original `src`.

import { useSyncExternalStore } from 'react';
import type { Asset } from '../core/types';

const ready = new Map<string, string>();
const listeners = new Set<() => void>();
let version = 0;

/** Record (or with null, forget) the ready proxy of the file at `src`. */
export function setPreviewProxy(src: string, proxySrc: string | null): void {
  if ((proxySrc ?? undefined) === ready.get(src)) return;
  if (proxySrc) ready.set(src, proxySrc);
  else ready.delete(src);
  version++;
  for (const fn of listeners) fn();
}

/** The ready proxy of the file at `src`, if the server has made one. */
export function previewProxyFor(src: string): string | undefined {
  return ready.get(src);
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const snapshot = () => version;

/** Re-render when a proxy becomes ready; returns a version number. */
export function usePreviewProxies(): number {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/**
 * The file the preview should load for a video asset: its ready proxy, else a
 * `proxySrc` stored in an older document (still honoured, no longer written),
 * else the original. Rendering always gets the original.
 */
export function videoPreviewSrc(asset: Pick<Asset, 'src' | 'proxySrc'>, rendering: boolean): string {
  if (rendering) return asset.src;
  return ready.get(asset.src) ?? (asset.proxySrc && asset.proxySrc !== asset.src ? asset.proxySrc : asset.src);
}

/** Tests. */
export function clearPreviewProxies(): void {
  ready.clear();
  version++;
  for (const fn of listeners) fn();
}
