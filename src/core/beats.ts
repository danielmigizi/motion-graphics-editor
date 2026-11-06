// Beats in an audio signal, shared by the browser ("Mark beats", waveforms)
// and the local server (the beats endpoint behind `editor_get_beats` and the
// Assets panel's BPM). Pure and deterministic for a given decoded signal.
//
// Two layers:
// - Peaks and onsets per frame (computePeaks, detectOnsets): what the
//   timeline draws and what "Mark beats" turns into markers.
// - A tempo and beat grid (analyzeBeats): an onset-strength envelope at
//   100 Hz (log-magnitude spectral flux, half-wave rectified, so a sustained
//   pad or chord swell carries little weight next to an attack), its
//   autocorrelation for the tempo candidates, each candidate checked against
//   the detected onsets (a tempo whose period does not connect the strong
//   onsets loses; a mild preference for ~120 BPM breaks octave ties),
//   dynamic-programming beat tracking (Ellis 2007) so the grid follows small
//   tempo drift, downbeats from the low-frequency (kick) strength every
//   fourth beat, and strong hits.

/** Peak resolution: 2 peaks per px at the closest timeline zoom (8 px per frame). */
export const PEAKS_PER_FRAME = 16;

export interface Peaks {
  /** Peaks per project frame. */
  perFrame: number;
  /** Max |sample| per bucket across channels, normalised so the loudest bucket is 1. */
  data: Float32Array;
  /** The loudest raw sample (0..1) before normalising; 0 for silence. */
  max: number;
}

/** Bucket the decoded channels into `perFrame` peaks per frame at `fps`. */
export function computePeaks(channels: readonly Float32Array[], sampleRate: number, fps: number, perFrame = PEAKS_PER_FRAME): Peaks {
  const length = channels.reduce((n, c) => Math.max(n, c.length), 0);
  const samplesPerBucket = sampleRate / (fps * perFrame);
  const n = Math.ceil(length / samplesPerBucket);
  const data = new Float32Array(n);
  let max = 0;
  for (let b = 0; b < n; b++) {
    const s0 = Math.floor(b * samplesPerBucket);
    const s1 = Math.min(length, Math.max(s0 + 1, Math.floor((b + 1) * samplesPerBucket)));
    let m = 0;
    for (const ch of channels) {
      const end = Math.min(s1, ch.length);
      for (let s = s0; s < end; s++) {
        const v = Math.abs(ch[s]);
        if (v > m) m = v;
      }
    }
    data[b] = m;
    if (m > max) max = m;
  }
  if (max > 0) for (let b = 0; b < n; b++) data[b] /= max;
  return { perFrame, data, max };
}

/** Length of the decoded audio in frames. */
export const peakFrames = (peaks: Peaks) => peaks.data.length / peaks.perFrame;

/** Loudness per frame: RMS of that frame's peaks. */
export function frameEnergy(peaks: Peaks): Float32Array {
  const frames = Math.ceil(peakFrames(peaks));
  const out = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    const i0 = f * peaks.perFrame;
    const i1 = Math.min(peaks.data.length, i0 + peaks.perFrame);
    let sum = 0;
    for (let i = i0; i < i1; i++) sum += peaks.data[i] * peaks.data[i];
    out[f] = i1 > i0 ? Math.sqrt(sum / (i1 - i0)) : 0;
  }
  return out;
}

export interface OnsetOptions {
  /** Closest two onsets may be (default: a fifth of a second). */
  minGapFrames?: number;
  /** Threshold in standard deviations of the energy rise above its mean (default 1.5). Lower finds more. */
  sensitivity?: number;
  /** A hit must also be this much louder than the recent average (default 0.35 = 35 %), so a sustained pad's wobble is not a beat. */
  minRise?: number;
}

export interface Onset {
  frame: number;
  /** How much louder than the recent average (normalised energy units). */
  strength: number;
}

