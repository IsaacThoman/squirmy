import { Fragment, useImperativeHandle, useRef } from 'react';
import {
  Button, Divider, Grid, Host, HStack, Menu, Picker, ProgressView, RNHostView, Spacer, Text, TextField, VStack, ZStack, useNativeState,
  type TextFieldRef,
} from '@expo/ui/swift-ui';
import {
  accessibilityLabel, autocorrectionDisabled, background, buttonBorderShape, buttonStyle, clipShape,
  font, foregroundStyle, frame, lineLimit, menuIndicator, offset, padding, pickerStyle,
  opacity, progressViewStyle, rotationEffect, submitLabel, tag, textInputAutocapitalization, tint,
} from '@expo/ui/swift-ui/modifiers';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { StyleSheet, View } from 'react-native';
import { IconButton, Symbol, hitShape, plainButton } from '../native/Controls';
import type {
  BrowseButtonProps, CollectionButtonProps, CollectionGridRowProps, FilterProps, GenreCardProps, GenreGridProps, HeroActionsProps,
  LinkedButtonProps, SearchFieldProps, TopResultProps,
} from './BrowseControls';
import { unavailableOpacity, useColors } from '../theme';
import { ZoomLink, ZoomSource } from './ZoomLink';

const footnote = font({ textStyle: 'footnote' });
const labelFont = font({ textStyle: 'subheadline', weight: 'semibold' });
const iconGlass = [buttonStyle('glass'), buttonBorderShape('circle')] as const;

export function SearchField({ value, onChange, placeholder, autoFocus, inputRef }: SearchFieldProps) {
  const colors = useColors();
  const nativeRef = useRef<TextFieldRef>(null);
  const fieldText = useNativeState(value);
  const setText = (text: string) => {
    fieldText.value = text;
    onChange(text);
  };
  useImperativeHandle(inputRef, () => ({
    focus: () => { void nativeRef.current?.focus(); },
    blur: () => { void nativeRef.current?.blur(); },
    setText,
  }), [fieldText, onChange]);

  return <Host style={styles.search}>
    <HStack spacing={9} modifiers={[
      padding({ horizontal: 12 }), frame({ height: 46 }), background(colors.surface), clipShape('roundedRectangle', 12),
    ]}>
      <Symbol name="magnifyingglass" size={17} color={colors.muted} />
      <TextField ref={nativeRef} text={fieldText} onTextChange={onChange} placeholder={placeholder} autoFocus={autoFocus}
        modifiers={[accessibilityLabel(placeholder), autocorrectionDisabled(), textInputAutocapitalization('never'),
          submitLabel('search'), font({ textStyle: 'body' }), frame({ maxWidth: Infinity })]} />
      {!!value.length && <IconButton label="Clear search" symbol="xmark.circle.fill" size={17} width={32} height={44}
        color={colors.muted} onPress={() => setText('')} />}
    </HStack>
  </Host>;
}

/** A chevron that leads somewhere ("See all ›") follows its title, as the system's disclosure does. */
function trailingIcon(icon: string, title: string | undefined) {
  return Boolean(title) && icon === 'chevron.right';
}

export function BrowseButton({ label, icon, title, glass, onPress }: BrowseButtonProps) {
  const colors = useColors();
  const useGlass = glass && isLiquidGlassAvailable();
  return <Host matchContents>
    <Button modifiers={[...(useGlass ? iconGlass : [plainButton]), accessibilityLabel(label)]} onPress={onPress}>
      <HStack spacing={6} modifiers={[frame({ minWidth: useGlass ? 30 : 44, minHeight: useGlass ? 30 : 44 }), hitShape]}>
        {icon && !trailingIcon(icon, title) && <Symbol name={icon} size={title ? 14 : 19} color={title ? colors.accent : colors.text} />}
        {title && <Text modifiers={[labelFont, foregroundStyle(colors.accent)]}>{title}</Text>}
        {icon && trailingIcon(icon, title) && <Symbol name={icon} size={14} color={colors.accent} />}
      </HStack>
    </Button>
  </Host>;
}

export function LibraryFilters<T extends string>({ options, value, onChange }: FilterProps<T>) {
  return <Host style={styles.filters}>
    <Picker label="Collections" selection={value} onSelectionChange={onChange} modifiers={[pickerStyle('segmented')]}>
      {options.map(option => <Text key={option} modifiers={[tag(option)]}>{option}</Text>)}
    </Picker>
  </Host>;
}

