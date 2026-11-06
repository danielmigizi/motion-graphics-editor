// Our Player: plays a composition in the editor. The clock is the shared
// AudioContext (sound and picture share one time base), snapped to whole
// frames; the picture is scaled to fit its box; an in/out range can loop.
// Imperative API: play/pause/toggle/seekTo/getCurrentFrame/isPlaying; events:
// frameupdate, play, pause, ended, seeked, waiting, resume.

import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type SyntheticEvent } from 'react';
import { AudioEngine } from './audioEngine';
import { NATIVE_MEDIA } from './media';
import { Readiness } from './readiness';
import { RuntimeRoot } from './RuntimeRoot';

export interface PlayerEventMap {
  frameupdate: { frame: number };
  seeked: { frame: number };
  play: Record<string, never>;
  pause: Record<string, never>;
  ended: Record<string, never>;
  waiting: Record<string, never>;
  resume: Record<string, never>;
}
export type PlayerEventName = keyof PlayerEventMap;
export type PlayerListener<K extends PlayerEventName> = (e: { detail: PlayerEventMap[K] }) => void;

export interface PlayerRef {
  play(e?: SyntheticEvent | Event): void;
  pause(): void;
  toggle(e?: SyntheticEvent | Event): void;
  seekTo(frame: number): void;
  getCurrentFrame(): number;
  isPlaying(): boolean;
  mute(): void;
  unmute(): void;
  isMuted(): boolean;
  /** Native only: an image, font or video frame is still loading. */
  isBuffering?(): boolean;
  addEventListener<K extends PlayerEventName>(name: K, cb: PlayerListener<K>): void;
  removeEventListener<K extends PlayerEventName>(name: K, cb: PlayerListener<K>): void;
}

export interface PlayerProps<P extends Record<string, unknown>> {
  component: React.ComponentType<P>;
  inputProps: P;
  durationInFrames: number;
  fps: number;
  compositionWidth: number;
  compositionHeight: number;
  style?: React.CSSProperties;
  className?: string;
  loop?: boolean;
  inFrame?: number | null;
  outFrame?: number | null;
  initialFrame?: number;
  initiallyMuted?: boolean;
  autoPlay?: boolean;
  clickToPlay?: boolean;
  /** After playing off the end (no loop), go back to the start. */
  moveToBeginningWhenEnded?: boolean;
}

const clampFrame = (f: number, total: number) => Math.max(0, Math.min(Math.round(f), Math.max(1, total) - 1));

