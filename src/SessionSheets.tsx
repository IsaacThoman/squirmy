import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import { type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { devices, formatTime, tracks, albums } from './catalog';
import { usePlayback, usePlaybackState } from './playback';
import { Cover, Icon, colors } from './ui';

export function closeSheet(router: ReturnType<typeof useRouter>) {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

function Sheet({ title, children }: { title: string; children?: ReactNode }) {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.sheet, { paddingBottom: Math.max(23, insets.bottom + 8) }]}>
      <View style={styles.sheetHeader}>
        <Text accessibilityRole="header" style={styles.heading}>{title}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" style={styles.close}
          onPress={() => closeSheet(router)}>
          <Icon name="xmark" size={15} />
        </Pressable>
      </View>
      {children}
    </View>
  );
}

function SheetRow({ title, subtitle, icon, color = colors.text, selected, onPress, trailing }: {
  title: string; subtitle?: string; icon: string; color?: string;
  selected?: boolean; onPress: () => void; trailing?: string;
}) {
  return (
    <Pressable accessibilityRole="button" accessibilityState={selected === undefined ? undefined : { selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.sheetRow, selected && styles.selectedRow, pressed && styles.pressed]}>
      <View style={[styles.rowIcon, selected && styles.selectedIcon]}><Icon name={icon} size={20} color={color} /></View>
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{title}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
      </View>
      {(selected || trailing) && <Icon name={selected ? 'checkmark' : trailing!} size={17} color={selected ? colors.accent : colors.muted} />}
    </Pressable>
  );
}

function TrackSummary({ id }: { id: string }) {
  const item = tracks[id];
  return (
    <View style={styles.trackSummary}>
      <Cover source={albums[item.albumId].artwork} size={53} radius={10} />
      <View style={styles.flex}>
        <Text numberOfLines={1} style={styles.rowTitle}>{item.title}</Text>
        <Text numberOfLines={1} style={styles.rowSubtitle}>{item.artist}</Text>
      </View>
      <Icon name="waveform" size={22} color={colors.accent} />
    </View>
  );
}

export function DeviceSheet() {
  const router = useRouter();
  const { track, device, actions } = usePlaybackState();
  return (
    <Sheet title="Playback device">
      <TrackSummary id={track.id} />
      <View style={styles.rows}>
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
        <SheetRow title="Preview remote controls" icon="laptopcomputer" trailing="chevron.right"
          onPress={() => router.replace('/session')} />
      </View>
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
      <View style={styles.rows}>
        <SheetRow title="Play now" icon="play.fill" onPress={() => perform(() => {
          if (state.trackId !== id || !state.playing) actions.playTrack(id);
        })} />
        <SheetRow title="Play next" icon="text.line.first.and.arrowtriangle.forward"
          onPress={() => perform(() => actions.addToQueue(id, 'next'))} />
        <SheetRow title="Play last" icon="text.badge.plus"
          onPress={() => perform(() => actions.addToQueue(id, 'last'))} />
        <SheetRow title={favorite ? 'Remove from Liked Songs' : 'Add to Liked Songs'} icon={favorite ? 'heart.fill' : 'heart'}
          onPress={() => perform(() => actions.toggleFavorite(id))} />
      </View>
    </Sheet>
  );
}

export function RemoteSessionSheet() {
  const router = useRouter();
  const { track, device, state, position, actions } = usePlayback();
  const next = state.queue[0] ?? (state.autoplay ? state.autoplayQueue[0] : undefined);
  return (
    <Sheet title="MacBook remote">
      <TrackSummary id={track.id} />
      <View style={styles.remoteStatus}>
        <Text style={styles.rowSubtitle}>{formatTime(position)} / {formatTime(track.duration)}</Text>
        <Text style={styles.rowSubtitle}>Output · {device.name}</Text>
      </View>
      <View style={styles.remoteControls}>
        <Pressable accessibilityRole="button" accessibilityLabel="Previous track" style={styles.control} onPress={actions.previous}>
          <Icon name="backward.fill" size={25} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={state.playing ? 'Pause' : 'Play'}
          style={[styles.control, styles.primaryControl]} onPress={actions.playPause}>
          <Icon name={state.playing ? 'pause.fill' : 'play.fill'} size={26} color="#1a1424" />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Next track" style={styles.control} onPress={actions.next}>
          <Icon name="forward.fill" size={25} />
        </Pressable>
      </View>
      <View style={styles.rows}>
        <SheetRow title="Up next" subtitle={next ? tracks[next.trackId].title : 'Queue is empty'}
          icon="list.bullet" trailing="chevron.right" onPress={() => router.replace({ pathname: '/player', params: { page: 'queue' } })} />
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  sheet: { paddingTop: 27, paddingHorizontal: 22, gap: 15 },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', minHeight: 36 },
  heading: { color: colors.text, fontSize: 25, fontWeight: '700', letterSpacing: -0.7, flexShrink: 1 },
  close: { width: 37, height: 37, borderRadius: 19, backgroundColor: '#ffffff17', alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, gap: 3 },
  trackSummary: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 4, paddingVertical: 3 },
  rows: { gap: 6 },
  sheetRow: { minHeight: 54, flexDirection: 'row', gap: 11, alignItems: 'center', paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, backgroundColor: '#ffffff0c' },
  selectedRow: { backgroundColor: '#cbc1ff25' },
  pressed: { opacity: 0.73 },
  rowIcon: { width: 33, height: 33, borderRadius: 11, backgroundColor: '#ffffff0d', justifyContent: 'center', alignItems: 'center' },
  selectedIcon: { backgroundColor: '#cbc1ff23' },
  rowTitle: { color: colors.text, fontSize: 15, fontWeight: '600' },
  rowSubtitle: { color: colors.muted, fontSize: 13, fontWeight: '500' },
  remoteStatus: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4, gap: 10 },
  remoteControls: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 28, paddingVertical: 8 },
  control: { width: 52, height: 52, alignItems: 'center', justifyContent: 'center' },
  primaryControl: { width: 62, height: 62, borderRadius: 31, backgroundColor: colors.accent },
});
