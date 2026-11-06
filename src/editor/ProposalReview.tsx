// Proposal review: owns the stage while open (the header row, Current and
// Proposed plates side by side with the change list, and the transport row
// under them), so the user can see, play and compare a proposed edit before
// it lands. The current document and the candidate are
// rendered by the same MainComposition, with the same asset base, as normal
// playback and export, read-only (no selection or handles). Both players show
// ONE shared frame: the proposed player drives playback, the current one
// follows it frame by frame, and the editor's playhead (and so its timeline)
// mirrors the review while it is open.
//
// Sound follows the view: the driving player plays the pictures of the
// proposal with the audio of whichever version you are hearing (Current,
// Proposed, or the "Hear" switch in Side by side); the following player is
// always muted. Swapping only the soundtrack keeps the one shared clock, so
// time alignment does not change. The soundtrack is the WHOLE soundtrack:
// audio clips and every video element's own sound (in groups and reusable
// components too). Hearing the other version, the pictures play with all of
// their sound silenced and a hidden, sound-only copy of the heard version
// plays under them.

import { Player, type PlayerRef } from '../runtime';
import React, { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { FullFrame } from '../runtime';
import { MainComposition } from '../composition/MainComposition';
import type { MainCompositionProps } from '../composition/types';
import type { ProposalSummary } from '../core/api-contract';
import { affectedRange, describeAudioChanges, describeProposal, listNames, targetName, type FrameRange, type Proposal, type ProposalCheck, type TargetRef } from '../core/proposal';
import { formatTimecode, projectDurationInFrames, sceneStartFrame, sceneStartFrames } from '../core/timing';
import type { ChangeEntry, Element, Project, TouchedRef } from '../core/types';
import { modelLabel, providerLabel, sendChat, useChat } from './chat';
import { requestComposerFocus } from './createFlow';
import { isTyping } from './editActions';
import { Icon } from './icons';
import { registerPlayer, togglePlayback } from './playback';
import { byYou, PASTED_BY, TAKE_BY, useProposals, whose, type ReviewView } from './proposals';
import { focusFrame } from './simpleTimelineEdits';
import { useEditor } from './store';
import { useChatDraft } from './takes';
import './review.css';

type Ready = Extract<ProposalCheck, { status: 'ready' }>;
type NotReady = Exclude<ProposalCheck, { status: 'ready' }>;

/** The A/B key: flips between Current and Proposed. */
const FLIP_KEY = '\\';

const VIEWS: { id: ReviewView; label: string }[] = [
  { id: 'current', label: 'Current' },
  { id: 'proposed', label: 'Proposed' },
  { id: 'split', label: 'Side by side' },
];

/** Agent and model as people know them ("Codex", "GPT-5.5"), when the chat knows that agent. */
function useCredit(p: Proposal): { agent: string; model: string | null } {
  const providers = useChat((s) => s.providers);
  if (p.agent === PASTED_BY) return { agent: 'Pasted patch', model: null };
  if (p.agent === TAKE_BY) return { agent: 'Generated take', model: null };
  const provider = providers.find((x) => x.label === p.agent);
  return { agent: p.agent, model: p.model ? (provider ? modelLabel(providers, provider.id, p.model) : p.model) : null };
}

const replacedNote = (r: ProposalSummary) => `Replaced ${r.agent === PASTED_BY ? 'your earlier pasted patch' : r.agent === TAKE_BY ? 'your earlier generated take' : `${r.agent}’s earlier proposal`}`;

/** The person's own proposal, in the header's words and its tooltip. */
const ownWords = (agent: string) => (agent === TAKE_BY ? { from: 'your generated take', did: 'You chose this take in Assets › Generated' } : { from: 'your pasted patch', did: 'You pasted it' });

/**
 * Where to look at a target in `project`: a little past its start, so an
 * entrance (a reveal, a fade, a transition) is under way rather than still
 * invisible on its first frame. Null when it is not in the project.
 */
function lookFrame(project: Project, ref: TargetRef): number | null {
  const start = sceneStartFrame(project, ref.sceneId);
  const scene = project.scenes.find((s) => s.id === ref.sceneId);
  if (start < 0 || !scene) return null;
  if (!ref.elementId) return start + Math.min(project.fps, Math.floor(scene.durationInFrames / 2));
  const el = scene.elements.find((e) => e.id === ref.elementId);
  return el ? Math.min(focusFrame(start, el, project.fps), start + scene.durationInFrames - 1) : null;
}

/**
 * The first frame to show: the playhead when it is already on the change
 * (past its very first frame, where entrances have not begun), otherwise the
 * earliest target, a little in.
 */
function firstFrame(playhead: number, candidate: Project, touched: TouchedRef[], range: FrameRange): number {
  if (playhead > range.start && playhead <= range.end) return playhead;
  const looks = touched.flatMap((t) => (t.kind === 'scene' || t.kind === 'element' ? [lookFrame(candidate, t)] : [])).filter((f): f is number => f !== null);
  const first = looks.length ? Math.min(...looks) : range.start + Math.min(candidate.fps, Math.floor((range.end - range.start) / 2));
  return Math.max(range.start, Math.min(first, range.end));
}

// ---------------------------------------------------------------------------
// Review surface
// ---------------------------------------------------------------------------

/** What the stage exposes to the review's keys and header. */
interface StageControls {
  step: (delta: number) => void;
  /** Show a changed scene or element. */
  look: (ref: TargetRef) => void;
  /** Go to a global frame (a changed audio clip's start). */
  showFrame: (frame: number) => void;
}

/** Which version you hear. */
type Audible = 'current' | 'proposed';

export function ProposalReview() {
  const proposal = useProposals((s) => s.proposal);
  const check = useProposals((s) => s.check);
  const controls = useRef<StageControls | null>(null);

  // The review's keys. The editor's own shortcuts stand down while it is open (App.tsx).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = useEditor.getState();
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey || st.openDialog || st.sheet) return;
      const proposals = useProposals.getState();
      switch (e.key) {
        case 'Escape':
          e.preventDefault();
          proposals.closeReview();
          return;
        case ' ':
          e.preventDefault();
          togglePlayback(e);
          return;
        case FLIP_KEY:
          e.preventDefault();
          proposals.setView(proposals.view === 'proposed' ? 'current' : 'proposed');
          return;
        case ',':
        case 'ArrowLeft':
          e.preventDefault();
          controls.current?.step(e.shiftKey ? -10 : -1);
          return;
        case '.':
        case 'ArrowRight':
          e.preventDefault();
          controls.current?.step(e.shiftKey ? 10 : 1);
          return;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!proposal || !check) return null;
  const ready = check.status === 'ready';
  // The review owns the stage (App.tsx gives the stage column a review grid): its
  // header row, the plates with the change list, and its transport row each take
  // a grid area of their own, so the section itself lays out nothing.
  return (
    <section className={`pr ${ready ? '' : 'is-stale'}`} data-testid="proposal-review" data-status={check.status} aria-label={`Review ${whose(proposal.agent)}: ${proposal.patch.summary}`}>
      <ReviewHeader proposal={proposal} check={check} />
      {ready ? <ReviewStage key={proposal.id} check={check} controls={controls} /> : <StaleNotice proposal={proposal} check={check} />}
    </section>
  );
}

