import { LinearGradient } from 'expo-linear-gradient';
import { SymbolView } from 'expo-symbols';
import { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, useTVEventHandler, useWindowDimensions, View } from 'react-native';
import { useLibraryActions, useLiked, useLikeFailure } from '../data/library';
import { shade } from '../data/color';
import { heartButton } from '../library/heart';
import { useLoading, usePlaybackActions, usePlaybackState } from '../playback';
import { whereItPlays } from '../player/session';
import { usePlaybackStatus } from '../player/usePlaybackStatus';
import { TvDevices } from './player/Devices';
import { TvLyrics } from './player/Lyrics';
import { PlayerCover, PlayerIconButton } from './player/Primitives';
import { TvQueue } from './player/Queue';
import { TvScrubber } from './player/Scrubber';
import { TvButton, TvScreen, tvColors } from './ui';

const tabs = [
  { id: 'track', title: 'Track' },
  { id: 'lyrics', title: 'Lyrics' },
  { id: 'queue', title: 'Queue' },
  { id: 'devices', title: 'Devices' },
] as const;

type Tab = typeof tabs[number]['id'];
type Playback = ReturnType<typeof usePlaybackState>;

/** The focused app receives the remote's Play/Pause press. Control Center uses native media commands. */
export function TvRemoteTransport() {
  const { playPause } = usePlaybackActions();
  useTVEventHandler(useCallback<Parameters<typeof useTVEventHandler>[0]>(event => {
    if (event.eventType === 'playPause' && String(event.eventKeyAction) !== '0') playPause();
  }, [playPause]));
  return null;
}

export function TvNowPlaying({ onBack }: { onBack: () => void }) {
  const { width, height } = useWindowDimensions();
  const [tab, setTab] = useState<Tab>('track');
  const [focusDevicesTab, setFocusDevicesTab] = useState(false);
  const playback = usePlaybackState();
  const { track } = playback;
  const artwork = track?.album?.artwork;
  const main = tab === 'track';
  const coverSize = Math.floor(Math.min(main ? 620 : 490, width * (main ? 0.35 : 0.27), height * (main ? 0.67 : 0.47)));
  const tint = artwork?.color ? shade(artwork.color, 0.63) : '#403352';

  const showDevices = () => {
    setFocusDevicesTab(true);
    setTab('devices');
  };

  return (
    <View style={styles.background}>
      <LinearGradient pointerEvents="none" colors={[tint, tvColors.background]}
        start={{ x: 0.03, y: 0 }} end={{ x: 0.83, y: 0.97 }} style={StyleSheet.absoluteFill} />
      <LinearGradient pointerEvents="none" colors={['#0D0A1210', '#0D0A12B8']}
        style={StyleSheet.absoluteFill} />
      <TvScreen style={styles.screen}>
        <View style={styles.header}>
          <View style={styles.headerTitle}>
            <PlayerIconButton icon="chevron.left" label="Back" onPress={onBack} />
            <Text accessibilityRole="header" style={styles.heading}>Now Playing</Text>
          </View>
          <View style={styles.tabs}>
            {tabs.map(({ id, title }) => <TvButton key={id} label={title} tone="quiet" selected={tab === id}
              hasTVPreferredFocus={id === 'devices' && focusDevicesTab}
              onFocus={id === 'devices' ? () => setFocusDevicesTab(false) : undefined}
              onPress={() => setTab(id)} />)}
          </View>
        </View>
        <View style={[styles.stage, !main && styles.panelStage]}>
          <View style={[styles.coverColumn, main ? { width: coverSize } : { width: Math.max(coverSize, 350) }]}>
            <PlayerCover artwork={artwork} size={coverSize} large />
            {!main && <TrackDetails playback={playback} compact onDevices={showDevices} />}
          </View>
          <View style={styles.content}>
            {main ? <TrackDetails playback={playback} onDevices={showDevices} /> : (
              <>
                {tab === 'lyrics' && <TvLyrics key={track?.id} track={track} />}
                {tab === 'queue' && <TvQueue />}
                {tab === 'devices' && <TvDevices />}
              </>
            )}
          </View>
        </View>
      </TvScreen>
    </View>
  );
}

