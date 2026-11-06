import { useEffect, useState } from 'react';
import type { GenerationAsk } from '../core/generation';
import { formatUsd } from '../core/generationStudio';
import { usePermissions } from './permissions';

/** A studio ask (estimateUsd set): the estimate, today's spend against the budget, and a meter of both. */
function StudioSpend({ g, estimate }: { g: GenerationAsk; estimate: number }) {
  const spent = g.spendTodayUsd ?? 0;
  const budget = g.budgetUsd;
  const after = spent + estimate;
  const cost = g.reserve ? `≈${formatUsd(estimate)} (budget reserve)` : `~${formatUsd(estimate)}`;
  return (
    <div className="gen-ask-spend" data-testid="generation-ask-spend">
      <span className="gen-ask-pill">Spends your {g.provider} credit</span>
      <span className="gen-ask-count tabular" title={g.estimateBasis}>
        {cost}
        {budget !== undefined && ` · today ${formatUsd(spent)} of ${formatUsd(budget)}`}
      </span>
      {budget !== undefined && (
        <span className={`gen-ask-meter ${after > budget ? 'over' : ''}`} aria-hidden>
          <i style={{ width: `${budget > 0 ? Math.min(100, (after / budget) * 100) : 100}%` }} />
        </span>
      )}
    </div>
  );
}

/** A generation or write: what, with which prompt and settings, where, and what it spends. */
export function GenerationDetail({ g }: { g: GenerationAsk }) {
  const rows: [string, string][] = [
    ...(g.media ? [['What', g.media] as [string, string]] : []),
    ...(g.prompt ? [['Prompt', g.prompt] as [string, string]] : []),
    ...(g.model ? [['Model', g.model] as [string, string]] : []),
    ...(g.settings.length ? [['Settings', g.settings.join(' · ')] as [string, string]] : []),
    ...(g.target ? [['Target', g.target] as [string, string]] : []),
  ];
  const after = g.usedToday + g.generations;
  return (
    <div className="gen-ask" data-testid="generation-ask">
      <dl className="gen-ask-rows">
        {rows.map(([k, v]) => (
          <div key={k} className={`gen-ask-row ${k === 'Prompt' ? 'prompt' : ''}`}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
      {g.kind === 'generate' && g.estimateUsd !== undefined ? (
        <StudioSpend g={g} estimate={g.estimateUsd} />
      ) : g.kind === 'generate' ? (
        <div className="gen-ask-spend">
          <span className="gen-ask-pill">Spends {g.provider} allowance</span>
          <span className="gen-ask-count">
            This would be {after} of {g.dailyLimit} today{g.generations > 1 ? ` (+${g.generations})` : ''}
          </span>
          <span className="gen-ask-meter" aria-hidden>
            <i style={{ width: `${Math.min(100, (after / Math.max(1, g.dailyLimit)) * 100)}%` }} />
          </span>
        </div>
      ) : (
        <div className="gen-ask-spend">
          <span className="gen-ask-pill write">Writes to {g.provider}</span>
          <span className="gen-ask-count">No generation</span>
        </div>
      )}
    </div>
  );
}

/**
 * The card's detail line. Another browser's claim reads "Code ABC-123.
 * Allow only if …": the code stands out in the pairing-code style, the same as
 * in the claiming tab's notice, so the two are compared at a glance.
 */
export function PermissionDetail({ detail }: { detail: string }) {
  const pairing = /^Code (\S+)\.(\s[\s\S]*)?$/.exec(detail);
  return (
    <p className="permission-detail">
      {pairing ? <>Code <strong className="pairing-code" data-testid="permission-code">{pairing[1]}</strong>.{pairing[2]}</> : detail}
    </p>
  );
}

/** A non-modal card: editing and chat remain usable while the agent waits. */
export function PermissionPrompt({ floating = false }: { floating?: boolean }) {
  const pending = usePermissions((s) => s.pending);
  const decide = usePermissions((s) => s.decide);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!pending) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(timer);
  }, [pending]);
  if (!pending) return null;
  const seconds = Math.max(0, Math.ceil((pending.expiresAt - now) / 1000));
  // A generator's ask carries `generation` (the card lays it out).
  const generation = (pending as typeof pending & { generation?: GenerationAsk }).generation;
  return (
    <section className={`permission-prompt${floating ? ' permission-prompt-floating' : ''}${generation ? ' permission-generation' : ''}`} aria-label="Agent permission request" onKeyDown={(e) => e.stopPropagation()}>
      <div role="status"><strong>{pending.agent} wants to:</strong> {pending.action}</div>
      {generation ? <GenerationDetail g={generation} /> : pending.detail && <PermissionDetail detail={pending.detail} />}
      <div className="permission-actions">
        <button className="btn primary" onClick={() => decide('allowed')}>{generation?.kind === 'generate' ? 'Generate' : 'Allow'}</button>
        <button className="btn" onClick={() => decide('denied')}>Deny</button>
        <span role="timer" aria-live="off">{seconds}s left</span>
      </div>
    </section>
  );
}
