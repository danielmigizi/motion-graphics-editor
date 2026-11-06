import type { ChangeEntry } from '../core/types';

function short(v: unknown): string {
  if (v === undefined) return '—';
  const s = typeof v === 'string' ? `“${v}”` : JSON.stringify(v);
  return s.length > 80 ? `${s.slice(0, 77)}…` : s;
}

const VERB: Record<ChangeEntry['change'], string> = { added: 'Added', removed: 'Removed', modified: 'Changed', moved: 'Moved' };

export function ChangeList({ changes, testId }: { changes: ChangeEntry[]; testId?: string }) {
  if (!changes.length) return <p className="fine" data-testid={testId}>No differences.</p>;
  return (
    <ul className="change-list" data-testid={testId}>
      {changes.map((c, i) => (
        <li key={i} className={`change ${c.change}`}>
          <div className="change-head">
            <span className={`change-kind ${c.change}`}>{VERB[c.change]}</span>
            <span className="change-label">{c.label}</span>
          </div>
          {(c.change === 'modified' || c.change === 'moved') && (
            <div className="change-values">
              <span className="before">{short(c.before)}</span>
              <span className="arrow">→</span>
              <span className="after">{short(c.after)}</span>
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}
