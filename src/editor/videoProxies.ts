// Video preview proxies: the server makes a light 720p copy of large, VFR or
// long-GOP uploads in the background. This watcher asks for one
// (POST /api/assets/proxy, once per file and page) for every video asset
// without one, then polls GET /api/assets/proxy, exposes the status
// ("preparing preview") to the Assets panel and inspector, and when the copy
// is ready records it in the preview-proxy cache
// (src/composition/previewProxies.ts). The document is never changed: a
// background proxy must not add an undo step or clear the redo stack. The
// preview switches to the proxy; exports keep using `src`. A `proxySrc`
// stored by older versions is still honoured.

import { useEffect, useMemo } from 'react';
import { create } from 'zustand';
import type { AssetProxyResponse } from '../core/api-contract';
import type { Asset } from '../core/types';
import { previewProxyFor, setPreviewProxy, usePreviewProxies } from '../composition/previewProxies';
import { withTab } from './api';
import { useEditor } from './store';
import { hasRealProxy } from './videoEdits';

export type ProxyStatus = AssetProxyResponse;

export const useVideoProxyStatus = create<{ bySrc: Record<string, ProxyStatus> }>(() => ({ bySrc: {} }));

/** Display status of an asset's preview: 'proxy' (using one), 'preparing', 'failed', or 'original' (none needed). */
export function previewState(asset: Asset, status: ProxyStatus | undefined): { kind: 'proxy' | 'preparing' | 'failed' | 'original'; text: string } {
  if (hasRealProxy(asset) || previewProxyFor(asset.src) || (status?.status === 'ready' && status.proxySrc)) return { kind: 'proxy', text: 'Preview: 720p proxy · export uses the original' };
  if (status?.status === 'pending' || status?.status === 'ready') return { kind: 'preparing', text: `Preparing preview…${status.reasons.length ? ` (${status.reasons.join(', ')})` : ''}` };
  if (status?.status === 'failed') return { kind: 'failed', text: `Preview copy failed (${status.error ?? 'unknown error'}); the preview plays the original` };
  return { kind: 'original', text: 'Preview plays the original file' };
}

/** Files already asked for a proxy on this page (later checks only read the status). */
const requested = new Set<string>();

async function fetchStatus(src: string): Promise<ProxyStatus | null> {
  const create = !requested.has(src);
  try {
    const res = create
      ? await fetch('/api/assets/proxy', withTab({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ src }), signal: AbortSignal.timeout(15000) }))
      : await fetch(`/api/assets/proxy?src=${encodeURIComponent(src)}`, withTab({ signal: AbortSignal.timeout(15000) }));
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('application/json')) return null;
    if (create) requested.add(src);
    return (await res.json()) as ProxyStatus;
  } catch {
    return null;
  }
}

/**
 * Apply polled statuses: the status store, and the preview-proxy cache for
 * ready ones — never the document or its history. Returns the files to poll
 * again (still pending, or not answered).
 */
export function applyProxyStatuses(results: readonly (readonly [string, ProxyStatus | null])[]): string[] {
  const next = { ...useVideoProxyStatus.getState().bySrc };
  const again: string[] = [];
  for (const [src, status] of results) {
    if (!status) {
      again.push(src);
      continue;
    }
    next[src] = status;
    if (status.status === 'ready' && status.proxySrc) setPreviewProxy(src, status.proxySrc);
    if (status.status === 'pending') again.push(src);
  }
  useVideoProxyStatus.setState({ bySrc: next });
  return again;
}

/** Runs once in the app (from the Assets panel). */
export function useVideoProxyFill(pollMs = 1500) {
  const assets = useEditor((s) => s.doc.project.assets);
  const server = useEditor((s) => s.server);
  const proxies = usePreviewProxies();
  const key = useMemo(
    () => [...new Set(Object.values(assets).filter((a) => a.kind === 'video' && !hasRealProxy(a) && !previewProxyFor(a.src)).map((a) => a.src))].sort().join('|'),
    // `proxies` changes when a proxy becomes ready (the cache is read inside).
    [assets, proxies],
  );
  useEffect(() => {
    if (server !== 'up' || !key) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending = key.split('|');
    const tick = async () => {
      const results = await Promise.all(pending.map(async (src) => [src, await fetchStatus(src)] as const));
      if (cancelled) return;
      pending = applyProxyStatuses(results);
      if (pending.length) timer = setTimeout(tick, pollMs);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [key, server, pollMs]);
}