/** "scene 2 of 3 · 18 s" for a change to one scene, "2 scenes" for more, nothing for project-wide changes. */
function whereLabel(candidate: Project, touched: TouchedRef[]): string | null {
  const ids = [...new Set(touched.flatMap((t) => (t.kind === 'scene' || t.kind === 'element' ? [t.sceneId] : [])))];
  if (ids.length === 0) return null;
  if (ids.length > 1) return `${ids.length} scenes`;
  const i = candidate.scenes.findIndex((s) => s.id === ids[0]);
  if (i < 0) return null;
  const secs = candidate.scenes[i].durationInFrames / candidate.fps;
  return `scene ${i + 1} of ${candidate.scenes.length} · ${Number.isInteger(secs) ? secs : secs.toFixed(1)} s`;
}

/** Ask the agent for a change to this proposal: the chat's composer, with the proposal named. */
function askForChange(proposal: Proposal) {
  useChatDraft.setState({ draft: `About your proposal “${proposal.patch.summary}”: ` });
  requestComposerFocus();
}

/** One row above the plates: what this is, whose, where, and the decision. */
function ReviewHeader({ proposal, check }: { proposal: Proposal; check: ProposalCheck }) {
  const revision = useEditor((s) => s.doc.project.revision);
  const credit = useCredit(proposal);
  const ready = check.status === 'ready' ? check : null;
  const base = proposal.patch.baseRevision;
  const where = useMemo(() => (ready ? whereLabel(ready.candidate, ready.touched) : null), [ready]);
  const { apply, cancel, closeReview } = useProposals.getState();
  const pasted = byYou(proposal.agent);
  const own = ownWords(proposal.agent);
  const from = pasted ? own.from : `from ${credit.agent}`;

  return (
    <header className="pr-head">
      <span className={`pr-eyebrow ${ready ? '' : 'stale'}`}>{ready ? 'Proposal' : 'Out of date'}</span>
      <h2 className="pr-title" title={proposal.patch.summary}>
        {proposal.patch.summary}
      </h2>
      <span
        className="pr-credit"
        data-testid="proposal-credit"
        title={`${pasted ? own.did : `${credit.agent}${credit.model ? ` (${credit.model})` : ''} proposed it`}, based on r${base}${ready && revision !== base ? `, rebased onto r${revision}` : ''}`}
      >
        <span className={`pr-dot ${pasted ? 'you' : ''}`} aria-hidden />
        <span className="pr-credit-text">{[from, where, ready && revision !== base ? `rebased onto r${revision}` : null].filter(Boolean).join(' · ')}</span>
      </span>
      <span className="pr-head-spacer" />
      {ready && (
        <>
          {!pasted && (
            <button className="btn ghost pr-ask" data-testid="proposal-ask" title={`Tell ${credit.agent} what to change in the chat; the proposal stays open`} onClick={() => askForChange(proposal)}>
              Ask for a change
            </button>
          )}
          <button className="btn" data-testid="proposal-cancel" title="Decline this proposal; nothing changes" onClick={cancel}>
            Decline
          </button>
          <button className="btn primary pr-apply" data-testid="proposal-apply" title={`Approve: apply it as one change you can undo (r${revision + 1})`} onClick={() => apply()}>
            <Icon name="check" size={14} />
            Approve
          </button>
        </>
      )}
      <button className="icon-btn pr-close" data-testid="proposal-back" aria-label="Close the review" title="Close the review; the proposal waits for you (Esc)" onClick={closeReview}>
        <Icon name="close" size={14} />
      </button>
    </header>
  );
}

