// The Assets library's Generated filter, as a list: generated takes grouped by
// request (provider, prompt, model, cost, Use this take / More like this),
// newest request first (or oldest), narrowed by the library's search. A take's
// thumbnail shows it larger on hover and drags into the Generate composer.
// Takes from the generation studio (request 'gjob_…') also carry a thumbs
// up / thumbs down rating beside "Not placed" and report auditions, so
// routing can learn which models do well; their More like this reopens the
// Generate tab with the same request. A narration take is one scene's line:
// Use this take works within that scene, and More like this asks for that
// line again.

import { useEffect, useMemo, useRef, useState } from 'react';
import { videoPreviewSrc } from '../composition/previewProxies';
import { excerpt } from '../core/generation';
import { JOB_KINDS, type JobKind, type JobSettings, type OutcomeEvent } from '../core/generationStudio';
import { resolveAssetUrl } from '../core/timing';
import type { Asset } from '../core/types';
import { api, errorText } from './api';
import { startAssetDrag } from './assetDrag';
import { AudioPlayButton, usePreviewing } from './AudioPreview';
import { modeOf, openGenerate, takeSceneOf } from './generateStore';
import { Icon } from './icons';
import { peekProps } from './Peek';
import { proposeAsTake } from './scoring';
import { useEditor } from './store';
import { ALREADY_PLACED, groupTakes, moreLikeThisPrompt, moreLikeThisSettings, narrationSceneOf, planUseTake, takeAlreadyPlaced, takeChoices, takeLength, takeUsage, useChatDraft, type TakeGroup } from './takes';

/** A generation studio job's takes (the server sets provenance.requestId to the job id). */
const isStudio = (group: TakeGroup) => group.key.startsWith('gjob_');

function applyTake(group: TakeGroup, take: Asset) {
  const st = useEditor.getState();
  // Music made for one scene (Generate music for this scene) goes there, whatever is selected now.
  const forScene = takeSceneOf(group.key);
  const sceneId = forScene && st.doc.project.scenes.some((s) => s.id === forScene) ? forScene : st.selection.sceneId;
  const plan = planUseTake(st.doc.project, group, take.id, sceneId);
  if (plan.kind === 'none') return st.toast({ tone: 'info', message: plan.message });
  // The person's own, like a pasted patch (pictures and sound alike), worded as a take: the review renders it and nothing changes until Apply.
  proposeAsTake(plan.patch, plan.note);
}

/** The studio request a take came from, read back from its provenance; null when it doesn't say (an older take). */
function studioRequest(take: Asset): { job: JobKind; model: string | null; settings: JobSettings } | null {
  const refs = take.provenance?.providerRefs;
  const job = refs?.job as JobKind | undefined;
  if (!job || !JOB_KINDS.includes(job)) return null;
  let settings: JobSettings = {};
  try {
    const parsed: unknown = refs?.settings ? JSON.parse(refs.settings) : {};
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) settings = parsed as JobSettings;
  } catch {
    // Unreadable settings: the Generate tab's defaults.
  }
  return { job, model: refs?.modelId || null, settings };
}

/** More like this: a studio take reopens the Generate tab with its request; any other asks the agent in the chat. */
function askForMore(group: TakeGroup, take: Asset) {
  const request = isStudio(group) ? studioRequest(take) : null;
  if (!request) return useChatDraft.setState({ draft: moreLikeThisPrompt(group, take) });
  // Fresh: exactly that request's settings (frames, keyframes, references included) over the job's defaults, nothing left from the current draft;
  // a narration line's take asks for that line only.
  openGenerate({ mode: modeOf(request.job), job: request.job, prompt: take.provenance?.prompt ?? group.prompt ?? '', model: request.model, takes: 2, regenerateOf: group.key, ...moreLikeThisSettings(request.settings, take) }, true);
}

/** Each take's audition is reported once per session. */
const auditioned = new Set<string>();
function reportAudition(jobId: string, assetId: string) {
  const key = `${jobId}\n${assetId}`;
  if (auditioned.has(key)) return;
  auditioned.add(key);
  void api.reportOutcome({ jobId, assetId, event: 'auditioned' }).catch(() => undefined);
}

/** Thumbs up is 1, thumbs down -1, 0 is cleared here (so a late load does not bring back a rating the person just cleared). */
type Thumb = 1 | -1 | 0;

