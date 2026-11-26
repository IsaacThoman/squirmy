import type { SessionMoveResult } from '@squirmy/client-core';
import type { DeviceInfo } from '@squirmy/contracts';
import { BlurView } from 'expo-blur';
import { useIsFocused, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTrack } from '../../data/library';
import { usePlaybackState } from '../../playback';
import { DETACHED_SYMBOL, detachedHeader, hasQueueToBring, moveFailure, separateRows } from '../../player/detach';
import { whereItPlays } from '../../player/session';
import { Icon } from '../../ui';
import { Button } from '../Button';
import { Focusable } from '../Focusable';
import { colors, type } from '../theme';
import { useMenuKey } from './useMenuKey';

const panelWidth = 760;

/**
 * Where the music plays, in a glass panel at the side of the screen as the system's own audio
 * picker opens: this Apple TV first, then the user's other devices that can play, the one
 * playing marked. Selecting one moves the music there; it carries on from where it was. From
 * here this Apple TV can also play on its own, apart from the other devices, and rejoin them.
 */
export function DevicesScreen() {
  const { track, devices, output, volume, session, queue, actions, detached, canDetach, allDevices, thisDeviceId, connection } = usePlaybackState();
  const [moving, setMoving] = useState<'detach' | 'attach' | 'bring' | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const router = useRouter();
  // Menu closes the panel, back to Now Playing.
  useMenuKey(useIsFocused(), () => router.back());
  const appear = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.spring(appear, { toValue: 1, speed: 14, bounciness: 0, useNativeDriver: true }).start();
  }, [appear]);
  // The panel turns to the other way of playing: what failed in the last one no longer applies.
  useEffect(() => setFailure(null), [detached]);
  const online = connection === 'online';
  const separate = allDevices.filter(device => device.detached && device.id !== thisDeviceId);
  const move = (run: () => Promise<SessionMoveResult>, kind: 'detach' | 'attach' | 'bring') => {
    if (moving) return;
    setMoving(kind);
    setFailure(null);
    void run().then(result => {
      setMoving(null);
      if (!result.ok) setFailure(moveFailure(kind === 'detach' ? 'detach' : 'attach', result.error));
    }, () => {
      setMoving(null);
      setFailure(moveFailure(kind === 'detach' ? 'detach' : 'attach', 'internal_error'));
    });
  };
  const header = detached ? detachedHeader(track, session.playing)
    : { title: 'Playback device', subtitle: session.activeDeviceId ? whereItPlays(output, session.playing ? 'Playing' : 'Paused') : 'Nothing playing' };
  const remoteVolume = !detached && session.activeDeviceId && !output.reconnecting && !output.isThisDevice && online;
  const preferred = devices.find(device => device.active) ?? devices[0];

  return <View style={styles.screen}>
    <Animated.View style={[styles.dim, { opacity: appear }]} />
    <Animated.View style={[styles.panel, { opacity: appear, transform: [{ translateX: appear.interpolate({ inputRange: [0, 1], outputRange: [80, 0] }) }] }]}>
      <BlurView tint="dark" intensity={90} style={StyleSheet.absoluteFill} />
      <View style={styles.wash} />
      <ScrollView contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
        <Text accessibilityRole="header" style={styles.title}>{header.title}</Text>
        <Text numberOfLines={2} style={styles.subtitle}>{header.subtitle}</Text>
        <View style={styles.rows}>
          {detached ? <>
            <Row title="Rejoin your other devices" subtitle="This Apple TV’s queue is cleared." icon="arrow.uturn.backward"
              busy={moving === 'attach'} disabled={!online} preferred onPress={() => move(() => actions.attach(), 'attach')} />
            {hasQueueToBring(session, queue) && <Row title="Bring this queue with me" icon="arrow.triangle.merge"
              subtitle="Your other devices switch to what’s playing here" busy={moving === 'bring'} disabled={!online}
              onPress={() => move(() => actions.attach({ bringQueue: true }), 'bring')} />}
          </> : <>
            {devices.map(device => <Row key={device.id || 'this'} title={device.name} subtitle={device.subtitle} icon={device.icon}
              active={device.active} preferred={device === preferred}
              disabled={!device.id || !device.canPlay || Boolean(device.reconnecting) || (!online && !device.active)}
              onPress={() => { if (!device.active) actions.transfer(device.id); }} />)}
            {canDetach && <Row title="Play separately on this Apple TV" subtitle="Your other devices keep their own queue."
              icon={DETACHED_SYMBOL} busy={moving === 'detach'} disabled={!online} onPress={() => move(() => actions.detach(), 'detach')} />}
          </>}
        </View>
        {remoteVolume && <View style={styles.volume}>
          <View style={styles.volumeWords}>
            <Text style={styles.rowTitle}>Volume</Text>
            <Text numberOfLines={1} style={styles.rowSubtitle}>{output.name}</Text>
          </View>
          <Button icon="speaker.minus.fill" accessibilityLabel={`Lower the volume on ${output.name}`}
            onPress={() => actions.setVolume(output.id, volume - 0.1)} />
          <Text style={styles.percent}>{`${Math.round(volume * 100)}%`}</Text>
          <Button icon="speaker.plus.fill" accessibilityLabel={`Raise the volume on ${output.name}`}
            onPress={() => actions.setVolume(output.id, volume + 0.1)} />
        </View>}
        {failure && <Text accessibilityRole="alert" style={styles.failure}>{failure}</Text>}
        {!online && <Text style={styles.note}>Connect to your server to switch playback devices.</Text>}
        {separate.length > 0 && <>
          <Text accessibilityRole="header" style={styles.section}>Playing separately</Text>
          {separate.map(device => <SeparateDevice key={device.id} device={device} />)}
        </>}
      </ScrollView>
    </Animated.View>
  </View>;
}

