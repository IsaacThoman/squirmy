import { queryKeys, type AlbumDetail, type VersionPickType } from '@squirmy/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { useSignedInApi } from '../account/AccountProvider';
import { useRealtime } from '../data/realtime';
import { usePlaybackActions } from '../playback';
import { useStreamingCache } from '../streamingCache/context';

/**
 * Makes a version the one that plays by default for an album or a song, for this user on
 * every device, or goes back to Automatic with null. Resolves once the server has the pick
 * and the album page (or the song's versions) has been read again; rejects when the server
 * refused it. This phone then loads the album's songs, or the song, from the server again
 * the next time they start; what plays now goes on.
 */
export function useVersionPick() {
  const api = useSignedInApi();
  const queryClient = useQueryClient();
  const { expectEcho } = useRealtime();
  const { forgetPlayback } = usePlaybackActions();
  const cache = useStreamingCache();
  return useCallback(async (type: VersionPickType, id: string, versionId: string | null) => {
    if (!api) throw new Error('Not signed in');
    const key = type === 'album' ? queryKeys.album(id) : queryKeys.track(id);
    // The songs whose file may change: the album's as the page lists them before the pick.
    const songs = type === 'album'
      ? queryClient.getQueryData<AlbumDetail>(key)?.discs.flatMap(disc => disc.tracks.map(track => track.id)) ?? []
      : [id];
    // The server invalidates the same key for every device of the user; here it is read again below.
    expectEcho(key);
    await (versionId === null ? api.catalog.clearVersion(type, id) : api.catalog.pickVersion(type, id, versionId));
    // A copy kept from streaming plays before the server is asked, and a song may already be
    // resolved, the next one preloading, from the old file.
    cache?.forget(songs);
    forgetPlayback(type === 'album' ? undefined : id);
    await queryClient.invalidateQueries({ queryKey: key });
  }, [api, cache, expectEcho, forgetPlayback, queryClient]);
}
