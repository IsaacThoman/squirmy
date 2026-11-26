import { artworkUrl, plural } from '@squirmy/client-core';
import { queryKeys, type LibraryItem, type PlaylistDetail, type QueueEntry, type TrackSummary } from '@squirmy/contracts';
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { useAccount, useAccountKey, useServerUrl, useSignedInApi, useWantlistEnabled } from '../account/AccountProvider';
import { awaitsTrackList } from '../data/albums';
import { releaseGroups } from '../data/artists';
import { isNotFound, loadFailure } from '../data/errors';
import { useTrackStore } from '../data/library';
import { useAlbum, useArtist, useHome, useLibraryItems, useLikedTracks, usePlaylist } from '../data/queries';
import { useAvailability, useDownloadManager } from '../downloads/DownloadsProvider';
import { albumCollectionId, likedId, playlistCollectionId, type CollectionRow } from '../downloads/model';
import { loadRest, uniqueTracks } from '../library/loadAll';
import { useStreamingCache } from '../streamingCache/context';
import {
  artistPage, downloadsPage, homePage, homeTab, libraryPage, libraryTab, messagePage, offlineMessage,
  pageOffset, pageSize, queuePage, routeHeader, signInMessage, songsPage, type BrowsePage, type BrowsePresentation, type BrowseRoute,
  type CarPlayLimits, type DownloadCollection,
} from './templates';

const defaultImagePixels = 96;
const defaultCoverPixels = 300;
const noSubscription = () => () => undefined;
const canOpen = () => true;
const emptyTracks: readonly TrackSummary[] = [];
const emptyDownloads = { count: 0, collections: [] as readonly CollectionRow[] };

function usePresentation(limits: CarPlayLimits, currentTrackId?: string) {
  const availability = useAvailability();
  const serverUrl = useServerUrl();
  const manager = useDownloadManager();
  const cache = useStreamingCache();
  const { offline, viewer, canPlay } = availability;
  const { listImagePixels, imageRowImagePixels, headerImagePixels } = limits;
  const ui = useMemo<BrowsePresentation>(() => ({
    limits, offline, viewer, canPlay, currentTrackId, canOpen,
    artwork: (art, placement) => {
      if (!art) return undefined;
      const kept = manager?.artworkUri(art.id) ?? cache?.artworkUri(art.id);
      if (kept || offline) return kept ?? undefined;
      const pixels = placement === 'header' ? headerImagePixels ?? defaultCoverPixels
        : placement === 'rail' ? imageRowImagePixels ?? defaultCoverPixels
          : listImagePixels ?? defaultImagePixels;
      return artworkUrl(serverUrl, art, pixels) ?? undefined;
    },
  }), [cache, canPlay, currentTrackId, headerImagePixels, imageRowImagePixels, limits, listImagePixels, manager, offline, serverUrl, viewer]);
  return { availability, ui, manager, cache };
}

function queryMessage(header: Pick<BrowsePage['list'], 'id' | 'title' | 'tabIcon'>, offline: boolean, error: unknown, refresh: () => Promise<unknown>): BrowsePage {
  if (offline) return messagePage(header, 'Offline', offlineMessage);
  if (error) {
    const failure = loadFailure(error);
    return messagePage(header, 'Couldn’t load music', failure.description, failure.retry ? async () => { await refresh(); } : undefined);
  }
  const page = messagePage(header, 'Loading…');
  page.list.loading = true;
  return page;
}

function libraryItem(row: CollectionRow): LibraryItem[] {
  if (row.kind === 'album' && row.album) return [{ kind: 'album', album: row.album, playedAt: null }];
  if (row.kind === 'playlist' && row.playlist) return [{ kind: 'playlist', playlist: row.playlist, playedAt: null }];
  if (row.kind === 'liked') return [{ kind: 'liked', playedAt: null }];
  return [];
}

function downloadedCollection(row: CollectionRow, count: number): DownloadCollection[] {
  let route: BrowseRoute;
  if (row.kind === 'album' && row.album) route = { type: 'album', id: row.album.id, title: row.title, downloaded: true };
  else if (row.kind === 'playlist' && row.playlist) route = { type: 'playlist', id: row.playlist.id, title: row.title, downloaded: true };
  else if (row.kind === 'liked') route = { type: 'liked', title: row.title, downloaded: true };
  else return [];
  const detail = row.kind === 'album' && row.subtitle ? `${row.subtitle} · ${plural(count, 'song')}` : plural(count, 'song');
  return [{ route, detail, artwork: row.artworks[0] }];
}

