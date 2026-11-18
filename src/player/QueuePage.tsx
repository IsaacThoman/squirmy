import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { GestureDetector, useNativeGesture, usePanGesture, type NativeGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedReaction, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { albums, tracks } from '../catalog';
import { type QueueEntry, usePlaybackState } from '../playback';
import { Cover, Icon } from '../ui';
import { PlayerButton } from './Controls';
import { playerColors as c, selectionFeedback } from './design';

const rowHeight = 62;
const historyLead = 48;
const historyTrail = 15;
const motion = { duration: 140 };
const actionWidth = 102;

export type QueueProps = {
  onTrackMenu: (trackId: string) => void;
};

export default function QueuePage({ onTrackMenu }: QueueProps) {
  const { state, actions } = usePlaybackState();
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const scrollGesture = useNativeGesture();
  const historyHeight = state.history.length ? historyLead + state.history.length * rowHeight + historyTrail : 0;
  const historyOffset = useRef(historyHeight);
  const initialOffset = useRef({ x: 0, y: historyHeight });
  const firstLayout = useRef(true);
  const scrollY = useRef(historyHeight);
  const [viewport, setViewport] = useState(0);
  const [historyVisible, setHistoryVisible] = useState(false);

  useEffect(() => {
    const shift = historyHeight - historyOffset.current;
    historyOffset.current = historyHeight;
    if (!shift) return;
    const target = Math.max(0, scrollY.current + shift);
    scrollY.current = target;
    setHistoryVisible(target < historyHeight - 16);
    const frame = requestAnimationFrame(() => scroll.current?.scrollTo({ y: target, animated: false }));
    return () => cancelAnimationFrame(frame);
  }, [historyHeight]);

  const showHistory = () => {
    selectionFeedback();
    scroll.current?.scrollTo({ y: Math.max(0, historyHeight - viewport * 0.8), animated: true });
  };
  const jumpToCurrent = () => {
    selectionFeedback();
    scroll.current?.scrollTo({ y: historyHeight, animated: true });
  };
  const clearHistory = () => {
    if (Platform.OS === 'web') {
      if (globalThis.confirm('Clear your listening history?')) actions.clearHistory();
    } else {
      Alert.alert('Clear listening history?', undefined, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Clear history', style: 'destructive', onPress: actions.clearHistory },
      ]);
    }
  };

  return (
    <View style={styles.screen}>
      <View style={styles.queueHeader}>
        <Text accessibilityRole="header" style={styles.queueTitle}>Play queue</Text>
        {state.history.length > 0 && (
          <Pressable style={styles.historyJump} accessibilityRole="button" onPress={historyVisible ? jumpToCurrent : showHistory}>
            <Icon name={historyVisible ? 'waveform' : 'clock.arrow.circlepath'} color={c.lilac} size={14} />
            <Text style={styles.historyJumpText}>{historyVisible ? 'Now playing' : 'History'}</Text>
          </Pressable>
        )}
      </View>
      <GestureDetector gesture={scrollGesture}>
        <ScrollView
          ref={scroll}
          contentOffset={initialOffset.current}
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustContentInsets={false}
          onLayout={(event) => setViewport(event.nativeEvent.layout.height)}
          onContentSizeChange={() => {
            if (firstLayout.current) {
              firstLayout.current = false;
              scroll.current?.scrollTo({ y: historyHeight, animated: false });
            }
          }}
          onScroll={(event) => {
            scrollY.current = event.nativeEvent.contentOffset.y;
            setHistoryVisible(scrollY.current < historyHeight - 16);
          }}
          scrollEventThrottle={32}
          showsVerticalScrollIndicator={false}
          contentContainerStyle={[styles.queueContent, { minHeight: historyHeight + viewport }]}
        >
          {state.history.length > 0 && (
            <View style={styles.historySection}>
              <View style={[styles.sectionHeader, styles.historyHeader]}>
                <Text style={styles.sectionTitle}>Listening history</Text>
                <Pressable accessibilityRole="button" onPress={clearHistory} style={styles.clearAction}>
                  <Text style={styles.clearText}>Clear</Text>
                </Pressable>
              </View>
              {state.history.map((entry) => (
                <TrackRow
                  key={entry.id}
                  trackId={entry.trackId}
                  onPress={() => actions.playTrack(entry.trackId)}
                  onTrackMenu={onTrackMenu}
                />
              ))}
            </View>
          )}
          <View style={styles.modeActions}>
            <QueueMode icon="shuffle" label="Shuffle" active={state.shuffle} onPress={actions.toggleShuffle} />
            <QueueMode
              icon={state.repeat === 'one' ? 'repeat.1' : 'repeat'}
              label={state.repeat === 'one' ? 'Repeat one' : 'Repeat'}
              announcement={`Repeat ${state.repeat}`}
              active={state.repeat !== 'off'}
              onPress={actions.cycleRepeat}
            />
            <QueueMode icon="infinity" label="Autoplay" active={state.autoplay} onPress={actions.toggleAutoplay} />
          </View>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>Up next</Text>
            <Text style={styles.sectionDetail}>{state.queue.length} {state.queue.length === 1 ? 'track' : 'tracks'}</Text>
          </View>
          {state.queue.length ? (
            <SortableRows entries={state.queue} scrollGesture={scrollGesture} onTrackMenu={onTrackMenu} />
          ) : (
            <Text style={styles.sectionNote}>Songs you add to the queue will appear here.</Text>
          )}
          <View style={[styles.sectionHeader, styles.autoplayHeader]}>
            <View style={styles.autoplayTitle}>
              <Icon name="infinity" size={17} color={state.autoplay ? c.lilac : c.quiet} />
              <Text style={styles.sectionTitle}>Autoplay</Text>
            </View>
          </View>
          <Text style={styles.sectionNote}>{state.autoplay ? 'Similar tracks continue when your queue ends.' : 'Turn on Autoplay to keep listening.'}</Text>
          {state.autoplay && (
            <SortableRows
              entries={state.autoplayQueue}
              scrollGesture={scrollGesture}

              onTrackMenu={onTrackMenu}
              autoplay
            />
          )}
        </ScrollView>
      </GestureDetector>
    </View>
  );
}

