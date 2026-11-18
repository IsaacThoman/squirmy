import { Button, Host, HStack, Image, Text } from '@expo/ui/swift-ui';
import {
  accessibilityLabel, background, buttonBorderShape, buttonStyle, clipShape, contentShape, font, foregroundStyle, frame, shapes,
} from '@expo/ui/swift-ui/modifiers';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { colors } from '../ui';
import type { AlbumNavProps, AlbumPlaybackProps } from './AlbumButtons';

const hitShape = contentShape(shapes.rectangle());

export function AlbumNavButton({ icon, label, onPress }: AlbumNavProps) {
  const glass = isLiquidGlassAvailable();
  return (
    <Host colorScheme="dark" style={{ width: 44, height: 44 }}>
      <Button onPress={onPress} modifiers={glass
        ? [buttonStyle('glass'), buttonBorderShape('circle'), accessibilityLabel(label)]
        : [buttonStyle('plain'), background('#26232D'), clipShape('circle'), accessibilityLabel(label)]}>
        <Image systemName={icon} size={20} color={colors.text}
          modifiers={[frame(glass ? { width: 26, height: 26 } : { width: 44, height: 44 }), hitShape]} />
      </Button>
    </Host>
  );
}

export function AlbumPlaybackButtons({ title, onPlay, onShuffle }: AlbumPlaybackProps) {
  const actions = [
    { label: 'Play', symbol: 'play.fill', onPress: onPlay, color: colors.background, surface: colors.accent },
    { label: 'Shuffle', symbol: 'shuffle', onPress: onShuffle, color: colors.text, surface: '#27232E' },
  ] as const;

  return (
    <Host colorScheme="dark" style={{ height: 46, marginTop: 18, alignSelf: 'stretch' }}>
      <HStack spacing={9}>
        {actions.map(({ label, symbol, onPress, color, surface }) => (
          <Button key={label} onPress={onPress}
            modifiers={[buttonStyle('plain'), background(surface), clipShape('capsule'), accessibilityLabel(`${label} ${title}`)]}>
            <HStack spacing={8} modifiers={[frame({ maxWidth: Infinity }), frame({ height: 46 }), hitShape]}>
              <Image systemName={symbol} color={color} size={17} />
              <Text modifiers={[foregroundStyle(color), font({ size: 15, weight: 'bold' })]}>{label}</Text>
            </HStack>
          </Button>
        ))}
      </HStack>
    </Host>
  );
}
