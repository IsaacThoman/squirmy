import { Button, Host, HStack, ProgressView, RNHostView, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import { accessibilityHidden, accessibilityLabel, font, foregroundStyle, frame, lineLimit, padding, tint } from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';
import Animated, { useAnimatedStyle } from 'react-native-reanimated';
import { IconButton, hitShape, plainButton } from '../native/Controls';
import { usePlayback } from '../playback';
import { Cover, colors } from '../ui';
import { miniCoverSize, usePlayerOrigin } from './PlayerOrigin';
import type { MiniPlayerContentProps } from './MiniPlayerContent';

export function MiniPlayerContent({ compact = false, native = false, containerRef, onOpen, onDevices, preview = false }: MiniPlayerContentProps) {
  const { track, album, device, state, actions, position } = usePlayback();
  const size = miniCoverSize(compact, native);
  const { accessoryInPlayer } = usePlayerOrigin();
  const visibility = useAnimatedStyle(() => ({ opacity: preview || !accessoryInPlayer.value ? 1 : 0 }));

  return <View ref={containerRef} collapsable={false} pointerEvents={preview ? 'none' : 'auto'}
    accessibilityElementsHidden={preview} style={styles.container}>
    <Animated.View style={[styles.container, visibility]}>
      <Host colorScheme="dark" ignoreSafeArea="container" style={styles.container}>
        <ZStack alignment="bottom">
          <HStack spacing={0} modifiers={[padding({ horizontal: compact ? 10 : 12 }), frame({ maxHeight: Infinity })]}>
            <Button onPress={onOpen} modifiers={[plainButton, accessibilityLabel(`Open Now Playing, ${track.title}`)]}>
              <HStack spacing={9} modifiers={[frame({ minHeight: 44 }), hitShape]}>
                {preview ? <Spacer minLength={0} modifiers={[frame({ width: size, height: size })]} /> : (
                  <RNHostView matchContents>
                    <View style={{ width: size, height: size }}>
                      <Cover source={album.artwork} size={size} radius={8} />
                    </View>
                  </RNHostView>
                )}
                <VStack alignment="leading" spacing={1}>
                  <Text modifiers={[font({ textStyle: 'subheadline', weight: 'semibold' }), foregroundStyle(colors.text), lineLimit(1)]}>{track.title}</Text>
                  {!compact && <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(colors.muted), lineLimit(1)]}>{track.artist}</Text>}
                </VStack>
                <Spacer minLength={4} />
              </HStack>
            </Button>
            {!compact && <IconButton symbol="airplay.audio" label={`Playback device, ${device.name}`}
              size={20} color={colors.accent} onPress={onDevices} />}
            <IconButton symbol={state.playing ? 'pause.fill' : 'play.fill'} label={state.playing ? 'Pause' : 'Play'}
              size={22} onPress={preview ? undefined : actions.playPause} />
          </HStack>
          {!compact && <ProgressView value={Math.min(1, position / track.duration)}
            modifiers={[tint(colors.accent), padding({ horizontal: 26, bottom: 1 }), accessibilityHidden(true)]} />}
        </ZStack>
      </Host>
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({ container: { flex: 1 } });
