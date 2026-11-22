import { Button, Divider, Host, HStack, Menu, RNHostView, ScrollView, Slider, Spacer, Text, TextField, VStack, useNativeState } from '@expo/ui/swift-ui';
import { useState } from 'react';
import { useWindowDimensions, View } from 'react-native';
import { SystemVolumeSlider } from '../modules/now-playing';
import {
  accessibilityAddTraits, accessibilityLabel, background, clipShape, disabled as disabledModifier, font, foregroundStyle,
  frame, lineLimit, menuIndicator, multilineTextAlignment, onGeometryChange, onSubmit as onSubmitModifier, opacity, padding, submitLabel, tint,
} from '@expo/ui/swift-ui/modifiers';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { IconButton, Symbol, TrackCover, hitShape, plainButton } from './native/Controls';
import type {
  SheetActionProps, SheetFieldProps, SheetFrameProps, SheetPickerRowProps, SheetScrollProps, SheetInfoProps, SheetRowProps, SheetSliderProps,
  TrackSummaryProps,
} from './SheetUI';
import { isAccessibilitySize } from './fontScale';
import { useColors } from './theme';

const sheetTop = 22;
const sheetSpacing = 14;
/** Room the system keeps between the tallest sheet and the status bar. */
const sheetTopGap = 10;

/**
 * A sheet sized to its content. Content taller than the screen, as at the largest text sizes,
 * scrolls under the title: a sheet that fits its content stops growing at the top of the
 * screen and would otherwise cut off its last rows, such as Sign out.
 */
export function SheetFrame({ title, onClose, children }: SheetFrameProps) {
  const colors = useColors();
  const { top, bottom } = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const [header, setHeader] = useState(0);
  const [content, setContent] = useState(0);
  const bottomPadding = Math.max(23, bottom + 8);
  const room = height - top - sheetTopGap - sheetTop - header - sheetSpacing - bottomPadding;
  const scrolls = header > 0 && content > room;
  // Measured in both layouts, so the sheet stops scrolling again when its content shrinks.
  const body = <VStack alignment="leading" spacing={sheetSpacing} modifiers={[onGeometryChange(frame => setContent(frame.height))]}>
    {children}
  </VStack>;
  return <Host matchContents={{ vertical: true }}>
    <VStack alignment="leading" spacing={sheetSpacing} modifiers={[padding({ top: sheetTop, horizontal: 22, bottom: bottomPadding })]}>
      <HStack spacing={8} modifiers={[onGeometryChange(frame => setHeader(frame.height))]}>
        <Text modifiers={[font({ textStyle: 'title2', weight: 'bold' }), accessibilityAddTraits(['isHeader'])]}>{title}</Text>
        <Spacer minLength={0} />
        <IconButton symbol="xmark.circle.fill" label="Close" size={26} color={colors.muted} onPress={onClose} />
      </HStack>
      {scrolls ? <ScrollView modifiers={[frame({ height: room })]}>{body}</ScrollView> : body}
    </VStack>
  </Host>;
}

/** A sheet's title and close button, fixed above a form that scrolls beneath them. */
export function SheetFormHeader({ title, onClose }: SheetFrameProps) {
  const colors = useColors();
  return <HStack spacing={8} modifiers={[padding({ top: 22, horizontal: 22, bottom: 6 })]}>
    <Text modifiers={[font({ textStyle: 'title2', weight: 'bold' }), accessibilityAddTraits(['isHeader'])]}>{title}</Text>
    <Spacer minLength={0} />
    <IconButton symbol="xmark.circle.fill" label="Close" size={26} color={colors.muted} onPress={onClose} />
  </HStack>;
}

export function SheetRows({ children }: { children: React.ReactNode }) {
  return <VStack alignment="leading" spacing={0}>{children}</VStack>;
}

/** Rows that scroll inside a sheet of this height, for lists that would not fit. */
export function SheetScroll({ height, children }: SheetScrollProps) {
  return <ScrollView modifiers={[frame({ height })]}>
    <VStack alignment="leading" spacing={0}>{children}</VStack>
  </ScrollView>;
}

