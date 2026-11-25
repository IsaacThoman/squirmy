import { formatBytes, GIGABYTE, plural, UNAVAILABLE_LABEL } from '@squirmy/client-core';
import type { StreamQuality } from '@squirmy/contracts';
import type { Href } from 'expo-router';
import { Alert, Platform } from 'react-native';
import { useUpdateSettings, useUserSettings } from '../data/queries';
import { albumCollection, likedCollection, playlistCollection, type Collection } from '../library/shared';
import { usePageLinks } from '../library/links';
import { tapFeedback } from '../library/shared';
import { useDownloadActions, useDownloadManager, useDownloadsSummary } from './DownloadsProvider';
import { freeSpace } from './files';
import { downloadStatus, songPage, songsId, type CollectionRow } from './model';

export const downloadQualityOptions: readonly { value: StreamQuality; label: string }[] = [
  { value: 'original', label: 'Original' },
  { value: 'high', label: 'High' },
  { value: 'data_saver', label: 'Data Saver' },
];

export const capOptions: readonly { value: number | null; label: string }[] = [
  { value: null, label: 'No Limit' },
  ...[1, 2, 5, 10, 25, 50].map(size => ({ value: size * GIGABYTE, label: `${size} GB` })),
];

export const downloadQualityNote = 'Original keeps each file as it is when this device can play it. High is AAC at 256 kbps. Data Saver takes the least space. A change applies to new downloads.';
export const wifiNote = 'Downloads wait for Wi-Fi instead of using cellular data.';
export const capNote = 'New downloads wait once this much is used.';

const device = Platform.OS === 'ios' ? 'iPhone' : 'phone';

/** One downloaded collection or song as the Downloads screen lists it. `remove` asks first; a swipe uses `removeNow`. */
export type DownloadItem = {
  id: string; collection: Collection; title: string; subtitle: string; failed: boolean; remove: () => void; removeNow: () => void;
  /** Where tapping the row goes; `null` when there is no page to open. */
  href: Href | null;
};

function count(total: number) {
  return plural(total, 'song');
}

/** The Downloads screen: what is kept, grouped by album and playlist, the space it takes, and the download settings. */
export function useDownloadsScreen() {
  const manager = useDownloadManager();
  const summary = useDownloadsSummary();
  const actions = useDownloadActions();
  const settings = useUserSettings().data;
  const update = useUpdateSettings();
  const link = usePageLinks();

  const confirm = (title: string, message: string, action: string, perform: () => void) => {
    tapFeedback();
    Alert.alert(title, message, [{ text: 'Cancel', style: 'cancel' }, { text: action, style: 'destructive', onPress: perform }]);
  };

  const itemOf = (row: CollectionRow): DownloadItem | null => {
    const download = manager?.collection(row.id);
    if (!download) return null;
    const collection = row.kind === 'album' && row.album ? albumCollection({ ...row.album }, link)
      : row.kind === 'playlist' && row.playlist ? playlistCollection(row.playlist, link) : likedCollection(link);
    const detail = download.state === 'done' ? `${count(download.total)} · ${formatBytes(download.bytes)}` : downloadStatus(download).text;
    return {
      id: row.id, collection, title: row.title, failed: download.state === 'failed',
      subtitle: [row.kind === 'album' ? row.subtitle : null, row.gone ? 'No longer on the server' : null, detail].filter(Boolean).join(' · '),
      remove: () => confirm(`Remove “${row.title}”?`, `Its songs will no longer play on this ${device} without a connection.`, 'Remove Download',
        () => actions.removeCollection(row.id)),
      removeNow: () => actions.removeCollection(row.id),
      href: collection.href,
    };
  };

  const rows = summary?.collections ?? [];
  const items = (kind: CollectionRow['kind'][]) => rows.filter(row => kind.includes(row.kind)).sort((a, b) => a.title.localeCompare(b.title))
    .flatMap(row => itemOf(row) ?? []);
  const songs: DownloadItem[] = (manager?.collectionRow(songsId)?.trackIds ?? []).flatMap(trackId => {
    const download = manager?.track(trackId);
    const track = manager?.collectionTracks(songsId).find(item => item.id === trackId);
    if (!download || !track) return [];
    const detail = download.state === 'done' ? formatBytes(download.bytes)
      : download.state === 'failed' ? download.unavailable ? UNAVAILABLE_LABEL : 'Couldn’t be downloaded'
        : download.state === 'downloading' ? `Downloading ${Math.round(download.progress * 100)}%` : 'Waiting to download';
    const page = songPage(track);
    const href = page && link(page.page, page.id);
    return [{
      id: trackId, title: track.title, subtitle: `${track.artistCredit} · ${detail}`, failed: download.state === 'failed', href,
      collection: { key: trackId, kind: 'album', title: track.title, subtitle: track.artistCredit, artwork: track.album?.artwork,
        // The row opens `href`; the collection only draws the cover.
        href: href ?? link('artist', '') },
      remove: () => confirm(`Remove “${track.title}”?`, `It will no longer play on this ${device} without a connection.`, 'Remove Download',
        () => actions.removeTrack(trackId)),
      removeNow: () => actions.removeTrack(trackId),
    }];
  });

  const status = !summary ? null : summary.failed && !summary.pending
    ? { text: `${count(summary.failed)} couldn’t be downloaded`, retry: true }
    : summary.pending ? {
      text: summary.wait === 'wifi' ? `${count(summary.pending)} waiting for Wi-Fi`
        : summary.wait === 'offline' ? `${count(summary.pending)} waiting for the server`
          : summary.wait === 'storage' ? `${count(summary.pending)} waiting: the storage limit is reached`
            : `Downloading ${count(summary.pending)}`,
      retry: false,
    } : summary.unavailable ? { text: `${count(summary.unavailable)} not available`, retry: true } : null;

  return {
    summary,
    used: summary ? `${count(summary.count)} · ${formatBytes(summary.usedBytes)}` : '',
    free: formatBytes(freeSpace()),
    device,
    status,
    albums: items(['album']),
    playlists: items(['liked', 'playlist']),
    songs,
    settings,
    setQuality: (downloadQuality: StreamQuality) => update.mutate({ downloadQuality }),
    setWifiOnly: (downloadOnWifiOnly: boolean) => update.mutate({ downloadOnWifiOnly }),
    cap: actions.cap,
    setCap: actions.setCap,
    retry: actions.retry,
    removeAll: () => confirm('Remove all downloads?', `Every downloaded song is removed from this ${device}.`, 'Remove All', actions.removeAll),
  };
}
