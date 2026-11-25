import { Button, ContextMenu, Host, HStack, Image, List, ProgressView, Spacer, SwipeActions, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  accessibilityHidden, accessibilityLabel, background, buttonStyle, clipShape, controlSize, dynamicTypeSize, environment, font, foregroundStyle, frame,
  labelStyle, lineLimit, listRowBackground, listRowInsets, listRowSeparator, listRowSeparatorTint, listStyle, monospacedDigit, opacity, padding,
  scrollContentBackground, scrollDisabled, tint, useScrollGeometryChange,
} from '@expo/ui/swift-ui/modifiers';
import { librarySave } from '@squirmy/client-core';
import { memo, useCallback, useMemo, useState } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { useWantlistEnabled } from '../account/AccountProvider';
import { useLiked, useLikeFailure, useWanted, useWantFailure } from '../data/library';
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
  pressVerb, sameRow, songRowKey, songRows, useSongRowHandlers, type SongListItems, type SongRowHandlers, type SongRowItem,
} from './rows';
import { trackActions, useDownloadedOnItsOwn, useTrackActionRunner, type TrackAction } from './trackActions';
import { unavailableOpacity, useColors } from '../theme';

export type { SongListProps } from './SongList';

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
type RowProps = { item: SongRowItem; run: Run; handlers: SongRowHandlers };

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
  const { tracks, numbered, playlist, album, kind, onUnavailable } = props;
  const { run } = useTrackActionRunner();
  const handlers = useSongRowHandlers(props, usePlaybackActions().toggleIfCurrent);
  const opens = Boolean(onUnavailable);
  const rows = useMemo(() => songRows({ tracks, numbered, playlist, album, kind, opens }), [album, numbered, playlist, tracks, kind, opens]);
  const onMove = ([source]: number[], destination: number) => {
    const itemId = source === undefined ? undefined : playlist?.itemIds[source];
    if (!playlist || !itemId) return;
    const index = destination > source! ? destination - 1 : destination;
    if (index !== source) playlist.onMove(itemId, index);
  };
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

/**
 * The rows of a long list, for a virtualized list to render. Each row is a native list of
 * its own, so it keeps its swipe actions and context menu while only the rows near the
 * screen exist.
 */
export function useSongListItems(props: SongListProps): SongListItems {
  const { tracks, numbered, playlist, album, kind, onUnavailable } = props;
  const { run } = useTrackActionRunner();
  const handlers = useSongRowHandlers(props, usePlaybackActions().toggleIfCurrent);
  const opens = Boolean(onUnavailable);
  const data = useMemo(() => songRows({ tracks, numbered, playlist, album, kind, opens }), [album, numbered, playlist, tracks, kind, opens]);
  const renderItem = useCallback(({ item }: { item: SongRowItem }) => <SongListItem item={item} run={run} handlers={handlers} />, [handlers, run]);
  return { data, renderItem, keyExtractor: songRowKey, rowHeight };
}

const SongListItem = memo(function SongListItem(props: RowProps) {
  const list = useListHeight(1);
  return <Host ignoreSafeArea="container" style={{ height: list.height }}>
    <List modifiers={[...listModifiers, ...list.modifiers]}><SongRow {...props} /></List>
  </Host>;
}, sameRowProps);

const SongRow = memo(function SongRow({ item, run, handlers }: RowProps) {
  const { track, number, playlist, showArtist, album } = item;
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
  const wanted = useWanted(track.id);
  const wantFailure = useWantFailure(track.id);
  const viewer = useViewer();
  // At accessibility sizes titles and credits take more lines, and the length moves under the title.
  const large = isAccessibilitySize(useWindowDimensions().fontScale);
  // Only an album's track list shows each song's length, as on web.
  const duration = number !== undefined ? trackDuration(track.durationMs) : null;
  const spoken = number !== undefined ? spokenDuration(track.durationMs) : null;
  const credit = item.kind ? `${item.kind} · ${track.artistCredit}` : track.artistCredit;
  const secondLine = [showArtist && credit, large && spoken && duration].filter(Boolean).join(' · ');
  const rowFrame = measuresRows ? frame({ minHeight: rowHeight }) : frame({ height: rowHeight });
  const options = { playlist: playlist && { ...playlist, onRemove: handlers.remove }, album };
  // Described from what the row already reads; nothing runs until an item is chosen.
  const actions = trackActions(track, { liked, likeFailure, playable, offline, current: playing, download, onItsOwn, wantlist, wanted, wantFailure, viewer }, options);
  const heart = heartButton(liked, track.title, likeFailure);
  const perform = (action: TrackAction) => run(track, action, options);

  return (
    <SwipeActions modifiers={[
      listRowInsets({ top: 0, bottom: 0, leading: 0, trailing: 0 }),
      listRowBackground('clear'),
      listRowSeparator(current ? 'hidden' : 'visible', 'bottom'),
      listRowSeparatorTint(colors.stroke, 'bottom'),
    ]}>
      <HStack spacing={0} modifiers={[
        padding({ leading: 5, trailing: 2 }), rowFrame,
        background(current ? colors.selection : 'clear'), clipShape('roundedRectangle', 11),
      ]}>
        <ContextMenu>
          <ContextMenu.Trigger>
            <Button onPress={playable ? () => handlers.play(item.index) : item.opens ? () => handlers.unavailable(item.index) : undefined}
              modifiers={[buttonStyle('plain'), accessibilityLabel(`${playable ? `${pressVerb(playing)} ` : ''}${track.title} by ${track.artistCredit}${
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
  return a.run === b.run && a.handlers === b.handlers && sameRow(a.item, b.item);
}

