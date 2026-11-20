import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { albums, tracks } from './catalog';
import { Cover, Icon } from './ui';
import { createThemedStyles, useColors } from './theme';

export type SheetFrameProps = { title: string; onClose: () => void; children?: ReactNode };
export type SheetRowProps = {
  title: string; subtitle?: string; icon: string; color?: string;
  selected?: boolean; onPress: () => void;
};
export type SheetInfoProps = { icon: string; title: string; subtitle: string };

export function SheetFrame({ title, onClose, children }: SheetFrameProps) {
  const styles = useStyles();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.sheet, { paddingBottom: Math.max(23, insets.bottom + 8) }]}>
      <View style={styles.sheetHeader}>
        <Text accessibilityRole="header" style={styles.heading}>{title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" style={styles.close}
          onPress={onClose}>
          <Icon name="xmark" size={15} />
        </Pressable>
      </View>
      {children}
    </View>
  );
}

export function SheetRows({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <View style={styles.rows}>{children}</View>;
}

export function SheetRow({ title, subtitle, icon, color, selected, onPress }: SheetRowProps) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <Pressable accessibilityRole="button" accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.sheetRow, selected && styles.selectedRow, pressed && styles.pressed]}>
      <View style={[styles.rowIcon, selected && styles.selectedIcon]}><Icon name={icon} size={20} color={color ?? colors.text} /></View>
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{title}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
      </View>
      {selected && <Icon name="checkmark" size={17} color={colors.accent} />}
    </Pressable>
  );
}

export function TrackSummary({ id }: { id: string }) {
  const colors = useColors();
  const styles = useStyles();
  const item = tracks[id];
  return (
    <View style={styles.trackSummary}>
      <Cover source={albums[item.albumId].artwork} size={53} radius={10} />
      <View style={styles.flex}>
        <Text numberOfLines={1} style={styles.rowTitle}>{item.title}</Text>
        <Text numberOfLines={1} style={styles.rowSubtitle}>{item.artist}</Text>
      </View>
      <Icon name="waveform" size={22} color={colors.accent} />
    </View>
  );
}

export function SheetInfo({ icon, title, subtitle }: SheetInfoProps) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.trackSummary}>
      <View style={[styles.rowIcon, styles.selectedIcon]}><Icon name={icon} size={20} color={colors.accent} /></View>
      <View style={styles.flex}>
        <Text numberOfLines={1} style={styles.rowTitle}>{title}</Text>
        <Text numberOfLines={1} style={styles.rowSubtitle}>{subtitle}</Text>
      </View>
    </View>
  );
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  sheet: { paddingTop: 27, paddingHorizontal: 22, gap: 15 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36 },
  heading: { color: colors.text, fontSize: 25, fontWeight: '700', letterSpacing: -0.7, flexShrink: 1 },
  close: { width: 37, height: 37, borderRadius: 19, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, gap: 3 },
  trackSummary: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 4, paddingVertical: 3 },
  rows: { gap: 6 },
  sheetRow: { minHeight: 54, flexDirection: 'row', gap: 11, alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: colors.overlay },
  selectedRow: { backgroundColor: colors.selection },
  pressed: { opacity: 0.73 },
  rowIcon: { width: 33, height: 33, borderRadius: 11, backgroundColor: colors.overlay, justifyContent: 'center', alignItems: 'center' },
  selectedIcon: { backgroundColor: colors.selection },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowSubtitle: { color: colors.muted, fontSize: 13, fontWeight: '500' },
}));
