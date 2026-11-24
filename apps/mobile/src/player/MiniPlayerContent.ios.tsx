import { Host, HStack, ProgressView, RNHostView, ZStack } from '@expo/ui/swift-ui';
import { accessibilityHidden, frame, padding, tint } from '@expo/ui/swift-ui/modifiers';
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { IconButton } from '../native/Controls';
import { useCurrentDurationMs, useLoading, usePlaybackState, usePositionEvery } from '../playback';
import { DETACHED_LABEL, DETACHED_SYMBOL } from './detach';
import { playPauseLabel, STILL_LOADING_LABEL } from './loading';
import { Cover } from '../ui';
import { miniCoverSize, usePlayerTransition } from './transition';
import type { MiniPlayerContentProps } from './MiniPlayerContent';
import { usePlaybackStatus } from './usePlaybackStatus';
import { useCurrentTrackHeart } from './useCurrentTrackHeart';
import { heartColor } from '../library/heart';
import { usePlayerShown } from './visibility';
import { skipActions, SwipeTitles, useSkipNeighbours } from './SwipeTitles';

import { useColors } from '../theme';

const progressIntervalMs = 1000;
/**
 * The bubble has a fixed height (the system's tab bar accessory). Two lines fit it up to xLarge
 * (font scale 1.118); from xxLarge on (1.235) the subtitle would run into the progress bar, so
 * the bubble shows the title alone, which may then grow as far as the first accessibility size
 * and still clear it. A playback status (a skipped song, a pause the server caused) keeps both
 * lines at every size, held at xLarge: the app has no toasts.
 */
const twoLineFontScale = 1.15;
/** The font scales of xLarge and of the first accessibility size: the caps above. */
const twoLineLimit = 1.118;
const oneLineLimit = 1.786;
/** The gap SwiftUI's stacks left between the cover and the titles, and after the titles. */
const coverGap = 9;
const titlesEnd = 4;

export function MiniPlayerContent({ compact = false, native = false, containerRef, onOpen, onDevices, preview = false, swipe }: MiniPlayerContentProps) {
  const colors = useColors();
  const { current, track, output, session, queue, actions, remote, detached } = usePlaybackState();
  const { previous, next } = useSkipNeighbours(session, queue);
  const loading = useLoading();
  const status = usePlaybackStatus();
  const { heart, toggle: toggleLiked } = useCurrentTrackHeart();
  // Until the current song's details load, say nothing rather than claim nothing is playing.
  const title = track?.title ?? (current ? '' : 'Not Playing');
  // What playback has to say comes first, for its few seconds or for as long as the pause it explains.
  const subtitle = status ? status.message : loading === 'slow' ? STILL_LOADING_LABEL : track?.artistCredit ?? '';
  const { fontScale } = useWindowDimensions();
  const twoLines = !compact && (status !== null || fontScale < twoLineFontScale);
  const deviceLabel = detached ? `${DETACHED_LABEL}. Playback devices` : `Playback device, ${output.name}`;
  const size = miniCoverSize(compact, native);
  const { motion } = usePlayerTransition();
  // The cover crossfades to a new song's (`Cover`'s transition) as the titles land on it.
  const cover = preview ? <View style={{ width: size, height: size }} /> : <Cover artwork={track?.album?.artwork} size={size} radius={8} />;
  // While Now Playing grows out of this bubble it draws the bubble's content itself. Stay barely
  // visible rather than hidden so the controls still take touches as the player settles back in.
  const visibility = useAnimatedStyle(() => ({
    opacity: preview || !motion.active.value || !motion.bubble.value ? 1 : 0.02,
  }));

  return <View ref={containerRef} collapsable={false} pointerEvents={preview ? 'none' : 'auto'}
    accessibilityElementsHidden={preview} style={styles.container}>
    <Animated.View style={[styles.container, visibility]}>
      <Host ignoreSafeArea="container" style={styles.container}>
        <ZStack alignment="bottom">
          <HStack spacing={0} modifiers={[padding({ horizontal: compact ? 10 : 12 }), frame({ maxHeight: Infinity })]}>
            {/* React Native rather than SwiftUI, so the titles can slide on the UI thread with a swipe
                and VoiceOver can offer the swipe's Next and Previous track as actions. */}
            <RNHostView matchContents={{ vertical: true }}>
              <Pressable accessibilityRole="button"
                accessibilityLabel={`Open Now Playing, ${[title, status?.message].filter(Boolean).join(', ')}`}
                {...skipActions(swipe, onOpen, previous !== null, next !== null)}
                onPress={onOpen} style={styles.opener}>
                {cover}
                {/* The compact bubble, inline with the shrunken tab bar, is shorter still and keeps the smaller limit. */}
                <SwipeTitles swipe={swipe} current={{ key: current?.id ?? '', title, subtitle }} previous={previous} next={next}
                  twoLines={twoLines} statusShown={status !== null || loading === 'slow'}
                  maxFontSizeMultiplier={twoLines || compact ? twoLineLimit : oneLineLimit}
                  titleStyle={[styles.title, { color: colors.text }]}
                  subtitleStyle={[styles.subtitle, { color: status ? colors.accent : colors.muted }]} />
              </Pressable>
            </RNHostView>
            {!compact && <IconButton symbol={detached ? DETACHED_SYMBOL : 'laptopcomputer.and.iphone'} label={deviceLabel}
              size={20} color={remote || detached ? colors.accent : colors.muted} onPress={onDevices} />}
            {!compact && track && <IconButton symbol={heart.icon} label={heart.label} selected={heart.selected}
              size={20} color={heartColor(heart, colors, colors.muted)} onPress={preview ? undefined : toggleLiked} />}
            <IconButton symbol={session.playing ? 'pause.fill' : 'play.fill'} label={playPauseLabel(session.playing, loading)}
              busy={loading !== 'none'} size={22} onPress={preview ? undefined : actions.playPause} />
          </HStack>
          {!compact && <Progress preview={preview} />}
        </ZStack>
      </Host>
    </Animated.View>
  </View>;
}

/**
 * The only part of the bubble that follows the playback clock, so each tick redraws just this.
 * A thin bar moves about a point a second, so it reads the clock once a second, and only
 * while it can be seen: the bubble's own while Now Playing is away, the preview's while it is up.
 */
function Progress({ preview }: { preview: boolean }) {
  const colors = useColors();
  const durationMs = useCurrentDurationMs();
  const position = usePositionEvery(progressIntervalMs, usePlayerShown() === preview);
  const fraction = durationMs > 0 ? Math.min(1, position / durationMs) : 0;
  return <ProgressView value={fraction}
    modifiers={[tint(colors.accent), padding({ horizontal: 26, bottom: 1 }), accessibilityHidden(true)]} />;
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  opener: { flexDirection: 'row', alignItems: 'center', minHeight: 44, gap: coverGap, paddingRight: titlesEnd },
  // SwiftUI's subheadline and caption, which grow with the system text size as these do.
  title: { fontSize: 15, lineHeight: 20, fontWeight: '600' },
  subtitle: { fontSize: 12, lineHeight: 16 },
});
