import { Fragment, useImperativeHandle, useRef, type ComponentProps } from 'react';
import {
  Button, ContextMenu, Divider, Grid, Host, HStack, Menu, Picker, ProgressView, RNHostView, Spacer, Text, TextField, VStack, ZStack, useNativeState,
  type TextFieldRef,
} from '@expo/ui/swift-ui';
import {
  accessibilityLabel, autocorrectionDisabled, background, buttonBorderShape, buttonStyle, clipShape, controlSize, dynamicTypeSize, fixedSize,
  font, foregroundStyle, frame, lineLimit, menuIndicator, offset, padding, pickerStyle, shadow, truncationMode,
  progressViewStyle, rotationEffect, submitLabel, tag, textInputAutocapitalization, tint,
} from '@expo/ui/swift-ui/modifiers';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { isAccessibilitySize } from '../fontScale';
import { IconButton, Symbol, hitShape, plainButton } from '../native/Controls';
import type {
  BrowseButtonProps, CollectionButtonProps, CollectionGridRowProps, FilterProps, GenreCardProps, GenreGridProps, HeroActionsProps,
  LinkedButtonProps, RowAction, SearchFieldProps,
} from './BrowseControls';
import { unavailableOpacity, useColors } from '../theme';
import { ZoomLink, ZoomSource } from './ZoomLink';

type ButtonSymbol = ComponentProps<typeof Button>['systemImage'];

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
      {!!value.length && <IconButton label="Clear search" symbol="xmark.circle.fill" size={17} width={44} height={44}
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
  const colors = useColors();
  const { fontScale } = useWindowDimensions();
  // A segmented control keeps its labels at one size whatever the reader chose, and five
  // larger ones would not fit across. At accessibility sizes the filter is a menu instead,
  // its label as large as the text around it.
  if (isAccessibilitySize(fontScale)) {
    return <Host matchContents style={styles.filterMenu}>
      <Menu modifiers={[plainButton, menuIndicator('hidden'), accessibilityLabel(`Show, ${value}`)]}
        label={<HStack spacing={8} modifiers={[frame({ minHeight: 44 }), hitShape]}>
          <Text modifiers={[font({ textStyle: 'headline' }), foregroundStyle(colors.accent)]}>{value}</Text>
          <Symbol name="chevron.up.chevron.down" size={15} color={colors.accent} />
        </HStack>}>
        {options.map(option => <Button key={option} label={option} systemImage={option === value ? 'checkmark' : undefined}
          onPress={() => onChange(option)} />)}
      </Menu>
    </Host>;
  }
  // The large segmented control is 44 tall, the smallest target Apple recommends; the regular one is 32.
  return <Host style={styles.filters}>
    <Picker label="Collections" selection={value} onSelectionChange={onChange} modifiers={[pickerStyle('segmented'), controlSize('large')]}>
      {options.map(option => <Text key={option} modifiers={[tag(option)]}>{option}</Text>)}
    </Picker>
  </Host>;
}

export function LibrarySort<T extends string>({ options, value, onChange }: FilterProps<T>) {
  const colors = useColors();
  return <Host matchContents>
    <Menu modifiers={[plainButton, menuIndicator('hidden'), accessibilityLabel(`Sort library, ${value}`)]}
      label={<HStack spacing={6} modifiers={[frame({ minHeight: 44 }), hitShape, dynamicTypeSize({ max: 'accessibility1' })]}>
        <Symbol name="arrow.up.arrow.down" size={14} color={colors.muted} />
        {/* Stops growing before it would push the grid/list switch beside it off the screen. */}
        <Text modifiers={[labelFont, foregroundStyle(colors.muted), lineLimit(1)]}>{value}</Text>
      </HStack>}>
      {options.map(option => <Button key={option} label={option} systemImage={option === value ? 'checkmark' : undefined}
        onPress={() => onChange(option)} />)}
    </Menu>
  </Host>;
}

/**
 * A React Native cover inside SwiftUI. With `zoom`, the linked page grows out of it. A `dim`
 * cover fades, as a gray song's does; the text beside it takes `fadedTitle` and `fadedCredit`
 * instead, which stay readable (3:1).
 */
function HostedCover({ cover, size, zoom, dim }: { cover: React.ReactElement; size: number; zoom?: boolean; dim?: boolean }) {
  const frame = { width: size, height: size, opacity: dim ? unavailableOpacity : 1 };
  return <RNHostView matchContents>
    {zoom ? <ZoomSource style={frame}>{cover}</ZoomSource> : <View style={frame}>{cover}</View>}
  </RNHostView>;
}

