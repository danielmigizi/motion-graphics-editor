// Settings › Generation: the fal key, what generation may spend, how
// models are chosen, and how each model has done for you (the scoreboard,
// with route suggestions to accept or dismiss). All of it lives on the local
// server, for every project: the page loads GenerationStatus when it opens
// and saves each change there. The key goes in once and is never shown
// again: the browser only ever holds its masked status, and the draft is
// cleared the moment it is sent.

import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  DEFAULT_GENERATION_SETTINGS,
  formatUsd,
  JOB_KINDS,
  type FalKeyStatus,
  type GenerationModelsResponse,
  type GenerationScoreboard,
  type GenerationSettings,
  type GenerationStatus,
  type JobKind,
  type ModelScore,
  type RoutePolicy,
  type RouteSuggestion,
} from '../core/generationStudio';
import { api, ApiRequestError, errorText, LOCKED_MESSAGE, ServerDownError } from './api';
import { CheckField, CommitNumber, ConfirmButton, Section } from './fields';
import { elapsedText, JOB_LABELS, suggestionKey } from './generateStore';
import { Icon } from './icons';

/** The page's sections, for Settings' palette entries (SETTINGS_SECTIONS) and openSettingsAt. */
export type GenerationSection = 'falKey' | 'spending' | 'routing' | 'models';

/** The last status this session loaded: a reopened page shows it at once and refreshes behind it. */
let cached: GenerationStatus | null = null;

/** loading: the first load; offline: no server (or it could not answer), with the reason to show. */
type Load = { state: 'loading' | 'ready' } | { state: 'offline'; message: string };

const OFFLINE = 'The local server isn’t running; generation settings are kept there.';

/** The Generation page body. `focusSection`: the section Settings was opened at; it gets focus once its controls exist. */
export function GenerationPage({ focusSection }: { focusSection?: string | null }) {
  const [status, setStatusState] = useState<GenerationStatus | null>(cached);
  const [load, setLoad] = useState<Load>({ state: cached ? 'ready' : 'loading' });
  const setStatus = (update: (s: GenerationStatus) => GenerationStatus) =>
    setStatusState((s) => {
      const next = s && update(s);
      cached = next;
      return next;
    });

  const refresh = () => {
    if (!cached) setLoad({ state: 'loading' });
    api.generationStatus().then(
      (s) => {
        cached = s;
        setStatusState(s);
        setLoad({ state: 'ready' });
      },
      (e) => {
        // A server that is down hides stale settings; one that answers with an error keeps what this session saw last.
        if (e instanceof ServerDownError) setLoad({ state: 'offline', message: OFFLINE });
        // A locked tab (session.ts) is told how to unlock, not that the server failed.
        else if (e instanceof ApiRequestError && e.status === 401) setLoad({ state: 'offline', message: LOCKED_MESSAGE });
        else if (!cached) setLoad({ state: 'offline', message: `The local server couldn’t load generation settings: ${errorText(e).message}` });
      },
    );
  };
  useEffect(refresh, []);

  // Opened at one of these sections before its controls existed (the first load): focus it now.
  const root = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  useEffect(() => {
    if (focused.current || load.state === 'loading' || !focusSection) return;
    focused.current = true;
    const dialog = root.current?.closest<HTMLElement>('[role="dialog"]');
    const control = root.current?.querySelector<HTMLElement>(`[data-testid="settings-${focusSection}"] :is(input, select, textarea, button)`);
    // Only when focus is still where the dialog put it, not somewhere the person moved it.
    if (control && (document.activeElement === dialog || !dialog?.contains(document.activeElement) || document.activeElement?.closest('.modal-head'))) control.focus({ preventScroll: true });
  }, [load.state, focusSection]);

  // The sections are always there (Settings scrolls to one when opened at it); their bodies wait for the status.
  const offline = load.state === 'offline';
  const ready = load.state === 'ready' && status;

  return (
    <div ref={root} className="gen-set" data-testid="generation-settings">
      <Section title="fal API key" testId="settings-falKey">
        {load.state === 'offline' ? (
          <Offline message={load.message} onRetry={refresh} />
        ) : ready ? (
          <FalKey status={status.key} onChange={(key) => setStatus((s) => ({ ...s, key }))} />
        ) : (
          <p className="set-note">Checking the local server…</p>
        )}
      </Section>
      <Section title="Spending" testId="settings-spending">
        {offline ? <Unavailable /> : ready && <Spending status={status} setStatus={setStatus} />}
      </Section>
      <Section title="Choosing models" testId="settings-routing">
        {offline ? <Unavailable /> : ready && <Routing status={status} setStatus={setStatus} />}
      </Section>
      <Section title="Models" testId="settings-models">
        {offline ? <Unavailable /> : ready && <Models status={status} setStatus={setStatus} />}
      </Section>
    </div>
  );
}