/**
 * Onsets with their strength: source frames where loudness rises sharply
 * above its recent average (~0.1 s), taken at local peaks of that rise above
 * an adaptive threshold (mean + sensitivity × std, at least a tenth of the
 * biggest rise, and `minRise` relative to the recent level), at least
 * `minGapFrames` apart (the stronger one wins).
 */
export function detectOnsetStrengths(peaks: Peaks, fps: number, opts: OnsetOptions = {}): Onset[] {
  const e = frameEnergy(peaks);
  if (!e.length) return [];
  const history = Math.max(2, Math.round(fps / 10));
  const rise = new Float32Array(e.length);
  const recent = new Float32Array(e.length);
  for (let i = 0; i < e.length; i++) {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - history); j < i; j++) {
      sum += e[j];
      n++;
    }
    recent[i] = n ? sum / n : 0;
    rise[i] = Math.max(0, e[i] - recent[i]);
  }
  const minRise = opts.minRise ?? 0.35;
  let mean = 0;
  let top = 0;
  for (const r of rise) {
    mean += r;
    top = Math.max(top, r);
  }
  mean /= rise.length;
  let variance = 0;
  for (const r of rise) variance += (r - mean) ** 2;
  const std = Math.sqrt(variance / rise.length);
  if (top <= 0) return [];
  const threshold = Math.max(mean + (opts.sensitivity ?? 1.5) * std, top * 0.1);
  const gap = Math.max(1, opts.minGapFrames ?? Math.round(fps / 5));
  const onsets: Onset[] = [];
  for (let i = 0; i < rise.length; i++) {
    const r = rise[i];
    // The level floor (0.05) keeps a near-silent noise floor from counting as "much louder".
    if (r < threshold || r <= 0 || r < minRise * Math.max(recent[i], 0.05)) continue;
    if (i > 0 && rise[i - 1] > r) continue;
    if (i < rise.length - 1 && rise[i + 1] > r) continue;
    const last = onsets[onsets.length - 1];
    if (last !== undefined && i - last.frame < gap) {
      if (r > last.strength) onsets[onsets.length - 1] = { frame: i, strength: r };
      continue;
    }
    onsets.push({ frame: i, strength: r });
  }
  return onsets;
}

/** Onset frames (beats, hits); see detectOnsetStrengths. */
export function detectOnsets(peaks: Peaks, fps: number, opts: OnsetOptions = {}): number[] {
  return detectOnsetStrengths(peaks, fps, opts).map((o) => o.frame);
}

// ---------------------------------------------------------------------------
// Tempo, beat grid, downbeats and strong hits
// ---------------------------------------------------------------------------

/** Analysis rate of the onset-strength envelope (Hz). */
const ENVELOPE_RATE = 100;
/** Smallest attack (rise in log1p(100 × RMS) per 10 ms) that counts as a hit: about +3 dB at a moderate level. */
const MIN_ATTACK = 0.1;

export interface BeatAnalysis {
  /** Frame rate the frame lists are in. */
  fps: number;
  /** Length of the source in frames. */
  durationInFrames: number;
  /** Tempo estimate, rounded to 0.1 BPM; null when no steady pulse was found. */
  bpm: number | null;
  /** 0..1: how clearly the signal repeats at that tempo. Below ~0.2 the grid is a guess. */
  confidence: number;
  /** Beat grid, source frames (frame 0 = first sample of the file). */
  beats: number[];
  /** Every fourth beat, phased on the strongest low-end hits: bar starts. */
  downbeats: number[];
  /** The few loudest hits (accents, drops), source frames. */
  strong: number[];
  /** Every onset "Mark beats" would find, source frames. */
  onsets: number[];
}

/** GET /api/assets/beats?src=&fps= (server/beats.ts): the analysis of one file, frames at `fps`. */
export interface BeatsResponse extends BeatAnalysis {
  src: string;
  /** Source length, seconds. */
  durationSeconds: number;
}

