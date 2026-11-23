import { isPlayable } from '@squirmy/client-core';
import type { TrackSummary } from '@squirmy/contracts';
import type { ReactNode } from 'react';
import { Alert, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { useRealtime } from '../data/realtime';
import { isAccessibilitySize } from '../fontScale';
import { useCollectionDownload, useDownloadActions, useViewer } from '../downloads/DownloadsProvider';
import { downloadStatus, type CollectionDownload } from '../downloads/model';
import { createThemedStyles, useColors } from '../theme';
import { Icon } from '../ui';
import type { AlbumNavProps } from './AlbumButtons';
import { tapFeedback } from './shared';

/**
 * The download button of an album, playlist or Liked Songs, and its status line. It is
 * offered when something of `tracks` plays for this user (client-core's `isPlayable`): what
 * the server has, and for a user who may have music fetched, what it can get, which the
 * download asks it for. Offline, only a download already made shows.
 */
export function useDownloadControl(collectionId: string, title: string, tracks: readonly TrackSummary[] | undefined,
  start: () => void): { nav: AlbumNavProps | false; status: ReactNode } {
  const download = useCollectionDownload(collectionId);
  const actions = useDownloadActions();
  const viewer = useViewer();
  const { offline } = useRealtime();
  const startable = Boolean(tracks?.some(track => isPlayable(track, viewer)));
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
    if (startable && !offline) nav = { icon: 'arrow.down.circle', label: `Download ${title}`, onPress: () => { tapFeedback(); start(); } };
  } else if (download.state === 'done') {
    nav = { icon: 'arrow.down.circle.fill', label: `Downloaded. Remove ${title} from this device`, selected: true, onPress: () => remove(false) };
  } else if (download.state === 'incomplete') {
    // All that can be had is here; the status line says what is not.
    nav = {
      icon: 'arrow.down.circle.fill', label: `${download.done} of ${download.total} songs downloaded. Remove ${title} from this device`,
      selected: true, onPress: () => remove(false),
    };
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
  // At accessibility sizes the icon goes above the line, which then has the page's whole width.
  const stacked = isAccessibilitySize(useWindowDimensions().fontScale);
  return <View style={[styles.status, stacked && styles.stacked]} accessibilityRole="text">
    <Icon name={icon} size={13} color={download.state === 'failed' ? colors.danger : colors.muted} />
    <Text style={styles.text}>{text}</Text>
    {retry && <Pressable accessibilityRole="button" hitSlop={10} onPress={onRetry}>
      <Text style={styles.retry}>Retry</Text>
    </Pressable>}
  </View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  // Stretched to the header's width and the text allowed to wrap: a centered row as wide as
  // its text overflowed both edges of the page at large sizes.
  status: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, marginTop: 14, alignSelf: 'stretch' },
  stacked: { flexDirection: 'column', gap: 4 },
  text: { color: colors.muted, fontSize: 13, fontWeight: '600', flexShrink: 1, textAlign: 'center' },
  retry: { color: colors.accent, fontSize: 13, fontWeight: '700' },
}));
