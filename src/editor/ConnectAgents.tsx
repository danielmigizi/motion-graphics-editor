// Connect panel: every agent the chat can use, whether it is ready, and how
// to get it there. Signing in always happens in the user's own terminal with
// the agent's own CLI (the editor never sees credentials), so the panel shows
// the command to run, copies it, and checks again afterwards.

import { useEffect, useState } from 'react';
import type { ProviderInfo } from '../core/api-contract';
import { loadProviders, providerStatus, useChat, type ProviderStatusKind } from './chat';
import { Icon } from './icons';
import { useEditor } from './store';
import './chat.css';

const STATE_TEXT: Record<ProviderStatusKind, string> = { available: 'Ready', 'signed-out': 'Not signed in', missing: 'Not installed', unsupported: 'Unavailable' };

/** One line on what to do next, for each state. */
function explain(p: ProviderInfo, status: ProviderStatusKind): string {
  if (status === 'available') return 'Signed in and limited to the editor’s tools. Pick it in the chat’s agent menu.';
  if (status === 'missing') return `Install ${p.label}, sign in with the command below, then check again.`;
  if (status === 'signed-out') return 'Run the command below in a terminal to sign in, then check again.';
  if (p.state === 'error') return `${p.label} did not answer its status check. Check again in a moment.`;
  return `The editor can’t limit ${p.label} to its own tools, so the chat won’t run it.`;
}

function SignInCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
    } catch {
      useEditor.getState().toast({ tone: 'info', message: 'Clipboard access was blocked — select the command and copy it.' });
    }
  };
  return (
    <div className="c-connect-cmd">
      <code>{command}</code>
      <button className="icon-btn small" aria-label={copied ? 'Copied' : `Copy “${command}”`} title={copied ? 'Copied' : 'Copy'} onClick={() => void copy()}>
        <Icon name={copied ? 'check' : 'copy'} size={12} />
      </button>
    </div>
  );
}

/** Every agent with its state and how to sign in. `compact` hides ready agents' details. */
export function ConnectAgents({ compact = false }: { compact?: boolean }) {
  const providers = useChat((s) => s.providers);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    if (!providers.length) void loadProviders();
  }, [providers.length]);

  const checkAgain = async () => {
    setChecking(true);
    try {
      await loadProviders({ force: true });
    } finally {
      setChecking(false);
    }
  };

  return (
    <section className={`c-connect ${compact ? 'compact' : ''}`} aria-label="Connect agents" data-testid="connect-agents">
      {/* In the chat a label heads the list; in the Connect agents dialog its title does, and the intro takes the label's place. */}
      <div className="c-connect-head">
        {compact ? <strong>Agents</strong> : <p className="c-connect-intro">Each agent runs on your own subscription, through its own app. Sign in there; the editor never sees your credentials.</p>}
        <button className="btn small" onClick={() => void checkAgain()} disabled={checking} data-testid="connect-check-again">
          {checking ? 'Checking…' : 'Check again'}
        </button>
      </div>
      {providers.length === 0 && <div className="c-menu-empty">Checking which agents are installed…</div>}
      <ul className="c-connect-list">
        {providers.map((p) => {
          const status = providerStatus(p);
          const showHelp = status !== 'available' || !compact;
          return (
            <li key={p.id} className={`c-connect-item ${status}`} data-testid={`connect-${p.id}`}>
              <div className="c-connect-row">
                <span className={`c-dot ${status}`} aria-hidden />
                <span className="c-connect-name">{p.label}</span>
                <span className="c-connect-state">{STATE_TEXT[status]}</span>
              </div>
              {showHelp && <div className="c-connect-explain">{explain(p, status)}</div>}
              {showHelp && p.detail && <div className="c-connect-detail">{p.detail}</div>}
              {(status === 'signed-out' || status === 'missing') && p.signIn && <SignInCommand command={p.signIn.command} />}
              {showHelp && p.signIn?.docsUrl && (
                <a className="c-connect-docs" href={p.signIn.docsUrl} target="_blank" rel="noreferrer">
                  {p.label} docs
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