function Offline({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="gen-set-offline" data-testid="generation-settings-offline">
      <p className="set-note">{message}</p>
      <button className="btn" onClick={onRetry} data-testid="generation-settings-retry">
        Try again
      </button>
    </div>
  );
}

const Unavailable = () => <p className="set-note">Available when the local server is running.</p>;

export function FieldError({ message }: { message?: string | null }) {
  return message ? (
    <p className="gen-set-error" role="alert">
      {message}
    </p>
  ) : null;
}

// ---- fal API key -----------------------------------------------------------

const SOURCE: Record<NonNullable<FalKeyStatus['source']>, string> = {
  keychain: 'saved in the keychain',
  file: 'saved in a private file',
  env: 'from the FAL_KEY environment variable',
};

function KeyState({ k }: { k: FalKeyStatus }) {
  const tested = k.checkedAt ? `Last tested ${new Date(k.checkedAt).toLocaleString()}` : undefined;
  if (k.valid === true)
    return (
      <span className="gen-key-state ok" title={tested} data-testid="fal-key-state">
        Working
      </span>
    );
  if (k.valid === false)
    return (
      <span className="gen-key-state bad" title={tested} data-testid="fal-key-state">
        Rejected: {k.error || 'fal did not accept it'}
      </span>
    );
  return (
    <span className="gen-key-state" data-testid="fal-key-state">
      Not tested
    </span>
  );
}

function FalKey({ status, onChange }: { status: FalKeyStatus; onChange: (k: FalKeyStatus) => void }) {
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  /** After the view swaps (form ↔ saved key), focus lands on the new view instead of dropping to the dialog. */
  const focusNext = useRef<string | null>(null);
  useEffect(() => {
    if (!focusNext.current) return;
    ref.current?.querySelector<HTMLElement>(`[data-testid="${focusNext.current}"]`)?.focus();
    focusNext.current = null;
  });

  const act = async (kind: 'save' | 'test' | 'remove', call: () => Promise<FalKeyStatus>, then?: (k: FalKeyStatus) => void) => {
    setBusy(kind);
    setError(null);
    try {
      const k = await call();
      onChange(k);
      then?.(k);
    } catch (e) {
      setError(errorText(e).message);
    } finally {
      setBusy(null);
    }
  };

  const showForm = !status.configured || replacing;
  return (
    <div ref={ref} className="gen-key-body">
      {showForm ? (
        <KeyForm
          busy={busy === 'save'}
          replacing={replacing}
          error={error}
          onCancel={() => {
            setReplacing(false);
            setError(null);
            focusNext.current = 'fal-key-replace';
          }}
          onSave={(key) =>
            act(
              'save',
              () => api.saveFalKey(key),
              () => {
                setReplacing(false);
                focusNext.current = 'fal-key-test';
              },
            )
          }
        />
      ) : (
        <>
          <div className="gen-key" data-testid="fal-key-saved">
            <div className="gen-key-text">
              <span className="gen-key-name">
                Key ending in <span className="mono">{status.last4 ?? '····'}</span>
                {status.source && <span className="set-meta"> · {SOURCE[status.source]}</span>}
              </span>
              <KeyState k={status} />
              {status.billing === true && <span className="set-note">Can read billing: real costs replace estimates.</span>}
              {status.billing === false && <span className="set-note">Can’t read billing (an API-preset key): costs stay estimates. A key with the BILLING or FULL preset adds real costs.</span>}
            </div>
            <div className="gen-key-actions">
            <button className="mini-btn" disabled={!!busy} data-testid="fal-key-test" title="Ask fal whether it accepts the key" onClick={() => void act('test', api.testFalKey)}>
              {busy === 'test' ? 'Testing…' : 'Test'}
            </button>
            <button
              className="mini-btn"
              disabled={!!busy}
              data-testid="fal-key-replace"
              onClick={() => {
                setError(null);
                setReplacing(true);
                focusNext.current = 'fal-key-input';
              }}
            >
              Replace…
            </button>
            <ConfirmButton
              label={busy === 'remove' ? 'Removing…' : 'Remove'}
              confirmLabel="Remove key"
              disabled={!!busy}
              testId="fal-key-remove"
              title="Delete the saved key from this computer"
              onConfirm={() => void act('remove', api.removeFalKey, (k) => !k.configured && (focusNext.current = 'fal-key-input'))}
            />
            </div>
          </div>
          <FieldError message={error} />
          {status.source === 'env' && <p className="set-note">This key comes from the FAL_KEY environment variable, which Remove can’t clear. Unset it where the server starts to stop using it.</p>}
        </>
      )}
    </div>
  );
}