/** The composition at its own size, scaled (contain) and centred in the box. */
export const ScaledStage: React.FC<{ width: number; height: number; style?: React.CSSProperties; className?: string; onClick?: (e: React.MouseEvent) => void; children: React.ReactNode }> = ({
  width,
  height,
  style,
  className,
  onClick,
  children,
}) => {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setSize({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = size ? Math.min(size.w / width, size.h / height) : 0;
  return (
    <div ref={box} className={className} onClick={onClick} style={{ position: 'relative', overflow: 'hidden', ...style }}>
      {size && scale > 0 ? (
        <div
          style={{
            position: 'absolute',
            left: (size.w - width * scale) / 2,
            top: (size.h - height * scale) / 2,
            width,
            height,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            overflow: 'hidden',
          }}
        >
          {children}
        </div>
      ) : null}
    </div>
  );
};

function PlayerInner<P extends Record<string, unknown>>(props: PlayerProps<P>, ref: React.ForwardedRef<PlayerRef>) {
  const {
    component: Component,
    inputProps,
    durationInFrames,
    fps,
    compositionWidth,
    compositionHeight,
    style,
    className,
    loop = false,
    inFrame = null,
    outFrame = null,
    initialFrame = 0,
    initiallyMuted = false,
    autoPlay = false,
    clickToPlay = false,
    moveToBeginningWhenEnded = true,
  } = props;
  const [frame, setFrame] = useState(() => clampFrame(initialFrame, durationInFrames));
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(initiallyMuted);
  const readiness = useMemo(() => new Readiness(), []);
  const engine = useMemo(() => new AudioEngine(), []);
  const listeners = useRef(new Map<PlayerEventName, Set<(e: { detail: unknown }) => void>>());
  // The truth, readable synchronously between renders.
  const live = useRef({ frame, playing: false, raf: 0, anchorFrame: 0, anchorTime: 0, clock: 'perf' as 'perf' | 'audio' });
  const cfg = useRef({ durationInFrames, fps, loop, inFrame, outFrame, moveToBeginningWhenEnded });
  cfg.current = { durationInFrames, fps, loop, inFrame, outFrame, moveToBeginningWhenEnded };

  const emit = useCallback(<K extends PlayerEventName>(name: K, detail: PlayerEventMap[K]) => {
    for (const cb of [...(listeners.current.get(name) ?? [])]) cb({ detail });
  }, []);

  const range = () => {
    const c = cfg.current;
    const last = Math.max(1, c.durationInFrames) - 1;
    const start = c.inFrame !== null ? Math.max(0, Math.min(c.inFrame, last)) : 0;
    const end = c.outFrame !== null ? Math.max(start, Math.min(c.outFrame, last)) : last;
    return { start, end };
  };

  const show = useCallback(
    (f: number) => {
      if (f === live.current.frame) return;
      live.current.frame = f;
      setFrame(f);
      emit('frameupdate', { frame: f });
    },
    [emit],
  );

  /** Clock time now: the audio output clock when the context runs, else performance time. */
  const clockNow = () => {
    const t = engine.now();
    return t !== null ? { kind: 'audio' as const, t } : { kind: 'perf' as const, t: performance.now() / 1000 };
  };

  const anchor = (f: number) => {
    const { end } = range();
    const loopEnd = cfg.current.loop ? end + 1 : Math.max(1, cfg.current.durationInFrames);
    if (engine.contextRunning) {
      live.current.clock = 'audio';
      live.current.anchorTime = engine.start(f, cfg.current.fps, loopEnd);
    } else {
      engine.stop();
      live.current.clock = 'perf';
      live.current.anchorTime = performance.now() / 1000;
    }
    live.current.anchorFrame = f;
  };

  const tick = useCallback(() => {
    const l = live.current;
    if (!l.playing) return;
    const now = clockNow();
    // The context started running after play(): move the clock (and sound) onto it.
    if (now.kind !== l.clock) {
      anchor(l.clock === 'perf' ? l.anchorFrame + Math.max(0, performance.now() / 1000 - l.anchorTime) * cfg.current.fps : l.frame);
      l.raf = requestAnimationFrame(tick);
      return;
    }
    const exact = l.anchorFrame + Math.max(0, now.t - l.anchorTime) * cfg.current.fps;
    let f = Math.floor(exact + 1e-6);
    const { start, end } = range();
    if (f > end) {
      if (cfg.current.loop) {
        const len = end - start + 1;
        const over = exact - (end + 1);
        const wrapTime = l.anchorTime + (end + 1 - l.anchorFrame) / cfg.current.fps;
        l.anchorFrame = start;
        l.anchorTime = wrapTime;
        if (l.clock === 'audio') engine.restartAt(start, wrapTime);
        f = start + Math.floor((over % len) + 1e-6);
      } else {
        show(end);
        stop();
        emit('ended', {});
        if (cfg.current.moveToBeginningWhenEnded) show(start);
        return;
      }
    }
    show(f);
    l.raf = requestAnimationFrame(tick);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, emit, engine]);

  const stop = () => {
    const l = live.current;
    if (!l.playing) return;
    l.playing = false;
    cancelAnimationFrame(l.raf);
    engine.stop();
    setPlaying(false);
    emit('pause', {});
  };

  const play = (e?: SyntheticEvent | Event) => {
    void e;
    const l = live.current;
    if (l.playing) return;
    engine.unlock();
    const { start, end } = range();
    let f = l.frame;
    if (f >= end || (cfg.current.loop && (f < start || f > end))) f = start;
    show(f);
    l.playing = true;
    anchor(f);
    setPlaying(true);
    emit('play', {});
    l.raf = requestAnimationFrame(tick);
  };

  const seekTo = (target: number) => {
    const f = clampFrame(target, cfg.current.durationInFrames);
    show(f);
    if (live.current.playing) anchor(f);
    emit('seeked', { frame: f });
  };

  useImperativeHandle(ref, () => ({
    play,
    pause: stop,
    toggle: (e) => (live.current.playing ? stop() : play(e)),
    seekTo,
    getCurrentFrame: () => live.current.frame,
    isPlaying: () => live.current.playing,
    mute: () => setMuted(true),
    unmute: () => setMuted(false),
    isMuted: () => muted,
    isBuffering: () => readiness.busy,
    addEventListener: (name, cb) => {
      const set = listeners.current.get(name) ?? new Set();
      set.add(cb as (e: { detail: unknown }) => void);
      listeners.current.set(name, set);
    },
    removeEventListener: (name, cb) => void listeners.current.get(name)?.delete(cb as (e: { detail: unknown }) => void),
  }));

  useEffect(() => engine.setMuted(muted), [engine, muted]);

  // Buffering (an image or video still loading) as waiting / resume.
  useEffect(() => {
    let waiting = false;
    return readiness.subscribe(() => {
      if (readiness.busy !== waiting) {
        waiting = readiness.busy;
        emit(waiting ? 'waiting' : 'resume', {});
      }
    });
  }, [readiness, emit]);

  // A shorter composition (or a moved range) never leaves the playhead past the end.
  useEffect(() => {
    if (live.current.frame > durationInFrames - 1) seekTo(durationInFrames - 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [durationInFrames]);

  useEffect(() => {
    if (autoPlay) play();
    return () => {
      cancelAnimationFrame(live.current.raf);
      live.current.playing = false;
      engine.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const config = useMemo(() => ({ width: compositionWidth, height: compositionHeight, fps, durationInFrames: Math.max(1, durationInFrames) }), [compositionWidth, compositionHeight, fps, durationInFrames]);
  const playback = useMemo(() => ({ playing, muted }), [playing, muted]);
  return (
    <ScaledStage width={compositionWidth} height={compositionHeight} style={style} className={className} onClick={clickToPlay ? (e) => (live.current.playing ? stop() : play(e)) : undefined}>
      <RuntimeRoot frame={frame} config={config} environment={PREVIEW_ENV} delay={readiness} media={NATIVE_MEDIA} playback={playback} audio={engine}>
        <Component {...inputProps} />
      </RuntimeRoot>
    </ScaledStage>
  );
}

const PREVIEW_ENV = { isRendering: false, isPlayer: true };

export const Player = forwardRef(PlayerInner) as <P extends Record<string, unknown>>(props: PlayerProps<P> & { ref?: React.Ref<PlayerRef> }) => React.ReactElement;

/** One still frame of a composition, scaled to fit (timeline thumbnails). */
export function Thumbnail<P extends Record<string, unknown>>(props: {
  component: React.ComponentType<P>;
  inputProps: P;
  compositionWidth: number;
  compositionHeight: number;
  durationInFrames: number;
  fps: number;
  frameToDisplay: number;
  style?: React.CSSProperties;
  className?: string;
}) {
  const { component: Component, inputProps, compositionWidth, compositionHeight, durationInFrames, fps, frameToDisplay, style, className } = props;
  const readiness = useMemo(() => new Readiness(), []);
  const config = useMemo(() => ({ width: compositionWidth, height: compositionHeight, fps, durationInFrames: Math.max(1, durationInFrames) }), [compositionWidth, compositionHeight, fps, durationInFrames]);
  return (
    <ScaledStage width={compositionWidth} height={compositionHeight} style={style} className={className}>
      <RuntimeRoot frame={clampFrame(frameToDisplay, durationInFrames)} config={config} environment={PREVIEW_ENV} delay={readiness} media={NATIVE_MEDIA} playback={PAUSED_MUTED}>
        <Component {...inputProps} />
      </RuntimeRoot>
    </ScaledStage>
  );
}

const PAUSED_MUTED = { playing: false, muted: true };
