import type { TrackSummary } from '@squirmy/contracts';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { Icon } from '../ui';
import { createThemedStyles, useColors } from '../theme';

export type PlayerButtonProps = {
  icon: string;
  label: string;
  size?: number;
  color?: string;
  onPress: () => void;
  style?: StyleProp<ViewStyle>;
  selected?: boolean;
  /** Shows an activity spinner in place of the icon, as while a track loads; the button still works. */
  busy?: boolean;
};

export type DeviceButtonProps = { icon: string; name: string; onPress: () => void };
export type TrackMenuButtonProps = { track: TrackSummary; onPress: () => void };
/** Without `onPress` (plain lyrics) the line is only text. */
export type LyricButtonProps = { line: string; active: boolean; onPress?: () => void };

export function PlayerButton({ icon, label, size = 20, color, onPress, style, selected, busy }: PlayerButtonProps) {
  const colors = useColors();
  const styles = useStyles();
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    accessibilityState={selected === undefined ? { busy } : { selected, busy }} onPress={onPress}
    style={({ pressed }) => [styles.icon, style, pressed && styles.pressed]}>
    {busy ? <ActivityIndicator size={size >= 32 ? 'large' : 'small'} color={color ?? colors.text} />
      : <Icon name={icon} size={size} color={color ?? colors.text} />}
  </Pressable>;
}

export function CollapseButton({ onPress }: { onPress: () => void }) {
  const styles = useStyles();
  return <Pressable accessibilityRole="button" accessibilityLabel="Collapse player" onPress={onPress} style={styles.grabberPress}>
    <View style={styles.grabber} />
  </Pressable>;
}

export function TrackMenuButton({ onPress }: TrackMenuButtonProps) {
  return <PlayerButton icon="ellipsis" label="Song options" onPress={onPress} />;
}

export function DeviceButton({ icon, name, onPress }: DeviceButtonProps) {
  const colors = useColors();
  const styles = useStyles();
  return <Pressable accessibilityRole="button" accessibilityLabel={`Playback device: ${name}`}
    style={({ pressed }) => [styles.device, pressed && styles.pressed]} onPress={onPress}>
    <View style={styles.deviceIcon}><Icon name={icon} size={21} color={colors.accent} /></View>
    <Text numberOfLines={1} style={styles.deviceName}>{name}</Text>
  </Pressable>;
}

export function LyricButton({ line, active, onPress }: LyricButtonProps) {
  const styles = useStyles();
  if (!onPress) return <Text style={[styles.lyric, styles.lyricButton, active && styles.lyricActive]}>{line}</Text>;
  return <Pressable accessibilityRole="button" accessibilityHint="Seek to this line"
    accessibilityState={{ selected: active }} onPress={onPress} style={({ pressed }) => [styles.lyricButton, pressed && styles.pressed]}>
    <Text style={[styles.lyric, active && styles.lyricActive]}>{line}</Text>
  </Pressable>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  icon: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.65 },
  grabberPress: { width: 105, height: 32, alignItems: 'center', justifyContent: 'center' },
  grabber: { width: 32, height: 4, borderRadius: 2, backgroundColor: colors.grabber },
  device: { height: 56, alignItems: 'center' },
  deviceIcon: { height: 38, justifyContent: 'center' },
  deviceName: { color: colors.accent, fontSize: 11, fontWeight: '600' },
  lyricButton: { paddingBottom: 21, maxWidth: 530 },
  lyric: { color: colors.quiet, fontWeight: '700', fontSize: 32, letterSpacing: -0.7 },
  lyricActive: { color: colors.text },
}));
