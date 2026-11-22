import type { TrackSummary } from '@squirmy/contracts';
import { useNavigationContainerRef, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef } from 'react';
import { useSignedInApi, useWantlistEnabled } from '../account/AccountProvider';
import { closeSheet } from '../closeSheet';
import { useLibraryActions, useLiked, usePlaylistActions, useSaved } from '../data/library';
import { useRealtime } from '../data/realtime';
import { useCanPlay, useDownloadManager, useTrackDownload } from '../downloads/DownloadsProvider';
import { songsId, type TrackDownload } from '../downloads/model';
import { useNotice } from '../Notice';
import { useCurrentTrackState, usePlaybackActions } from '../playback';
import { usePlayerTransition } from '../player/transition';
import { pageHref } from './links';
import { tabIn } from './tabs';
import { createStartGuard } from './pending';
import { trackActions, type TrackAction, type TrackActionOptions } from './trackActionList';

export { trackActions, type TrackAction, type TrackActionId, type TrackActionOptions, type TrackActionState } from './trackActionList';

/** Radios started from a song's menu, which closes before the radio arrives. */
const radioStarts = createStartGuard();

/** Whether the track was downloaded on its own, as opposed to with an album or playlist. */
export function useDownloadedOnItsOwn(trackId: string | undefined, download: TrackDownload | undefined) {
  const manager = useDownloadManager();
  return Boolean(download && trackId && manager?.collectionRow(songsId)?.trackIds.includes(trackId));
}

/**
 * Carries out a track's action. Reads only contexts, so a row can hold one without
 * re-rendering as playback, playlists or navigation change; what an action needs is
 * looked up when it runs. Opening a page closes Now Playing first; from inside a sheet
 * the sheet closes too, and another sheet takes its place.
 */
export function useTrackActionRunner(inSheet = false) {
  const router = useRouter();
  const navigation = useNavigationContainerRef();
  const { close } = usePlayerTransition();
  const api = useSignedInApi();
  const notify = useNotice();
  const actions = usePlaybackActions();
  const { setLiked, want, setSaved } = useLibraryActions();
  const manager = useDownloadManager();
  const live = useRef({ api, notify, actions, setLiked, want, setSaved, manager, close });
  live.current = { api, notify, actions, setLiked, want, setSaved, manager, close };

  const perform = useCallback((track: TrackSummary, action: TrackAction, { playlist }: TrackActionOptions = {}) => {
    const { api, notify, actions, setLiked, want, setSaved, manager } = live.current;
    switch (action.id) {
      case 'play': return actions.playNow(track);
      case 'resume': return actions.play();
      case 'next': return actions.enqueue([track], 'next');
      case 'last': return actions.enqueue([track], 'last');
      case 'like': return setLiked('track', track.id, true);
      case 'unlike': return setLiked('track', track.id, false);
      case 'save': return setSaved('track', track.id, true, track.title);
      case 'unsave': return setSaved('track', track.id, false, track.title);
      case 'download': return void manager?.addTrack(track);
      case 'retryDownload': return void manager?.retry();
      case 'removeDownload': return void manager?.removeTrack(track.id);
      case 'radio':
        // The menu closes at once, so the notice is what shows the radio is on its way.
        if (api) radioStarts.run('radio', () => {
          notify('Starting radio…');
          return api.radio.track(track.id).then(actions.playRadio, () => notify('Couldn’t start a radio from this song.'));
        });
        return undefined;
      case 'want': return want('track', track.id, track.title);
      case 'remove': return playlist?.onRemove?.(playlist.itemId);
      default: return undefined;
    }
  }, []);

  const open = useCallback((action: TrackAction) => {
    const href = action.href ?? (action.page && pageHref(tabIn(navigation.getRootState()), action.page.page, action.page.id));
    if (!href) {
      if (inSheet) closeSheet(router);
      return;
    }
    if (action.sheet) {
      if (inSheet) router.replace(href);
      else router.push(href);
      return;
    }
    if (inSheet) closeSheet(router);
    live.current.close();
    router.navigate(href);
  }, [inSheet, navigation, router]);

  return useMemo(() => ({
    /** The action's command, such as queueing or liking the track. */
    perform,
    /** The page or sheet the action leads to, if any. */
    open,
    run: (track: TrackSummary, action: TrackAction, options?: TrackActionOptions) => {
      perform(track, action, options);
      open(action);
    },
  }), [open, perform]);
}

/**
 * What can be done with `track`, each action with its command bound as `run`. For a
 * single menu or sheet; rows build theirs with `trackActions` from what they already read.
 */
export function useTrackActions(track: TrackSummary | undefined, options: TrackActionOptions = {}): TrackAction[] {
  const liked = useLiked('track', track?.id, track?.liked);
  const { offline } = useRealtime();
  const playable = useCanPlay(track);
  const download = useTrackDownload(track?.id);
  const onItsOwn = useDownloadedOnItsOwn(track?.id, download);
  const current = useCurrentTrackState(track?.id);
  const wantlist = useWantlistEnabled();
  const saved = useSaved('track', track?.id, track?.inLibrary);
  const playlists = usePlaylistActions();
  const { perform } = useTrackActionRunner();
  if (!track) return [];
  const playlist = options.playlist && {
    ...options.playlist,
    onRemove: options.playlist.onRemove ?? ((itemId: string) => playlists.removeItem(options.playlist!.id, itemId)),
  };
  return trackActions(track, { liked, playable, offline, current, download, onItsOwn, wantlist, saved }, { playlist })
    .map(action => ({ ...action, run: () => perform(track, action, { playlist }) }));
}

/** Carries out an action from `useTrackActions`: its command, then the page or sheet it leads to. */
export function useRunTrackAction(inSheet: boolean) {
  const { open } = useTrackActionRunner(inSheet);
  return (action: TrackAction) => {
    action.run?.();
    open(action);
  };
}
