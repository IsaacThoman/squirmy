import { Button, Image, Menu, RNHostView } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityLabel, buttonStyle, contentShape, frame, menuIndicator, shapes,
} from '@expo/ui/swift-ui/modifiers';
import { View } from 'react-native';
import type { ComponentProps } from 'react';
import { albums, tracks } from '../catalog';
import { usePlaybackState } from '../playback';
import { Cover, colors } from '../ui';

type SymbolName = ComponentProps<typeof Image>['systemName'];
export const plainButton = buttonStyle('plain');
export const hitShape = contentShape(shapes.rectangle());
const iconFrame = frame({ width: 44, height: 44 });

export function Symbol({ name, size = 20, color }: { name: string; size?: number; color?: string }) {
  return <Image systemName={name as SymbolName} size={size} color={color} />;
}

export function IconButton({ symbol, label, size = 20, color = colors.text, width = 44, height = 44, selected, onPress }: {
  symbol: string;
  label: string;
  size?: number;
  color?: string;
  width?: number;
  height?: number;
  selected?: boolean;
  onPress?: () => void;
}) {
  return (
    <Button onPress={onPress} modifiers={[
      plainButton, accessibilityLabel(label),
      ...(selected ? [accessibilityAddTraits(['isSelected'])] : []),
    ]}>
      <Image systemName={symbol as SymbolName} size={size} color={color}
        modifiers={[frame({ width, height }), hitShape]} />
    </Button>
  );
}

export function NativeCover({ source, size, radius }: ComponentProps<typeof Cover> & { size: number }) {
  return <RNHostView matchContents>
    <View style={{ width: size, height: size }}><Cover source={source} size={size} radius={radius} /></View>
  </RNHostView>;
}

export function TrackCover({ trackId, size = 42, radius = 8 }: { trackId: string; size?: number; radius?: number }) {
  return <NativeCover source={albums[tracks[trackId].albumId].artwork} size={size} radius={radius} />;
}

export function TrackActions({ trackId }: { trackId: string }) {
  const { state, actions } = usePlaybackState();
  const liked = state.favorites.includes(trackId);
  return <>
    <Button label="Play now" systemImage="play.fill" onPress={() => {
      if (state.trackId !== trackId || !state.playing) actions.playTrack(trackId);
    }} />
    <Button label="Play next" systemImage="text.line.first.and.arrowtriangle.forward"
      onPress={() => actions.addToQueue(trackId, 'next')} />
    <Button label="Play last" systemImage="text.badge.plus" onPress={() => actions.addToQueue(trackId, 'last')} />
    <Button label={liked ? 'Remove from Liked Songs' : 'Add to Liked Songs'} systemImage={liked ? 'heart.slash' : 'heart'}
      onPress={() => actions.toggleFavorite(trackId)} />
  </>;
}

export function TrackMenu({ trackId, label, color = colors.muted, children }: {
  trackId: string; label?: string; color?: string; children?: React.ReactNode;
}) {
  return <Menu label={<Image systemName="ellipsis" size={19} color={color} modifiers={[iconFrame, hitShape]} />}
    modifiers={[plainButton, menuIndicator('hidden'), accessibilityLabel(label ?? `More options for ${tracks[trackId].title}`)]}>
    <TrackActions trackId={trackId} />
    {children}
  </Menu>;
}
