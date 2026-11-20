import type { ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { useRealtime } from '../data/realtime';
import { useCollectionDownload, useDownloadActions } from '../downloads/DownloadsProvider';
import { formatBytes, type CollectionDownload, type WaitReason } from '../downloads/model';
import { createThemedStyles, useColors } from '../theme';
import { Icon } from '../ui';
import type { AlbumNavProps } from './AlbumButtons';
import { tapFeedback } from './shared';

const waiting: Record<WaitReason, string> = {
  offline: 'Waiting for the server',
  wifi: 'Waiting for Wi-Fi',
  storage: 'Storage limit reached',
};

/** The line under a collection's buttons while it is downloaded or downloading. */
export function downloadStatus(download: CollectionDownload): { icon: string; text: string; retry?: boolean } {
  switch (download.state) {
    case 'queued': return { icon: 'arrow.down.circle.dotted', text: download.wait ? waiting[download.wait] : 'Waiting to download' };
    case 'downloading': return { icon: 'arrow.down.circle.dotted', text: `Downloading ${download.done + 1} of ${download.total}` };
    case 'failed': {
      const missing = download.total - download.done;
      return { icon: 'exclamationmark.circle', text: `${missing} ${missing === 1 ? 'song' : 'songs'} couldn’t be downloaded`, retry: true };
    }
    case 'done': return {
      icon: 'arrow.down.circle.fill',
      text: download.gone ? 'Downloaded · No longer on the server' : `Downloaded · ${formatBytes(download.bytes)}`,
    };
  }
}

/**
 * The download button of an album, playlist or Liked Songs, and its status line. `start`
 * is null when there is nothing to download. Offline, only a download already made shows.
 */
export function useDownloadControl(collectionId: string, title: string, start: (() => void) | null): { nav: AlbumNavProps | false; status: ReactNode } {
  const download = useCollectionDownload(collectionId);
  const actions = useDownloadActions();
  const { offline } = useRealtime();
  const remove = (cancel: boolean) => {
    tapFeedback();
    Alert.alert(cancel ? `Stop downloading “${title}”?` : `Remove “${title}” from this device?`,
      cancel ? 'What has downloaded so far is removed too.' : 'Its songs will no longer play without a connection.', [
        { text: 'Cancel', style: 'cancel' },
        { text: cancel ? 'Stop Download' : 'Remove Download', style: 'destructive', onPress: () => actions.removeCollection(collectionId) },
      ]);
  };
  let nav: AlbumNavProps | false = false;
  if (!download) {
    if (start && !offline) nav = { icon: 'arrow.down.circle', label: `Download ${title}`, onPress: () => { tapFeedback(); start(); } };
  } else if (download.state === 'done') {
    nav = { icon: 'arrow.down.circle.fill', label: `Downloaded. Remove ${title} from this device`, selected: true, onPress: () => remove(false) };
  } else if (download.state === 'failed') {
    nav = { icon: 'exclamationmark.circle', label: `Retry downloading ${title}`, onPress: () => { tapFeedback(); actions.retry(); } };
  } else {
    nav = { icon: 'arrow.down.circle.dotted', label: `Downloading ${title}. Stop download`, busy: download.state === 'downloading', onPress: () => remove(true) };
  }
  return { nav, status: download ? <DownloadStatus download={download} onRetry={actions.retry} /> : null };
}

function DownloadStatus({ download, onRetry }: { download: CollectionDownload; onRetry: () => void }) {
  const colors = useColors();
  const styles = useStyles();
  const { icon, text, retry } = downloadStatus(download);
  return <View style={styles.status} accessibilityRole="text">
    <Icon name={icon} size={13} color={download.state === 'failed' ? colors.danger : colors.muted} />
    <Text style={styles.text}>{text}</Text>
    {retry && <Pressable accessibilityRole="button" hitSlop={10} onPress={onRetry}>
      <Text style={styles.retry}>Retry</Text>
    </Pressable>}
  </View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  status: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: 14 },
  text: { color: colors.muted, fontSize: 13, fontWeight: '600' },
  retry: { color: colors.accent, fontSize: 13, fontWeight: '700' },
}));
