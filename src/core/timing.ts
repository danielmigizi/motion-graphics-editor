// Frame arithmetic on the project timeline. Everything is integer frames.

import type { AudioClip, Project, Scene } from './types';

export function projectDurationInFrames(project: Project): number {
  return project.scenes.reduce((sum, s) => sum + s.durationInFrames, 0);
}

/** Global start frame of each scene, in playback order. */
export function sceneStartFrames(project: Project): number[] {
  const starts: number[] = [];
  let acc = 0;
  for (const s of project.scenes) {
    starts.push(acc);
    acc += s.durationInFrames;
  }
  return starts;
}

export function sceneStartFrame(project: Project, sceneId: string): number {
  let acc = 0;
  for (const s of project.scenes) {
    if (s.id === sceneId) return acc;
    acc += s.durationInFrames;
  }
  return -1;
}

export interface FrameLocation {
  sceneIndex: number;
  scene: Scene;
  sceneStart: number;
  frameInScene: number;
}

/** Which scene a global frame falls in. Frames past the end clamp to the last frame. */
export function locateFrame(project: Project, globalFrame: number): FrameLocation | null {
  if (project.scenes.length === 0) return null;
  const total = projectDurationInFrames(project);
  const f = Math.max(0, Math.min(Math.floor(globalFrame), total - 1));
  let acc = 0;
  for (let i = 0; i < project.scenes.length; i++) {
    const scene = project.scenes[i];
    if (f < acc + scene.durationInFrames) {
      return { sceneIndex: i, scene, sceneStart: acc, frameInScene: f - acc };
    }
    acc += scene.durationInFrames;
  }
  const last = project.scenes.length - 1;
  const scene = project.scenes[last];
  return { sceneIndex: last, scene, sceneStart: acc - scene.durationInFrames, frameInScene: scene.durationInFrames - 1 };
}

/** Absolute project frame where an audio clip starts (scene-anchored clips follow their scene). */
export function audioClipStartFrame(project: Project, clip: AudioClip): number {
  if (!clip.sceneId) return clip.startFrame;
  const start = sceneStartFrame(project, clip.sceneId);
  return start < 0 ? clip.startFrame : start + clip.startFrame;
}

export function framesToSeconds(frames: number, fps: number): number {
  return frames / fps;
}

/** `m:ss:ff` timecode. */
export function formatTimecode(frame: number, fps: number): string {
  const f = Math.max(0, Math.floor(frame));
  const totalSeconds = Math.floor(f / fps);
  const ff = f % fps;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
}

/** Join an asset-root-relative src onto a base URL (e.g. '/' in preview, 'http://localhost:5318/' in export). */
export function resolveAssetUrl(assetBaseUrl: string, src: string): string {
  if (/^(data:|blob:|https?:)/.test(src)) return src;
  const base = assetBaseUrl.endsWith('/') ? assetBaseUrl : `${assetBaseUrl}/`;
  return base + src.replace(/^\/+/, '');
}
