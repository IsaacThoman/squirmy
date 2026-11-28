import { isPlayable, librarySave, type PlaybackNotice, type Viewer } from '@squirmy/client-core';
import type { TrackSummary } from '@squirmy/contracts';
import type { Href } from 'expo-router';
import type { TrackDownload } from '../downloads/model';
import type { Page } from './links';

/** One thing to do with a track: a command, a page to open, or a sheet to open. */
export type TrackAction = {
  id: TrackActionId;
  title: string;
  /** What a page action leads to, such as the album's title, for a menu that shows it under the title. */
  subtitle?: string;
  icon: string;
  destructive?: boolean;
  run?: () => void;
  href?: Href;
  /** A page in the tab on screen when the action runs. */
  page?: { page: Extract<Page, 'album' | 'artist'>; id: string };
  sheet?: boolean;
};

export type TrackActionId =
  | 'play' | 'resume' | 'next' | 'last' | 'like' | 'unlike' | 'download' | 'retryDownload' | 'removeDownload'
  | 'playlist' | 'radio' | 'want' | 'unwant' | 'album' | 'artist' | 'remove' | 'info';

export type TrackActionOptions = {
  /** The playlist the track is shown in, for "Remove from playlist". */
  playlist?: { id: string; itemId: string; onRemove?: (itemId: string) => void };
  /** The album whose page the track is shown on, which "Go to album" would only reopen. */
  album?: string;
  /** The artist whose page the track is shown on, which "Go to artist" would only reopen. */
  artist?: string;
};

/** What a track's menu depends on, read by the row that shows it. */
export type TrackActionState = {
  /** The heart: saved to the user's library, counting what the user just did here. */
  liked: boolean;
  /** The heart's change the server just refused (`useLikeFailure`): the library entry says so, and tries again. */
  likeFailure?: boolean;
  playable: boolean;
  offline: boolean;
  /** Whether the track is the current entry, and if so whether it plays. */
  current: 'playing' | 'paused' | null;
  download: TrackDownload | undefined;
  /** Downloaded on its own, not only as part of an album or playlist, so it can be removed here. */
  onItsOwn: boolean;
  /** The server has the wantlist on. */
  wantlist: boolean;
  /** On the wantlist already, so the menu offers to take it off. */
  wanted?: boolean;
  /** The wantlist change the server just refused (`useWantFailure`): the wantlist entry says so, and tries again. */
  wantFailure?: boolean;
  /** Who is signed in: a radio starts from what the server plays for them, never from a download alone. */
  viewer?: Viewer | null;
};

/**
 * What the player's status line says when a song is queued from a menu or a swipe, where the
 * queue isn't on screen (the app has no toasts), in the web menu's words.
 */
export function queuedNotice(title: string, placement: 'next' | 'last'): PlaybackNotice {
  return { message: placement === 'next' ? 'Playing next' : 'Added to queue', detail: title };
}

/** What the status line says while a radio from a menu, which has closed, is on its way, as on the web. */
export const radioStartingNotice: PlaybackNotice = { message: 'Starting radio…' };

/** A menu entry whose last try the server refused: it says so, and choosing it tries again. */
const failed = (what: string) => ({ title: `${what}. Try again`, icon: 'exclamationmark.circle' });

/** A key for an action in a list: a track has one "Go to" action per artist. */
export function trackActionKey(action: Pick<TrackAction, 'id' | 'page'>): string {
  return action.page ? `${action.id}:${action.page.id}` : action.id;
}

/**
 * What can be done with `track`, in menu order. Gray tracks can only be saved to or removed
 * from the library, wanted (when the server has the wantlist on) and opened. The library entry
 * flips the heart (`librarySave`), so a track has one, collection songs too. Offline, what
 * needs the server is left out, and hearts wait for it. The result only describes the
 * actions; `useTrackActionRunner` carries one out when it is chosen.
 */
