import type { ComponentRef, Ref } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { usePlayback, usePlaybackState } from '../playback';
import { Cover, Icon } from '../ui';
import { miniCoverSize, usePlayerTransition } from './transition';
import { createThemedStyles, useColors } from '../theme';

type BubbleView = ComponentRef<typeof View>;
type Appearance = { compact?: boolean; native?: boolean };

export type MiniPlayerContentProps = Appearance & {
  containerRef?: Ref<BubbleView>;
  onOpen?: () => void;
  onDevices?: () => void;
  preview?: boolean;
};

export function MiniPlayerContent({ compact = false, native = false, containerRef, onOpen, onDevices, preview = false }: MiniPlayerContentProps) {
  const colors = useColors();
  const styles = useStyles();
  const { track, album, device, state, actions } = usePlaybackState();
  const size = miniCoverSize(compact, native);
  const { motion } = usePlayerTransition();
  // While Now Playing grows out of this bubble it draws the bubble's content itself. Stay barely
  // visible rather than hidden so the controls still take touches as the player settles back in.
  const visibility = useAnimatedStyle(() => ({
    opacity: preview || !motion.active.value || !motion.bubble.value ? 1 : 0.02,
  }));

  return (
    <View ref={containerRef} collapsable={false}
      pointerEvents={preview ? 'none' : 'auto'} accessibilityElementsHidden={preview}
      importantForAccessibility={preview ? 'no-hide-descendants' : 'auto'}
      style={styles.flex}>
      <Animated.View style={[styles.container, compact && styles.compact, visibility]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Open Now Playing, ${track.title}`}
          onPress={onOpen} style={styles.info}>
          {preview ? <View style={{ width: size, height: size }} /> : (
            <Cover source={album.artwork} size={size} radius={8} />
          )}
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
        {!compact && <Progress />}
      </Animated.View>
    </View>
  );
}

/** The only part of the bubble that follows the playback clock, so each tick redraws just this. */
function Progress() {
  const styles = useStyles();
  const { track, position } = usePlayback();
  return (
    <View style={styles.progress} pointerEvents="none">
      <View style={[styles.progressFill, { width: `${Math.min(1, position / track.duration) * 100}%` }]} />
    </View>
  );
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  flex: { flex: 1 },
  container: { flex: 1, flexDirection: 'row', alignItems: 'center', paddingHorizontal: 12, paddingVertical: 2 },
  compact: { paddingHorizontal: 10 },
  info: { flex: 1, flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: 10 },
  copy: { flex: 1, paddingRight: 8, gap: 1 },
  title: { color: colors.text, fontSize: 14, fontWeight: '700' },
  subtitle: { color: colors.muted, fontSize: 12, fontWeight: '500' },
  control: { width: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  progress: { position: 'absolute', left: 26, right: 26, bottom: 1, height: 2, borderRadius: 2, backgroundColor: colors.stroke, overflow: 'hidden' },
  progressFill: { height: 2, backgroundColor: colors.accent, borderRadius: 2 },
}));
