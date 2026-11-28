import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import type { RowAction } from './BrowseControls';
import { useMenuSheet } from '../MenuSheet';
import { Icon } from '../ui';
import { createThemedStyles, useColors } from '../theme';
import { useBrowseBackLabel } from './links';

export type AlbumNavProps = {
  icon: string;
  label: string;
  onPress?: () => void;
  /** The button opens these as a menu, such as an album's ⋯, instead of running `onPress`. */
  menu?: readonly RowAction[];
  selected?: boolean;
  /** Shows activity in place of the icon, such as a download running. */
  busy?: boolean;
  /** The server refused what the button did: its icon takes the error color for a few seconds. */
  failed?: boolean;
};

/** The buttons under a collection's title. The first is the prominent one. */
export type AlbumPlaybackProps = {
  title: string;
  /**
   * `busy`: the action has started and is still loading; a spinner shows in place of its symbol.
   * `disabled`: there is nothing for it to do yet, so it stays in its place, faded, and ignores taps.
   * `failed`: the server refused what it did; its symbol and label say so in the error color.
   * `spoken`: what VoiceOver says, when the label alone (with the title after it) would not read well.
   */
  actions: readonly { label: string; symbol: string; onPress: () => void; busy?: boolean; disabled?: boolean; failed?: boolean; spoken?: string }[];
};

export function AlbumNavButton({ icon, label, onPress, menu, selected, busy, failed }: AlbumNavProps) {
  const colors = useColors();
  const styles = useStyles();
  const sheet = useMenuSheet();
  const open = menu ? () => sheet.open(label, menu) : onPress;
  return <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={selected === undefined ? { busy } : { selected, busy }}
    style={({ pressed }) => [styles.nav, pressed && styles.pressed]} onPress={open}>
    {busy ? <ActivityIndicator color={colors.text} /> : <Icon name={icon} size={20} color={failed ? colors.danger : selected ? colors.accent : colors.text} />}
    {sheet.sheet}
  </Pressable>;
}

export function BrowseBackButton({ onPress }: { onPress: () => void }) {
  const source = useBrowseBackLabel();
  const colors = useColors();
  const styles = useStyles();
  if (!source) return <AlbumNavButton icon="chevron.left" label="Go back" onPress={onPress} />;
  return <Pressable accessibilityRole="button" accessibilityLabel={`Back to ${source}`} onPress={onPress}
    style={({ pressed }) => [styles.nav, styles.back, pressed && styles.pressed]}>
    <Icon name="chevron.left" size={16} color={colors.text} />
    <Text numberOfLines={1} maxFontSizeMultiplier={1.3} style={styles.backText}>{source}</Text>
  </Pressable>;
}

export function AlbumPlaybackButtons({ title, actions }: AlbumPlaybackProps) {
  const colors = useColors();
  const styles = useStyles();
  return <View style={styles.controls}>
    {actions.map(({ label, symbol, onPress, busy, disabled, failed, spoken }, index) => {
      const prominent = index === 0 && !failed;
      const color = failed ? colors.danger : prominent ? colors.onAccent : colors.text;
      return <Pressable key={index} accessibilityRole="button" accessibilityLabel={spoken ?? `${label} ${title}`} accessibilityState={{ busy, disabled }} disabled={disabled}
        style={({ pressed }) => [styles.action, prominent && styles.play, disabled && styles.disabled, pressed && styles.pressed]} onPress={onPress}>
        {busy ? <ActivityIndicator color={color} /> : <Icon name={symbol} size={17} color={color} />}
        <Text style={[styles.label, { color }]}>{label}</Text>
      </Pressable>;
    })}
  </View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  nav: { width: 44, height: 44, borderRadius: 22, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  back: { width: 'auto', maxWidth: 112, flexDirection: 'row', gap: 4, paddingHorizontal: 10 },
  backText: { color: colors.text, fontSize: 14, fontWeight: '600', flexShrink: 1 },
  pressed: { opacity: 0.72 },
  disabled: { opacity: 0.45 },
  controls: { flexDirection: 'row', gap: 9, marginTop: 18, alignSelf: 'stretch' },
  action: { backgroundColor: colors.surface, borderRadius: 24, minHeight: 46, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9, flex: 1 },
  play: { backgroundColor: colors.accent },
  label: { fontSize: 15, fontWeight: '700' },
}));
