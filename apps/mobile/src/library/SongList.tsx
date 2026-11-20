import type { TrackSummary } from '@squirmy/contracts';
import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { useLibraryActions, useLiked } from '../data/library';
import { useRealtime } from '../data/realtime';
import { useCanPlay, useTrackDownload } from '../downloads/DownloadsProvider';
import { downloadSymbol, unavailableReason } from '../downloads/model';
import { usePlaybackState } from '../playback';
import { Cover, Icon } from '../ui';
import { createThemedStyles, unavailableOpacity, useColors } from '../theme';

const swipeActionWidth = 78;

export type SongListProps = {
  tracks: readonly TrackSummary[];
  /** Shows each track's position on its album instead of its cover. */
  numbered?: boolean;
  /** Called with the index of the track in `tracks`. */
  onPlay: (index: number) => void;
  onTrackMenu: (track: TrackSummary, index: number) => void;
  /** The rows are a playlist's items, in the same order as `tracks`, which can be removed and (on iOS, while editing) moved. */
  playlist?: {
    id: string;
    itemIds: readonly string[];
    editing: boolean;
    onMove: (itemId: string, toIndex: number) => void;
    onRemove: (itemId: string) => void;
  };
};

export function SongList({ tracks, numbered, onPlay, onTrackMenu, playlist }: SongListProps) {
  return tracks.map((track, index) => (
    <SongRow key={playlist?.itemIds[index] ?? `${track.id}:${index}`} track={track}
      number={numbered ? track.position ?? index + 1 : undefined}
      onPlay={() => onPlay(index)} onMenu={() => onTrackMenu(track, index)}
      onRemove={playlist && (() => playlist.onRemove(playlist.itemIds[index]!))} />
  ));
}

function tapFeedback() {
  void Haptics.selectionAsync();
}

function SwipeAction({ translation, icon, danger, onPress }: { translation: SharedValue<number>; icon: string; danger?: boolean; onPress: () => void }) {
  const colors = useColors();
  const styles = useStyles();
  const reveal = useAnimatedStyle(() => ({
    transform: [{ translateX: Math.max(0, Math.min(swipeActionWidth, swipeActionWidth + translation.value)) }],
  }));

  return (
    <Animated.View style={[styles.swipeTray, reveal]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Pressable accessibilityRole="button" style={({ pressed }) => [styles.swipeAction, danger && styles.danger, pressed && styles.pressed]} onPress={onPress}>
        <Icon name={icon} size={19} color={danger ? '#FFE9EE' : colors.onAccent} />
      </Pressable>
    </Animated.View>
  );
}

function SongRow({ track, number, onPlay, onMenu, onRemove }: {
  track: TrackSummary; number?: number; onPlay: () => void; onMenu: () => void; onRemove?: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const { session, actions } = usePlaybackState();
  const liked = useLiked('track', track.id, track.liked);
  const { setLiked } = useLibraryActions();
  const current = session.current?.trackId === track.id;
  const playable = useCanPlay(track);
  const { offline } = useRealtime();
  const mark = downloadSymbol(useTrackDownload(track.id));
  const playNext = () => {
    tapFeedback();
    actions.enqueue([track], 'next');
  };
  const swipe = onRemove ? { icon: 'trash', danger: true, run: onRemove } : playable ? { icon: 'text.badge.plus', danger: false, run: playNext } : null;
  return <ReanimatedSwipeable
    friction={1.8}
    overshootRight={false}
    rightThreshold={35}
    enabled={swipe !== null}
    renderRightActions={(_progress, translation, controls) => swipe && (
      <SwipeAction translation={translation} icon={swipe.icon} danger={swipe.danger} onPress={() => {
        swipe.run();
        controls.close();
      }} />
    )}
  >
    <View style={[styles.songRow, current && styles.songCurrent]}>
      <Pressable accessibilityRole="button"
        accessibilityLabel={playable ? `Play ${track.title} by ${track.artistCredit}` : `${track.title} by ${track.artistCredit}, ${unavailableReason(track, offline)}`}
        style={({ pressed }) => [styles.songInfo, !playable && styles.unavailable, pressed && styles.pressed]}
        onPress={playable ? onPlay : onMenu} onLongPress={onMenu}
        accessibilityActions={playable ? [{ name: 'playNext', label: 'Play next' }] : undefined}
        onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'playNext') playNext(); }}>
        {typeof number === 'number' ? <View style={styles.songPosition}>
          {current ? <Icon name={session.playing ? 'waveform' : 'pause.fill'} size={17} color={colors.accent} /> : <Text style={styles.songNumber}>{number}</Text>}
        </View> : <Cover artwork={track.album?.artwork} size={42} radius={8} />}
        <View style={styles.flex}>
          <Text numberOfLines={1} style={[styles.rowTitle, current && styles.currentTitle]}>{track.title}</Text>
          <View style={styles.subtitle}>
            {mark && <Icon name={mark} size={11} color={colors.muted} />}
            <Text numberOfLines={1} style={[styles.rowSub, styles.flex]}>{track.artistCredit}</Text>
          </View>
        </View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={liked ? `Unlike ${track.title}` : `Like ${track.title}`} accessibilityState={{ selected: liked }}
        onPress={() => { tapFeedback(); setLiked('track', track.id, !liked); }} style={styles.rowIcon}>
        <Icon name={liked ? 'heart.fill' : 'heart'} size={19} color={liked ? colors.accent : colors.muted} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`More options for ${track.title}`} onPress={onMenu} style={styles.rowIcon}>
        <Icon name="ellipsis" size={19} color={colors.muted} />
      </Pressable>
    </View>
  </ReanimatedSwipeable>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  flex: { flex: 1 },
  pressed: { opacity: 0.72 },
  unavailable: { opacity: unavailableOpacity },
  rowTitle: { color: colors.text, fontWeight: '600', fontSize: 15, letterSpacing: -0.2 },
  rowSub: { color: colors.muted, fontSize: 12 },
  subtitle: { marginTop: 3, flexDirection: 'row', alignItems: 'center', gap: 3 },
  songRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.stroke, paddingLeft: 5, paddingRight: 2, minHeight: 58 },
  songCurrent: { backgroundColor: colors.selection, borderRadius: 11 },
  songInfo: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 56, gap: 10 },
  songPosition: { width: 25, alignItems: 'center', marginRight: 2 },
  songNumber: { fontSize: 13, color: colors.quiet, fontVariant: ['tabular-nums'] },
  currentTitle: { color: colors.accent },
  rowIcon: { width: 42, height: 44, alignItems: 'center', justifyContent: 'center' },
  swipeTray: { width: swipeActionWidth },
  swipeAction: { flex: 1, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', borderTopLeftRadius: 10, borderBottomLeftRadius: 10 },
  danger: { backgroundColor: '#A03757' },
}));
