// Banners over the stage (save failure, recovery, a locked tab), the Open project dialog and
// the toasts. The stage's own header lives in StageHeader.tsx.

import { ago } from './activity';
import { useEffect, useState } from 'react';
import type { ProjectSummary } from '../core/api-contract';
import { api, ServerDownError, SERVER_DOWN_MESSAGE } from './api';
import { Icon } from './icons';
import { acceptRecovery, discardRecovery, downloadRecoveryCopies, exportJson, openFromServer, openSample, saveToServer, useRecovery, useSaving } from './persistence';
import { claim, NO_TOKEN_MESSAGE, tokenFrom, useSession } from './session';
import { useEditor } from './store';

function SaveFailureBanner() {
  const failed = useSaving((s) => s.failed);
  const message = useSaving((s) => s.message);
  const saving = useSaving((s) => s.saving);
  if (!failed) return null;
  return <div className="banner notice error" role="alert" data-testid="save-failure-banner">
    <span>Save failed. {message} Your edits are still open.</span>
    <button className="btn small primary" disabled={saving} onClick={() => void saveToServer()}>Retry</button>
    <button className="btn small" onClick={exportJson}>Download a copy</button>
  </div>;
}

export function RecoveryBanner() {
  const offer = useRecovery((s) => s.offer);
  const saved = useRecovery((s) => s.saved);
  return <>
    <SaveFailureBanner />
    {offer && <div className="banner" data-testid="recovery-banner">
      <span>Recovery available for “{offer.file.project.name}”.</span>
      <button className="btn small primary" data-testid="recover-accept" onClick={acceptRecovery}>
        Recover r{offer.file.project.revision} from {ago(offer.at)}
      </button>
      <button className="btn small" data-testid="recover-discard" onClick={discardRecovery}>
        {saved ? `Open saved r${saved.project.revision}` : 'Discard'}
      </button>
      {saved && <button className="btn small" onClick={downloadRecoveryCopies}>Download both</button>}
    </div>}
  </>;
}

/**
 * The locked notice's words: where the link is (a terminal, or the file an
 * agent-started server saved it in), then either the wait for an unlocked tab
 * to allow a minted link, with the pairing code to compare, or why the last
 * unlock failed.
 */
export function LockedNoticeText({ linkFile, code, error }: { linkFile: string | null; code: string | null; error: string | null }) {
  return <div className="session-banner-text">
    <strong>This tab isn’t unlocked</strong>
    {linkFile
      ? <span data-testid="session-link-file">An agent started the editor, so its link wasn’t printed in a terminal. It’s saved in <code>{linkFile}</code>: open that file from your own terminal (for example <code>cat {linkFile}</code>) and paste the link here. It works once.</span>
      : <span>Open the editor link from the terminal where npm run dev is running. It ends in ?session=… and works once. Until then, agents, the fal key and generation settings are off; editing and exports still work.</span>}
    {code !== null
      ? <span className="session-banner-wait" role="status" data-testid="session-waiting">
          Waiting for the unlocked tab. It will ask you to allow this browser: allow it only if it shows the code <strong className="pairing-code" data-testid="session-code">{code}</strong>.
        </span>
      : error && <span className="session-banner-error" role="alert" data-testid="session-error">{error}</span>}
  </div>;
}

