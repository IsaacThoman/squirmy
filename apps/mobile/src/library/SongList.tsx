import type { TrackSummary } from '@squirmy/contracts';
import * as Haptics from 'expo-haptics';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { memo, useCallback, useMemo } from 'react';
import { useLiked } from '../data/library';
import { heartButton } from './heart';
import { useRealtime } from '../data/realtime';
import { useCanPlay, useTrackDownload, useViewer } from '../downloads/DownloadsProvider';
import { downloadSymbol, unavailableReason } from '../downloads/model';
import { useCurrentTrackState, useTrackLoading } from '../playback';
import { STILL_LOADING_LABEL } from '../player/loading';
import {
  sameRow, songRowKey, songRows, useSongRowHandlers, type SongListItems, type SongRowHandlers, type SongRowItem,
} from './rows';
import { useTrackActionRunner, type TrackAction } from './trackActions';
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
  /** The album whose page the list is: rows name only artists other than the album's, and its menu has no "Go to album". */
  album?: { id: string; artistCredit: string };
};

const rowHeight = 58;

export function SongList(props: SongListProps) {
  const handlers = useSongRowHandlers(props);
  const { run } = useTrackActionRunner();
  return songRows(props).map(item => <SongRow key={item.key} item={item} handlers={handlers} run={run} />);
}

/** The rows of a long list, for a virtualized list to render. */
export function useSongListItems(props: SongListProps): SongListItems {
  const { tracks, numbered, playlist, album } = props;
  const handlers = useSongRowHandlers(props);
  const { run } = useTrackActionRunner();
  const data = useMemo(() => songRows({ tracks, numbered, playlist, album }), [album, numbered, playlist, tracks]);
  const renderItem = useCallback(({ item }: { item: SongRowItem }) => <SongRow item={item} handlers={handlers} run={run} />, [handlers, run]);
  return { data, renderItem, keyExtractor: songRowKey, rowHeight };
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

const playNextAction: TrackAction = { id: 'next', title: 'Play next', icon: 'text.badge.plus' };

const SongRow = memo(function SongRow({ item, handlers, run }: {
  item: SongRowItem; handlers: SongRowHandlers; run: ReturnType<typeof useTrackActionRunner>['run'];
}) {
  const { track, number, index } = item;
  const colors = useColors();
  const styles = useStyles();
  const liked = useLiked('track', track.id, track.liked);
  const playing = useCurrentTrackState(track.id);
  const current = playing !== null;
  const playable = useCanPlay(track);
  const { offline } = useRealtime();
  const mark = downloadSymbol(useTrackDownload(track.id));
  const loading = useTrackLoading(track.id);
  const viewer = useViewer();
  const onPlay = () => handlers.play(index);
  const onMenu = () => handlers.menu(track, index);
  const onRemove = item.playlist && (() => handlers.remove(item.playlist!.itemId));
  const playNext = () => {
    tapFeedback();
    run(track, playNextAction);
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
        accessibilityLabel={`${playable ? 'Play ' : ''}${track.title} by ${track.artistCredit}${track.explicit ? ', Explicit' : ''}${
          playable ? '' : `, ${unavailableReason(track, offline, viewer)}`}`}
        style={({ pressed }) => [styles.songInfo, !playable && styles.unavailable, pressed && styles.pressed]}
        onPress={playable ? onPlay : onMenu} onLongPress={onMenu}
        accessibilityActions={playable ? [{ name: 'playNext', label: 'Play next' }] : undefined}
        onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'playNext') playNext(); }}>
        {typeof number === 'number' ? <View style={styles.songPosition}>
          {current && loading !== 'none' ? <ActivityIndicator size="small" color={colors.accent} />
            : current ? <Icon name={playing === 'playing' ? 'waveform' : 'pause.fill'} size={17} color={colors.accent} /> : <Text style={styles.songNumber}>{number}</Text>}
        </View> : <Cover artwork={track.album?.artwork} size={42} radius={8} />}
        <View style={styles.flex}>
          <View style={styles.titleRow}>
            <Text numberOfLines={1} style={[styles.rowTitle, styles.titleText, current && styles.currentTitle]}>{track.title}</Text>
            {track.explicit && <Icon name="e.square.fill" size={12} color={colors.muted} />}
          </View>
          {/* On an album page a row by the album's artist has no second line, unless it has something else to say. */}
          {(item.showArtist || mark || loading !== 'none') && <View style={styles.subtitle}>
            {typeof number !== 'number' && loading !== 'none' ? <ActivityIndicator size="small" color={colors.accent} style={styles.rowSpinner} />
              : mark && <Icon name={mark} size={11} color={colors.muted} />}
            {(item.showArtist || loading === 'slow') && <Text numberOfLines={1} style={[styles.rowSub, styles.flex]}>
              {loading === 'slow' ? STILL_LOADING_LABEL : track.artistCredit}
            </Text>}
          </View>}
        </View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={heartButton(liked, track.title).label} accessibilityState={{ selected: liked }}
        onPress={() => { tapFeedback(); run(track, { id: liked ? 'unlike' : 'like', title: '', icon: '' }); }} style={styles.rowIcon}>
        <Icon name={liked ? 'heart.fill' : 'heart'} size={19} color={liked ? colors.accent : colors.muted} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`More options for ${track.title}`} onPress={onMenu} style={styles.rowIcon}>
        <Icon name="ellipsis" size={19} color={colors.muted} />
      </Pressable>
    </View>
  </ReanimatedSwipeable>;
}, (a, b) => a.handlers === b.handlers && a.run === b.run && sameRow(a.item, b.item));

const useStyles = createThemedStyles(colors => StyleSheet.create({
  flex: { flex: 1 },
  pressed: { opacity: 0.72 },
  unavailable: { opacity: unavailableOpacity },
  rowTitle: { color: colors.text, fontWeight: '600', fontSize: 15, letterSpacing: -0.2 },
  titleText: { flexShrink: 1 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  rowSub: { color: colors.muted, fontSize: 12 },
  subtitle: { marginTop: 3, flexDirection: 'row', alignItems: 'center', gap: 3 },
  songRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.stroke, paddingLeft: 5, paddingRight: 2, minHeight: 58 },
  songCurrent: { backgroundColor: colors.selection, borderRadius: 11 },
  songInfo: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 56, gap: 10 },
  songPosition: { width: 25, alignItems: 'center', marginRight: 2 },
  songNumber: { fontSize: 13, color: colors.quiet, fontVariant: ['tabular-nums'] },
  currentTitle: { color: colors.accent },
  rowSpinner: { transform: [{ scale: 0.6 }], width: 12, height: 12 },
  rowIcon: { width: 42, height: 44, alignItems: 'center', justifyContent: 'center' },
  swipeTray: { width: swipeActionWidth },
  swipeAction: { flex: 1, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center', borderTopLeftRadius: 10, borderBottomLeftRadius: 10 },
  danger: { backgroundColor: '#A03757' },
}));
