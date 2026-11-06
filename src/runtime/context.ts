// The runtime's contexts and hooks. A host (the Player, a Thumbnail, or the
// export render page) provides the root frame, the video config, the
// environment, readiness and the media components; compositions only ever
// read them through these hooks, so the same tree runs under every host.

import { createContext, useContext, type ComponentType, type CSSProperties } from 'react';
import { globalReadiness, type ReadyHandle } from './readiness';

export interface VideoConfig {
  width: number;
  height: number;
  fps: number;
  durationInFrames: number;
}

export interface Environment {
  /** Exporting (frames are captured): never degrade quietly, wait for every asset. */
  isRendering: boolean;
  /** Interactive preview (Player, thumbnails, capture page). */
  isPlayer: boolean;
}

/**
 * Where this subtree sits in time. `frame` is the host's root frame (or the
 * frozen frame under <HoldFrame>, in root time); `offset` is the sum of the
 * enclosing Sequences' `from`, so a component's own frame is frame - offset.
 */
export interface Timeline {
  frame: number;
  offset: number;
}

export interface Delay {
  delayRender: (label?: string) => ReadyHandle;
  continueRender: (handle: ReadyHandle) => void;
  cancelRender: (err: unknown) => void;
}

/** Element-local video: the frame is re-based by an enclosing TimeSpan. */
export interface VideoProps {
  src: string;
  /** Source frames (at the project fps) skipped from the file start. */
  trimBefore: number;
  playbackRate: number;
  loop: boolean;
  /** How long the element plays (local frames), when the host wants it. */
  durationInFrames?: number;
  /** Length of the source in project-fps frames, when known (loop wraps on it). */
  sourceDurationInFrames?: number;
  muted: boolean;
  /** Gain at the local frame (0..1). */
  volume: (frame: number) => number;
  objectFit: 'cover' | 'contain';
  style?: CSSProperties;
  /** Preview only: the file cannot be played. */
  onError?: () => void;
}

/** One sound placed in time: plays from `from` (relative to the enclosing TimeSpan) for `durationInFrames`. */
export interface AudioProps {
  src: string;
  from: number;
  durationInFrames: number;
  /** Source frames (at the project fps) skipped from the file start. */
  trimBefore: number;
  /** Gain at the clip-relative frame (0..1). */
  volume: (frame: number) => number;
  name?: string;
}

export interface ImgProps {
  src: string;
  style?: CSSProperties;
  onError?: () => void;
}

export interface MediaComponents {
  Video: ComponentType<VideoProps>;
  Audio: ComponentType<AudioProps>;
}

export const TimelineContext = createContext<Timeline>({ frame: 0, offset: 0 });
export const VideoConfigContext = createContext<VideoConfig | null>(null);
export const EnvironmentContext = createContext<Environment>({ isRendering: false, isPlayer: false });
export const DelayContext = createContext<Delay>(globalReadiness);
const NoMedia: MediaComponents = { Video: () => null, Audio: () => null };
export const MediaContext = createContext<MediaComponents>(NoMedia);

/** This component's frame: the root frame minus the enclosing Sequences' offsets. */
export function useFrame(): number {
  const t = useContext(TimelineContext);
  return t.frame - t.offset;
}

export function useTimeline(): Timeline {
  return useContext(TimelineContext);
}

export function useCompositionConfig(): VideoConfig {
  const config = useContext(VideoConfigContext);
  if (!config) throw new Error('useCompositionConfig() was called outside a Player, Thumbnail or the render page.');
  return config;
}

export function useEnvironment(): Environment {
  return useContext(EnvironmentContext);
}

export function useRenderHold(): Delay {
  return useContext(DelayContext);
}

export function useMedia(): MediaComponents {
  return useContext(MediaContext);
}
