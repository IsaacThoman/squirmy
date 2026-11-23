import type { ComponentRef, Ref } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { useCurrentDurationMs, useLoading, usePlaybackState, usePositionEvery } from '../playback';
import { DETACHED_LABEL, DETACHED_SYMBOL } from './detach';
import { playPauseLabel, STILL_LOADING_LABEL } from './loading';
import { whereItPlays } from './session';
import { Cover, Icon } from '../ui';
import { miniCoverSize, usePlayerTransition } from './transition';
import { createThemedStyles, useColors } from '../theme';
import { usePlaybackStatus } from './usePlaybackStatus';
import { usePlayerShown } from './visibility';

const progressIntervalMs = 1000;

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
  const { current, track, output, session, actions, remote, detached } = usePlaybackState();
  const loading = useLoading();
  const status = usePlaybackStatus();
  // Until the current song's details load, say nothing rather than claim nothing is playing.
  const title = track?.title ?? (current ? '' : 'Not Playing');
  // A detached phone says so where "Playing on …" would be, so pressing play here is never a surprise.
  // The marker outlasts a slow load: the play button's spinner already says it is loading.
  // What playback has to say comes first, for its few seconds or for as long as the pause it explains.
  const subtitle = status ? status.message : detached ? DETACHED_LABEL : loading === 'slow' ? STILL_LOADING_LABEL : remote ? whereItPlays(output, session.playing ? 'Playing' : 'Paused') : track?.artistCredit ?? '';
  const deviceLabel = detached ? `${DETACHED_LABEL}. Playback devices` : `Playback device, ${output.name}`;
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
        <Pressable accessibilityRole="button" accessibilityLabel={`Open Now Playing, ${[title, status?.message ?? (detached && DETACHED_LABEL)].filter(Boolean).join(', ')}`}
          onPress={onOpen} style={styles.info}>
          {preview ? <View style={{ width: size, height: size }} /> : (
            <Cover artwork={track?.album?.artwork} size={size} radius={8} />
          )}
          <View style={styles.copy}>
            <Text numberOfLines={1} style={styles.title}>{title}</Text>
            {!compact && <Text numberOfLines={1} style={[styles.subtitle, (detached || status) && { color: colors.accent }]}>{subtitle}</Text>}
          </View>
        </Pressable>
        {!compact && <Pressable accessibilityRole="button" accessibilityLabel={deviceLabel}
          style={styles.control} onPress={onDevices}>
          <Icon name={detached ? DETACHED_SYMBOL : 'laptopcomputer.and.iphone'} size={21} color={colors.accent} />
        </Pressable>}
        <Pressable accessibilityRole="button" accessibilityLabel={playPauseLabel(session.playing, loading)}
          accessibilityState={{ busy: loading !== 'none' }} onPress={preview ? undefined : actions.playPause} style={styles.control}>
          {loading !== 'none' ? <ActivityIndicator color={colors.text} /> : <Icon name={session.playing ? 'pause.fill' : 'play.fill'} size={23} />}
        </Pressable>
        {!compact && <Progress preview={preview} />}
      </Animated.View>
    </View>
  );
}

/**
 * The only part of the bubble that follows the playback clock, so each tick redraws just this.
 * A thin bar moves about a point a second, so it reads the clock once a second, and only
 * while it can be seen: the bubble's own while Now Playing is away, the preview's while it is up.
 */
function Progress({ preview }: { preview: boolean }) {
  const styles = useStyles();
  const durationMs = useCurrentDurationMs();
  const position = usePositionEvery(progressIntervalMs, usePlayerShown() === preview);
  const fraction = durationMs > 0 ? Math.min(1, position / durationMs) : 0;
  return (
    <View style={styles.progress} pointerEvents="none">
      <View style={[styles.progressFill, { width: `${fraction * 100}%` }]} />
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
