import { Button, ContextMenu, Host, HStack, Image, List, Spacer, SwipeActions, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityLabel, background, buttonStyle, clipShape, environment, font, foregroundStyle, frame,
  labelStyle, lineLimit, listRowBackground, listRowInsets, listRowSeparator, listRowSeparatorTint, listStyle, opacity, padding,
  scrollContentBackground, scrollDisabled, tint,
} from '@expo/ui/swift-ui/modifiers';
import { memo, useCallback, useMemo } from 'react';
import { StyleSheet } from 'react-native';
import { useWantlistEnabled } from '../account/AccountProvider';
import { useLiked } from '../data/library';
import { useRealtime } from '../data/realtime';
import { useCanPlay, useTrackDownload } from '../downloads/DownloadsProvider';
import { trackMark, unavailableReason } from '../downloads/model';
import { IconButton, TrackActionButtons, TrackActionsMenu, TrackCover, hitShape } from '../native/Controls';
import { useCurrentTrackState, useTrackPreparing } from '../playback';
import type { SongListProps } from './SongList';
import {
  sameRow, songRowKey, songRows, useSongRowHandlers, type SongListItems, type SongRowHandlers, type SongRowItem,
} from './rows';
import { trackActions, useDownloadedOnItsOwn, useTrackActionRunner, type TrackAction } from './trackActions';
import { unavailableOpacity, useColors } from '../theme';

export type { SongListProps } from './SongList';

const rowHeight = 58;
const swipeLabelStyle = labelStyle('iconOnly');
const listModifiers = [listStyle('plain'), scrollContentBackground('hidden'), scrollDisabled()];
const quick = {
  next: { id: 'next', title: 'Play next', icon: 'text.line.first.and.arrowtriangle.forward' },
  last: { id: 'last', title: 'Play last', icon: 'text.badge.plus' },
  like: { id: 'like', title: 'Like', icon: 'heart' },
  unlike: { id: 'unlike', title: 'Unlike', icon: 'heart.slash' },
} satisfies Record<string, TrackAction>;

type Run = ReturnType<typeof useTrackActionRunner>['run'];
type RowProps = { item: SongRowItem; run: Run; handlers: SongRowHandlers };

/**
 * A short list, drawn whole: an album's tracklist, a rail of top songs, search results, or a
 * playlist being reordered. Long lists go through `useSongListItems` instead.
 */
