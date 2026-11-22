import { Button, Capsule, Host, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityHint, accessibilityLabel, dynamicTypeSize, font, foregroundStyle, frame, lineLimit, padding,
} from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';
import { IconButton, Symbol, TrackMenu, hitShape, plainButton } from '../native/Controls';
import type { DeviceButtonProps, LyricButtonProps, PlayerButtonProps, TrackMenuButtonProps } from './Controls';
import { useColors } from '../theme';

export function PlayerButton({ icon, label, size, color, onPress, style, selected }: PlayerButtonProps) {
  const colors = useColors();
  const { width = 44, height = 44 } = StyleSheet.flatten(style) ?? {};
  return <Host style={[styles.icon, style]}>
    <IconButton symbol={icon} label={label} size={size} color={color ?? colors.text} onPress={onPress} selected={selected}
      width={Number(width)} height={Number(height)} />
  </Host>;
}

export function CollapseButton({ onPress }: { onPress: () => void }) {
  const colors = useColors();
  return <Host style={{ width: 105, height: 32 }}>
    <Button onPress={onPress} modifiers={[plainButton, accessibilityLabel('Collapse player')]}>
      <Capsule modifiers={[foregroundStyle(colors.grabber), frame({ width: 32, height: 4 }),
        frame({ width: 105, height: 32 }), hitShape]} />
    </Button>
  </Host>;
}

export function TrackMenuButton({ track }: TrackMenuButtonProps) {
  const colors = useColors();
  return <Host style={styles.icon}><TrackMenu track={track} label="Song options" color={colors.text} /></Host>;
}

export function DeviceButton({ icon, name, onPress }: DeviceButtonProps) {
  const colors = useColors();
  return <Host style={styles.device}>
    <Button onPress={onPress} modifiers={[plainButton, accessibilityLabel(`Playback device: ${name}`)]}>
      {/* The footer is a fixed 56 pt tall, so the label stops growing before it overflows it. */}
      <VStack spacing={5} modifiers={[frame({ maxWidth: Infinity, minHeight: 44 }), hitShape, dynamicTypeSize({ max: 'xxxLarge' })]}>
        <Symbol name={icon} size={21} color={colors.accent} />
        <Text modifiers={[foregroundStyle(colors.accent), font({ textStyle: 'caption2', weight: 'semibold' }), lineLimit(1)]}>{name}</Text>
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
