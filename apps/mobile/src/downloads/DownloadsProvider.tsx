import { ApiError, artworkUrl, canFetch, streamUrl, type Viewer } from '@squirmy/client-core';
import type { AlbumDetail, PlaylistDetail, TrackSummary } from '@squirmy/contracts';
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PropsWithChildren,
} from 'react';
import { Platform } from 'react-native';
import { useAccount, useAccountKey, useServerUrl, useSignedInApi, type Api } from '../account/AccountProvider';
import { accountItem } from '../data/accountStorage';
import { useTrackStore } from '../data/library';
import { useUserSettings } from '../data/queries';
import { useRealtime } from '../data/realtime';
import { codecsFor } from '../player/session';
import { useCached, useCachedArtwork, useCacheFilesVersion, useStreamingCache } from '../streamingCache/context';
import { otherAccountsBytes } from '../account/accounts';
import { downloadIndex, downloadUsage } from './database';
import { downloadFiles, downloadNetwork } from './files';
import { DownloadManager, type CollectionContent, type DownloadSource } from './manager';
import {
  albumCollectionId, canPlay, likedId, playlistCollectionId, savedLimit, type CollectionDownload, type CollectionKind, type TrackDownload,
} from './model';

/** Covers are kept at the size the lock screen uses. */
const keptArtSize = 600;
const likedPageSize = 200;
const syncIntervalMs = 6 * 3600_000;
const resyncAfterMs = 10 * 60_000;
/** Server changes come in bursts (a scan, a playlist edit); collections are re-read once they settle. */
const invalidateDelayMs = 3000;
/**
 * Songs the server was getting are looked up this long after the first word that one
 * arrived, gathering the rest of a burst without waiting for the burst to end: an album
 * fetched song by song announces one every few seconds.
 */
const arrivalDelayMs = 1000;

/** `viewer`: the signed-in user, whose role and `canAcquire` decide what plays (client-core's `isPlayable`). */
type DownloadsValue = { manager: DownloadManager | null; offline: boolean; viewer: Viewer | null };

const DownloadsContext = createContext<DownloadsValue>({ manager: null, offline: false, viewer: null });

const noSubscription = () => () => undefined;
const noVersion = () => 0;
const noTrack = { id: '', availability: 'none' } as const;

/** The storage limit, kept on this device only. Null is no limit. */
const capItem = accountItem<number | null>('downloadCap', 'device');