/** The same query keys and availability rules as phone browsing, with downloaded metadata
 * available even when the phone hasn't loaded the matching browse page before. */
export function useCarPlayBrowse({
  enabled, limits, route, currentTrackId,
}: { enabled: boolean; limits: CarPlayLimits; route: BrowseRoute | null; currentTrackId?: string }) {
  const { state } = useAccount();
  const account = useAccountKey();
  const api = useSignedInApi();
  const client = useQueryClient();
  const tracks = useTrackStore();
  const wantlist = useWantlistEnabled();
  const { ui: base, manager, cache, availability } = usePresentation(limits, currentTrackId);
  const { offline } = base;
  const observing = enabled && state.status === 'signedIn';
  const online = observing && !offline;
  const downloaded = route && 'downloaded' in route && route.downloaded === true;

  const home = useHome(online);
  const library = useLibraryItems('played', online);
  const albums = useAlbum(route?.type === 'album' ? route.id : '', { enabled: online && route?.type === 'album' && !downloaded, background: true });
  const artist = useArtist(route?.type === 'artist' ? route.id : '', { enabled: online && route?.type === 'artist', background: true });
  const playlist = usePlaylist(route?.type === 'playlist' ? route.id : '', online && route?.type === 'playlist' && !downloaded);
  const likes = useLikedTracks(online && route?.type === 'liked' && !downloaded);

  const downloadSnapshot = useMemo(() => {
    let last = emptyDownloads;
    return () => {
      if (!observing || !manager) return emptyDownloads;
      const { count, collections } = manager.summary();
      if (count !== last.count || collections.length !== last.collections.length || collections.some((row, i) => row !== last.collections[i])) {
        last = { count, collections };
      }
      return last;
    };
  }, [manager, observing]);
  // Collection membership or artwork can change without a new file. Ignore progress updates.
  const downloads = useSyncExternalStore(observing && manager ? manager.subscribe : noSubscription, downloadSnapshot);
  const local = useMemo(() => {
    const downloadedTracks = observing && manager ? manager.tracks().filter(track => availability.downloaded(track.id)) : [];
    const keptTracks = offline && observing ? uniqueTracks([...downloadedTracks, ...(cache?.tracks() ?? [])]) : emptyTracks;
    const collections = downloads.collections.flatMap(row => {
      const count = row.trackIds.filter(availability.downloaded).length;
      return count ? [{ row, count }] : [];
    });
    return { keptTracks, downloadedTracks, collections };
  }, [availability, cache, downloads, manager, observing, offline]);

  const ui: BrowsePresentation = {
    ...base,
    canOpen: destination => {
      if (!offline || ('downloaded' in destination && destination.downloaded)) return true;
      switch (destination.type) {
        case 'album': return local.keptTracks.some(track => track.album?.id === destination.id);
        case 'artist': return local.keptTracks.some(track => track.artists.some(artist => artist.id === destination.id));
        case 'playlist': {
          const items = client.getQueryData<PlaylistDetail>(queryKeys.playlist(destination.id))?.items ?? [];
          return items.some(item => base.canPlay(item.track)) || local.collections.some(({ row }) => row.playlist?.id === destination.id);
        }
        case 'liked':
        case 'downloaded-songs': return true;
      }
    },
  };

  const detailId = route ? routeHeader(route).id : null;
  const [libraryPaging, setLibraryPaging] = useState({ account, offset: 0 });
  const [downloadPaging, setDownloadPaging] = useState({ account, offset: 0 });
  const [detailPaging, setDetailPaging] = useState({ account, id: detailId, offset: 0 });
  const detailOffset = detailPaging.account === account && detailPaging.id === detailId ? detailPaging.offset : 0;
  const onPage = (offset: number) => setDetailPaging({ account, id: detailId, offset });
  const signedOut = enabled && (state.status === 'signIn' || state.status === 'connect');
  if (!observing) {
    const root = messagePage(homeTab, signedOut ? 'Sign In' : 'Loading…', signedOut ? signInMessage : undefined);
    if (!signedOut) root.list.loading = true;
    return { tabs: enabled ? [root] : [], page: null, signedOut };
  }

  const localLibrary = local.collections.flatMap(({ row }) => libraryItem(row));
  const libraryItems = library.data ? library.items : localLibrary;
  const libraryOffset = libraryPaging.account === account ? libraryPaging.offset : 0;
  const tabs = [
    home.data
      ? homePage({ sections: home.data.sections.filter(section => wantlist || section.id !== 'wantlist') }, ui)
      : queryMessage(homeTab, offline, home.error, home.refetch),
    libraryItems.length || library.data
      ? libraryPage(libraryItems, ui, {
        offset: libraryOffset, hasMore: !offline && library.hasNextPage,
        onPage: async offset => {
          if (offset >= libraryItems.length && !offline && library.hasNextPage) await library.fetchNextPage({ throwOnError: true });
          setLibraryPaging({ account, offset });
        },
      })
      : queryMessage(libraryTab, offline, library.error, library.refetch),
  ];
  if (local.downloadedTracks.length) {
    const collections = local.collections.flatMap(({ row, count }) => downloadedCollection(row, count))
      .sort((a, b) => a.route.title.localeCompare(b.route.title));
    const allSongs: DownloadCollection = {
      route: { type: 'downloaded-songs', title: 'Songs' }, detail: plural(local.downloadedTracks.length, 'song'),
    };
    tabs.push(downloadsPage([allSongs, ...collections], ui, {
      offset: downloadPaging.account === account ? downloadPaging.offset : 0,
      onPage: offset => setDownloadPaging({ account, offset }),
    }));
  }
  // If tabs are limited, keep Library and Downloads ahead of the Home previews.
  const tabCount = Math.max(1, limits.maximumTabCount);
  const visibleTabs = local.downloadedTracks.length ? tabs.slice(-tabCount) : tabs.slice(0, tabCount);
  const result = (page: BrowsePage | null) => ({ tabs: visibleTabs, page, signedOut });
  if (!route) return result(null);

  const kept = (id: string) => manager?.collectionTracks(id) ?? emptyTracks;
  const isDownloaded = (track: TrackSummary) => availability.downloaded(track.id);
  const header = routeHeader(route);
  switch (route.type) {
    case 'album': {
      const album = albums.query.isPlaceholderData || downloaded ? undefined : albums.query.data;
      const localAlbum = manager?.collectionRow(albumCollectionId(route.id))?.album;
      const downloadedAlbum = kept(albumCollectionId(route.id));
      const keptTracks = (downloadedAlbum.length ? downloadedAlbum : local.keptTracks.filter(track => track.album?.id === route.id))
        .slice().sort((a, b) => (a.disc ?? 0) - (b.disc ?? 0) || (a.position ?? 0) - (b.position ?? 0));
      const albumTracks = album?.discs.flatMap(disc => disc.tracks);
      const songs = downloaded ? keptTracks.filter(isDownloaded)
        : albumTracks?.length ? albumTracks : keptTracks;
      if (!songs.length) {
        if (!album && !localAlbum) return result(queryMessage(header, offline, albums.query.error, albums.checkAgain));
        if (awaitsTrackList(album)) return result(messagePage(header, 'Songs are loading…', undefined, async () => { await albums.checkAgain(); }));
      }
      const title = album?.title ?? localAlbum?.title ?? route.title;
      return result(songsPage({ ...route, title }, songs, { type: 'album', id: album?.id ?? route.id, title }, ui,
        { offset: detailOffset, onPage }, { subtitle: album?.artistCredit ?? localAlbum?.artistCredit, artwork: album?.artwork ?? localAlbum?.artwork ?? songs[0]?.album?.artwork }));
    }
    case 'artist': {
      const data = artist.isPlaceholderData ? undefined : artist.data;
      const localTracks = local.keptTracks.filter(track => track.artists.some(artist => artist.id === route.id));
      if (!data && !localTracks.length) return result(queryMessage(header, offline, artist.error, artist.refetch));
      const albums = data ? releaseGroups(data).flatMap(group => group.albums) : [];
      const top = data?.topTracks ?? emptyTracks;
      const topTracks = offline ? uniqueTracks([...top.filter(ui.canPlay), ...localTracks, ...top]) : top;
      if (data?.detailPending && !albums.length && !topTracks.length && online) {
        return result(messagePage(header, 'Songs are loading…', undefined, async () => { await artist.refetch(); }));
      }
      return result(artistPage(route, { id: data?.id ?? route.id, name: data?.name ?? route.title, radio: data?.radio, albums, topTracks }, ui,
        { offset: detailOffset, onPage }));
    }
    case 'playlist': {
      const details = !downloaded ? playlist.data : undefined;
      const localPlaylist = manager?.collectionRow(playlistCollectionId(route.id))?.playlist;
      const localTracks = kept(playlistCollectionId(route.id));
      if ((!downloaded && isNotFound(playlist.error)) || (!details && !localPlaylist && !localTracks.length)) {
        return result(queryMessage(header, offline, playlist.error, playlist.refetch));
      }
      const songs = downloaded ? localTracks.filter(isDownloaded) : details?.items.map(item => item.track) ?? localTracks;
      const title = details?.name ?? localPlaylist?.name ?? route.title;
      const meta = details ?? localPlaylist;
      return result(songsPage({ ...route, title }, songs, { type: 'playlist', id: meta?.id ?? route.id, title }, ui,
        { offset: detailOffset, onPage }, { subtitle: meta?.ownerName, artwork: meta?.artworks[0] }));
    }
    case 'liked': {
      const localTracks = kept(likedId);
      const songs = downloaded ? localTracks.filter(isDownloaded)
        : likes.data ? likes.items : localTracks.length ? localTracks : local.keptTracks.filter(track => track.liked);
      if (!songs.length && !likes.data && !downloaded) return result(queryMessage(header, offline, likes.error, likes.refetch));
      const hasMore = !downloaded && online && likes.hasNextPage;
      const cursor = hasMore ? likes.data?.pages.at(-1)?.nextCursor : null;
      const loadTracks = api && cursor ? async () => {
        const all = await loadRest(songs, cursor, (next, limit) => api.userdata.likes('track', { cursor: next, limit }));
        tracks.prime(all);
        return all;
      } : undefined;
      return result(songsPage(route, songs, { type: 'liked', id: null, title: route.title }, ui, {
        offset: detailOffset, hasMore,
        onPage: async offset => {
          if (offset >= songs.length && hasMore) await likes.fetchNextPage({ throwOnError: true });
          onPage(offset);
        },
      }, { loadTracks }));
    }
    case 'downloaded-songs': {
      const songs = local.downloadedTracks.slice().sort((a, b) => a.title.localeCompare(b.title));
      return result(songsPage(route, songs, { type: 'other', id: null, title: 'Downloaded Songs' }, ui, { offset: detailOffset, onPage }));
    }
  }
}

