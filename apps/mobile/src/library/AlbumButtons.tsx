import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../ui';
import { createThemedStyles, useColors } from '../theme';

export type AlbumNavProps = {
  icon: string;
  label: string;
  onPress: () => void;
  selected?: boolean;
  /** Shows activity in place of the icon, such as a download running. */
  busy?: boolean;
};

/** The buttons under a collection's title. The first is the prominent one. */
export type AlbumPlaybackProps = {
  title: string;
  /** `busy`: the action has started and is still loading; a spinner shows in place of its symbol. */
  actions: readonly { label: string; symbol: string; onPress: () => void; busy?: boolean }[];
};

export function AlbumNavButton({ icon, label, onPress, selected, busy }: AlbumNavProps) {
  const colors = useColors();
  const styles = useStyles();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={selected === undefined ? { busy } : { selected, busy }}
    style={({ pressed }) => [styles.nav, pressed && styles.pressed]} onPress={onPress}>
    {busy ? <ActivityIndicator color={colors.text} /> : <Icon name={icon} size={20} color={selected ? colors.accent : colors.text} />}
  </Pressable>;
}

export function AlbumPlaybackButtons({ title, actions }: AlbumPlaybackProps) {
  const colors = useColors();
  const styles = useStyles();
  return <View style={styles.controls}>
    {actions.map(({ label, symbol, onPress, busy }, index) => (
      <Pressable key={label} accessibilityRole="button" accessibilityLabel={`${label} ${title}`} accessibilityState={{ busy }}
        style={({ pressed }) => [styles.action, index === 0 && styles.play, pressed && styles.pressed]} onPress={onPress}>
        {busy
          ? <ActivityIndicator color={index === 0 ? colors.onAccent : colors.text} />
          : <Icon name={symbol} size={17} color={index === 0 ? colors.onAccent : colors.text} />}
        <Text style={[styles.label, index === 0 && styles.playLabel]}>{label}</Text>
      </Pressable>
    ))}
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
