import { albumPresentation, searchKey, type SearchItem } from '@squirmy/client-core';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { useAvailability, useDownloadManager, useKeptCollections } from '../downloads/DownloadsProvider';
import { localLibrary, type KeptDownloads } from './localLibrary';
import { localSearch } from './localSearch';

/**
 * What the phone holds that matches `text`, best first (`localSearch` over `localLibrary`):
 * Search's results while the server can't be reached. Null while `enabled` is false or
 * nothing is typed. Read again for each query and when downloads change; the cache it reads
 * does not change while offline.
 */
export function useLocalSearch(text: string, scope: 'all' | 'library', enabled: boolean): SearchItem[] | null {
  const queryClient = useQueryClient();
  const manager = useDownloadManager();
  const { canPlay, offline, viewer } = useAvailability();
  const kept = useKeptCollections();
  const term = searchKey(text);
  return useMemo(() => {
    if (!enabled || !term) return null;
    const collections = manager?.summary().collections ?? [];
    const downloads: KeptDownloads = {
      tracks: manager?.tracks() ?? [],
      albums: collections.flatMap(row => row.album ?? []),
      playlists: collections.flatMap(row => row.playlist ?? []),
    };
    const queries = queryClient.getQueryCache().getAll().map(query => ({ queryKey: query.queryKey, data: query.state.data }));
    // Offline only what is on the phone plays: an album or artist with something downloaded, as the Library dims the rest.
    const plays = (item: SearchItem) => {
      switch (item.type) {
        case 'track': return canPlay(item.track);
        case 'album': return offline ? kept.albums.has(item.album.id) : albumPresentation(item.album, viewer) === 'normal';
        case 'artist': return !offline || kept.artists.has(item.artist.id);
        case 'playlist': return !offline || kept.playlists.has(item.playlist.id);
      }
    };
    return localSearch(text, localLibrary(queries, downloads, scope), { plays });
  }, [canPlay, enabled, kept, manager, offline, queryClient, scope, term, text, viewer]);
}
