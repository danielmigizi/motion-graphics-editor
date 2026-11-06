// Playback must start synchronously inside the user's click/key handler:
// browsers only allow audio playback from a user gesture, and the Player
// resumes its AudioContext there.

import type { PlayerRef } from '../runtime';
import type { SyntheticEvent } from 'react';

let player: PlayerRef | null = null;

export function registerPlayer(ref: PlayerRef | null): void {
  player = ref;
}

/** Toggle play/pause from a user gesture. The store follows the Player's play/pause events. */
export function togglePlayback(e?: SyntheticEvent | Event): void {
  if (!player) return;
  if (player.isPlaying()) player.pause();
  else player.play(e as SyntheticEvent | undefined);
}
