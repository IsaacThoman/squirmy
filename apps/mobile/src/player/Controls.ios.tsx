import { Button, Capsule, Host, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityHint, accessibilityLabel, animation, Animation, blur, dynamicTypeSize, font, foregroundStyle, frame,
  lineLimit, minimumScaleFactor, opacity, padding,
} from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';
import { IconButton, Symbol, TrackMenu, hitShape, plainButton } from '../native/Controls';
import type { DeviceButtonProps, LyricButtonProps, PlayerButtonProps, TrackMenuButtonProps } from './Controls';
import { useColors } from '../theme';

export function PlayerButton({ icon, label, size, color, onPress, style, selected, busy, filled }: PlayerButtonProps) {
  const colors = useColors();
  const { width = 44, height = 44 } = StyleSheet.flatten(style) ?? {};
  return <Host style={[styles.icon, style]}>
    <IconButton symbol={icon} label={label} size={size} color={color ?? colors.text} onPress={onPress} selected={selected} busy={busy} filled={filled}
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
  return <Host style={styles.icon}><TrackMenu track={track} label="Song options" color={colors.text} /></Host>;
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

export function LyricButton({ line, active, onPress, opacity: shown, blur: blurred = 0, delay = 0 }: LyricButtonProps) {
  const colors = useColors();
  // Given a look, the line is drawn in the text color and dimmed by opacity, so a line coming
  // into song brightens and sharpens in one ease, a moment after the line above it.
  const look = shown === undefined ? [] : [
    blur(blurred), opacity(shown),
    animation(Animation.easeInOut({ duration: 0.42 }).delay(delay / 1000), shown * 100 + blurred),
  ];
  const text = <Text modifiers={[
    foregroundStyle(active || shown !== undefined ? colors.text : colors.quiet), font({ textStyle: 'largeTitle', weight: 'bold' }),
    // Only the words take a tap, so a tap beside or between lines can bring the controls back without seeking.
    hitShape, frame({ maxWidth: Infinity, alignment: 'leading' }), padding({ bottom: 20 }), ...look,
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

/** "Written By" after the last line, quieter and smaller than the lyrics. */
export function LyricCredits({ credits, opacity: shown }: { credits: string; opacity: number }) {
  const colors = useColors();
  return <View style={styles.lyricRow}>
    <Host matchContents={{ vertical: true }}>
      <Text modifiers={[
        foregroundStyle(colors.text), font({ textStyle: 'subheadline', weight: 'semibold' }), opacity(shown),
        frame({ maxWidth: Infinity, alignment: 'leading' }), padding({ top: 8, bottom: 20 }),
      ]}>{`Written By: ${credits}`}</Text>
    </Host>
  </View>;
}

const styles = StyleSheet.create({
  icon: { width: 44, height: 44 },
  device: { height: 56 },
  lyricRow: { width: '100%', maxWidth: 530 },
});
