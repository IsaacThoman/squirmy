import { useRouter } from 'expo-router';
import { useRef, type ComponentRef, type Ref } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { usePlayback } from './playback';
import { usePlayerOrigin } from './player/PlayerOrigin';
import { colors, Cover, Icon } from './ui';

type BubbleView = ComponentRef<typeof View>;

type Appearance = { compact?: boolean; native?: boolean };

export function MiniPlayer({ compact = false, native = false }: Appearance) {
  const router = useRouter();
  const origin = usePlayerOrigin();
  const bubble = useRef<BubbleView>(null);
  const opening = useRef(false);

  const open = () => {
    if (opening.current || !bubble.current) return;
    opening.current = true;
    bubble.current.measureInWindow((x, y, width, height) => {
      opening.current = false;
      origin.current = width > 0 && height > 0
        ? { x, y, width, height, compact, native, artworkSize: coverSize(compact, native) }
        : null;
      router.push({ pathname: '/player', params: { fromMini: '1' } });
    });
  };

  return <MiniPlayerContent compact={compact} native={native} containerRef={bubble}
    onOpen={open} onDevices={() => router.push('/devices')} />;
}

function coverSize(compact: boolean, native: boolean) {
  return compact ? 28 : native ? 36 : 42;
}

export function MiniPlayerContent({ compact = false, native = false, containerRef, onOpen, onDevices, preview = false, hideArtwork = false }: Appearance & {
  containerRef?: Ref<BubbleView>;
  onOpen?: () => void;
  onDevices?: () => void;
  preview?: boolean;
  hideArtwork?: boolean;
}) {
  const { track, album, device, state, actions, position } = usePlayback();
  const progress = Math.min(1, position / track.duration) * 100;

  return (
    <View ref={containerRef} collapsable={false}
      pointerEvents={preview ? 'none' : 'auto'} accessibilityElementsHidden={preview}
      importantForAccessibility={preview ? 'no-hide-descendants' : 'auto'}
      style={[styles.container, compact && styles.compact]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`Open Now Playing, ${track.title}`}
        onPress={onOpen} style={styles.info}>
        <Cover source={album.artwork} size={coverSize(compact, native)} radius={8}
          style={hideArtwork ? styles.hidden : undefined} />
        <View style={styles.copy}>
          <Text numberOfLines={1} style={styles.title}>{track.title}</Text>
          {!compact && <Text numberOfLines={1} style={styles.subtitle}>{track.artist}</Text>}
        </View>
      </Pressable>
      {!compact && <Pressable accessibilityRole="button" accessibilityLabel={`Playback device, ${device.name}`}
        style={styles.control} onPress={onDevices}>
        <Icon name="airplay.audio" size={21} color={colors.accent} />
      </Pressable>}
      <Pressable accessibilityRole="button" accessibilityLabel={state.playing ? 'Pause' : 'Play'}
        onPress={preview ? undefined : actions.playPause} style={styles.control}>
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
  hidden: { opacity: 0 },
});
