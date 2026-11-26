import type { ReactElement } from 'react';
import { FlatList, StyleSheet, Text, TVFocusGuideView, View } from 'react-native';
import { tv, type } from './theme';

type Props<T> = {
  title?: string;
  items: readonly T[];
  keyOf: (item: T) => string;
  render: (item: T, index: number) => ReactElement;
  /** Room the focus lift needs above and below the tiles. */
  lift?: number;
  gap?: number;
};

/**
 * A titled row of tiles that scrolls sideways as focus moves along it. Coming back to the row
 * returns to the tile last focused in it, as the system's shelves do.
 */
export function Shelf<T>({ title, items, keyOf, render, lift = 40, gap = tv.tileGap }: Props<T>) {
  if (!items.length) return null;
  return <View style={styles.shelf}>
    {title ? <Text accessibilityRole="header" style={styles.title}>{title}</Text> : null}
    <TVFocusGuideView autoFocus style={{ marginVertical: -lift }}>
      <FlatList
        horizontal
        data={items as T[]}
        keyExtractor={keyOf}
        renderItem={({ item, index }) => render(item, index)}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: tv.gutter, paddingVertical: lift, gap }}
        style={styles.list}
        initialNumToRender={8}
        windowSize={5}
        removeClippedSubviews={false}
      />
    </TVFocusGuideView>
  </View>;
}

const styles = StyleSheet.create({
  shelf: { marginBottom: tv.shelfGap },
  title: { ...type.section, marginHorizontal: tv.gutter, marginBottom: 22 },
  list: { overflow: 'visible' },
});
