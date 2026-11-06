// The chat's session details (shown by SessionDetails.tsx): what the agent
// reported about its session, or what the editor configured it with (kept on
// each reply as `session`), and what the session used, counted from the
// replies' tool steps. The two stay apart: a skill or MCP server listed at
// start was not necessarily used, the Skill tool being available says nothing
// about which skills exist, and the motion-video workflow the editor puts in
// the agent's instructions is not a skill it invoked. Use is counted only over
// replies from the same agent and session. Claude Code, Codex and Cursor keep
// session details; a field an agent did not report stays "not reported", and
// OpenCode reports nothing.

import type { AgentProviderId, ChatMessage, ChatSessionInfo } from '../core/api-contract';
import { mcpToolPrefix, splitMcpTool } from '../core/generation';

export interface UsedSkill {
  name: string;
  calls: number;
}

export interface UsedServer {
  name: string;
  calls: number;
  /** Tool names called on it (as the agent named them, without any mcp__<server>__ prefix), first call first. */
  tools: string[];
  /** False when only the tool's mcp__<server>__ name prefix names the server (neither the call nor the session's reported list did). */
  reported: boolean;
}

export type SessionView =
  /** No reply yet. */
  | { kind: 'none' }
  /** The latest reply's agent does not report its session. */
  | { kind: 'unreported'; provider: AgentProviderId }
  /** A reply without details from an agent that keeps them: starting, stopped before reporting, or saved before the editor kept them. */
  | { kind: 'missing'; provider: AgentProviderId; why: 'starting' | 'stopped' | 'older' }
  | { kind: 'session'; provider: AgentProviderId; info: ChatSessionInfo; replies: number; skills: UsedSkill[]; servers: UsedServer[] };

/** Agents whose replies carry session details. */
export const SESSION_PROVIDERS: readonly AgentProviderId[] = ['claude', 'codex', 'cursor'];

const byUse = <T extends { name: string; calls: number }>(a: T, b: T) => b.calls - a.calls || a.name.localeCompare(b.name);

/** The latest reply's session, with what that session (same agent, same session id) used across the conversation. */
export function sessionView(messages: ChatMessage[]): SessionView {
  const latest = messages.findLast((m) => m.role === 'assistant');
  if (!latest) return { kind: 'none' };
  // Replies saved before agent choice were Claude Code's.
  const provider = latest.provider ?? 'claude';
  const info = latest.session;
  if (!info) {
    if (!SESSION_PROVIDERS.includes(provider)) return { kind: 'unreported', provider };
    const why: 'starting' | 'stopped' | 'older' = latest.status === 'running' ? 'starting' : latest.status === 'done' || (latest.parts?.length ?? 0) > 0 ? 'older' : 'stopped';
    return { kind: 'missing', provider, why };
  }
  const scope = messages.filter(
    (m) => m.role === 'assistant' && (m.provider ?? 'claude') === provider && m.session !== undefined && (info.sessionId ? m.session.sessionId === info.sessionId : m === latest),
  );
  const skills = new Map<string, UsedSkill>();
  const servers = new Map<string, UsedServer>();
  for (const m of scope) {
    for (const p of m.parts ?? []) {
      if (p.type !== 'tool') continue;
      if (p.skill) {
        const s: UsedSkill = skills.get(p.skill) ?? { name: p.skill, calls: 0 };
        s.calls++;
        skills.set(p.skill, s);
      }
      const split = p.mcpServer ? null : splitMcpTool(p.name);
      const name = p.mcpServer ?? split?.prefix.replace(/^mcp__/, '');
      if (!name) continue;
      // The agent's own tool name when it reports one; else from Claude Code's mcp__<server>__<tool>.
      const tool = p.mcpTool ?? (p.mcpServer ? p.name.slice(mcpToolPrefix(p.mcpServer).length + 2) : split!.name);
      const key = `${p.mcpServer ? 'reported' : 'other'}:${name}`;
      const s: UsedServer = servers.get(key) ?? { name, calls: 0, tools: [], reported: !!p.mcpServer };
      s.calls++;
      if (!s.tools.includes(tool)) s.tools.push(tool);
      servers.set(key, s);
    }
  }
  return { kind: 'session', provider, info, replies: scope.length, skills: [...skills.values()].sort(byUse), servers: [...servers.values()].sort(byUse) };
}

const STATUS_ORDER = ['connected', 'pending', 'needs-auth', 'failed', 'disabled'];
const STATUS_LABELS: Record<string, string> = { connected: 'Connected', pending: 'Connecting', 'needs-auth': 'Needs sign-in', failed: 'Failed', disabled: 'Disabled' };

/** The reported MCP servers grouped by status (connected first), names in reported order. */
export function serversByStatus(servers: NonNullable<ChatSessionInfo['mcpServers']>): { status: string; label: string; names: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const s of servers) groups.set(s.status, [...(groups.get(s.status) ?? []), s.name]);
  const rank = (s: string) => (STATUS_ORDER.includes(s) ? STATUS_ORDER.indexOf(s) : STATUS_ORDER.length);
  return [...groups.entries()]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([status, names]) => ({ status, label: STATUS_LABELS[status] ?? status, names }));
}

const MODE_LABELS: Record<string, string> = {
  // Claude Code's own mode names.
  default: 'Manual: asks you first',
  auto: 'Auto: a safety check reviews actions',
  // The editor's names for the Codex and Cursor modes Auto-apply picks.
  'codex-manual': 'Manual: asks you first',
  'codex-auto-review': 'Auto-review: Codex’s reviewer checks actions',
  'cursor-manual': 'Manual: asks you first',
  'cursor-auto-review': 'Auto-review: Cursor checks actions itself',
};

/** A permission mode in the user's words. */
export function permissionModeLabel(mode: string | undefined): string {
  if (mode === undefined) return 'Not reported';
  return MODE_LABELS[mode] ?? mode;
}

/**
 * Whether the agent reported the mode it ran in, or the editor only asked for
 * it (the agent does not say). Replies without a source are Claude Code's,
 * whose init event reports its mode.
 */
export function permissionSourceLabel(info: ChatSessionInfo, agent: string): string | null {
  if (info.permissionMode === undefined) return null;
  return info.permissionSource === 'configured' ? `Set by the editor; ${agent} doesn’t report it` : `Reported by ${agent}`;
}
