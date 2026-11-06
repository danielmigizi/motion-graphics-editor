// Commands that place a downloaded Openverse track as a music bed or a
// scene-anchored SFX. Same addAsset + addAudioClip path as built-in SFX.

import { newId } from './ids';
import { projectDurationInFrames } from './timing';
import type { Asset, AssetLicense, AssetProvenance, AudioClip, Command, ID, Project } from './types';
import type { ImportUrlResponse } from './generation';
import { OPENVERSE_NOTICE } from './openverseLicense';

export type OpenverseAudioRole = 'music' | 'sfx';

export interface OpenverseWork {
  id: string;
  title: string;
  creator?: string;
  creatorUrl?: string;
  durationSeconds: number | null;
  license: string;
  licenseVersion?: string;
  licenseUrl?: string;
  attribution: string;
  category?: string;
  provider?: string;
  source?: string;
  foreignLandingUrl?: string;
  /** Catalog download / preview URL (never used as a permanent asset.src). */
  url?: string;
  thumbnail?: string;
  tags: string[];
}

export function openverseAssetId(openverseId: string): ID {
  const compact = openverseId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32) || 'work';
  return `ast_ov_${compact}`;
}

export function openverseLicenseFromWork(work: OpenverseWork, cachedAt?: number): AssetLicense {
  const license: AssetLicense = {
    spdxOrCc: work.license,
    attribution: work.attribution || `"${work.title}" by ${work.creator ?? 'unknown'} / Openverse`,
  };
  if (work.licenseVersion) license.version = work.licenseVersion;
  if (work.licenseUrl) license.licenseUrl = work.licenseUrl;
  if (work.creator) license.creator = work.creator;
  if (work.creatorUrl) license.creatorUrl = work.creatorUrl;
  if (work.foreignLandingUrl) license.foreignLandingUrl = work.foreignLandingUrl;
  license.openverseId = work.id;
  if (cachedAt !== undefined) license.cachedAt = cachedAt;
  return license;
}

export function openverseProvenance(work: OpenverseWork, cachedAt = Date.now()): AssetProvenance {
  const refs: Record<string, string> = { openverseId: work.id };
  if (work.source) refs.source = work.source;
  if (work.provider) refs.provider = work.provider;
  if (work.foreignLandingUrl) refs.foreignLandingUrl = work.foreignLandingUrl;
  return {
    source: 'openverse',
    provider: 'openverse',
    providerRefs: refs,
    createdAt: cachedAt,
    license: openverseLicenseFromWork(work, cachedAt),
  };
}

export function openverseAssetFromImport(
  work: OpenverseWork,
  up: ImportUrlResponse,
  fps: number,
  opts?: { assetId?: ID; name?: string; cachedAt?: number },
): Asset {
  const durationSeconds = up.durationSeconds ?? work.durationSeconds ?? 0;
  const asset: Asset = {
    id: opts?.assetId ?? openverseAssetId(work.id),
    kind: 'audio',
    name: opts?.name?.trim() || work.title || up.name,
    src: up.src,
    mimeType: up.mimeType,
    provenance: openverseProvenance(work, opts?.cachedAt ?? Date.now()),
  };
  if (durationSeconds > 0) asset.durationInFrames = Math.max(1, Math.round(durationSeconds * fps));
  return asset;
}

export interface OpenverseClipOpts {
  clipId: ID;
  role: OpenverseAudioRole;
  sceneId?: ID;
  startFrame: number;
}

/**
 * addAsset (when missing) + addAudioClip. Music beds omit sceneId and fade in/out;
 * SFX are scene-anchored. Wrap in one batch / one patch.
 */
export function openverseClipCommands(project: Project, asset: Asset, opts: OpenverseClipOpts): Command[] {
  const sourceFrames = asset.durationInFrames ?? Math.max(1, project.fps * 4);
  const total = projectDurationInFrames(project);
  const scene = opts.sceneId ? project.scenes.find((s) => s.id === opts.sceneId) : undefined;
  const isBed = opts.role === 'music';
  let startFrame = Math.max(0, Math.round(opts.startFrame));
  let durationInFrames: number;
  if (isBed) {
    durationInFrames = Math.max(1, Math.min(sourceFrames, Math.max(1, total - startFrame)));
  } else {
    const sceneLen = scene?.durationInFrames ?? 1;
    startFrame = Math.max(0, Math.min(startFrame, sceneLen - 1));
    durationInFrames = Math.max(1, Math.min(sourceFrames, sceneLen - startFrame));
  }
  const clip: AudioClip = {
    id: opts.clipId,
    assetId: asset.id,
    name: asset.name,
    startFrame,
    trimStartFrames: 0,
    durationInFrames,
    volume: isBed ? 0.6 : 0.75,
    fadeInFrames: isBed ? Math.round(project.fps * 0.5) : 0,
    fadeOutFrames: isBed ? Math.round(project.fps * 1.5) : 0,
  };
  if (!isBed && opts.sceneId) clip.sceneId = opts.sceneId;
  return [...(project.assets[asset.id] ? [] : [{ type: 'addAsset' as const, asset }]), { type: 'addAudioClip', clip }];
}

export function openverseClipId(): ID {
  return newId('aud');
}

export function openverseMadeWithLine(): string {
  return OPENVERSE_NOTICE;
}