export function SheetRow({ title, subtitle, icon, selected, destructive, onPress }: SheetRowProps) {
  const colors = useColors();
  const iconColor = destructive ? colors.danger : selected ? colors.accent : colors.muted;
  return <>
    <Button onPress={onPress} modifiers={[
      plainButton, accessibilityLabel(subtitle ? `${title}, ${subtitle}` : title),
      ...(selected ? [accessibilityAddTraits(['isSelected'])] : []),
    ]}>
      <HStack spacing={12} modifiers={[frame({ minHeight: 49 }), hitShape]}>
        <HStack modifiers={[frame({ width: 27 })]}>
          <Symbol name={icon} size={18} color={iconColor} />
        </HStack>
        <VStack alignment="leading" spacing={2}>
          <Text modifiers={[font({ textStyle: 'body', weight: 'medium' }), ...(destructive ? [foregroundStyle(colors.danger)] : [])]}>{title}</Text>
          {subtitle && <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.muted)]}>{subtitle}</Text>}
        </VStack>
        <Spacer minLength={4} />
        {selected && <Symbol name="checkmark" size={15} color={colors.accent} />}
      </HStack>
    </Button>
    <Divider modifiers={[padding({ leading: 39 })]} />
  </>;
}

/** Small print at the foot of a sheet, such as the app's version. */
export function SheetNote({ children }: { children: string }) {
  const colors = useColors();
  return <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(colors.muted), frame({ maxWidth: Infinity }),
    multilineTextAlignment('center')]}>{children}</Text>;
}

/**
 * A form row that picks one of a few values from a menu. SwiftUI's own menu picker tints
 * its value only once it has been changed, so the value here is drawn by hand.
 */
export function SheetPickerRow<T extends string | number>({ label, value, options, onChange }: SheetPickerRowProps<T>) {
  const colors = useColors();
  const { fontScale } = useWindowDimensions();
  const current = options.find(option => option.value === value)?.label ?? '';
  // At accessibility sizes the label and the value do not fit side by side, so the value goes under the label.
  const stacked = isAccessibilitySize(fontScale);
  const choice = <HStack spacing={5}>
    <Text modifiers={[foregroundStyle(colors.muted), ...(stacked ? [] : [lineLimit(1)])]}>{current}</Text>
    <Symbol name="chevron.up.chevron.down" size={12} color={colors.muted} />
  </HStack>;
  // The whole row opens the menu, as a native picker's does.
  return <Menu modifiers={[plainButton, menuIndicator('hidden'), accessibilityLabel(`${label}, ${current}`)]}
    label={stacked
      ? <VStack alignment="leading" spacing={4} modifiers={[frame({ maxWidth: Infinity, minHeight: 44, alignment: 'leading' }), hitShape]}>
        <Text modifiers={[foregroundStyle(colors.text)]}>{label}</Text>
        {choice}
      </VStack>
      : <HStack spacing={5} modifiers={[frame({ maxWidth: Infinity, minHeight: 32 }), hitShape]}>
        <Text modifiers={[foregroundStyle(colors.text)]}>{label}</Text>
        <Spacer minLength={8} />
        {choice}
      </HStack>}>
    {options.map(option => <Button key={String(option.value)} label={option.label}
      systemImage={option.value === value ? 'checkmark' : undefined} onPress={() => onChange(option.value)} />)}
  </Menu>;
}

/**
 * One line for a summary's title and subtitle, except at accessibility sizes: there one line
 * holds a word or two, and the sheet scrolls, so they wrap instead.
 */
function useSummaryLines() {
  const { fontScale } = useWindowDimensions();
  return isAccessibilitySize(fontScale) ? [] : [lineLimit(1)];
}

