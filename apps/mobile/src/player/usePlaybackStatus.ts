import { useSyncExternalStore } from 'react';
import { announce } from '../inlineFeedback';
import { PlaybackStatusStore, type PlaybackStatus } from './playbackStatus';

/** The one store `PlaybackProvider` reports to; the mini player and Now Playing read it. */
export const playbackStatus = new PlaybackStatusStore(announce);

/** The status the player shows in place of the artist line, if any. */
export function usePlaybackStatus(): PlaybackStatus | null {
  return useSyncExternalStore(playbackStatus.subscribe, playbackStatus.current);
}
