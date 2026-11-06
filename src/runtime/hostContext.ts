// What the native hosts (Player, render page) give the native media
// components: playback state, the audio registry, pre-extracted video frames
// and the per-frame media report used to mix video soundtracks on export.

import { createContext } from 'react';

export interface Playback {
  playing: boolean;
  muted: boolean;
}
export const PlaybackContext = createContext<Playback>({ playing: false, muted: false });

/** A sound the tree declares, in root frames. */
export interface RegisteredAudio {
  key: string;
  src: string;
  from: number;
  durationInFrames: number;
  trimBefore: number;
  volume: (frame: number) => number;
  name?: string;
}
export interface AudioRegistry {
  register(audio: RegisteredAudio): () => void;
}
export const AudioRegistryContext = createContext<AudioRegistry | null>(null);

/** Frames of one video file, decoded ahead by the exporter. */
export interface VideoFrameSet {
  /** Presentation time (seconds) of every decoded frame, ascending. */
  pts: number[];
  url: (index: number) => string;
}
export interface VideoFrames {
  lookup(src: string): VideoFrameSet | null;
}
export const VideoFramesContext = createContext<VideoFrames | null>(null);

/** What a video element plays at the captured frame (for its soundtrack in the export mix). */
export interface VideoReport {
  src: string;
  /** Source time shown, seconds. */
  time: number;
  playbackRate: number;
  volume: number;
}
export interface MediaReports {
  add(key: string, read: () => VideoReport | null): () => void;
}
export const MediaReportContext = createContext<MediaReports | null>(null);

/** Index of the frame on screen at source time `t`: the last frame starting at or before it. */
export function frameIndexAt(pts: readonly number[], t: number): number {
  let lo = 0;
  let hi = pts.length - 1;
  if (hi < 0) return -1;
  if (t < pts[0]) return 0;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pts[mid] <= t + 1e-6) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Source time (seconds) a video shows at local frame `frame`, wrapped to the trimmed source when looping. */
export function videoSourceSeconds(args: { frame: number; fps: number; trimBefore: number; playbackRate: number; loop: boolean; sourceDurationInFrames?: number }): number {
  const { frame, fps, trimBefore, playbackRate, loop, sourceDurationInFrames } = args;
  let f = trimBefore + Math.max(0, frame) * playbackRate;
  if (loop && sourceDurationInFrames !== undefined && sourceDurationInFrames > trimBefore) {
    const span = sourceDurationInFrames - trimBefore;
    f = trimBefore + ((f - trimBefore) % span);
  }
  return f / fps;
}
