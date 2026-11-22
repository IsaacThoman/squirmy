import { Button, Host, HStack, ProgressView, RNHostView, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import { accessibilityHidden, accessibilityLabel, font, foregroundStyle, frame, lineLimit, padding, tint } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { IconButton, hitShape, plainButton } from '../native/Controls';
import { usePlaybackState, usePosition } from '../playback';
import { Cover } from '../ui';
import { miniCoverSize, usePlayerTransition } from './transition';
import type { MiniPlayerContentProps } from './MiniPlayerContent';
import { useColors } from '../theme';

export function MiniPlayerContent({ compact = false, native = false, containerRef, onOpen, onDevices, preview = false }: MiniPlayerContentProps) {
  const colors = useColors();
  const { current, track, output, session, actions, preparing, remote } = usePlaybackState();
  // Until the current song's details load, say nothing rather than claim nothing is playing.
  const title = track?.title ?? (current ? '' : 'Not Playing');
  const subtitle = preparing ? 'Preparing…' : remote ? `Playing on ${output.name}` : track?.artistCredit ?? '';
  const size = miniCoverSize(compact, native);
  const { motion } = usePlayerTransition();
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
            <Button onPress={onOpen} modifiers={[plainButton, accessibilityLabel(`Open Now Playing, ${title}`)]}>
              <HStack spacing={9} modifiers={[frame({ minHeight: 44 }), hitShape]}>
                {preview ? <Spacer minLength={0} modifiers={[frame({ width: size, height: size })]} /> : (
                  <RNHostView matchContents>
                    <View style={{ width: size, height: size }}>
                      <Cover artwork={track?.album?.artwork} size={size} radius={8} />
                    </View>
                  </RNHostView>
                )}
                <VStack alignment="leading" spacing={1}>
                  <Text modifiers={[font({ textStyle: 'subheadline', weight: 'semibold' }), foregroundStyle(colors.text), lineLimit(1)]}>{title}</Text>
                  {!compact && <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(colors.muted), lineLimit(1)]}>{subtitle}</Text>}
                </VStack>
                <Spacer minLength={4} />
              </HStack>
            </Button>
            {!compact && <IconButton symbol="airplay.audio" label={`Playback device, ${output.name}`}
              size={20} color={colors.accent} onPress={onDevices} />}
            <IconButton symbol={session.playing ? 'pause.fill' : 'play.fill'} label={session.playing ? 'Pause' : 'Play'}
              size={22} onPress={preview ? undefined : actions.playPause} />
          </HStack>
          {!compact && <Progress />}
        </ZStack>
      </Host>
    </Animated.View>
  </View>;
}

/** The only part of the bubble that follows the playback clock, so each tick redraws just this. */
function Progress() {
  const colors = useColors();
  const { durationMs } = usePlaybackState();
  const position = usePosition();
  const fraction = durationMs > 0 ? Math.min(1, position / durationMs) : 0;
  return <ProgressView value={fraction}
    modifiers={[tint(colors.accent), padding({ horizontal: 26, bottom: 1 }), accessibilityHidden(true)]} />;
}

const styles = StyleSheet.create({ container: { flex: 1 } });
