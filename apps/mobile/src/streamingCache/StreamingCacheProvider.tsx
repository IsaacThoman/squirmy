import { artworkUrl, streamUrl } from '@squirmy/client-core';
import { useCallback, useEffect, useMemo, useRef, useState, type PropsWithChildren } from 'react';
import { Platform } from 'react-native';
import { useAccountKey, useServerUrl, useSignedInApi } from '../account/AccountProvider';
import { accountItem } from '../data/accountStorage';
import { useTrackStore } from '../data/library';
import { useUserSettings } from '../data/queries';
import { useRealtime } from '../data/realtime';
import { useDownloadManager } from '../downloads/DownloadsProvider';
import { downloadNetwork } from '../downloads/files';
import { codecsFor } from '../player/session';
import { StreamingCacheContext } from './context';
import { cacheIndex } from './database';
import { cacheFiles } from './files';
import { StreamingCache, type CacheSource } from './manager';
import { defaultLimitBytes, limitOptions } from './model';

/** Covers are kept at the size the lock screen uses, as downloads keep them. */
const keptArtSize = 600;

/** The size limit, kept on this device only. */
const limitItem = accountItem<number>('cacheLimit', 'device');

function storedLimit(): number {
  const stored = limitItem.read();
  return limitOptions.some(option => option.value === stored) ? stored! : defaultLimitBytes;
}

/**
 * The streaming cache of the signed-in account. It follows the user's streaming quality
 * for the network it is on and the device's size limit, fetches only while the server is
 * reachable, and is emptied on sign-out (see `removeStreamingCache`). `PlaybackProvider` tells it what
 * the session will play next.
 */
export function StreamingCacheProvider({ children }: PropsWithChildren) {
  const api = useSignedInApi();
  const account = useAccountKey();
  const serverUrl = useServerUrl();
  const settings = useUserSettings().data;
  const tracks = useTrackStore();
  const downloads = useDownloadManager();
  const { offline, socket } = useRealtime();
  const [cache, setCache] = useState<StreamingCache | null>(null);
  const [limitBytes, setLimitBytes] = useState(storedLimit);
  // Read when a fetch runs: a renewed API client or track store must not restart the cache and its fetches.
  const live = useRef({ api, tracks, downloads, serverUrl, settings });
  live.current = { api, tracks, downloads, serverUrl, settings };

  useEffect(() => {
    if (!account) return;
    const source: CacheSource = {
      describe: (trackId, albumId, quality) => {
        const current = live.current.api;
        if (!current) return Promise.reject(new Error('Signed out'));
        return current.streaming.playback(trackId, { albumId: albumId ?? undefined, quality, codecs: codecsFor(Platform.OS) });
      },
      url: descriptor => streamUrl(live.current.serverUrl, descriptor),
      track: async (trackId, albumId) => {
        const known = live.current.tracks.peek(trackId, albumId);
        if (known || !live.current.api) return known ?? null;
        const { tracks: found } = await live.current.api.catalog.trackSummaries({ tracks: [{ id: trackId, albumId }] });
        live.current.tracks.prime(found);
        return found[0] ?? null;
      },
      artworkUrl: artwork => artworkUrl(live.current.serverUrl, artwork, keptArtSize),
    };
    const network = downloadNetwork();
    const next = new StreamingCache({
      index: cacheIndex(account), files: cacheFiles(), network, source,
      settings: {
        limitBytes: storedLimit(),
        wifiQuality: live.current.settings?.qualityWifi ?? 'original',
        cellularQuality: live.current.settings?.qualityCellular ?? 'high',
      },
      downloaded: trackId => live.current.downloads?.isDownloaded(trackId) ?? false,
    });
    next.start();
    setCache(next);
    return () => {
      next.dispose();
      network.dispose();
      setCache(null);
    };
  }, [account]);

  // Cached tracks show in the queue with no connection.
  useEffect(() => {
    if (cache) tracks.prime(cache.tracks());
  }, [cache, tracks]);

  useEffect(() => {
    if (settings) cache?.setSettings({ wifiQuality: settings.qualityWifi, cellularQuality: settings.qualityCellular });
  }, [cache, settings?.qualityWifi, settings?.qualityCellular]);

  const online = Boolean(socket) && !offline;
  useEffect(() => cache?.setOnline(online), [cache, online]);

  const setLimit = useCallback((bytes: number) => {
    limitItem.write(bytes);
    setLimitBytes(bytes);
    cache?.setSettings({ limitBytes: bytes });
  }, [cache]);

  const value = useMemo(() => ({ cache, limitBytes, setLimit }), [cache, limitBytes, setLimit]);
  return <StreamingCacheContext.Provider value={value}>{children}</StreamingCacheContext.Provider>;
}