/** Mono mixdown of decoded channels. */
export function mixdown(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const n = channels.reduce((m, c) => Math.max(m, c.length), 0);
  const out = new Float32Array(n);
  for (const ch of channels) for (let i = 0; i < ch.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

/** RMS per hop of `samples`, log-compressed. */
function hopLoudness(samples: Float32Array, hop: number): Float32Array {
  const n = Math.floor(samples.length / hop);
  const out = new Float32Array(n);
  for (let h = 0; h < n; h++) {
    let sum = 0;
    const s0 = h * hop;
    for (let i = s0; i < s0 + hop; i++) sum += samples[i] * samples[i];
    out[h] = Math.log1p(100 * Math.sqrt(sum / hop));
  }
  return out;
}

/** Half-wave rectified rise of loudness above its local mean (~0.3 s): the onset strength. */
function novelty(loud: Float32Array): Float32Array {
  const n = loud.length;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // Before the file is silence, so a sound on its very first sample is an onset too.
    const d = loud[i] - (i > 0 ? loud[i - 1] : 0);
    out[i] = Math.max(0, d);
  }
  return localRise(out);
}

/** In-place iterative radix-2 FFT of (re, im); the length is a power of two. Deterministic. */
function fft(re: Float64Array, im: Float64Array, cos: Float64Array, sin: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const step = n / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sin[k * step];
        const a = i + k;
        const b = a + half;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** FFT size of the spectral flux: the power of two at or above ~46 ms. */
function fluxWindow(sampleRate: number): number {
  let size = 256;
  while (size < 0.046 * sampleRate) size <<= 1;
  return size;
}

/**
 * Spectral flux per hop: the summed rise of log magnitude across frequency
 * bins (Hann window of ~46 ms ending with the hop), half-wave rectified. A
 * held chord or a slow pad swell barely changes its bins from hop to hop; an
 * attack (a click, a hat, a kick) lights up many bins at once.
 */
function spectralFlux(samples: Float32Array, sampleRate: number, hop: number): Float32Array {
  const hops = Math.floor(samples.length / hop);
  const size = fluxWindow(sampleRate);
  const window = new Float64Array(size);
  for (let i = 0; i < size; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let k = 0; k < size / 2; k++) {
    cos[k] = Math.cos((-2 * Math.PI * k) / size);
    sin[k] = Math.sin((-2 * Math.PI * k) / size);
  }
  const bins = size / 2;
  // A sine of amplitude A peaks at A × size / 4 through a Hann window.
  const scale = 4 / size;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let prev = new Float64Array(bins);
  let cur = new Float64Array(bins);
  const out = new Float32Array(hops);
  for (let h = 0; h < hops; h++) {
    // The window ends with the hop: log-magnitude flux jumps the moment an
    // attack enters the window, so this places it in the hop that holds it.
    const start = (h + 1) * hop - size;
    for (let i = 0; i < size; i++) {
      const s = start + i;
      re[i] = s >= 0 && s < samples.length ? samples[s] * window[i] : 0;
      im[i] = 0;
    }
    fft(re, im, cos, sin);
    let rise = 0;
    for (let k = 1; k < bins; k++) {
      cur[k] = Math.log1p(100 * scale * Math.hypot(re[k], im[k]));
      // Before the file is silence (prev starts at zero), so a sound on its first sample is an onset too.
      const d = cur[k] - prev[k];
      if (d > 0) rise += d;
    }
    out[h] = rise / Math.sqrt(bins);
    const t = prev;
    prev = cur;
    cur = t;
  }
  return out;
}

/** Subtract the average of the preceding ~0.3 s of `rise` (half-wave rectified) so a slowly rising level is not a pulse. */
function localRise(rise: Float32Array): Float32Array {
  const n = rise.length;
  const win = Math.round(ENVELOPE_RATE * 0.3);
  const res = new Float32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const count = Math.min(i, win);
    res[i] = Math.max(0, rise[i] - (count ? acc / count : 0));
    acc += rise[i];
    if (i >= win) acc -= rise[i - win];
  }
  return res;
}

/** Two one-pole low-passes (~150 Hz): the kick and bass. */
function lowPass(samples: Float32Array, sampleRate: number, cutoff = 150): Float32Array {
  const a = Math.exp((-2 * Math.PI * cutoff) / sampleRate);
  const out = new Float32Array(samples.length);
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    y1 = (1 - a) * samples[i] + a * y1;
    y2 = (1 - a) * y1 + a * y2;
    out[i] = y2;
  }
  return out;
}

