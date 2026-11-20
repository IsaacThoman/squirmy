import { Button, ContextMenu, Host, HStack, Image, List, Spacer, SwipeActions, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityLabel, background, buttonStyle, clipShape, environment, font, foregroundStyle, frame,
  labelStyle, lineLimit, listRowBackground, listRowInsets, listRowSeparator, listRowSeparatorTint, listStyle, opacity, padding,
  scrollContentBackground, scrollDisabled, tint,
} from '@expo/ui/swift-ui/modifiers';
import type { TrackSummary } from '@squirmy/contracts';
import { useLibraryActions, useLiked } from '../data/library';
import { useRealtime } from '../data/realtime';
import { useCanPlay, useTrackDownload } from '../downloads/DownloadsProvider';
import { downloadSymbol, unavailableReason } from '../downloads/model';
import { IconButton, TrackActions, TrackCover, TrackMenu, hitShape } from '../native/Controls';
import { usePlaybackState } from '../playback';
import type { SongListProps } from './SongList';
import { unavailableOpacity, useColors } from '../theme';

const rowHeight = 58;
const swipeLabelStyle = labelStyle('iconOnly');

export function SongList({ tracks, numbered, onPlay, playlist }: SongListProps) {
  const rows = tracks.map((track, index) => ({ key: playlist?.itemIds[index] ?? `${track.id}:${index}`, track, index }));
  const onMove = ([source]: number[], destination: number) => {
    const itemId = source === undefined ? undefined : playlist?.itemIds[source];
    if (!playlist || !itemId) return;
    const index = destination > source! ? destination - 1 : destination;
    if (index !== source) playlist.onMove(itemId, index);
  };
  // React Native handles screen insets; the list keeps every row while its host scrolls through them.
  return (
    <Host ignoreSafeArea="container" style={{ height: tracks.length * rowHeight }}>
      <List modifiers={[listStyle('plain'), scrollContentBackground('hidden'), scrollDisabled(),
        environment({ key: 'editMode', value: playlist?.editing ? 'active' : 'inactive' })]}>
        <List.ForEach data={rows} keyExtractor={row => row.key} recycling={false}
          onMove={playlist && tracks.length > 1 ? onMove : undefined}>
          {({ item }) => <SongRow track={item.track} number={numbered ? item.track.position ?? item.index + 1 : undefined}
            onPlay={() => onPlay(item.index)} playlist={playlist && { id: playlist.id, itemId: playlist.itemIds[item.index]!, onRemove: playlist.onRemove }} />}
        </List.ForEach>
      </List>
    </Host>
  );
}

function SongRow({ track, number, onPlay, playlist }: {
  track: TrackSummary;
  number?: number;
  onPlay: () => void;
  playlist?: { id: string; itemId: string; onRemove: (itemId: string) => void };
}) {
  const colors = useColors();
  const { session, actions } = usePlaybackState();
  const liked = useLiked('track', track.id, track.liked);
  const { setLiked } = useLibraryActions();
  const current = session.current?.trackId === track.id;
  const playable = useCanPlay(track);
  const { offline } = useRealtime();
  const mark = downloadSymbol(useTrackDownload(track.id));
  const favoriteLabel = liked ? `Unlike ${track.title}` : `Like ${track.title}`;
  const playNext = () => actions.enqueue([track], 'next');
  const options = playlist && { playlist: { id: playlist.id, itemId: playlist.itemId } };

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
            <Button onPress={playable ? onPlay : undefined}
              modifiers={[buttonStyle('plain'), accessibilityLabel(playable
                ? `Play ${track.title} by ${track.artistCredit}`
                : `${track.title} by ${track.artistCredit}, ${unavailableReason(track, offline)}`)]}>
              <HStack spacing={10} modifiers={[frame({ height: rowHeight }), hitShape, ...(playable ? [] : [opacity(unavailableOpacity)])]}>
                {number !== undefined ? (
                  <HStack modifiers={[frame({ width: 27 })]}>
                    {current ? <Image systemName={session.playing ? 'waveform' : 'pause.fill'} color={colors.accent} size={16} /> : (
                      <Text modifiers={[foregroundStyle(colors.muted), font({ size: 13 })]}>{String(number)}</Text>
                    )}
                  </HStack>
                ) : (
                  <TrackCover track={track} />
                )}
                <VStack alignment="leading" spacing={3}>
                  <Text modifiers={[foregroundStyle(current ? colors.accent : colors.text), font({ size: 15, weight: 'semibold' }), lineLimit(1)]}>{track.title}</Text>
                  <HStack spacing={3}>
                    {mark && <Image systemName={mark as 'arrow.down.circle.fill'} color={colors.muted} size={10} />}
                    <Text modifiers={[foregroundStyle(colors.muted), font({ size: 12 }), lineLimit(1)]}>{track.artistCredit}</Text>
                  </HStack>
                </VStack>
                <Spacer minLength={5} />
              </HStack>
            </Button>
          </ContextMenu.Trigger>
          <ContextMenu.Items><TrackActions track={track} options={options} /></ContextMenu.Items>
        </ContextMenu>
        <IconButton symbol={liked ? 'heart.fill' : 'heart'} size={19} label={favoriteLabel} selected={liked}
          color={liked ? colors.accent : colors.muted} onPress={() => setLiked('track', track.id, !liked)} />
        <TrackMenu track={track} options={options} />
      </HStack>
      {playable && <SwipeActions.Actions edge="leading">
        <Button label="Play next" systemImage="text.line.first.and.arrowtriangle.forward" modifiers={[swipeLabelStyle, tint('#8071D4')]} onPress={playNext} />
      </SwipeActions.Actions>}
      <SwipeActions.Actions edge="trailing" allowsFullSwipe={false}>
        {playlist && <Button label="Remove from playlist" systemImage="trash" role="destructive" modifiers={[swipeLabelStyle]}
          onPress={() => playlist.onRemove(playlist.itemId)} />}
        {playable && <Button label="Play next" systemImage="text.line.first.and.arrowtriangle.forward" modifiers={[swipeLabelStyle, tint('#8071D4')]} onPress={playNext} />}
        {playable && <Button label="Play last" systemImage="text.badge.plus" modifiers={[swipeLabelStyle, tint('#3D826D')]} onPress={() => actions.enqueue([track], 'last')} />}
      </SwipeActions.Actions>
    </SwipeActions>
  );
}
