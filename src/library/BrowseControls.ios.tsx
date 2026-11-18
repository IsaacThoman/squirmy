import { Fragment, useImperativeHandle, useRef } from 'react';
import { Button, Divider, Grid, Host, HStack, Menu, Picker, RNHostView, Spacer, Text, TextField, VStack, ZStack, useNativeState, type TextFieldRef } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityLabel, autocorrectionDisabled, background, buttonBorderShape, buttonStyle, clipShape,
  font, foregroundStyle, frame, lineLimit, menuIndicator, multilineTextAlignment, offset, padding, pickerStyle,
  rotationEffect, submitLabel, tag, textInputAutocapitalization, tint,
} from '@expo/ui/swift-ui/modifiers';
import { isLiquidGlassAvailable } from 'expo-glass-effect';
import { StyleSheet, View } from 'react-native';
import { IconButton, Symbol, hitShape, plainButton } from '../native/Controls';
import { colors } from '../ui';
import type {
  AlbumMetadataProps, BrowseButtonProps, CollectionButtonProps, CollectionGridProps, FilterProps, GenreCardProps, GenreGridProps, HeroActionsProps, SearchFieldProps,
} from './BrowseControls';

const footnote = font({ textStyle: 'footnote' });
const secondary = foregroundStyle(colors.muted);
const labelFont = font({ textStyle: 'subheadline', weight: 'semibold' });
const iconGlass = [buttonStyle('glass'), buttonBorderShape('circle')] as const;

