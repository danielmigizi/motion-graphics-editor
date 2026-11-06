// The built-in sound-effect set: short WAVs synthesised by
// scripts/make-sfx.ts into public/assets/sfx/ (no recorded material, so they
// are CC0 by construction). Each is an ordinary audio asset once added to a
// project; agents and the Insert menu add one as addAsset (when missing) +
// addAudioClip anchored to a scene, in one batch.

import type { Asset, AudioClip, Command, ID, Project } from './types';

export const SFX_IDS = ['whoosh', 'click', 'pop', 'rise', 'hit', 'tick'] as const;
export type SfxId = (typeof SFX_IDS)[number];

export interface SfxDef {
  id: SfxId;
  name: string;
  /** Length of the file, seconds. */
  seconds: number;
  /** What it sounds like. */
  description: string;
  /** Where it fits, for people and agents. */
  use: string;
  /** Default clip volume. */
  volume: number;
  /**
   * Frames from the clip start to the sound's peak at 30 fps: place the clip
   * this much before the moment it should land (a whoosh peaks mid-sweep, a
   * riser at its end).
   */
  leadFrames: number;
}

export const SFX: Record<SfxId, SfxDef> = {
  whoosh: { id: 'whoosh', name: 'Whoosh', seconds: 0.7, description: 'Air sweep, rising then falling', use: 'Scene transitions, fast slides and wipes', volume: 0.7, leadFrames: 12 },
  click: { id: 'click', name: 'Click', seconds: 0.05, description: 'Short bright click', use: 'Button presses, cursor clicks, toggles', volume: 0.8, leadFrames: 0 },
  pop: { id: 'pop', name: 'Pop', seconds: 0.15, description: 'Soft pitched pop', use: 'Bubbles, badges, cards and icons appearing', volume: 0.7, leadFrames: 0 },
  rise: { id: 'rise', name: 'Rise', seconds: 1.5, description: 'Noise and tone riser that builds to a stop', use: 'Build-up into a reveal or a drop; end it on the hit', volume: 0.6, leadFrames: 44 },
  hit: { id: 'hit', name: 'Hit', seconds: 0.9, description: 'Low impact with a short transient', use: 'Logo slams, big numbers, the downbeat of a reveal', volume: 0.8, leadFrames: 0 },
  tick: { id: 'tick', name: 'Tick', seconds: 0.04, description: 'Tiny high tick', use: 'Counters, typing, list items, a stagger', volume: 0.5, leadFrames: 0 },
};

export const SFX_LICENSE = 'CC0 1.0 Universal (public domain dedication): synthesised by scripts/make-sfx.ts from code; no recorded or third-party material.';

export const sfxSrc = (id: SfxId) => `assets/sfx/${id}.wav`;
export const sfxAssetId = (id: SfxId): ID => `ast_sfx_${id}`;

/** The asset for a built-in effect (stable id, so adding it twice reuses it). */
export function sfxAsset(id: SfxId, fps: number): Asset {
  const def = SFX[id];
  return {
    id: sfxAssetId(id),
    kind: 'audio',
    name: def.name,
    src: sfxSrc(id),
    mimeType: 'audio/wav',
    durationInFrames: Math.max(1, Math.round(def.seconds * fps)),
    provenance: { source: 'generated', model: 'scripts/make-sfx.ts (procedural, CC0)' },
  };
}

/**
 * Commands that place a built-in effect in `sceneId` at scene frame
 * `startFrame` (clamped into the scene): the asset when the project lacks
 * it, then a scene-anchored clip. Wrap them in one batch.
 */
export function sfxCommands(project: Project, id: SfxId, sceneId: ID, startFrame: number, clipId: ID): Command[] {
  const scene = project.scenes.find((s) => s.id === sceneId);
  const asset = sfxAsset(id, project.fps);
  const duration = asset.durationInFrames!;
  const at = Math.max(0, Math.min(Math.round(startFrame), (scene?.durationInFrames ?? 1) - 1));
  const clip: AudioClip = { id: clipId, assetId: asset.id, name: SFX[id].name, sceneId, startFrame: at, trimStartFrames: 0, durationInFrames: duration, volume: SFX[id].volume, fadeInFrames: 0, fadeOutFrames: 0 };
  return [...(project.assets[asset.id] ? [] : [{ type: 'addAsset' as const, asset }]), { type: 'addAudioClip', clip }];
}
