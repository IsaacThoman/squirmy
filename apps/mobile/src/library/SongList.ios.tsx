import { Button, ContextMenu, Host, HStack, Image, List, ProgressView, RNHostView, Spacer, SwipeActions, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  accessibilityHidden, accessibilityLabel, alignmentGuide, background, buttonStyle, clipShape, controlSize, dynamicTypeSize, environment, font, foregroundStyle, frame,
  labelStyle, lineLimit, listRowBackground, listRowInsets, listRowSeparator, listRowSeparatorTint, listStyle, monospacedDigit, onAppear, opacity, padding,
  scrollContentBackground, scrollDisabled, scrollIndicators, tint, useScrollGeometryChange,
} from '@expo/ui/swift-ui/modifiers';
import { librarySave } from '@squirmy/client-core';
import { memo, useCallback, useMemo, useRef, useState } from 'react';
import { Platform, useWindowDimensions, View } from 'react-native';
import { useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useSharingEnabled, useWantlistEnabled } from '../account/AccountProvider';
import { useLiked, useLikeFailure, useWanted, useWantFailure } from '../data/library';
import { useRatingsEnabled } from '../data/queries';
import { useRealtime } from '../data/realtime';
import { useCanPlay, useTrackDownload, useViewer } from '../downloads/DownloadsProvider';
import { downloadSymbol, unavailableReason } from '../downloads/model';
import { IconButton, TrackActionButtons, TrackActionsMenu, TrackCover, hitShape } from '../native/Controls';
import { useCurrentTrackState, usePlaybackActions, useTrackLoading } from '../playback';
import { STILL_LOADING_LABEL } from '../player/loading';
import { isAccessibilitySize } from '../fontScale';
import { spokenDuration, trackDuration } from './duration';
import type { SongListProps } from './SongList';
import { heartButton, heartColor } from './heart';
import {
  nearListEnd, pressVerb, sameRow, songRowKey, songRows, useSongRowHandlers, type LongSongListProps, type SongListItems, type SongRowHandlers,
  type SongRowItem,
} from './rows';
import { trackActions, useDownloadedOnItsOwn, useTrackActionRunner, type TrackAction } from './trackActions';
import { unavailableOpacity, useColors } from '../theme';

export type { SongListProps } from './SongList';

/** How far before a row's trailing edge a short list's separator ends. */
const separatorEnd = 16;
/** The height of a row at the usual text sizes, and the least it gets; larger text makes it taller. */
const rowHeight = 58;
/**
 * A native list is sized from its rows' real heights, read from its scroll geometry, so rows
 * grow with the reader's text size. That reading needs iOS 18; before it, rows keep one
 * height and their text stops growing where it still fits (the list's minimum row height
 * grows with the text too, and past the limit the last row would be cut off).
 */
const measuresRows = parseInt(String(Platform.Version), 10) >= 18;
const listModifiers = [listStyle('plain'), scrollContentBackground('hidden'), scrollDisabled(),
  ...(measuresRows ? [] : [dynamicTypeSize({ max: 'xxLarge' })])];
const swipeLabelStyle = labelStyle('iconOnly');

const quick = {
  next: { id: 'next', title: 'Play next', icon: 'text.line.first.and.arrowtriangle.forward' },
  last: { id: 'last', title: 'Add to queue', icon: 'text.line.last.and.arrowtriangle.forward' },
  like: { id: 'like', title: librarySave({ liked: false }).label, icon: 'heart' },
  unlike: { id: 'unlike', title: librarySave({ liked: true }).label, icon: 'heart.slash' },
} satisfies Record<string, TrackAction>;

type Run = ReturnType<typeof useTrackActionRunner>['run'];
/** `inset`: the row's distance from each side of the list, which its swipe actions reach past. */
type RowProps = { item: SongRowItem; run: Run; handlers: SongRowHandlers; inset?: number };
/** A row of the list that is not a song: the page's header, the footer. */
const plainRow = [listRowInsets({ top: 0, bottom: 0, leading: 0, trailing: 0 }), listRowBackground('clear'), listRowSeparator('hidden')];