export function LibrarySort<T extends string>({ options, value, onChange }: FilterProps<T>) {
  const colors = useColors();
  return <Host matchContents>
    <Menu modifiers={[plainButton, menuIndicator('hidden'), accessibilityLabel(`Sort library, ${value}`)]}
      label={<HStack spacing={6} modifiers={[frame({ minHeight: 44 }), hitShape]}>
        <Symbol name="arrow.up.arrow.down" size={14} color={colors.muted} />
        <Text modifiers={[labelFont, foregroundStyle(colors.muted)]}>{value}</Text>
      </HStack>}>
      {options.map(option => <Button key={option} label={option} systemImage={option === value ? 'checkmark' : undefined}
        onPress={() => onChange(option)} />)}
    </Menu>
  </Host>;
}

/** A React Native cover inside SwiftUI. With `zoom`, the linked page grows out of it. */
function HostedCover({ cover, size, zoom }: { cover: React.ReactElement; size: number; zoom?: boolean }) {
  const frame = { width: size, height: size };
  return <RNHostView matchContents>
    {zoom ? <ZoomSource style={frame}>{cover}</ZoomSource> : <View style={frame}>{cover}</View>}
  </RNHostView>;
}

export function CollectionTile(props: CollectionButtonProps) {
  return <Host matchContents={{ vertical: true }} style={{ width: props.size }}>
    <CollectionTileButton {...props} />
  </Host>;
}

export function CollectionGridRow({ items }: CollectionGridRowProps) {
  return <View style={styles.gridRow}>
    {items.map(({ id, ...item }) => <CollectionTile key={id} {...item} />)}
  </View>;
}

function CollectionTileButton({ href, ...props }: CollectionButtonProps) {
  return <ZoomLink href={href}><TileButton {...props} /></ZoomLink>;
}

function TileButton({ title, subtitle, cover, size, dim, onPress }: LinkedButtonProps<CollectionButtonProps>) {
  const colors = useColors();
  return <Button modifiers={[plainButton, accessibilityLabel(`${title}, ${subtitle}`)]} onPress={onPress}>
    <VStack alignment="leading" spacing={6} modifiers={[frame({ width: size, alignment: 'leading' }), hitShape, ...(dim ? [opacity(unavailableOpacity)] : [])]}>
      <HostedCover cover={cover} size={size} zoom />
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[labelFont, lineLimit(1)]}>{title}</Text>
        <Text modifiers={[footnote, foregroundStyle(colors.muted), lineLimit(1)]}>{subtitle}</Text>
      </VStack>
    </VStack>
  </Button>;
}

export function CollectionRow({ href, ...props }: CollectionButtonProps) {
  return <Host matchContents={{ vertical: true }}>
    <ZoomLink href={href}><RowButton {...props} /></ZoomLink>
  </Host>;
}

function RowButton({ title, subtitle, cover, size, dim, onPress }: LinkedButtonProps<CollectionButtonProps>) {
  const colors = useColors();
  return <VStack spacing={0}>
    <Button modifiers={[plainButton, accessibilityLabel(`${title}, ${subtitle}`)]} onPress={onPress}>
      <HStack spacing={12} modifiers={[padding({ vertical: 7 }), hitShape, ...(dim ? [opacity(unavailableOpacity)] : [])]}>
        <HostedCover cover={cover} size={size} zoom />
        <VStack alignment="leading" spacing={3}>
          <Text modifiers={[labelFont, lineLimit(1)]}>{title}</Text>
          <Text modifiers={[footnote, foregroundStyle(colors.muted), lineLimit(1)]}>{subtitle}</Text>
        </VStack>
        <Spacer minLength={4} />
        <Symbol name="chevron.right" size={12} color={colors.muted} />
      </HStack>
    </Button>
    <Divider modifiers={[padding({ leading: size + 12 })]} />
  </VStack>;
}

export function GenreGrid({ items }: GenreGridProps) {
  return <TileGrid items={items} columns={2} verticalSpacing={12} render={item => <GenreTileButton {...item} />} />;
}

function TileGrid<T extends { id: string }>({ items, columns, verticalSpacing, render }: {
  items: readonly T[]; columns: number; verticalSpacing: number; render: (item: T) => React.ReactElement;
}) {
  const rows = Array.from({ length: Math.ceil(items.length / columns) },
    (_, index) => items.slice(index * columns, (index + 1) * columns));
  // React Native handles screen insets. Keep the grid anchored while its host scrolls through them.
  return <Host alignment="topLeading" ignoreSafeArea="container" matchContents={{ vertical: true }}>
    <Grid alignment="topLeading" horizontalSpacing={12} verticalSpacing={verticalSpacing}>
      {rows.map(row => <Grid.Row key={row[0].id}>
        {row.map(item => <Fragment key={item.id}>{render(item)}</Fragment>)}
      </Grid.Row>)}
    </Grid>
  </Host>;
}

