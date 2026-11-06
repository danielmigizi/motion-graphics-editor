// Today's generation activity, as the editor sees it. The server owns it; the
// editor reads it once and hears new entries as `generation` events on the
// editor event stream (agentBridge.ts). Nothing here is kept in browser storage.

import { create } from 'zustand';
import type { GenerationEntry } from '../core/generation';
import { withTab } from './api';

interface GenerationsState {
  /** Today's generation activity, newest first. */
  generations: GenerationEntry[];
}

export const useGenerations = create<GenerationsState>(() => ({ generations: [] }));

export async function loadGenerations(): Promise<void> {
  try {
    const res = await fetch('/api/generations/log', withTab());
    const body = (await res.json().catch(() => null)) as GenerationEntry[] | null;
    if (res.ok && Array.isArray(body)) useGenerations.setState({ generations: body });
  } catch {
    // The feed simply starts empty.
  }
}

/** A `generation` event: add it to the feed. */
export function applyGenerationEntry(e: GenerationEntry) {
  useGenerations.setState((s) => (s.generations.some((g) => g.id === e.id) ? s : { generations: [e, ...s.generations].slice(0, 50) }));
}