const meanOf = (a: ArrayLike<number>) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return a.length ? s / a.length : 0;
};

/** Symmetric triangular smoothing over ±`radius` hops, so a hit that lands between hops still lines up with its neighbours. */
function smoothed(env: Float32Array, radius: number): Float32Array {
  const out = new Float32Array(env.length);
  for (let i = 0; i < env.length; i++) {
    let sum = 0;
    let w = 0;
    for (let j = -radius; j <= radius; j++) {
      const k = i + j;
      if (k < 0 || k >= env.length) continue;
      const weight = radius + 1 - Math.abs(j);
      sum += env[k] * weight;
      w += weight;
    }
    out[i] = sum / w;
  }
  return out;
}

/** An onset in envelope hops (fractional) with its strength. */
interface HopOnset {
  hop: number;
  strength: number;
}

/** Beats an onset may be from its neighbour (one bar) and still say something about the period. */
const MAX_BEATS_BETWEEN_ONSETS = 4;

/**
 * How well a beat period connects the detected onsets: the strength-weighted
 * share of onsets that have another onset a whole number of periods (1 to 4)
 * before or after them, within `tol` hops. Every onset of a steady click (or
 * of a kick on beats 1 and 3) sits on the grid of the true period; a wrong
 * tempo's period lands between them and misses the strong ones. Local (onset
 * to neighbouring onset), so a slowly drifting tempo still fits. Octaves
 * (half or double the period) fit too; the autocorrelation and the tempo
 * preference choose between those.
 */
function onsetConsistency(onsets: readonly HopOnset[], period: number, tol: number): number {
  let total = 0;
  let hit = 0;
  let j0 = 0;
  const reach = MAX_BEATS_BETWEEN_ONSETS * period + tol;
  for (let i = 0; i < onsets.length; i++) {
    const o = onsets[i];
    total += o.strength;
    while (j0 < onsets.length && onsets[j0].hop < o.hop - reach) j0++;
    for (let j = j0; j < onsets.length && onsets[j].hop <= o.hop + reach; j++) {
      if (j === i) continue;
      const d = Math.abs(onsets[j].hop - o.hop);
      const k = Math.round(d / period);
      if (k >= 1 && Math.abs(d - k * period) <= tol) {
        hit += o.strength;
        break;
      }
    }
  }
  return total > 0 ? hit / total : 0;
}

/**
 * Tempo period (in envelope hops, fractional) from the onset-strength
 * autocorrelation; null when there is no pulse. Every autocorrelation peak in
 * the BPM range is a candidate, scored by its correlation × a mild ~120 BPM
 * preference (octave ties) × how well its period connects the detected
 * onsets (`onsets`, when there are enough of them to judge).
 */
