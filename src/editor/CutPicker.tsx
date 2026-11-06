// "Start from a storyboard" (firstCut.ts): the blank project's stage as a
// cut picker. Four beat slots with looping previews, shuffle per slot and for
// all four, a browse dialog per beat, the stitched cut playing live in a
// Player (the real composition, not the preview clips), one input
// for a website or idea, and "Start editing".

import { Player, type PlayerRef } from '../runtime';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { MainComposition } from '../composition/MainComposition';
import type { MainCompositionProps } from '../composition/types';
import { CUT_BEAT_INFO, CUT_BEATS, cutInputKind, type CutBeat, type CutCard } from '../core/cutCards';
import { cardsFor, cutCard } from '../core/cutCatalog';
import { STYLE_PACK_IDS, STYLE_PACKS } from '../core/style';
import { projectDurationInFrames } from '../core/timing';
import { isTyping } from './editActions';
import { Icon } from './icons';
import { agentName } from './createFlow';
import { applyCut, loadBrandKits, closeBrowse, cutPreviewProject, dismissPicker, openBrowse, pickCard, setCutInput, setLook, shuffleAll, shuffleBeat, useCutPicker, type CutLook } from './firstCut';
import { useEditor } from './store';

const previewSrc = (id: string, ext: 'mp4' | 'jpg') => `/cut-previews/${id}.${ext}`;

/** A card's looping preview clip (poster first, so a missing clip still shows something). */
function CardClip({ card, playing = true }: { card: CutCard; playing?: boolean }) {
  return playing ? (
    <video key={card.id} className="cut-clip" src={previewSrc(card.id, 'mp4')} poster={previewSrc(card.id, 'jpg')} muted loop autoPlay playsInline aria-hidden />
  ) : (
    <img className="cut-clip" src={previewSrc(card.id, 'jpg')} alt="" aria-hidden />
  );
}

function Slot({ beat, index }: { beat: CutBeat; index: number }) {
  const card = cutCard(useCutPicker((s) => s.picks[beat]))!;
  const info = CUT_BEAT_INFO[beat];
  const count = cardsFor(beat).length;
  return (
    <div className="cut-slot" data-testid={`cut-slot-${beat}`}>
      <div className="cut-slot-head">
        <span className="cut-slot-num tabular">{index + 1}</span>
        <strong>{info.label}</strong>
      </div>
      <span className="cut-slot-job">{info.job}</span>
      <div className="cut-slot-tile">
        <button className="cut-slot-open" onClick={() => openBrowse(beat)} aria-label={`Choose from ${count} ${info.noun}s. Now: ${card.name}`} title={card.name} data-testid={`cut-browse-${beat}`}>
          <CardClip card={card} />
          <span className="cut-slot-browse">{count} {info.noun}s</span>
        </button>
        <button className="cut-slot-shuffle icon-btn" onClick={() => shuffleBeat(beat)} aria-label={`Another ${info.noun}`} title={`Another ${info.noun}`} data-testid={`cut-shuffle-${beat}`}>
          <Icon name="shuffle" size={14} />
        </button>
      </div>
      <span className="cut-slot-name" title={card.name}>
        {card.name}
      </span>
    </div>
  );
}