/**
 * The height for the host of a native list of `rows` rows: what the list's content measures,
 * once it has been laid out, and until then `rowHeight` a row. `modifier` goes on the list.
 */
function useListHeight(rows: number) {
  const [measured, setMeasured] = useState<number | null>(null);
  const modifier = useScrollGeometryChange(measuresRows ? geometry => {
    const height = Math.ceil(geometry.contentHeight);
    if (height > 0) setMeasured(previous => (previous === height ? previous : height));
  } : undefined);
  return { height: measured ?? rows * rowHeight, modifiers: modifier ? [modifier] : [] };
}

/**
 * A short list, drawn whole: an album's tracklist, a rail of top songs, search results, or a
 * playlist being reordered. Long lists go through `useSongListItems` instead.
 */
export function SongList(props: SongListProps) {
  const { tracks, numbered, playlist, album, artist, kind, addedByNames, onUnavailable } = props;
  const { run } = useTrackActionRunner();
  const handlers = useSongRowHandlers(props, usePlaybackActions().toggleIfCurrent);
  const opens = Boolean(onUnavailable);
  const rows = useMemo(() => songRows({ tracks, numbered, playlist, album, artist, kind, addedByNames, opens }), [album, artist, numbered, playlist, tracks, kind, addedByNames, opens]);
  const onMove = moveHandler(playlist);
  const list = useListHeight(tracks.length);
  // React Native handles screen insets; the list keeps every row while its host scrolls through them.
  return (
    <Host ignoreSafeArea="container" style={{ height: list.height }}>
      <List modifiers={[...listModifiers, ...list.modifiers, environment({ key: 'editMode', value: playlist?.editing ? 'active' : 'inactive' })]}>
        <List.ForEach data={rows} keyExtractor={songRowKey} recycling={false}
          onMove={playlist && tracks.length > 1 ? onMove : undefined}>
          {({ item }) => <SongRow item={item} run={run} handlers={handlers} />}
        </List.ForEach>
      </List>
    </Host>
  );
}

/** Moves a playlist's dragged row, from `List.ForEach`'s indices (which count the row before it is taken out). */
function moveHandler(playlist: SongListProps['playlist']) {
  return ([source]: number[], destination: number) => {
    const itemId = source === undefined ? undefined : playlist?.itemIds[source];
    if (!playlist || !itemId) return;
    const index = destination > source! ? destination - 1 : destination;
    if (index !== source) playlist.onMove(itemId, index);
  };
}

/**
 * A page that is mostly a long list of songs, as one native list that scrolls the whole page.
 * The list recycles its rows: only those near the screen are drawn, and scrolling hands them
 * other songs, where a React Native list made (and threw away) a native list for every row.
 * The page's header (React Native) is the list's first row. A playlist being reordered stays
 * this one list, which drags its rows natively: drawing all of a long playlist's rows at once
 * to reorder them ran SwiftUI out of memory.
 */
