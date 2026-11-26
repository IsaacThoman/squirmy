import { useCallback, useEffect, useMemo, useRef, useState, type ComponentRef, type ComponentType } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TVTextScrollView, View, type ScrollViewProps } from 'react-native';
import type { TrackSummary } from '@squirmy/contracts';
import { useLyrics } from '../../data/queries';
import { usePlaybackActions, usePositionEvery } from '../../playback';
import { activeLine, lyricCredits, lyricLines, type LyricLine } from '../../player/lyrics';
import { TvButton, tvColors } from '../ui';

// The TV fork's generated declarations type this wrapper with the ScrollView constructor rather than its props.
const TranscriptScroll = TVTextScrollView as unknown as ComponentType<ScrollViewProps>;

export function TvLyrics({ track }: { track: TrackSummary | undefined }) {
  const query = useLyrics(track);
  const { lines, synced } = useMemo(() => lyricLines(query.data), [query.data]);
  const credit = lyricCredits(query.data);
  return (
    <View style={styles.panel}>
      {lines.length ? synced ? <SyncedLyrics lines={lines} credit={credit} /> : <PlainLyrics lines={lines} credit={credit} /> : (
        <View style={styles.empty}>
          <Text style={styles.message}>{query.isError ? 'Couldn’t load lyrics.'
            : track?.hasLyrics && query.isPending ? 'Loading lyrics…' : 'No lyrics available for this song.'}</Text>
          {query.isError && <TvButton label="Try again" onPress={() => void query.refetch()} />}
        </View>
      )}
    </View>
  );
}

function SyncedLyrics({ lines, credit }: { lines: readonly LyricLine[]; credit: string | null }) {
  const { seek } = usePlaybackActions();
  const position = usePositionEvery(125);
  const active = activeLine(lines, position);
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const offsets = useRef(new Map<number, number>());
  const [viewport, setViewport] = useState(0);
  const [following, setFollowing] = useState(true);
  const scrollToActive = useCallback(() => {
    if (!following) return;
    const offset = offsets.current.get(active) ?? 0;
    scroll.current?.scrollTo({ y: Math.max(0, offset - viewport * 0.22), animated: true });
  }, [active, following, viewport]);

  useEffect(scrollToActive, [scrollToActive]);

  return (
    <>
      <View style={styles.actions}>
        <TvButton label="Follow playback" selected={following} onPress={() => setFollowing(true)} tone="quiet" />
      </View>
      <ScrollView ref={scroll} style={styles.scroll}
        onLayout={event => setViewport(event.nativeEvent.layout.height)}
        onContentSizeChange={scrollToActive}
        contentContainerStyle={[styles.lines, { paddingBottom: viewport * 0.56 }]}
        showsVerticalScrollIndicator={false}>
        {lines.map((line, index) => (
          <TimedLine key={index} line={line} active={active === index}
            onLayout={y => offsets.current.set(index, y)}
            onFocus={() => setFollowing(false)}
            onPress={() => { if (line.startMs !== null) seek(line.startMs); }} />
        ))}
        {credit && <Text style={styles.credit}>Written by {credit}</Text>}
      </ScrollView>
    </>
  );
}

function TimedLine({ line, active, onLayout, onFocus, onPress }: {
  line: LyricLine;
  active: boolean;
  onLayout: (y: number) => void;
  onFocus: () => void;
  onPress: () => void;
}) {
  const [focused, setFocused] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={line.text}
      accessibilityHint="Seek to this line"
      onLayout={({ nativeEvent }) => onLayout(nativeEvent.layout.y)}
      onFocus={() => { setFocused(true); onFocus(); }}
      onBlur={() => setFocused(false)}
      onPress={onPress}
      style={[styles.line, active && styles.activeLine, focused && styles.focusedLine]}
    >
      <Text style={[styles.lyric, (active || focused) && styles.activeLyric, focused && styles.focusedLyric]}>{line.text}</Text>
    </Pressable>
  );
}

function PlainLyrics({ lines, credit }: { lines: readonly LyricLine[]; credit: string | null }) {
  const [focused, setFocused] = useState(false);
  return (
    <TranscriptScroll
      style={[styles.scroll, styles.transcript, focused && styles.focusedTranscript]}
      contentContainerStyle={styles.lines}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      showsVerticalScrollIndicator={false}
    >
      {lines.map(({ text }, index) => <Text key={index} style={[styles.lyric, styles.activeLyric, styles.plain]}>{text}</Text>)}
      {credit && <Text style={styles.credit}>Written by {credit}</Text>}
    </TranscriptScroll>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, minHeight: 0, gap: 14 },
  actions: { alignItems: 'flex-start' },
  empty: { alignItems: 'flex-start', justifyContent: 'center', flex: 1, gap: 22 },
  message: { color: tvColors.muted, fontSize: 28 },
  scroll: { flex: 1, minHeight: 0 },
  lines: { paddingRight: 22, paddingBottom: 20, gap: 8 },
  line: { paddingHorizontal: 19, paddingVertical: 12, borderRadius: 13, borderLeftWidth: 4, borderLeftColor: 'transparent' },
  activeLine: { backgroundColor: '#CBC1FF17', borderLeftColor: tvColors.accent },
  focusedLine: { backgroundColor: tvColors.text, borderLeftColor: tvColors.text },
  lyric: { color: '#C8C2D4', fontSize: 37, lineHeight: 47, fontWeight: '600', letterSpacing: -0.9 },
  activeLyric: { color: tvColors.text },
  focusedLyric: { color: tvColors.ink },
  transcript: { borderRadius: 14, borderWidth: 2, borderColor: 'transparent' },
  focusedTranscript: { borderColor: tvColors.accent },
  plain: { paddingHorizontal: 17 },
  credit: { color: tvColors.muted, paddingHorizontal: 19, paddingTop: 24, fontSize: 22 },
});
