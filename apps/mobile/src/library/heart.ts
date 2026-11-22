import { librarySave } from '@squirmy/client-core';

export type HeartButton = { icon: 'heart' | 'heart.fill'; label: string; selected: boolean };

/**
 * The heart on a track, album or artist: the one library control, so its spoken label says
 * what it does to the library. `liked` already counts what the user just did here.
 */
export function heartButton(liked: boolean, name: string): HeartButton {
  const { saved } = librarySave({ liked });
  return saved
    ? { icon: 'heart.fill', label: `Remove ${name} from library`, selected: true }
    : { icon: 'heart', label: `Save ${name} to library`, selected: false };
}
