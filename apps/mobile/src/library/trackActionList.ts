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
  /** Shown as a submenu of these actions, as the stars of Rating. */
  children?: TrackAction[];
  /** Marked as the current choice of its submenu. */
  checked?: boolean;
  /** The stars a Rate action gives, 0 for none. */
  rating?: number;
};

export type TrackActionId =
  | 'play' | 'resume' | 'next' | 'last' | 'like' | 'unlike' | 'download' | 'retryDownload' | 'removeDownload'
  | 'playlist' | 'radio' | 'sonicRadio' | 'share' | 'want' | 'unwant' | 'album' | 'artist' | 'remove' | 'info' | 'rating' | 'rate'
  | 'credits';

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
  /** The server lets members make public links: Share makes one, as on web. */
  sharing?: boolean;
  /** The user shows star ratings (`showRatings`): the menu offers 1 to 5 stars, as on web. */
  ratings?: boolean;
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

/** A key for an action in a list: a track has one "Go to" action per artist, and Rating one Rate per number of stars. */
export function trackActionKey(action: Pick<TrackAction, 'id' | 'page' | 'rating'>): string {
  if (action.rating !== undefined) return `${action.id}:${action.rating}`;
  return action.page ? `${action.id}:${action.page.id}` : action.id;
}

/** What a rating reads as in the menu and to VoiceOver. */
export const starsLabel = (stars: number) => (stars === 1 ? '1 star' : `${stars} stars`);

/** "Rating: 4 stars": a submenu of 5 to 1 stars with the song's own checked, and No rating once it has one, as on web. */
export function ratingAction(track: Pick<TrackSummary, 'rating'>): TrackAction {
  const current = track.rating ?? 0;
  return {
    id: 'rating', title: current ? `Rating: ${starsLabel(current)}` : 'Rating', icon: 'star',
    children: [
      ...[5, 4, 3, 2, 1].map((stars): TrackAction => ({
        id: 'rate', rating: stars, title: starsLabel(stars), icon: stars === current ? 'checkmark' : 'star', checked: stars === current,
      })),
      ...current ? [{ id: 'rate' as const, rating: 0, title: 'No rating', icon: 'star.slash' }] : [],
    ],
  };
}

/**
 * What can be done with `track`, in menu order. Gray tracks can only be saved to or removed
 * from the library, wanted (when the server has the wantlist on) and opened. The library entry
 * flips the heart (`librarySave`), so a track has one, collection songs too. Offline, what
 * needs the server is left out, and hearts wait for it. The result only describes the
 * actions; `useTrackActionRunner` carries one out when it is chosen.
 */
export function trackActions(track: TrackSummary, state: TrackActionState, { playlist, album, artist }: TrackActionOptions = {}): TrackAction[] {
  const { liked, likeFailure, playable, offline, current, download, onItsOwn, wantlist, wanted, wantFailure, viewer, sharing = false, ratings = false } = state;
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
    // Stars grade a song beside the heart; they never put it in the library.
    ratings && online && ratingAction(track),
    downloadAction,
    playable && online && { id: 'playlist', title: 'Add to playlist', icon: 'text.badge.plus', sheet: true,
      href: { pathname: '/add-to-playlist', params: { trackId: track.id, albumId: track.album?.id ?? '' } } },
    // The server seeds the radio by the queue's rule, so a song that plays only from the
    // device (gone from the server, or `on_demand` for someone who may not fetch) has none.
    online && isPlayable(track, viewer) && { id: 'radio', title: 'Start radio', icon: 'dot.radiowaves.left.and.right' },
    // Leans on how the song sounds (the server's sonic analysis) more than on who made it.
    online && isPlayable(track, viewer) && { id: 'sonicRadio', title: 'Songs that sound like this', icon: 'waveform' },
    sharing && online && { id: 'share', title: 'Share', icon: 'square.and.arrow.up' },
    // Only what does not play for this user: for someone who may fetch music nothing is wanted.
    // Added or removed alike, as on web.
    wantlist && !playable && track.availability !== 'server' && online && (wanted
      ? { id: 'unwant', ...wantFailure === undefined ? { title: 'Remove from wantlist', icon: 'star.slash' } : failed('Couldn’t remove from wantlist') }
      : { id: 'want', ...wantFailure === undefined ? { title: 'Add to wantlist', icon: 'star' } : failed('Couldn’t add to wantlist') }),
    ...trackLinks(track, album, artist),
    // Who wrote, produced and played on it, each opening their page.
    Boolean(track.credits?.length) && { id: 'credits', title: 'Credits', icon: 'person.2', sheet: true,
      href: { pathname: '/track-credits', params: { id: track.id, albumId: track.album?.id ?? '' } } },
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
