import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import ReanimatedSwipeable from 'react-native-gesture-handler/ReanimatedSwipeable';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { albums, tracks, type Track } from '../catalog';
import { usePlaybackState } from '../playback';
import { colors, Cover, Icon } from '../ui';

const { background: ink, accent: lilac, muted, text: ivory } = colors;
const faint = '#857F8E';
const swipeActionWidth = 78;

export type SongListProps = {
  trackIds: readonly string[];
  numbered?: boolean;
  onPlay: (id: string) => void;
  onTrackMenu: (id: string) => void;
};

export function SongList({ trackIds, numbered, onPlay, onTrackMenu }: SongListProps) {
  return trackIds.map((id, index) => (
    <SongRow key={id} track={tracks[id]} number={numbered ? index + 1 : undefined}
      onPlay={() => onPlay(id)} onTrackMenu={onTrackMenu} />
  ));
}

function tapFeedback() {
  void Haptics.selectionAsync();
}

function PlayNextSwipeAction({ translation, onPress }: { translation: SharedValue<number>; onPress: () => void }) {
  const reveal = useAnimatedStyle(() => ({
    transform: [{ translateX: Math.max(0, Math.min(swipeActionWidth, swipeActionWidth + translation.value)) }],
  }));

  return (
    <Animated.View style={[styles.swipeTray, reveal]} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      <Pressable accessibilityRole="button" style={({ pressed }) => [styles.swipeAction, pressed && styles.pressed]} onPress={onPress}>
        <Icon name="text.badge.plus" size={19} color={ink} />
        <Text style={styles.swipeText}>Play next</Text>
      </Pressable>
    </Animated.View>
  );
}

function SongRow({ track, number, onPlay, onTrackMenu }: { track: Track; number?: number; onPlay: () => void; onTrackMenu: SongListProps['onTrackMenu'] }) {
  const { state, actions } = usePlaybackState();
  const liked = state.favorites.includes(track.id);
  const current = state.trackId === track.id;
  const playNext = () => {
    tapFeedback();
    actions.addToQueue(track.id, 'next');
  };
  return <ReanimatedSwipeable
    friction={1.8}
    overshootRight={false}
    rightThreshold={35}
    renderRightActions={(_progress, translation, controls) => (
      <PlayNextSwipeAction translation={translation} onPress={() => {
        playNext();
        controls.close();
      }} />
    )}
  >
    <View style={[styles.songRow, current && styles.songCurrent]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Play ${track.title} by ${track.artist}`} style={({ pressed }) => [styles.songInfo, pressed && styles.pressed]} onPress={onPlay} onLongPress={() => onTrackMenu(track.id)}
        accessibilityActions={[{ name: 'playNext', label: 'Play next' }]}
        onAccessibilityAction={event => { if (event.nativeEvent.actionName === 'playNext') playNext(); }}>
        {typeof number === 'number' ? <View style={styles.songPosition}>
          {current ? <Icon name={state.playing ? 'waveform' : 'pause.fill'} size={17} color={lilac} /> : <Text style={styles.songNumber}>{number}</Text>}
        </View> : <Cover source={albums[track.albumId].artwork} size={42} radius={8} />}
        <View style={styles.flex}>
          <Text numberOfLines={1} style={[styles.rowTitle, current && styles.currentTitle]}>{track.title}</Text>
          <Text numberOfLines={1} style={styles.rowSub}>{track.artist}</Text>
        </View>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={liked ? `Unlike ${track.title}` : `Like ${track.title}`} accessibilityState={{ selected: liked }} onPress={() => { tapFeedback(); actions.toggleFavorite(track.id); }} style={styles.rowIcon}>
        <Icon name={liked ? 'heart.fill' : 'heart'} size={19} color={liked ? lilac : muted} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={`More options for ${track.title}`} onPress={() => onTrackMenu(track.id)} style={styles.rowIcon}>
        <Icon name="ellipsis" size={19} color={muted} />
      </Pressable>
    </View>
  </ReanimatedSwipeable>;
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  pressed: { opacity: 0.72 },
  rowTitle: { color: ivory, fontWeight: '600', fontSize: 15, letterSpacing: -0.2 },
  rowSub: { marginTop: 3, color: muted, fontSize: 12 },
  songRow: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#FFFFFF15', paddingLeft: 5, paddingRight: 2, minHeight: 58 },
  songCurrent: { backgroundColor: '#CBC1FF12', borderRadius: 11 },
  songInfo: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 56, gap: 10 },
  songPosition: { width: 25, alignItems: 'center', marginRight: 2 },
  songNumber: { fontSize: 13, color: faint, fontVariant: ['tabular-nums'] },
  currentTitle: { color: lilac },
  rowIcon: { width: 42, height: 44, alignItems: 'center', justifyContent: 'center' },
  swipeTray: { width: swipeActionWidth },
  swipeAction: { flex: 1, backgroundColor: lilac, alignItems: 'center', justifyContent: 'center', gap: 3, borderTopLeftRadius: 10, borderBottomLeftRadius: 10 },
  swipeText: { color: ink, fontSize: 10, fontWeight: '700' },
});
