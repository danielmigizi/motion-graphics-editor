// Inspector section for video elements: the source strip (a scrubbable
// preview of the file with in/out handles over the part the element plays),
// exact In / Out / Speed fields, Mute, Loop, the preview-proxy state and
// "Detach audio". Every drag or edit commits ONE updateElement (or the one
// detachVideoAudio command) — one undo step. Volume, fit, corner radius and
// the file itself stay in the generic Properties section (volume animates).

import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { videoPreviewSrc } from '../composition/previewProxies';
import { newId } from '../core/ids';
import { framesToSeconds, resolveAssetUrl } from '../core/timing';
import type { ElementChanges, Element, Scene } from '../core/types';
import { detachedAudioClip, videoProps, videoSourceFrame } from '../core/video';
import { CheckField, NumberField, Row, Section, useFieldVisible } from './fields';
import { useEditor } from './store';
import { inPointChanges, loopChanges, outPointChanges, sourceRange, speedChanges } from './videoEdits';
import { previewState, useVideoProxyStatus } from './videoProxies';

/** Keys this section edits; the generic Properties list skips them for video elements. */
export const VIDEO_SECTION_KEYS: ReadonlySet<string> = new Set(['trimStartFrames', 'playbackRate', 'muted', 'loop']);

const SPEEDS = [0.5, 1, 1.5, 2];
const sec = (frames: number, fps: number) => `${framesToSeconds(frames, fps).toFixed(2)} s`;

type Drag = { edge: 'in' | 'out'; value: number } | null;

