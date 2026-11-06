// What the Export popover holds (ExportPopover.tsx opens it from the header):
// the delivery preset and what it resolves to, Export video and its render's
// progress, a still or a thumbnail of the current frame, and Advanced (the
// preset's codecs, the snapshot, a failure switch for verification). Renders
// go through the local server from a snapshot of the document; nothing here
// ever changes the document. The job's state lives in useExportJob, which the
// header keeps mounted, so a running render keeps polling with the popover
// closed.

import { useEffect, useRef, useState } from 'react';
import type { DeliveryPreset, ExportStillResponse, RenderJob, StillPreset } from '../core/api-contract';
import { DELIVERY_PRESETS, deliveryDimensions, deliverySettings } from '../core/delivery';
import { api, ApiRequestError, errorText, ServerDownError, SERVER_DOWN_MESSAGE } from './api';
import { Icon } from './icons';
import { useEditor } from './store';

const STAGE: Record<RenderJob['status'], string> = {
  queued: 'Queued',
  bundling: 'Bundling composition',
  rendering: 'Rendering frames',
  encoding: 'Encoding output',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
};

/** A render still on its way: the popover shows its progress and the header button a ring. */
export const isRendering = (j: RenderJob | null) => !!j && ['queued', 'bundling', 'rendering', 'encoding'].includes(j.status);

const FAILED: RenderJob['status'][] = ['failed', 'cancelled', 'interrupted'];

const LOST_MESSAGE = 'The server restarted and lost this render — export again';

const isNotFound = (e: unknown) => e instanceof ApiRequestError && e.status === 404;

/** The codecs behind each family of presets (server/engine): video, audio. */
const CODECS = { h264: ['H.264', 'AAC'], vp9: ['VP9', 'Opus'], prores: ['ProRes 4444', 'PCM'], gif: ['GIF', 'None'] } as const;

export interface PresetSpec {
  width: number;
  height: number;
  fps: number;
  /** The file's format: MP4, WebM, MOV, GIF. */
  container: string;
  video: string;
  audio: string;
  everyNthFrame: number;
  scale: number;
}

