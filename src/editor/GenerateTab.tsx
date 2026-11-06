// The Generate tab of the right column: music, voice-over, sound
// effects, images and video clips made on fal through the local server.
//
// One composer, built like the chat's: what to make (the media switch above,
// the job as a menu at the composer's head), the images and frames it works
// from as tiles inside the composer, the prompt, then one row of setting chips
// (length, aspect, resolution, takes, model; each opens a small popover) ending
// in the Generate button with its price; the model sits at the composer's
// head, across from the job. Under it a single status line (what
// is missing, the price's basis, today's spend), then recent jobs with their
// results.
//
// Images and clips can be dropped on the composer, from the Assets library or
// from the computer (uploaded as references): the job follows what it is given
// (generateDrop.ts). Video settings fill from the selected scene (its length; a
// transition or keyframed clip starts as a 5 s bridge; the cut after it), and
// frames taken from a scene's edge follow it as the video changes
// (generateStore.ts).
//
// Music scored to the cut lays its plan inside the composer where tiles go
// (a section per scene, each with its own direction), with the tempo as a
// chip; narration for each scene writes a line per scene where the prompt
// goes. Their done jobs say how the cuts sit on the bed's downbeats and
// offer Place as bed, Snap cuts to downbeats and Place at scenes, each a
// proposal to review (scoring.ts). Takes land in Assets › Generated
// (TakesPanel.tsx); nothing here places anything in the video by itself.
// With the server down or no key the composer stays usable for planning;
// only the button waits, with a note.

import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent, type ReactNode } from 'react';
import { videoPreviewSrc } from '../composition/previewProxies';
import { formatUsd, type FrameSource, type GenerationJob, type GenerationJobStatus, type GenerationQuote, type JobKind, type JobSettings, type RoutePolicy } from '../core/generationStudio';
import { narrationLines, planProblem } from '../core/scorePlan';
import { resolveAssetUrl } from '../core/timing';
import type { Asset, AssetKind, Project } from '../core/types';
import { startAssetDrag, useMediaDrop } from './assetDrag';
import { acceptFor, addReferenceFiles, pickFile } from './assets';
import { showInLibrary } from './AssetsPanel';
import { AudioPlayButton } from './AudioPreview';
import { CommitNumber, CommitText } from './fields';
import { dropPlan } from './generateDrop';
import {
  acrossCut,
  ACTIVE_STATUSES,
  addMissingTakes,
  ASPECT_RATIOS,
  aspectFor,
  BRIDGE_SECONDS,
  brokenCut,
  cancelGenerationJob,
  carriedOverNote,
  cutAfter,
  draftProblem,
  elapsedText,
  estimateDraft,
  frameSourceLabel,
  frameWarning,
  jobElapsedMs,
  jobPromptText,
  jobRowLabel,
  jobsOf,
  KEYFRAME_COUNT,
  loadGenerationStudio,
  MAX_TAKES,
  missingTakes,
  nextKeyframeTime,
  pickedFrame,
  quoteFresh,
  referenceLabels,
  referenceTally,
  routeReason,
  sameFrame,
  sceneEdgeFrame,
  sceneMusicLabel,
  sceneMusicSeconds,
  sceneSeconds,
  secondsText,
  selectedImageAssetId,
  SFX_PROMPT_MAX,
  sortKeyframes,
  statusStamp,
  submitDraft,
  useGenerate,
  VIDEO_ASPECTS,
  VIDEO_REFERENCE_LIMITS,
  VIDEO_SECONDS,
  videoLengthFor,
  videoSeconds,
  type GenerateMode,
  type PinnedFrame,
} from './generateStore';
import { Icon, type IconName } from './icons';
import { useLayout } from './layout';
import { peekProps } from './Peek';
import { Chip, Option, Popover, PopLabel } from './Popover';
import {
  alignmentText,
  bedAction,
  currentCuts,
  lineFit,
  mergeNarrationLines,
  narrationAction,
  narrationScenes,
  outputMetaOf,
  parseStyles,
  pickedTake,
  placedBed,
  proposeAction,
  sectionScenes,
  snapAction,
  SPOKEN_CHARS_PER_SECOND,
  tenths,
  type TakeAction,
  type TakePicks,
} from './scoring';
import { takeUsage } from './takes';
import { openSettingsAt } from './SettingsDialog';
import { SceneThumb } from './SimpleTimeline';
import { useEditor } from './store';
import './generate.css';

/** Settings › Generation; at the key or the spending section when that is what to change. */
const openGenerationSettings = (section?: 'falKey' | 'spending') => (section ? openSettingsAt(section) : useLayout.getState().openSettings('generation'));

/** "$5" for a whole-dollar budget, otherwise formatUsd. */
const budgetText = (usd: number) => (Number.isInteger(usd) ? `$${usd}` : formatUsd(usd));

const takesText = (n: number) => `${n} ${n === 1 ? 'take' : 'takes'}`;

/** "Image 1", "Image 1 and Video 1", "Image 1, Image 2 and Video 1". */
const listText = (items: string[]) => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** The media switch, in the order people reach for them. */
const MODES: { id: GenerateMode; label: string; title: string; icon: IconName }[] = [
  { id: 'image', label: 'Image', title: 'Stills, cutouts, backgrounds, edits', icon: 'image' },
  { id: 'video', label: 'Video', title: 'Clips from text, an image, frames or a subject', icon: 'video' },
  { id: 'music', label: 'Music', title: 'A music bed for the video', icon: 'music' },
  { id: 'voice', label: 'Voice', title: 'Voice-over: a line or narration', icon: 'mic' },
  { id: 'sfx', label: 'Sound', title: 'Sound effects: hits and ambience', icon: 'volume' },
];

/** Each job as the composer's menu says it: a short name, what it is for, its mark. */
const JOB_UI: Record<JobKind, { label: string; detail: string; icon: IconName }> = {
  'image.generate': { label: 'Text to image', detail: 'A still from a description', icon: 'image' },
  'image.typography': { label: 'Image with text', detail: 'Words set in the picture; put them in quotes', icon: 'text' },
  'image.plate': { label: 'Background plate', detail: 'Wide or high-resolution, to sit behind a scene', icon: 'frame' },
  'image.cutout': { label: 'Cutout', detail: 'A subject on a transparent background', icon: 'scissors' },
  'image.edit': { label: 'Edit an image', detail: 'Change one thing; everything else stays', icon: 'wand' },
  'image.composite': { label: 'Combine images', detail: 'Two or more images into one', icon: 'layers' },
  'video.generate': { label: 'Text to video', detail: 'A clip from a description', icon: 'video' },
  'video.animate': { label: 'Animate an image', detail: 'Bring one still to life', icon: 'play' },
  'video.between': { label: 'Between two frames', detail: 'Bridge a cut, from a first frame to a last', icon: 'right' },
  'video.keyframes': { label: 'Through keyframes', detail: `Pass through ${KEYFRAME_COUNT.min}–${KEYFRAME_COUNT.max} pinned frames`, icon: 'diamond' },
  'video.reference': { label: 'Consistent subject', detail: 'The same person or product across shots', icon: 'smile' },
  'video.long': { label: 'Longer clip', detail: 'Up to 30 s, or from a document or web page', icon: 'film' },
  'music.bed': { label: 'Music bed', detail: 'A track for the whole video', icon: 'music' },
  'music.scored': { label: 'Scored to the cut', detail: 'Changes at each cut, a section per scene, each with its own feel', icon: 'timeline' },
  'voice.line': { label: 'Short line', detail: 'One read, a sentence or two', icon: 'mic' },
  'voice.narration': { label: 'Narration for each scene', detail: 'A line per scene, each its own take, placed in its scene', icon: 'message' },
  'sfx.hit': { label: 'One hit', detail: 'A whoosh, pop, tick or impact', icon: 'volume' },
  'sfx.ambience': { label: 'Ambience', detail: 'A bed of sound that loops', icon: 'loop' },
};

/** Used until the server's own hints load (models.jobs[].hint). */
const FALLBACK_HINT: Record<GenerateMode, string> = {
  music: 'Genre, mood, tempo and instruments; say where it builds or drops.',
  voice: 'The exact words to speak, punctuated the way they should sound.',
  sfx: 'What makes the sound, the space it is in, and how it starts and ends.',
  image: 'Subject, setting, light and style; name any text to show in quotes.',
  video: 'The shot: subject, action, camera move and light, in the order they happen.',
};

/** A job whose prompt asks for something other than its media's usual (also until the server's hints load). */
const FALLBACK_JOB_HINT: Partial<Record<JobKind, string>> = {
  'music.scored': 'Genre and instruments for the whole score; each section’s feel is set above.',
};

const POLICIES: { value: RoutePolicy; label: string; title: string }[] = [
  { value: 'quality', label: 'Quality', title: 'The best capable model' },
  { value: 'balanced', label: 'Balanced', title: 'A cheaper model where your own results show it does as well; Quality until there is enough evidence' },
  { value: 'draft', label: 'Draft', title: 'The cheapest capable model, for trying ideas' },
];

const POLICY_PICK: Record<RoutePolicy, string> = { quality: 'picked for quality', balanced: 'picked for results per dollar', draft: 'picked for the lowest price' };

const RESOLUTIONS: { value: NonNullable<JobSettings['resolution']>; label: string; detail: string }[] = [
  { value: '1k', label: '1K', detail: 'About 1024 px on the long side' },
  { value: '2k', label: '2K', detail: 'About 2048 px on the long side' },
  { value: '4k', label: '4K', detail: 'About 4096 px; slower and dearer' },
];

const VIDEO_RESOLUTIONS: { value: NonNullable<JobSettings['videoResolution']>; label: string; detail: string }[] = [
  { value: '1080p', label: '1080p', detail: 'Full HD: the best the models make' },
  { value: '720p', label: '720p', detail: 'HD: often quicker and cheaper' },
];

/** ElevenLabs voices fal offers by name; '' leaves it to the model. */
const VOICES = ['', 'Rachel', 'Aria', 'Sarah', 'Laura', 'Charlotte', 'Alice', 'Matilda', 'Jessica', 'Roger', 'George', 'Callum', 'Charlie', 'Liam', 'Brian', 'Daniel', 'Bill'];