function estimatePeriod(
  env: Float32Array,
  rate: number,
  minBpm: number,
  maxBpm: number,
  onsets: readonly HopOnset[],
  onsetTol: number,
): { period: number; confidence: number } | null {
  const n = env.length;
  const m = meanOf(env);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = env[i] - m;
  let energy = 0;
  for (let i = 0; i < n; i++) energy += x[i] * x[i];
  if (energy <= 1e-9) return null;
  const minLag = Math.max(2, Math.floor((60 * rate) / maxBpm));
  const maxLag = Math.min(n - 2, Math.ceil((60 * rate) / minBpm));
  if (maxLag <= minLag) return null;
  const acAt = (lag: number) => {
    if (lag >= n - 1) return 0;
    let sum = 0;
    for (let i = lag; i < n; i++) sum += x[i] * x[i - lag];
    return sum / (n - lag);
  };
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) ac[lag] = acAt(lag);
  const norm = energy / n;
  // A log-normal preference around 120 BPM (one octave wide) breaks octave ties.
  const weight = (period: number) => Math.exp(-0.5 * Math.log2((60 * rate) / period / 120) ** 2);
  const judgeOnsets = onsets.length >= 4;
  let best: { period: number; lag: number; fit: number; score: number } | null = null;
  for (let lag = minLag; lag <= maxLag; lag++) {
    // Local maxima only, so a slope near the edge of the range does not win.
    if (ac[lag] <= 0 || ac[lag] < ac[lag - 1] || ac[lag] < ac[lag + 1]) continue;
    // Parabolic interpolation for a sub-hop period.
    const y0 = ac[lag - 1];
    const y1 = ac[lag];
    const y2 = ac[lag + 1];
    const denom = y0 - 2 * y1 + y2;
    const period = lag + (denom < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom)) : 0);
    const fit = judgeOnsets ? onsetConsistency(onsets, period, Math.max(onsetTol, period * 0.06)) : 1;
    const score = (y1 / norm) * weight(period) * (0.15 + fit);
    if (!best || score > best.score) best = { period, lag, fit, score };
  }
  if (!best) return null;
  // Confidence: how strongly the signal repeats at the beat or at the bar level
  // (a kick every other beat correlates at 2 or 4 beats more than at one),
  // scaled down when the period does not connect the onsets.
  const repeat = Math.max(ac[best.lag], acAt(Math.round(2 * best.period)), acAt(Math.round(4 * best.period)));
  const confidence = Math.max(0, Math.min(1, repeat / norm)) * (judgeOnsets ? 0.5 + 0.5 * best.fit : 1);
  return { period: best.period, confidence };
}

/** Dynamic-programming beat tracker (Ellis 2007) over a normalised onset envelope. */
function trackBeats(env: Float32Array, period: number, tightness = 100): number[] {
  const n = env.length;
  if (!n) return [];
  let sd = 0;
  const m = meanOf(env);
  for (let i = 0; i < n; i++) sd += (env[i] - m) ** 2;
  sd = Math.sqrt(sd / n) || 1;
  const local = new Float64Array(n);
  for (let i = 0; i < n; i++) local[i] = env[i] / sd;
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  const lo = Math.max(1, Math.round(period / 2));
  const hi = Math.max(lo + 1, Math.round(period * 2));
  for (let t = 0; t < n; t++) {
    let best = -Infinity;
    let arg = -1;
    for (let tau = t - hi; tau <= t - lo; tau++) {
      if (tau < 0) continue;
      const s = score[tau] - tightness * Math.log((t - tau) / period) ** 2;
      if (s > best) {
        best = s;
        arg = tau;
      }
    }
    score[t] = local[t] + (arg >= 0 ? best : 0);
    back[t] = arg;
  }
  // The last beat: the best score within the final period.
  let last = n - 1;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t] > score[last]) last = t;
  const beats: number[] = [];
  for (let t = last; t >= 0; t = back[t]) beats.push(t);
  beats.reverse();
  // Trim beats in silence at either end (a fade-in, a tail).
  const strength = (b: number) => Math.max(env[b], b > 0 ? env[b - 1] : 0, b < n - 1 ? env[b + 1] : 0);
  let rms = 0;
  for (const b of beats) rms += strength(b) ** 2;
  rms = Math.sqrt(rms / Math.max(1, beats.length));
  let a = 0;
  let z = beats.length;
  while (a < z && strength(beats[a]) < rms * 0.5) a++;
  while (z > a && strength(beats[z - 1]) < rms * 0.5) z--;
  return beats.slice(a, z);
}

/**
 * Tempo, beat grid, downbeats, strong hits and onsets of a decoded signal, in
 * source frames at `fps`. Deterministic. Works on any sample rate; the server
 * decodes to 22.05 kHz mono.
 */