export function trackActions(track: TrackSummary, state: TrackActionState, { playlist, album, artist }: TrackActionOptions = {}): TrackAction[] {
  const { liked, likeFailure, playable, offline, current, download, onItsOwn, wantlist, wanted, wantFailure, viewer } = state;
  const online = !offline;
  const library = librarySave({ liked });
  const downloadAction: TrackAction | false = download?.state === 'failed' && onItsOwn
    ? { id: 'retryDownload', title: 'Retry download', icon: 'arrow.clockwise' }
    : download && onItsOwn
      ? { id: 'removeDownload', title: download.state === 'done' ? 'Remove download' : 'Cancel download',
        icon: download.state === 'done' ? 'trash' : 'xmark.circle', destructive: download.state === 'done' }
      // What plays for this user downloads: a song the server does not have yet is fetched first.
      : !download && online && isPlayable(track, viewer) && { id: 'download', title: 'Download', icon: 'arrow.down.circle' };
  const items: (TrackAction | false)[] = [
    // The current track can only be resumed; queueing it next would play it twice.
    playable && current === null && { id: 'play', title: 'Play now', icon: 'play.fill' },
    playable && current === 'paused' && { id: 'resume', title: 'Play', icon: 'play.fill' },
    playable && current === null && { id: 'next', title: 'Play next', icon: 'text.line.first.and.arrowtriangle.forward' },
    playable && { id: 'last', title: 'Add to queue', icon: 'text.line.last.and.arrowtriangle.forward' },
    // A refused change was set back, so the entry that would make it again says it failed.
    library.saved
      ? { id: 'unlike', ...likeFailure === undefined ? { title: library.label, icon: 'heart.slash' } : failed('Couldn’t remove from library') }
      : { id: 'like', ...likeFailure === undefined ? { title: library.label, icon: 'heart' } : failed('Couldn’t save to library') },
    downloadAction,
    playable && online && { id: 'playlist', title: 'Add to playlist', icon: 'text.badge.plus', sheet: true,
      href: { pathname: '/add-to-playlist', params: { trackId: track.id, albumId: track.album?.id ?? '' } } },
    // The server seeds the radio by the queue's rule, so a song that plays only from the
    // device (gone from the server, or `on_demand` for someone who may not fetch) has none.
    online && isPlayable(track, viewer) && { id: 'radio', title: 'Start radio', icon: 'dot.radiowaves.left.and.right' },
    // Only what does not play for this user: for someone who may fetch music nothing is wanted.
    // Added or removed alike, as on web.
    wantlist && !playable && track.availability !== 'server' && online && (wanted
      ? { id: 'unwant', ...wantFailure === undefined ? { title: 'Remove from wantlist', icon: 'star.slash' } : failed('Couldn’t remove from wantlist') }
      : { id: 'want', ...wantFailure === undefined ? { title: 'Add to wantlist', icon: 'star' } : failed('Couldn’t add to wantlist') }),
    ...trackLinks(track, album, artist),
    playlist !== undefined && online && { id: 'remove', title: 'Remove from playlist', icon: 'minus.circle', destructive: true },
    // What the device playing it says of its file and stream: only the current song has that.
    current !== null && { id: 'info', title: 'Track info', icon: 'info.circle', sheet: true, href: '/track-info' },
  ];
  return items.filter((item): item is TrackAction => Boolean(item));
}

/**
 * The pages a track leads to: its album, unless that is the page it is shown on, then each
 * credited artist's but the one whose page it is shown on, as on an artist's page a featured
 * artist is often not the first. Each is named when there is more than one artist. Only what
 * exists: a track with no album has no "Go to album".
 */
export function trackLinks(track: TrackSummary, album?: string, here?: string): TrackAction[] {
  const links: TrackAction[] = [];
  if (track.album && track.album.id !== album) {
    links.push({ id: 'album', title: 'Go to album', subtitle: track.album.title, icon: 'square.stack', page: { page: 'album', id: track.album.id } });
  }
  for (const artist of track.artists) {
    if (artist.id === here) continue;
    links.push({
      id: 'artist', title: track.artists.length > 1 ? `Go to ${artist.name}` : 'Go to artist', subtitle: artist.name, icon: 'music.mic',
      page: { page: 'artist', id: artist.id },
    });
  }
  return links;
}