function QueueMode({ icon, label, active, onPress, announcement }: {
  icon: string;
  label: string;
  active: boolean;
  onPress: () => void;
  announcement?: string;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.modeAction, active && styles.modeActive, pressed && styles.pressed]}
      accessibilityRole="switch"
      accessibilityLabel={announcement ?? label}
      accessibilityState={{ checked: active }}
      onPress={() => { selectionFeedback(); onPress(); }}
    >
      <Icon name={icon} size={16} color={active ? c.ink : c.text} />
      <Text style={[styles.modeText, active && styles.modeActiveText]} numberOfLines={1}>{label}</Text>
    </Pressable>
  );
}

function SortableRows({ entries, scrollGesture, onTrackMenu, autoplay = false }: QueueProps & {
  entries: readonly QueueEntry[];
  scrollGesture: NativeGesture;
  autoplay?: boolean;
}) {
  const { actions } = usePlaybackState();
  const from = useSharedValue(-1);
  const destination = useSharedValue(-1);
  const offset = useSharedValue(0);
  const openSwipe = useSharedValue<string | null>(null);

  const resetDrag = () => {
    from.set(-1);
    destination.set(-1);
    offset.set(0);
  };
  useLayoutEffect(() => {
    resetDrag();
    const openId = openSwipe.get();
    if (openId && !entries.some((entry) => entry.id === openId)) openSwipe.set(null);
  }, [entries]);

  const commit = (id: string, index: number) => {
    const current = entries.findIndex((entry) => entry.id === id);
    if (current < 0 || current === index) {
      resetDrag();
      return;
    }
    actions.moveInQueue(id, index);
  };

  return (
    <View style={styles.sortable}>
      {entries.map((entry, index) => (
        <SortableRow
          key={entry.id}
          entry={entry}
          index={index}
          lastIndex={entries.length - 1}
          from={from}
          destination={destination}
          offset={offset}
          onCommit={commit}
          onPlay={() => actions.playQueueEntry(entry.id)}
          onRemove={() => actions.removeFromQueue(entry.id)}
          onPromote={() => {
            if (autoplay) {
              actions.addToQueue(entry.trackId, 'next');
              actions.removeFromQueue(entry.id);
            } else {
              actions.moveInQueue(entry.id, 0);
            }
          }}
          openSwipe={openSwipe}
          scrollGesture={scrollGesture}

          onTrackMenu={onTrackMenu}
        />
      ))}
    </View>
  );
}