/** A tile's picture height, frames and references alike. */
const TILE_H = 64;

/** What frames and pictures take; a subject's references take clips too. */
const PICTURES: readonly AssetKind[] = ['image', 'svg'];
const MEDIA: readonly AssetKind[] = ['image', 'svg', 'video'];

const ACTIVE = ACTIVE_STATUSES;
const CANCELLABLE: GenerationJobStatus[] = ['queued', 'running'];
/** Jobs listed before "Show older". */
const RECENT_JOBS = 8;

const assetSrc = (asset: Asset) => resolveAssetUrl('/', asset.kind === 'video' ? videoPreviewSrc(asset, false) : asset.src);

/** A clip asset's length, as the asset list says it ("8 s"); asset lengths are in project frames. */
const clipLength = (asset: Asset, fps: number) => (asset.durationInFrames ? secondsText(Math.round((asset.durationInFrames / fps) * 10) / 10) : null);

/** Nothing can be generated: the server is down, or there is no usable key. A useGenerate selector. */
const isBlocked = (s: ReturnType<typeof useGenerate.getState>) => s.link === 'offline' || (!!s.status && (!s.status.key.configured || s.status.key.valid === false));

/** Put dropped or picked assets into the draft the way its job takes them (generateDrop.ts). */
function takeAssets(ids: string[]) {
  const g = useGenerate.getState();
  const st = useEditor.getState();
  const r = dropPlan(g.draft, ids, st.doc.project);
  if ('refused' in r) st.toast({ tone: 'info', message: r.refused });
  else g.setDraft(r.patch);
}

