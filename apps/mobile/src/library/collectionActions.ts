import { queryKeys } from '@squirmy/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';
import { useSignedInApi } from '../account/AccountProvider';
import { useTrackStore } from '../data/library';
import { useRealtime } from '../data/realtime';
import { useViewer } from '../downloads/DownloadsProvider';
import { usePlaybackActions } from '../playback';
import type { RowAction } from './BrowseControls';
import { collectionActions, type CollectionRunners } from './collectionMenu';
import { useStartGuard } from './pending';
import type { Collection } from './shared';

/**
 * Plays an album from its tile: its tracks come from the cached page when there is one,
 * otherwise from the server. `pending` is true while that request is out; taps meanwhile are ignored.
 */
export function useAlbumPlayer() {
  const api = useSignedInApi();
  const queryClient = useQueryClient();
  const tracks = useTrackStore();
  const actions = usePlaybackActions();
  const starts = useStartGuard();
  const play = (albumId: string, shuffle = false) => {
    if (!api) return;
    starts.run(albumId, () => queryClient.ensureQueryData({ queryKey: queryKeys.album(albumId), queryFn: () => api.catalog.album(albumId) }).then(album => {
      const list = album.discs.flatMap(disc => disc.tracks);
      tracks.prime(list);
      actions.playTracks(list, { shuffle, context: { type: 'album', id: album.id, title: album.title } });
    }));
  };
  return { play, pending: starts.pending };
}

/** `collectionActions` for the signed-in viewer. The function changes only when what the menus offer does. */
export function useCollectionActions(): (item: Collection) => RowAction[] {
  const router = useRouter();
  const { offline } = useRealtime();
  const viewer = useViewer();
  const albumPlayer = useAlbumPlayer();
  const latest = useRef<CollectionRunners>(null!);
  latest.current = {
    playAlbum: (albumId, shuffle) => albumPlayer.play(albumId, shuffle),
    open: href => router.push(href),
  };
  return useCallback((item: Collection) => collectionActions(item, { offline, viewer }, {
    playAlbum: (albumId, shuffle) => latest.current.playAlbum(albumId, shuffle),
    open: href => latest.current.open(href),
  }), [offline, viewer]);
}
