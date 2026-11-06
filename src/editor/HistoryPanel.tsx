// The History tab of the right column: named checkpoints (on the local
// server), then the revision list: compare two revisions, roll back (as a new
// revision).

import { useEffect, useMemo, useState } from 'react';
import { diffProjects } from '../core/diff';
import type { CommandError, RevisionSource } from '../core/types';
import type { CheckpointSummary } from '../core/api-contract';
import { api, errorText } from './api';
import { serializeDoc } from './doc';
import { ago } from './activity';
import { ChangeList } from './ChangeList';
import { Section } from './fields';
import { Icon, type IconName } from './icons';
import { useEditor } from './store';

const SOURCE: Record<RevisionSource, { label: string; icon: IconName }> = {
  load: { label: 'Opened', icon: 'circle' },
  user: { label: 'You', icon: 'circleDot' },
  ai: { label: 'AI patch', icon: 'sparkles' },
  undo: { label: 'Undo', icon: 'undo' },
  redo: { label: 'Redo', icon: 'redo' },
  rollback: { label: 'Rollback', icon: 'rotateCcw' },
};

function Checkpoints() {
  const origin = useEditor((s) => s.origin);
  const session = useEditor((s) => s.docSession);
  const id = origin.kind === 'server' ? origin.id : null;
  const [list, setList] = useState<CheckpointSummary[]>([]);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setList([]); setError(null); setEditing(false); setName('');
    if (id) api.listCheckpoints(id).then((items) => { if (!cancelled) setList(items); }).catch((e) => { if (!cancelled) setError(errorText(e).message); });
    return () => { cancelled = true; };
  }, [id, session]);
  const save = async () => {
    if (!id) return;
    const st = useEditor.getState();
    setBusy(true); setError(null);
    try {
      const cp = await api.saveCheckpoint(id, { name: name.trim(), file: serializeDoc(st.doc) });
      if (useEditor.getState().docSession !== session) return;
      setList((items) => [cp, ...items]); setName(''); setEditing(false);
    } catch (e) { if (useEditor.getState().docSession === session) setError(errorText(e).message); }
    finally { setBusy(false); }
  };
  const restore = async (cp: CheckpointSummary) => {
    if (!id) return;
    setBusy(true); setError(null);
    try {
      const full = await api.getCheckpoint(id, cp.id);
      if (useEditor.getState().docSession !== session) return;
      const err = useEditor.getState().restoreCheckpoint(full);
      if (err) setError(err.message);
    } catch (e) { if (useEditor.getState().docSession === session) setError(errorText(e).message); }
    finally { setBusy(false); }
  };
  return <Section title="Checkpoints" actions={id ? <button className="mini-btn" disabled={busy} onClick={() => setEditing(!editing)}>Save checkpoint…</button> : undefined}>
    {!id ? <p className="fine">Save the project to the local server to use checkpoints</p> : <>
      {editing && <form className="btn-row rev-form" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <input className="input" aria-label="Checkpoint name" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        <button className="btn small" disabled={busy || !name.trim()}>Save</button>
      </form>}
      {list.length === 0 && <p className="fine">No checkpoints yet.</p>}
      <ol className="rev-list">{list.map((cp) => <li className="rev checkpoint" key={cp.id}>
        <span className="rev-label" title={cp.note}>{cp.name}</span>
        <span className="rev-num tabular">r{cp.revision}</span>
        <span className="rev-time">{ago(Date.parse(cp.createdAt))}</span>
        <button className="link" disabled={busy} onClick={() => void restore(cp)} title="Open this checkpoint as a new revision (undoable)">Open</button>
      </li>)}</ol>
    </>}
    {error && <div className="notice error" role="alert">{error}</div>}
  </Section>;
}

export function HistoryPanel() {
  const doc = useEditor((s) => s.doc);
  const rollback = useEditor((s) => s.rollback);
  const [picked, setPicked] = useState<number[]>([]);
  const [error, setError] = useState<CommandError | null>(null);
  const revisions = [...doc.revisions].reverse();
  const current = doc.project.revision;

  const toggle = (rev: number) => {
    setPicked((p) => (p.includes(rev) ? p.filter((r) => r !== rev) : [...p, rev].slice(-2)));
  };

  const comparison = useMemo(() => {
    if (picked.length !== 2) return null;
    const [a, b] = [...picked].sort((x, y) => x - y);
    const ra = doc.revisions.find((r) => r.revision === a);
    const rb = doc.revisions.find((r) => r.revision === b);
    if (!ra || !rb) return null;
    return { a, b, changes: diffProjects(ra.snapshot, rb.snapshot) };
  }, [picked, doc.revisions]);

  return (
    <div className="panel-scroll" data-testid="history-panel">
      <Checkpoints />
      {comparison && (
        <Section title={`Compare r${comparison.a} → r${comparison.b}`} actions={<button className="mini-btn" onClick={() => setPicked([])}>Clear</button>}>
          <ChangeList changes={comparison.changes} testId="history-diff" />
        </Section>
      )}
      {error && (
        <div className="notice error" data-testid="history-error">
          <div className="notice-title">
            <span className="code">{error.code}</span> {error.message}
          </div>
          {error.hint && <div className="fine">{error.hint}</div>}
          <button className="mini-btn" onClick={() => setError(null)}>
            Dismiss
          </button>
        </div>
      )}
      <Section title={`Revisions (${doc.revisions.length})`} actions={<span className="hint-tag">tick two to compare</span>}>
        <ol className="rev-list">
          {revisions.map((r) => (
            <li key={r.revision} className={`rev ${r.revision === current ? 'current' : ''} ${picked.includes(r.revision) ? 'picked' : ''}`} data-testid={`revision-${r.revision}`}>
              <label className="rev-pick">
                <input type="checkbox" checked={picked.includes(r.revision)} onChange={() => toggle(r.revision)} data-testid={`revision-compare-${r.revision}`} aria-label={`Compare r${r.revision}`} />
              </label>
              <span className="rev-num tabular">r{r.revision}</span>
              <span className={`rev-src ${r.source}`} title={SOURCE[r.source].label}>
                <Icon name={SOURCE[r.source].icon} size={12} />
              </span>
              <span className="rev-label" title={r.label}>
                {r.label}
              </span>
              {/* 24-hour, so the time fits the 304 px column beside the label; the full date is in the tooltip. */}
              <span className="rev-time tabular" title={new Date(r.at).toLocaleString()}>
                {new Date(r.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' })}
              </span>
              {r.revision !== current && (
                <button
                  className="mini-btn rev-restore"
                  data-testid={`revision-rollback-${r.revision}`}
                  title="Roll back to this revision (creates a new revision; undoable)"
                  onClick={() => {
                    const err = rollback(r.revision);
                    setError(err);
                    if (!err) useEditor.getState().toast({ tone: 'success', message: `Rolled back to r${r.revision} as r${useEditor.getState().doc.project.revision}.` });
                  }}
                >
                  Roll back
                </button>
              )}
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}
