// The Player's sound and clock. Every declared <Audio> is decoded once into
// an AudioBuffer and scheduled on one shared AudioContext, so the picture
// clock and the sound share a time base: frame f is heard at
//   anchorTime + (f - anchorFrame) / fps
// and shown when the output clock (currentTime minus output latency) reaches
// that time. Gains follow each sound's per-frame volume as linear ramps.

import type { RegisteredAudio } from './hostContext';

let shared: AudioContext | null = null;
const buffers = new Map<string, Promise<AudioBuffer | null>>();

export function audioContext(): AudioContext | null {
  if (shared) return shared;
  if (typeof window === 'undefined' || typeof window.AudioContext !== 'function') return null;
  shared = new AudioContext({ latencyHint: 'interactive' });
  return shared;
}

function loadBuffer(src: string): Promise<AudioBuffer | null> {
  let p = buffers.get(src);
  if (!p) {
    const ctx = audioContext();
    p = ctx
      ? fetch(src)
          .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(`${r.status}`))))
          .then((data) => ctx.decodeAudioData(data))
          .catch((err) => {
            console.warn(`[player] could not decode audio ${src}: ${err instanceof Error ? err.message : err}`);
            buffers.delete(src);
            return null;
          })
      : Promise.resolve(null);
    buffers.set(src, p);
  }
  return p;
}

/** Seconds of lead before the first scheduled sample, so nothing is scheduled in the past. */
const LEAD = 0.03;

interface Voice {
  key: string;
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export class AudioEngine {
  private items = new Map<string, RegisteredAudio>();
  private voices: Voice[] = [];
  private master: GainNode | null = null;
  private ready = new Map<string, AudioBuffer>();
  private anchorFrame = 0;
  private anchorTime = 0;
  private running = false;
  private fps = 30;
  /** Stop scheduling at this frame (exclusive): the loop end or the end of the composition. */
  private endFrame = Infinity;
  private muted = false;

  register(audio: RegisteredAudio): () => void {
    this.items.set(audio.key, audio);
    void loadBuffer(audio.src).then((buffer) => {
      if (!buffer || this.items.get(audio.key) !== audio) return;
      this.ready.set(audio.src, buffer);
      if (this.running) this.scheduleOne(audio);
    });
    if (this.running) {
      this.stopVoices(audio.key);
      this.scheduleOne(audio);
    }
    return () => {
      if (this.items.get(audio.key) === audio) this.items.delete(audio.key);
      this.stopVoices(audio.key);
    };
  }

  /** Output clock: the context time being heard now, or null while the context is not running. */
  now(): number | null {
    const ctx = audioContext();
    if (!ctx || ctx.state !== 'running') return null;
    const latency = (ctx as AudioContext & { outputLatency?: number }).outputLatency || ctx.baseLatency || 0;
    return ctx.currentTime - latency;
  }

  /** Resume the context; call synchronously inside the user's gesture. */
  unlock(): void {
    const ctx = audioContext();
    if (ctx && ctx.state !== 'running') void ctx.resume().catch(() => undefined);
  }

  get contextRunning(): boolean {
    return audioContext()?.state === 'running';
  }

  /** Start sounding from `frame` (fractional allowed). Returns the context time that frame plays at. */
  start(frame: number, fps: number, endFrame: number): number {
    const ctx = audioContext();
    this.stop();
    this.fps = fps;
    this.endFrame = endFrame;
    if (!ctx) return 0;
    this.anchorFrame = frame;
    this.anchorTime = ctx.currentTime + LEAD;
    this.running = true;
    for (const item of this.items.values()) this.scheduleOne(item);
    return this.anchorTime;
  }

  /** Context time at which `frame` is heard (valid while running). */
  timeOf(frame: number): number {
    return this.anchorTime + (frame - this.anchorFrame) / this.fps;
  }

  /** Re-anchor at a loop wrap: `frame` plays at context time `time`. */
  restartAt(frame: number, time: number): void {
    this.stopVoices();
    this.anchorFrame = frame;
    this.anchorTime = time;
    if (!this.running) return;
    for (const item of this.items.values()) this.scheduleOne(item);
  }

  stop(): void {
    this.running = false;
    this.stopVoices();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master) this.master.gain.value = muted ? 0 : 1;
  }

  private output(): GainNode | null {
    const ctx = audioContext();
    if (!ctx) return null;
    if (!this.master) {
      this.master = ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 1;
      this.master.connect(ctx.destination);
    }
    return this.master;
  }

  private scheduleOne(item: RegisteredAudio): void {
    const ctx = audioContext();
    const buffer = this.ready.get(item.src);
    const out = this.output();
    if (!ctx || !buffer || !out) return;
    const fps = this.fps;
    const nowFrame = this.anchorFrame + (Math.max(ctx.currentTime + 0.005, this.anchorTime) - this.anchorTime) * fps;
    const begin = Math.max(item.from, nowFrame);
    const end = Math.min(item.from + item.durationInFrames, this.endFrame);
    if (end <= begin) return;
    const when = this.timeOf(begin);
    const offset = (item.trimBefore + (begin - item.from)) / fps;
    if (offset >= buffer.duration) return;
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const gain = ctx.createGain();
    const first = Math.floor(begin);
    gain.gain.setValueAtTime(clamp01(item.volume(first - item.from)), when);
    for (let f = first + 1; f < end; f++) gain.gain.linearRampToValueAtTime(clamp01(item.volume(f - item.from)), this.timeOf(f));
    source.connect(gain).connect(out);
    source.start(when, offset, (end - begin) / fps);
    const voice = { key: item.key, source, gain };
    source.onended = () => {
      this.voices = this.voices.filter((v) => v !== voice);
      gain.disconnect();
    };
    this.voices.push(voice);
  }

  private stopVoices(key?: string): void {
    const keep: Voice[] = [];
    for (const v of this.voices) {
      if (key !== undefined && v.key !== key) {
        keep.push(v);
        continue;
      }
      v.source.onended = null;
      try {
        v.source.stop();
      } catch {
        /* never started */
      }
      v.source.disconnect();
      v.gain.disconnect();
    }
    this.voices = keep;
  }
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0);