export function LongSongList({ songs, header, footer, onEndReached, scrollOffset, bottomInset, inset }: LongSongListProps) {
  const { tracks, numbered, playlist, album, artist, kind, addedByNames, onUnavailable } = songs;
  const { run } = useTrackActionRunner();
  const handlers = useSongRowHandlers(songs, usePlaybackActions().toggleIfCurrent);
  const opens = Boolean(onUnavailable);
  const rows = useMemo(() => songRows({ tracks, numbered, playlist, album, artist, kind, addedByNames, opens }), [album, artist, numbered, playlist, tracks, kind, addedByNames, opens]);
  const renderRow = useCallback(({ item }: { item: SongRowItem }) => <SongRow item={item} run={run} handlers={handlers} inset={inset} />, [handlers, inset, run]);
  const endReached = useRef(onEndReached);
  endReached.current = onEndReached;
  const loadMore = useCallback(() => endReached.current?.(), []);
  // Asked once per length of the list, not on every frame near its end.
  const askedAt = useSharedValue(-1);
  // On the UI thread, as a React Native list's scroll handler is (iOS 18 and later; before
  // that the status bar edge stays clear, and the footer's appearance loads the next page).
  const geometry = useScrollGeometryChange(g => {
    'worklet';
    scrollOffset.value = g.contentOffsetY;
    if (askedAt.value !== g.contentHeight && g.contentHeight > g.containerHeight
      && nearListEnd(g.contentOffsetY, g.containerHeight, g.contentHeight)) {
      askedAt.value = g.contentHeight;
      scheduleOnRN(loadMore);
    }
  });
  const editing = Boolean(playlist?.editing);
  // React Native lays out the screen's insets: the header starts under the status bar itself.
  return (
    <Host ignoreSafeArea="container" style={{ flex: 1 }}>
      <List modifiers={[listStyle('plain'), scrollContentBackground('hidden'), scrollIndicators('hidden'), ...(geometry ? [geometry] : []),
        ...(measuresRows ? [] : [dynamicTypeSize({ max: 'xxLarge' })]), environment({ key: 'editMode', value: editing ? 'active' : 'inactive' })]}>
        <VStack modifiers={[...plainRow, frame({ maxWidth: Infinity })]}>
          <RNHostView matchContents={{ vertical: true }}><View collapsable={false}>{header}</View></RNHostView>
        </VStack>
        <List.ForEach data={rows} keyExtractor={songRowKey} estimatedItemSize={rowHeight}
          onMove={playlist && tracks.length > 1 ? moveHandler(playlist) : undefined}>
          {renderRow}
        </List.ForEach>
        <VStack modifiers={[...plainRow, frame({ maxWidth: Infinity, minHeight: bottomInset, alignment: 'top' }), onAppear(loadMore)]}>
          {footer ? <RNHostView matchContents={{ vertical: true }}><View collapsable={false}>{footer}</View></RNHostView> : <Spacer />}
        </VStack>
      </List>
    </Host>
  );
}

/**
 * The rows of a long list, for a virtualized list to render. Each row is a native list of
 * its own, so it keeps its swipe actions and context menu while only the rows near the
 * screen exist.
 */
export function useSongListItems(props: SongListProps): SongListItems {
  const { tracks, numbered, playlist, album, artist, kind, addedByNames, onUnavailable } = props;
  const { run } = useTrackActionRunner();
  const handlers = useSongRowHandlers(props, usePlaybackActions().toggleIfCurrent);
  const opens = Boolean(onUnavailable);
  const data = useMemo(() => songRows({ tracks, numbered, playlist, album, artist, kind, addedByNames, opens }), [album, artist, numbered, playlist, tracks, kind, addedByNames, opens]);
  const renderItem = useCallback(({ item }: { item: SongRowItem }) => <SongListItem item={item} run={run} handlers={handlers} />, [handlers, run]);
  return { data, renderItem, keyExtractor: songRowKey, rowHeight };
}

const SongListItem = memo(function SongListItem(props: RowProps) {
  const list = useListHeight(1);
  return <Host ignoreSafeArea="container" style={{ height: list.height }}>
    <List modifiers={[...listModifiers, ...list.modifiers]}><SongRow {...props} /></List>
  </Host>;
}, sameRowProps);