const fmtTime = (frames: number, fps: number) => {
  const s = Math.floor(frames / fps);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The stitched cut in a Player, with a play button and one segment per beat. */
function CutPreview() {
  const picks = useCutPicker((s) => s.picks);
  const look = useCutPicker((s) => s.look);
  const width = useEditor((s) => s.doc.project.width);
  const height = useEditor((s) => s.doc.project.height);
  const fps = useEditor((s) => s.doc.project.fps);
  const kits = useCutPicker((s) => s.kits);
  const project = useMemo(() => cutPreviewProject(picks, look, { width, height, fps, backgroundColor: '#000000' }, kits), [picks, look, width, height, fps, kits]);
  const inputProps = useMemo<MainCompositionProps>(() => ({ project, assetBaseUrl: '/' }), [project]);
  const total = Math.max(1, projectDurationInFrames(project));
  const ref = useRef<PlayerRef>(null);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    const p = ref.current;
    if (!p) return;
    const onFrame = (e: { detail: { frame: number } }) => setFrame(e.detail.frame);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    p.addEventListener('frameupdate', onFrame);
    p.addEventListener('play', onPlay);
    p.addEventListener('pause', onPause);
    return () => {
      p.removeEventListener('frameupdate', onFrame);
      p.removeEventListener('play', onPlay);
      p.removeEventListener('pause', onPause);
    };
  }, []);

  let start = 0;
  const segments = project.scenes.map((scene, i) => {
    const seg = { beat: CUT_BEATS[i], start, length: scene.durationInFrames };
    start += scene.durationInFrames;
    return seg;
  });
  const toggle = () => (playing ? ref.current?.pause() : ref.current?.play());

  return (
    <div className="cut-preview" data-testid="cut-preview">
      <div className="cut-player" style={{ aspectRatio: `${project.width} / ${project.height}` }}>
        <Player
          ref={ref}
          component={MainComposition}
          inputProps={inputProps}
          durationInFrames={total}
          fps={project.fps}
          compositionWidth={project.width}
          compositionHeight={project.height}
          style={{ width: '100%', height: '100%' }}
          loop
          clickToPlay
        />
      </div>
      <div className="cut-bar">
        <button className="cut-play" onClick={toggle} aria-label={playing ? 'Pause' : 'Play the storyboard'} data-testid="cut-play">
          <Icon name={playing ? 'pause' : 'play'} size={14} />
        </button>
        <div className="cut-segments" role="group" aria-label="Beats">
          {segments.map((s) => {
            const fill = Math.max(0, Math.min(1, (frame - s.start) / s.length));
            return (
              <button key={s.beat} className="cut-segment" style={{ flexGrow: s.length }} onClick={() => ref.current?.seekTo(s.start)} aria-label={`Jump to ${CUT_BEAT_INFO[s.beat].label}`} title={CUT_BEAT_INFO[s.beat].label}>
                <span className="cut-segment-fill" style={{ transform: `scaleX(${fill})` }} />
              </button>
            );
          })}
        </div>
        <span className="cut-time tabular">
          {fmtTime(frame, project.fps)} / {fmtTime(total, project.fps)}
        </span>
      </div>
    </div>
  );
}

