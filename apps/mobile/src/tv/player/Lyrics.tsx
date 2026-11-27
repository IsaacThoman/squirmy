import type { TrackSummary } from '@squirmy/contracts';
import { memo, useEffect, useMemo, useRef, useState, type ComponentRef, type ComponentType } from 'react';
import { ActivityIndicator, Animated, ScrollView, StyleSheet, Text, TVTextScrollView, View, type ScrollViewProps } from 'react-native';
import { loadFailure } from '../../data/errors';
import { useLyrics } from '../../data/queries';
import { usePositionEvery } from '../../playback';
import { activeLine, lyricCredits, lyricLines, type LyricLine } from '../../player/lyrics';
import { Icon } from '../../ui';
import { Button } from '../Button';
import { colors } from '../theme';

// The TV fork types this wrapper with the ScrollView class rather than its props.
const TextScroll = TVTextScrollView as unknown as ComponentType<ScrollViewProps>;

/** The sung line sits this far down the panel, with the ones coming up under it. */
const leadIn = 220;

/**
 * The lyrics beside the cover, as the system's music app shows them on the TV: big bold lines,
 * the one being sung bright and the rest dim, moving up as the song goes. Unsynced lyrics are
 * a page the remote scrolls. Without lyrics it says why, in the phone's words.
 */
export const Lyrics = memo(function Lyrics({ track, live }: { track: TrackSummary | undefined; live: boolean }) {
  const lyrics = useLyrics(track);
  const { lines, synced } = useMemo(() => lyricLines(lyrics.data), [lyrics.data]);
  const credit = lyricCredits(lyrics.data);
  if (lines.length) {
    return synced ? <SyncedLyrics key={track?.id} lines={lines} credit={credit} live={live} /> : <PlainLyrics lines={lines} credit={credit} />;
  }
  return <NoLyrics lyrics={lyrics} />;
});

function SyncedLyrics({ lines, credit, live }: { lines: readonly LyricLine[]; credit: string | null; live: boolean }) {
  const position = usePositionEvery(200, live);
  const active = activeLine(lines, position);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const tops = useRef<number[]>([]);
  const [laidOut, setLaidOut] = useState(0);
  useEffect(() => {
    const top = active < 0 ? 0 : tops.current[active] ?? 0;
    scroll.current?.scrollTo({ y: Math.max(0, top - leadIn), animated: laidOut > 0 });
  }, [active, laidOut]);
  return <ScrollView ref={scroll} style={styles.panel} contentContainerStyle={styles.synced} scrollEnabled={false}
    showsVerticalScrollIndicator={false} onContentSizeChange={() => setLaidOut(count => count + 1)}>
    {lines.map((line, index) => <Line key={index} text={line.text} look={lookOf(index - active)}
      onTop={top => { tops.current[index] = top; }} />)}
    {credit && <Text style={styles.credit}>{`Written by ${credit}`}</Text>}
  </ScrollView>;
}

/**
 * How bright a line is `distance` lines from the sung one: the sung line full, the next two
 * readable, those after fading out toward the controls, and the ones already sung faint as they
 * scroll away, as the system's lyrics do.
 */
function lookOf(distance: number): number {
  if (distance === 0) return 1;
  if (distance < 0) return 0.18;
  return distance <= 2 ? 0.34 : 0.14;
}

/** A line brightens as it comes up and dims as it passes; only the lines whose look changes redraw. */
const Line = memo(function Line({ text, look, onTop }: { text: string; look: number; onTop: (top: number) => void }) {
  const opacity = useRef(new Animated.Value(look)).current;
  useEffect(() => {
    Animated.timing(opacity, { toValue: look, duration: 350, useNativeDriver: true }).start();
  }, [look, opacity]);
  return <Animated.Text onLayout={event => onTop(event.nativeEvent.layout.y)} style={[styles.line, { opacity }]}>{text}</Animated.Text>;
}, (a, b) => a.text === b.text && a.look === b.look);

function PlainLyrics({ lines, credit }: { lines: readonly LyricLine[]; credit: string | null }) {
  return <TextScroll style={styles.panel} contentContainerStyle={styles.plain} showsVerticalScrollIndicator={false}>
    {lines.map((line, index) => <Text key={index} style={styles.plainLine}>{line.text}</Text>)}
    {credit && <Text style={styles.credit}>{`Written by ${credit}`}</Text>}
  </TextScroll>;
}

/**
 * No lines to show. Loading, none and failed look different: a failed request is not a song
 * without lyrics, and a request waiting for the connection has failed for now, too.
 */
function NoLyrics({ lyrics }: { lyrics: ReturnType<typeof useLyrics> }) {
  const failure = lyrics.isError || (lyrics.isPending && lyrics.fetchStatus === 'paused') ? loadFailure(lyrics.error) : null;
  if (!lyrics.data?.instrumental && !failure && lyrics.isLoading) {
    return <View style={styles.empty} accessible accessibilityLabel="Loading lyrics">
      <ActivityIndicator size="large" color={colors.secondary} />
    </View>;
  }
  const empty: { icon: string; title: string; detail?: string; retry?: boolean } = lyrics.data?.instrumental
    ? { icon: 'music.note', title: 'Instrumental' }
    : failure ? { icon: failure.connection ? 'wifi.exclamationmark' : 'exclamationmark.circle', title: 'Couldn’t load lyrics',
      detail: failure.description, retry: failure.retry }
      : { icon: 'quote.bubble', title: 'No lyrics available' };
  return <View style={styles.empty}>
    <Icon name={empty.icon} size={64} color={colors.secondary} />
    <Text style={styles.emptyTitle}>{empty.title}</Text>
    {empty.detail ? <Text style={styles.emptyDetail}>{empty.detail}</Text> : null}
    {empty.retry && <Button label="Try again" icon="arrow.clockwise" onPress={() => void lyrics.refetch()} />}
  </View>;
}

const styles = StyleSheet.create({
  panel: { flex: 1, overflow: 'hidden' },
  synced: { paddingTop: leadIn, paddingBottom: 900, gap: 34 },
  line: { fontSize: 62, lineHeight: 74, fontWeight: '800', color: colors.text, letterSpacing: -0.6 },
  plain: { paddingVertical: 20, gap: 18 },
  plainLine: { fontSize: 44, lineHeight: 56, fontWeight: '700', color: colors.text },
  credit: { fontSize: 27, fontWeight: '500', color: colors.secondary, marginTop: 30 },
  empty: { flex: 1, alignItems: 'flex-start', justifyContent: 'center', gap: 20 },
  emptyTitle: { fontSize: 48, fontWeight: '700', color: colors.text },
  emptyDetail: { fontSize: 29, color: colors.secondary, maxWidth: 820 },
});
