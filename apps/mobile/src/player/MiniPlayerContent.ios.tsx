import { Button, Host, HStack, ProgressView, RNHostView, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  accessibilityHidden, accessibilityLabel, dynamicTypeSize, font, foregroundStyle, frame, lineLimit, padding, tint,
} from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { IconButton, hitShape, plainButton } from '../native/Controls';
import { useCurrentDurationMs, useLoading, usePlaybackState, usePositionEvery } from '../playback';
import { DETACHED_LABEL, DETACHED_SYMBOL } from './detach';
import { playPauseLabel, STILL_LOADING_LABEL } from './loading';
import { whereItPlays } from './session';
import { Cover } from '../ui';
import { miniCoverSize, usePlayerTransition } from './transition';
import type { MiniPlayerContentProps } from './MiniPlayerContent';
import { usePlayerShown } from './visibility';

import { useColors } from '../theme';

const progressIntervalMs = 1000;
/**
 * The bubble has a fixed height (the system's tab bar accessory). Two lines fit it up to xLarge
 * (font scale 1.118); from xxLarge on (1.235) the subtitle would run into the progress bar, so
 * the bubble shows the title alone, which may then grow as far as the first accessibility size
 * and still clear it. Played separately, the bubble keeps both lines at every size, held at
 * xLarge: "Only on this device" is what says the phone is not playing for the other devices.
 */
const twoLineFontScale = 1.15;
const twoLineLimit = dynamicTypeSize({ max: 'xLarge' });
const oneLineLimit = dynamicTypeSize({ max: 'accessibility1' });

export function MiniPlayerContent({ compact = false, native = false, containerRef, onOpen, onDevices, preview = false }: MiniPlayerContentProps) {
  const colors = useColors();
  const { current, track, output, session, actions, remote, detached } = usePlaybackState();
  const loading = useLoading();
  // Until the current song's details load, say nothing rather than claim nothing is playing.
  const title = track?.title ?? (current ? '' : 'Not Playing');
  // A detached phone says so where "Playing on …" would be, so pressing play here is never a surprise.
  // The marker outlasts a slow load: the play button's spinner already says it is loading.
  const subtitle = detached ? DETACHED_LABEL : loading === 'slow' ? STILL_LOADING_LABEL : remote ? whereItPlays(output, session.playing ? 'Playing' : 'Paused') : track?.artistCredit ?? '';
  const { fontScale } = useWindowDimensions();
  const twoLines = !compact && (detached || fontScale < twoLineFontScale);
  const deviceLabel = detached ? `${DETACHED_LABEL}. Playback devices` : `Playback device, ${output.name}`;
  const size = miniCoverSize(compact, native);
  const { motion } = usePlayerTransition();
  const cover = preview ? <Spacer minLength={0} modifiers={[frame({ width: size, height: size })]} /> : (
    <RNHostView matchContents>
      <View style={{ width: size, height: size }}>
        <Cover artwork={track?.album?.artwork} size={size} radius={8} />
      </View>
    </RNHostView>
  );
  const titleText = <Text modifiers={[font({ textStyle: 'subheadline', weight: 'semibold' }), foregroundStyle(colors.text), lineLimit(1)]}>{title}</Text>;
  const subtitleText = <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(detached ? colors.accent : colors.muted), lineLimit(1)]}>{subtitle}</Text>;
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
            {/* The text opens Now Playing, the whole bubble's height. "Only on this device" is no button of its
                own: stacked under the title, each would get half the bubble (about 22 pt) to touch. The crossed-out
                link beside it, 44 pt square, opens the device picker, where Rejoin is. */}
            <Button onPress={onOpen} modifiers={[plainButton,
              accessibilityLabel(`Open Now Playing, ${[title, detached && DETACHED_LABEL].filter(Boolean).join(', ')}`)]}>
              <HStack spacing={9} modifiers={[frame({ minHeight: 44 }), hitShape]}>
                {cover}
                {/* The compact bubble, inline with the shrunken tab bar, is shorter still and keeps the smaller limit. */}
                <VStack alignment="leading" spacing={1} modifiers={[twoLines || compact ? twoLineLimit : oneLineLimit]}>
                  {titleText}
                  {twoLines && subtitleText}
                </VStack>
                <Spacer minLength={4} />
              </HStack>
            </Button>
            {!compact && <IconButton symbol={detached ? DETACHED_SYMBOL : 'laptopcomputer.and.iphone'} label={deviceLabel}
              size={20} color={colors.accent} onPress={onDevices} />}
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

const styles = StyleSheet.create({ container: { flex: 1 } });
