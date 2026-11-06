// Native media components.
//
// Img: an <img> that holds readiness until the file is decoded.
// Audio: declares a sound to the host (the Player schedules it on its
//   AudioContext clock; the render page hands it to the export mixer).
// Video: in the preview a <video> element kept on the host clock; in an
//   export the exact decoded source frame (pre-extracted by the exporter),
//   plus a report of what it plays so its soundtrack can be mixed.

import React, { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useFrame, useRenderHold, useEnvironment, useTimeline, useCompositionConfig, type AudioProps, type ImgProps, type MediaComponents, type VideoProps } from './context';
import {
  AudioRegistryContext,
  frameIndexAt,
  MediaReportContext,
  PlaybackContext,
  VideoFramesContext,
  videoSourceSeconds,
  type VideoReport,
} from './hostContext';

const fill: React.CSSProperties = { display: 'block', width: '100%', height: '100%' };

/** <img> that holds readiness until decoded. Without onError, a failed load stops an export. */
export const Img: React.FC<ImgProps> = ({ src, style, onError }) => {
  const { delayRender, continueRender, cancelRender } = useRenderHold();
  const { isRendering } = useEnvironment();
  const ref = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    const img = ref.current;
    if (!img) return;
    const id = delayRender(`Loading image ${src}`);
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      continueRender(id);
    };
    const fail = () => {
      if (done) return;
      if (onError) onError();
      else if (isRendering) cancelRender(new Error(`Image failed to load: ${src}`));
      finish();
    };
    const decode = () => img.decode().then(finish, () => (img.naturalWidth > 0 ? finish() : fail()));
    if (img.complete && img.naturalWidth > 0) void decode();
    else {
      img.addEventListener('load', decode, { once: true });
      img.addEventListener('error', fail, { once: true });
    }
    return () => {
      img.removeEventListener('load', decode);
      img.removeEventListener('error', fail);
      finish();
    };
    // onError is a callback prop; the image only reloads when src changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, delayRender, continueRender, cancelRender, isRendering]);
  return <img ref={ref} src={src} alt="" decoding="sync" style={style} />;
};

/** Declares one sound; draws nothing. */
export const Audio: React.FC<AudioProps> = ({ src, from, durationInFrames, trimBefore, volume, name }) => {
  const registry = useContext(AudioRegistryContext);
  const { offset } = useTimeline();
  const key = useId();
  const vol = useRef(volume);
  vol.current = volume;
  useEffect(() => {
    if (!registry || durationInFrames <= 0) return;
    return registry.register({ key, src, from: offset + from, durationInFrames, trimBefore, name, volume: (f) => vol.current(f) });
  }, [registry, key, src, offset, from, durationInFrames, trimBefore, name]);
  return null;
};

/** Preview: a <video> element following the host clock (seeks when paused, drift-corrected when playing). */
const PreviewVideo: React.FC<VideoProps> = ({ src, trimBefore, playbackRate, loop, sourceDurationInFrames, muted, volume, objectFit, style, onError }) => {
  const frame = useFrame();
  const { fps } = useCompositionConfig();
  const playback = useContext(PlaybackContext);
  const { delayRender, continueRender } = useRenderHold();
  const ref = useRef<HTMLVideoElement>(null);
  const seekHandle = useRef<number | null>(null);
  const [duration, setDuration] = useState<number | undefined>(undefined);
  const known = sourceDurationInFrames ?? (duration !== undefined ? duration * fps : undefined);
  const target = videoSourceSeconds({ frame, fps, trimBefore, playbackRate, loop, sourceDurationInFrames: known });

  // Hold readiness until the first frame of the file is decoded.
  useLayoutEffect(() => {
    const v = ref.current;
    if (!v) return;
    const id = delayRender(`Loading video ${src}`);
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        continueRender(id);
      }
    };
    const loaded = () => {
      if (Number.isFinite(v.duration)) setDuration(v.duration);
      finish();
    };
    const failed = () => {
      onError?.();
      finish();
    };
    if (v.readyState >= 2) loaded();
    v.addEventListener('loadeddata', loaded);
    v.addEventListener('error', failed);
    return () => {
      v.removeEventListener('loadeddata', loaded);
      v.removeEventListener('error', failed);
      finish();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, delayRender, continueRender]);

  useLayoutEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.muted = muted || playback.muted;
    v.volume = Math.max(0, Math.min(1, volume(frame)));
    if (v.playbackRate !== playbackRate) v.playbackRate = playbackRate;
    // Speed moves the pitch, as the export's resampling does.
    if (v.preservesPitch) v.preservesPitch = false;
    if (playback.playing) {
      if (Math.abs(v.currentTime - target) > 0.25) v.currentTime = target;
      if (v.paused) void v.play().catch(() => undefined);
      return;
    }
    if (!v.paused) v.pause();
    if (Math.abs(v.currentTime - target) < 0.5 / fps && !v.seeking) return;
    // Paused: show exactly this frame, and hold readiness until it is on screen.
    if (seekHandle.current === null) seekHandle.current = delayRender(`Seeking video ${src}`);
    v.currentTime = target;
    const settle = () => {
      const h = seekHandle.current;
      seekHandle.current = null;
      if (h !== null) continueRender(h);
    };
    const onSeeked = () => {
      if (v.seeking) return;
      v.removeEventListener('seeked', onSeeked);
      if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(() => settle());
      else settle();
      // A paused element may not present a frame after seeking; never wait for long.
      setTimeout(settle, 250);
    };
    v.addEventListener('seeked', onSeeked);
    return () => v.removeEventListener('seeked', onSeeked);
  });

  useEffect(
    () => () => {
      const h = seekHandle.current;
      seekHandle.current = null;
      if (h !== null) continueRender(h);
      ref.current?.pause();
    },
    [continueRender],
  );

  return <video ref={ref} src={src} preload="auto" playsInline muted={muted || playback.muted} style={{ ...fill, objectFit, ...style }} />;
};

/** Export: the decoded source frame at this frame's source time, as an image. */
const RenderVideo: React.FC<VideoProps> = ({ src, trimBefore, playbackRate, loop, sourceDurationInFrames, muted, volume, objectFit, style }) => {
  const frame = useFrame();
  const { fps } = useCompositionConfig();
  const frames = useContext(VideoFramesContext)?.lookup(src) ?? null;
  const reports = useContext(MediaReportContext);
  const key = useId();
  const sourceFrames = sourceDurationInFrames ?? (frames && frames.pts.length ? frames.pts.length : undefined);
  const time = videoSourceSeconds({ frame, fps, trimBefore, playbackRate, loop, sourceDurationInFrames: sourceFrames });
  const latest = useRef<VideoReport | null>(null);
  latest.current = muted ? null : { src, time, playbackRate, volume: Math.max(0, Math.min(1, volume(frame))) };
  useLayoutEffect(() => reports?.add(key, () => latest.current), [reports, key]);
  if (!frames) throw new Error(`No decoded frames for ${src}; the exporter did not prepare this video.`);
  const index = frameIndexAt(frames.pts, time);
  return <Img src={frames.url(Math.max(0, index))} style={{ ...fill, objectFit, ...style }} />;
};

const Video: React.FC<VideoProps> = (props) => {
  const { isRendering } = useEnvironment();
  return isRendering ? <RenderVideo {...props} /> : <PreviewVideo {...props} />;
};

export const NATIVE_MEDIA: MediaComponents = { Video, Audio };
