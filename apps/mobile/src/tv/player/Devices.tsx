import type { SessionMoveResult } from '@squirmy/client-core';
import type { DeviceInfo } from '@squirmy/contracts';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import NowPlaying from '../../../modules/now-playing';
import { useTrack } from '../../data/library';
import { usePlaybackState } from '../../playback';
import { hasQueueToBring, moveFailure, separateRows } from '../../player/detach';
import { TvButton, tvColors } from '../ui';
import { PlayerIconButton, PlayerRow } from './Primitives';

export function TvDevices() {
  const { actions, allDevices, canDetach, connection, detached, devices, output, queue, session, thisDeviceId, volume } = usePlaybackState();
  const [moving, setMoving] = useState(false);
  const moveInFlight = useRef(false);
  const [failure, setFailure] = useState<string | null>(null);
  const separate = allDevices.filter(device => device.detached && device.id !== thisDeviceId);
  const online = connection === 'online';

  const changeSession = (move: 'attach' | 'detach', run: () => Promise<SessionMoveResult>) => {
    if (moveInFlight.current) return;
    moveInFlight.current = true;
    setMoving(true);
    setFailure(null);
    void run().then(result => {
      if (!result.ok) setFailure(moveFailure(move, result.error));
    }, () => setFailure(moveFailure(move, 'internal_error'))).finally(() => {
      moveInFlight.current = false;
      setMoving(false);
    });
  };

  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      {detached ? (
        <>
          <Text style={styles.detail}>Playing separately on this Apple TV.</Text>
          <PlayerRow title="Rejoin your devices" detail="Return to the shared playback session" disabled={moving || !online}
            onPress={() => changeSession('attach', () => actions.attach())} />
          {hasQueueToBring(session, queue) && (
            <PlayerRow title="Rejoin and bring this queue" detail="Your other devices switch to this queue" disabled={moving || !online}
              onPress={() => changeSession('attach', () => actions.attach({ bringQueue: true }))} />
          )}
        </>
      ) : (
        <>
          {devices.map(device => (
            <PlayerRow key={device.id} title={device.name} detail={device.subtitle}
              active={device.active}
              leading={<DeviceSymbol icon={device.icon as SymbolViewProps['name']} />}
              disabled={!device.id || !device.canPlay || (!online && !device.active)}
              onPress={() => { if (!device.active) actions.transfer(device.id); }} />
          ))}
          {canDetach && (
            <PlayerRow title="Play separately" detail="Your other devices keep their own queue" disabled={moving || !online}
              onPress={() => changeSession('detach', actions.detach)} />
          )}
        </>
      )}
      {session.activeDeviceId && !output.reconnecting && (online || output.isThisDevice) && (
        <View style={styles.volume}>
          <View style={styles.volumeCopy}>
            <Text style={styles.title}>Volume</Text>
            <Text style={styles.detail}>{output.name}</Text>
          </View>
          <PlayerIconButton icon="speaker.wave.1" label="Lower volume" onPress={() => actions.setVolume(output.id, volume - 0.1)} />
          <Text style={styles.percentage}>{Math.round(volume * 100)}%</Text>
          <PlayerIconButton icon="speaker.wave.3" label="Raise volume" onPress={() => actions.setVolume(output.id, volume + 0.1)} />
        </View>
      )}
      {output.isThisDevice && NowPlaying?.showRoutePicker && (
        <TvButton label="AirPlay and Bluetooth" onPress={() => {
          setFailure(null);
          void NowPlaying?.showRoutePicker?.().catch(() => setFailure('Couldn’t open the audio output picker.'));
        }} />
      )}
      {separate.length > 0 && <Text accessibilityRole="header" style={styles.heading}>Playing separately</Text>}
      {separate.map(device => <SeparateDevice key={device.id} device={device} />)}
      {!online && <Text style={styles.detail}>Connect to your server to switch playback devices.</Text>}
      {failure && <Text accessibilityRole="alert" style={styles.failure}>{failure}</Text>}
    </ScrollView>
  );
}

function DeviceSymbol({ icon }: { icon: SymbolViewProps['name'] }) {
  return (
    <View style={styles.icon}>
      <SymbolView name={icon} size={26} tintColor={tvColors.accent} accessible={false} />
    </View>
  );
}

function SeparateDevice({ device }: { device: DeviceInfo }) {
  const track = useTrack(device.detached?.trackId, device.detached?.albumId);
  const [row] = separateRows([device], '', () => track?.title);
  if (!row) return null;
  return (
    <View style={styles.separate}>
      <DeviceSymbol icon={row.icon as SymbolViewProps['name']} />
      <View style={styles.volumeCopy}>
        <Text numberOfLines={1} style={styles.title}>{row.name}</Text>
        <Text numberOfLines={1} style={styles.detail}>{row.subtitle}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, minHeight: 0 },
  content: { paddingRight: 16, paddingBottom: 20, gap: 8 },
  heading: { color: tvColors.text, fontSize: 26, fontWeight: '600', paddingTop: 20 },
  title: { color: tvColors.text, fontSize: 23, fontWeight: '600' },
  detail: { color: tvColors.muted, fontSize: 20 },
  failure: { color: tvColors.danger, fontSize: 22 },
  percentage: { color: tvColors.text, fontSize: 20, fontVariant: ['tabular-nums'], minWidth: 58, textAlign: 'center' },
  volume: {
    flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 18, paddingVertical: 12,
    marginTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderColor: tvColors.border,
  },
  volumeCopy: { flex: 1, minWidth: 0, gap: 3 },
  icon: { backgroundColor: '#302743', width: 52, height: 52, alignItems: 'center', justifyContent: 'center', borderRadius: 11 },
  separate: { flexDirection: 'row', alignItems: 'center', gap: 15, paddingHorizontal: 18, paddingVertical: 9 },
});
