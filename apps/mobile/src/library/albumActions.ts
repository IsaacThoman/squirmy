import { librarySave } from '@squirmy/client-core';
import type { RowAction } from './BrowseControls';

/** What an album's menu depends on, wherever it shows: its page, a tile, a Search row. */
export type AlbumMenuState = {
  /** Something on it plays for this viewer (offline: something on it is downloaded). Play, Shuffle and the queue need it. */
  plays: boolean;
  offline: boolean;
  /**
   * False while the server is still looking up the songs: there is nothing to add to a
   * playlist yet. A tile does not know, and the sheet loads them.
   */
  songsKnown?: boolean;
  /** The heart, where it is known: on the page, and on a Search row the server said it for. */
  saved?: { liked: boolean; failed?: boolean };
  /** For music that does not play, while the server has the wantlist on. */
  want?: { wanted: boolean; failed?: boolean };
  artists: readonly { name: string }[];
  /** `artists` leaves out the artist whose page the album is shown on, so each one left is named. */
  named?: boolean;
  /** Share, on the album's page. */
  share?: boolean;
};

/** What an album's menu runs. `goToArtist` takes the index of a credited artist. */
export type AlbumMenuRunners = {
  play: (shuffle: boolean) => void;
  enqueue: (placement: 'next' | 'last') => void;
  addToPlaylist: () => void;
  setSaved?: (saved: boolean) => void;
  setWanted?: (wanted: boolean) => void;
  goToArtist: (index: number) => void;
  share?: () => void;
};

/**
 * An album's menu, the same on its page, its tiles and its Search row, as on web: play it,
 * queue it, add it to a playlist, the library entry where it is known, the wantlist for what
 * does not play, its artists, and Share on the page. Adding to a playlist needs the server,
 * and adds every song the album lists, as web does; a gray album can be added too.
 */
export function albumActions(state: AlbumMenuState, run: AlbumMenuRunners): RowAction[] {
  const { plays, offline, songsKnown = true, saved, want, artists, named = false, share } = state;
  const items: (RowAction | false)[] = [
    ...playActions(plays, run),
    !offline && songsKnown && { title: 'Add to playlist', icon: 'text.badge.plus', onPress: run.addToPlaylist },
    // A refused change was set back, so the entry that would make it again says it failed (as the track menu does).
    saved !== undefined && run.setSaved !== undefined && libraryEntry(saved, run.setSaved),
    want !== undefined && !offline && run.setWanted !== undefined && wantEntry(want, run.setWanted),
    ...artists.map((artist, index) => ({
      title: artists.length > 1 || named ? `Go to ${artist.name}` : 'Go to artist', icon: 'music.mic', onPress: () => run.goToArtist(index),
    })),
    share === true && run.share !== undefined && { title: 'Share', icon: 'square.and.arrow.up', onPress: run.share },
  ];
  return items.filter((item): item is RowAction => Boolean(item));
}

/**
 * Play, Shuffle, Play next and Add to queue for a list of songs, while something on it plays:
 * the head of an album's menu, and of a playlist's or Liked Songs' on their pages.
 */
export function playActions(plays: boolean, run: Pick<AlbumMenuRunners, 'play' | 'enqueue'>): RowAction[] {
  if (!plays) return [];
  return [
    { title: 'Play', icon: 'play.fill', onPress: () => run.play(false) },
    { title: 'Shuffle', icon: 'shuffle', onPress: () => run.play(true) },
    { title: 'Play next', icon: 'text.line.first.and.arrowtriangle.forward', onPress: () => run.enqueue('next') },
    { title: 'Add to queue', icon: 'text.line.last.and.arrowtriangle.forward', onPress: () => run.enqueue('last') },
  ];
}

function libraryEntry({ liked, failed }: { liked: boolean; failed?: boolean }, setSaved: (saved: boolean) => void): RowAction {
  const { saved, label } = librarySave({ liked });
  const onPress = () => setSaved(!saved);
  if (failed) return { title: `Couldn’t ${saved ? 'remove from' : 'save to'} library. Try again`, icon: 'exclamationmark.circle', onPress };
  return { title: label, icon: saved ? 'heart.slash' : 'heart', onPress };
}

function wantEntry({ wanted, failed }: { wanted: boolean; failed?: boolean }, setWanted: (wanted: boolean) => void): RowAction {
  const onPress = () => setWanted(!wanted);
  if (failed) return { title: `Couldn’t ${wanted ? 'remove from' : 'add to'} wantlist. Try again`, icon: 'exclamationmark.circle', onPress };
  return wanted ? { title: 'Remove from wantlist', icon: 'star.slash', onPress } : { title: 'Add to wantlist', icon: 'star', onPress };
}

/** What VoiceOver hears once songs are queued: the queue may be out of sight, so it says it worked. */
export function queuedMessage(placement: 'next' | 'last'): string {
  return placement === 'next' ? 'Playing next' : 'Added to queue';
}

/**
 * The question asked before songs a playlist has already go in again, as on web: one song,
 * all of them, or some, where Skip adds only the others. Null when none is there yet.
 */
export function repeatedAddPrompt(playlist: string, tracks: readonly { id: string; title: string }[], repeated: readonly { id: string }[]) {
  if (!repeated.length) return null;
  const title = `Already in “${playlist}”`;
  if (tracks.length === 1) return { title, message: `Add “${tracks[0]!.title}” again?`, skip: null };
  if (repeated.length >= tracks.length) return { title, message: `All ${songs(tracks.length)} are already in this playlist. Add them again?`, skip: null };
  const fresh = tracks.length - repeated.length;
  return {
    title,
    message: `${repeated.length} of these ${songs(tracks.length)} ${repeated.length === 1 ? 'is' : 'are'} already in this playlist. Skip adds only the other ${songs(fresh)}.`,
    skip: 'Skip',
  };
}

const songs = (count: number) => `${count} ${count === 1 ? 'song' : 'songs'}`;