export function SongList(props: SongListProps) {
  const { tracks, numbered, playlist } = props;
  const { run } = useTrackActionRunner();
  const handlers = useSongRowHandlers(props);
  const rows = useMemo(() => songRows({ tracks, numbered, playlist }), [numbered, playlist, tracks]);
  const onMove = ([source]: number[], destination: number) => {
    const itemId = source === undefined ? undefined : playlist?.itemIds[source];
    if (!playlist || !itemId) return;
    const index = destination > source! ? destination - 1 : destination;
    if (index !== source) playlist.onMove(itemId, index);
  };
  // React Native handles screen insets; the list keeps every row while its host scrolls through them.
  return (
    <Host ignoreSafeArea="container" style={{ height: tracks.length * rowHeight }}>
      <List modifiers={[...listModifiers, environment({ key: 'editMode', value: playlist?.editing ? 'active' : 'inactive' })]}>
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
  const { tracks, numbered, playlist } = props;
  const { run } = useTrackActionRunner();
  const handlers = useSongRowHandlers(props);
  const data = useMemo(() => songRows({ tracks, numbered, playlist }), [numbered, playlist, tracks]);
  const renderItem = useCallback(({ item }: { item: SongRowItem }) => <SongListItem item={item} run={run} handlers={handlers} />, [handlers, run]);
  return { data, renderItem, keyExtractor: songRowKey, rowHeight };
}

const SongListItem = memo(function SongListItem(props: RowProps) {
  return <Host ignoreSafeArea="container" style={styles.item}>
    <List modifiers={listModifiers}><SongRow {...props} /></List>
  </Host>;
}, sameRowProps);

const SongRow = memo(function SongRow({ item, run, handlers }: RowProps) {
  const { track, number, playlist } = item;
  const colors = useColors();
  const liked = useLiked('track', track.id, track.liked);
  const playing = useCurrentTrackState(track.id);
  const current = playing !== null;
  const playable = useCanPlay(track);
  const { offline } = useRealtime();
  const download = useTrackDownload(track.id);
  const onItsOwn = useDownloadedOnItsOwn(track.id, download);
  const mark = trackMark(download, track, playable);
  const preparing = useTrackPreparing(track.id);
  const wantlist = useWantlistEnabled();
  const options = playlist && { playlist: { ...playlist, onRemove: handlers.remove } };
  // Described from what the row already reads; nothing runs until an item is chosen.
  const actions = trackActions(track, { liked, playable, offline, current: playing, download, onItsOwn, wantlist }, options);
  const perform = (action: TrackAction) => run(track, action, options);

  return (
    <SwipeActions modifiers={[
      listRowInsets({ top: 0, bottom: 0, leading: 0, trailing: 0 }),
      listRowBackground('clear'),
      listRowSeparator(current ? 'hidden' : 'visible', 'bottom'),
      listRowSeparatorTint(colors.stroke, 'bottom'),
    ]}>
      <HStack spacing={0} modifiers={[
        padding({ leading: 5, trailing: 2 }), frame({ height: rowHeight }),
        background(current ? colors.selection : 'clear'), clipShape('roundedRectangle', 11),
      ]}>
        <ContextMenu>
          <ContextMenu.Trigger>
            <Button onPress={playable ? () => handlers.play(item.index) : undefined}
              modifiers={[buttonStyle('plain'), accessibilityLabel(playable
                ? `Play ${track.title} by ${track.artistCredit}`
                : `${track.title} by ${track.artistCredit}, ${unavailableReason(track, offline)}`)]}>
              <HStack spacing={10} modifiers={[frame({ height: rowHeight }), hitShape, ...(playable ? [] : [opacity(unavailableOpacity)])]}>
                {number !== undefined ? (
                  <HStack modifiers={[frame({ width: 27 })]}>
                    {current ? <Image systemName={playing === 'playing' ? 'waveform' : 'pause.fill'} color={colors.accent} size={16} /> : (
                      <Text modifiers={[foregroundStyle(colors.muted), font({ size: 13 })]}>{String(number)}</Text>
                    )}
                  </HStack>
                ) : (
                  <TrackCover track={track} />
                )}
                <VStack alignment="leading" spacing={3}>
                  <Text modifiers={[foregroundStyle(current ? colors.accent : colors.text), font({ size: 15, weight: 'semibold' }), lineLimit(1)]}>{track.title}</Text>
                  <HStack spacing={3}>
                    {mark && !preparing && <Image systemName={mark as 'arrow.down.circle.fill'} color={colors.muted} size={10} />}
                    <Text modifiers={[foregroundStyle(preparing ? colors.accent : colors.muted), font({ size: 12 }), lineLimit(1)]}>
                      {preparing ? 'Preparing…' : track.artistCredit}
                    </Text>
                  </HStack>
                </VStack>
                <Spacer minLength={5} />
              </HStack>
            </Button>
          </ContextMenu.Trigger>
          <ContextMenu.Items><TrackActionButtons actions={actions} onRun={perform} /></ContextMenu.Items>
        </ContextMenu>
        <IconButton symbol={liked ? 'heart.fill' : 'heart'} size={19} label={liked ? `Unlike ${track.title}` : `Like ${track.title}`} selected={liked}
          color={liked ? colors.accent : colors.muted} onPress={() => perform(liked ? quick.unlike : quick.like)} />
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
        {playable && <Button label="Play last" systemImage="text.badge.plus" modifiers={[swipeLabelStyle, tint('#3D826D')]}
          onPress={() => perform(quick.last)} />}
      </SwipeActions.Actions>
    </SwipeActions>
  );
}, sameRowProps);

function sameRowProps(a: RowProps, b: RowProps) {
  return a.run === b.run && a.handlers === b.handlers && sameRow(a.item, b.item);
}

const styles = StyleSheet.create({ item: { height: rowHeight } });

