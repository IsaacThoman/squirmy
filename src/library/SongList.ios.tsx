import { Button, ContextMenu, Host, HStack, Image, List, Spacer, SwipeActions, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityLabel, background, buttonStyle, clipShape, font, foregroundStyle, frame,
  labelStyle, lineLimit, listRowBackground, listRowInsets, listRowSeparator, listRowSeparatorTint, listStyle, padding,
  scrollContentBackground, scrollDisabled, tint,
} from '@expo/ui/swift-ui/modifiers';
import { tracks } from '../catalog';
import { IconButton, TrackActions, TrackCover, TrackMenu, hitShape } from '../native/Controls';
import { usePlaybackState } from '../playback';
import type { SongListProps } from './SongList';
import { useColors } from '../theme';

const rowHeight = 58;
const swipeLabelStyle = labelStyle('iconOnly');

export function SongList({ trackIds, numbered, onPlay }: SongListProps) {
  const colors = useColors();
  const { state, actions } = usePlaybackState();
  return (
    <Host style={{ height: trackIds.length * rowHeight }}>
      <List modifiers={[listStyle('plain'), scrollContentBackground('hidden'), scrollDisabled()]}>
        {trackIds.map((id, index) => {
          const track = tracks[id];
          const current = state.trackId === id;
          const liked = state.favorites.includes(id);
          const favoriteLabel = liked ? `Unlike ${track.title}` : `Like ${track.title}`;
          const playNext = () => actions.addToQueue(id, 'next');
          const toggleFavorite = () => actions.toggleFavorite(id);

          return (
            <SwipeActions key={id} modifiers={[
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
                    <Button onPress={() => onPlay(id)}
                      modifiers={[buttonStyle('plain'), accessibilityLabel(`Play ${track.title} by ${track.artist}`)]}>
                      <HStack spacing={10} modifiers={[frame({ height: rowHeight }), hitShape]}>
                        {numbered ? (
                          <HStack modifiers={[frame({ width: 27 })]}>
                            {current ? <Image systemName={state.playing ? 'waveform' : 'pause.fill'} color={colors.accent} size={16} /> : (
                              <Text modifiers={[foregroundStyle(colors.muted), font({ size: 13 })]}>{String(index + 1)}</Text>
                            )}
                          </HStack>
                        ) : (
                          <TrackCover trackId={id} />
                        )}
                        <VStack alignment="leading" spacing={3}>
                          <Text modifiers={[foregroundStyle(current ? colors.accent : colors.text), font({ size: 15, weight: 'semibold' }), lineLimit(1)]}>{track.title}</Text>
                          <Text modifiers={[foregroundStyle(colors.muted), font({ size: 12 }), lineLimit(1)]}>{track.artist}</Text>
                        </VStack>
                        <Spacer minLength={5} />
                      </HStack>
                    </Button>
                  </ContextMenu.Trigger>
                  <ContextMenu.Items><TrackActions trackId={id} /></ContextMenu.Items>
                </ContextMenu>
                <IconButton symbol={liked ? 'heart.fill' : 'heart'} size={19} label={favoriteLabel} selected={liked}
                  color={liked ? colors.accent : colors.muted} onPress={toggleFavorite} />
                <TrackMenu trackId={id} />
              </HStack>
              <SwipeActions.Actions edge="leading">
                <Button label="Play next" systemImage="text.line.first.and.arrowtriangle.forward" modifiers={[swipeLabelStyle, tint('#8071D4')]} onPress={playNext} />
              </SwipeActions.Actions>
              <SwipeActions.Actions edge="trailing" allowsFullSwipe={false}>
                <Button label="Play next" systemImage="text.line.first.and.arrowtriangle.forward" modifiers={[swipeLabelStyle, tint('#8071D4')]} onPress={playNext} />
                <Button label="Play last" systemImage="text.badge.plus" modifiers={[swipeLabelStyle, tint('#3D826D')]} onPress={() => actions.addToQueue(id, 'last')} />
              </SwipeActions.Actions>
            </SwipeActions>
          );
        })}
      </List>
    </Host>
  );
}
