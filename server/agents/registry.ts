// The agents the editor chat can run, in picker order (Claude Code first, so
// it is the default whenever it is available). Status checks run CLI version /
// login commands, so each provider's status is cached for ~30 s; a turn that
// fails because the agent is signed out (or on another account) invalidates
// that agent's status, and GET /api/chat/providers?refresh=1 invalidates all.

import type { AgentProviderId, ProviderInfo } from '../../src/core/api-contract';
import type { AgentProvider } from './types';
import { cached, SIGN_IN, type ProviderOptions } from './shared';
import { createClaudeProvider } from './claude';
import { createCodexProvider } from './codex';
import { createCursorProvider } from './cursor';
import { createOpenCodeProvider } from './opencode';

export class ProviderRegistry {
  private readonly status = new Map<AgentProviderId, ReturnType<typeof cached<ProviderInfo>>>();

  constructor(
    readonly providers: AgentProvider[],
    ttlMs = 30_000,
  ) {
    for (const p of providers) {
      this.status.set(
        p.id,
        cached(ttlMs, () =>
          p.status().catch(
            (err: unknown): ProviderInfo => ({
              id: p.id,
              label: p.label,
              available: false,
              state: 'error',
              detail: `Status check failed: ${err instanceof Error ? err.message : String(err)}`,
              signIn: SIGN_IN[p.id],
              models: [{ id: '', label: 'Default' }],
            }),
          ),
        ),
      );
    }
  }

  get(id: string): AgentProvider | undefined {
    return this.providers.find((p) => p.id === id);
  }

  /** GET /api/chat/providers: every provider, available or not. */
  list(): Promise<ProviderInfo[]> {
    return Promise.all(this.providers.map((p) => this.info(p.id) as Promise<ProviderInfo>));
  }

  info(id: string): Promise<ProviderInfo> | undefined {
    return this.status.get(id as AgentProviderId)?.();
  }

  /** Forget one provider's cached status (e.g. its turn just failed because it is signed out). */
  invalidate(id: string): void {
    this.status.get(id as AgentProviderId)?.invalidate();
  }

  /** Forget every cached status: the next list() checks each agent again. */
  invalidateAll(): void {
    for (const s of this.status.values()) s.invalidate();
  }

  /** The first available provider (Claude Code when it is), else the first listed. */
  async defaultProvider(): Promise<AgentProviderId> {
    const all = await this.list();
    return (all.find((p) => p.available) ?? all[0]).id;
  }
}

/** Every provider, for the real server. */
export function createProviders(opts: ProviderOptions): ProviderRegistry {
  return new ProviderRegistry([createClaudeProvider(opts), createCodexProvider(opts), createCursorProvider(opts), createOpenCodeProvider(opts)]);
}
