import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { devices, tracks } from './catalog';
import { usePlaybackState } from './playback';
import { SheetFrame, SheetRows, SheetRow, TrackSummary } from './SheetUI';
import { colors } from './ui';

export function closeSheet(router: ReturnType<typeof useRouter>) {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

function Sheet({ title, children }: { title: string; children?: ReactNode }) {
  const router = useRouter();
  return <SheetFrame title={title} onClose={() => closeSheet(router)}>{children}</SheetFrame>;
}

export function DeviceSheet() {
  const { track, device, actions } = usePlaybackState();
  return (
    <Sheet title="Playback device">
      <TrackSummary id={track.id} />
      <SheetRows>
        {devices.map(candidate => (
          <SheetRow key={candidate.id} title={candidate.name} icon={candidate.icon}
            subtitle={device.id === candidate.id ? 'Current output' : candidate.subtitle}
            selected={device.id === candidate.id}
            color={device.id === candidate.id ? colors.accent : colors.text}
            onPress={() => {
              actions.setDevice(candidate.id);
              void Haptics.selectionAsync();
            }} />
        ))}
      </SheetRows>
    </Sheet>
  );
}

export function TrackActionSheet({ id }: { id: string }) {
  const router = useRouter();
  const { state, actions } = usePlaybackState();
  if (!Object.hasOwn(tracks, id)) return <Sheet title="Track unavailable" />;
  const favorite = state.favorites.includes(id);
  const perform = (action: () => void) => {
    action();
    void Haptics.selectionAsync();
    closeSheet(router);
  };
  return (
    <Sheet title="Track options">
      <TrackSummary id={id} />
      <SheetRows>
        <SheetRow title="Play now" icon="play.fill" onPress={() => perform(() => {
          if (state.trackId !== id || !state.playing) actions.playTrack(id);
        })} />
        <SheetRow title="Play next" icon="text.line.first.and.arrowtriangle.forward"
          onPress={() => perform(() => actions.addToQueue(id, 'next'))} />
        <SheetRow title="Play last" icon="text.badge.plus"
          onPress={() => perform(() => actions.addToQueue(id, 'last'))} />
        <SheetRow title={favorite ? 'Remove from Liked Songs' : 'Add to Liked Songs'} icon={favorite ? 'heart.fill' : 'heart'}
          onPress={() => perform(() => actions.toggleFavorite(id))} />
      </SheetRows>
    </Sheet>
  );
}