/** The key entry. The draft lives only here and is cleared as soon as it is sent, whatever the answer. */
function KeyForm({ busy, replacing, error, onSave, onCancel }: { busy: boolean; replacing: boolean; error: string | null; onSave: (key: string) => Promise<void>; onCancel: () => void }) {
  const [draft, setDraft] = useState('');
  const save = () => {
    const key = draft.trim();
    if (!key || busy) return;
    setDraft('');
    void onSave(key);
  };
  return (
    <>
      <div className="gen-key-form">
        <label className="set-field gen-set-field">
          <span className="set-field-label">fal API key</span>
          <input
            type="password"
            className="input"
            value={draft}
            autoComplete="off"
            spellCheck={false}
            placeholder={replacing ? 'Paste the new key' : 'Paste your key'}
            disabled={busy}
            data-testid="fal-key-input"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                save();
              }
            }}
          />
        </label>
        <button className="btn primary" disabled={busy || !draft.trim()} data-testid="fal-key-save" onClick={save}>
          {busy ? 'Checking…' : 'Save'}
        </button>
        {replacing && (
          <button className="btn" disabled={busy} data-testid="fal-key-cancel" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
      <FieldError message={error} />
      <p className="set-note">Stored on this computer in the system keychain, or in a private file when there is no keychain. The editor never sends it to the browser or to agents, but a program running as you could read it.</p>
      <p className="set-note" data-testid="fal-key-advice">
        Use a key just for this editor: create one at{' '}
        <a href="https://fal.ai/dashboard/keys" target="_blank" rel="noreferrer">
          fal.ai/dashboard/keys
        </a>{' '}
        with API scope, put{' '}
        <a href="https://fal.ai/dashboard/billing" target="_blank" rel="noreferrer">
          prepaid credit
        </a>{' '}
        on the account and turn auto top-up off. That credit is the most anyone can spend, even a program running as you. If you think the key leaked, delete it there and paste a new one here.
      </p>
    </>
  );
}

// ---- Spending and routing --------------------------------------------------

type SetStatus = (update: (s: GenerationStatus) => GenerationStatus) => void;

/** Save one setting: shown at once, put back with the server's reason if it refuses. */
function useSaveSetting(setStatus: SetStatus) {
  const [errors, setErrors] = useState<Partial<Record<keyof GenerationSettings, string>>>({});
  const save = <K extends keyof GenerationSettings>(key: K, value: GenerationSettings[K], before: GenerationSettings[K]) => {
    setStatus((s) => ({ ...s, settings: { ...s.settings, [key]: value } }));
    setErrors((e) => ({ ...e, [key]: undefined }));
    api.saveGenerationSettings({ [key]: value }).then(
      (settings) => setStatus((s) => ({ ...s, settings: { ...DEFAULT_GENERATION_SETTINGS, ...settings } })),
      (e) => {
        setStatus((s) => ({ ...s, settings: { ...s.settings, [key]: before } }));
        setErrors((x) => ({ ...x, [key]: errorText(e).message }));
      },
    );
  };
  return { errors, save };
}

function UsdField({ label, value, min, max, step, testId, error, onCommit, children }: { label: string; value: number; min: number; max: number; step: number; testId: string; error?: string; onCommit: (v: number) => void; children?: ReactNode }) {
  return (
    <div className="gen-set-item">
      <label className="set-field gen-set-field">
        <span className="set-field-label">{label}</span>
        <CommitNumber value={value} min={min} max={max} step={step} unit="USD" testId={testId} onCommit={onCommit} />
      </label>
      {children}
      <FieldError message={error} />
    </div>
  );
}