/** What a preset renders for this project (the server's own rules, core/delivery.ts), or why it can't. */
export function presetSpec(preset: DeliveryPreset, project: { width: number; height: number; fps: number }): { ok: true; spec: PresetSpec } | { ok: false; reason: string } {
  try {
    const { codec, scale, everyNthFrame, extension } = deliverySettings(preset, project.height);
    const { width, height } = deliveryDimensions(preset, project.width, project.height);
    const [video, audio] = CODECS[codec];
    return { ok: true, spec: { width, height, fps: project.fps / everyNthFrame, container: extension === 'mov' ? 'MOV' : extension === 'webm' ? 'WebM' : extension.toUpperCase(), video, audio, everyNthFrame, scale } };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

const num = (n: number) => String(Math.round(n * 100) / 100);

/** The resolved line under the preset, in mono: `1280×720 · 30 fps · MP4`. */
export const specLine = (s: PresetSpec) => `${s.width}×${s.height} · ${num(s.fps)} fps · ${s.container}`;

/** The server's reasons come without a full stop; another sentence follows them. */
const sentence = (t: string) => (/[.!?…]$/.test(t.trim()) ? t.trim() : `${t.trim()}.`);

/** The download button's file type, from the preset the job rendered. */
const fileKind = (preset: DeliveryPreset | undefined) => (preset === 'gif-480' ? 'GIF' : preset === 'prores-1080' ? 'MOV' : preset === 'webm-1080' ? 'WebM' : 'MP4');

/**
 * The render job and the latest still, with what starts, cancels and retries
 * them. Called once, by the header's Export button (ExportPopover.tsx), which
 * is always mounted: the job keeps polling whether or not the popover is open,
 * and the preset, a finished render and a still are still there when it
 * opens again.
 */
export function useExportJob() {
  const [job, setJob] = useState<RenderJob | null>(null);
  /**
   * Set when polling can no longer follow the job (the server forgot it, or
   * answered with an error). The job is then shown as failed locally and Retry
   * starts a fresh render instead of asking the server to retry an unknown job.
   */
  const [lost, setLost] = useState<string | null>(null);
  const [error, setError] = useState<{ message: string; hint?: string } | null>(null);
  const [preset, setPreset] = useState<DeliveryPreset>('mp4-1080');
  const [still, setStill] = useState<ExportStillResponse | null>(null);
  const [stillBusy, setStillBusy] = useState(false);
  const [simulate, setSimulate] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [starting, setStarting] = useState(false);
  const jobId = useRef<string | null>(null);

  const shown: RenderJob | null = job && lost ? { ...job, status: 'failed', error: lost } : job;

  useEffect(() => {
    if (!isRendering(job) || lost) return;
    const t = setInterval(async () => {
      setNow(Date.now());
      const id = jobId.current;
      if (!id) return;
      try {
        const j = await api.getRender(id);
        if (jobId.current !== id) return;
        setJob(j);
        setError(null);
      } catch (e) {
        if (jobId.current !== id) return;
        if (e instanceof ServerDownError) {
          // Keep polling: either the render is still running, or the restarted server answers 404 next.
          setError({ message: SERVER_DOWN_MESSAGE, hint: 'The render may still be running; polling resumes when the server answers.' });
        } else if (isNotFound(e)) {
          setError(null);
          setLost(LOST_MESSAGE);
        } else {
          setError(null);
          setLost(`Could not get the render status: ${errorText(e).message}`);
        }
      }
    }, 500);
    return () => clearInterval(t);
  }, [job?.id, job?.status, lost]);

  const start = async () => {
    setError(null);
    setLost(null);
    setStarting(true);
    try {
      const project = useEditor.getState().doc.project;
      const j = await api.startRender({ project, preset, ...(simulate ? { simulateFailureAtProgress: 0.3 } : {}) });
      jobId.current = j.id;
      setJob(j);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setStarting(false);
    }
  };

  const retry = async () => {
    if (!job) return;
    // The server no longer knows this job: render the current project afresh.
    if (lost) return start();
    setError(null);
    try {
      const j = await api.retryRender(job.id);
      jobId.current = j.id;
      setJob(j);
    } catch (e) {
      if (isNotFound(e)) return start();
      setError(errorText(e));
    }
  };

  const cancel = async () => {
    if (!job) return;
    setError(null);
    try {
      const cancelled = await api.cancelRender(job.id);
      if (jobId.current === cancelled.id) setJob(cancelled);
    } catch (e) {
      setError(errorText(e));
    }
  };

  const exportStill = async (stillPreset: StillPreset) => {
    setStillBusy(true); setError(null); setStill(null);
    const { doc, playhead } = useEditor.getState();
    try { setStill(await api.exportStill({ project: doc.project, frame: playhead, preset: stillPreset })); }
    catch (e) { setError(errorText(e)); }
    finally { setStillBusy(false); }
  };

  const elapsed = shown ? Math.max(0, ((shown.finishedAt ? Date.parse(shown.finishedAt) : now) - Date.parse(shown.createdAt)) / 1000) : 0;
  const pct = shown ? Math.round(shown.progress * 100) : 0;

  return { shown, error, preset, setPreset, still, stillBusy, simulate, setSimulate, starting, elapsed, pct, start, retry, cancel, exportStill };
}

export type ExportJob = ReturnType<typeof useExportJob>;

/** The running, finished or failed render: where Export video was while it runs, under it once it ends. */
function JobCard({ job }: { job: ExportJob }) {
  const { shown, elapsed, pct } = job;
  if (!shown) return null;
  const running = isRendering(shown);
  const failed = FAILED.includes(shown.status);
  const done = shown.status === 'done' && !!shown.outputUrl;
  const status = (
    <div className="status-line">
      <span className={`status-dot ${shown.status}`} aria-hidden />
      <strong>{shown.status === 'done' ? 'Ready to download' : STAGE[shown.status]}</strong>
      <span className="mono export-meta">{running ? `${pct}%` : `${elapsed.toFixed(1)} s`}</span>
    </div>
  );
  // A small tile of the result that plays it in a new tab (a browser can't play ProRes: none for MOV).
  const preview = shown.preset === 'gif-480' ? <img src={shown.outputUrl} alt="" /> : shown.preset !== 'prores-1080' ? <video src={shown.outputUrl} muted preload="metadata" data-testid="export-video" /> : null;
  return (
    <div className="export-job" data-testid="export-status" data-status={shown.status} title={`${shown.id} · revision r${shown.projectRevision}`}>
      {done ? (
        <div className="export-done" data-testid="export-done">
          {preview && (
            <a className="export-thumb" href={shown.outputUrl} target="_blank" rel="noreferrer" title="Play it in a new tab" aria-label={`Play the ${fileKind(shown.preset)} in a new tab`}>
              {preview}
              <span className="export-thumb-play" aria-hidden>
                <Icon name="play" size={10} />
              </span>
            </a>
          )}
          <div className="export-done-main">
            {status}
            <a className="btn small export-download" href={shown.outputUrl} download data-testid="export-download">
              <Icon name="download" size={13} />
              Download {fileKind(shown.preset)}
            </a>
          </div>
        </div>
      ) : (
        status
      )}
      {running && (
        <>
          <div className="progress" role="progressbar" aria-label="Render progress" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
            <div className={`progress-fill ${shown.status}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="export-job-foot">
            <span className="mono export-meta">
              {shown.renderedFrames}/{shown.totalFrames} f · {elapsed.toFixed(1)} s
            </span>
            <button className="btn small" onClick={job.cancel} data-testid="export-cancel">
              Cancel
            </button>
          </div>
          <p className="export-note">You can keep editing while it renders.</p>
        </>
      )}
      {failed && (
        <div className="export-failure" data-testid="export-failure">
          <p className="export-note">{sentence(shown.error ?? (shown.status === 'cancelled' ? 'Render cancelled' : 'Unknown error'))} Your document was not changed.</p>
          <button className="btn small" data-testid="export-retry" onClick={job.retry}>
            <Icon name="rotateCcw" size={13} />
            Retry
          </button>
        </div>
      )}
      {done && (
        <div className="export-provenance">
          {(shown.projectHash || shown.manifestUrl) && (
            <div className="export-provenance-row">
              {shown.projectHash && (
                <span className="mono export-meta">
                  r{shown.projectRevision} · {shown.projectHash.slice(0, 8)} · {shown.rendererVersion}
                </span>
              )}
              {shown.manifestUrl && (
                <a className="link export-manifest" href={shown.manifestUrl} target="_blank" rel="noreferrer" data-testid="export-manifest">
                  Manifest
                </a>
              )}
            </div>
          )}
          {shown.outputPath && (
            <div className="mono export-meta export-path" title={shown.outputPath}>
              {shown.outputPath}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The popover's contents, top to bottom: Preset, Export video (or its render), the current frame's still and thumbnail, Advanced. */
export function ExportPanel({ job }: { job: ExportJob }) {
  const server = useEditor((s) => s.server);
  const revision = useEditor((s) => s.doc.project.revision);
  const width = useEditor((s) => s.doc.project.width);
  const height = useEditor((s) => s.doc.project.height);
  const fps = useEditor((s) => s.doc.project.fps);
  const playhead = useEditor((s) => s.playhead);
  const { shown, error, preset, still, stillBusy, starting } = job;
  const running = isRendering(shown);
  const resolved = presetSpec(preset, { width, height, fps });
  const spec = resolved.ok ? resolved.spec : null;
  // The server's thumbnail is a quarter of the project's size (server/app.ts).
  const thumb = `${Math.round(width / 4)}×${Math.round(height / 4)}`;

  return (
    <div className="export-body" data-testid="export-panel">
      {server === 'down' && (
        <div className="notice warn" data-testid="server-down">
          <strong>{SERVER_DOWN_MESSAGE}.</strong>
          <div className="fine">Export, Save and uploads need it. Editing, undo, preview and JSON export keep working.</div>
        </div>
      )}
      <div className="export-part">
        <label className="export-label" htmlFor="export-preset">
          Preset
        </label>
        <select id="export-preset" className="input select" data-testid="export-preset" value={preset} onChange={(e) => job.setPreset(e.target.value as DeliveryPreset)} disabled={starting || running}>
          {DELIVERY_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
        <div className={`mono export-spec ${spec ? '' : 'warn-text'}`} data-testid="export-spec">
          {spec ? specLine(spec) : `${resolved.ok ? '' : resolved.reason} Pick another preset.`}
        </div>
        {running ? (
          <JobCard job={job} />
        ) : (
          <>
            <button className="btn primary export-go" data-testid="export-start" disabled={starting || !spec} onClick={job.start}>
              {starting ? 'Starting…' : 'Export video'}
            </button>
            <JobCard job={job} />
          </>
        )}
        {error && (
          <div className="notice error" data-testid="export-error">
            <div className="notice-title">{error.message}</div>
            {error.hint && <div className="fine">{error.hint}</div>}
          </div>
        )}
      </div>

      <div className="export-part">
        <div className="export-label-row">
          <span className="export-label">Current frame</span>
          <span className="mono export-meta">f {playhead}</span>
        </div>
        <div className="export-stills">
          <button className="btn" data-testid="export-still" disabled={stillBusy} onClick={() => void job.exportStill('png-full')} title={`A PNG of frame ${playhead} at the project’s size`}>
            Still <span className="mono export-btn-spec">{width}×{height}</span>
          </button>
          <button className="btn" data-testid="export-thumbnail" disabled={stillBusy} onClick={() => void job.exportStill('jpeg-thumb')} title={`A JPEG of frame ${playhead} at a quarter of the project’s size`}>
            Thumbnail <span className="mono export-btn-spec">{thumb}</span>
          </button>
        </div>
        {stillBusy && <p className="export-note">Rendering the frame…</p>}
        {still && (
          <a className="btn small export-still-link" href={still.url} download data-testid="export-still-download">
            <Icon name="download" size={13} />
            Download {still.url.endsWith('.jpg') ? 'thumbnail' : 'still'} · <span className="mono">{still.width}×{still.height}</span>
          </a>
        )}
      </div>

      <details className="export-advanced" data-testid="export-advanced">
        <summary>
          <Icon name="right" size={12} />
          Advanced
        </summary>
        <div className="export-advanced-body">
          <dl className="export-specs">
            <dt>Video</dt>
            <dd>{spec?.video ?? '—'}</dd>
            <dt>Audio</dt>
            <dd>{spec?.audio ?? '—'}</dd>
            <dt>Frames</dt>
            <dd>{!spec ? '—' : spec.everyNthFrame === 1 ? 'Every frame' : `Every ${spec.everyNthFrame === 2 ? 'second' : `${spec.everyNthFrame}th`} frame`}</dd>
            <dt>Project</dt>
            <dd className="mono">
              {width}×{height} · {num(fps)} fps
            </dd>
            <dt>Scale</dt>
            <dd className="mono">{spec ? `${num(spec.scale)}×` : '—'}</dd>
            <dt>Snapshot</dt>
            <dd>
              Revision <span className="mono">r{revision}</span>
            </dd>
          </dl>
          <p className="export-note">Export renders the document as it is when you start; later edits are not in it. 2160p scales the project up by at most 3×.</p>
          <label className="check">
            <input type="checkbox" className="toggle" checked={job.simulate} onChange={(e) => job.setSimulate(e.target.checked)} disabled={starting || running} data-testid="export-simulate-failure" />
            <span>Simulate failure at 30% (verification)</span>
          </label>
        </div>
      </details>
    </div>
  );
}