function LookSelect() {
  const look = useCutPicker((s) => s.look);
  const kits = useCutPicker((s) => s.kits);
  return (
    <label className="cut-look">
      <span>Look</span>
      <select value={look} onChange={(e) => setLook(e.target.value as CutLook)} data-testid="cut-look">
        <option value="auto">Match the opener</option>
        {kits.length > 0 && (
          <optgroup label="Brand kits">
            {kits.map((k) => (
              <option key={k.id} value={`kit:${k.id}`}>
                {k.name} ({k.domain})
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Style packs">
          {STYLE_PACK_IDS.map((id) => (
            <option key={id} value={id}>
              {STYLE_PACKS[id].name}
            </option>
          ))}
        </optgroup>
      </select>
    </label>
  );
}

function CutInput() {
  const input = useCutPicker((s) => s.input);
  const using = useCutPicker((s) => s.using);
  const stage = useCutPicker((s) => s.stage);
  const kind = cutInputKind(input);
  const submit = () => void applyCut();
  return (
    <div className="cut-input-area">
      <label className="cut-input-label" htmlFor="cut-input">
        What’s it for?
      </label>
      <div className="cut-input-row">
        <div className="cut-input">
          <Icon name="link" size={15} />
          <input
            id="cut-input"
            value={input}
            onChange={(e) => setCutInput(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && submit()}
            placeholder="Paste your site, or say what you’re making"
            autoComplete="off"
            data-testid="cut-input"
          />
        </div>
        <button className="btn primary cut-use" onClick={submit} disabled={using} data-testid="cut-use">
          {stage === 'scanning' ? 'Reading the site…' : using ? 'Setting it up…' : 'Start editing'}
        </button>
      </div>
      <span className="cut-input-hint">
        {kind === 'site'
          ? `The site’s colours, logo and words fill the scenes and are saved as a brand kit; ${agentName()} then polishes each scene.`
          : kind === 'idea'
            ? `${agentName()} writes each scene’s words from your description.`
            : 'A site brings your colours and words along. Leave it empty to start from the sample and edit by hand.'}
      </span>
    </div>
  );
}

/** Browse one beat's cards; a click picks one and closes. */
function BrowseDialog({ beat }: { beat: CutBeat }) {
  const picks = useCutPicker((s) => s.picks);
  const [hover, setHover] = useState<string | null>(null);
  const cards = cardsFor(beat);
  const info = CUT_BEAT_INFO[beat];
  const gridRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    gridRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.scrollIntoView({ block: 'center' });
    gridRef.current?.querySelector<HTMLElement>('[aria-pressed="true"]')?.focus({ preventScroll: true });
  }, [beat]);
  const onKeyDown = (e: KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Escape' && !isTyping(e.target)) closeBrowse();
  };
  const choose = (id: string) => {
    pickCard(id);
    closeBrowse();
  };
  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && closeBrowse()}>
      <div className="modal cut-browse" role="dialog" aria-label={`Choose ${info.noun === "opener" ? "an" : "a"} ${info.noun}`} data-testid="cut-browse" onKeyDown={onKeyDown}>
        <header className="modal-head">
          <div>
            <h2>Choose {info.noun === "opener" ? "an" : "a"} {info.noun}</h2>
            <span className="cut-browse-job">{info.job}</span>
          </div>
          <button className="icon-btn" onClick={closeBrowse} aria-label="Close">
            <Icon name="close" />
          </button>
        </header>
        <div className="cut-browse-tabs" role="tablist" aria-label="Beats">
          {CUT_BEATS.map((b, i) => {
            const picked = cutCard(picks[b])!;
            return (
              <button key={b} role="tab" aria-selected={b === beat} className={`cut-browse-tab ${b === beat ? 'on' : ''}`} onClick={() => openBrowse(b)} data-testid={`cut-tab-${b}`}>
                <img src={previewSrc(picked.id, 'jpg')} alt="" />
                <span>
                  <span className="tabular">{i + 1}</span> {CUT_BEAT_INFO[b].label}
                </span>
              </button>
            );
          })}
        </div>
        <div className="cut-browse-grid" ref={gridRef}>
          {cards.map((card) => {
            const on = picks[beat] === card.id;
            return (
              <button
                key={card.id}
                className={`cut-browse-card ${on ? 'on' : ''}`}
                aria-pressed={on}
                onClick={() => choose(card.id)}
                onPointerEnter={() => setHover(card.id)}
                onPointerLeave={() => setHover((h) => (h === card.id ? null : h))}
                onFocus={() => setHover(card.id)}
                onBlur={() => setHover((h) => (h === card.id ? null : h))}
                data-testid={`cut-card-${card.id}`}
              >
                <span className="cut-browse-media">
                  <CardClip card={card} playing={hover === card.id} />
                  {on && (
                    <span className="cut-in-cut">
                      <Icon name="check" size={12} /> Chosen
                    </span>
                  )}
                </span>
                <span className="cut-browse-name">{card.name}</span>
              </button>
            );
          })}
        </div>
        <footer className="cut-browse-foot">
          <span>
            {cards.length} {info.noun}s · hover to play
          </span>
          <button className="btn" onClick={closeBrowse}>
            Done
          </button>
        </footer>
      </div>
    </div>
  );
}

/** The blank project's stage: build a first cut from four beats. */
export function CutPicker() {
  const browse = useCutPicker((s) => s.browse);
  useEffect(() => void loadBrandKits(), []);
  return (
    <div className="cut-home" data-testid="cut-picker">
      <div className="cut-home-inner">
        <header className="cut-home-head">
          <div>
            <h1>Start from a storyboard</h1>
            <p>Four beats, one video: choose each, watch it play, then make it yours.</p>
          </div>
          <div className="cut-home-tools">
            <LookSelect />
            <button className="btn" onClick={() => shuffleAll()} data-testid="cut-shuffle-all">
              <Icon name="shuffle" size={14} /> Remix
            </button>
          </div>
        </header>
        <div className="cut-slots">
          {CUT_BEATS.map((b, i) => (
            <Slot key={b} beat={b} index={i} />
          ))}
        </div>
        <CutPreview />
        <CutInput />
        <button className="cut-dismiss" onClick={dismissPicker} data-testid="cut-dismiss">
          Rather describe it? Use the chat
        </button>
      </div>
      {browse && <BrowseDialog beat={browse} />}
    </div>
  );
}