function menuItems(actions: readonly RowAction[]) {
  return actions.map(action => <Button key={action.title} label={action.title} systemImage={action.icon as ButtonSymbol} onPress={action.onPress} />);
}

export function CollectionTile(props: CollectionButtonProps) {
  // As for the grid below: near the screen's edges the host would otherwise take the safe
  // area into its height, and the last rows of a long grid would overlap.
  return <Host ignoreSafeArea="container" matchContents={{ vertical: true }} style={{ width: props.size }}>
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

function TileButton({ title, subtitle, cover, size, dim, onPress, actions }: LinkedButtonProps<CollectionButtonProps>) {
  const colors = useColors();
  const large = isAccessibilitySize(useWindowDimensions().fontScale);
  const button = <Button modifiers={[plainButton, accessibilityLabel(`${title}, ${subtitle}`)]} onPress={onPress}>
    <VStack alignment="leading" spacing={6} modifiers={[frame({ width: size, alignment: 'leading' }), hitShape]}>
      <HostedCover cover={cover} size={size} zoom dim={dim} />
      <VStack alignment="leading" spacing={2}>
        {/* Up to four lines (five at accessibility sizes), cut in the middle: editions of one
            release differ at the end of the title ("… (Acoustic Version)"), which a cut at the
            end would hide, and in a narrow grid tile the qualifier alone can take two lines. */}
        <Text modifiers={[labelFont, ...(dim ? [foregroundStyle(colors.fadedTitle)] : []), lineLimit(large ? 5 : 4), truncationMode('middle')]}>{title}</Text>
        <Text modifiers={[footnote, foregroundStyle(dim ? colors.fadedCredit : colors.muted), lineLimit(large ? 2 : 1)]}>{subtitle}</Text>
      </VStack>
    </VStack>
  </Button>;
  // A long press shows what can be done with it, as on a song row, rather than opening it.
  return actions?.length ? <ContextMenu>
    <ContextMenu.Trigger>{button}</ContextMenu.Trigger>
    <ContextMenu.Items>{menuItems(actions)}</ContextMenu.Items>
  </ContextMenu> : button;
}

export function CollectionRow({ href, ...props }: CollectionButtonProps) {
  return <Host matchContents={{ vertical: true }}>
    <ZoomLink href={href}><RowButton {...props} /></ZoomLink>
  </Host>;
}

function RowButton({ title, subtitle, cover, size, dim, onPress, onSelect, actions }: LinkedButtonProps<CollectionButtonProps>) {
  const colors = useColors();
  const menu = actions?.length ? menuItems(actions) : null;
  const button = <Button modifiers={[plainButton, accessibilityLabel(`${title}, ${subtitle}`)]} onPress={() => { onSelect?.(); onPress?.(); }}>
    <HStack spacing={12} modifiers={[padding({ vertical: 7 }), hitShape]}>
      <HostedCover cover={cover} size={size} zoom dim={dim} />
      <VStack alignment="leading" spacing={3}>
        {/* Cut in the middle, as on tiles: editions differ at the end of a title. */}
        <Text modifiers={[labelFont, ...(dim ? [foregroundStyle(colors.fadedTitle)] : []), lineLimit(2), truncationMode('middle')]}>{title}</Text>
        <Text modifiers={[footnote, foregroundStyle(dim ? colors.fadedCredit : colors.muted), lineLimit(1)]}>{subtitle}</Text>
      </VStack>
      <Spacer minLength={4} />
      {!menu && <Symbol name="chevron.right" size={12} color={colors.muted} />}
    </HStack>
  </Button>;
  return <VStack spacing={0}>
    {menu ? <HStack spacing={0}>
      <ContextMenu>
        <ContextMenu.Trigger>{button}</ContextMenu.Trigger>
        <ContextMenu.Items>{menu}</ContextMenu.Items>
      </ContextMenu>
      <Menu label={<Symbol name="ellipsis" size={19} color={colors.muted} />}
        modifiers={[plainButton, menuIndicator('hidden'), accessibilityLabel(`More options for ${title}`), frame({ width: 44, height: 44 }), hitShape]}>
        {menu}
      </Menu>
    </HStack> : button}
    <Divider modifiers={[padding({ leading: size + 12 })]} />
  </VStack>;
}

export function GenreGrid({ items, columns = 2 }: GenreGridProps) {
  return <TileGrid items={items} columns={columns} verticalSpacing={12} render={item => <GenreTileButton {...item} />} />;
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
    {/* At least 106 tall, taller when the name needs it: a large text size wraps it instead of cutting it. */}
    <ZStack alignment="bottomTrailing" modifiers={[
      frame({ minWidth: width, maxWidth: width, minHeight: 106 }), background(color), clipShape('roundedRectangle', 15), hitShape,
    ]}>
      <ZStack modifiers={[rotationEffect(19), offset({ x: 8, y: 16 })]}>
        <HostedCover cover={cover} size={85} />
      </ZStack>
      <Text modifiers={[font({ textStyle: 'headline' }), foregroundStyle('#F5F2FF'), padding({ top: 12, leading: 12, trailing: 8, bottom: 12 }),
        frame({ maxWidth: Infinity, alignment: 'topLeading' }), fixedSize({ horizontal: false, vertical: true }),
        frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: 'topLeading' }), shadow({ radius: 6, color: '#00000080' })]}>{title}</Text>
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

