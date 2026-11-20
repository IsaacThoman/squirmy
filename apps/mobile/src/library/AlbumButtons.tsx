import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../ui';
import { createThemedStyles, useColors } from '../theme';

export type AlbumNavProps = {
  icon: 'chevron.left' | 'square.and.arrow.up';
  label: string;
  onPress: () => void;
};

export type AlbumPlaybackProps = {
  title: string;
  onPlay: () => void;
  onShuffle: () => void;
};

export function AlbumNavButton({ icon, label, onPress }: AlbumNavProps) {
  const styles = useStyles();
  return <Pressable accessibilityRole="button" accessibilityLabel={label}
    style={({ pressed }) => [styles.nav, pressed && styles.pressed]} onPress={onPress}>
    <Icon name={icon} size={20} />
  </Pressable>;
}

export function AlbumPlaybackButtons({ title, onPlay, onShuffle }: AlbumPlaybackProps) {
  const colors = useColors();
  const styles = useStyles();
  return <View style={styles.controls}>
    <Pressable accessibilityRole="button" accessibilityLabel={`Play ${title}`}
      style={({ pressed }) => [styles.action, styles.play, pressed && styles.pressed]} onPress={onPlay}>
      <Icon name="play.fill" size={16} color={colors.onAccent} />
      <Text style={[styles.label, styles.playLabel]}>Play</Text>
    </Pressable>
    <Pressable accessibilityRole="button" accessibilityLabel={`Shuffle ${title}`}
      style={({ pressed }) => [styles.action, pressed && styles.pressed]} onPress={onShuffle}>
      <Icon name="shuffle" size={18} />
      <Text style={styles.label}>Shuffle</Text>
    </Pressable>
  </View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  nav: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.72 },
  controls: { flexDirection: 'row', gap: 9, marginTop: 18, alignSelf: 'stretch' },
  action: { backgroundColor: colors.surface, borderRadius: 24, minHeight: 46, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9, flex: 1 },
  play: { backgroundColor: colors.accent },
  label: { color: colors.text, fontSize: 15, fontWeight: '700' },
  playLabel: { color: colors.onAccent },
}));