// ---------------------------------------------------------------------------
// The change list beside the plates: one line per change, + added, ~ changed, − removed
// ---------------------------------------------------------------------------

const MARK: Record<ChangeEntry['change'], string> = { added: '+', modified: '~', moved: '~', removed: '−' };

function shortValue(v: unknown): string {
  if (v === undefined) return '—';
  const s = typeof v === 'string' ? `“${v}”` : JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

/** Field names as people say them. */
const FIELD: Record<string, string> = { startFrame: 'start', durationInFrames: 'length', backgroundColor: 'background', transitionIn: 'transition' };

/** `Scene "Intro" › Headline › props.text` → `Headline › text` (the scene is in the header row already). */
function changeLabel(c: ChangeEntry): string {
  const parts = c.label.split(' › ');
  const rest = parts[0]?.startsWith('Scene ') && parts.length > 1 ? parts.slice(1) : parts;
  return rest
    .map((p) => p.replace(/^(props|transform|tracks)\./, ''))
    .map((p) => FIELD[p] ?? p)
    .join(' › ');
}

function ChangePanel({ check, controls }: { check: Ready; controls: RefObject<StageControls | null> }) {
  const current = useEditor((s) => s.doc.project);
  const replaced = useProposals((s) => s.replaced);
  const [values, setValues] = useState(false);
  const desc = useMemo(() => describeProposal(check.diff, check.candidate), [check]);
  const audio = useMemo(() => describeAudioChanges(current, check.candidate), [check, current]);

  return (
    <aside className="pr-changes" aria-label="What changes">
      <div className="pr-changes-head">
        <span className="pr-headline" data-testid="proposal-headline">
          {desc.headline}
        </span>
        {check.diff.length > 0 && (
          <button className="pr-details-btn" aria-expanded={values} data-testid="proposal-details" onClick={() => setValues(!values)}>
            {values ? 'Hide values' : 'Show values'}
          </button>
        )}
      </div>
      {desc.targets.length > 0 && (
        <ul className="pr-targets" aria-label="Where">
          {desc.targets.map((t, i) => (
            <li key={t}>
              <button className="pr-target" title={`Show ${t}`} data-testid="proposal-target" onClick={() => controls.current?.look(desc.refs[i])}>
                {t}
              </button>
            </li>
          ))}
        </ul>
      )}
      {check.diff.length === 0 ? (
        <p className="pr-none" data-testid="proposal-changes">
          No differences.
        </p>
      ) : (
        <ul className="pr-change-list" data-testid="proposal-changes">
          {check.diff.map((c, i) => (
            <li key={i} className={`pr-change ${c.change}`}>
              <span className="pr-mark" aria-label={c.change}>
                {MARK[c.change]}
              </span>
              <span className="pr-change-text">
                <span className="pr-change-label">{changeLabel(c)}</span>
                {values && (c.change === 'modified' || c.change === 'moved') && (
                  <span className="pr-change-values">
                    {shortValue(c.before)} → {shortValue(c.after)}
                  </span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
      {audio.length > 0 && (
        <ul className="pr-audio" aria-label="Sound changes" data-testid="proposal-audio">
          {audio.map((a) => (
            <li key={a.clipId}>
              <button className="pr-audio-line" title={`Go to ${a.name}`} onClick={() => controls.current?.showFrame(a.frame)}>
                <Icon name="volume" size={12} />
                {a.text}
              </button>
            </li>
          ))}
        </ul>
      )}
      {replaced && (
        <p className="pr-note" data-testid="proposal-replaced">
          {replacedNote(replaced)}
        </p>
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Players and the shared frame
// ---------------------------------------------------------------------------

type ReviewCompositionProps = MainCompositionProps & { audioFrom: Project };

/** Every element list of a project (scenes and reusable components) mapped by `fn`. */
function mapElements(project: Project, fn: (elements: Element[]) => Element[]): Project {
  return {
    ...project,
    scenes: project.scenes.map((s) => ({ ...s, elements: fn(s.elements) })),
    compositions: Object.fromEntries(Object.entries(project.compositions).map(([id, c]) => [id, { ...c, elements: fn(c.elements) }])),
  };
}

/** `project`'s pictures without any sound: no audio clips, every video element muted (in groups and components too). */
export function silentProject(project: Project): Project {
  const muted = mapElements(project, (els) => els.map((el) => (el.type === 'video' && el.props.muted !== true ? { ...el, props: { ...el.props, muted: true } } : el)));
  return { ...muted, audio: [] };
}

/**
 * Only what sounds in `project`: its audio clips and its audible video
 * elements, with the groups and instances that time them. Nothing else is
 * drawn (and no mattes), so the copy costs little more than its videos.
 */
export function soundOnlyProject(project: Project): Project {
  return mapElements(project, (els) =>
    els.flatMap((el) => {
      if (el.type !== 'group' && el.type !== 'instance' && !(el.type === 'video' && el.props.muted !== true)) return [];
      const { mask: _mask, ...rest } = el;
      return [rest];
    }),
  );
}

/** The pictures of `project` (exactly MainComposition) with the complete soundtrack of `audioFrom`. */
const ReviewComposition: React.FC<ReviewCompositionProps> = ({ project, assetBaseUrl, audioFrom }) => {
  const own = audioFrom === project;
  const silent = useMemo(() => (own ? project : silentProject(project)), [own, project]);
  const sound = useMemo(() => (own ? null : soundOnlyProject(audioFrom)), [own, audioFrom]);
  // The pictures keep their place in the tree, so flipping what you hear never remounts (re-decodes) them.
  return (
    <>
      <MainComposition project={silent} assetBaseUrl={assetBaseUrl} />
      {sound && (
        // Heard, never seen: the same composition, so the sound matches playback and export exactly.
        <FullFrame style={{ visibility: 'hidden' }} aria-hidden>
          <MainComposition project={sound} assetBaseUrl={assetBaseUrl} />
        </FullFrame>
      )}
    </>
  );
};

const ReviewPlayer = memo(function ReviewPlayer({
  project,
  audioFrom,
  fit,
  playerRef,
  initialFrame,
  muted,
  loop,
}: {
  project: Project;
  /** Whose audio this player plays (the driving player switches it with the view). */
  audioFrom: Project;
  fit: number;
  playerRef: RefObject<PlayerRef | null>;
  initialFrame: number;
  muted?: boolean;
  loop?: FrameRange | null;
}) {
  // Exactly what playback and export render: MainComposition, assets from '/'.
  const inputProps = useMemo<ReviewCompositionProps>(() => ({ project, assetBaseUrl: '/', audioFrom }), [project, audioFrom]);
  const total = Math.max(1, projectDurationInFrames(project));
  return (
    <Player
      ref={playerRef}
      component={ReviewComposition}
      inputProps={inputProps}
      durationInFrames={total}
      fps={project.fps}
      compositionWidth={project.width}
      compositionHeight={project.height}
      style={{ width: project.width * fit, height: project.height * fit }}
      clickToPlay={false}
      initialFrame={Math.min(initialFrame, total - 1)}
      initiallyMuted={muted}
      inFrame={loop ? loop.start : null}
      outFrame={loop ? loop.end : null}
      loop={!!loop}
    />
  );
});

/** A loop the Player can play (outFrame > inFrame), at least a second long when the change is shorter. */
function loopable(range: FrameRange, total: number, fps: number): FrameRange | null {
  const last = total - 1;
  if (last < 1) return null;
  if (range.end > range.start) return range;
  const end = Math.min(last, range.start + fps);
  return { start: Math.max(0, Math.min(range.start, end - 1)), end };
}

/** Space round the plates, between them, and for the label above each. */
const PAD = 8;
const GAP = 16;
const LABEL = 24;

function ReviewStage({ check, controls }: { check: Ready; controls: RefObject<StageControls | null> }) {
  const current = useEditor((s) => s.doc.project);
  const revision = current.revision;
  const view = useProposals((s) => s.view);
  const setView = useProposals((s) => s.setView);
  const playing = useEditor((s) => s.playing);
  const seekNonce = useEditor((s) => s.seekNonce);
  const candidate = check.candidate;
  const fps = candidate.fps;
  const totalC = projectDurationInFrames(current);
  const totalP = projectDurationInFrames(candidate);
  const total = Math.max(totalC, totalP, 1);
  const range = useMemo(() => affectedRange(current, candidate, check.touched), [current, candidate, check.touched]);
  const loopRange = loopable(range, totalP, fps);

  const proposedRef = useRef<PlayerRef>(null);
  const currentRef = useRef<PlayerRef>(null);
  const [startFrame] = useState(() => firstFrame(useEditor.getState().playhead, candidate, check.touched, range));
  const [frame, setFrame] = useState(startFrame);
  const [looping, setLooping] = useState(false);
  // In Side by side you pick what you hear; Current and Proposed hear themselves.
  const [hear, setHear] = useState<Audible>('proposed');
  const audible: Audible = view === 'split' ? hear : view;
  const live = useRef({ frame: startFrame, totalC, totalP, range, looping, candidate });
  live.current = { ...live.current, totalC, totalP, range, looping, candidate };

  const mirror = (f: number) => useEditor.getState().syncPlayhead(Math.max(0, Math.min(f, live.current.totalC - 1)));

  /** Put both players on frame f (and the editor's playhead with them). */
  const show = useCallback((f: number, { echo = true } = {}) => {
    const { totalC: c, totalP: p, range: r, looping: l } = live.current;
    const target = Math.max(0, Math.min(Math.round(f), Math.max(c, p, 1) - 1));
    live.current.frame = target;
    setFrame(target);
    if (l && (target < r.start || target > r.end)) setLooping(false);
    proposedRef.current?.seekTo(Math.min(target, p - 1));
    currentRef.current?.seekTo(Math.min(target, c - 1));
    if (echo) mirror(target);
  }, []);

  // The proposed player drives: it is the editor's player while the review is open,
  // so Space and the timeline's play button play the review.
  useEffect(() => {
    const d = proposedRef.current;
    registerPlayer(d);
    mirror(live.current.frame);
    if (!d) return;
    const onFrame = (e: { detail: { frame: number } }) => {
      if (!d.isPlaying()) return;
      const f = e.detail.frame;
      live.current.frame = f;
      setFrame(f);
      currentRef.current?.seekTo(Math.min(f, live.current.totalC - 1));
      mirror(f);
    };
    const onPlay = () => useEditor.getState().setPlaying(true);
    const onPause = () => {
      // Pausing ends "Play affected range"; Play then plays on normally.
      live.current.looping = false;
      setLooping(false);
      useEditor.getState().setPlaying(false);
    };
    d.addEventListener('frameupdate', onFrame);
    d.addEventListener('play', onPlay);
    d.addEventListener('pause', onPause);
    d.addEventListener('ended', onPause);
    return () => {
      d.removeEventListener('frameupdate', onFrame);
      d.removeEventListener('play', onPlay);
      d.removeEventListener('pause', onPause);
      d.removeEventListener('ended', onPause);
      registerPlayer(null);
      useEditor.getState().setPlaying(false);
    };
  }, []);

  // The editor paused playback (a frame step, a timeline scrub).
  useEffect(() => {
    const d = proposedRef.current;
    if (d && !playing && d.isPlaying()) d.pause();
  }, [playing]);

  // The editor moved the playhead (timeline scrub, an agent's focus): the review follows.
  const firstNonce = useRef(seekNonce);
  useEffect(() => {
    if (seekNonce === firstNonce.current) return;
    const p = useEditor.getState().playhead;
    if (p !== Math.min(live.current.frame, live.current.totalC - 1)) show(p, { echo: false });
  }, [seekNonce, show]);

  useEffect(() => {
    controls.current = {
      step: (delta) => {
        useEditor.getState().setPlaying(false);
        show(live.current.frame + delta);
      },
      look: (ref) => {
        const f = lookFrame(live.current.candidate, ref);
        if (f === null) return;
        useEditor.getState().setPlaying(false);
        show(f);
      },
      showFrame: (f) => {
        useEditor.getState().setPlaying(false);
        show(f);
      },
    };
    return () => {
      controls.current = null;
    };
  }, [controls, show]);

  const playRange = (e: ReactMouseEvent) => {
    const d = proposedRef.current;
    if (!d || !loopRange) return;
    if (looping) {
      setLooping(false);
      d.pause();
      return;
    }
    live.current.looping = true;
    setLooping(true);
    const inside = live.current.frame >= loopRange.start && live.current.frame < loopRange.end;
    if (!inside) show(loopRange.start);
    // Must start inside the click: browsers only allow sound from a user gesture.
    if (!d.isPlaying()) d.play(e);
  };

  // Size the plates to the well.
  const wellRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = wellRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize({ w: entry.contentRect.width, h: entry.contentRect.height }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const W = candidate.width;
  const H = candidate.height;
  const split = view === 'split';
  const room = { w: size.w - PAD * 2, h: size.h - PAD * 2 - LABEL };
  const fit = size.w > 0 ? Math.max(0.05, Math.min((split ? (room.w - GAP) / 2 : room.w) / W, room.h / H)) : 0.25;

  const slot = (which: 'current' | 'proposed') => {
    const shown = split || view === which;
    const ended = which === 'current' ? frame > totalC - 1 : frame > totalP - 1;
    const label = which === 'current' ? `Current · r${revision}` : 'Proposed';
    const hearing = shown && audible === which;
    return (
      <figure className={`pr-slot ${which} ${shown ? 'shown' : ''} ${hearing ? 'audible' : ''}`} aria-hidden={!shown} data-testid={`proposal-slot-${which}`} style={{ width: W * fit }}>
        <figcaption className="pr-tag">
          {which === 'proposed' && <span className="pr-tag-dot" aria-hidden />}
          {label}
          {hearing && split && (
            <span className="pr-tag-hear" title="You are hearing this version">
              <Icon name="volume" size={12} />
            </span>
          )}
        </figcaption>
        <div className="pr-plate" style={{ width: W * fit, height: H * fit }}>
          <ReviewPlayer
            project={which === 'current' ? current : candidate}
            // The proposed player drives, so it carries the audible soundtrack; the current one is muted.
            audioFrom={which === 'current' || audible === 'current' ? current : candidate}
            fit={fit}
            playerRef={which === 'current' ? currentRef : proposedRef}
            initialFrame={startFrame}
            muted={which === 'current'}
            loop={which === 'proposed' && looping ? loopRange : null}
          />
          {ended && (
            <div className="pr-ended">
              {which === 'current' ? 'The current version' : 'The proposed version'} ends at {formatTimecode((which === 'current' ? totalC : totalP) - 1, fps)}
            </div>
          )}
        </div>
      </figure>
    );
  };

  return (
    <>
      <div className={`pr-body view-${view}`} data-audible={audible}>
        <div className="pr-stage" ref={wellRef}>
          <div className="pr-frames" style={split ? undefined : { width: W * fit, height: H * fit + LABEL }}>
            {slot('current')}
            {slot('proposed')}
          </div>
        </div>
        <ChangePanel check={check} controls={controls} />
      </div>
      <ReviewBar
        frame={frame}
        total={total}
        fps={fps}
        playing={playing}
        range={range}
        looping={looping}
        canLoop={!!loopRange}
        sceneStarts={sceneStartFrames(candidate)}
        view={view}
        onView={setView}
        hear={hear}
        onHear={setHear}
        onSeek={(f) => {
          useEditor.getState().setPlaying(false);
          show(f);
        }}
        onPlayRange={playRange}
      />
    </>
  );
}

// ---------------------------------------------------------------------------
// The transport row under the plates: play/pause, the timecode, scrub with the
// affected range, which version you see (and hear), Play affected range
// ---------------------------------------------------------------------------

function ReviewBar({
  frame,
  total,
  fps,
  playing,
  range,
  looping,
  canLoop,
  sceneStarts,
  view,
  onView,
  hear,
  onHear,
  onSeek,
  onPlayRange,
}: {
  frame: number;
  total: number;
  fps: number;
  playing: boolean;
  range: FrameRange;
  looping: boolean;
  canLoop: boolean;
  sceneStarts: number[];
  view: ReviewView;
  onView: (view: ReviewView) => void;
  hear: Audible;
  onHear: (hear: Audible) => void;
  onSeek: (frame: number) => void;
  onPlayRange: (e: ReactMouseEvent) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const pct = (f: number) => `${(f / Math.max(1, total - 1)) * 100}%`;
  const frameAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return Math.round(((clientX - r.left) / Math.max(1, r.width)) * (total - 1));
  };
  const scrub = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    onSeek(frameAt(e.clientX));
    const move = (ev: PointerEvent) => onSeek(frameAt(ev.clientX));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  };
  const seconds = ((range.end - range.start + 1) / fps).toFixed(1);

  return (
    <div className="transport pr-bar" data-testid="proposal-transport">
      <button className="icon-btn play" data-testid="proposal-play" aria-label={playing ? 'Pause' : 'Play'} aria-pressed={playing} title="Play / pause both (Space)" onClick={(e) => togglePlayback(e)}>
        <Icon name={playing ? 'pause' : 'play'} size={14} />
      </button>
      <span className="timecode" data-testid="proposal-timecode">
        <span className="tc-now">{formatTimecode(frame, fps)}</span>
        <span className="tc-total">/ {formatTimecode(total, fps)}</span>
        <span className="tc-frame">f {frame}</span>
      </span>
      <div
        className="pr-scrub"
        role="slider"
        tabIndex={0}
        aria-label="Review position"
        aria-valuemin={0}
        aria-valuemax={total - 1}
        aria-valuenow={frame}
        aria-valuetext={`${formatTimecode(frame, fps)}, frame ${frame}`}
        data-testid="proposal-scrubber"
        onPointerDown={scrub}
      >
        <div className="pr-track" ref={trackRef}>
          {sceneStarts.slice(1).map((s) => (
            <span key={s} className="pr-scene-tick" style={{ left: pct(s) }} aria-hidden />
          ))}
          <span
            className={`pr-range ${looping ? 'looping' : ''}`}
            style={{ left: pct(range.start), width: `calc(${pct(range.end)} - ${pct(range.start)})` }}
            title={`Affected: ${formatTimecode(range.start, fps)} – ${formatTimecode(range.end, fps)}`}
            data-testid="proposal-range"
            aria-hidden
          />
          <span className="pr-head-mark" style={{ left: pct(frame) }} aria-hidden />
        </div>
      </div>
      <div className="transport-right">
        <div className="pr-seg" role="group" aria-label="Compare">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              className={`pr-view ${view === v.id ? 'on' : ''}`}
              aria-pressed={view === v.id}
              data-testid={`proposal-view-${v.id}`}
              title={v.id === 'split' ? 'Show both side by side' : `Show the ${v.label.toLowerCase()} version (${FLIP_KEY} flips Current / Proposed)`}
              onClick={() => onView(v.id)}
            >
              {v.label}
            </button>
          ))}
        </div>
        {view === 'split' && (
          <div className="pr-seg pr-hear" role="radiogroup" aria-label="Hear" data-testid="proposal-hear">
            <span className="pr-hear-label" title="Which version's sound you hear">
              <Icon name="volume" size={12} />
            </span>
            {(['current', 'proposed'] as const).map((h) => (
              <button key={h} role="radio" aria-checked={hear === h} className={`pr-view ${hear === h ? 'on' : ''}`} data-testid={`proposal-hear-${h}`} title={`Hear the ${h} version's sound`} onClick={() => onHear(h)}>
                {h === 'current' ? 'Current' : 'Proposed'}
              </button>
            ))}
          </div>
        )}
        <button
          className={`btn small pr-play-range ${looping ? 'on' : ''}`}
          data-testid="proposal-play-range"
          aria-pressed={looping}
          disabled={!canLoop}
          title={`${looping ? 'Stop looping' : 'Loop'} ${formatTimecode(range.start, fps)} – ${formatTimecode(range.end, fps)}, where the change is`}
          onClick={onPlayRange}
        >
          <Icon name="loop" size={13} />
          <span className="pr-play-range-label">{looping ? 'Looping affected range' : 'Play affected range'}</span>
          <span className="pr-range-len">{seconds} s</span>
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Out of date: explain what changed; never offer Apply
// ---------------------------------------------------------------------------

function StaleNotice({ proposal, check }: { proposal: Proposal; check: NotReady }) {
  const project = useEditor((s) => s.doc.project);
  const sameDocument = useEditor((s) => s.docSession === proposal.docSession);
  const chatAgent = useChat((s) => providerLabel(s.providers, s.provider));
  const by = proposal.agent === PASTED_BY ? 'you pasted it' : proposal.agent === TAKE_BY ? 'you chose this take' : `${proposal.agent} proposed it`;
  const conflicts = check.status === 'stale' && check.conflicts?.length ? listNames(check.conflicts.map((t) => targetName(project, t))) : null;
  const what = !sameDocument
    ? 'Another project was opened, so it no longer applies here.'
    : conflicts
      ? `${conflicts} changed after ${by}. Applying it now would overwrite that change, so it can’t be applied.`
      : check.error.message;
  const canAsk = sameDocument && !byYou(proposal.agent) && chatAgent === proposal.agent;

  const askToRedo = async () => {
    const why = conflicts ? `${conflicts} changed after you proposed it` : 'the project changed after you proposed it';
    if (!(await sendChat(`Your proposal “${proposal.patch.summary}” went out of date: ${why}. Please redo it on the current version.`, []))) return;
    useProposals.getState().cancel();
  };

  return (
    <div className="pr-body pr-stale-well">
      <div className="pr-stale" role="alert" data-testid="proposal-stale">
        <span className="pr-stale-icon" aria-hidden>
          <Icon name="warning" size={18} />
        </span>
        <h3>{check.status === 'stale' ? 'This proposal is out of date' : 'This proposal can’t be applied'}</h3>
        <p>{what}</p>
        {check.status === 'stale' && conflicts && <p className="fine">Your work is safe: nothing was changed.</p>}
        <div className="pr-stale-actions">
          {canAsk ? (
            <button className="btn agent" data-testid="proposal-ask-redo" onClick={() => void askToRedo()}>
              Ask {proposal.agent} to redo it
            </button>
          ) : (
            <p className="fine">
              {proposal.agent === PASTED_BY
                ? 'Copy a fresh prompt from AI revisions and paste the new patch.'
                : proposal.agent === TAKE_BY
                  ? 'Dismiss it, then choose Use this take again in Assets › Generated.'
                  : `Ask ${proposal.agent} to redo it on the current version.`}
            </p>
          )}
          <button className="btn" data-testid="proposal-dismiss" onClick={() => useProposals.getState().cancel()}>
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Minimised: a pill on the stage reopens the review
// ---------------------------------------------------------------------------

export function ProposalPill() {
  const proposal = useProposals((s) => s.proposal);
  const check = useProposals((s) => s.check);
  const open = useProposals((s) => s.open);
  if (!proposal || !check || open) return null;
  const stale = check.status !== 'ready';
  const from = byYou(proposal.agent) ? whose(proposal.agent) : `Proposal from ${proposal.agent}`;
  return (
    <button
      className={`pr-pill ${stale ? 'stale' : ''}`}
      data-testid="proposal-pill"
      title={`${proposal.patch.summary}${stale ? ' (out of date)' : ''}`}
      onClick={() => useProposals.getState().openReview()}
    >
      <span className="pr-pill-dot" aria-hidden />
      <span className="pr-pill-text">{stale ? `${whose(proposal.agent)} is out of date` : from}</span>
      <span className="pr-pill-cta">Review</span>
    </button>
  );
}