function Row({ title, subtitle, icon, active, busy, disabled, preferred, onPress }: {
  title: string;
  subtitle?: string;
  icon: string;
  active?: boolean;
  busy?: boolean;
  disabled?: boolean;
  preferred?: boolean;
  onPress: () => void;
}) {
  return <Focusable
    accessibilityLabel={[title, subtitle, active ? 'Selected' : null].filter(Boolean).join(', ')}
    accessibilityState={{ selected: active, disabled, busy }}
    onPress={disabled || busy ? undefined : onPress}
    hasTVPreferredFocus={preferred}
    scale={1.03}
    liftStyle={({ focused }) => [styles.row, focused && styles.rowFocused]}
  >
    {({ focused }) => {
      const ink = focused ? colors.onFocused : disabled ? colors.tertiary : colors.text;
      return <>
        <View style={[styles.icon, focused && styles.iconFocused, active && !focused && styles.iconActive]}>
          <Icon name={icon} size={34} color={active && !focused ? colors.onFocused : ink} />
        </View>
        <View style={styles.words}>
          <Text numberOfLines={1} style={[styles.rowTitle, { color: ink }]}>{title}</Text>
          {subtitle ? <Text numberOfLines={2} style={[styles.rowSubtitle, focused && styles.rowSubtitleFocused]}>{busy ? 'One moment…' : subtitle}</Text> : null}
        </View>
        {active && <Icon name="checkmark" size={30} color={focused ? colors.onFocused : colors.accent} />}
      </>;
    }}
  </Focusable>;
}

function SeparateDevice({ device }: { device: DeviceInfo }) {
  const track = useTrack(device.detached?.trackId, device.detached?.albumId);
  const [row] = separateRows([device], '', () => track?.title);
  if (!row) return null;
  return <View style={styles.separate}>
    <View style={styles.icon}><Icon name={row.icon} size={34} color={colors.secondary} /></View>
    <View style={styles.words}>
      <Text numberOfLines={1} style={styles.rowTitle}>{row.name}</Text>
      <Text numberOfLines={1} style={styles.rowSubtitle}>{row.subtitle}</Text>
    </View>
  </View>;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  dim: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.45)' },
  panel: { position: 'absolute', top: 60, bottom: 60, right: 60, width: panelWidth, borderRadius: 44, overflow: 'hidden' },
  wash: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(40,36,54,0.35)' },
  content: { padding: 44, paddingBottom: 60 },
  title: { ...type.title2 },
  subtitle: { ...type.body, color: colors.secondary, marginTop: 6 },
  rows: { marginTop: 34, marginHorizontal: -20, gap: 6 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 24, paddingHorizontal: 20, paddingVertical: 16, borderRadius: 22 },
  rowFocused: { backgroundColor: colors.focused },
  icon: { width: 68, height: 68, borderRadius: 34, backgroundColor: colors.platter, alignItems: 'center', justifyContent: 'center' },
  iconFocused: { backgroundColor: 'rgba(0,0,0,0.08)' },
  iconActive: { backgroundColor: colors.accent },
  words: { flex: 1, gap: 2 },
  rowTitle: { ...type.callout, fontWeight: '600', color: colors.text },
  rowSubtitle: { ...type.caption, color: colors.secondary },
  rowSubtitleFocused: { color: 'rgba(17,16,24,0.62)' },
  volume: { flexDirection: 'row', alignItems: 'center', gap: 20, marginTop: 30, paddingTop: 30, borderTopWidth: 1, borderColor: colors.hairline },
  volumeWords: { flex: 1, gap: 2 },
  percent: { ...type.callout, fontVariant: ['tabular-nums'], minWidth: 80, textAlign: 'center' },
  failure: { ...type.body, color: colors.danger, marginTop: 24 },
  note: { ...type.body, color: colors.secondary, marginTop: 24 },
  section: { ...type.headline, color: colors.secondary, marginTop: 40, marginBottom: 12 },
  separate: { flexDirection: 'row', alignItems: 'center', gap: 24, paddingVertical: 12 },
});