export function useCarPlayQueue({
  enabled, limits, current, entries, offset, onPage,
}: {
  enabled: boolean;
  limits: CarPlayLimits;
  current: QueueEntry | null;
  entries: readonly QueueEntry[];
  offset: number;
  onPage: (offset: number) => void;
}): BrowsePage | null {
  const store = useTrackStore();
  const { ui, manager, cache } = usePresentation(limits, current?.trackId);
  const stored = useMemo(() => enabled && ui.offline
    ? new Map(uniqueTracks([...(manager?.tracks() ?? []), ...(cache?.tracks() ?? [])]).map(track => [track.id, track]))
    : undefined, [cache, enabled, manager, ui.canPlay, ui.offline]);
  const snapshot = useMemo(() => {
    const size = pageSize(limits, current ? 1 : 0);
    const upcoming = entries.filter(entry => entry.id !== current?.id);
    const from = pageOffset(offset, upcoming.length, size);
    // Include navigation row slack when a short queue is displayed on one page.
    const visible = [...(current ? [current] : []), ...upcoming.slice(from, from + size + 2)];
    let previous = new Map<string, TrackSummary>();
    return () => {
      if (!enabled) return previous;
      const next = new Map<string, TrackSummary>();
      for (const { id, trackId, albumId } of visible) {
        const track = ui.offline ? store.peek(trackId, albumId) ?? stored?.get(trackId) : store.get(trackId, albumId);
        if (track) next.set(id, track);
      }
      if (next.size !== previous.size || [...next].some(([id, track]) => previous.get(id) !== track)) previous = next;
      return previous;
    };
  }, [current, enabled, entries, limits, offset, store, stored, ui.offline]);
  const tracks = useSyncExternalStore(enabled ? store.subscribe : noSubscription, snapshot);
  return enabled ? queuePage({ entries, current, tracks, presentation: ui, offset, onPage }) : null;
}