export function SearchField({ value, onChange, placeholder, autoFocus, inputRef }: SearchFieldProps) {
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

  return <Host colorScheme="dark" style={styles.search}>
    <HStack spacing={9} modifiers={[
      padding({ horizontal: 12 }), frame({ height: 46 }), background('#202024'), clipShape('roundedRectangle', 12),
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

export function BrowseButton({ label, icon, title, glass, onPress }: BrowseButtonProps) {
  const useGlass = glass && isLiquidGlassAvailable();
  return <Host colorScheme="dark" matchContents>
    <Button modifiers={[...(useGlass ? iconGlass : [plainButton]), accessibilityLabel(label)]} onPress={onPress}>
      <HStack spacing={6} modifiers={[frame({ minWidth: useGlass ? 30 : 44, minHeight: useGlass ? 30 : 44 }), hitShape]}>
        {icon && <Symbol name={icon} size={title ? 14 : 19} color={title ? colors.accent : colors.text} />}
        {title && <Text modifiers={[labelFont, foregroundStyle(colors.accent)]}>{title}</Text>}
      </HStack>
    </Button>
  </Host>;
}

export function LibraryFilters<T extends string>({ options, value, onChange }: FilterProps<T>) {
  return <Host colorScheme="dark" style={styles.filters}>
    <Picker label="Collections" selection={value} onSelectionChange={onChange} modifiers={[pickerStyle('segmented')]}>
      {options.map(option => <Text key={option} modifiers={[tag(option)]}>{option}</Text>)}
    </Picker>
  </Host>;
}

export function LibrarySort<T extends string>({ options, value, onChange }: FilterProps<T>) {
  return <Host colorScheme="dark" matchContents>
    <Menu modifiers={[plainButton, menuIndicator('hidden'), accessibilityLabel(`Sort library, ${value}`)]}
      label={<HStack spacing={6} modifiers={[frame({ minHeight: 44 }), hitShape]}>
        <Symbol name="arrow.up.arrow.down" size={14} color={colors.muted} />
        <Text modifiers={[labelFont, secondary]}>{value}</Text>
      </HStack>}>
      {options.map(option => <Button key={option} label={option} systemImage={option === value ? 'checkmark' : undefined}
        onPress={() => onChange(option)} />)}
    </Menu>
  </Host>;
}

function HostedCover({ cover, size }: { cover: React.ReactElement; size: number }) {
  return <RNHostView matchContents><View style={{ width: size, height: size }}>{cover}</View></RNHostView>;
}

export function CollectionTile(props: CollectionButtonProps) {
  return <Host colorScheme="dark" matchContents={{ vertical: true }} style={{ width: props.size }}>
    <CollectionTileButton {...props} />
  </Host>;
}

export function CollectionGrid({ items, columns }: CollectionGridProps) {
  return <TileGrid items={items} columns={columns} verticalSpacing={19} render={item => <CollectionTileButton {...item} />} />;
}

function CollectionTileButton({ title, subtitle, cover, size, onPress }: CollectionButtonProps) {
  return <Button modifiers={[plainButton, accessibilityLabel(`${title}, ${subtitle}`)]} onPress={onPress}>
    <VStack alignment="leading" spacing={6} modifiers={[frame({ width: size, alignment: 'leading' }), hitShape]}>
      <HostedCover cover={cover} size={size} />
      <VStack alignment="leading" spacing={2}>
        <Text modifiers={[labelFont, lineLimit(1)]}>{title}</Text>
        <Text modifiers={[footnote, secondary, lineLimit(1)]}>{subtitle}</Text>
      </VStack>
    </VStack>
  </Button>;
}

export function CollectionRow({ title, subtitle, cover, size, onPress }: CollectionButtonProps) {
  return <Host colorScheme="dark" matchContents={{ vertical: true }}>
    <VStack spacing={0}>
      <Button modifiers={[plainButton, accessibilityLabel(`${title}, ${subtitle}`)]} onPress={onPress}>
        <HStack spacing={12} modifiers={[padding({ vertical: 7 }), hitShape]}>
          <HostedCover cover={cover} size={size} />
          <VStack alignment="leading" spacing={3}>
            <Text modifiers={[labelFont, lineLimit(1)]}>{title}</Text>
            <Text modifiers={[footnote, secondary, lineLimit(1)]}>{subtitle}</Text>
          </VStack>
          <Spacer minLength={4} />
          <Symbol name="chevron.right" size={12} color={colors.muted} />
        </HStack>
      </Button>
      <Divider modifiers={[padding({ leading: size + 12 })]} />
    </VStack>
  </Host>;
}

export function GenreGrid({ items }: GenreGridProps) {
  return <TileGrid items={items} columns={2} verticalSpacing={12} render={item => <GenreTileButton {...item} />} />;
}

function TileGrid<T extends { id: string }>({ items, columns, verticalSpacing, render }: {
  items: readonly T[]; columns: number; verticalSpacing: number; render: (item: T) => React.ReactElement;
}) {
  const rows = Array.from({ length: Math.ceil(items.length / columns) },
    (_, index) => items.slice(index * columns, (index + 1) * columns));
  return <Host colorScheme="dark" alignment="topLeading" matchContents={{ vertical: true }}>
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
      <Text modifiers={[font({ textStyle: 'headline' }), padding({ top: 12, leading: 12, trailing: 8 }),
        frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: 'topLeading' })]}>{title}</Text>
    </ZStack>
  </Button>;
}

export function HeroActions({ title, artist, onOpen, onPlay }: HeroActionsProps) {
  return <Host colorScheme="dark" style={StyleSheet.absoluteFill}>
    <ZStack alignment="bottomTrailing">
      <Button modifiers={[plainButton, accessibilityLabel(`Open ${title}`)]} onPress={onOpen}>
        <VStack alignment="leading" spacing={4} modifiers={[
          padding({ bottom: 20, leading: 20, trailing: 75 }),
          frame({ maxWidth: Infinity, maxHeight: Infinity, alignment: 'bottomLeading' }), hitShape,
        ]}>
          <Text modifiers={[font({ textStyle: 'largeTitle', weight: 'bold' }), lineLimit(2)]}>{title}</Text>
          <Text modifiers={[font({ textStyle: 'subheadline' }), foregroundStyle('#F0E6FA'), lineLimit(1)]}>{artist}</Text>
        </VStack>
      </Button>
      <VStack modifiers={[padding({ bottom: 17, trailing: 17 })]}>
        <Button modifiers={[
          buttonStyle(isLiquidGlassAvailable() ? 'glassProminent' : 'borderedProminent'), buttonBorderShape('circle'),
          tint(colors.accent), accessibilityLabel(`Play ${title}`),
        ]} onPress={onPlay}>
          <HStack modifiers={[frame({ width: 34, height: 34 })]}><Symbol name="play.fill" size={20} color={colors.background} /></HStack>
        </Button>
      </VStack>
    </ZStack>
  </Host>;
}

export function AlbumMetadata({ title, info, artist }: AlbumMetadataProps) {
  return <Host colorScheme="dark" matchContents={{ vertical: true }} style={styles.metadata}>
    <VStack spacing={4}>
      <Text modifiers={[font({ textStyle: 'largeTitle', weight: 'bold' }), multilineTextAlignment('center'),
        accessibilityAddTraits(['isHeader'])]}>{title}</Text>
      {artist && <Text modifiers={[font({ textStyle: 'title3', weight: 'medium' }), multilineTextAlignment('center')]}>{artist}</Text>}
      <Text modifiers={[footnote, secondary, multilineTextAlignment('center')]}>{info}</Text>
    </VStack>
  </Host>;
}

const styles = StyleSheet.create({
  search: { height: 46 },
  filters: { height: 37 },
  metadata: { alignSelf: 'stretch' },
});