/** A shallow well of choices, one raised: a radiogroup, arrows move and choose. */
function Segmented<T extends string>({ label, value, options, onChange, testId, className }: { label: string; value: T; options: readonly { value: T; label: ReactNode; title?: string }[]; onChange: (v: T) => void; testId?: (v: T) => string; className?: string }) {
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent) => {
    const i = options.findIndex((o) => o.value === value);
    const n = options.length;
    const next = ({ ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 } as Record<string, number>)[e.key];
    if (next === undefined) return;
    // Arrows here choose; they must not nudge the selected element.
    e.preventDefault();
    e.stopPropagation();
    onChange(options[next].value);
    buttons.current[next]?.focus();
  };
  return (
    <div className={`ins-seg gt-seg${className ? ` ${className}` : ''}`} role="radiogroup" aria-label={label} onKeyDown={onKey}>
      {options.map((o, i) => (
        <button
          key={o.value}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={o.value === value ? 0 : -1}
          className={o.value === value ? 'on' : ''}
          title={o.title}
          data-testid={testId?.(o.value)}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The head: the media switch and settings
// ---------------------------------------------------------------------------

function MediaSwitch() {
  const mode = useGenerate((s) => s.draft.mode);
  const setDraft = useGenerate((s) => s.setDraft);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: KeyboardEvent) => {
    const i = MODES.findIndex((m) => m.id === mode);
    const n = MODES.length;
    const next = ({ ArrowRight: (i + 1) % n, ArrowLeft: (i - 1 + n) % n, Home: 0, End: n - 1 } as Record<string, number>)[e.key];
    if (next === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    setDraft({ mode: MODES[next].id });
    buttons.current[next]?.focus();
  };
  return (
    <div className="gt-media" role="radiogroup" aria-label="What to generate" onKeyDown={onKey}>
      {MODES.map((m, i) => (
        <button
          key={m.id}
          ref={(el) => {
            buttons.current[i] = el;
          }}
          type="button"
          role="radio"
          aria-checked={m.id === mode}
          tabIndex={m.id === mode ? 0 : -1}
          className={m.id === mode ? 'on' : ''}
          title={m.title}
          data-testid={`generate-mode-${m.id}`}
          onClick={() => setDraft({ mode: m.id })}
        >
          <Icon name={m.icon} size={15} />
          <span>{m.label}</span>
        </button>
      ))}
    </div>
  );
}

/** The job, as a menu at the composer's head; a plain label when the media has one. */
function JobMenu() {
  const job = useGenerate((s) => s.draft.job);
  const mode = useGenerate((s) => s.draft.mode);
  const setDraft = useGenerate((s) => s.setDraft);
  const forSceneId = useGenerate((s) => s.draft.forScene);
  const scenes = useEditor((s) => s.doc.project.scenes);
  const jobs = jobsOf(mode);
  // Music for one scene (Generate music for this scene) is a bed for that scene, not the whole video.
  const forScene = scenes.find((x) => x.id === forSceneId);
  const labelOf = (j: JobKind) => (j === 'music.bed' && job === 'music.bed' && forScene ? sceneMusicLabel(forScene.name) : JOB_UI[j].label);
  const detailOf = (j: JobKind) => (j === 'music.bed' && job === 'music.bed' && forScene ? `A track as long as “${forScene.name}”, placed there` : JOB_UI[j].detail);
  const ui = JOB_UI[job];
  if (jobs.length < 2) {
    return (
      <span className="gt-job-label" title={ui.detail}>
        <Icon name={ui.icon} size={13} />
        {ui.label}
      </span>
    );
  }
  return (
    <Chip className="gt-job" icon={ui.icon} label={labelOf(job)} title="What to make" menu popClass="gt-pop gt-job-pop" testId="generate-job">
      {(close) =>
        jobs.map((j) => (
          <Option
            key={j}
            icon={JOB_UI[j].icon}
            label={labelOf(j)}
            detail={detailOf(j)}
            checked={j === job}
            testId={`generate-job-${j}`}
            onSelect={() => {
              setDraft({ job: j });
              close();
            }}
          />
        ))
      }
    </Chip>
  );
}

// ---------------------------------------------------------------------------
// Tiles: frames and references inside the composer
// ---------------------------------------------------------------------------

/** A frame of the video or an image, as a tile's picture: drawn live, or the image cropped to the tile. */
function TilePicture({ frame, asset, project }: { frame?: FrameSource; asset?: Asset; project: Project }) {
  if (frame && 'projectFrame' in frame) return <SceneThumb project={project} frame={frame.projectFrame} className="gt-tile-scene" />;
  const a = asset ?? (frame ? project.assets[frame.assetId] : undefined);
  if (!a) return <Icon name="warning" size={14} />;
  return a.kind === 'video' ? <video src={`${assetSrc(a)}#t=0.5`} muted playsInline preload="metadata" /> : <img src={assetSrc(a)} alt="" loading="lazy" decoding="async" draggable={false} />;
}

/**
 * What a tile can take: frames of the video (either side of the cut after the
 * selected scene, the playhead), the selected image, the project's images (and
 * clips, for a subject), or a file from the computer.
 */
function MediaPicker({ frames, kinds, chosen, onFrame, onAssets, close }: { frames?: boolean; kinds: readonly AssetKind[]; chosen?: (a: Asset) => boolean; onFrame?: (f: FrameSource) => void; onAssets: (ids: string[]) => void; close: () => void }) {
  const project = useEditor((s) => s.doc.project);
  const sceneId = useEditor((s) => s.selection.sceneId);
  const playhead = useEditor((s) => s.playhead);
  const selected = useEditor(selectedImageAssetId);
  const [busy, setBusy] = useState(false);
  const media = useMemo(() => Object.values(project.assets).filter((a) => kinds.includes(a.kind)).reverse(), [project.assets, kinds]);
  const videoFrames: { label: string; frame: FrameSource; title: string }[] = [];
  if (frames && onFrame) {
    const cut = cutAfter(project, sceneId);
    if (cut) {
      videoFrames.push({ label: `End of ${cut.scene.name}`, frame: sceneEdgeFrame(project, cut.scene, 'end'), title: `The last frame of “${cut.scene.name}”` });
      if (cut.next) videoFrames.push({ label: `Start of ${cut.next.name}`, frame: sceneEdgeFrame(project, cut.next, 'start'), title: cut.entrance ? `The first frame of “${cut.next.name}” once its ${cut.entrance} has finished` : `The first frame of “${cut.next.name}”` });
    }
    if (!videoFrames.some((f) => sameFrame(f.frame, { projectFrame: playhead }))) videoFrames.push({ label: 'At the playhead', frame: pickedFrame(project, playhead), title: frameSourceLabel({ projectFrame: playhead }, project) });
  }
  const upload = async () => {
    const file = await pickFile(acceptFor(kinds));
    if (!file) return;
    setBusy(true);
    const added = await addReferenceFiles([file], kinds);
    setBusy(false);
    if (added.length) {
      onAssets(added.map((a) => a.id));
      close();
    }
  };
  return (
    <div className="gt-picker">
      {videoFrames.length > 0 && (
        <>
          <PopLabel>From the video</PopLabel>
          <div className="gt-picker-frames">
            {videoFrames.map((f) => (
              <button
                key={f.label}
                type="button"
                className="gt-picker-frame"
                title={f.title}
                onClick={() => {
                  onFrame!(f.frame);
                  close();
                }}
              >
                <SceneThumb project={project} frame={(f.frame as { projectFrame: number }).projectFrame} className="gt-picker-scene" />
                <span>{f.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
      <PopLabel>{kinds.includes('video') ? 'Project images and clips' : 'Project images'}</PopLabel>
      {selected && kinds.includes('image') && (
        <button
          type="button"
          className="pop-opt"
          data-testid="generate-use-selected"
          onClick={() => {
            onAssets([selected]);
            close();
          }}
        >
          <span className="pop-opt-mark" aria-hidden>
            <Icon name="pointer" size={13} />
          </span>
          <span className="pop-opt-text">
            <span className="pop-opt-label">Use the selected image</span>
          </span>
        </button>
      )}
      {media.length === 0 ? (
        <p className="gt-picker-empty">No {kinds.includes('video') ? 'images or clips' : 'images'} in this project yet.</p>
      ) : (
        <ul className="gt-picker-grid">
          {media.map((a) => {
            const on = chosen?.(a) ?? false;
            return (
              <li key={a.id}>
                <button
                  type="button"
                  className={`gt-picker-item${on ? ' on' : ''}`}
                  aria-pressed={on}
                  aria-label={a.name}
                  title={a.name}
                  data-testid={`generate-pick-${a.id}`}
                  onClick={() => {
                    onAssets([a.id]);
                    close();
                  }}
                >
                  <TilePicture asset={a} project={project} />
                  {a.kind === 'video' && (
                    <span className="gt-tile-play" aria-hidden>
                      <Icon name="play" size={8} />
                    </span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <button type="button" className="btn small gt-picker-upload" disabled={busy} onClick={() => void upload()}>
        <Icon name="upload" size={13} />
        {busy ? 'Uploading…' : 'Upload from computer…'}
      </button>
    </div>
  );
}

/**
 * One tile: its picture (or an empty well with a plus), a caption under it, a
 * remove mark on hover, and a popover to change it on click. Media dropped on
 * it go to it; the pointer resting on it shows the picture larger.
 */
function Tile({ caption, title, picture, asset, empty, warn, shape, onDropIds, onRemove, popTitle, pop, testId }: { caption: string; title?: string; picture?: ReactNode; asset?: Asset; empty?: boolean; warn?: boolean; shape?: number; onDropIds: (ids: string[]) => void; onRemove?: () => void; popTitle: string; pop: (close: () => void) => ReactNode; testId: string }) {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const drop = useMediaDrop(onDropIds, MEDIA);
  // A frame tile has the video's shape; a reference is square; all are as tall.
  const width = shape ? Math.round(Math.min(116, Math.max(36, TILE_H * shape))) : TILE_H;
  return (
    <div className={`gt-tile${empty ? ' is-empty' : ''}${warn ? ' warn' : ''}${drop.over ? ' over' : ''}`} style={{ width }} data-testid={testId} {...drop.handlers}>
      <button
        ref={setAnchor}
        type="button"
        className="gt-tile-pic"
        style={{ height: TILE_H }}
        aria-label={empty ? `Pick the ${caption.toLowerCase()}` : `${caption}: ${title ?? ''}. Change`}
        aria-expanded={open}
        title={title}
        draggable={!!asset}
        onDragStart={(e) => asset && startAssetDrag(e, asset, e.currentTarget)}
        onClick={() => setOpen(!open)}
        {...peekProps(asset)}
      >
        {empty ? <Icon name="plus" size={16} /> : picture}
        {asset?.kind === 'video' && (
          <span className="gt-tile-play" aria-hidden>
            <Icon name="play" size={8} />
          </span>
        )}
        {drop.uploading > 0 && <span className="gt-tile-busy">Uploading…</span>}
      </button>
      {onRemove && !empty && (
        <button type="button" className="gt-tile-x" aria-label={`Remove ${caption.toLowerCase()}`} title="Remove" onClick={onRemove}>
          <Icon name="close" size={10} />
        </button>
      )}
      <span className="gt-tile-cap" title={title ?? caption}>
        {caption}
      </span>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} label={popTitle} className="gt-pop gt-pick-pop">
        {pop(() => setOpen(false))}
      </Popover>
    </div>
  );
}

/** A frame slot (the image to animate, a first or last frame): picked from the video or the project, or dropped in. */
function FrameTile({ caption, value, onChange, optional, testId }: { caption: string; value?: FrameSource; onChange: (f: FrameSource | undefined) => void; optional?: boolean; testId: string }) {
  const project = useEditor((s) => s.doc.project);
  const name = value ? frameSourceLabel(value, project) : undefined;
  const asset = value && 'assetId' in value ? project.assets[value.assetId] : undefined;
  return (
    <Tile
      caption={caption}
      title={name}
      empty={!value}
      warn={!!value && !!frameWarning(value, project)}
      shape={project.width / project.height}
      asset={asset}
      picture={value && <TilePicture frame={value} project={project} />}
      onDropIds={(ids) => {
        const id = ids.find((i) => PICTURES.includes(project.assets[i]?.kind));
        if (id) onChange({ assetId: id });
      }}
      onRemove={optional || value ? () => onChange(undefined) : undefined}
      popTitle={`The ${caption.toLowerCase()}`}
      testId={testId}
      pop={(close) => <MediaPicker frames kinds={PICTURES} chosen={(a) => sameFrame(value, { assetId: a.id })} onFrame={onChange} onAssets={(ids) => onChange({ assetId: ids[0] })} close={close} />}
    />
  );
}

/** The add tile at the end of a list: pick or drop more. */
function AddTile({ caption, kinds, onIds, frames, onFrame, testId }: { caption: string; kinds: readonly AssetKind[]; onIds: (ids: string[]) => void; frames?: boolean; onFrame?: (f: FrameSource) => void; testId: string }) {
  return <Tile caption={caption} empty onDropIds={onIds} popTitle={caption} testId={testId} pop={(close) => <MediaPicker frames={frames} kinds={kinds} onFrame={onFrame} onAssets={onIds} close={close} />} />;
}

/** References to edit, combine or keep consistent: numbered tiles, then an add tile. */
function RefTiles({ kinds, max, names }: { kinds: readonly AssetKind[]; max?: number; names?: Map<string, string> }) {
  const ids = useGenerate((s) => s.draft.settings.referenceAssetIds) ?? [];
  const setDraft = useGenerate((s) => s.setDraft);
  const project = useEditor((s) => s.doc.project);
  const put = (referenceAssetIds: string[]) => setDraft({ settings: { referenceAssetIds } });
  const add = (more: string[]) => put([...new Set([...ids, ...more.filter((i) => kinds.includes(project.assets[i]?.kind))])]);
  return (
    <>
      {ids.map((id, i) => {
        const a = project.assets[id];
        const caption = names?.get(id) ?? (max === 1 ? 'Image' : `Image ${i + 1}`);
        const length = a?.kind === 'video' ? clipLength(a, project.fps) : null;
        return (
          <Tile
            key={id}
            caption={caption}
            title={a ? (length ? `${a.name} · ${length}` : a.name) : 'No longer in the project'}
            asset={a}
            warn={!a}
            picture={a ? <TilePicture asset={a} project={project} /> : <Icon name="warning" size={14} />}
            onDropIds={(more) => {
              const next = more.find((m) => kinds.includes(project.assets[m]?.kind));
              if (next) put(ids.map((x) => (x === id ? next : x)));
            }}
            onRemove={() => put(ids.filter((x) => x !== id))}
            popTitle={`Change ${caption.toLowerCase()}`}
            testId={`generate-ref-${id}`}
            pop={(close) => <MediaPicker kinds={kinds} chosen={(c) => c.id === id} onAssets={(sel) => put([...new Set(ids.map((x) => (x === id ? sel[0] : x)))])} close={close} />}
          />
        );
      })}
      {(max === undefined || ids.length < max) && <AddTile caption={max === 1 ? 'Image' : 'Add'} kinds={kinds} onIds={add} testId="generate-ref-add" />}
    </>
  );
}

/** Keyframes as tiles in time order, each with its time; a click changes the frame or the time, or removes it. */
function KeyframeTiles() {
  const s = useGenerate((st) => st.draft.settings);
  const setDraft = useGenerate((st) => st.setDraft);
  const project = useEditor((st) => st.doc.project);
  const keys = s.keyframes ?? [];
  const length = s.durationSeconds ?? BRIDGE_SECONDS;
  const set = (keyframes: PinnedFrame[]) => setDraft({ settings: { keyframes: sortKeyframes(keyframes) } });
  const add = (frame: FrameSource) => keys.length < KEYFRAME_COUNT.max && set([...keys, { frame, atSeconds: nextKeyframeTime(keys.map((k) => k.atSeconds), length) }]);
  const shape = project.width / project.height;
  return (
    <>
      {keys.map((k, i) => {
        const name = frameSourceLabel(k.frame, project);
        const asset = 'assetId' in k.frame ? project.assets[k.frame.assetId] : undefined;
        return (
          <Tile
            key={i}
            caption={secondsText(k.atSeconds)}
            title={`${name} at ${secondsText(k.atSeconds)}`}
            asset={asset}
            warn={!!frameWarning(k.frame, project)}
            shape={shape}
            picture={<TilePicture frame={k.frame} project={project} />}
            onDropIds={(ids) => {
              const id = ids.find((x) => PICTURES.includes(project.assets[x]?.kind));
              if (id) set(keys.map((x, j) => (j === i ? { ...x, frame: { assetId: id } } : x)));
            }}
            onRemove={() => set(keys.filter((_, j) => j !== i))}
            popTitle={`Keyframe at ${secondsText(k.atSeconds)}`}
            testId={`generate-keyframe-${i}`}
            pop={(close) => (
              <>
                <div className="gt-pop-row">
                  <span className="pop-label">At</span>
                  <CommitNumber value={k.atSeconds} min={0} max={length} step={0.1} unit="s" title="When the clip reaches this frame, in seconds from its start" testId={`generate-keyframe-time-${i}`} onCommit={(atSeconds) => set(keys.map((x, j) => (j === i ? { ...x, atSeconds } : x)))} />
                </div>
                <MediaPicker frames kinds={PICTURES} onFrame={(frame) => set(keys.map((x, j) => (j === i ? { ...x, frame } : x)))} onAssets={(ids) => set(keys.map((x, j) => (j === i ? { ...x, frame: { assetId: ids[0] } } : x)))} close={close} />
              </>
            )}
          />
        );
      })}
      {keys.length < KEYFRAME_COUNT.max && <AddTile caption="Add a frame" kinds={PICTURES} frames onFrame={add} onIds={(ids) => ids.forEach((id) => add({ assetId: id }))} testId="generate-keyframe-add" />}
    </>
  );
}

/** video.between: the cut its frames span, in words, or why there is none; and the cut after the selected scene, offered. */
function CutNote() {
  const s = useGenerate((st) => st.draft.settings);
  const setDraft = useGenerate((st) => st.setDraft);
  const project = useEditor((st) => st.doc.project);
  const sceneId = useEditor((st) => st.selection.sceneId);
  const across = acrossCut(project, s.start, s.end);
  const broken = brokenCut(project, s.start, s.end);
  const cut = cutAfter(project, sceneId);
  const lastScene = cut && !cut.next && !s.end ? cut.scene : null;
  const offer = cut?.next && across?.from.id !== cut.scene.id ? { scene: cut.scene, next: cut.next } : null;
  if (!across && !broken && !lastScene && !offer) return null;
  return (
    <div className="gt-media-note" data-testid="generate-cut">
      {across ? (
        <span className="gt-cut-text">
          Across the cut from {across.from.name} to {across.to.name}
        </span>
      ) : broken ? (
        <span className="warn">{broken}</span>
      ) : lastScene ? (
        <span>“{lastScene.name}” is the last scene, so there is no cut after it.</span>
      ) : null}
      {offer && (
        <button type="button" className="gt-link" data-testid="generate-use-cut" onClick={() => setDraft({ settings: { start: sceneEdgeFrame(project, offer.scene, 'end'), end: sceneEdgeFrame(project, offer.next, 'start') } })}>
          Use the cut after {offer.scene.name}
        </button>
      )}
    </div>
  );
}

/** video.long: an optional document or web page the clip is built from (https only), as a line in the composer. */
function LinkRow() {
  const s = useGenerate((st) => st.draft.settings);
  const setDraft = useGenerate((st) => st.setDraft);
  const put = (patch: JobSettings) => setDraft({ settings: patch });
  const web = s.webUrl !== undefined;
  const url = (web ? s.webUrl : s.documentUrl) ?? '';
  return (
    <div className="gt-link-row">
      <Icon name="link" size={14} />
      <Segmented
        label="Build the clip from"
        value={web ? 'web' : 'document'}
        options={[
          { value: 'document', label: 'Document', title: 'A public PDF, slide deck or document' },
          { value: 'web', label: 'Web page', title: 'A public web page' },
        ]}
        onChange={(k) => put(k === 'web' ? { webUrl: url, documentUrl: undefined } : { documentUrl: url, webUrl: undefined })}
        testId={(k) => `generate-link-${k}`}
      />
      <CommitText className="gt-link-input" value={url} placeholder={web ? 'https://… (optional)' : 'https://….pdf (optional)'} testId="generate-link" title="Optional, https only. Leave it empty for a longer clip from the prompt alone." onCommit={(v) => put(web ? { webUrl: v.trim() } : { documentUrl: v.trim() })} />
    </div>
  );
}

/** Inside the composer above the prompt: what the job works from, as tiles, and a line about them. */
function MediaRow() {
  const job = useGenerate((st) => st.draft.job);
  const s = useGenerate((st) => st.draft.settings);
  const lost = useGenerate((st) => st.draft.lostFrames);
  const setDraft = useGenerate((st) => st.setDraft);
  const project = useEditor((st) => st.doc.project);
  const put = (patch: JobSettings) => setDraft({ settings: patch });
  const lostText = [lost?.start, lost?.end, lost?.keyframes].filter(Boolean).map((l) => `${l}. Pick another.`);
  const moved = [s.start, s.end, ...(s.keyframes ?? []).map((k) => k.frame)].map((f) => (f ? frameWarning(f, project) : null)).find(Boolean);

  // Lines under the tiles: plain words, a warning, or a whole note of their own (the cut).
  const say = (text: string, warn = false) => (
    <p key={text} className="gt-media-note">
      {warn ? <span className="warn">{text}</span> : text}
    </p>
  );
  let tiles: ReactNode = null;
  let notes: ReactNode[] = [];
  if (job === 'image.edit') tiles = <RefTiles kinds={PICTURES} max={1} />;
  else if (job === 'image.composite') {
    tiles = <RefTiles kinds={PICTURES} />;
    notes = [say('The first image sets the frame. Say in the prompt what to take from each.')];
  } else if (job === 'video.animate') tiles = <FrameTile caption="Image" value={s.start} onChange={(start) => put({ start })} testId="generate-start" />;
  else if (job === 'video.between') {
    tiles = (
      <>
        <FrameTile caption="First" value={s.start} onChange={(start) => put({ start })} testId="generate-start" />
        <span className="gt-tiles-arrow" aria-hidden>
          <Icon name="right" size={14} />
        </span>
        <FrameTile caption="Last" value={s.end} onChange={(end) => put({ end })} testId="generate-end" />
      </>
    );
    notes = [<CutNote key="cut" />];
  } else if (job === 'video.keyframes') tiles = <KeyframeTiles />;
  else if (job === 'video.reference') {
    const ids = s.referenceAssetIds ?? [];
    const names = referenceLabels(ids, project);
    const t = referenceTally(ids, project);
    const L = VIDEO_REFERENCE_LIMITS;
    const over = t.images > L.images || t.clips > L.clips || t.clipSeconds > L.clipSeconds;
    tiles = (
      <>
        <RefTiles kinds={MEDIA} names={names} />
        <span className="gt-tiles-gap" aria-hidden />
        <FrameTile caption="First" optional value={s.start} onChange={(start) => put({ start })} testId="generate-start" />
        <FrameTile caption="Last" optional value={s.end} onChange={(end) => put({ end })} testId="generate-end" />
      </>
    );
    notes = [
      say(names.size > 0 ? `Call them ${listText([...names.values()])} in the prompt. A first or last frame is optional.` : `Add images or clips of the subject: up to ${L.images} images and ${L.clips} clips.`),
      over ? say(`${t.images} of ${L.images} images, ${t.clips} of ${L.clips} clips, ${secondsText(Math.round(t.clipSeconds * 10) / 10)} of ${L.clipSeconds} s of video.`, true) : null,
    ];
  } else if (job === 'video.long') return <LinkRow />;
  if (!tiles) return null;
  return (
    <div className="gt-media-row" data-testid="generate-media">
      <div className="gt-tiles">{tiles}</div>
      {notes}
      {lostText.map((l) => say(l, true))}
      {moved && say(moved, true)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Setting chips
// ---------------------------------------------------------------------------

/** A ratio's shape, as a small outline. */
function RatioGlyph({ ratio }: { ratio: string }) {
  const [w, h] = ratio.split(':').map(Number);
  const r = w / h;
  return <span className="gt-ratio" style={r >= 1 ? { width: 14, height: Math.max(5, Math.round(14 / r)) } : { width: Math.max(5, Math.round(13 * r)), height: 13 }} aria-hidden />;
}

function AspectChip({ ratios }: { ratios: readonly string[] }) {
  const value = useGenerate((st) => st.draft.settings.aspectRatio);
  const setDraft = useGenerate((st) => st.setDraft);
  const project = useEditor((st) => st.doc.project);
  const fromVideo = aspectFor(project.width, project.height, ratios);
  const shown = value ?? fromVideo;
  return (
    <Chip glyph={<RatioGlyph ratio={shown} />} label={shown} title="Aspect ratio" menu popClass="gt-pop" testId="generate-aspect">
      {(close) => (
        <>
          <PopLabel>Aspect ratio</PopLabel>
          {ratios.map((r) => (
            <Option
              key={r}
              label={
                <>
                  <RatioGlyph ratio={r} /> {r}
                </>
              }
              figure={r === fromVideo ? 'the video’s' : undefined}
              checked={r === shown}
              testId={`generate-aspect-${r}`}
              onSelect={() => {
                setDraft({ settings: { aspectRatio: r } });
                close();
              }}
            />
          ))}
        </>
      )}
    </Chip>
  );
}

/** The length: typed, or one of the usual ones for the job (the scene, a bridge, the whole video, a hit). */
function LengthChip() {
  const draft = useGenerate((st) => st.draft);
  const setDraft = useGenerate((st) => st.setDraft);
  const project = useEditor((st) => st.doc.project);
  const sceneId = useEditor((st) => st.selection.sceneId);
  const job = draft.job;
  const put = (durationSeconds: number) => setDraft({ settings: { durationSeconds } });
  const video = draft.mode === 'video';
  const music = draft.mode === 'music';
  const range = video ? VIDEO_SECONDS : music ? { min: 3, max: 600 } : { min: 0.5, max: 22 };
  const usual: { seconds: number; label: string; detail?: string }[] = [];
  if (video) {
    const scene = project.scenes.find((x) => x.id === sceneId) ?? project.scenes[0];
    const fit = videoLengthFor(project, sceneId);
    const raw = sceneSeconds(project, sceneId);
    if (job === 'video.between' || job === 'video.keyframes') usual.push({ seconds: BRIDGE_SECONDS, label: `${BRIDGE_SECONDS} s ${job === 'video.between' ? 'transition' : 'bridge'}`, detail: 'Whatever the scene’s length' });
    if (scene && raw !== null) usual.push({ seconds: fit, label: `Fit “${scene.name}”`, detail: `The scene is ${secondsText(Math.round(raw * 10) / 10)}${Math.round(raw) !== fit ? `; clips run ${VIDEO_SECONDS.min}–${VIDEO_SECONDS.max} s` : ''}` });
  } else if (music) {
    // Music for one scene (Generate music for this scene): as long as that scene, and placed in it.
    const forScene = project.scenes.find((x) => x.id === draft.forScene);
    usual.push(forScene ? { seconds: sceneMusicSeconds(project, forScene.id), label: `All of “${forScene.name}”`, detail: 'The take is trimmed to the scene' } : { seconds: videoSeconds(project), label: 'The whole video' });
  }
  else if (job === 'sfx.ambience') usual.push({ seconds: 10, label: 'Ambience', detail: 'Long enough to loop' });
  else usual.push({ seconds: 2, label: 'A hit' });
  const value = draft.settings.durationSeconds ?? usual[0]?.seconds ?? range.min;
  return (
    <Chip icon="clock" label={secondsText(value)} title="Length" popClass="gt-pop" testId="generate-length">
      {(close) => (
        <>
          <div className="gt-pop-row">
            <span className="pop-label">Length</span>
            <CommitNumber value={value} min={range.min} max={range.max} step={video || music ? 1 : 0.5} unit="s" testId="generate-length-input" onCommit={put} />
          </div>
          {usual.map((u) => (
            <Option
              key={u.label}
              label={u.label}
              detail={u.detail}
              figure={secondsText(u.seconds)}
              checked={value === u.seconds}
              onSelect={() => {
                put(u.seconds);
                close();
              }}
            />
          ))}
        </>
      )}
    </Chip>
  );
}

function ResolutionChip() {
  const draft = useGenerate((st) => st.draft);
  const setDraft = useGenerate((st) => st.setDraft);
  if (draft.mode === 'video') {
    const value = draft.settings.videoResolution ?? '1080p';
    return (
      <Chip label={value} title="Resolution" menu popClass="gt-pop" testId="generate-video-resolution">
        {(close) =>
          VIDEO_RESOLUTIONS.map((r) => (
            <Option
              key={r.value}
              label={r.label}
              detail={r.detail}
              checked={r.value === value}
              testId={`generate-video-resolution-${r.value}`}
              onSelect={() => {
                setDraft({ settings: { videoResolution: r.value } });
                close();
              }}
            />
          ))
        }
      </Chip>
    );
  }
  const value = draft.settings.resolution ?? (draft.job === 'image.plate' ? '2k' : '1k');
  return (
    <Chip label={value.toUpperCase()} title="Resolution" menu popClass="gt-pop" testId="generate-resolution">
      {(close) =>
        RESOLUTIONS.map((r) => (
          <Option
            key={r.value}
            label={r.label}
            detail={r.detail}
            checked={r.value === value}
            testId={`generate-resolution-${r.value}`}
            onSelect={() => {
              setDraft({ settings: { resolution: r.value } });
              close();
            }}
          />
        ))
      }
    </Chip>
  );
}

function VoiceChip() {
  const value = useGenerate((st) => st.draft.settings.voice) ?? '';
  const setDraft = useGenerate((st) => st.setDraft);
  return (
    <Chip icon="mic" label={value || 'Default voice'} title="Voice" menu popClass="gt-pop gt-voice-pop" testId="generate-voice">
      {(close) =>
        VOICES.map((v) => (
          <Option
            key={v || 'default'}
            label={v || 'Model default'}
            checked={v === value}
            onSelect={() => {
              setDraft({ settings: { voice: v || undefined } });
              close();
            }}
          />
        ))
      }
    </Chip>
  );
}

/** An on/off setting as a chip: Instrumental, Loop. */
function ToggleChip({ label, on, title, onChange, testId }: { label: string; on: boolean; title: string; onChange: (v: boolean) => void; testId: string }) {
  return (
    <button type="button" className={`chip-btn toggle${on ? ' on' : ''}`} aria-pressed={on} title={title} data-testid={testId} onClick={() => onChange(!on)}>
      <Icon name={on ? 'check' : 'plus'} size={12} />
      <span className="chip-label">{label}</span>
    </button>
  );
}

function TakesChip() {
  const takes = useGenerate((s) => s.draft.takes);
  const setDraft = useGenerate((s) => s.setDraft);
  return (
    <Chip icon="copy" label={`×${takes}`} title="Takes per request: each is a separate result to pick from, and each is paid for" menu popClass="gt-pop" testId="generate-takes">
      {(close) => (
        <>
          <PopLabel>Takes · each is paid for</PopLabel>
          {Array.from({ length: MAX_TAKES }, (_, i) => i + 1).map((n) => (
            <Option
              key={n}
              label={takesText(n)}
              checked={n === takes}
              testId={`generate-takes-${n}`}
              onSelect={() => {
                setDraft({ takes: n });
                close();
              }}
            />
          ))}
        </>
      )}
    </Chip>
  );
}

/** BPM the person may set: within what music is written at. */
const BPM = { min: 40, max: 240 } as const;

/** music.scored: the tempo, typed, or left to the music; it also judges how the cuts sit on the downbeats. */
function TempoChip() {
  const bpm = useGenerate((st) => st.draft.settings.bpm);
  const setDraft = useGenerate((st) => st.setDraft);
  const set = (text: string) => {
    const n = Math.round(Number(text.trim()));
    if (!text.trim()) setDraft({ settings: { bpm: undefined } });
    else if (Number.isFinite(n) && n >= BPM.min && n <= BPM.max) setDraft({ settings: { bpm: n } });
  };
  return (
    <Chip icon="clock" label={bpm ? `${bpm} BPM` : 'Any tempo'} title="Tempo" on={!!bpm} popClass="gt-pop" testId="generate-tempo">
      {(close) => (
        <>
          <div className="gt-pop-row">
            <span className="pop-label">BPM</span>
            <CommitText value={bpm ? String(bpm) : ''} placeholder="Any" title={`Beats per minute, ${BPM.min}–${BPM.max}; leave it empty to let the music choose`} testId="generate-bpm" onCommit={set} />
          </div>
          <Option
            label="Let the music choose"
            checked={!bpm}
            onSelect={() => {
              setDraft({ settings: { bpm: undefined } });
              close();
            }}
          />
        </>
      )}
    </Chip>
  );
}

/** The model: the router's pick for the policy (Auto), or the person's choice; the policy sits at the popover's top. */
function ModelChip() {
  const draft = useGenerate((s) => s.draft);
  const setDraft = useGenerate((s) => s.setDraft);
  const models = useGenerate((s) => s.models);
  const status = useGenerate((s) => s.status);
  // The router's pick for the last priced request (it can differ from the plain default, e.g. with many references).
  const quote = useGenerate((s) => (s.quoteFor?.job === s.draft.job ? s.quote : null));
  const route = models?.jobs.find((j) => j.job === draft.job);
  const policy = draft.policy ?? status?.settings.policy ?? models?.policy ?? 'quality';
  // Why the router picked that model, in words: Balanced's evidence (or its lack) even before a prompt is priced.
  const reason = useGenerate((s) => routeReason(s, policy));
  const defaultId = route?.defaults[policy];
  // The router's pick for the last priced request, else the policy's default.
  const routed = route?.models.find((m) => m.id === ((!draft.model && quote?.route.model) || defaultId));
  // A suggestion accepted in Settings › Generation › Models: the job's default for Quality and Balanced (Draft stays the cheapest).
  const accepted = !!defaultId && policy !== 'draft' && status?.settings.routeOverrides?.[draft.job] === defaultId;
  const chosen = draft.model ? route?.models.find((m) => m.id === draft.model) : undefined;
  const autoLabel = routed?.label ?? (quote && !draft.model ? quote.route.modelLabel : undefined);
  const label = chosen?.label ?? autoLabel ?? 'Model';
  return (
    <Chip className="gt-model" icon="box" label={label} title={reason ? `Model: ${label}. ${reason}` : 'Model'} on={!!chosen} popClass="gt-pop gt-model-pop" align="end" testId="generate-model" disabled={!route}>
      {(close) => (
        <>
          <div className="gt-pop-row">
            <span className="pop-label">Pick for</span>
            <Segmented label="Routing policy" value={policy} options={POLICIES} onChange={(p) => setDraft({ policy: p, model: null })} testId={(p) => `generate-policy-${p}`} />
          </div>
          {reason && (
            <p className="gt-pop-note" data-testid="generate-model-reason">
              {reason}
            </p>
          )}
          <PopLabel>Model</PopLabel>
          <Option
            label={autoLabel ? `Auto · ${autoLabel}` : 'Auto'}
            detail={[accepted ? 'Your default (accepted suggestion)' : POLICY_PICK[policy], routed?.priceLabel, routed?.license].filter(Boolean).join(' · ')}
            checked={!draft.model}
            testId="generate-model-auto"
            onSelect={() => {
              setDraft({ model: null });
              close();
            }}
          />
          {route?.models.map((m) => (
            <Option
              key={m.id}
              label={m.label}
              detail={m.available === false ? 'Not offered by fal right now' : [m.priceLabel, m.license].filter(Boolean).join(' · ')}
              checked={draft.model === m.id}
              disabled={m.available === false}
              testId={`generate-model-${m.id}`}
              onSelect={() => {
                setDraft({ model: m.id });
                close();
              }}
            />
          ))}
        </>
      )}
    </Chip>
  );
}

/** The job's settings as chips, then takes. */
function SettingChips() {
  const draft = useGenerate((s) => s.draft);
  const setDraft = useGenerate((s) => s.setDraft);
  const s = draft.settings;
  const put = (patch: JobSettings) => setDraft({ settings: patch });
  return (
    <>
      {draft.mode === 'video' && (
        <>
          <LengthChip />
          <AspectChip ratios={VIDEO_ASPECTS} />
          <ResolutionChip />
        </>
      )}
      {draft.mode === 'image' && (
        <>
          <AspectChip ratios={ASPECT_RATIOS} />
          <ResolutionChip />
        </>
      )}
      {/* Scored music is as long as the video (its sections add up to it): the tempo, not a length. */}
      {draft.job === 'music.scored' && <TempoChip />}
      {draft.job === 'music.bed' && (
        <>
          <LengthChip />
          <ToggleChip label="Instrumental" on={s.instrumental ?? true} title="No vocals" onChange={(instrumental) => put({ instrumental })} testId="generate-instrumental" />
        </>
      )}
      {draft.mode === 'voice' && <VoiceChip />}
      {draft.mode === 'sfx' && (
        <>
          <LengthChip />
          {draft.job === 'sfx.ambience' && <ToggleChip label="Loop" on={s.loop ?? true} title="Loops seamlessly" onChange={(loop) => put({ loop })} testId="generate-loop" />}
        </>
      )}
      <TakesChip />
    </>
  );
}

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

/** What a confirmation is given for: the model and the price. A requote that changes either needs its own. */
const quoteKey = (q: GenerationQuote) => JSON.stringify([q.route.model, q.estimate.usd, q.estimate.basis, q.needsConfirm]);

/** The Generate button with the price; a price over the threshold takes a second click (Confirm). */
function GoButton({ armed, blocked, onClick }: { armed: boolean; blocked: boolean; onClick: () => void }) {
  const draft = useGenerate((s) => s.draft);
  const fresh = useGenerate(quoteFresh);
  const quote = useGenerate((s) => s.quote);
  const submitting = useGenerate((s) => s.submitting);
  // The project too: a reference clip's length or a removed image changes what is missing.
  const project = useEditor((s) => s.doc.project);
  const problem = draftProblem(draft, project);
  const over = fresh && !!quote?.overBudget;
  const refused = fresh && !quote;
  const usd = quote && !problem ? `~${formatUsd(quote.estimate.usd)}` : null;
  const title = problem ?? (quote ? `${quote.estimate.basis}. ⌘↵ in the prompt also starts it.` : '⌘↵ in the prompt also starts it.');
  return (
    <button type="button" className={`btn primary gt-go${armed ? ' armed' : ''}`} disabled={blocked || submitting || !!problem || over || refused} title={title} data-testid="generate-submit" onClick={onClick}>
      <Icon name={submitting ? 'loader' : 'sparkles'} size={13} className={submitting ? 'gt-spin' : undefined} />
      <span>{submitting ? 'Starting…' : armed ? 'Confirm' : 'Generate'}</span>
      {usd && !submitting && <span className="gt-go-price">{usd}</span>}
    </button>
  );
}

function Composer({ armed, blocked, onSubmit }: { armed: boolean; blocked: boolean; onSubmit: () => void }) {
  const draft = useGenerate((s) => s.draft);
  const setDraft = useGenerate((s) => s.setDraft);
  const hint = useGenerate((s) => s.models?.jobs.find((j) => j.job === s.draft.job)?.hint);
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [attachAnchor, setAttachAnchor] = useState<HTMLButtonElement | null>(null);
  const [attaching, setAttaching] = useState(false);
  const visual = draft.mode === 'image' || draft.mode === 'video';
  const drop = useMediaDrop(takeAssets, draft.mode === 'video' ? MEDIA : PICTURES);
  const sfx = draft.mode === 'sfx';
  // Narration by scene: the lines are the words, so they stand where the prompt goes (each line counts its own).
  const byLines = draft.job === 'voice.narration' && !!draft.settings.lines;
  const scored = draft.job === 'music.scored';
  const count = byLines ? null : draft.mode === 'voice' ? `${draft.prompt.length}` : sfx ? `${draft.prompt.length}/${SFX_PROMPT_MAX}` : null;
  const promptLabel = draft.mode === 'voice' ? 'Words to speak' : scored ? 'Genre and instruments' : 'Prompt';

  // The prompt grows with what is written, up to a point; then it scrolls.
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [draft.prompt]);

  // Sound takes no pictures: say so instead of the browser opening the file.
  const soundDrop = {
    onDragOver: (e: DragEvent) => {
      if (e.dataTransfer.types.length) e.preventDefault();
    },
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      useEditor.getState().toast({ tone: 'info', message: 'Images and clips steer Image and Video. Switch to one of those to use them.' });
    },
  };

  return (
    <div className={`gt-box${drop.over ? ' over' : ''}`} data-testid="generate-composer" {...(visual ? drop.handlers : soundDrop)}>
      <div className="gt-box-head">
        <JobMenu />
        {drop.uploading > 0 && <span className="gt-uploading">Uploading {drop.uploading === 1 ? 'a file' : `${drop.uploading} files`}…</span>}
        <span className="gt-spacer" />
        <ModelChip />
      </div>
      {draft.regenerateOf && (
        <p className="gt-again" data-testid="generate-again">
          Like an earlier request.{' '}
          <button type="button" className="gt-link" onClick={() => setDraft({ regenerateOf: undefined })}>
            Start fresh
          </button>
        </p>
      )}
      <ForSceneNote />
      <MediaRow />
      {scored && <ScorePlan />}
      {byLines ? (
        <NarrationLines onSubmit={onSubmit} />
      ) : (
        <textarea
          ref={area}
          id={id}
          className="gt-prompt"
          rows={3}
          value={draft.prompt}
          placeholder={hint ?? FALLBACK_JOB_HINT[draft.job] ?? FALLBACK_HINT[draft.mode]}
          aria-label={promptLabel}
          maxLength={sfx ? SFX_PROMPT_MAX : undefined}
          data-testid="generate-prompt"
          onChange={(e) => setDraft({ prompt: e.target.value })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onSubmit();
            }
          }}
        />
      )}
      <div className="gt-toolbar">
        <div className="gt-chips">
          {visual && (
            <>
              <button ref={setAttachAnchor} type="button" className="icon-btn small gt-attach" aria-label="Add an image" title={draft.mode === 'video' ? 'Add an image or clip to work from (or drop one here)' : 'Add an image to work from (or drop one here)'} aria-expanded={attaching} data-testid="generate-attach" onClick={() => setAttaching(!attaching)}>
                <Icon name="paperclip" size={14} />
              </button>
              <Popover anchor={attachAnchor} open={attaching} onClose={() => setAttaching(false)} label="Add an image" className="gt-pop gt-pick-pop">
                <MediaPicker kinds={draft.mode === 'video' ? MEDIA : PICTURES} onAssets={takeAssets} close={() => setAttaching(false)} />
              </Popover>
            </>
          )}
          <SettingChips />
        </div>
        {count && <span className={`gt-count${sfx && draft.prompt.length >= SFX_PROMPT_MAX ? ' full' : ''}`}>{count}</span>}
        <GoButton armed={armed} blocked={blocked} onClick={onSubmit} />
      </div>
      {drop.over && (
        <div className="gt-drop" aria-hidden>
          <Icon name="image" size={16} />
          {draft.mode === 'video' ? 'Drop to animate, bridge or pin frames; a clip keeps a subject' : 'Drop to edit or combine'}
        </div>
      )}
    </div>
  );
}

/** Under the composer, one line: what is missing, or the price's basis; today's spend at its end. */
function StatusLine({ armed }: { armed: boolean }) {
  const draft = useGenerate((s) => s.draft);
  const fresh = useGenerate(quoteFresh);
  const quote = useGenerate((s) => s.quote);
  const quoteError = useGenerate((s) => s.quoteError);
  const submitError = useGenerate((s) => s.submitError);
  const status = useGenerate((s) => s.status);
  const confirmOver = status?.settings.confirmOverUsd;
  const project = useEditor((s) => s.doc.project);
  const problem = draftProblem(draft, project);
  const over = fresh && !!quote?.overBudget;
  const refused = fresh && !quote;
  const spend = status?.spendTodayUsd ?? 0;
  const budget = status?.settings.dailyBudgetUsd ?? 0;
  const why = problem ? (
    <span>{problem}</span>
  ) : over ? (
    <span className="warn">
      Over today’s budget ({budgetText(quote!.budgetUsd)}).{' '}
      <button type="button" className="gt-link" onClick={() => openGenerationSettings('spending')}>
        Change it
      </button>
    </span>
  ) : armed ? (
    <span className="warn">More than {budgetText(confirmOver ?? 1)} for one request: Confirm to start, or press Escape.</span>
  ) : refused && quoteError ? (
    <span className="warn">{quoteError}</span>
  ) : quote ? (
    <span data-testid="generate-basis" title={quote.estimate.basis}>
      {quote.estimate.basis}
      {quote.estimate.reserve && !/reserve/i.test(quote.estimate.basis) ? ' · a budget reserve, not a list price' : ''}
    </span>
  ) : null;
  return (
    <>
      <div className="gt-status">
        <span className="gt-why">{why}</span>
        {status && (
          <button type="button" className={`gt-spend${budget > 0 && spend >= budget * 0.8 ? ' near' : ''}`} title="Spent on fal today (your local day), of the daily budget. Change the budget in Settings." data-testid="generate-spend" onClick={() => openGenerationSettings('spending')}>
            {formatUsd(spend)} of {budgetText(budget)} today
          </button>
        )}
      </div>
      {submitError && (
        <p className="gt-error" role="alert" data-testid="generate-error">
          {submitError}
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Inside the composer: scored music's plan and narration's lines (Phase C)
// ---------------------------------------------------------------------------

/** Music made for one scene (Generate music for this scene): a line at the composer's top saying so, with the way back to the whole video. */
function ForSceneNote() {
  const job = useGenerate((st) => st.draft.job);
  const forSceneId = useGenerate((st) => st.draft.forScene);
  const setDraft = useGenerate((st) => st.setDraft);
  const project = useEditor((st) => st.doc.project);
  const forScene = job === 'music.bed' ? project.scenes.find((x) => x.id === forSceneId) : undefined;
  if (!forScene) return null;
  return (
    <p className="gt-again" data-testid="generate-for-scene">
      For “{forScene.name}”: Use this take places it there.{' '}
      <button type="button" className="gt-link" onClick={() => setDraft({ forScene: undefined, settings: { durationSeconds: videoSeconds(project) } })}>
        Make it for the whole video
      </button>
    </p>
  );
}

/**
 * music.scored, where tiles go: the plan, a section per scene (short scenes
 * share one), each its scenes, length and direction; the sections add up to
 * the video and follow its scenes. The genre and instruments are the prompt.
 */
function ScorePlan() {
  const sections = useGenerate((st) => st.draft.settings.score) ?? [];
  const setDraft = useGenerate((st) => st.setDraft);
  const project = useEditor((st) => st.doc.project);
  const total = sections.reduce((t, x) => t + x.seconds, 0);
  // What the model can't take (too many sections, too long a video), said here by the plan; the status line says it too.
  const limit = sections.length ? planProblem(sections) : null;
  const setStyles = (i: number, styles: string[]) => setDraft({ settings: { score: sections.map((x, j) => (j === i ? { ...x, styles } : x)) } });
  return (
    <div className="gt-plan" role="group" aria-label="Sections" data-testid="generate-score">
      <div className="gt-plan-head">
        <span className="gt-plan-title">{sections.length === 1 ? '1 section' : `${sections.length} sections`}</span>
        <span className="gt-plan-sum" title="The sections add up to the video’s length">
          {tenths(total)}, the whole video
        </span>
      </div>
      {sections.length > 0 ? (
        <ol className="gt-score">
          {sections.map((x, i) => {
            const names = sectionScenes(project, x);
            return (
              <li key={`${x.sceneIds.join(' ')}#${i}`} className="gt-score-row" data-testid={`generate-score-${i}`}>
                <span className="gt-score-scene" title={names}>
                  {names}
                </span>
                <span className="gt-score-len">{tenths(x.seconds)}</span>
                <CommitText value={x.styles.join(', ')} className="gt-score-styles" placeholder="Its feel, e.g. quiet, building, drop the drums" title={`How the music feels in ${names}, comma-separated`} testId={`generate-score-styles-${i}`} onCommit={(v) => setStyles(i, parseStyles(v))} />
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="gt-media-note">No scenes yet: the music follows the scenes.</p>
      )}
      {limit && (
        <p className="gt-media-note" data-testid="generate-score-limit">
          <span className="warn">{limit}</span>
        </p>
      )}
      <p className="gt-media-note">The music changes at each cut. Scenes under 3 s share a section with the next. Each section follows its scene as the video changes.</p>
    </div>
  );
}

/**
 * voice.narration, where the prompt goes: a line per scene, prefilled from the
 * story; each says how long it takes to say, and warns gently when that runs
 * past its scene. ⌘↵ in any line starts the request, as in the prompt.
 */
function NarrationLines({ onSubmit }: { onSubmit: () => void }) {
  const lines = useGenerate((st) => st.draft.settings.lines) ?? [];
  const forScene = useGenerate((st) => st.draft.forScene);
  const setDraft = useGenerate((st) => st.setDraft);
  const project = useEditor((st) => st.doc.project);
  const id = useId();
  const put = (i: number, text: string) => setDraft({ settings: { lines: lines.map((l, j) => (j === i ? { ...l, text } : l)) } });
  // More like this on one line's take: that line only, until the person asks for every scene's again.
  const only = forScene ? project.scenes.find((x) => x.id === forScene) : undefined;
  return (
    <div className="gt-lines-box" role="group" aria-label="Narration, a line per scene" data-testid="generate-lines">
      {forScene && (
        <p className="gt-media-note" data-testid="generate-lines-one">
          {only ? `Only “${only.name}”: more takes of its line.` : 'The scene this line was for is gone.'}
          <button type="button" className="gt-link" onClick={() => setDraft({ forScene: undefined, settings: { lines: mergeNarrationLines(lines, narrationLines(project)) } })}>
            Write a line for every scene
          </button>
        </p>
      )}
      {lines.length === 0 && !forScene && <p className="gt-media-note">No scenes yet: narration is written a line per scene.</p>}
      <ol className="gt-lines">
        {lines.map((l, i) => {
          const scene = project.scenes.find((x) => x.id === l.sceneId);
          const fit = lineFit(project, l);
          return (
            <li key={l.sceneId} className="gt-line" data-testid={`generate-line-${i}`}>
              <label className="gt-line-head" htmlFor={`${id}-${i}`}>
                <span className="gt-line-scene">{scene?.name ?? 'A deleted scene'}</span>
                <span className={`gt-count${fit.long ? ' full' : ''}`} data-testid={`generate-line-count-${i}`}>
                  {fit.chars} {fit.chars === 1 ? 'character' : 'characters'}
                  {fit.chars > 0 && ` · about ${tenths(fit.seconds)}`}
                </span>
              </label>
              <textarea
                id={`${id}-${i}`}
                className="gt-line-text"
                rows={2}
                value={l.text}
                placeholder="Leave empty for no narration here"
                data-testid={`generate-line-text-${i}`}
                onChange={(e) => put(i, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    onSubmit();
                  }
                }}
              />
              {fit.long && fit.sceneSeconds !== null && (
                <p className="gt-media-note" data-testid={`generate-line-long-${i}`}>
                  <span className="warn">Likely longer than the scene ({tenths(fit.sceneSeconds)}): shorten the line, or lengthen the scene.</span>
                </p>
              )}
            </li>
          );
        })}
      </ol>
      <p className="gt-media-note">Each line becomes its own take, tagged with its scene; empty lines are skipped. Timed at about {SPOKEN_CHARS_PER_SECOND} characters a second.</p>
    </div>
  );
}

/** Instead of a working button: the server is down, or there is no usable key. */
function Blocked() {
  const link = useGenerate((s) => s.link);
  const key = useGenerate((s) => s.status?.key);
  if (link === 'offline') {
    return (
      <div className="notice gt-callout" data-testid="generate-offline">
        <p>The local server isn’t running.</p>
        <p className="fine">Start it with npm run dev. What you write here is kept.</p>
      </div>
    );
  }
  if (key && !key.configured) {
    return (
      <div className="notice gt-callout" data-testid="generate-no-key">
        <p>Add your fal API key in Settings › Generation to generate music, voice, sound, images and video.</p>
        <button type="button" className="btn small" data-testid="generate-add-key" onClick={() => openGenerationSettings('falKey')}>
          Add key
        </button>
      </div>
    );
  }
  if (key?.valid === false) {
    return (
      <div className="notice gt-callout" data-testid="generate-bad-key">
        <p>fal did not accept the saved key{key.error ? `: ${key.error}` : '.'}</p>
        <button type="button" className="btn small" onClick={() => openGenerationSettings('falKey')}>
          Check the key
        </button>
      </div>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Recent jobs
// ---------------------------------------------------------------------------

/** Ticks once a second while `on`, for elapsed times. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

function statusText(job: GenerationJob): string {
  switch (job.status) {
    case 'awaiting-permission':
      return 'Waiting for permission';
    case 'queued':
      // fal counts from 0 (next up).
      return job.queuePosition !== undefined ? `Queued (position ${job.queuePosition + 1})` : 'Queued';
    case 'running':
      return 'Generating';
    case 'importing':
      return 'Importing';
    case 'done':
      return takesText(job.outputs.length);
    case 'failed':
      return job.error?.type === 'interrupted' ? 'Interrupted (server restarted)' : `Failed: ${job.error?.message ?? 'no reason given'}`;
    case 'cancelled':
      return 'Cancelled';
    case 'denied':
      return 'Declined';
  }
}

/** What it cost (from fal's billing) or is estimated to cost; failures fal does not bill say so. */
function costText(job: GenerationJob): string | null {
  if (job.actualUsd !== undefined) return formatUsd(job.actualUsd);
  if (job.billed === false) return 'not billed';
  if (job.status === 'done' || ACTIVE.includes(job.status)) return `${job.estimate.reserve ? '≈' : '~'}${formatUsd(job.estimate.usd)}`;
  return null;
}

/** A job's results: pictures to look at larger or drag into the prompt; sound to play. */
function Outputs({ job, project }: { job: GenerationJob; project: Project }) {
  const shown = job.outputs.slice(0, 6);
  if (!shown.length) return null;
  return (
    <div className="gt-outs">
      {shown.map((o) => {
        const a = project.assets[o.id] ?? o;
        if (a.kind === 'audio') {
          return (
            <span key={o.id} className="gt-out audio">
              <AudioPlayButton src={a.src} name={a.name} testId={`generate-out-play-${o.id}`} />
            </span>
          );
        }
        const inProject = !!project.assets[o.id];
        return (
          <span key={o.id} className="gt-out" draggable={inProject} title={inProject ? `${a.name}: drag into the prompt to work from it` : a.name} onDragStart={(e) => startAssetDrag(e, a, e.currentTarget)} {...peekProps(a)}>
            {a.kind === 'video' ? <video src={`${assetSrc(a)}#t=0.5`} muted playsInline preload="metadata" /> : <img src={assetSrc(a)} alt="" loading="lazy" decoding="async" draggable={false} />}
            {a.kind === 'video' && (
              <span className="gt-tile-play" aria-hidden>
                <Icon name="play" size={8} />
              </span>
            )}
          </span>
        );
      })}
    </div>
  );
}

/** A Place or Snap button: disabled with its reason as the tooltip, like Use this take. */
function TakeButton({ action, testId, onClick }: { action: TakeAction; testId: string; onClick: () => void }) {
  return (
    <button type="button" className="mini-btn" disabled={!!action.why} title={action.why ?? `${action.summary}: opens the review, nothing changes until Apply`} data-testid={testId} onClick={onClick}>
      {action.label}
    </button>
  );
}

/**
 * Under a finished scored or narration job whose takes are in the project: a
 * scored take's cut alignment with Place as bed and Snap cuts to downbeats
 * (measured against that take where it plays as the bed); narration's Place
 * at scenes. Each click works the action out again against the video as it
 * is then, and proposes it.
 */
function JobPlacements({ job, project }: { job: GenerationJob; project: Project }) {
  if (job.job === 'music.scored') {
    const takes = job.outputs.filter((a) => project.assets[a.id]);
    return (
      <ul className="gt-job-takes">
        {takes.map((a, i) => {
          const meta = outputMetaOf(job, a.id);
          const bpm = meta?.bpm ?? job.settings.bpm ?? null;
          // The clip playing this take as the bed: its start and in-point move the downbeats; Snap waits for it.
          const bed = placedBed(project, a.id);
          const cuts = currentCuts(project, meta, bpm, bed);
          const text = [takes.length > 1 ? `Take ${i + 1}` : null, cuts ? alignmentText(cuts) : null, bpm ? `${Math.round(bpm)} BPM` : null].filter(Boolean).join(' · ');
          return (
            <li key={a.id} className="gt-job-take">
              {text && (
                <span className="gt-job-align" data-testid={`generate-alignment-${a.id}`}>
                  {text}
                </span>
              )}
              <span className="gt-job-place">
                <TakeButton action={bedAction(project, a)} testId={`generate-place-bed-${a.id}`} onClick={() => proposeAction((p) => bedAction(p, p.assets[a.id] ?? a))} />
                {cuts && (
                  <TakeButton
                    action={snapAction(project, cuts, bed?.id)}
                    testId={`generate-snap-${a.id}`}
                    onClick={() =>
                      proposeAction((p) => {
                        const now = placedBed(p, a.id);
                        return snapAction(p, currentCuts(p, meta, bpm, now) ?? [], now?.id);
                      })
                    }
                  />
                )}
              </span>
            </li>
          );
        })}
      </ul>
    );
  }
  if (job.job === 'voice.narration' && job.outputs.some((a) => outputMetaOf(job, a.id)?.sceneId)) return <NarrationPlacements job={job} project={project} />;
  return null;
}

/**
 * Narration's Place at scenes. When a line has several takes, a picker per
 * scene first (each take playable; the first not in the video to start
 * with), so the person chooses which take each scene gets.
 */
function NarrationPlacements({ job, project }: { job: GenerationJob; project: Project }) {
  const [picks, setPicks] = useState<TakePicks>({});
  const scenes = narrationScenes(project, job);
  const used = takeUsage(project);
  const several = scenes.some((s) => s.takes.length > 1);
  return (
    <>
      {several && (
        <ul className="gt-job-picks" aria-label="The take for each scene" data-testid={`generate-picks-${job.id}`}>
          {scenes.map((s) => {
            const name = project.scenes.find((x) => x.id === s.sceneId)?.name ?? 'A scene';
            const take = pickedTake(s.takes, picks[s.sceneId], used);
            return (
              <li key={s.sceneId} className="gt-job-pick">
                <AudioPlayButton src={take.src} name={take.name} />
                <span className="gt-job-pick-scene" title={name}>
                  {name}
                </span>
                {s.takes.length > 1 ? (
                  <select
                    className="input select gt-job-pick-take"
                    aria-label={`Take for ${name}`}
                    value={take.id}
                    data-testid={`generate-pick-${job.id}-${s.sceneId}`}
                    onChange={(e) => setPicks((p) => ({ ...p, [s.sceneId]: e.target.value }))}
                  >
                    {s.takes.map((t, i) => (
                      <option key={t.id} value={t.id}>
                        Take {i + 1}
                        {used.get(t.id) ? ' · in the video' : ''}
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="gt-job-pick-one">{used.get(take.id) ? 'In the video' : 'One take'}</span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="gt-job-place">
        <TakeButton action={narrationAction(project, job, picks)} testId={`generate-place-scenes-${job.id}`} onClick={() => proposeAction((p) => narrationAction(p, job, picks))} />
      </div>
    </>
  );
}

function JobRow({ job, now, project, docSession }: { job: GenerationJob; now: number; project: Project; docSession: string }) {
  const active = ACTIVE.includes(job.status);
  // From the server's own start, so a reload or a restart does not reset the count.
  const elapsed = elapsedText(jobElapsedMs(job, now));
  const cost = costText(job);
  const by = job.requestedBy.origin === 'agent' ? `asked by ${job.requestedBy.agent ?? 'an agent'}` : null;
  // Delivered into a document since replaced (or undone): offered, never re-added by itself.
  const missing = missingTakes(job, project, docSession).length > 0;
  const note = missing ? 'Not in this project' : (job.note ?? carriedOverNote(job));
  const ui = JOB_UI[job.job];
  // Narration by scene: its first line, not the "Narration · 4 lines" label the request carries.
  const quoted = jobPromptText(job);
  return (
    <li className={`gt-job-row ${job.status}${job.error?.type === 'interrupted' ? ' interrupted' : ''}`} data-testid={`generate-job-row-${job.id}`}>
      <span className="gt-job-icon" aria-hidden>
        <Icon name={ui.icon} size={13} />
        <span className={`gt-dot${active ? ' active' : ''}`} />
      </span>
      <div className="gt-job-main">
        <div className="gt-job-title">
          {/* Music made for one scene says which ("Music for Show"). */}
          <span className="gt-job-name">{jobRowLabel(job, project, ui.label)}</span>
          <span className="gt-job-model">{job.modelLabel}</span>
        </div>
        {quoted && (
          <p className="gt-job-prompt" title={quoted.title}>
            {quoted.text}
          </p>
        )}
        <Outputs job={job} project={project} />
        <div className="gt-job-meta">
          <span className="gt-job-status">{statusText(job)}</span>
          {/* What the status alone does not say: "Cancelled after 2 of 4 takes", "Resumed after a restart", or that it began before this page opened. */}
          {note && (
            <span className="gt-job-note" data-testid={`generate-job-note-${job.id}`}>
              {' '}
              · {note}
            </span>
          )}
          {[elapsed, cost, by].filter(Boolean).map((m) => (
            <span key={m}> · {m}</span>
          ))}
        </div>
        {/* Scored: each take's cut alignment, Place as bed, Snap cuts to downbeats. Narration: Place at scenes. */}
        {job.status === 'done' && !missing && <JobPlacements job={job} project={project} />}
      </div>
      <div className="gt-job-actions">
        {CANCELLABLE.includes(job.status) && (
          <button type="button" className="mini-btn" data-testid={`generate-cancel-${job.id}`} onClick={() => void cancelGenerationJob(job.id)}>
            Cancel
          </button>
        )}
        {missing ? (
          <button type="button" className="mini-btn" data-testid={`generate-add-takes-${job.id}`} title="Add this job’s takes to Assets › Generated (one undo step)" onClick={() => void addMissingTakes(job)}>
            Add takes
          </button>
        ) : (
          job.status === 'done' &&
          job.outputs.length > 0 && (
            <button type="button" className="icon-btn small" aria-label="Show the takes in Assets" data-testid={`generate-show-${job.id}`} title="Show the takes in Assets › Generated, to use or rate" onClick={() => showInLibrary('generated')}>
              <Icon name="external" size={13} />
            </button>
          )
        )}
      </div>
    </li>
  );
}

/** This project's jobs, newest first; older ones fold away. */
function Jobs() {
  const project = useEditor((s) => s.doc.project);
  const docSession = useEditor((s) => s.docSession);
  const projectId = project.id;
  const all = useGenerate((s) => s.jobs);
  const [showOlder, setShowOlder] = useState(false);
  const jobs = useMemo(() => all.filter((j) => j.projectId === projectId), [all, projectId]);
  const now = useNow(jobs.some((j) => ACTIVE.includes(j.status)));
  const shown = showOlder ? jobs : jobs.slice(0, RECENT_JOBS);
  return (
    <section className="gt-recent" data-testid="generate-jobs">
      <header className="gt-recent-head">
        <h3>Recent</h3>
        {jobs.length > 0 && <span className="gt-recent-n">{jobs.length}</span>}
      </header>
      {jobs.length === 0 ? (
        <p className="gt-recent-empty">Requests from here, or from an agent, show here with their results. Takes land in Assets › Generated.</p>
      ) : (
        <ul className="gt-job-list">
          {shown.map((j) => (
            <JobRow key={j.id} job={j} now={now} project={project} docSession={docSession} />
          ))}
        </ul>
      )}
      {jobs.length > RECENT_JOBS && (
        <button type="button" className="mini-btn gt-older" aria-expanded={showOlder} onClick={() => setShowOlder(!showOlder)}>
          {showOlder ? 'Show fewer' : `Show ${jobs.length - RECENT_JOBS} older`}
        </button>
      )}
    </section>
  );
}

export function GenerateTab() {
  const draft = useGenerate((s) => s.draft);
  const link = useGenerate((s) => s.link);
  const blocked = useGenerate(isBlocked);
  const tab = useRef<HTMLDivElement>(null);
  const projectId = useEditor((s) => s.doc.project.id);
  const server = useEditor((s) => s.server);
  const settingsOpen = useLayout((s) => s.overlay === 'settings');
  // Budget, spend, reservations, policy, key: a change prices the draft again.
  const stamp = useGenerate((s) => statusStamp(s.status));
  const quote = useGenerate((s) => s.quote);
  /** The quote (quoteKey) the person was asked to confirm; the button is armed only while it is still the price. */
  const [armedFor, setArmedFor] = useState<string | null>(null);
  const armed = armedFor !== null && !!quote && quoteKey(quote) === armedFor;

  // On opening, when the server comes back, and when Settings closes (the key or budget may have changed).
  useEffect(() => {
    if (!settingsOpen) void loadGenerationStudio();
  }, [server, settingsOpen]);

  // Price the draft once typing settles, and again whenever the status changes (Settings closed, a job moved spend).
  useEffect(() => {
    if (link !== 'up') return;
    const t = setTimeout(() => void estimateDraft(), 300);
    return () => clearTimeout(t);
  }, [draft, projectId, link, stamp]);

  // A changed request or a changed price needs its own confirmation; an armed button gives up after 4 s.
  useEffect(() => setArmedFor(null), [draft]);
  useEffect(() => {
    if (armedFor !== null && !armed) setArmedFor(null);
  }, [armedFor, armed]);
  useEffect(() => {
    if (armedFor === null) return;
    const t = setTimeout(() => setArmedFor(null), 4000);
    return () => clearTimeout(t);
  }, [armedFor]);

  const go = async () => {
    const g = () => useGenerate.getState();
    if (blocked || g().submitting || draftProblem(g().draft)) return;
    // Typed, or the budget or spend moved, since the last price: price this exact request before deciding.
    if (!quoteFresh()) await estimateDraft();
    const { quote: now } = g();
    if (!now || !quoteFresh() || now.overBudget) return;
    const key = quoteKey(now);
    // The confirmation counts only for the price it was shown with.
    if (now.needsConfirm && armedFor !== key) return setArmedFor(key);
    setArmedFor(null);
    const job = await submitDraft(now.needsConfirm);
    // Bring the new job's row into view, as little as it takes.
    if (job) requestAnimationFrame(() => tab.current?.querySelector(`[data-testid="generate-job-row-${job.id}"]`)?.scrollIntoView({ block: 'nearest' }));
  };

  return (
    <div
      ref={tab}
      className="panel-scroll gt"
      data-testid="generate-tab"
      onKeyDown={(e) => {
        if (e.key === 'Escape' && armed) {
          e.stopPropagation();
          setArmedFor(null);
        }
      }}
    >
      <div className="gt-form">
        <div className="gt-top">
          <MediaSwitch />
          <button type="button" className="icon-btn small" aria-label="Generation settings" title="Generation settings: key, budget, confirmation" data-testid="generate-settings" onClick={() => openGenerationSettings()}>
            <Icon name="settings" size={14} />
          </button>
        </div>
        <Composer armed={armed} blocked={blocked} onSubmit={() => void go()} />
        {blocked ? <Blocked /> : <StatusLine armed={armed} />}
      </div>
      <Jobs />
    </div>
  );
}
