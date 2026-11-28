import { audioQualityLabel, signalQuality } from '@squirmy/client-core';
import type { SignalPath } from '@squirmy/contracts';
import { Pressable, StyleSheet, Text } from 'react-native';
import { secondaryFontScale } from '../fontScale';
import { createThemedStyles, useColors } from '../theme';
import { Icon } from '../ui';
import { selectionFeedback } from './design';

/**
 * "Lossless" or "Hi-Res Lossless" between the scrubber's times, as Apple Music badges what it
 * plays, in the times' own quiet colour; nothing for a lossy stream, the ordinary case. It is
 * about what reaches the device playing, so a lossless file played as a transcode has none.
 * A tap opens Track info.
 */
export function QualityBadge({ signal, onPress }: { signal: SignalPath | null; onPress: () => void }) {
  const colors = useColors();
  const styles = useStyles();
  const quality = signalQuality(signal);
  if (!quality) return null;
  const label = audioQualityLabel(quality);
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityHint="Shows track info" hitSlop={10}
    onPress={() => { selectionFeedback(); onPress(); }}
    style={({ pressed }) => [styles.badge, pressed && styles.pressed]}>
    <Icon name="waveform" size={10} color={colors.quiet} />
    <Text maxFontSizeMultiplier={secondaryFontScale} style={styles.label}>{label}</Text>
  </Pressable>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  badge: {
    flexDirection: 'row', alignItems: 'center', gap: 3, paddingHorizontal: 5, paddingVertical: 1.5,
    borderRadius: 4, borderWidth: StyleSheet.hairlineWidth * 2, borderColor: colors.quiet,
  },
  pressed: { opacity: 0.6 },
  label: { color: colors.quiet, fontSize: 10, fontWeight: '700', letterSpacing: 0.2 },
}));