/** A tab that has not opened the editor link (session.ts): what is off, and a field to paste the link into. Under the header, never over the stage. */
export function LockedBanner() {
  const locked = useSession((s) => s.editor === false);
  const error = useSession((s) => s.error);
  // A claim waiting on an unlocked tab shows here even at boot (a minted link opened in the address bar, editor still unknown).
  const code = useSession((s) => s.code);
  const waiting = code !== null;
  const linkFile = useSession((s) => s.linkFile);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  if (!locked && !waiting) return null;
  const unlock = async () => {
    const token = tokenFrom(draft);
    if (!token) return setProblem(NO_TOKEN_MESSAGE);
    setBusy(true);
    const why = await claim(token);
    setBusy(false);
    setProblem(why);
    // The token is spent either way: never leave it sitting in the field.
    setDraft('');
  };
  return <div className="banner session-banner" role="region" aria-label="This tab isn’t unlocked" data-testid="session-banner">
    <LockedNoticeText linkFile={linkFile} code={code} error={problem ?? error} />
    <form className="session-unlock" onSubmit={(e) => { e.preventDefault(); void unlock(); }}>
      <input
        className="input"
        value={draft}
        autoComplete="off"
        spellCheck={false}
        placeholder="Paste the editor link"
        aria-label="Editor link"
        disabled={busy || waiting}
        data-testid="session-link-input"
        onChange={(e) => { setDraft(e.target.value); setProblem(null); }}
      />
      {/* While the claim waits on an unlocked tab, the notice says so: the button keeps its plain label. */}
      <button className="btn small primary" type="submit" disabled={busy || waiting || !draft.trim()} data-testid="session-unlock">{busy && !waiting ? 'Unlocking…' : 'Unlock'}</button>
    </form>
  </div>;
}

export function OpenDialog() {
  const open = useEditor((s) => s.openDialog);
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [down, setDown] = useState(false);
  const origin = useEditor((s) => s.origin);
  // Newest first; the built-in sample comes after the saved projects.
  const sorted = list && [...list].sort((a, b) => Date.parse(b.savedAt) - Date.parse(a.savedAt));
  useEffect(() => {
    if (!open) return;
    setList(null);
    setDown(false);
    api
      .listProjects()
      .then(setList)
      .catch((e) => {
        setDown(e instanceof ServerDownError);
        setList([]);
      });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && useEditor.getState().setOpenDialog(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && useEditor.getState().setOpenDialog(false)}>
      <div className="modal" role="dialog" aria-label="Open project" data-testid="open-dialog">
        <header className="modal-head">
          <h2>Open project</h2>
          <button className="icon-btn" onClick={() => useEditor.getState().setOpenDialog(false)} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <ul className="open-list">
          {list === null && <li className="fine pad">Loading saved projects…</li>}
          {sorted?.map((p) => {
            const current = origin.kind === 'server' && origin.id === p.id;
            return (
              <li key={p.id}>
                <button className="open-item" data-testid={`open-project-${p.id}`} aria-current={current ? 'true' : undefined} onClick={() => openFromServer(p.id)}>
                  <span className="item-name">{p.name}</span>
                  <span className="item-meta tabular">
                    r{p.revision} · saved {new Date(p.savedAt).toLocaleString()}
                    {current && ' · Open'}
                  </span>
                </button>
              </li>
            );
          })}
          {list && list.length === 0 && !down && <li className="fine pad">No saved projects yet.</li>}
          <li role="separator" aria-hidden="true">
            <hr />
          </li>
          <li>
            <button className="open-item" data-testid="open-sample" aria-current={origin.kind === 'sample' ? 'true' : undefined} onClick={openSample}>
              <span className="item-name">Sample: Relay launch demo</span>
              <span className="item-meta">
                24 s · built in{origin.kind === 'sample' && ' · Open'}
              </span>
            </button>
          </li>
        </ul>
        {down && (
          <div className="notice warn" data-testid="open-server-down">
            <strong>{SERVER_DOWN_MESSAGE}.</strong>
            <div className="fine">Saved projects live on the local server. You can still open the sample or import a JSON file.</div>
          </div>
        )}
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useEditor((s) => s.toasts);
  return (
    <div className="toasts" aria-live="polite" data-testid="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`} data-testid={`toast-${t.tone}`}>
          <div className="toast-body">
            <div className="toast-msg">{t.message}</div>
            {t.path && <div className="toast-path">at {t.path}</div>}
            {t.hint && <div className="toast-hint">{t.hint}</div>}
          </div>
          <button className="icon-btn small" onClick={() => useEditor.getState().dismissToast(t.id)} aria-label="Dismiss">
            <Icon name="close" size={12} />
          </button>
        </div>
      ))}
    </div>
  );
}
