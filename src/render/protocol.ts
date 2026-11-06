// What the exporter (server/engine) and the render page (src/render/main.tsx)
// say to each other through window.__mge in headless Chrome.

import type { ContactSheetProps } from '../composition/ContactSheet';
import type { MainCompositionProps } from '../composition/types';

export type RenderInput =
  | { composition: 'main'; props: MainCompositionProps; width: number; height: number; fps: number; durationInFrames: number; videoFrames: Record<string, VideoFrameIndex> }
  | { composition: 'contact-sheet'; props: ContactSheetProps; width: number; height: number; fps: number; durationInFrames: number; videoFrames: Record<string, VideoFrameIndex> };

/** Frames of one video file decoded ahead: `${urlPrefix}${index + 1}.${ext}`, shown at `pts` seconds. */
export interface VideoFrameIndex {
  urlPrefix: string;
  ext: 'jpg' | 'png';
  pts: number[];
}

/** A sound the composition declares, with its gain at every frame of its duration. */
export interface PlannedAudio {
  key: string;
  src: string;
  from: number;
  durationInFrames: number;
  trimBefore: number;
  volumes: number[];
}

export interface FrameMedia {
  /** Soundtrack of every unmuted video on screen at this frame. */
  videos: { key: string; src: string; time: number; playbackRate: number; volume: number }[];
}

export interface RenderPageApi {
  /** Mount (or replace) what the page shows. */
  load(input: RenderInput): Promise<{ audio: PlannedAudio[] }>;
  seek(frame: number): Promise<FrameMedia>;
}

declare global {
  interface Window {
    __mge?: RenderPageApi;
    __mgeReady?: boolean;
  }
}
