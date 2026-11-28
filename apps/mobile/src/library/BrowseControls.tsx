import type { Href } from 'expo-router';
import { useImperativeHandle, useRef, type ComponentRef, type ReactElement, type Ref } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useMenuSheet } from '../MenuSheet';
import { Icon } from '../ui';
import { collectionLabel } from './collectionLabel';
import { createThemedStyles, unavailableOpacity, useColors } from '../theme';
import { ZoomLink } from './ZoomLink';

export type SearchHandle = Pick<ComponentRef<typeof TextInput>, 'focus' | 'blur'> & { setText: (text: string) => void };

export type SearchFieldProps = {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  inputRef?: Ref<SearchHandle>;
};

export type BrowseButtonProps = { label: string; icon?: string; title?: string; glass?: boolean; onPress: () => void };
export type FilterProps<T extends string> = { options: readonly T[]; value: T; onChange: (option: T) => void };
/** An entry of a row's menu. `icon` is an SF Symbol name. `destructive`: it deletes something, and is drawn in red. */
export type RowAction = { title: string; icon: string; onPress: () => void; destructive?: boolean };
/**
 * A collection that opens `href` when pressed. On iOS the page zooms out of its cover. `dim`
 * grays it: the cover fades, and the title and subtitle take the faded colors, which stay
 * readable. `onSelect` runs as it opens. `actions` give it a menu: a long press, and on a row
 * the ellipsis that replaces its chevron. `pinned` puts a pin before the subtitle.
 */
export type CollectionButtonProps = {
  title: string; subtitle: string; cover: ReactElement; size: number; href: Href; dim?: boolean;
  onSelect?: () => void; actions?: readonly RowAction[]; pinned?: boolean;
};
/** The button a `ZoomLink` wraps. The link supplies `onPress`. */
export type LinkedButtonProps<T> = Omit<T, 'href'> & { onPress?: () => void };
export type GenreCardProps = { title: string; color: string; width: number; cover: ReactElement; onPress: () => void };
/** One row of a grid of collections; a long grid is a virtualized list of these. */
export type CollectionGridRowProps = { items: readonly (CollectionButtonProps & { id: string })[] };
/** `columns`: two, or one when large text needs the width. */
export type GenreGridProps = { items: readonly (GenreCardProps & { id: string })[]; columns?: number };
export function SearchField({ value, onChange, placeholder, autoFocus, inputRef }: SearchFieldProps) {
  const colors = useColors();
  const styles = useStyles();
  const field = useRef<ComponentRef<typeof TextInput>>(null);
  useImperativeHandle(inputRef, () => ({
    focus: () => field.current?.focus(),
    blur: () => field.current?.blur(),
    setText: onChange,
  }), [onChange]);
  return <View style={styles.searchField}>
    <Icon name="magnifyingglass" size={18} color={colors.muted} />
    <TextInput ref={field} value={value} onChangeText={onChange}
      placeholder={placeholder} accessibilityLabel={placeholder} placeholderTextColor={colors.muted}
      autoFocus={autoFocus} autoCorrect={false} autoCapitalize="none" returnKeyType="search" style={styles.searchInput} />
    {!!value.length && <BrowseButton label="Clear search" icon="xmark.circle.fill" onPress={() => onChange('')} />}
  </View>;
}

export function BrowseButton({ label, icon, title, glass, onPress }: BrowseButtonProps) {
  const colors = useColors();
  const styles = useStyles();
  return <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress}
    style={({ pressed }) => [styles.button, glass && styles.glass, pressed && styles.pressed]}>
    {/* A chevron that leads somewhere ("See all ›") follows its title. */}
    {icon && !(title && icon === 'chevron.right') && <Icon name={icon} size={title ? 15 : 19} color={colors.text} />}
    {title && <Text style={styles.buttonTitle}>{title}</Text>}
    {icon && title && icon === 'chevron.right' && <Icon name={icon} size={15} color={colors.text} />}
  </Pressable>;
}

export function LibraryFilters<T extends string>({ options, value, onChange }: FilterProps<T>) {
  const colors = useColors();
  const styles = useStyles();
  return <View style={styles.filterRow}>
    {options.map(option => <Pressable key={option} accessibilityRole="button" accessibilityState={{ selected: value === option }}
      style={[styles.filter, value === option && styles.activeFilter]} onPress={() => onChange(option)}>
      <Text style={[styles.buttonTitle, value === option && { color: colors.onAccent }]}>{option}</Text>
    </Pressable>)}
  </View>;
}

export function LibrarySort<T extends string>({ options, value, onChange }: FilterProps<T>) {
  const menu = useMenuSheet();
  return <>
    <BrowseButton label={`Sort library, ${value}`} title={value} icon="arrow.up.arrow.down"
      onPress={() => menu.open('Sort your library', options.map(option => ({
        title: option, icon: option === value ? 'checkmark' : undefined, onPress: () => onChange(option),
      })))} />
    {menu.sheet}
  </>;
}

export function CollectionTile({ href, ...props }: CollectionButtonProps) {
  return <ZoomLink href={href}><TileButton {...props} /></ZoomLink>;
}

/** A menu of `actions` under `title`, for a long press: `open` is undefined when there are none. */
function useActionMenu(title: string, actions: readonly RowAction[] | undefined) {
  const menu = useMenuSheet();
  return { open: actions?.length ? () => menu.open(title, actions) : undefined, sheet: menu.sheet };
}

