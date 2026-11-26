import { Image } from 'expo-image';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import type { ReactNode } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import type { Artwork } from '@squirmy/contracts';
import { useArtworkImage } from '../../data/artwork';
import { shade } from '../../data/color';
import { TvControl, tvColors } from '../ui';

export function PlayerCover({ artwork, size, large = false }: {
  artwork: Artwork | null | undefined;
  size: number;
  large?: boolean;
}) {
  const art = useArtworkImage(artwork, size);
  return (
    <View style={[
      large && styles.coverShadow,
      { width: size, height: size, borderRadius: large ? 22 : 9, backgroundColor: shade(artwork?.color, 0.32) },
    ]}>
      {art ? (
        <Image {...art} accessibilityIgnoresInvertColors accessible={false}
          contentFit="cover" recyclingKey={art.source.uri} transition={180}
          style={[StyleSheet.absoluteFill, { borderRadius: large ? 22 : 9 }]} />
      ) : (
        <View style={styles.coverPlaceholder}>
          <SymbolView name="music.note" size={large ? 80 : 23} tintColor={tvColors.muted} accessible={false} />
        </View>
      )}
    </View>
  );
}

export function PlayerIconButton({ icon, label, onPress, onFocus, disabled, primary, selected, preferred }: {
  icon: SymbolViewProps['name'];
  label: string;
  onPress: () => void;
  onFocus?: () => void;
  disabled?: boolean;
  primary?: boolean;
  selected?: boolean;
  preferred?: boolean;
}) {
  return (
    <TvControl
      accessibilityLabel={label}
      hasTVPreferredFocus={preferred}
      disabled={disabled}
      selected={selected}
      onPress={onPress}
      onFocus={onFocus}
      style={[styles.iconButton, primary && styles.primary, selected && styles.selected]}
      focusedStyle={styles.focused}
    >
      {focused => <SymbolView name={icon} size={primary ? 31 : 23} weight="semibold" accessible={false}
        tintColor={focused || primary ? tvColors.ink : selected ? tvColors.accent : tvColors.text} />}
    </TvControl>
  );
}

export function PlayerRow({ title, detail, leading, trailing, active, disabled, onPress }: {
  title: string;
  detail?: string;
  leading?: ReactNode;
  trailing?: (focused: boolean) => ReactNode;
  active?: boolean;
  disabled?: boolean;
  onPress: () => void;
}) {
  return (
    <TvControl
      accessibilityLabel={detail ? `${title}, ${detail}` : title}
      disabled={disabled}
      selected={active}
      onPress={onPress}
      style={[styles.row, active && styles.activeRow]}
      focusedStyle={styles.focusedRow}
    >
      {focused => <>
        {leading}
        <View style={styles.rowCopy}>
          <Text numberOfLines={1} style={[styles.rowTitle, active && styles.activeTitle, focused && styles.focusText]}>{title}</Text>
          {detail && <Text numberOfLines={1} style={[styles.rowDetail, focused && styles.focusText]}>{detail}</Text>}
        </View>
        {trailing?.(focused)}
      </>}
    </TvControl>
  );
}

const styles = StyleSheet.create({
  coverShadow: {
    boxShadow: '0 24px 62px #00000080',
    borderCurve: 'continuous',
  },
  coverPlaceholder: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  iconButton: {
    width: 68, height: 68, alignItems: 'center', justifyContent: 'center', borderRadius: 34,
    backgroundColor: '#FFFFFF12', borderWidth: 1, borderColor: '#FFFFFF20',
  },
  primary: { width: 86, height: 86, borderRadius: 43, backgroundColor: tvColors.accent, borderColor: tvColors.accent },
  selected: { borderColor: tvColors.accent, backgroundColor: '#CBC1FF13' },
  focused: { backgroundColor: tvColors.text, borderColor: tvColors.text, transform: [{ scale: 1.08 }] },
  row: {
    flex: 1, minWidth: 0, minHeight: 76, paddingHorizontal: 18, paddingVertical: 9, borderRadius: 15,
    flexDirection: 'row', gap: 15, alignItems: 'center',
  },
  activeRow: { backgroundColor: '#CBC1FF17' },
  focusedRow: { backgroundColor: tvColors.text },
  rowCopy: { flex: 1, minWidth: 0, gap: 3 },
  rowTitle: { fontSize: 25, color: tvColors.text, fontWeight: '600', letterSpacing: -0.25 },
  activeTitle: { color: tvColors.accent },
  rowDetail: { fontSize: 20, color: tvColors.muted },
  focusText: { color: tvColors.ink },
});