export function analyzeBeats(channels: readonly Float32Array[], sampleRate: number, fps: number, opts: { minBpm?: number; maxBpm?: number } = {}): BeatAnalysis {
  const samples = mixdown(channels);
  const durationInFrames = Math.ceil((samples.length / sampleRate) * fps);
  const onsetList = detectOnsetStrengths(computePeaks([samples], sampleRate, fps), fps);
  const result: BeatAnalysis = { fps, durationInFrames, bpm: null, confidence: 0, beats: [], downbeats: [], strong: [], onsets: onsetList.map((o) => o.frame) };
  const hop = Math.max(1, Math.round(sampleRate / ENVELOPE_RATE));
  /** The envelope's true rate (the hop is a whole number of samples). */
  const rate = sampleRate / hop;
  const toFrame = (h: number) => Math.min(Math.max(0, durationInFrames - 1), Math.round(((h * hop) / sampleRate) * fps));

  // Strong hits: onsets well above the typical one.
  if (onsetList.length) {
    const strengths = onsetList.map((o) => o.strength);
    const mean = meanOf(strengths);
    const sd = Math.sqrt(meanOf(strengths.map((s) => (s - mean) ** 2)));
    const top = Math.max(...strengths);
    const threshold = Math.max(mean + sd, top * 0.6);
    result.strong = onsetList.filter((o) => o.strength >= threshold).map((o) => o.frame);
  }

  // No audible attacks at all (silence, a steady tone or pad): no pulse to track.
  let peak = 0;
  for (const v of smoothed(novelty(hopLoudness(samples, hop)), 2)) peak = Math.max(peak, v);
  if (peak < MIN_ATTACK) return result;
  // The onset strength the tempo and grid follow: spectral flux, not loudness,
  // so a pad's swell or its chord tones beating against each other do not
  // outweigh the clicks on top of it.
  const env = smoothed(localRise(spectralFlux(samples, sampleRate, hop)), 2);
  const hopOnsets = onsetList.map((o) => ({ hop: (o.frame / fps) * rate, strength: o.strength }));
  const tempo = estimatePeriod(env, rate, opts.minBpm ?? 60, opts.maxBpm ?? 190, hopOnsets, (0.75 * rate) / fps);
  if (!tempo) return result;
  result.bpm = Math.round(((60 * rate) / tempo.period) * 10) / 10;
  result.confidence = Math.round(tempo.confidence * 100) / 100;
  const beatHops = trackBeats(env, tempo.period);
  if (!beatHops.length) return result;

  // Downbeats: the phase (of 4) whose beats carry the most low-end attack.
  const low = smoothed(novelty(hopLoudness(lowPass(samples, sampleRate), hop)), 2);
  const around = (a: Float32Array, h: number) => Math.max(a[h] ?? 0, a[h - 1] ?? 0, a[h + 1] ?? 0, a[h + 2] ?? 0);
  let phase = 0;
  let bestPhase = -Infinity;
  for (let p = 0; p < 4; p++) {
    let s = 0;
    let k = 0;
    for (let i = p; i < beatHops.length; i += 4) {
      s += around(low, beatHops[i]) * 2 + around(env, beatHops[i]);
      k++;
    }
    const v = k ? s / k : -Infinity;
    if (v > bestPhase + 1e-9) {
      bestPhase = v;
      phase = p;
    }
  }
  const frames = beatHops.map(toFrame);
  // Two beats never share a frame (very fast tempo at a low frame rate).
  result.beats = frames.filter((f, i) => i === 0 || f > frames[i - 1]);
  result.downbeats = [...new Set(beatHops.filter((_, i) => i % 4 === phase).map(toFrame))];
  return result;
}

/** A source-frame list mapped onto the project timeline for a clip placed at `clipStart` with `trim` and `duration`. */
export function sourceToProjectFrames(frames: readonly number[], clipStart: number, trim: number, duration: number): number[] {
  return frames.filter((f) => f >= trim && f < trim + duration).map((f) => clipStart + f - trim);
}
