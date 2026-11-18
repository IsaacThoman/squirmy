import { Button, ContextMenu, Host, HStack, Image, List, Menu, RNHostView, Spacer, SwipeActions, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityLabel, background, buttonStyle, clipShape, contentShape, font, foregroundStyle, frame,
  lineLimit, listRowBackground, listRowInsets, listRowSeparator, listRowSeparatorTint, listStyle, menuIndicator, padding,
  scrollContentBackground, scrollDisabled, shapes, tint,
} from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';
import { albums, tracks } from '../catalog';
import { usePlaybackState } from '../playback';
import { colors, Cover } from '../ui';
import type { SongListProps } from './SongList';

const rowHeight = 58;
const tapArea = frame({ width: 44, height: 44 });
const tappable = contentShape(shapes.rectangle());

export function SongList({ trackIds, numbered, onPlay }: SongListProps) {
  const { state, actions } = usePlaybackState();
  return (
    <Host colorScheme="dark" style={{ height: trackIds.length * rowHeight }}>
      <List modifiers={[listStyle('plain'), scrollContentBackground('hidden'), scrollDisabled()]}>
        {trackIds.map((id, index) => {
          const track = tracks[id];
          const current = state.trackId === id;
          const liked = state.favorites.includes(id);
          const favoriteLabel = liked ? `Unlike ${track.title}` : `Like ${track.title}`;
          const playNext = () => actions.addToQueue(id, 'next');
          const toggleFavorite = () => actions.toggleFavorite(id);

          const menuItems = (
            <>
              <Button label="Play now" systemImage="play.fill" onPress={() => {
                if (!current || !state.playing) actions.playTrack(id);
              }} />
              <Button label="Play next" systemImage="text.line.first.and.arrowtriangle.forward" onPress={playNext} />
              <Button label="Play last" systemImage="text.badge.plus" onPress={() => actions.addToQueue(id, 'last')} />
              <Button label={liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'}
                systemImage={liked ? 'heart.slash' : 'heart'} onPress={toggleFavorite} />
            </>
          );

          return (
            <SwipeActions key={id} modifiers={[
              listRowInsets({ top: 0, bottom: 0, leading: 0, trailing: 0 }),
              listRowBackground('clear'),
              listRowSeparator(current ? 'hidden' : 'visible', 'bottom'),
              listRowSeparatorTint('#FFFFFF16', 'bottom'),
            ]}>
              <HStack spacing={0} modifiers={[
                padding({ leading: 5, trailing: 2 }), frame({ height: rowHeight }),
                background(current ? '#CBC1FF12' : 'clear'), clipShape('roundedRectangle', 11),
              ]}>
                <ContextMenu>
                  <ContextMenu.Trigger>
                    <Button onPress={() => onPlay(id)}
                      modifiers={[buttonStyle('plain'), accessibilityLabel(`Play ${track.title} by ${track.artist}`)]}>
                      <HStack spacing={10} modifiers={[frame({ height: rowHeight }), tappable]}>
                        {numbered ? (
                          <HStack modifiers={[frame({ width: 27 })]}>
                            {current ? <Image systemName={state.playing ? 'waveform' : 'pause.fill'} color={colors.accent} size={16} /> : (
                              <Text modifiers={[foregroundStyle(colors.muted), font({ size: 13 })]}>{String(index + 1)}</Text>
                            )}
                          </HStack>
                        ) : (
                          <RNHostView matchContents>
                            <View style={{ width: 42, height: 42 }}>
                              <Cover source={albums[track.albumId].artwork} size={42} radius={8} />
                            </View>
                          </RNHostView>
                        )}
                        <VStack alignment="leading" spacing={3}>
                          <Text modifiers={[foregroundStyle(current ? colors.accent : colors.text), font({ size: 15, weight: 'semibold' }), lineLimit(1)]}>{track.title}</Text>
                          <Text modifiers={[foregroundStyle(colors.muted), font({ size: 12 }), lineLimit(1)]}>{track.artist}</Text>
                        </VStack>
                        <Spacer minLength={5} />
                      </HStack>
                    </Button>
                  </ContextMenu.Trigger>
                  <ContextMenu.Items>{menuItems}</ContextMenu.Items>
                </ContextMenu>
                <Button onPress={toggleFavorite}
                  modifiers={[buttonStyle('plain'), accessibilityLabel(favoriteLabel), ...(liked ? [accessibilityAddTraits(['isSelected'])] : [])]}>
                  <Image systemName={liked ? 'heart.fill' : 'heart'} size={19}
                    color={liked ? colors.accent : colors.muted} modifiers={[tapArea, tappable]} />
                </Button>
                <Menu label={<Image systemName="ellipsis" size={19} color={colors.muted} modifiers={[tapArea, tappable]} />}
                  modifiers={[buttonStyle('plain'), menuIndicator('hidden'), accessibilityLabel(`More options for ${track.title}`)]}>
                  {menuItems}
                </Menu>
              </HStack>
              <SwipeActions.Actions edge="leading">
                <Button label="Play next" systemImage="text.line.first.and.arrowtriangle.forward" modifiers={[tint('#8071D4')]} onPress={playNext} />
              </SwipeActions.Actions>
              <SwipeActions.Actions edge="trailing" allowsFullSwipe={false}>
                <Button label="Play next" systemImage="text.line.first.and.arrowtriangle.forward" modifiers={[tint('#8071D4')]} onPress={playNext} />
                <Button label="Play last" systemImage="text.badge.plus" modifiers={[tint('#3D826D')]} onPress={() => actions.addToQueue(id, 'last')} />
              </SwipeActions.Actions>
            </SwipeActions>
          );
        })}
      </List>
    </Host>
  );
}
