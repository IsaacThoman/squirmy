import { queryKeys } from '@squirmy/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useCallback, useRef } from 'react';
import { Alert } from 'react-native';
import { useSignedInApi } from '../account/AccountProvider';
import { useTrackStore } from '../data/library';
import { useRealtime } from '../data/realtime';
import { useViewer } from '../downloads/DownloadsProvider';
import { usePlaybackActions } from '../playback';
import type { RowAction } from './BrowseControls';
import { loadFailure } from '../data/errors';
import { collectionActions, pinTarget, type CollectionRunners } from './collectionMenu';
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

/**
 * Pins a collection to the top of the Library, on every device, or unpins it. The Library is
 * read again once the server has it, which moves the item; a refusal is said in an alert.
 */
export function usePinCollection() {
  const api = useSignedInApi();
  const queryClient = useQueryClient();
  return (item: Collection, pinned: boolean) => {
    const target = pinTarget(item);
    if (!api || !target) return;
    const [kind, id] = target;
    void (pinned ? api.userdata.pin(kind, id) : api.userdata.unpin(kind, id))
      .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.libraryItems() }))
      .catch((error: unknown) => {
        const { connection, description } = loadFailure(error);
        Alert.alert(pinned ? `Couldn’t pin “${item.title}”` : `Couldn’t unpin “${item.title}”`, connection ? 'Check your connection to the server.' : description);
      });
  };
}

/** `collectionActions` for the signed-in viewer. The function changes only when what the menus offer does. */
export function useCollectionActions(): (item: Collection) => RowAction[] {
  const router = useRouter();
  const { offline } = useRealtime();
  const viewer = useViewer();
  const albumPlayer = useAlbumPlayer();
  const pin = usePinCollection();
  const latest = useRef<CollectionRunners>(null!);
  latest.current = {
    playAlbum: (albumId, shuffle) => albumPlayer.play(albumId, shuffle),
    open: href => router.push(href),
    pin,
  };
  return useCallback((item: Collection) => collectionActions(item, { offline, viewer }, {
    playAlbum: (albumId, shuffle) => latest.current.playAlbum(albumId, shuffle),
    open: href => latest.current.open(href),
    pin: (collection, pinned) => latest.current.pin(collection, pinned),
  }), [offline, viewer]);
}
