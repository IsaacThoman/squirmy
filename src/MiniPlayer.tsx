import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePlayback } from './playback';
import { colors, Cover, Icon } from './ui';

export function MiniPlayer({ compact = false, native = false }: { compact?: boolean; native?: boolean }) {
  const router = useRouter();
  const { track, album, device, state, actions, position } = usePlayback();
  const progress = Math.min(1, position / track.duration) * 100;

  return (
    <View style={[styles.container, compact && styles.compact]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Open Now Playing, ${track.title}`}
        onPress={() => router.push('/player')} style={styles.info}>
        <Cover source={album.artwork} size={compact ? 28 : native ? 36 : 42} radius={8} />
        <View style={styles.copy}>
          <Text numberOfLines={1} style={styles.title}>{track.title}</Text>
          {!compact && <Text numberOfLines={1} style={styles.subtitle}>{track.artist}</Text>}
        </View>
      </Pressable>
      {!compact && <Pressable accessibilityRole="button" accessibilityLabel={`Playback device, ${device.name}`}
        style={styles.control} onPress={() => router.push('/devices')}>
        <Icon name="airplay.audio" size={21} color={colors.accent} />
      </Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel={state.playing ? 'Pause' : 'Play'}
        onPress={actions.playPause} style={styles.control}>
        <Icon name={state.playing ? 'pause.fill' : 'play.fill'} size={23} />
      </Pressable>
      {!compact && <View style={styles.progress} pointerEvents="none">
        <View style={[styles.progressFill, { width: `${progress}%` }]} />
      </View>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 2 },
  compact: { paddingHorizontal: 10 },
  info: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 10 },
  copy: { flex: 1, paddingRight: 8, gap: 1 },
  title: { color: colors.text, fontSize: 14, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: 12, fontWeight: '500' },
  control: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  progress: { position: 'absolute', left: 26, right: 26, bottom: 1, height: 2, borderRadius: 2, backgroundColor: '#ffffff14', overflow: 'hidden' },
  progressFill: { height: 2, backgroundColor: colors.accent, borderRadius: 2 },
});