function Spending({ status, setStatus }: { status: GenerationStatus; setStatus: SetStatus }) {
  const s = status.settings;
  const { errors, save } = useSaveSetting(setStatus);
  const spent = status.spendTodayUsd;
  const share = s.dailyBudgetUsd > 0 ? Math.min(1, spent / s.dailyBudgetUsd) : spent > 0 ? 1 : 0;
  return (
    <>
      <div className="gen-spent" data-testid="generation-spent-today">
        <span className="tabular">
          Spent today: {formatUsd(spent)} of {formatUsd(s.dailyBudgetUsd)}
        </span>
        <span className={`gen-ask-meter ${spent >= s.dailyBudgetUsd && spent > 0 ? 'over' : ''}`} aria-hidden>
          <i style={{ width: `${share * 100}%` }} />
        </span>
      </div>
      <UsdField label="Daily budget" value={s.dailyBudgetUsd} min={0} max={1000} step={1} testId="settings-daily-budget" error={errors.dailyBudgetUsd} onCommit={(v) => save('dailyBudgetUsd', v, s.dailyBudgetUsd)} />
      <UsdField label="Ask before a single request over" value={s.confirmOverUsd} min={0} max={1000} step={0.5} testId="settings-confirm-over" error={errors.confirmOverUsd} onCommit={(v) => save('confirmOverUsd', v, s.confirmOverUsd)} />
      <div className="gen-set-item">
        <CheckField
          checked={s.skipCardForOwnClicks}
          label="Skip the permission card for my own clicks (the price is on the button)"
          testId="settings-skip-card"
          onCommit={(v) => save('skipCardForOwnClicks', v, s.skipCardForOwnClicks)}
        />
        <FieldError message={errors.skipCardForOwnClicks} />
      </div>
      <UsdField label="GPT Image budget reserve per image" value={s.gptImageReserveUsd} min={0} max={10} step={0.05} testId="settings-gpt-image-reserve" error={errors.gptImageReserveUsd} onCommit={(v) => save('gptImageReserveUsd', v, s.gptImageReserveUsd)}>
        <p className="set-note">fal bills GPT Image in units it doesn’t size per image. Until real costs are measured, each image holds this much of the budget.</p>
      </UsdField>
      <p className="set-note">Agents always ask on the permission card, with the price. Only you can change these settings.</p>
    </>
  );
}

const POLICIES: { id: RoutePolicy; label: string; hint: string }[] = [
  { id: 'quality', label: 'Quality first', hint: 'The best model for each job, whatever it costs.' },
  { id: 'balanced', label: 'Balanced', hint: 'Cheaper models where your own results show they do as well. Until there’s enough evidence, the same as Quality.' },
  { id: 'draft', label: 'Draft', hint: 'The cheapest capable model, for quick previews.' },
];

function Routing({ status, setStatus }: { status: GenerationStatus; setStatus: SetStatus }) {
  const policy = status.settings.policy;
  const { errors, save } = useSaveSetting(setStatus);
  return (
    <>
      <div className="fmt-choices gen-policies" role="radiogroup" aria-label="Choosing models">
        {POLICIES.map((p) => (
          <button key={p.id} role="radio" aria-checked={policy === p.id} className={`fmt-choice ${policy === p.id ? 'on' : ''}`} data-testid={`settings-policy-${p.id}`} onClick={() => policy !== p.id && save('policy', p.id, policy)}>
            <span className="fmt-choice-label">{p.label}</span>
            <span className="fmt-choice-hint">{p.hint}</span>
          </button>
        ))}
      </div>
      <FieldError message={errors.policy} />
      <p className="set-note">The default for every request. The Generate tab can still pick another policy, or a model, for one request.</p>
    </>
  );
}

// ---- Models: the scoreboard and route suggestions --------------------------

export { suggestionKey };

type BoardLoad = { state: 'loading' } | { state: 'ready'; board: GenerationScoreboard } | { state: 'error'; message: string };