/** `current` gives the latest client, so a replaced one does not rebuild the manager. */
function source(current: () => Api, serverUrl: string): DownloadSource {
  return {
    describe: (trackId, albumId, quality) => current().streaming.playback(trackId, {
      albumId: albumId ?? undefined, quality, codecs: codecsFor(Platform.OS), download: true, intent: 'download',
    }),
    url: descriptor => streamUrl(serverUrl, descriptor),
    artworkUrl: artwork => artworkUrl(serverUrl, artwork, keptArtSize),
    collection: async (kind, id): Promise<CollectionContent> => {
      if (kind === 'album') {
        const album = await current().catalog.album(id);
        return { album, tracks: album.discs.flatMap(disc => disc.tracks) };
      }
      if (kind === 'playlist') {
        const playlist = await current().userdata.playlist(id);
        return { playlist, tracks: playlist.items.map(item => item.track) };
      }
      const tracks: TrackSummary[] = [];
      let cursor: string | undefined;
      do {
        const page = await current().userdata.likes('track', { cursor, limit: likedPageSize });
        tracks.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return { tracks };
    },
    summaries: async tracks => (await current().catalog.trackSummaries({ tracks: tracks.map(track => ({ id: track.id, albumId: track.albumId })) })).tracks,
    acquireTrack: (trackId, query) => current().acquisition.acquireTrack(trackId, query),
    acquireAlbum: (albumId, query) => current().acquisition.acquireAlbum(albumId, query),
    lyrics: async trackId => {
      try {
        return await current().catalog.lyrics(trackId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) return null;
        throw error;
      }
    },
  };
}

/**
 * Downloads for the signed-in account. The manager follows the user's download quality and
 * Wi-Fi setting and the device's storage limit, runs only while the server is reachable,
 * and re-reads downloaded collections when the server says they changed, when it comes
 * back, and every few hours.
 */
export function DownloadsProvider({ children }: PropsWithChildren) {
  const api = useSignedInApi();
  const account = useAccountKey();
  const serverUrl = useServerUrl();
  const settings = useUserSettings().data;
  const tracks = useTrackStore();
  const { offline, socket, onInvalidate } = useRealtime();
  const [manager, setManager] = useState<DownloadManager | null>(null);
  const online = Boolean(socket) && !offline;
  const apiRef = useRef(api);
  apiRef.current = api;
  const { state } = useAccount();
  const user = state.status === 'signedIn' ? state.user : null;
  const role = user?.role;
  const canAcquire = user?.canAcquire;
  // Rebuilt only when what decides playability changes, not on every new user object.
  const viewer = useMemo(() => role === undefined ? null : { role, canAcquire: canAcquire ?? false }, [canAcquire, role]);
  const fetches = canFetch(viewer);

  // Built once per account: rebuilding would cancel the downloads in flight and start them over.
  // Another account's downloads stay on the device, in the same folder, and wait for it to be opened again.
  useEffect(() => {
    if (Platform.isTV || !apiRef.current || !account) return;
    const network = downloadNetwork();
    const next = new DownloadManager({
      index: downloadIndex(account), files: downloadFiles(), network, source: source(() => {
        if (!apiRef.current) throw new Error('Signed out');
        return apiRef.current;
      }, serverUrl),
      options: {
        quality: settings?.downloadQuality ?? 'original', wifiOnly: settings?.downloadOnWifiOnly ?? true, capBytes: savedLimit(capItem.read()), canFetch: fetches,
        // The limit is the device's: the other accounts' downloads, kept for when they are opened again, count too.
        otherBytes: otherAccountsBytes(downloadUsage(), account),
      },
    });
    next.start();
    tracks.prime(next.tracks());
    setManager(next);
    return () => {
      next.dispose();
      network.dispose();
      setManager(null);
    };
  }, [account, serverUrl, tracks]);

  useEffect(() => {
    if (settings) manager?.setOptions({ quality: settings.downloadQuality, wifiOnly: settings.downloadOnWifiOnly });
  }, [manager, settings?.downloadQuality, settings?.downloadOnWifiOnly]);

  useEffect(() => {
    manager?.setOptions({ canFetch: fetches });
  }, [manager, fetches]);

  // Coming back online re-reads everything at most every few minutes: a phone on a weak
  // network can drop and regain its connection many times in that time.
  const lastSync = useRef({ manager: null as DownloadManager | null, at: -Infinity });
  useEffect(() => {
    if (!manager) return;
    manager.setOnline(online);
    if (!online) return;
    const sync = () => {
      lastSync.current = { manager, at: Date.now() };
      void manager.sync();
    };
    if (lastSync.current.manager !== manager || Date.now() - lastSync.current.at >= resyncAfterMs) sync();
    const timer = setInterval(sync, syncIntervalMs);
    return () => clearInterval(timer);
  }, [manager, online]);

  useEffect(() => {
    if (!manager) return;
    const kinds = new Set<CollectionKind>();
    const arrived = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let arrivalTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = onInvalidate((keys, { own }) => {
      for (const [root, id] of keys) {
        // The server invalidates a song when it has it, or when it could not get it.
        if (root === 'track' && typeof id === 'string' && manager.awaits(id)) arrived.add(id);
        // A like made here changes which songs are liked, not what a playlist or album holds.
        if (root === 'likes' && manager.collectionRow(likedId)) kinds.add('liked');
        if (own) continue;
        if (root === 'playlists') kinds.add('playlist');
        if (root === 'library' || (root === 'album' && typeof id === 'string' && manager.collectionRow(albumCollectionId(id)))) kinds.add('album');
      }
      if (arrived.size && !arrivalTimer) {
        arrivalTimer = setTimeout(() => {
          arrivalTimer = undefined;
          void manager.refreshTracks([...arrived]);
          arrived.clear();
        }, arrivalDelayMs);
      }
      if (!kinds.size) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        void manager.syncKinds([...kinds]);
        kinds.clear();
      }, invalidateDelayMs);
    });
    return () => {
      clearTimeout(timer);
      clearTimeout(arrivalTimer);
      stop();
    };
  }, [manager, onInvalidate]);

  const value = useMemo(() => ({ manager, offline, viewer }), [manager, offline, viewer]);
  return <DownloadsContext.Provider value={value}>{children}</DownloadsContext.Provider>;
}