/** The studio takes' ratings: loaded once per set of jobs, set optimistically, put back with a toast if the server refuses. */
function useThumbs(jobIds: string[]) {
  const [thumbs, setThumbs] = useState<Record<string, Thumb>>({});
  const key = jobIds.join(',');
  useEffect(() => {
    if (!key) return;
    let live = true;
    api.generationThumbs(key.split(',')).then(
      (loaded) => live && setThumbs((now) => ({ ...loaded, ...now })),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [key]);
  const rate = (jobId: string, assetId: string, value: 1 | -1) => {
    const before = thumbs[assetId] ?? 0;
    const next: Thumb = before === value ? 0 : value;
    const event: OutcomeEvent = next === 1 ? 'thumbsUp' : next === -1 ? 'thumbsDown' : 'thumbCleared';
    setThumbs((now) => ({ ...now, [assetId]: next }));
    api.reportOutcome({ jobId, assetId, event }).catch((e) => {
      setThumbs((now) => ({ ...now, [assetId]: before }));
      useEditor.getState().toast({ tone: 'error', message: 'Could not save your rating', hint: errorText(e).message });
    });
  };
  return { thumbs, rate };
}

function Thumbs({ group, take, value, rate }: { group: TakeGroup; take: Asset; value: Thumb; rate: (jobId: string, assetId: string, value: 1 | -1) => void }) {
  return (
    <span className="take-thumbs" role="group" aria-label={`Rate ${take.name}`}>
      <button type="button" className={`mini-btn icon-only take-rate ${value === 1 ? 'on' : ''}`} aria-pressed={value === 1} aria-label="Good take" title={value === 1 ? 'Good take (click to clear)' : 'Good take'} data-testid={`take-up-${take.id}`} onClick={() => rate(group.key, take.id, 1)}>
        <Icon name="thumbsUp" size={14} />
      </button>
      <button type="button" className={`mini-btn icon-only take-rate ${value === -1 ? 'on' : ''}`} aria-pressed={value === -1} aria-label="Not this one" title={value === -1 ? 'Not this one (click to clear)' : 'Not this one'} data-testid={`take-down-${take.id}`} onClick={() => rate(group.key, take.id, -1)}>
        <Icon name="thumbsDown" size={14} />
      </button>
    </span>
  );
}

const previewSrc = (asset: Asset) => resolveAssetUrl('/', videoPreviewSrc(asset, false));

/** The take's thumbnail: audio plays in place; a picture shows larger on hover, opens under the take on click, and drags into Generate. */
function TakeThumb({ asset, open, onToggle }: { asset: Asset; open: boolean; onToggle: () => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  if (asset.kind === 'audio') {
    return (
      <span className="take-thumb audio">
        <AudioPlayButton src={asset.src} name={asset.name} testId={`take-play-${asset.id}`} />
      </span>
    );
  }
  const src = previewSrc(asset);
  const video = asset.kind === 'video';
  return (
    <button ref={ref} type="button" className={`take-thumb${video ? ' video' : ''} ${open ? 'open' : ''}`} aria-expanded={open} aria-label={open ? `Hide the larger view of ${asset.name}` : `${video ? 'Play' : 'Show'} ${asset.name} larger`} data-testid={`take-thumb-${asset.id}`} draggable onDragStart={(e) => startAssetDrag(e, asset, ref.current)} onClick={onToggle} {...peekProps(asset)}>
      {video ? (
        <>
          {/* A poster half a second in (the first frame is often black), as the asset list shows clips. */}
          <video src={`${src}#t=0.5`} muted playsInline preload="metadata" />
          <span className="asset-thumb-play" aria-hidden>
            <Icon name="play" size={9} />
          </span>
        </>
      ) : (
        <img src={src} alt="" loading="lazy" decoding="async" draggable={false} />
      )}
    </button>
  );
}

function TakeLarge({ asset }: { asset: Asset }) {
  const src = previewSrc(asset);
  return <div className="take-large">{asset.kind === 'video' ? <video src={src} controls muted playsInline preload="metadata" aria-label={asset.name} /> : <img src={src} alt={asset.name} decoding="async" />}</div>;
}

/** A request matches the search when every word is in its prompt, model, provider or a take's name. */
function groupMatches(g: TakeGroup, query: string): boolean {
  const hay = `${g.prompt ?? ''} ${g.model ?? ''} ${g.provider ?? ''} ${g.takes.map((t) => t.name).join(' ')}`.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}

export function TakesPanel({ query = '', order = 'newest' }: { query?: string; order?: 'newest' | 'oldest' }) {
  const project = useEditor((s) => s.doc.project);
  const all = useMemo(() => groupTakes(project), [project]);
  const groups = useMemo(() => {
    const shown = all.filter((g) => groupMatches(g, query));
    return order === 'oldest' ? shown.reverse() : shown;
  }, [all, query, order]);
  const usage = useMemo(() => takeUsage(project), [project]);
  const studioJobs = useMemo(() => groups.filter(isStudio).map((g) => g.key).sort(), [groups]);
  const { thumbs, rate } = useThumbs(studioJobs);
  const [large, setLarge] = useState<string | null>(null);

  // A studio audio take starting to play (here or anywhere else in the editor) is an audition.
  const previewing = usePreviewing();
  useEffect(() => {
    if (!previewing) return;
    for (const g of groups) if (isStudio(g)) for (const t of g.takes) if (t.kind === 'audio' && t.src === previewing) reportAudition(g.key, t.id);
  }, [previewing, groups]);

  const toggleLarge = (group: TakeGroup, take: Asset) => {
    const opening = large !== take.id;
    setLarge(opening ? take.id : null);
    if (opening && isStudio(group)) reportAudition(group.key, take.id);
  };

  return (
    <div className="takes-panel" data-testid="takes-panel">
      {groups.length === 0 ? (
        <p className="lib-empty">{all.length && query ? `No request matches “${query}”.` : 'Takes you or an agent generate appear here, grouped by request, for you to pick.'}</p>
      ) : (
        <ul className="take-groups">
          {groups.map((g) => (
            <li key={g.key} className="take-group" data-testid={`take-group-${g.key}`}>
              <div className="take-group-head">
                <span className="take-provider">{g.provider || 'Generated'}</span>
                {g.model && <span className="take-model">{g.model}</span>}
              </div>
              {g.prompt && <p className="take-prompt" title={g.prompt}>“{excerpt(g.prompt, 180)}”</p>}
              {g.cost && <p className="take-cost">{g.cost}</p>}
              <ul className="take-list">
                {g.takes.map((t, i) => {
                  const used = usage.get(t.id) ?? 0;
                  // A narration line counts only its own takes, and goes in its own scene.
                  const line = narrationSceneOf(t);
                  const lineScene = line ? (project.scenes.find((s) => s.id === line)?.name ?? 'its scene') : null;
                  const placed = takeAlreadyPlaced(takeChoices(g, t), t.id, usage);
                  const studio = isStudio(g);
                  const useTitle = t.reference
                    ? 'A reference steers generation and is never placed in the video'
                    : placed
                      ? ALREADY_PLACED
                      : lineScene
                        ? `Propose this take as the narration in “${lineScene}”, in place of another take of the line`
                        : used
                          ? 'Switch every place another take of this request is used to this one'
                          : 'Propose this take in every place another take of this request is used, or add it to the current scene';
                  const moreTitle = studio && studioRequest(t) ? (lineScene ? `Open Generate with this line for “${lineScene}”, for two more takes` : 'Open Generate with this request’s prompt, model and settings, for two more takes') : 'Write a chat message asking for more takes like this one';
                  return (
                    <li key={t.id} className={`take ${used ? 'in-use' : ''}`} data-testid={`take-${t.id}`}>
                      <TakeThumb asset={t} open={large === t.id} onToggle={() => toggleLarge(g, t)} />
                      <div className="take-meta">
                        <span className="take-name" title={t.name}>Take {i + 1} · {t.name}</span>
                        <div className="take-status">
                          <span className="fine">
                            {takeLength(t, project.fps)}
                            {used ? `In use ×${used}` : 'Not placed'}
                            {t.provenance?.seed !== undefined ? ` · seed ${t.provenance.seed}` : ''}
                          </span>
                          {studio && <Thumbs group={g} take={t} value={thumbs[t.id] ?? 0} rate={rate} />}
                        </div>
                      </div>
                      <div className="take-actions">
                        <button className="mini-btn" disabled={!!t.reference || placed} data-testid={`take-use-${t.id}`} onClick={() => applyTake(g, t)} title={useTitle}>
                          {placed ? ALREADY_PLACED : 'Use this take'}
                        </button>
                        <button className="mini-btn" data-testid={`take-more-${t.id}`} onClick={() => askForMore(g, t)} title={moreTitle}>
                          More like this
                        </button>
                      </div>
                      {large === t.id && t.kind !== 'audio' && <TakeLarge asset={t} />}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
