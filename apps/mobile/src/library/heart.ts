import { librarySave } from '@squirmy/client-core';

export type HeartButton = {
  icon: 'heart' | 'heart.fill' | 'exclamationmark.circle';
  label: string;
  selected: boolean;
  /** The server refused the last change: the heart shows the error in place, and a tap tries again. */
  failed: boolean;
};

/** What a heart the server refused says, on the heart and to VoiceOver. `refused`: the value it would not take. */
export function heartFailure(refused: boolean, name?: string): string {
  const item = name ? `“${name}”` : 'that';
  return refused ? `Couldn’t save ${item} to your library. Try again.` : `Couldn’t remove ${item} from your library. Try again.`;
}

/**
 * The heart on a track, album or artist: the one library control, so its spoken label says
 * what it does to the library. `liked` already counts what the user just did here.
 * `failure` is the change the server just refused (`useLikeFailure`): for a few seconds the
 * heart shows an error instead, and since it was set back, a tap sends the same change again.
 */
export function heartButton(liked: boolean, name: string, failure?: boolean): HeartButton {
  const { saved } = librarySave({ liked });
  if (failure !== undefined) return { icon: 'exclamationmark.circle', label: heartFailure(failure, name), selected: saved, failed: true };
  return saved
    ? { icon: 'heart.fill', label: `Remove ${name} from library`, selected: true, failed: false }
    : { icon: 'heart', label: `Save ${name} to library`, selected: false, failed: false };
}

/** The heart's color: the error color while it shows a failure, the accent while on. */
export function heartColor(heart: HeartButton, colors: { danger: string; accent: string }, off: string): string {
  return heart.failed ? colors.danger : heart.selected ? colors.accent : off;
}
