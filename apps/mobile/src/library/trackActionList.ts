import type { TrackSummary } from '@squirmy/contracts';
import type { Href } from 'expo-router';
import type { TrackDownload } from '../downloads/model';
import type { Page } from './links';

/** One thing to do with a track: a command, a page to open, or a sheet to open. */
export type TrackAction = {
  id: TrackActionId;
  title: string;
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
  | 'playlist' | 'radio' | 'want' | 'album' | 'artist' | 'remove';

export type TrackActionOptions = {
  /** The playlist the track is shown in, for "Remove from playlist". */
  playlist?: { id: string; itemId: string; onRemove?: (itemId: string) => void };
};

/** What a track's menu depends on, read by the row that shows it. */
export type TrackActionState = {
  liked: boolean;
  playable: boolean;
  offline: boolean;
  isCurrent: boolean;
  download: TrackDownload | undefined;
  /** Downloaded on its own, not only as part of an album or playlist, so it can be removed here. */
  onItsOwn: boolean;
  /** The server has the wantlist on. */
  wantlist: boolean;
};

/**
 * What can be done with `track`, in menu order. Gray tracks can only be liked, wanted (when
 * the server has the wantlist on) and opened. Offline, what needs the server is left out,
 * and likes wait for it. The result
 * only describes the actions; `useTrackActionRunner` carries one out when it is chosen.
 */
export function trackActions(track: TrackSummary, state: TrackActionState, { playlist }: TrackActionOptions = {}): TrackAction[] {
  const { liked, playable, offline, isCurrent, download, onItsOwn, wantlist } = state;
  const online = !offline;
  const downloadAction: TrackAction | false = download?.state === 'failed' && onItsOwn
    ? { id: 'retryDownload', title: 'Retry download', icon: 'arrow.clockwise' }
    : download && onItsOwn
      ? { id: 'removeDownload', title: download.state === 'done' ? 'Remove download' : 'Cancel download',
        icon: download.state === 'done' ? 'trash' : 'xmark.circle', destructive: download.state === 'done' }
      : !download && online && track.availability === 'server' && { id: 'download', title: 'Download', icon: 'arrow.down.circle' };
  const items: (TrackAction | false)[] = [
    playable && { id: isCurrent ? 'resume' : 'play', title: 'Play now', icon: 'play.fill' },
    playable && { id: 'next', title: 'Play next', icon: 'text.line.first.and.arrowtriangle.forward' },
    playable && { id: 'last', title: 'Play last', icon: 'text.badge.plus' },
    liked
      ? { id: 'unlike', title: 'Unlike', icon: 'heart.slash' }
      : { id: 'like', title: 'Like', icon: 'heart' },
    downloadAction,
    playable && online && { id: 'playlist', title: 'Add to playlist', icon: 'text.badge.plus', sheet: true,
      href: { pathname: '/add-to-playlist', params: { trackId: track.id, albumId: track.album?.id ?? '' } } },
    playable && online && { id: 'radio', title: 'Start radio', icon: 'dot.radiowaves.left.and.right' },
    // Gray tracks, including on-demand ones this user may not have fetched.
    wantlist && !playable && track.availability !== 'server' && online && { id: 'want', title: 'Add to wantlist', icon: 'star' },
    Boolean(track.album) && { id: 'album', title: 'Go to album', icon: 'square.stack', page: { page: 'album', id: track.album!.id } },
    Boolean(track.artists[0]) && { id: 'artist', title: 'Go to artist', icon: 'music.mic', page: { page: 'artist', id: track.artists[0]!.id } },
    playlist !== undefined && online && { id: 'remove', title: 'Remove from playlist', icon: 'minus.circle', destructive: true },
  ];
  return items.filter((item): item is TrackAction => Boolean(item));
}
