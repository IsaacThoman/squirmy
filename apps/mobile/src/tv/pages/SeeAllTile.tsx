import { StyleSheet, Text, View } from 'react-native';
import { Icon } from '../../ui';
import { Focusable } from '../Focusable';
import { colors, tv, type } from '../theme';

/** The end of a shelf that shows only part of a list: it opens the rest on a page of its own. */
export function SeeAllTile({ size, height = size, onPress, label = 'See all' }: { size: number; height?: number; onPress: () => void; label?: string }) {
  return <Focusable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} scale={1.06} style={{ width: size }}>
    {({ focused }) => <>
      <View style={[styles.tile, { width: size, height }, focused && styles.focused]}>
        <Icon name="chevron.right" size={Math.round(Math.min(size, height) * 0.22)} color={focused ? colors.onFocused : colors.text} />
      </View>
      <Text style={styles.label}>{label}</Text>
    </>}
  </Focusable>;
}

const styles = StyleSheet.create({
  tile: { borderRadius: tv.radius, backgroundColor: colors.platter, alignItems: 'center', justifyContent: 'center' },
  focused: { backgroundColor: colors.focused },
  label: { ...type.body, marginTop: 18 },
});
