import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { loadFailure } from '../data/errors';
import type { useLyrics } from '../data/queries';
import { createThemedStyles, useColors } from '../theme';
import { Icon } from '../ui';
import { selectionFeedback } from './design';

/**
 * The page with no lines to show. Loading, none and failed look different: a failed request
 * is not a song without lyrics. A request waiting for the connection (paused) has failed for now, too.
 */
export default function LyricsEmpty({ lyrics }: { lyrics: ReturnType<typeof useLyrics> }) {
  const colors = useColors();
  const styles = useStyles();
  const failure = lyrics.isError || (lyrics.isPending && lyrics.fetchStatus === 'paused') ? loadFailure(lyrics.error) : null;
  const empty: { icon: string; title: string; detail?: string; retry?: boolean } | null = lyrics.data?.instrumental
    ? { icon: 'music.note', title: 'Instrumental' }
    : failure ? { icon: failure.connection ? 'wifi.exclamationmark' : 'exclamationmark.circle', title: 'Couldn’t load lyrics',
      detail: failure.description, retry: failure.retry }
      : lyrics.isLoading ? null : { icon: 'quote.bubble', title: 'No lyrics available' };

  return empty ? (
    <View style={styles.noLyrics}>
      <Icon name={empty.icon} size={29} color={colors.quiet} />
      <Text style={styles.noLyricsTitle}>{empty.title}</Text>
      {empty.detail && <Text style={styles.noLyricsDetail}>{empty.detail}</Text>}
      {empty.retry && <Pressable accessibilityRole="button" hitSlop={10} onPress={() => { selectionFeedback(); void lyrics.refetch(); }}
        style={({ pressed }) => [styles.retry, pressed && styles.pressed]}>
        <Text style={styles.retryText}>Try again</Text>
      </Pressable>}
    </View>
  ) : (
    <View style={styles.noLyrics} accessible accessibilityLabel="Loading lyrics">
      <ActivityIndicator color={colors.muted} />
    </View>
  );
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  noLyrics: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  noLyricsTitle: { color: colors.muted, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  noLyricsDetail: { color: colors.quiet, fontSize: 14, textAlign: 'center', marginTop: -6 },
  retry: { minHeight: 44, paddingHorizontal: 16, justifyContent: 'center' },
  retryText: { color: colors.accent, fontSize: 16, fontWeight: '700' },
  pressed: { opacity: 0.65 },
}));