export function VideoSection({ scene, element, localFrame }: { scene: Scene; element: Element; localFrame: number }) {
  const project = useEditor((s) => s.doc.project);
  const run = useEditor((s) => s.run);
  const disabled = scene.locked;
  const v = videoProps(element);
  const asset = project.assets[v.assetId];
  const status = useVideoProxyStatus((s) => (asset ? s.bySrc[asset.src] : undefined));
  const range = sourceRange(element, project.assets);
  const fps = project.fps;
  const [drag, setDrag] = useState<Drag>(null);
  const [hover, setHover] = useState<number | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const update = (changes: ElementChanges | null, label: string) => changes && run({ type: 'updateElement', sceneId: scene.id, elementId: element.id, changes }, label);

  // What the preview shows: the dragged handle, else the hovered point, else the frame under the playhead (or the in-point).
  const inside = localFrame >= 0 && localFrame < element.durationInFrames;
  const playheadSource = inside ? videoSourceFrame(range.in, range.rate, localFrame, range.loop, range.length) : range.in;
  const shown = drag?.value ?? hover ?? playheadSource;
  const seekPreview = () => {
    const el = videoRef.current;
    if (!el || !Number.isFinite(shown)) return;
    const t = shown / fps + 0.001;
    if (Math.abs(el.currentTime - t) > 0.5 / fps) el.currentTime = t;
  };
  const previewSrc = asset ? resolveAssetUrl('/', videoPreviewSrc(asset, false)) : '';
  // Re-seek when the frame changes and whenever the file (re)loads, e.g. when its proxy arrives.
  useEffect(seekPreview, [shown, fps, previewSrc]);

  if (!asset || asset.kind !== 'video') {
    return (
      <Section title="Video" testId="video-section">
        <p className="fine">Choose a video file under Properties to trim it here.</p>
      </Section>
    );
  }

  const length = range.length ?? Math.max(range.out, range.in + 1);
  const pct = (f: number) => `${Math.max(0, Math.min(100, (f / length) * 100))}%`;
  const shownIn = drag?.edge === 'in' ? drag.value : range.in;
  const shownOut = drag?.edge === 'out' ? drag.value : Math.min(range.out, length);
  const frameAt = (clientX: number) => {
    const r = trackRef.current!.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(1, (clientX - r.left) / Math.max(1, r.width))) * length);
  };

  const beginHandle = (e: ReactPointerEvent, edge: 'in' | 'out') => {
    if (disabled || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const gesture = useEditor.getState().beginGesture();
    const clampEdge = (f: number) => (edge === 'in' ? Math.max(0, Math.min(f, range.out - range.rate)) : Math.max(range.in + range.rate, Math.min(f, length)));
    let value = edge === 'in' ? range.in : shownOut;
    setDrag({ edge, value });
    const move = (ev: PointerEvent) => {
      value = clampEdge(frameAt(ev.clientX));
      setDrag({ edge, value });
    };
    const up = (ev: PointerEvent) => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
      target.removeEventListener('pointercancel', up);
      gesture.end();
      setDrag(null);
      if (ev.type !== 'pointerup' || gesture.stale()) return;
      if (edge === 'in') update(inPointChanges(scene, element, project.assets, value), `Trim “${element.name}” in-point`);
      else update(outPointChanges(scene, element, project.assets, value), `Trim “${element.name}” out-point`);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  };

  const detach = detachedAudioClip(project, scene, element, 'aud_check');
  const preview = previewState(asset, status);

  return (
    <Section title="Video" testId="video-section" actions={<span className="hint-tag">{asset.width && asset.height ? `${asset.width}×${asset.height}` : 'video'}{asset.fps ? ` · ${Math.round(asset.fps)} fps` : ''}</span>}>
      <div className="video-trim" data-testid="video-trim">
        <div className="video-trim-preview">
          <video ref={videoRef} src={previewSrc} muted playsInline preload="auto" onLoadedMetadata={seekPreview} aria-label={`Source frame ${Math.round(shown)}`} />
          <span className="video-trim-time" data-testid="video-trim-time">
            {drag ? (drag.edge === 'in' ? 'In ' : 'Out ') : hover !== null ? '' : inside ? 'Playhead ' : 'In '}
            {sec(shown, fps)}
          </span>
        </div>
        <div
          ref={trackRef}
          className={`video-trim-track ${disabled ? 'locked' : ''}`}
          data-testid="video-trim-track"
          title="Hover to preview the source; drag the handles to trim"
          onPointerMove={(e) => !drag && setHover(frameAt(e.clientX))}
          onPointerLeave={() => setHover(null)}
        >
          <span className="video-trim-range" style={{ left: pct(shownIn), width: `calc(${pct(shownOut)} - ${pct(shownIn)})` }} />
          {inside && <span className="video-trim-playhead" style={{ left: pct(playheadSource) }} />}
          <span className="video-trim-handle in" style={{ left: pct(shownIn) }} role="slider" aria-label="In-point" aria-valuenow={Math.round(shownIn)} data-testid="video-trim-in" onPointerDown={(e) => beginHandle(e, 'in')} />
          <span className="video-trim-handle out" style={{ left: pct(shownOut) }} role="slider" aria-label="Out-point" aria-valuenow={Math.round(shownOut)} data-testid="video-trim-out" onPointerDown={(e) => beginHandle(e, 'out')} />
        </div>
        <div className="video-trim-scale fine">
          <span>0:00</span>
          <span>
            plays {sec(shownIn, fps)} → {sec(shownOut, fps)}
            {range.loop ? ' (loops)' : ''}
          </span>
          <span>{range.length !== undefined ? sec(range.length, fps) : '?'}</span>
        </div>
      </div>
      <div className="grid-2 pair">
        <NumberField id="v-in" label="In" inline searchKey="trimStartFrames" testId="video-field-in" value={range.in} integer min={0} max={range.length !== undefined ? range.length - 1 : undefined} unit="f" title={`Source in-point: ${sec(range.in, fps)}`} disabled={disabled} onCommit={(f) => update(inPointChanges(scene, element, project.assets, f), `Trim “${element.name}” in-point`)} />
        <NumberField id="v-out" label="Out" inline searchKey="trimEnd" testId="video-field-out" value={Math.round(range.out)} integer min={range.in + 1} max={range.length} unit="f" title={`Source out-point: ${sec(range.out, fps)}`} disabled={disabled} onCommit={(f) => update(outPointChanges(scene, element, project.assets, f), `Trim “${element.name}” out-point`)} />
      </div>
      <NumberField
        id="v-speed"
        label="Speed"
        searchKey="playbackRate"
        testId="video-field-speed"
        value={v.playbackRate}
        min={0.25}
        max={4}
        step={0.05}
        unit="×"
        disabled={disabled}
        onCommit={(s) => update(speedChanges(element, project.assets, s), `Set “${element.name}” speed to ${s}×`)}
      />
      <SpeedPresets rate={v.playbackRate} disabled={disabled} onPick={(s) => update(speedChanges(element, project.assets, s), `Set “${element.name}” speed to ${s}×`)} />
      <Row label="Mute" searchKey="muted">
        <CheckField testId="video-field-muted" checked={v.muted} disabled={disabled} onCommit={(muted) => update({ props: { muted } }, muted ? `Mute “${element.name}”` : `Unmute “${element.name}”`)} />
      </Row>
      <Row label="Loop" searchKey="loop">
        <CheckField testId="video-field-loop" checked={v.loop} disabled={disabled} onCommit={(loop) => update(loopChanges(element, project.assets, loop), loop ? `Loop “${element.name}”` : `Stop looping “${element.name}”`)} />
      </Row>
      <div className="video-detach">
        <button
          type="button"
          className="btn small"
          data-testid="video-detach-audio"
          disabled={disabled || !detach.ok}
          title={detach.ok ? 'Move the soundtrack to its own audio clip (same source, trim and timing, anchored to this scene) and mute the video' : `${detach.message}${detach.hint ? `. ${detach.hint}` : ''}`}
          onClick={() => run({ type: 'detachVideoAudio', sceneId: scene.id, elementId: element.id, clipId: newId('aud') }, `Detach audio of “${element.name}”`)}
        >
          Detach audio
        </button>
        <span className="fine">{detach.ok ? 'The soundtrack plays with the video.' : v.muted ? 'Muted: the soundtrack is silent here (or detached).' : detach.hint ?? detach.message}</span>
      </div>
      <div className={`video-preview-state ${preview.kind}`} data-testid="video-section-preview-state">
        {preview.kind === 'preparing' && <span className="video-spinner" aria-hidden />}
        {preview.text}
      </div>
    </Section>
  );
}

/** The common speeds, under the Speed field (beside it they would squeeze the value); filtered with it. */
function SpeedPresets({ rate, disabled, onPick }: { rate: number; disabled: boolean; onPick: (speed: number) => void }) {
  const visible = useFieldVisible('Speed', 'playbackRate');
  if (!visible) return null;
  return (
    <div className="video-speeds" data-field="playbackRate">
      {SPEEDS.map((s) => (
        <button key={s} type="button" className={`mini-btn ${rate === s ? 'on' : ''}`} disabled={disabled} data-testid={`video-speed-${s}`} onClick={() => onPick(s)}>
          {s}×
        </button>
      ))}
    </div>
  );
}
