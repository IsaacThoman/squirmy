import type { TrackSummary } from '@squirmy/contracts';
import { useCallback, type ReactElement, type ReactNode } from 'react';
import { FlatList, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import type { TrackActionOptions } from '../../library/trackActions';
import { Backdrop } from '../Page';
import { SongRow } from '../SongRow';
import { colors, tv, type } from '../theme';
import { MoreSpinner } from './CollectionGrid';

/** The cover's side, and where the songs begin beside it. */
export const artSize = 800;
const listLeft = tv.gutter + artSize + 20;

type Props = {
  /** The large cover, which stays put on the left while the songs scroll beside it. */
  art: ReactElement;
  tint?: string | null;
  title: string;
  /** Under the title, such as who made the playlist. */
  credit?: string;
  facts?: string;
  buttons?: ReactNode;
  description?: string | null;
  tracks: readonly TrackSummary[];
  /** Keys for the rows, such as a playlist's item ids; by default each song's id and place. */
  keys?: readonly string[];
  /** A row's song menu: the playlist it can be removed from. */
  rowMenu?: (index: number) => TrackActionOptions | undefined;
  onPlay: (index: number) => void;
  /** Called as focus nears the end of what is loaded, for the next page. */
  onEndReached?: () => void;
  loadingMore?: boolean;
  /** In place of the songs when there are none, or while they load. */
  empty?: ReactNode;
};

/**
 * A list of songs with its cover, as the system's music app shows a playlist: the cover on the
 * left, and beside it the title, what it is, Play, Shuffle and More, then the songs, each with
 * its own cover. The songs are drawn as they scroll into view, so a list of thousands stays quick.
 */
export function TrackListPage({ art, tint, title, credit, facts, buttons, description, tracks, keys, rowMenu, onPlay, onEndReached, loadingMore = false, empty }: Props) {
  const renderRow = useCallback(({ item: track, index }: { item: TrackSummary; index: number }) => <SongRow track={track} cover
    subtitle={track.artistCredit} menu={rowMenu?.(index)} onPress={() => onPlay(index)} />, [onPlay, rowMenu]);
  const { height } = useWindowDimensions();
  const keyOf = useCallback((track: TrackSummary, index: number) => keys?.[index] ?? `${track.id}:${index}`, [keys]);
  return <View style={styles.page}>
    <Backdrop tint={tint} />
    <View style={styles.art} pointerEvents="none">{art}</View>
    {/* On the TV a vertical list sits in a focus guide of no size of its own, so it is given the screen's height rather than flex. */}
    <View style={styles.column}><FlatList
      data={tracks as TrackSummary[]}
      renderItem={renderRow}
      keyExtractor={keyOf}
      style={[styles.list, { height }]}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      onEndReached={onEndReached}
      onEndReachedThreshold={2}
      initialNumToRender={10}
      maxToRenderPerBatch={8}
      windowSize={7}
      removeClippedSubviews={false}
      ListHeaderComponent={<View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title} numberOfLines={2}>{title}</Text>
        {credit ? <Text style={styles.credit} numberOfLines={1}>{credit}</Text> : null}
        {facts ? <Text style={styles.facts} numberOfLines={1}>{facts}</Text> : null}
        {buttons ? <View style={styles.buttons}>{buttons}</View> : null}
        {description ? <Text style={styles.description} numberOfLines={3}>{description}</Text> : null}
        {!tracks.length && empty}
      </View>}
      ListFooterComponent={<MoreSpinner loading={loadingMore} />}
    /></View>
  </View>;
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.background },
  art: { position: 'absolute', left: tv.gutter, top: tv.gutter },
  column: { position: 'absolute', left: listLeft, right: 0, top: 0, bottom: 0 },
  list: { overflow: 'visible' },
  content: { paddingTop: tv.gutter + 20, paddingBottom: 120, paddingLeft: 30, paddingRight: tv.gutter - 30 },
  header: { paddingHorizontal: 30, marginBottom: 20 },
  title: { ...type.largeTitle, fontSize: 64 },
  credit: { ...type.title2, fontWeight: '500', color: colors.secondary, marginTop: 4 },
  facts: { ...type.callout, color: colors.secondary, marginTop: 14 },
  buttons: { flexDirection: 'row', alignItems: 'center', gap: 24, marginTop: 40 },
  description: { ...type.callout, color: colors.secondary, marginTop: 28 },
});
