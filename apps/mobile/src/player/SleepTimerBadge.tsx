import { StyleSheet, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { secondaryFontScale } from '../fontScale';
import { useSleepTimer } from '../playback';
import { createThemedStyles, useColors } from '../theme';
import { Icon } from '../ui';

/**
 * Now Playing's sign of a sleep timer while one is set, beside the grabber as the offline
 * badge is: a moon and the time left, or what it waits for ("End of song").
 */
export function SleepTimerBadge({ style }: { style?: StyleProp<ViewStyle> }) {
  const colors = useColors();
  const styles = useStyles();
  const { label, spoken } = useSleepTimer();
  if (!label) return null;
  return <View style={[styles.badge, style]} accessibilityRole="text" accessibilityLabel={spoken ?? undefined}>
    <Icon name="moon.zzz.fill" size={13} color={colors.muted} />
    <Text maxFontSizeMultiplier={secondaryFontScale} style={styles.text}>{label}</Text>
  </View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  badge: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 4, minHeight: 28, borderRadius: 14, backgroundColor: colors.surface },
  text: { color: colors.muted, fontSize: 13, fontWeight: '600', fontVariant: ['tabular-nums'] },
}));
