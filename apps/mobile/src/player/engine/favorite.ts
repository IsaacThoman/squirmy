import { librarySave } from '@squirmy/client-core';
import type { TrackSummary } from '@squirmy/contracts';

/** The star on the lock screen: shown while `available`, filled while `active`. */
export type FavoriteState = { available: boolean; active: boolean; label: string };

export const noFavorite: FavoriteState = { available: false, active: false, label: '' };

/**
 * The lock screen's star for `track`, which is the heart: filled when the track is saved to
 * the library. `likes` holds hearts changed since the summary was loaded (here, or on
 * another device), and wins over it, as everywhere the heart shows. Any track can be saved,
 * offline too (the heart waits to be sent), but only once its summary is in: hidden till then.
 */
export function favoriteState(
  track: Pick<TrackSummary, 'id' | 'liked'> | null | undefined,
  likes: ReadonlyMap<string, boolean>,
): FavoriteState {
  if (!track) return noFavorite;
  const { saved, label } = librarySave(track, likes.get(`track:${track.id}`));
  return { available: true, active: saved, label };
}

export function sameFavorite(a: FavoriteState, b: FavoriteState): boolean {
  return a.available === b.available && a.active === b.active && a.label === b.label;
}
