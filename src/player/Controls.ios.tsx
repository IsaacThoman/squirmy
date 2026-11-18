import { Button, Capsule, Host, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityHint, accessibilityLabel, font, foregroundStyle, frame, lineLimit, padding,
} from '@expo/ui/swift-ui/modifiers';
import { StyleSheet, View } from 'react-native';
import { IconButton, Symbol, TrackMenu, hitShape, plainButton } from '../native/Controls';
import { playerColors as c } from './design';
import type { DeviceButtonProps, LyricButtonProps, PlayerButtonProps, TrackMenuButtonProps } from './Controls';

export function PlayerButton({ icon, label, size, color = c.text, onPress, style, selected }: PlayerButtonProps) {
  const { width = 44, height = 44 } = StyleSheet.flatten(style) ?? {};
  return <Host colorScheme="dark" style={[styles.icon, style]}>
    <IconButton symbol={icon} label={label} size={size} color={color} onPress={onPress} selected={selected}
      width={Number(width)} height={Number(height)} />
  </Host>;
}

export function CollapseButton({ onPress }: { onPress: () => void }) {
  return <Host colorScheme="dark" style={{ width: 105, height: 32 }}>
    <Button onPress={onPress} modifiers={[plainButton, accessibilityLabel('Collapse player')]}>
      <Capsule modifiers={[foregroundStyle('#FFFFFF66'), frame({ width: 32, height: 4 }),
        frame({ width: 105, height: 32 }), hitShape]} />
    </Button>
  </Host>;
}

export function TrackMenuButton({ trackId }: TrackMenuButtonProps) {
  return <Host colorScheme="dark" style={styles.icon}><TrackMenu trackId={trackId} label="Song options" color={c.text} /></Host>;
}

export function DeviceButton({ icon, name, onPress }: DeviceButtonProps) {
  return <Host colorScheme="dark" style={styles.device}>
    <Button onPress={onPress} modifiers={[plainButton, accessibilityLabel(`Playback device: ${name}`)]}>
      <VStack spacing={5} modifiers={[frame({ maxWidth: Infinity, minHeight: 44 }), hitShape]}>
        <Symbol name={icon} size={21} color={c.lilac} />
        <Text modifiers={[foregroundStyle(c.lilac), font({ textStyle: 'caption2', weight: 'semibold' }), lineLimit(1)]}>{name}</Text>
      </VStack>
    </Button>
  </Host>;
}

export function LyricButton({ line, active, onPress }: LyricButtonProps) {
  return <View style={styles.lyricRow}>
    <Host colorScheme="dark" matchContents={{ vertical: true }}>
      <Button onPress={onPress} modifiers={[
        plainButton, accessibilityHint('Seek to this line'),
        ...(active ? [accessibilityAddTraits(['isSelected'])] : []),
      ]}>
        <Text modifiers={[
          foregroundStyle(active ? c.text : '#BAB1CB91'), font({ textStyle: 'largeTitle', weight: 'bold' }),
          frame({ maxWidth: Infinity, alignment: 'leading' }), padding({ bottom: 20 }), hitShape,
        ]}>{line}</Text>
      </Button>
    </Host>
  </View>;
}

const styles = StyleSheet.create({
  icon: { width: 44, height: 44 },
  device: { height: 56 },
  lyricRow: { width: '100%', maxWidth: 530 },
});