export function useDownloadManager(): DownloadManager | null {
  return useContext(DownloadsContext).manager;
}

/** Re-renders on every change to the downloads, progress included. */
function useVersion(manager: DownloadManager | null): number {
  return useSyncExternalStore(manager?.subscribe ?? noSubscription, manager?.getVersion ?? noVersion);
}

/** Re-renders when a download arrives or is removed. */
function useFilesVersion(manager: DownloadManager | null): number {
  return useSyncExternalStore(manager?.subscribe ?? noSubscription, manager?.getFilesVersion ?? noVersion);
}

export function useTrackDownload(trackId: string | undefined): TrackDownload | undefined {
  const manager = useDownloadManager();
  return useSyncExternalStore(manager?.subscribe ?? noSubscription, () => trackId ? manager?.track(trackId) : undefined);
}

export function useCollectionDownload(id: string): CollectionDownload | undefined {
  const manager = useDownloadManager();
  return useSyncExternalStore(manager?.subscribe ?? noSubscription, () => manager?.collection(id));
}

export function useDownloadsSummary() {
  const manager = useDownloadManager();
  useVersion(manager);
  return manager?.summary() ?? null;
}

/**
 * Whether the server can be reached, and what can be played: with no connection only what
 * is on the device, as a download or in the streaming cache; otherwise what the server
 * has as well. Re-renders when that changes, not on download progress.
 */
export function useAvailability() {
  const { manager, offline, viewer } = useContext(DownloadsContext);
  const version = useFilesVersion(manager);
  const cache = useStreamingCache();
  const cacheVersion = useCacheFilesVersion();
  return useMemo(() => {
    const downloaded = (trackId: string) => manager?.isDownloaded(trackId) ?? false;
    const onDevice = (trackId: string) => downloaded(trackId) || (cache?.has(trackId) ?? false);
    return {
      offline, viewer, downloaded,
      canPlay: (track: Pick<TrackSummary, 'id' | 'availability'>) => canPlay(track, { offline, onDevice, viewer }),
    };
  }, [cache, cacheVersion, manager, offline, version, viewer]);
}

/** Whether one track can be played now; re-renders only when the answer changes. */
export function useCanPlay(track: Pick<TrackSummary, 'id' | 'availability'> | undefined): boolean {
  const { manager, offline, viewer } = useContext(DownloadsContext);
  const subject = track ?? noTrack;
  const cached = useCached(track?.id);
  return useSyncExternalStore(manager?.subscribe ?? noSubscription,
    () => canPlay(subject, { offline, viewer, onDevice: trackId => cached || (manager?.isDownloaded(trackId) ?? false) }));
}

/** The local copy of a cover, when one was kept with a download or a cached track. */
export function useKeptArtwork(artworkId: string | undefined): string | null {
  const manager = useDownloadManager();
  const cached = useCachedArtwork(artworkId);
  const downloaded = useSyncExternalStore(manager?.subscribe ?? noSubscription, () => artworkId ? manager?.artworkUri(artworkId) ?? null : null);
  return downloaded ?? cached;
}

