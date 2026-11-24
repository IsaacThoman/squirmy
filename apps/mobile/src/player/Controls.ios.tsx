import { Button, Capsule, Host, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityHint, accessibilityLabel, dynamicTypeSize, font, foregroundStyle, frame, lineLimit, minimumScaleFactor,
  padding,
} from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';
import { IconButton, Symbol, TrackMenu, hitShape, plainButton } from '../native/Controls';
import type { DeviceButtonProps, LyricButtonProps, PlayerButtonProps, TrackMenuButtonProps } from './Controls';
import { useColors } from '../theme';

// The heart and menu buttons ignore the safe area: inside the iOS queue's scroll view, where
// the song playing rides with the page, its insets pushed their symbols out of the 44 pt frame
// at accessibility text sizes.
export function PlayerButton({ icon, label, size, color, onPress, style, selected, busy }: PlayerButtonProps) {
  const colors = useColors();
  const { width = 44, height = 44 } = StyleSheet.flatten(style) ?? {};
  return <Host ignoreSafeArea="container" style={[styles.icon, style]}>
    <IconButton symbol={icon} label={label} size={size} color={color ?? colors.text} onPress={onPress} selected={selected} busy={busy}
      width={Number(width)} height={Number(height)} />
  </Host>;
}

/** The grabber, 14 pt from the top of a 44 pt target that reaches below the 32 pt row it is drawn in. */
export function CollapseButton({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  return <Host style={{ width: 105, height: 44 }}>
    <Button onPress={onPress} modifiers={[plainButton, accessibilityLabel('Collapse player')]}>
      <Capsule modifiers={[foregroundStyle(colors.grabber), frame({ width: 32, height: 4 }), padding({ top: 14 }),
        frame({ width: 105, height: 44, alignment: 'top' }), hitShape]} />
    </Button>
  </Host>;
}

export function TrackMenuButton({ track }: TrackMenuButtonProps) {
  const colors = useColors();
  return <Host ignoreSafeArea="container" style={styles.icon}><TrackMenu track={track} label="Song options" color={colors.text} /></Host>;
}

export function DeviceButton({ icon, name, highlighted, onPress }: DeviceButtonProps) {
  const colors = useColors();
  const color = highlighted ? colors.accent : colors.muted;
  return <Host style={styles.device}>
    <Button onPress={onPress} modifiers={[plainButton, accessibilityLabel(`Playback device: ${name}`)]}>
      {/* The footer is a fixed 56 pt tall, so the label stops growing before it overflows it. */}
      <VStack spacing={5} modifiers={[frame({ maxWidth: Infinity, minHeight: 44 }), hitShape, dynamicTypeSize({ max: 'xxxLarge' })]}>
        <Symbol name={icon} size={21} color={color} />
        {/* Shrinks a little rather than cut "Only on this device" short at the largest sizes. */}
        <Text modifiers={[foregroundStyle(color), font({ textStyle: 'caption2', weight: 'semibold' }), lineLimit(1),
          minimumScaleFactor(0.8)]}>{name}</Text>
      </VStack>
    </Button>
  </Host>;
}

export function LyricButton({ line, active, onPress }: LyricButtonProps) {
  const colors = useColors();
  const text = <Text modifiers={[
    foregroundStyle(active ? colors.text : colors.quiet), font({ textStyle: 'largeTitle', weight: 'bold' }),
    frame({ maxWidth: Infinity, alignment: 'leading' }), padding({ bottom: 20 }), hitShape,
  ]}>{line}</Text>;
  return <View style={styles.lyricRow}>
    <Host matchContents={{ vertical: true }}>
      {onPress ? <Button onPress={onPress} modifiers={[
        plainButton, accessibilityHint('Seek to this line'),
        ...(active ? [accessibilityAddTraits(['isSelected'])] : []),
      ]}>{text}</Button> : text}
    </Host>
  </View>;
}

const styles = StyleSheet.create({
  icon: { width: 44, height: 44 },
  device: { height: 56 },
  lyricRow: { width: '100%', maxWidth: 530 },
});
