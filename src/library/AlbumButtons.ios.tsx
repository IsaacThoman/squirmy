import { Button, Host, HStack, Image, Text } from '@expo/ui/swift-ui';
import {
  accessibilityLabel, background, buttonBorderShape, buttonStyle, clipShape, contentShape, font, foregroundStyle, frame, shapes,
} from '@expo/ui/swift-ui/modifiers';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import type { AlbumNavProps, AlbumPlaybackProps } from './AlbumButtons';
import { useColors } from '../theme';

const hitShape = contentShape(shapes.rectangle());

export function AlbumNavButton({ icon, label, onPress }: AlbumNavProps) {
  const colors = useColors();
  const glass = isLiquidGlassAvailable();
  return (
    <Host style={{ width: 44, height: 44 }}>
      <Button onPress={onPress} modifiers={glass
        ? [buttonStyle('glass'), buttonBorderShape('circle'), accessibilityLabel(label)]
        : [buttonStyle('plain'), background(colors.surface), clipShape('circle'), accessibilityLabel(label)]}>
        <Image systemName={icon} size={20} color={colors.text}
          modifiers={[frame(glass ? { width: 26, height: 26 } : { width: 44, height: 44 }), hitShape]} />
      </Button>
    </Host>
  );
}

export function AlbumPlaybackButtons({ title, onPlay, onShuffle }: AlbumPlaybackProps) {
  const colors = useColors();
  const actions = [
    { label: 'Play', symbol: 'play.fill', onPress: onPlay, color: colors.onAccent, surface: colors.accent },
    { label: 'Shuffle', symbol: 'shuffle', onPress: onShuffle, color: colors.text, surface: colors.surface },
  ] as const;

  return (
    <Host style={{ height: 46, marginTop: 18, alignSelf: 'stretch' }}>
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