/** An album's page as last downloaded, for opening it with no connection. */
export function useDownloadedAlbum(id: string): AlbumDetail | null {
  const manager = useDownloadManager();
  const version = useFilesVersion(manager);
  return useMemo(() => {
    const row = manager?.collectionRow(albumCollectionId(id));
    if (!manager || !row?.album) return null;
    return { ...row.album, discs: [{ disc: 1, title: null, tracks: manager.collectionTracks(row.id) }] };
  }, [id, manager, version]);
}

/** A playlist as last downloaded. Its items are keyed by track, so it is shown read-only. */
export function useDownloadedPlaylist(id: string): PlaylistDetail | null {
  const manager = useDownloadManager();
  const version = useFilesVersion(manager);
  return useMemo(() => {
    const row = manager?.collectionRow(playlistCollectionId(id));
    if (!manager || !row?.playlist) return null;
    const { updatedAt } = row.playlist;
    return { ...row.playlist, items: manager.collectionTracks(row.id).map(track => ({ itemId: track.id, addedAt: updatedAt, track })) };
  }, [id, manager, version]);
}

/** The albums, artists and playlists that have something downloaded: what stays lit offline. */
export function useKeptCollections() {
  const manager = useDownloadManager();
  const version = useFilesVersion(manager);
  return useMemo(() => {
    const albums = new Set<string>();
    const artists = new Set<string>();
    for (const track of manager?.tracks() ?? []) {
      if (!manager?.isDownloaded(track.id)) continue;
      if (track.album) albums.add(track.album.id);
      for (const artist of track.artists) artists.add(artist.id);
    }
    const playlists = new Set((manager?.summary().collections ?? []).filter(row => row.kind === 'playlist').map(row => row.id.slice('playlist:'.length)));
    return { albums, artists, playlists };
  }, [manager, version]);
}

/** Liked Songs as last downloaded. */
export function useDownloadedLikes(): TrackSummary[] | null {
  const manager = useDownloadManager();
  const version = useFilesVersion(manager);
  return useMemo(() => manager?.collectionRow(likedId) ? manager.collectionTracks(likedId) : null, [manager, version]);
}

/** Starting and removing downloads. */
export function useDownloadActions() {
  const manager = useDownloadManager();
  const [cap, setCapState] = useState(() => savedLimit(capItem.read()));
  const setCap = useCallback((bytes: number | null) => {
    capItem.write(bytes);
    setCapState(bytes);
    manager?.setOptions({ capBytes: bytes });
  }, [manager]);
  return useMemo(() => ({
    album: (album: AlbumDetail) => {
      const { discs, ...summary } = album;
      manager?.addCollection({
        id: albumCollectionId(album.id), kind: 'album', title: album.title, subtitle: album.artistCredit,
        artworks: album.artwork ? [album.artwork] : [], album: summary,
      }, discs.flatMap(disc => disc.tracks));
    },
    playlist: (playlist: PlaylistDetail) => {
      const { items, ...summary } = playlist;
      manager?.addCollection({
        id: playlistCollectionId(playlist.id), kind: 'playlist', title: playlist.name, subtitle: `Playlist · ${playlist.ownerName}`,
        artworks: playlist.artworks, playlist: summary,
      }, items.map(item => item.track));
    },
    /** Starts with the liked songs loaded so far; the rest are read from the server. */
    liked: (tracks: readonly TrackSummary[]) => {
      manager?.addCollection({ id: likedId, kind: 'liked', title: 'Liked Songs', subtitle: 'Playlist', artworks: [] }, tracks);
      void manager?.syncKinds(['liked']);
    },
    track: (track: TrackSummary) => manager?.addTrack(track),
    removeCollection: (id: string) => manager?.removeCollection(id),
    removeTrack: (trackId: string) => manager?.removeTrack(trackId),
    removeAll: () => manager?.removeAll(),
    retry: () => manager?.retry(),
    cap,
    setCap,
  }), [cap, manager, setCap]);
}

/** The signed-in user as the availability rules see them, or null while signed out. */
export function useViewer(): Viewer | null {
  return useContext(DownloadsContext).viewer;
}
