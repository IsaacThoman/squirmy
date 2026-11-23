/**
 * What a refused change says where it was made: on its control, under it, or in its sheet,
 * and to VoiceOver. The app has no toasts. A heart's words are in `heart.ts`.
 */

/** A wantlist change the server refused. `refused`: the value it would not take. */
export function wantFailure(refused: boolean, title: string): string {
  return refused ? `Couldn’t add “${title}” to your wantlist. Try again.` : `Couldn’t remove “${title}” from your wantlist. Try again.`;
}

/** The wantlist control's own short words for that failure, where the title is already on screen. */
export function wantFailureLabel(refused: boolean): string {
  return refused ? 'Couldn’t add. Try again' : 'Couldn’t remove. Try again';
}

/** The line a playlist's page shows when the server refused an edit made to it; the edit was put back. */
export function playlistEditFailure(edit: 'remove' | 'move' | 'delete'): string {
  switch (edit) {
    case 'remove': return 'Couldn’t remove the song. Try again.';
    case 'move': return 'Couldn’t move the song. Try again.';
    case 'delete': return 'Couldn’t delete the playlist. Try again.';
  }
}

/** What the add-to-playlist sheet says when the server refused the song. */
export function playlistAddFailure(name: string): string {
  return `Couldn’t add to “${name}”. Try again.`;
}

/** A radio that didn't start: on the button that started it, or, from a menu that has closed, in the player. */
export const radioFailure = 'Couldn’t start radio. Try again';

/** Play or Shuffle could not load the rest of a long list; it played what was loaded. */
export const playAllFailure = 'Couldn’t load the whole list. Playing the songs loaded so far.';
