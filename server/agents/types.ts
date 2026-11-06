// Agent providers run one chat turn with a coding agent the user already has
// installed and logged in (their own subscription). The chat manager only
// sees this interface (via the registry in registry.ts).

import type { AgentProviderId, ChatSessionInfo, ProviderInfo } from '../../src/core/api-contract';

export type { AgentProviderId };

export interface AgentTurn {
  prompt: string;
  /** Provider conversation to continue; null starts a new one. */
  sessionId: string | null;
  /** Model id from the provider's list; '' = the agent's default. */
  model: string;
  /**
   * Auto-apply was on when the user sent this message. Supported harnesses
   * use their native automatic permission reviewer. Absent = off.
   */
  autoApply?: boolean;
  /** Absolute paths of image attachments (for CLIs that take images as flags). */
  images: string[];
  /** The project's workspace folder (absolute, exists): the agent's working directory. */
  workspace: string;
  signal: AbortSignal;
  /** Ask through the active editor. Missing callback, cancellation and timeout deny. */
  askPermission?: (action: string, detail?: string) => Promise<boolean>;
}

export type AgentEvent =
  /** The provider's conversation id, to resume on the next turn. */
  | { type: 'session'; sessionId: string }
  /** What the agent reported about its session at start (Claude Code's init event). */
  | { type: 'session-info'; info: ChatSessionInfo }
  /** Streamed assistant text (append). */
  | { type: 'text'; text: string }
  /** The agent started using a tool; `skill` / `mcpServer` when the provider can tell (see ChatPart). */
  | { type: 'tool'; name: string; input: unknown; skill?: string; mcpServer?: string; mcpTool?: string }
  /** `failure` says why a failed turn failed, when that could be recognised (see classifyAgentFailure). */
  | { type: 'done'; isError: boolean; error?: string; failure?: FailureKind; /** Native turn completed successfully before a later abort during metadata collection. */ nativeCompleted?: boolean };

/** Why a turn failed: the account (sign in again), the plan or rate limits, the network, or something else. */
export type FailureKind = 'login-expired' | 'plan-limit' | 'account-changed' | 'rate-limited' | 'network' | 'unknown';

export type ProviderStatus = ProviderInfo;

export interface AgentProvider {
  id: AgentProviderId;
  label: string;
  /**
   * Whether a session can continue on a different model. When false, the
   * chat starts a fresh session (with a transcript) after a model change.
   */
  resumesAcrossModels: boolean;
  /** Installed / signed in / restricted / models. Cheap (no model turn); the registry caches it. */
  status(): Promise<ProviderStatus>;
  run(turn: AgentTurn): AsyncIterable<AgentEvent>;
}
