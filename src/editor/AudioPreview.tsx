// Audio preview for lists (Assets panel, New video's Music step, Insert ›
// Sound effects): one shared <audio> element for the whole editor, so starting
// a preview stops the previous one. Independent of the timeline's playback.

import { useSyncExternalStore } from 'react';
import { resolveAssetUrl } from '../core/timing';
import { Icon } from './icons';

let audio: HTMLAudioElement | null = null;
let playing: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

function player(): HTMLAudioElement {
  if (!audio) {
    audio = new Audio();
    audio.preload = 'auto';
    const stop = () => {
      playing = null;
      emit();
    };
    // Not 'pause': switching files pauses first, and that event arrives after the new one started.
    audio.addEventListener('ended', stop);
    audio.addEventListener('error', stop);
  }
  return audio;
}

/** Play `src` (asset-root-relative), or stop it when it is the one playing. */
export function togglePreview(src: string) {
  const a = player();
  if (playing === src) {
    stopPreview();
    return;
  }
  a.pause();
  a.src = resolveAssetUrl('/', src);
  a.currentTime = 0;
  playing = src;
  emit();
  void a.play().catch(() => {
    // A newer preview interrupting this one is not a failure of the newer one.
    if (playing !== src) return;
    playing = null;
    emit();
  });
}

export function stopPreview() {
  if (!playing) return;
  player().pause();
  playing = null;
  emit();
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function usePreviewing(): string | null {
  return useSyncExternalStore(subscribe, () => playing, () => null);
}

/** A round play/stop button for one audio file. */
export function AudioPlayButton({ src, name, testId }: { src: string; name: string; testId?: string }) {
  const on = usePreviewing() === src;
  return (
    <button
      type="button"
      className={`audio-play ${on ? 'on' : ''}`}
      aria-label={on ? `Stop ${name}` : `Play ${name}`}
      aria-pressed={on}
      title={on ? 'Stop' : 'Listen'}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation();
        togglePreview(src);
      }}
    >
      <Icon name={on ? 'pause' : 'play'} size={11} />
    </button>
  );
}
