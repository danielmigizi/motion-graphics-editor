// Attribution lines for a project's audio (Openverse catalog imports and any
// other asset that stored a license). Used by MCP tools and by export, which
// writes credits.txt next to the MP4.

import { OPENVERSE_NOTICE } from './openverseLicense';
import type { Asset, Project } from './types';

export interface ProjectCredits {
  lines: string[];
  madeWithOpenverse: boolean;
  /** Assets that contributed a line, in the same order as `lines`. */
  assets: Asset[];
}

function licenseLine(asset: Asset): string | null {
  const lic = asset.provenance?.license;
  if (lic?.attribution?.trim()) return lic.attribution.trim();
  const creator = lic?.creator?.trim();
  const title = asset.name.trim() || 'Untitled';
  if (creator && lic?.spdxOrCc) return `"${title}" by ${creator} is licensed under ${lic.spdxOrCc}${lic.version ? ` ${lic.version}` : ''}.`;
  return null;
}

function isOpenverse(asset: Asset): boolean {
  const p = asset.provenance;
  return p?.source === 'openverse' || p?.provider === 'openverse' || !!p?.license?.openverseId;
}

/** Unique attribution lines for clips (and leftover licensed assets). */
export function projectAudioCredits(project: Project): ProjectCredits {
  const lines: string[] = [];
  const assets: Asset[] = [];
  const seen = new Set<string>();
  const consider = (asset: Asset | undefined) => {
    if (!asset) return;
    const line = licenseLine(asset);
    if (!line || seen.has(line)) return;
    seen.add(line);
    lines.push(line);
    assets.push(asset);
  };
  for (const clip of project.audio) consider(project.assets[clip.assetId]);
  for (const asset of Object.values(project.assets)) {
    if (asset.kind !== 'audio') continue;
    if (!asset.provenance?.license && !isOpenverse(asset)) continue;
    consider(asset);
  }
  return {
    lines,
    madeWithOpenverse: assets.some(isOpenverse) || Object.values(project.assets).some(isOpenverse),
    assets,
  };
}

/** Sidecar file written next to an export when the project has credits. */
export function formatCreditsFile(credits: ProjectCredits): string {
  const body = credits.lines.length ? credits.lines.map((l) => `- ${l}`).join('\n') : '(none)';
  const openverse = credits.madeWithOpenverse ? `\n\n${OPENVERSE_NOTICE}` : '';
  return `Audio credits\n-------------\n${body}${openverse}\n`;
}