function SortableRow({ entry, index, lastIndex, from, destination, offset, onCommit, onPlay, onRemove, onPromote, openSwipe, scrollGesture, onTrackMenu }: QueueProps & {
  entry: QueueEntry;
  index: number;
  lastIndex: number;
  from: SharedValue<number>;
  destination: SharedValue<number>;
  offset: SharedValue<number>;
  onCommit: (id: string, index: number) => void;
  onPlay: () => void;
  onRemove: () => void;
  onPromote: () => void;
  openSwipe: SharedValue<string | null>;
  scrollGesture: NativeGesture;
}) {
  const swipeOffset = useSharedValue(0);
  const startSwipeOffset = useSharedValue(0);
  const trackTitle = tracks[entry.trackId].title;
  const closeSwipe = () => openSwipe.set(null);
  useAnimatedReaction(
    () => openSwipe.value,
    (id) => { if (id !== entry.id) swipeOffset.value = withTiming(0, motion); },
  );
  const swipe = usePanGesture({
    activeOffsetX: -9,
    failOffsetX: 9,
    failOffsetY: [-11, 11],
    onActivate: () => {
      startSwipeOffset.value = swipeOffset.value;
      openSwipe.value = entry.id;
    },
    onUpdate: (event) => {
      swipeOffset.value = Math.max(-actionWidth, Math.min(0, startSwipeOffset.value + event.translationX));
    },
    onDeactivate: (event) => {
      if (!event.canceled && swipeOffset.value + event.velocityX * 0.04 < -actionWidth * 0.5) {
        swipeOffset.value = withTiming(-actionWidth, motion);
      } else {
        openSwipe.value = null;
      }
    },
  });
  const reorder = usePanGesture({
    enabled: lastIndex > 0,
    activeOffsetY: [-5, 5],
    failOffsetX: [-12, 12],
    block: scrollGesture,
    onActivate: () => {
      from.value = index;
      destination.value = index;
      offset.value = 0;
      openSwipe.value = null;
      scheduleOnRN(selectionFeedback);
    },
    onUpdate: (event) => {
      if (from.value !== index) return;
      offset.value = Math.max(-index * rowHeight, Math.min((lastIndex - index) * rowHeight, event.translationY));
      const next = index + Math.round(offset.value / rowHeight);
      if (next !== destination.value) {
        destination.value = next;
        scheduleOnRN(selectionFeedback);
      }
    },
    onDeactivate: (event) => {
      if (from.value !== index) return;
      const next = event.canceled ? index : destination.value;
      destination.value = next;
      offset.value = withTiming((next - index) * rowHeight, motion, (finished) => {
        if (finished) scheduleOnRN(onCommit, entry.id, next);
      });
    },
  });
  const swipeMotion = useAnimatedStyle(() => ({ transform: [{ translateX: swipeOffset.value }] }));
  const trayMotion = useAnimatedStyle(() => ({ transform: [{ translateX: actionWidth + swipeOffset.value }] }));
  const rowMotion = useAnimatedStyle(() => {
    if (from.value === index) {
      return { zIndex: 2, transform: [{ translateY: offset.value }], backgroundColor: '#332A49' };
    }
    let shift = 0;
    if (index > from.value && index <= destination.value) shift = -rowHeight;
    if (index < from.value && index >= destination.value) shift = rowHeight;
    return { zIndex: 0, transform: [{ translateY: withTiming(shift, motion) }], backgroundColor: 'transparent' };
  });

  const swipeAction = (action: () => void) => {
    selectionFeedback();
    closeSwipe();
    action();
  };

  return (
    <Animated.View style={[styles.sortableRow, rowMotion]}>
      <View style={styles.swipeable}>
        <Animated.View style={[styles.swipeActions, trayMotion]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
          <PlayerButton icon="text.insert" label="Play next" size={20} color={c.ink} style={styles.promote} onPress={() => swipeAction(onPromote)} />
          <PlayerButton icon="trash" label="Remove from queue" size={19} color="#FFE9EE" style={styles.remove} onPress={() => swipeAction(onRemove)} />
        </Animated.View>
        <GestureDetector gesture={swipe} touchAction="pan-y">
          <Animated.View style={swipeMotion}>
            <TrackRow
              trackId={entry.trackId}
              onPress={() => { if (openSwipe.get() === entry.id) closeSwipe(); else onPlay(); }}
              onTrackMenu={onTrackMenu}
              onPromote={onPromote}
              onRemove={onRemove}
              handle={lastIndex > 0 && (
                <GestureDetector gesture={reorder}>
                  <View
                    accessible
                    accessibilityRole="adjustable"
                    accessibilityLabel={`Reorder ${trackTitle}`}
                    accessibilityValue={{ min: 1, max: lastIndex + 1, now: index + 1 }}
                    accessibilityActions={[{ name: 'increment', label: 'Move down' }, { name: 'decrement', label: 'Move up' }]}
                    onAccessibilityAction={(event) => {
                      const next = index + (event.nativeEvent.actionName === 'increment' ? 1 : -1);
                      onCommit(entry.id, Math.max(0, Math.min(lastIndex, next)));
                    }}
                    style={styles.handle}
                  >
                    <Icon name="line.3.horizontal" size={18} color={c.quiet} />
                  </View>
                </GestureDetector>
              )}
            />
          </Animated.View>
        </GestureDetector>
      </View>
    </Animated.View>
  );
}

function TrackRow({ trackId, onPress, handle, onTrackMenu, onPromote, onRemove }: {
  trackId: string;
  onPress: () => void;
  handle?: React.ReactNode;
  onTrackMenu: (trackId: string) => void;
  onPromote?: () => void;
  onRemove?: () => void;
}) {
  const { state, actions } = usePlaybackState();
  const track = tracks[trackId];
  const album = albums[track.albumId];
  const favorite = state.favorites.includes(trackId);
  const canManage = onPromote !== undefined || onRemove !== undefined;

  return (
    <View style={styles.trackRow}>
      <Pressable
        style={({ pressed }) => [styles.trackLink, pressed && styles.pressed]}
        accessibilityRole="button"
        accessibilityLabel={`${track.title}, ${track.artist}`}
        accessibilityActions={canManage ? [{ name: 'playNext', label: 'Play next' }, { name: 'remove', label: 'Remove from queue' }] : undefined}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === 'playNext') onPromote?.();
          if (event.nativeEvent.actionName === 'remove') onRemove?.();
        }}
        onPress={onPress}
      >
        <Cover source={album.artwork} size={42} radius={8} />
        <View style={styles.trackCopy}>
          <Text numberOfLines={1} style={styles.trackName}>{track.title}</Text>
          <Text numberOfLines={1} style={styles.trackArtist}>{track.artist}</Text>
        </View>
      </Pressable>
      <PlayerButton
        icon={favorite ? 'heart.fill' : 'heart'}
        size={17}
        label={favorite ? `Remove ${track.title} from favorites` : `Favorite ${track.title}`}
        selected={favorite}
        color={favorite ? c.lilac : c.muted}
        onPress={() => { selectionFeedback(); actions.toggleFavorite(track.id); }}
        style={styles.rowAction}
      />
      <PlayerButton icon="ellipsis" label={`Options for ${track.title}`} size={16} color={c.muted} onPress={() => onTrackMenu(track.id)} style={styles.rowAction} />
      {handle}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  queueHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 25, paddingBottom: 7, minHeight: 46 },
  queueTitle: { color: c.text, fontSize: 28, fontWeight: '700', letterSpacing: -0.8 },
  historyJump: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 36, paddingHorizontal: 11, borderRadius: 18, borderWidth: 1, borderColor: c.stroke, backgroundColor: c.surface },
  historyJumpText: { color: c.lilac, fontWeight: '600', fontSize: 12 },
  queueContent: { paddingHorizontal: 24, paddingBottom: 28 },
  historySection: { paddingBottom: historyTrail },
  historyHeader: { height: historyLead },
  sectionHeader: { minHeight: 35, justifyContent: 'space-between', alignItems: 'center', flexDirection: 'row' },
  sectionTitle: { color: c.text, fontSize: 19, fontWeight: '700', letterSpacing: -0.3 },
  sectionDetail: { color: c.quiet, fontSize: 12, fontWeight: '500', fontVariant: ['tabular-nums'] },
  sectionNote: { color: c.muted, fontSize: 13, marginBottom: 7 },
  clearAction: { minHeight: 44, minWidth: 44, alignItems: 'flex-end', justifyContent: 'center' },
  clearText: { fontSize: 14, fontWeight: '600', color: c.lilac },
  modeActions: { flexDirection: 'row', gap: 7, marginTop: 11, marginBottom: 10 },
  modeAction: { flex: 1, minHeight: 38, borderRadius: 20, backgroundColor: c.surface, borderWidth: 1, borderColor: c.stroke, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, paddingHorizontal: 4 },
  modeActive: { backgroundColor: c.lilac, borderColor: c.lilac },
  modeText: { color: c.text, fontSize: 11, fontWeight: '600', flexShrink: 1 },
  modeActiveText: { color: c.ink },
  autoplayHeader: { marginTop: 15 },
  autoplayTitle: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  trackRow: { height: rowHeight, flexDirection: 'row', alignItems: 'center' },
  trackLink: { flex: 1, minHeight: rowHeight, flexDirection: 'row', alignItems: 'center', gap: 10 },
  trackCopy: { flex: 1, minWidth: 0 },
  trackName: { color: c.text, fontSize: 15, fontWeight: '600' },
  trackArtist: { color: c.muted, fontSize: 12, marginTop: 3 },
  rowAction: { width: 34 },
  handle: { width: 33, height: 44, justifyContent: 'center', alignItems: 'flex-end' },
  pressed: { opacity: 0.62 },
  sortable: { zIndex: 1 },
  sortableRow: { borderRadius: 10 },
  swipeable: { borderRadius: 10, overflow: 'hidden' },
  swipeActions: { position: 'absolute', right: 0, top: 0, bottom: 0, width: actionWidth, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: '#211A32', paddingHorizontal: 5 },
  promote: { borderRadius: 21, backgroundColor: c.lilac },
  remove: { borderRadius: 21, backgroundColor: '#A03757' },
});
