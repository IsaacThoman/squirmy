import { useCallback, useMemo, type ReactElement } from 'react';
import { ActivityIndicator, FlatList, StyleSheet, Text, useWindowDimensions, View, type StyleProp, type ViewStyle } from 'react-native';
import { chunk } from '../../library/rows';
import { useCollectionDim, type Collection } from '../../library/shared';
import { CollectionLockup } from '../CollectionLockup';
import { useCollectionMenu } from '../menus';
import { Backdrop } from '../Page';
import { colors, tv, type } from '../theme';
import { useFirstFocus } from '../screens/useFirstFocus';

type GridProps = {
  items: readonly Collection[];
  columns: number;
  /** A tile's cover. */
  size: number;
  gap?: number;
  header?: ReactElement | null;
  footer?: ReactElement | null;
  /** Called as focus nears the end of what is loaded, for the next page. */
  onEndReached?: () => void;
  contentStyle?: StyleProp<ViewStyle>;
  /** The first tile takes focus when the grid first appears. */
  focusFirst?: boolean;
};

const rowKey = (row: readonly Collection[]) => row[0]!.key;

/**
 * Tiles in rows, drawn as they scroll into view, so a library or genre of thousands stays
 * quick on the box; the list scrolls with focus, and asks for more as focus nears its end.
 */
export function CollectionGrid({ items, columns, size, gap = tv.tileGap, header, footer, onEndReached, contentStyle, focusFirst }: GridProps) {
  const menu = useCollectionMenu();
  const dim = useCollectionDim();
  const { height } = useWindowDimensions();
  const rows = useMemo(() => chunk(items.map(dim), columns), [items, dim, columns]);
  // The first row is drawn again when it scrolls back into the list's window: only the grid's first focus goes to it.
  const first = useFirstFocus();
  const preferFirst = Boolean(focusFirst) && first.preferred;
  const renderRow = useCallback(({ item: row, index }: { item: Collection[]; index: number }) => <View style={[styles.row, { gap }]}>
    {row.map((item, at) => <CollectionLockup key={item.key} item={item} size={size} menu={menu} hasTVPreferredFocus={preferFirst && index === 0 && at === 0} />)}
  </View>, [preferFirst, gap, menu, size]);
  // On the TV a vertical list sits in a focus guide of no size of its own, so it is given the screen's height rather than flex.
  return <FlatList
    data={rows}
    renderItem={renderRow}
    keyExtractor={rowKey}
    onFocusCapture={first.onFocusCapture}
    ListHeaderComponent={header ?? undefined}
    ListFooterComponent={footer ?? undefined}
    onEndReached={onEndReached}
    onEndReachedThreshold={2}
    initialNumToRender={4}
    maxToRenderPerBatch={3}
    windowSize={7}
    removeClippedSubviews={false}
    showsVerticalScrollIndicator={false}
    style={[styles.list, { height }]}
    contentContainerStyle={contentStyle}
  />;
}

/** A spinner at the end of a list while its next page loads. */
export function MoreSpinner({ loading }: { loading: boolean }) {
  return loading ? <ActivityIndicator style={styles.more} color={colors.secondary} /> : <View style={styles.end} />;
}

/**
 * A page of tiles under a title: a genre's albums, or every release under one heading of an
 * artist's discography.
 */
export function GridPage({ title, detail, items, state, onEndReached, loadingMore = false }: {
  title: string;
  /** A line over the title, such as the artist whose releases these are. */
  detail?: string;
  items: readonly Collection[];
  /** In place of the tiles: loading, or what to say when there are none. */
  state?: ReactElement | null;
  onEndReached?: () => void;
  loadingMore?: boolean;
}) {
  return <View style={styles.page}>
    <Backdrop />
    <CollectionGrid items={items} columns={gridColumns} size={gridTile} focusFirst onEndReached={onEndReached}
      contentStyle={styles.pageContent}
      header={<View style={styles.header}>
        {detail ? <Text style={styles.detail} numberOfLines={1}>{detail}</Text> : null}
        <Text accessibilityRole="header" style={styles.title} numberOfLines={1}>{title}</Text>
        {state}
      </View>}
      footer={<MoreSpinner loading={loadingMore} />} />
  </View>;
}

/** Six covers across a page between its gutters. */
const gridColumns = 6;
const gridTile = Math.floor((1920 - tv.gutter * 2 - tv.tileGap * (gridColumns - 1)) / gridColumns);

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  list: { overflow: 'visible' },
  row: { flexDirection: 'row', marginBottom: 56 },
  more: { marginVertical: 40 },
  end: { height: 1 },
  pageContent: { paddingHorizontal: tv.gutter, paddingTop: tv.pushedTop, paddingBottom: 120 },
  header: { marginBottom: 44 },
  detail: { ...type.title3, color: colors.secondary },
  title: { ...type.title1 },
});