/** Where the hero's text ends: the gradient's darkest stop, so a card grown taller for large text stays one piece. */
const heroShade = '#100D16';
/** The play button with its glass, and so the height of the credit's row beside it. */
const heroPlaySize = 48;
const heroInset = 20;

/**
 * The featured album: one button that opens it (its page zooms out of the card) and a play
 * button, each its own element for VoiceOver, as tiles are. Both are SwiftUI's, inside the
 * host, with the artwork hosted in the button as a tile's cover is.
 */
function HeroButton({ title, artist, art, width, height, onPress }: LinkedButtonProps<Omit<HeroActionsProps, 'onPlay' | 'busy'>>) {
  return <Button modifiers={[plainButton, accessibilityLabel(`${title}, ${artist}`)]} onPress={onPress}>
    <ZStack alignment="top" modifiers={[frame({ minWidth: width, maxWidth: width, minHeight: height, alignment: 'top' }), background(heroShade), hitShape]}>
      <RNHostView matchContents>
        <ZoomSource style={{ width, height }}>{art}</ZoomSource>
      </RNHostView>
      {/* The title takes the card's whole width, above the play button, and up to three lines,
          so a large text size still names the album; it stops growing at AX2, where that still
          fits. Past the artwork's height the card grows, on the gradient's last color. */}
      <VStack alignment="leading" spacing={4} modifiers={[
        dynamicTypeSize({ max: 'accessibility2' }), padding({ top: heroInset, bottom: heroInset, leading: heroInset, trailing: heroInset }),
        frame({ minWidth: width, maxWidth: width, minHeight: height, alignment: 'bottomLeading' }),
      ]}>
        <Text modifiers={[font({ textStyle: 'largeTitle', weight: 'bold' }), foregroundStyle('#F5F2FF'), lineLimit(3),
          fixedSize({ horizontal: false, vertical: true })]}>{title}</Text>
        {/* Two lines, so a large text size keeps every credited artist ("Khruangbin & Leon Bridges").
            The row is as tall as the play button laid over its end, so the title never runs under it. */}
        <Text modifiers={[font({ textStyle: 'subheadline' }), foregroundStyle('#F0E6FA'), lineLimit(2),
          fixedSize({ horizontal: false, vertical: true }), padding({ trailing: heroPlaySize + 8 }),
          frame({ maxWidth: Infinity, minHeight: heroPlaySize, alignment: 'leading' })]}>{artist}</Text>
      </VStack>
    </ZStack>
  </Button>;
}

export function HeroActions({ href, onPlay, busy, ...card }: HeroActionsProps) {
  return <Host ignoreSafeArea="container" matchContents={{ vertical: true }} style={{ width: card.width }}>
    <ZStack alignment="bottomTrailing" modifiers={[clipShape('roundedRectangle', 26)]}>
      <ZoomLink href={href}><HeroButton {...card} /></ZoomLink>
      <VStack modifiers={[frame({ height: heroPlaySize }), padding({ bottom: heroInset, trailing: 17 })]}>
        <CardPlayButton title={card.title} size={34} symbolSize={20} busy={busy} onPress={onPlay} />
      </VStack>
    </ZStack>
  </Host>;
}

const styles = StyleSheet.create({
  search: { height: 46 },
  filters: { height: 48 },
  filterMenu: { alignSelf: 'flex-start' },
  gridRow: { flexDirection: 'row', columnGap: 12, marginBottom: 19 },
});
