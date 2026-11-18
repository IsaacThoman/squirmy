import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { albums, tracks } from './catalog';
import { Cover, Icon, colors } from './ui';

export type SheetFrameProps = { title: string; onClose: () => void; children?: ReactNode };
export type SheetRowProps = {
  title: string; subtitle?: string; icon: string; color?: string;
  selected?: boolean; onPress: () => void; trailing?: string;
};
export type SheetTransportProps = {
  position: string; device: string; playing: boolean; onPrevious: () => void; onPlayPause: () => void; onNext: () => void;
};

export function SheetFrame({ title, onClose, children }: SheetFrameProps) {
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
  return <View style={styles.rows}>{children}</View>;
}

export function SheetRow({ title, subtitle, icon, color = colors.text, selected, onPress, trailing }: SheetRowProps) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.sheetRow, selected && styles.selectedRow, pressed && styles.pressed]}>
      <View style={[styles.rowIcon, selected && styles.selectedIcon]}><Icon name={icon} size={20} color={color} /></View>
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{title}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
      </View>
      {(selected || trailing) && <Icon name={selected ? 'checkmark' : trailing!} size={17} color={selected ? colors.accent : colors.muted} />}
    </Pressable>
  );
}

export function TrackSummary({ id }: { id: string }) {
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

export function SheetTransport({ position, device, playing, onPrevious, onPlayPause, onNext }: SheetTransportProps) {
  return <>
    <View style={styles.remoteStatus}>
      <Text style={styles.rowSubtitle}>{position}</Text>
      <Text style={styles.rowSubtitle}>{device}</Text>
    </View>
    <View style={styles.remoteControls}>
      <Pressable accessibilityRole="button" accessibilityLabel="Previous track" style={styles.control} onPress={onPrevious}>
        <Icon name="backward.fill" size={25} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={playing ? 'Pause' : 'Play'}
        style={[styles.control, styles.primaryControl]} onPress={onPlayPause}>
        <Icon name={playing ? 'pause.fill' : 'play.fill'} size={26} color="#1a1424" />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Next track" style={styles.control} onPress={onNext}>
        <Icon name="forward.fill" size={25} />
      </Pressable>
    </View>
  </>;
}

const styles = StyleSheet.create({
  sheet: { paddingTop: 27, paddingHorizontal: 22, gap: 15 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36 },
  heading: { color: colors.text, fontSize: 25, fontWeight: '700', letterSpacing: -0.7, flexShrink: 1 },
  close: { width: 37, height: 37, borderRadius: 19, backgroundColor: '#ffffff17', alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, gap: 3 },
  trackSummary: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 4, paddingVertical: 3 },
  rows: { gap: 6 },
  sheetRow: { minHeight: 54, flexDirection: 'row', gap: 11, alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: '#ffffff0c' },
  selectedRow: { backgroundColor: '#cbc1ff25' },
  pressed: { opacity: 0.73 },
  rowIcon: { width: 33, height: 33, borderRadius: 11, backgroundColor: '#ffffff0d', justifyContent: 'center', alignItems: 'center' },
  selectedIcon: { backgroundColor: '#cbc1ff23' },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowSubtitle: { color: colors.muted, fontSize: 13, fontWeight: '500' },
  remoteStatus: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4, gap: 10 },
  remoteControls: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 28, paddingVertical: 8 },
  control: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  primaryControl: { width: 62, height: 62, borderRadius: 31, backgroundColor: colors.accent },
});