export function TrackSummary({ track, subtitle }: TrackSummaryProps) {
  const colors = useColors();
  const lines = useSummaryLines();
  return <HStack spacing={12} modifiers={[padding({ bottom: 4 })]}>
    <TrackCover track={track} size={53} radius={9} />
    <VStack alignment="leading" spacing={3}>
      <Text modifiers={[font({ textStyle: 'headline' }), ...lines]}>{track?.title ?? 'Not Playing'}</Text>
      <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.muted), ...lines]}>{subtitle ?? track?.artistCredit ?? ''}</Text>
    </VStack>
    <Spacer minLength={0} />
  </HStack>;
}

export function SheetInfo({ icon, title, subtitle }: SheetInfoProps) {
  const colors = useColors();
  const lines = useSummaryLines();
  return <HStack spacing={12} modifiers={[padding({ vertical: 4 })]}>
    <HStack modifiers={[frame({ width: 27 })]}><Symbol name={icon} size={22} color={colors.accent} /></HStack>
    <VStack alignment="leading" spacing={2}>
      <Text modifiers={[font({ textStyle: 'headline' }), ...lines]}>{title}</Text>
      <Text modifiers={[font({ textStyle: 'footnote' }), foregroundStyle(colors.muted), ...lines]}>{subtitle}</Text>
    </VStack>
    <Spacer minLength={0} />
  </HStack>;
}

export function SheetSlider({ label, value, onChange }: SheetSliderProps) {
  const colors = useColors();
  return <VStack alignment="leading" spacing={6} modifiers={[padding({ top: 6 })]}>
    <Text modifiers={[font({ textStyle: 'footnote', weight: 'semibold' }), foregroundStyle(colors.muted)]}>{label}</Text>
    <HStack spacing={10}>
      <Symbol name="speaker.fill" size={13} color={colors.muted} />
      <Slider value={value} min={0} max={1} onValueChange={onChange} modifiers={[tint(colors.accent), accessibilityLabel(label)]} />
      <Symbol name="speaker.wave.3.fill" size={15} color={colors.muted} />
    </HStack>
  </VStack>;
}

/** This phone's volume, which is the system's: the system slider, which the side buttons move too. */
export function SheetSystemVolume({ label }: { label: string }) {
  const colors = useColors();
  const { width } = useWindowDimensions();
  if (!SystemVolumeSlider) return null;
  return <VStack alignment="leading" spacing={6} modifiers={[padding({ top: 6 })]}>
    <Text modifiers={[font({ textStyle: 'footnote', weight: 'semibold' }), foregroundStyle(colors.muted)]}>{label}</Text>
    <RNHostView matchContents>
      <View style={{ width: width - 44, height: 34 }}>
        <SystemVolumeSlider tint={colors.accent} trackTint={colors.stroke} style={{ flex: 1 }} />
      </View>
    </RNHostView>
  </VStack>;
}

export function SheetField({ label, value, onChange, onSubmit, autoFocus, maxLength }: SheetFieldProps) {
  const colors = useColors();
  const text = useNativeState(value);
  return <TextField text={text} onTextChange={onChange} placeholder={label} autoFocus={autoFocus} maxLength={maxLength}
    modifiers={[accessibilityLabel(label), submitLabel('done'), onSubmitModifier(onSubmit), font({ textStyle: 'body' }),
      padding({ horizontal: 14 }), frame({ maxWidth: Infinity, minHeight: 48 }), background(colors.surface), clipShape('roundedRectangle', 14)]} />;
}

/** The sheet's one prominent button. */
export function SheetAction({ title, disabled, onPress }: SheetActionProps) {
  const colors = useColors();
  return <Button onPress={onPress} modifiers={[plainButton, disabledModifier(disabled), accessibilityLabel(title)]}>
    <Text modifiers={[font({ size: 15, weight: 'bold' }), foregroundStyle(colors.onAccent), frame({ maxWidth: Infinity, minHeight: 48 }),
      background(colors.accent), clipShape('capsule'), hitShape, ...(disabled ? [opacity(0.45)] : [])]}>{title}</Text>
  </Button>;
}