function GenreTileButton({ title, color, width, cover, onPress }: GenreCardProps) {
  return <Button onPress={onPress} modifiers={[plainButton, accessibilityLabel(`Browse ${title}`)]}>
    <ZStack alignment="bottomTrailing" modifiers={[
      frame({ width, height: 106 }), background(color), clipShape('roundedRectangle', 15), hitShape,
    ]}>
      <ZStack modifiers={[rotationEffect(19), offset({ x: 8, y: 16 })]}>
        <HostedCover cover={cover} size={85} />
      </ZStack>
      <Text modifiers={[font({ textStyle: 'headline' }), foregroundStyle('#F5F2FF'), padding({ top: 12, leading: 12, trailing: 8 }),
        frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: 'topLeading' })]}>{title}</Text>
    </ZStack>
  </Button>;
}

/** The round play button of a card. While `busy` it spins and ignores taps, so one tap starts one play. */
function CardPlayButton({ title, size, symbolSize, busy, onPress }: { title: string; size: number; symbolSize: number; busy?: boolean; onPress: () => void }) {
  const colors = useColors();
  return <Button modifiers={[
    buttonStyle(isLiquidGlassAvailable() ? 'glassProminent' : 'borderedProminent'), buttonBorderShape('circle'),
    tint(colors.accent), accessibilityLabel(busy ? `Starting ${title}` : `Play ${title}`),
  ]} onPress={busy ? () => undefined : onPress}>
    <HStack modifiers={[frame({ width: size, height: size })]}>
      {busy ? <ProgressView modifiers={[progressViewStyle('circular'), tint(colors.onAccent)]} />
        : <Symbol name="play.fill" size={symbolSize} color={colors.onAccent} />}
    </HStack>
  </Button>;
}

export function HeroActions({ title, artist, onOpen, onPlay, busy }: HeroActionsProps) {
  return <Host style={StyleSheet.absoluteFill}>
    <ZStack alignment="bottomTrailing">
      <Button modifiers={[plainButton, accessibilityLabel(`Open ${title}`)]} onPress={onOpen}>
        <VStack alignment="leading" spacing={4} modifiers={[
          padding({ bottom: 20, leading: 20, trailing: 75 }),
          frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: 'bottomLeading' }), hitShape,
        ]}>
          <Text modifiers={[font({ textStyle: 'largeTitle', weight: 'bold' }), foregroundStyle('#F5F2FF'), lineLimit(2)]}>{title}</Text>
          <Text modifiers={[font({ textStyle: 'subheadline' }), foregroundStyle('#F0E6FA'), lineLimit(1)]}>{artist}</Text>
        </VStack>
      </Button>
      <VStack modifiers={[padding({ bottom: 17, trailing: 17 })]}>
        <CardPlayButton title={title} size={34} symbolSize={20} busy={busy} onPress={onPlay} />
      </VStack>
    </ZStack>
  </Host>;
}

export function TopResult({ href, onPlay, busy, ...props }: TopResultProps) {
  const colors = useColors();
  return <Host matchContents={{ vertical: true }}>
    <ZStack alignment="trailing" modifiers={[background(colors.surface), clipShape('roundedRectangle', 18)]}>
      {href ? <ZoomLink href={href}><TopResultButton {...props} playable={Boolean(onPlay)} zoom /></ZoomLink>
        : <TopResultButton {...props} playable={Boolean(onPlay)} />}
      {onPlay && <VStack modifiers={[padding({ trailing: 16 })]}>
        <CardPlayButton title={props.title} size={30} symbolSize={17} busy={busy} onPress={onPlay} />
      </VStack>}
    </ZStack>
  </Host>;
}

function TopResultButton({ title, subtitle, cover, size, dim, zoom, playable, onPress }: Omit<TopResultProps, 'href' | 'onPlay' | 'busy'> & {
  zoom?: boolean; playable: boolean;
}) {
  const colors = useColors();
  return <Button modifiers={[plainButton, accessibilityLabel(`${title}, ${subtitle}`)]} onPress={onPress}>
    <HStack spacing={14} modifiers={[
      padding({ vertical: 14, leading: 14, trailing: playable ? 76 : 18 }), frame({ maxWidth: Infinity, alignment: 'leading' }), hitShape,
      ...(dim ? [opacity(unavailableOpacity)] : []),
    ]}>
      <HostedCover cover={cover} size={size} zoom={zoom} />
      <VStack alignment="leading" spacing={3}>
        <Text modifiers={[font({ textStyle: 'title3', weight: 'bold' }), lineLimit(2)]}>{title}</Text>
        <Text modifiers={[footnote, foregroundStyle(colors.muted), lineLimit(1)]}>{subtitle}</Text>
      </VStack>
      <Spacer minLength={4} />
      {!playable && <Symbol name="chevron.right" size={12} color={colors.muted} />}
    </HStack>
  </Button>;
}

const styles = StyleSheet.create({
  search: { height: 46 },
  filters: { height: 37 },
  gridRow: { flexDirection: 'row', columnGap: 12, marginBottom: 19 },
});
