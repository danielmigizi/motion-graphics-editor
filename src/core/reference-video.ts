// Structured reference-video analysis (the bar-video ffmpeg workflow).
// Pure helpers: shot lists, hold detection, motion summaries. I/O lives in
// server/reference-analyze.ts. Analysis only — never import the source media.

export const REFERENCE_NOTICE =
  'Analysis only. Do not import this reference’s media into a project. Rebuild it in the editor from the measurements, and give every correction as an absolute value (not “a bit tighter”).';

export interface ReferenceSpecs {
  width: number;
  height: number;
  fps: number;
  durationSeconds: number;
  frames: number;
  videoCodec?: string;
  audioCodec?: string;
  hasAudio: boolean;
  sampleRate?: number;
}

export interface SceneCut {
  timeSeconds: number;
  frame: number;
}

export interface Shot {
  index: number;
  startSeconds: number;
  endSeconds: number;
  startFrame: number;
  endFrame: number;
  /** Hex colours sampled in this shot, most frequent first. */
  palette: string[];
}

export interface Loudness {
  /** Integrated loudness, LUFS. */
  integratedLufs: number | null;
  /** Loudness range, LU. */
  lra: number | null;
  truePeakDbtp?: number | null;
  note?: string;
}

export interface BeatGrid {
  bpm: number | null;
  confidence: number;
  /** Source frames at the analysed fps. */
  beats: number[];
  downbeats: number[];
  onsets: number[];
  strongHits: number[];
}

export interface MotionStats {
  /** Mean abs-diff per analysed frame (0..1). */
  energy: number[];
  /** Analysis fps (may be lower than the source). */
  fps: number;
  /** Near-still windows (no new visual information). */
  holds: { startFrame: number; endFrame: number; startSeconds: number; endSeconds: number }[];
  /** High-energy windows worth a dense strip. */
  fast: { startFrame: number; endFrame: number; startSeconds: number; endSeconds: number }[];
}

export interface ReferenceArtifact {
  kind: 'contact-sheet' | 'strip';
  path: string;
  startSeconds: number;
  endSeconds: number;
  columns?: number;
  rows?: number;
  stepFrames?: number;
}

export interface ReferenceReport {
  source: { kind: 'file' | 'url'; input: string; resolvedPath: string };
  specs: ReferenceSpecs;
  sceneCuts: SceneCut[];
  shots: Shot[];
  loudness: Loudness;
  beats: BeatGrid;
  motion: MotionStats;
  artifacts: ReferenceArtifact[];
  cached: boolean;
  notice: string;
}

const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;

/** Scene-cut times (seconds) → shots covering [0, duration]. */
export function shotsFromCuts(cutsSeconds: number[], durationSeconds: number, fps: number): Omit<Shot, 'palette'>[] {
  const dur = Math.max(0, durationSeconds);
  const times = [...new Set(cutsSeconds.filter((t) => t > 0.05 && t < dur - 0.05))].sort((a, b) => a - b);
  const edges = [0, ...times, dur];
  const shots: Omit<Shot, 'palette'>[] = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const start = edges[i];
    const end = edges[i + 1];
    shots.push({
      index: i + 1,
      startSeconds: round(start),
      endSeconds: round(end),
      startFrame: Math.round(start * fps),
      endFrame: Math.max(Math.round(start * fps), Math.round(end * fps) - 1),
    });
  }
  return shots;
}

/** Windows where energy stays below `threshold` for at least `minFrames`. */
export function holdWindows(
  energy: readonly number[],
  fps: number,
  threshold = 0.02,
  minFrames = 8,
): MotionStats['holds'] {
  const out: MotionStats['holds'] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start < 0 || end - start < minFrames) return;
    out.push({
      startFrame: start,
      endFrame: end - 1,
      startSeconds: round(start / fps),
      endSeconds: round((end - 1) / fps),
    });
  };
  for (let i = 0; i < energy.length; i++) {
    if (energy[i]! < threshold) {
      if (start < 0) start = i;
    } else {
      flush(i);
      start = -1;
    }
  }
  flush(energy.length);
  return out;
}

/** High-energy runs (mean above `threshold`) long enough for a 2-frame strip. */
export function fastWindows(
  energy: readonly number[],
  fps: number,
  threshold = 0.08,
  minFrames = 6,
): MotionStats['fast'] {
  const out: MotionStats['fast'] = [];
  let start = -1;
  const flush = (end: number) => {
    if (start < 0 || end - start < minFrames) return;
    out.push({
      startFrame: start,
      endFrame: end - 1,
      startSeconds: round(start / fps),
      endSeconds: round((end - 1) / fps),
    });
  };
  for (let i = 0; i < energy.length; i++) {
    if (energy[i]! >= threshold) {
      if (start < 0) start = i;
    } else {
      flush(i);
      start = -1;
    }
  }
  flush(energy.length);
  return out;
}

/** Mean absolute difference between consecutive gray frames (0..1). First frame is 0. */
export function motionEnergy(frames: readonly Uint8Array[]): number[] {
  if (!frames.length) return [];
  const out = new Array<number>(frames.length).fill(0);
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1]!;
    const b = frames[i]!;
    const n = Math.min(a.length, b.length);
    if (!n) continue;
    let sum = 0;
    for (let p = 0; p < n; p++) sum += Math.abs(a[p]! - b[p]!);
    out[i] = round(sum / n / 255, 4);
  }
  return out;
}

/** 12-bit colour buckets → top hex values (deterministic). */
export function paletteFromRgb(pixels: Uint8Array, max = 6): string[] {
  const counts = new Map<number, number>();
  for (let i = 0; i + 2 < pixels.length; i += 3) {
    const r = pixels[i]! & 0xf0;
    const g = pixels[i + 1]! & 0xf0;
    const b = pixels[i + 2]! & 0xf0;
    const key = (r << 16) | (g << 8) | b;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, max)
    .map(([key]) => `#${key.toString(16).padStart(6, '0')}`);
}

/** Contact-sheet tile count for 1 fps coverage of `durationSeconds` (6×4 pages). */
export function contactSheetPages(durationSeconds: number, columns = 6, rows = 4): { pages: number; tilesPerPage: number } {
  const tilesPerPage = columns * rows;
  const tiles = Math.max(1, Math.ceil(durationSeconds));
  return { pages: Math.ceil(tiles / tilesPerPage), tilesPerPage };
}
