import { planChanges } from '@squirmy/client-core';
import type { TrackSummary } from '@squirmy/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigationContainerRef, useRouter } from 'expo-router';
import { useCallback, useMemo, useRef } from 'react';
import { useServerUrl, useSharingEnabled, useSignedInApi, useWantlistEnabled } from '../account/AccountProvider';
import { closeSheet } from '../closeSheet';
import { useLibraryActions, useLiked, useLikeFailure, usePlaylistActions, useWanted, useWantFailure } from '../data/library';
import { useRatingsEnabled } from '../data/queries';
import { applyChanges } from '../data/changes';
import { useRealtime } from '../data/realtime';
import { useCanPlay, useDownloadManager, useTrackDownload, useViewer } from '../downloads/DownloadsProvider';
import { songsId, type TrackDownload } from '../downloads/model';
import { useCurrentTrackState, usePlaybackActions } from '../playback';
import { usePlayerTransition } from '../player/transition';
import { playbackStatus } from '../player/usePlaybackStatus';
import { pageHref } from './links';
import { tabIn } from './tabs';
import { createStartGuard } from './pending';
import { confirmQueued } from './queued';
import { shareLink } from './shareLink';
import { queuedNotice, radioStartingNotice, trackActions, type TrackAction, type TrackActionOptions } from './trackActionList';

export { trackActionKey, trackActions, type TrackAction, type TrackActionId, type TrackActionOptions, type TrackActionState } from './trackActionList';

/** Radios started from a song's menu, which closes before the radio arrives. */
const radioStarts = createStartGuard();

/**
 * Rates a song 1 to 5 stars, or takes its rating away with 0. It shows at once in every cached
 * answer that has the song (the patch the server then sends this user's other devices); a
 * refusal puts the old rating back and the player's status line says so, as the menu has closed.
 */
export function useSetRating() {
  const api = useSignedInApi();
  const queryClient = useQueryClient();
  return useCallback((track: TrackSummary, stars: number) => {
    if (!api) return;
    const patch = (rating: number | null) =>
      applyChanges(queryClient, planChanges([{ kind: 'patch', entity: 'track', id: track.id, fields: { rating } }]), { own: true });
    patch(stars || null);
    api.userdata.rate('track', track.id, stars).catch(() => {
      patch(track.rating ?? null);
      playbackStatus.report({ message: `Couldn’t rate “${track.title}”` });
    });
  }, [api, queryClient]);
}

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
  const actions = usePlaybackActions();
  const { setLiked, setWanted } = useLibraryActions();
  const manager = useDownloadManager();
  const serverUrl = useServerUrl();
  const setRating = useSetRating();
  const live = useRef({ api, actions, setLiked, setWanted, manager, close, serverUrl, setRating });
  live.current = { api, actions, setLiked, setWanted, manager, close, serverUrl, setRating };

  const perform = useCallback((track: TrackSummary, action: TrackAction, { playlist }: TrackActionOptions = {}) => {
    const { api, actions, setLiked, setWanted, manager, serverUrl, setRating } = live.current;
    switch (action.id) {
      case 'play': return actions.playNow(track);
      case 'resume': return actions.play();
      case 'next':
      case 'last':
        actions.enqueue([track], action.id);
        // The queue isn't on screen: the player's status line, a tap and VoiceOver say it worked.
        playbackStatus.report(queuedNotice(track.title, action.id));
        return confirmQueued(action.id);
      case 'like': return setLiked('track', track.id, true, track.title);
      case 'unlike': return setLiked('track', track.id, false, track.title);
      case 'download': return void manager?.addTrack(track);
      case 'retryDownload': return void manager?.retry();
      case 'removeDownload': return void manager?.removeTrack(track.id);
      case 'radio':
      case 'sonicRadio': {
        // The menu has closed by the time the server answers, so the player says it is on its
        // way until it plays, and a failure shows there too.
        if (!api) return undefined;
        const start = action.id === 'radio' ? api.radio.track : api.radio.sonic;
        let starting: number | null = null;
        if (radioStarts.run('radio', () => start(track.id).then(radio => {
          if (starting !== null) playbackStatus.withdraw(starting);
          actions.playRadio(radio);
        }, () => playbackStatus.report({ message: `Couldn’t start a radio from “${track.title}”` })))) {
          starting = playbackStatus.report(radioStartingNotice);
        }
        return undefined;
      }
      case 'rate': return setRating(track, action.rating ?? 0);
      case 'share': return api ? shareLink(api, serverUrl, { kind: 'track', id: track.id, albumId: track.album?.id ?? null, title: track.title }) : undefined;
      case 'want': return setWanted('track', track.id, true, track.title);
      case 'unwant': return setWanted('track', track.id, false, track.title);
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
  const viewer = useViewer();
  const download = useTrackDownload(track?.id);
  const onItsOwn = useDownloadedOnItsOwn(track?.id, download);
  const current = useCurrentTrackState(track?.id);
  const wantlist = useWantlistEnabled();
  const sharing = useSharingEnabled();
  const ratings = useRatingsEnabled();
  const wanted = useWanted(track?.id);
  const likeFailure = useLikeFailure('track', track?.id);
  const wantFailure = useWantFailure(track?.id);
  const playlists = usePlaylistActions();
  const { perform } = useTrackActionRunner();
  if (!track) return [];
  const playlist = options.playlist && {
    ...options.playlist,
    onRemove: options.playlist.onRemove ?? ((itemId: string) => playlists.removeItem(options.playlist!.id, itemId)),
  };
  return trackActions(track, { liked, likeFailure, playable, offline, current, download, onItsOwn, wantlist, wanted, wantFailure, viewer, sharing, ratings }, { playlist })
    .map(function bind(action): TrackAction {
      return { ...action, run: () => perform(track, action, { playlist }), children: action.children?.map(bind) };
    });
}

/** Carries out an action from `useTrackActions`: its command, then the page or sheet it leads to. */
export function useRunTrackAction(inSheet: boolean) {
  const { open } = useTrackActionRunner(inSheet);
  return (action: TrackAction) => {
    action.run?.();
    open(action);
  };
}
