// Generated media, provider-neutral: the generation log, the generation
// permission card, and importing a generated file from a URL. Shared by the
// local server (log, import), the MCP server and the editor (activity, card).
//
//   GET  /api/generations/log    → GenerationEntry[] (today, newest first)
//   POST /api/assets/import-url  (body: ImportUrlRequest) → ImportUrlResponse
//
// Generation entries also stream to the editor as `generation` events.

import type { AssetKind, AssetProvenance } from './types';

/** The editor's own MCP server name (its tools: mcp__motion-editor__editor_*). */
export const EDITOR_MCP_SERVER = 'motion-editor';

/** Claude Code's tool-name prefix for an MCP server ("claude.ai Linear" → "mcp__claude_ai_Linear"). */
export function mcpToolPrefix(serverName: string): string {
  // Claude Code 2.1.296's own normaliser: claude.ai connectors also collapse "_" runs and trim them.
  let name = serverName.replace(/[^a-zA-Z0-9_-]/g, '_');
  if (serverName.startsWith('claude.ai ')) name = name.replace(/_+/g, '_').replace(/^_|_$/g, '');
  return `mcp__${name}`;
}

/**
 * "mcp__<server>__<tool>" → { prefix, name }; null for non-MCP names. Splits
 * at the FIRST "__" after the server, so it is wrong for server names
 * containing "__": use it for display only.
 */
export function splitMcpTool(tool: string): { prefix: string; name: string } | null {
  const m = /^(mcp__.+?)__([^_].*)$/.exec(tool);
  return m ? { prefix: m[1], name: m[2] } : null;
}

export function excerpt(text: string, max = 160): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** What a generation permission card shows (structured, so the editor can lay it out). */
export interface GenerationAsk {
  /** Generator id, e.g. 'fal'. */
  provider: string;
  tool: string;
  /** generate: spends the provider's allowance and counts against the daily limit; write: changes something without generating. */
  kind: 'generate' | 'write';
  /** "Generate an image". */
  title: string;
  /** Media kind words ("image", "voice-over"), when generating. */
  media?: string;
  prompt?: string;
  model?: string;
  /** Settings as short "key: value" strings. */
  settings: string[];
  target?: string;
  /** Generations this call queues (0 for writes). */
  generations: number;
  usedToday: number;
  dailyLimit: number;
  /** Generation studio: spend in USD replaces the count. The estimate for this request. */
  estimateUsd?: number;
  /** "2 × $0.0675 per image"; with `reserve`, the estimate is a budget reserve rather than a list price. */
  estimateBasis?: string;
  reserve?: boolean;
  /** Today's spend before this request, and the daily budget. */
  spendTodayUsd?: number;
  budgetUsd?: number;
}

export type GenerationEntryKind = 'requested' | 'approved' | 'denied' | 'limit' | 'imported';

/** One line of generation activity (server log, `generation` events, Activity feed). */
export interface GenerationEntry {
  id: string;
  at: number;
  kind: GenerationEntryKind;
  /** Who asked (agent label). */
  agent: string;
  /** Generator id, e.g. 'fal'. */
  provider?: string;
  /** "Generate a shot image" / an imported asset's name. */
  title: string;
  tool?: string;
  /** Today's approved generations after this entry, and the limit. */
  usedToday?: number;
  dailyLimit?: number;
  reason?: string;
}

export interface ImportUrlRequest {
  url: string;
  name?: string;
  /** Kept on the asset; with a provider, the import is logged as an "imported" generation entry. */
  provenance?: AssetProvenance;
}

export interface ImportUrlResponse {
  src: string;
  name: string;
  mimeType: string;
  kind: AssetKind;
  bytes: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  fps?: number;
  hasAudio?: boolean;
}