/** Loads the scoreboard (and the routes, to mark each job's default) when the page opens; accepting, resetting and dismissing save on the server. */
function Models({ status, setStatus }: { status: GenerationStatus; setStatus: SetStatus }) {
  const [load, setLoad] = useState<BoardLoad>({ state: 'loading' });
  const [routes, setRoutes] = useState<GenerationModelsResponse | null>(null);
  const [busy, setBusy] = useState<JobKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The defaults the routes report follow overrides and suggestions: fetched again after each change.
  const fetchRoutes = () => api.generationModels().then(setRoutes, () => undefined);
  useEffect(() => {
    api.generationScoreboard().then(
      (board) => setLoad({ state: 'ready', board }),
      (e) => setLoad({ state: 'error', message: e instanceof ServerDownError ? OFFLINE : `Couldn’t load your results: ${errorText(e).message}` }),
    );
    void fetchRoutes();
  }, []);

  /** A change that answers with the scoreboard: shown, and the routes fetched again (Balanced's pick may have moved). */
  const save = (job: JobKind, call: () => Promise<GenerationScoreboard>, after: (board: GenerationScoreboard) => void) => {
    setBusy(job);
    setError(null);
    call()
      .then(
        (board) => {
          setLoad({ state: 'ready', board });
          after(board);
          void fetchRoutes();
        },
        (e) => setError(errorText(e).message),
      )
      .finally(() => setBusy(null));
  };
  const setDefault = (job: JobKind, model: string | null) =>
    save(job, () => api.setRouteOverride(job, model), (board) => setStatus((s) => ({ ...s, settings: { ...s.settings, routeOverrides: board.overrides } })));
  const dismiss = (sug: RouteSuggestion) =>
    save(sug.job, () => api.dismissSuggestion(sug.job, sug.to), () => setStatus((s) => ({ ...s, settings: { ...s.settings, dismissedSuggestions: [...new Set([...(s.settings.dismissedSuggestions ?? []), suggestionKey(sug)])] } })));

  if (load.state === 'loading') return <p className="set-note">Reading your results…</p>;
  if (load.state === 'error') return <p className="set-note">{load.message}</p>;
  return <ModelsView board={load.board} routes={routes} policy={status.settings.policy} dismissed={status.settings.dismissedSuggestions ?? []} busy={busy} error={error} onSetDefault={setDefault} onDismiss={dismiss} />;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/** The scoreboard's numbers, as the table prints them. */
export function scoreCells(r: ModelScore): { runs: string; used: string; kept: string; thumbs: string; matched: string; perKept: string; time: string; failed: string } {
  return {
    runs: String(r.runs),
    used: pct(r.useRate),
    kept: pct(r.keepRate),
    thumbs: `${r.thumbsUp} / ${r.thumbsDown}`,
    matched: r.matchRate === null ? '—' : pct(r.matchRate),
    perKept: r.costPerKept === null ? '—' : formatUsd(r.costPerKept),
    time: r.p50Seconds === null ? '—' : elapsedText(r.p50Seconds * 1000),
    failed: pct(r.failureRate),
  };
}

const COLUMNS: { key: keyof ReturnType<typeof scoreCells>; label: ReactNode; title: string }[] = [
  { key: 'runs', label: 'Runs', title: 'Requests that reached fal' },
  { key: 'used', label: 'Used', title: 'Share of takes placed in a video' },
  { key: 'kept', label: 'Kept', title: 'Share of takes still kept' },
  {
    key: 'thumbs',
    label: (
      <span className="gen-board-thumbs">
        <Icon name="thumbsUp" size={12} />
        <Icon name="thumbsDown" size={12} />
      </span>
    ),
    title: 'Thumbs up / thumbs down',
  },
  { key: 'matched', label: 'Matched', title: 'Share of checked outputs that matched the request' },
  { key: 'perKept', label: 'Per kept', title: 'What was spent for each take kept' },
  { key: 'time', label: 'Time', title: 'Median time from request to done' },
  { key: 'failed', label: 'Failed', title: 'Share of runs that failed' },
];

interface ModelsViewProps {
  board: GenerationScoreboard;
  /** The routes, to mark each job's current default; null until they load. */
  routes: GenerationModelsResponse | null;
  policy: RoutePolicy;
  /** suggestionKey()s dismissed (settings.dismissedSuggestions): the server leaves them out too; kept out here while a save settles. */
  dismissed: readonly string[];
  /** The job whose default or dismissal is being saved. */
  busy: JobKind | null;
  error: string | null;
  onSetDefault: (job: JobKind, model: string | null) => void;
  onDismiss: (s: RouteSuggestion) => void;
}

/**
 * Suggestions as cards (Make default, Dismiss), then a table per job kind
 * that has runs: each model's runs, use and keep rates, thumbs, match rate,
 * cost per kept take, median time and failure rate. Too few runs to trust
 * reads grey; the job's default and your own default are marked.
 */
export function ModelsView({ board, routes, policy, dismissed, busy, error, onSetDefault, onDismiss }: ModelsViewProps) {
  const route = (job: JobKind) => routes?.jobs.find((j) => j.job === job);
  const jobLabel = (job: JobKind) => route(job)?.label ?? JOB_LABELS[job];
  const modelLabel = (job: JobKind, id: string) => board.rows.find((r) => r.job === job && r.model === id)?.modelLabel ?? route(job)?.models.find((m) => m.id === id)?.label ?? id;
  const suggestions = board.suggestions.filter((s) => !dismissed.includes(suggestionKey(s)));
  const jobs = JOB_KINDS.filter((j) => board.rows.some((r) => r.job === j && r.runs > 0));
  return (
    <div className="gen-models" data-testid="generation-models">
      {suggestions.length > 0 && (
        <div className="gen-suggestions">
          {suggestions.map((s) => (
            <div key={suggestionKey(s)} className="gen-suggestion" data-testid={`generation-suggestion-${s.job}`}>
              <div className="gen-key-text">
                <span className="gen-key-name">
                  {jobLabel(s.job)}: {modelLabel(s.job, s.to)}
                  <span className="set-meta"> · {s.kind === 'cheaper' ? 'as good, for less' : 'better, for no more'}</span>
                </span>
                <span className="set-note">{s.reason}</span>
              </div>
              <div className="gen-key-actions">
                <button className="mini-btn" disabled={busy === s.job} data-testid={`generation-suggestion-accept-${s.job}`} title={`Use ${modelLabel(s.job, s.to)} by default for ${jobLabel(s.job).toLowerCase()}`} onClick={() => onSetDefault(s.job, s.to)}>
                  {busy === s.job ? 'Saving…' : 'Make default'}
                </button>
                <button className="mini-btn" disabled={busy === s.job} data-testid={`generation-suggestion-dismiss-${s.job}`} title="Hide this suggestion; Balanced stops following it" onClick={() => onDismiss(s)}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      <p className="set-note" data-testid="generation-models-policy-note">
        Balanced follows suggestions automatically; Quality first only after you accept one.
      </p>
      <FieldError message={error} />
      {jobs.length === 0 ? (
        <p className="set-note" data-testid="generation-models-empty">
          No generations yet. As you generate and use takes, this fills in.
        </p>
      ) : (
        <table className="gen-board" data-testid="generation-scoreboard">
          <thead>
            <tr>
              <th scope="col">Model</th>
              {COLUMNS.map((c) => (
                <th key={c.key} scope="col" title={c.title} aria-label={c.key === 'thumbs' ? c.title : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          {jobs.map((job) => {
            const rows = board.rows.filter((r) => r.job === job && r.runs > 0).sort((a, b) => b.runs - a.runs);
            const mine = board.overrides[job];
            const current = route(job)?.defaults[policy];
            return (
              <tbody key={job} data-testid={`generation-board-${job}`}>
                <tr className="gen-board-job">
                  <th scope="colgroup" colSpan={COLUMNS.length + 1}>
                    <span className="gen-board-job-name">{jobLabel(job)}</span>
                    {mine && (
                      <button className="mini-btn" disabled={busy === job} data-testid={`generation-board-reset-${job}`} title={`Stop using ${modelLabel(job, mine)} by default`} onClick={() => onSetDefault(job, null)}>
                        {busy === job ? 'Saving…' : 'Reset to the route’s default'}
                      </button>
                    )}
                  </th>
                </tr>
                {rows.map((r) => {
                  const cells = scoreCells(r);
                  return (
                    <tr key={r.model} className={r.smallSample ? 'small' : undefined} data-testid={`generation-board-row-${job}-${r.model}`}>
                      <th scope="row">
                        <span className="gen-board-model" title={r.modelLabel}>
                          {r.modelLabel}
                        </span>
                        {r.model === mine ? <span className="gen-board-tag mine">your default</span> : r.model === current ? <span className="gen-board-tag">default</span> : null}
                        {r.smallSample && <span className="gen-board-small">fewer than {board.threshold} runs</span>}
                      </th>
                      {COLUMNS.map((c) => (
                        <td key={c.key}>{cells[c.key]}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            );
          })}
        </table>
      )}
    </div>
  );
}
