// One line under the chat's messages: what the agent is doing right now (the
// current tool step, or what the agent link reports), how long it has been
// at it, and the turn's full step list behind a small disclosure. Under it, a
// second quiet line: the newest change by anyone (activity.ts) with an undo
// for the one on top of the undo stack, only while it is under a minute old.

import { useEffect, useMemo, useState } from 'react';
import type { ChatMessage } from '../core/api-contract';
import { activityItems, ago, withGenerations, withProposals } from './activity';
import { useAgentLink } from './agentBridge';
import { LOCKED_MESSAGE } from './api';
import { useSession } from './session';
import { providerLabel, useChat } from './chat';
import { useCreate } from './createFlow';
import { Icon } from './icons';
import { useGenerations } from './generations';
import { byYou, useProposals } from './proposals';
import { useEditor } from './store';

/** How long the newest change stays on the second line. */
const RECENT_MS = 60_000;

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** "0:42", "12:05". */
export function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** What the agent is doing in its turn, from the reply streaming in. */
export function currentStep(reply: ChatMessage | undefined): string {
  const last = reply?.parts?.at(-1);
  if (!last) return 'Thinking…';
  return last.type === 'tool' ? `${last.label}…` : 'Writing a reply…';
}

export function AgentStatus() {
  const { status, activity } = useAgentLink();
  const agent = useChat((s) => providerLabel(s.providers, s.provider));
  const chatBusy = useChat((s) => s.busy);
  const messages = useChat((s) => s.messages);
  const server = useEditor((s) => s.server);
  const doc = useEditor((s) => s.doc);
  const log = useProposals((s) => s.log);
  const proposal = useProposals((s) => s.proposal);
  const check = useProposals((s) => s.check);
  const outlinePending = useCreate((s) => s.status === 'pending' && !!s.outline);
  const generations = useGenerations((s) => s.generations);
  const latest = useMemo(() => withGenerations(withProposals(activityItems(doc, 1), log, 1), generations, 1)[0] ?? null, [doc, log, generations]);
  const [open, setOpen] = useState(false);
  // A locked tab runs no agent bridge (session.ts): say why instead of "Connecting…".
  const locked = useSession((s) => s.editor === false);

  const up = status === 'connected' && !locked;
  const working = up && (!!activity || chatBusy);
  const now = useNow(working ? 1000 : 10_000);

  // The latest reply: its steps, and while it runs, its start for the elapsed time.
  const reply = useMemo(() => [...messages].reverse().find((m) => m.role === 'assistant'), [messages]);
  const steps = useMemo(() => reply?.parts?.flatMap((p) => (p.type === 'tool' ? [p.label] : [])) ?? [], [reply]);
  const running = reply?.status === 'running' ? reply : undefined;
  // An agent working through the link alone (a terminal session) has no reply: time it from when the work began.
  const [since, setSince] = useState<number | null>(null);
  useEffect(() => setSince(working ? (s) => s ?? Date.now() : null), [working]);
  const started = running?.at ?? since;

  const reviewing = !!proposal && check?.status === 'ready' && !byYou(proposal.agent);
  const step = locked
    ? 'Locked — open the editor link'
    : !up
    ? status === 'offline'
      ? 'Offline — reconnecting…'
      : 'Connecting…'
    : working
      ? activity && !running
        ? `${capital(activity.detail)}…`
        : currentStep(running)
      : reviewing
        ? 'Done — review the proposal on the stage'
        : outlinePending
          ? 'Done — review the outline above'
          : server === 'down'
            ? 'Server offline'
            : 'Ready';

  const recent = latest && now - latest.at < RECENT_MS ? latest : null;

  return (
    <div className="agent-status" data-testid="agent-status" aria-live="polite">
      <div className="agent-status-line">
        <span
          className={`agent-link ${up ? 'up' : locked || status === 'offline' ? 'down' : ''} ${working ? 'busy' : ''} ${!working && (reviewing || outlinePending) ? 'waiting' : ''}`}
          data-testid="agent-link-status"
          title={up ? `${agent} can see and edit this editor (motion-editor MCP server). Switch agents from the menu above.` : locked ? LOCKED_MESSAGE : 'Not connected to the local server; reconnecting…'}
        >
          <span className="dot" />
          <span className="agent-link-detail">{step}</span>
        </span>
        {working && started != null && <span className="agent-status-elapsed tabular">{elapsedText(now - started)}</span>}
        {steps.length > 0 && (
          <button className="agent-status-steps" aria-expanded={open} data-testid="agent-status-steps" title="Every step of this turn" onClick={() => setOpen(!open)}>
            {steps.length} step{steps.length === 1 ? '' : 's'}
            <Icon name={open ? 'up' : 'down'} size={11} />
          </button>
        )}
      </div>
      {open && steps.length > 0 && (
        <ol className="agent-status-list">
          {steps.map((s, i) => (
            <li key={i} className={running && i === steps.length - 1 ? 'now' : ''}>
              {s}
            </li>
          ))}
        </ol>
      )}
      {recent && (
        <div className={`agent-status-recent ${recent.notApplied ? 'not-applied' : ''}`}>
          <span className="agent-status-text" title={`${recent.text} · ${recent.who}`}>
            {recent.text}
            <span className="agent-status-when">
              {' '}
              · {recent.who} · {ago(recent.at)}
            </span>
          </span>
          {recent.undoable && (
            <button className="icon-btn small" title="Undo this (⌘Z)" data-testid="activity-undo" onClick={() => useEditor.getState().undo()}>
              <Icon name="undo" size={12} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