function TrackDetails({ playback, compact = false, onDevices }: {
  playback: Playback;
  compact?: boolean;
  onDevices: () => void;
}) {
  const { actions, current, detached, durationMs, output, queue, session, track } = playback;
  const load = useLoading();
  const notice = usePlaybackStatus();
  const { setLiked } = useLibraryActions();
  const liked = useLiked('track', track?.id, track?.liked);
  const heart = heartButton(liked, track?.title ?? '', useLikeFailure('track', track?.id));
  const canPlay = Boolean(current || queue.queue.length || (session.autoplay && queue.autoplayQueue.length));
  const showOutput = Boolean(current && !compact);
  const outputStatus = detached ? 'Only on this Apple TV' : session.activeDeviceId
    ? whereItPlays(output, session.playing ? 'Playing' : 'Paused') : 'No playback device selected';
  const detail = notice?.message ?? (load === 'slow' ? 'Still loading…' : track?.artistCredit);
  return (
    <View style={[styles.details, compact && styles.compactDetails]}>
      <View style={styles.metadata}>
        <Text accessibilityRole="header" numberOfLines={2} style={[styles.title, compact && styles.compactTitle]}>
          {track?.title ?? (current ? 'Loading song…' : 'Nothing playing')}
        </Text>
        {detail && <Text numberOfLines={2} style={[styles.artist, compact && styles.compactArtist, (notice || load === 'slow') && styles.notice]}>{detail}</Text>}
        {notice?.detail && <Text numberOfLines={2} style={styles.album}>{notice.detail}</Text>}
        {!compact && !notice && track?.album && <Text numberOfLines={1} style={styles.album}>{track.album.title}</Text>}
        {!current && !compact && <Text style={styles.album}>Choose music from your library to start listening.</Text>}
      </View>
      {current && <TvScrubber key={current.id} duration={durationMs} disabled={current.state === 'failed'} />}
      {canPlay && (
        <View style={styles.transport}>
          <PlayerIconButton icon="backward.end.fill" label="Previous track" disabled={!current} onPress={actions.previous} />
          <PlayerIconButton icon={session.playing ? 'pause.fill' : 'play.fill'}
            label={session.playing ? 'Pause' : 'Play'} onPress={actions.playPause} primary preferred={!compact} />
          <PlayerIconButton icon="forward.end.fill" label="Next track" onPress={actions.next} />
          {!compact && track && <PlayerIconButton icon={heart.icon} label={heart.label} selected={heart.selected}
            onPress={() => setLiked('track', track.id, !liked, track.title)} />}
          {load !== 'none' && <ActivityIndicator accessibilityLabel="Buffering" color={tvColors.accent} />}
        </View>
      )}
      {!compact && heart.failed && <Text accessibilityRole="alert" style={styles.failure}>{heart.label}</Text>}
      {showOutput && (
        <View style={styles.output}>
          <SymbolView name={output.isThisDevice ? 'appletv' : 'airplay.audio'} size={25} tintColor={tvColors.accent} accessible={false} />
          <Text numberOfLines={1} style={styles.outputLabel}>{outputStatus}</Text>
          <TvButton label="Switch device" tone="quiet" onPress={onDevices} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  background: { flex: 1, backgroundColor: tvColors.background },
  screen: { paddingTop: 50, paddingBottom: 64 },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 20,
    paddingBottom: 24, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: '#FFFFFF33',
  },
  headerTitle: { flexDirection: 'row', gap: 21, alignItems: 'center', flexShrink: 1 },
  heading: { color: tvColors.text, fontSize: 32, fontWeight: '700', letterSpacing: -0.6 },
  tabs: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  stage: { flex: 1, flexDirection: 'row', gap: 70, alignItems: 'center', paddingTop: 28 },
  panelStage: { alignItems: 'stretch', paddingTop: 43, gap: 60 },
  coverColumn: { gap: 23, alignItems: 'flex-start' },
  content: { flex: 1, minWidth: 0, minHeight: 0 },
  details: { justifyContent: 'center', gap: 25, flexShrink: 1, maxWidth: 850 },
  compactDetails: { gap: 12, alignSelf: 'stretch' },
  metadata: { gap: 6 },
  title: { color: tvColors.text, fontWeight: '700', fontSize: 66, letterSpacing: -2.1, lineHeight: 72 },
  compactTitle: { fontSize: 38, letterSpacing: -0.7, lineHeight: 43 },
  artist: { color: tvColors.text, fontWeight: '500', fontSize: 33, letterSpacing: -0.6 },
  compactArtist: { fontSize: 25, letterSpacing: -0.3 },
  album: { color: tvColors.muted, fontSize: 24, fontWeight: '500' },
  notice: { color: tvColors.accent },
  failure: { color: tvColors.danger, fontSize: 22 },
  transport: { flexDirection: 'row', alignItems: 'center', gap: 15 },
  output: { flexDirection: 'row', alignItems: 'center', gap: 12, alignSelf: 'flex-start', maxWidth: '100%' },
  outputLabel: { color: tvColors.muted, fontSize: 21, fontWeight: '500', flexShrink: 1 },
});