/** A pinned collection's subtitle starts with a pin. */
function Subtitle({ subtitle, pinned, dim, lines }: { subtitle: string; pinned?: boolean; dim?: boolean; lines: number }) {
  const colors = useColors();
  const styles = useStyles();
  const text = <Text numberOfLines={lines} style={[styles.subtitle, pinned && styles.pinnedSubtitle, dim && styles.fadedCredit]}>{subtitle}</Text>;
  return pinned ? <View style={styles.pinnedLine}><Icon name="pin.fill" size={10} color={colors.accent} />{text}</View> : text;
}

function TileButton({ title, subtitle, cover, size, dim, pinned, onPress, actions }: LinkedButtonProps<CollectionButtonProps>) {
  const styles = useStyles();
  const menu = useActionMenu(title, actions);
  return <Pressable accessibilityRole="button" accessibilityLabel={collectionLabel({ title, subtitle, pinned })} onPress={onPress} onLongPress={menu.open}
    style={({ pressed }) => [{ width: size }, pressed && styles.pressed]}>
    <View style={dim && styles.dim}>{cover}</View>
    <Text numberOfLines={4} style={[styles.collectionTitle, { marginTop: 7 }, dim && styles.fadedTitle]}>{title}</Text>
    <Subtitle subtitle={subtitle} pinned={pinned} dim={dim} lines={2} />
    {menu.sheet}
  </Pressable>;
}

export function CollectionGridRow({ items }: CollectionGridRowProps) {
  const styles = useStyles();
  return <View style={styles.collectionGrid}>
    {items.map(({ id, ...item }) => <CollectionTile key={id} {...item} />)}
  </View>;
}

export function CollectionRow({ href, ...props }: CollectionButtonProps) {
  return <ZoomLink href={href}><RowButton {...props} /></ZoomLink>;
}

function RowButton({ title, subtitle, cover, dim, pinned, onPress, onSelect, actions }: LinkedButtonProps<CollectionButtonProps>) {
  const colors = useColors();
  const styles = useStyles();
  const { open: menu, sheet } = useActionMenu(title, actions);
  return <Pressable accessibilityRole="button" accessibilityLabel={collectionLabel({ title, subtitle, pinned })}
    onPress={() => { onSelect?.(); onPress?.(); }} onLongPress={menu}
    style={({ pressed }) => [styles.collectionRow, pressed && styles.pressed]}>
    <View style={dim && styles.dim}>{cover}</View>
    <View style={styles.flex}>
      <Text numberOfLines={1} style={[styles.collectionTitle, dim && styles.fadedTitle]}>{title}</Text>
      <Subtitle subtitle={subtitle} pinned={pinned} dim={dim} lines={1} />
    </View>
    {menu
      ? <Pressable accessibilityRole="button" accessibilityLabel={`More options for ${title}`} onPress={menu} hitSlop={10}><Icon name="ellipsis" size={18} color={colors.muted} /></Pressable>
      : <Icon name="chevron.right" size={12} color={colors.muted} />}
    {sheet}
  </Pressable>;
}

function GenreCard({ title, color, width, cover, onPress }: GenreCardProps) {
  const styles = useStyles();
  return <Pressable accessibilityRole="button" accessibilityLabel={`Browse ${title}`} onPress={onPress}
    style={({ pressed }) => [styles.genre, { width, backgroundColor: color }, pressed && styles.pressed]}>
    <Text style={styles.genreTitle}>{title}</Text>
    <View pointerEvents="none" style={styles.genreCover}>{cover}</View>
  </Pressable>;
}

export function GenreGrid({ items }: GenreGridProps) {
  const styles = useStyles();
  return <View style={styles.genreGrid}>
    {items.map(({ id, ...item }) => <GenreCard key={id} {...item} />)}
  </View>;
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  dim: { opacity: unavailableOpacity },
  fadedTitle: { color: colors.fadedTitle },
  fadedCredit: { color: colors.fadedCredit },
  flex: { flex: 1 },
  pressed: { opacity: 0.68 },
  button: { minWidth: 44, minHeight: 44, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6 },
  glass: { borderRadius: 22, backgroundColor: colors.surface },
  buttonTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  searchField: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 46, paddingHorizontal: 12, borderRadius: 13, backgroundColor: colors.surface },
  searchInput: { flex: 1, height: 44, color: colors.text, fontSize: 15, paddingVertical: 0 },
  filterRow: { flexDirection: 'row', gap: 7 },
  filter: { borderRadius: 17, paddingHorizontal: 10, minHeight: 34, justifyContent: 'center', backgroundColor: colors.surface },
  activeFilter: { backgroundColor: colors.accent },
  collectionRow: { paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 11,
    borderBottomWidth: StyleSheet.hairlineWidth, borderColor: colors.stroke },
  collectionTitle: { color: colors.text, fontSize: 14, fontWeight: '600' },
  subtitle: { color: colors.muted, fontSize: 13, marginTop: 3 },
  pinnedLine: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 3 },
  pinnedSubtitle: { flexShrink: 1, marginTop: 0 },
  collectionGrid: { flexDirection: 'row', columnGap: 12, marginBottom: 19 },
  genreGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  genre: { minHeight: 106, padding: 12, borderRadius: 15, overflow: 'hidden' },
  genreTitle: { color: '#F5F2FF', fontSize: 17, fontWeight: '700' },
  genreCover: { position: 'absolute', bottom: -11, right: -6, transform: [{ rotate: '19deg' }] },
}));