const SongRow = memo(function SongRow({ item, run, handlers, inset = 0 }: RowProps) {
  const { track, number, playlist, showArtist, album, artist } = item;
  const colors = useColors();
  const liked = useLiked('track', track.id, track.liked);
  const likeFailure = useLikeFailure('track', track.id);
  const playing = useCurrentTrackState(track.id);
  const current = playing !== null;
  const playable = useCanPlay(track);
  const { offline } = useRealtime();
  const download = useTrackDownload(track.id);
  const onItsOwn = useDownloadedOnItsOwn(track.id, download);
  const mark = downloadSymbol(download);
  const loading = useTrackLoading(track.id);
  const wantlist = useWantlistEnabled();
  const sharing = useSharingEnabled();
  const ratings = useRatingsEnabled();
  const wanted = useWanted(track.id);
  const wantFailure = useWantFailure(track.id);
  const viewer = useViewer();
  // At accessibility sizes titles and credits take more lines, and the length moves under the title.
  const { fontScale, width } = useWindowDimensions();
  const large = isAccessibilitySize(fontScale);
  // Only an album's track list shows each song's length. Web shows it on every song row, as its rows have the width.
  const duration = number !== undefined ? trackDuration(track.durationMs) : null;
  const spoken = number !== undefined ? spokenDuration(track.durationMs) : null;
  const credit = item.kind ? `${item.kind} · ${track.artistCredit}` : track.artistCredit;
  const secondLine = [showArtist && credit, item.addedByName && `Added by ${item.addedByName}`, large && spoken && duration].filter(Boolean).join(' · ');
  const rowFrame = measuresRows ? frame({ minHeight: rowHeight }) : frame({ height: rowHeight });
  const options = { playlist: playlist && { ...playlist, onRemove: handlers.remove }, album, artist };
  // Described from what the row already reads; nothing runs until an item is chosen.
  const actions = trackActions(track, { liked, likeFailure, playable, offline, current: playing, download, onItsOwn, wantlist, wanted, wantFailure, viewer, sharing, ratings }, options);
  const heart = heartButton(liked, track.title, likeFailure);
  const perform = (action: TrackAction) => run(track, action, options);

  return (
    <SwipeActions modifiers={[
      listRowInsets({ top: 0, bottom: 0, leading: inset, trailing: inset }),
      listRowBackground('clear'),
      listRowSeparator(current ? 'hidden' : 'visible', 'bottom'),
      listRowSeparatorTint(colors.stroke, 'bottom'),
    ]}>
      <HStack spacing={0} modifiers={[
        padding({ leading: 5, trailing: 2 }), rowFrame,
        // Inset from the screen's edges, the separator still ends under the menu button, as in a short list.
        ...(inset ? [alignmentGuide('listRowSeparatorTrailing', width - inset * 2 - separatorEnd)] : []),
        background(current ? colors.selection : 'clear'), clipShape('roundedRectangle', 11),
      ]}>
        <ContextMenu>
          <ContextMenu.Trigger>
            <Button onPress={playable ? () => handlers.play(item.index) : item.opens ? () => handlers.unavailable(item.index) : undefined}
              modifiers={[buttonStyle('plain'), accessibilityLabel(`${playable ? `${pressVerb(playing)} ` : ''}${track.title} by ${track.artistCredit}${item.addedByName ? `, added by ${item.addedByName}` : ''}${
                track.explicit ? ', Explicit' : ''}${spoken ? `, ${spoken}` : ''}${playable ? '' : `, ${unavailableReason(track, offline, viewer)}${
                item.opens ? '. Opens its album' : ''}`}`)]}>
              {/* A gray song fades its artwork, and its text takes colors that stay readable (3:1). */}
              <HStack spacing={10} modifiers={[rowFrame, ...(large ? [padding({ vertical: 8 })] : []), hitShape]}>
                {number !== undefined ? (
                  <HStack modifiers={[frame({ minWidth: 27 }), ...(playable ? [] : [opacity(unavailableOpacity)])]}>
                    {current && loading !== 'none' ? <ProgressView modifiers={[controlSize('small'), tint(colors.accent)]} />
                      : current ? <Image systemName={playing === 'playing' ? 'waveform' : 'pause.fill'} color={colors.accent} size={16} /> : (
                      <Text modifiers={[foregroundStyle(colors.muted), font({ textStyle: 'footnote' })]}>{String(number)}</Text>
                    )}
                  </HStack>
                ) : (
                  <ZStack modifiers={playable ? [] : [opacity(unavailableOpacity)]}><TrackCover track={track} /></ZStack>
                )}
                <VStack alignment="leading" spacing={3}>
                  <HStack spacing={5} alignment="firstTextBaseline">
                    <Text modifiers={[foregroundStyle(current ? colors.accent : playable ? colors.text : colors.fadedTitle), font({ textStyle: 'subheadline', weight: 'semibold' }), lineLimit(large ? 4 : 1)]}>{track.title}</Text>
                    {track.explicit && <Image systemName="e.square.fill" color={playable ? colors.muted : colors.fadedCredit} size={12} modifiers={[accessibilityHidden(true)]} />}
                  </HStack>
                  {/* On an album page a row by the album's artist has no second line, unless it has something else to say. */}
                  {(secondLine || mark || loading !== 'none') && <HStack spacing={3}>
                    {/* Rows with a cover have no number to swap for the spinner, so it goes before the artist. */}
                    {number === undefined && loading !== 'none' ? <ProgressView modifiers={[controlSize('mini'), tint(colors.accent)]} />
                      : mark && <Image systemName={mark as 'arrow.down.circle.fill'} color={colors.muted} size={10} />}
                    {(secondLine || loading === 'slow') && <Text modifiers={[foregroundStyle(playable ? colors.muted : colors.fadedCredit), font({ textStyle: 'caption' }), lineLimit(large ? 3 : 1)]}>
                      {loading === 'slow' ? STILL_LOADING_LABEL : secondLine}
                    </Text>}
                  </HStack>}
                </VStack>
                <Spacer minLength={5} />
                {duration && !large && <Text modifiers={[foregroundStyle(playable ? colors.muted : colors.fadedCredit), font({ textStyle: 'footnote' }),
                  monospacedDigit(), lineLimit(1), accessibilityHidden(true)]}>{duration}</Text>}
              </HStack>
            </Button>
          </ContextMenu.Trigger>
          <ContextMenu.Items><TrackActionButtons actions={actions} onRun={perform} /></ContextMenu.Items>
        </ContextMenu>
        <IconButton symbol={heart.icon} size={19} label={heart.label} selected={heart.selected}
          color={heartColor(heart, colors, colors.muted)} onPress={() => perform(liked ? quick.unlike : quick.like)} />
        <TrackActionsMenu actions={actions} onRun={perform} label={`More options for ${track.title}`} />
      </HStack>
      {playable && !current && <SwipeActions.Actions edge="leading">
        <Button label="Play next" systemImage="text.line.first.and.arrowtriangle.forward" modifiers={[swipeLabelStyle, tint('#8071D4')]}
          onPress={() => perform(quick.next)} />
      </SwipeActions.Actions>}
      <SwipeActions.Actions edge="trailing" allowsFullSwipe={false}>
        {playlist && <Button label="Remove from playlist" systemImage="trash" role="destructive" modifiers={[swipeLabelStyle]}
          onPress={() => handlers.remove(playlist.itemId)} />}
        {playable && !current && <Button label="Play next" systemImage="text.line.first.and.arrowtriangle.forward" modifiers={[swipeLabelStyle, tint('#8071D4')]}
          onPress={() => perform(quick.next)} />}
        {playable && <Button label={quick.last.title} systemImage="text.line.last.and.arrowtriangle.forward" modifiers={[swipeLabelStyle, tint('#3D826D')]}
          onPress={() => perform(quick.last)} />}
      </SwipeActions.Actions>
    </SwipeActions>
  );
}, sameRowProps);

function sameRowProps(a: RowProps, b: RowProps) {
  return a.run === b.run && a.handlers === b.handlers && a.inset === b.inset && sameRow(a.item, b.item);
}

