import type { TrackSummary } from '@squirmy/contracts';
import { useRouter, type Href } from 'expo-router';
import { useSignedInApi } from '../account/AccountProvider';
import { closeSheet } from '../closeSheet';
import { useLibraryActions, useLiked, usePlaylistActions } from '../data/library';
import { useRealtime } from '../data/realtime';
import { useCanPlay, useDownloadActions, useDownloadManager, useTrackDownload } from '../downloads/DownloadsProvider';
import { songsId } from '../downloads/model';
import { useNotice } from '../Notice';
import { usePlaybackState } from '../playback';
import { usePlayerTransition } from '../player/transition';
import { usePageLinks } from './links';

/** One thing to do with a track: a command, a page to open, or a sheet to open. */
export type TrackAction = {
  id: string;
  title: string;
  icon: string;
  destructive?: boolean;
  run?: () => void;
  href?: Href;
  sheet?: boolean;
};

export type TrackActionOptions = {
  /** The playlist the track is shown in, for "Remove from playlist". */
  playlist?: { id: string; itemId: string };
};

/**
 * What can be done with `track`, in menu order. Gray tracks can only be liked, wanted and
 * opened. Offline, what needs the server is left out, and likes wait for it.
 */
export function useTrackActions(track: TrackSummary | undefined, { playlist }: TrackActionOptions = {}): TrackAction[] {
  const api = useSignedInApi();
  const notify = useNotice();
  const link = usePageLinks();
  const { session, actions } = usePlaybackState();
  const liked = useLiked('track', track?.id, track?.liked);
  const { setLiked, want } = useLibraryActions();
  const playlists = usePlaylistActions();
  const { offline } = useRealtime();
  const playable = useCanPlay(track);
  const download = useTrackDownload(track?.id);
  const downloads = useDownloadActions();
  const manager = useDownloadManager();
  if (!track) return [];
  const online = !offline;
  const isCurrent = session.current?.trackId === track.id;
  const onItsOwn = manager?.collectionRow(songsId)?.trackIds.includes(track.id) ?? false;
  const downloadAction: TrackAction | false = download?.state === 'failed' && onItsOwn
    ? { id: 'download', title: 'Retry download', icon: 'arrow.clockwise', run: downloads.retry }
    : download && onItsOwn
      ? { id: 'download', title: download.state === 'done' ? 'Remove download' : 'Cancel download',
        icon: download.state === 'done' ? 'trash' : 'xmark.circle', destructive: download.state === 'done', run: () => downloads.removeTrack(track.id) }
      : !download && online && track.availability === 'server' && { id: 'download', title: 'Download', icon: 'arrow.down.circle', run: () => downloads.track(track) };
  const items: (TrackAction | false)[] = [
    playable && { id: 'play', title: 'Play now', icon: 'play.fill', run: () => {
      if (isCurrent) actions.play();
      else actions.playNow(track);
    } },
    playable && { id: 'next', title: 'Play next', icon: 'text.line.first.and.arrowtriangle.forward', run: () => actions.enqueue([track], 'next') },
    playable && { id: 'last', title: 'Play last', icon: 'text.badge.plus', run: () => actions.enqueue([track], 'last') },
    { id: 'like', title: liked ? 'Remove from Liked Songs' : 'Add to Liked Songs', icon: liked ? 'heart.slash' : 'heart',
      run: () => setLiked('track', track.id, !liked) },
    downloadAction,
    playable && online && { id: 'playlist', title: 'Add to playlist', icon: 'text.badge.plus', sheet: true,
      href: { pathname: '/add-to-playlist', params: { trackId: track.id, albumId: track.album?.id ?? '' } } },
    playable && online && { id: 'radio', title: 'Start radio', icon: 'dot.radiowaves.left.and.right', run: () => {
      api?.radio.track(track.id).then(actions.playRadio, () => notify('Couldn’t start a radio from this song.'));
    } },
    // Gray tracks, including on-demand ones this user may not have fetched.
    !playable && track.availability !== 'server' && online && { id: 'want', title: 'Add to wantlist', icon: 'star', run: () => want('track', track.id, track.title) },
    Boolean(track.album) && { id: 'album', title: 'Go to album', icon: 'square.stack', href: link('album', track.album!.id) },
    Boolean(track.artists[0]) && { id: 'artist', title: 'Go to artist', icon: 'music.mic', href: link('artist', track.artists[0]!.id) },
    playlist !== undefined && online && { id: 'remove', title: 'Remove from playlist', icon: 'minus.circle', destructive: true,
      run: () => playlists.removeItem(playlist.id, playlist.itemId) },
  ];
  return items.filter((item): item is TrackAction => Boolean(item));
}

/**
 * Carries out an action. Opening a page closes Now Playing first; from inside a sheet the
 * sheet closes too, and another sheet takes its place.
 */
export function useRunTrackAction(inSheet: boolean) {
  const router = useRouter();
  const { close } = usePlayerTransition();
  return (action: TrackAction) => {
    if (action.run) action.run();
    if (!action.href) {
      if (inSheet) closeSheet(router);
      return;
    }
    if (action.sheet) {
      if (inSheet) router.replace(action.href);
      else router.push(action.href);
      return;
    }
    if (inSheet) closeSheet(router);
    close();
    router.navigate(action.href);
  };
}
