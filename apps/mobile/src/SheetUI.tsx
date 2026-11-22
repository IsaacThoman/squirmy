import type { ReactNode } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { TrackSummary as Track } from '@squirmy/contracts';
import TransportSlider from './player/TransportSlider';
import { Cover, Icon } from './ui';
import { createThemedStyles, useColors } from './theme';

export type SheetFrameProps = { title: string; onClose: () => void; children?: ReactNode };
/** `destructive` colors the row for an action that ends something, such as signing out. */
export type SheetRowProps = {
  title: string; subtitle?: string; icon: string; color?: string;
  selected?: boolean; destructive?: boolean; onPress: () => void;
};
export type SheetInfoProps = { icon: string; title: string; subtitle: string };
export type TrackSummaryProps = { track: Track | undefined; subtitle?: string };
export type SheetSliderProps = { label: string; value: number; onChange: (value: number) => void };
export type SheetFieldProps = { label: string; value: string; onChange: (value: string) => void; onSubmit: () => void; autoFocus?: boolean };
export type SheetActionProps = { title: string; disabled?: boolean; onPress: () => void };
export type SheetScrollProps = { height: number; children: ReactNode };
export type SheetPickerRowProps<T extends string | number> = {
  label: string; value: T; options: readonly { value: T; label: string }[]; onChange: (value: T) => void;
};

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

/** A sheet's title and close button, fixed above content that scrolls beneath them. */
export function SheetFormHeader({ title, onClose }: SheetFrameProps) {
  const styles = useStyles();
  return <View style={[styles.sheetHeader, styles.formHeader]}>
    <Text accessibilityRole="header" style={styles.heading}>{title}</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Close" style={styles.close} onPress={onClose}>
      <Icon name="xmark" size={15} />
    </Pressable>
  </View>;
}

export function SheetRows({ children }: { children: ReactNode }) {
  const styles = useStyles();
  return <View style={styles.rows}>{children}</View>;
}

/** Rows that scroll inside a sheet of this height, for lists that would not fit. */
export function SheetScroll({ height, children }: SheetScrollProps) {
  const styles = useStyles();
  return <ScrollView style={{ maxHeight: height }} contentContainerStyle={styles.rows} keyboardShouldPersistTaps="handled">{children}</ScrollView>;
}

export function SheetRow({ title, subtitle, icon, color, selected, destructive, onPress }: SheetRowProps) {
  const colors = useColors();
  const styles = useStyles();
  const tone = destructive ? colors.danger : undefined;
  return (
    <Pressable accessibilityRole="button" accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.sheetRow, selected && styles.selectedRow, pressed && styles.pressed]}>
      <View style={[styles.rowIcon, selected && styles.selectedIcon]}><Icon name={icon} size={20} color={tone ?? color ?? colors.text} /></View>
      <View style={styles.flex}>
        <Text style={[styles.rowTitle, tone ? { color: tone } : null]}>{title}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
      </View>
      {selected && <Icon name="checkmark" size={17} color={colors.accent} />}
    </Pressable>
  );
}

/** Small print at the foot of a sheet, such as the app's version. */
export function SheetNote({ children }: { children: string }) {
  const styles = useStyles();
  return <Text style={styles.note}>{children}</Text>;
}

/** A row that picks one of a few values; the choices open in an action sheet. */
export function SheetPickerRow<T extends string | number>({ label, value, options, onChange }: SheetPickerRowProps<T>) {
  const current = options.find(option => option.value === value)?.label ?? '';
  return <SheetRow title={label} subtitle={current} icon="chevron.up.chevron.down" onPress={() => Alert.alert(label, undefined, [
    ...options.map(option => ({ text: option.label, onPress: () => onChange(option.value) })),
    { text: 'Cancel', style: 'cancel' as const },
  ])} />;
}

export function TrackSummary({ track, subtitle }: TrackSummaryProps) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.trackSummary}>
      <Cover artwork={track?.album?.artwork} size={53} radius={10} />
      <View style={styles.flex}>
        <Text numberOfLines={1} style={styles.rowTitle}>{track?.title ?? 'Not Playing'}</Text>
        <Text numberOfLines={1} style={styles.rowSubtitle}>{subtitle ?? track?.artistCredit ?? ''}</Text>
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

export function SheetSlider({ label, value, onChange }: SheetSliderProps) {
  const colors = useColors();
  const styles = useStyles();
  return (
    <View style={styles.slider}>
      <Text style={styles.rowSubtitle}>{label}</Text>
      <View style={styles.sliderRow}>
        <Icon name="speaker.fill" size={13} color={colors.muted} />
        <View style={styles.flex}><TransportSlider label={label} value={value} maximum={1} accessibilityStep={0.1} onChange={onChange} /></View>
        <Icon name="speaker.wave.3.fill" size={15} color={colors.muted} />
      </View>
    </View>
  );
}

export function SheetField({ label, value, onChange, onSubmit, autoFocus }: SheetFieldProps) {
  const colors = useColors();
  const styles = useStyles();
  return <TextInput value={value} onChangeText={onChange} placeholder={label} accessibilityLabel={label} placeholderTextColor={colors.muted}
    autoFocus={autoFocus} returnKeyType="done" onSubmitEditing={onSubmit} style={styles.field} />;
}

/** The sheet's one prominent button. */
export function SheetAction({ title, disabled, onPress }: SheetActionProps) {
  const styles = useStyles();
  return <Pressable accessibilityRole="button" accessibilityState={{ disabled }} disabled={disabled} onPress={onPress}
    style={({ pressed }) => [styles.action, disabled && styles.disabled, pressed && styles.pressed]}>
    <Text style={styles.actionTitle}>{title}</Text>
  </Pressable>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  sheet: { paddingTop: 27, paddingHorizontal: 22, gap: 15 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36 },
  formHeader: { paddingTop: 27, paddingHorizontal: 22, paddingBottom: 8 },
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
  note: { color: colors.muted, fontSize: 12, textAlign: 'center' },
  slider: { gap: 4, paddingHorizontal: 4 },
  sliderRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  field: { minHeight: 48, borderRadius: 14, paddingHorizontal: 14, backgroundColor: colors.surface, color: colors.text, fontSize: 16 },
  action: { minHeight: 48, borderRadius: 24, backgroundColor: colors.accent, alignItems: 'center', justifyContent: 'center' },
  actionTitle: { color: colors.onAccent, fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.45 },
}));
