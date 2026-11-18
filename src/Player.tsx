import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { GestureDetector, useNativeGesture, usePanGesture } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { SafeAreaView } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { formatTime } from './catalog';
import { usePlayback, usePlaybackState } from './playback';
import { Cover, Icon } from './ui';
import PageDeck from './player/PageDeck';
import QueuePage from './player/QueuePage';
import TransportSlider from './player/TransportSlider';
import { PlayerButton, playerColors as c, selectionFeedback } from './player/design';

const pages = [
  { id: 'lyrics', label: 'Lyrics', icon: 'quote.bubble' },
  { id: 'player', label: 'Playing', icon: 'waveform' },
  { id: 'queue', label: 'Queue', icon: 'list.bullet' },
] as const;

export type PlayerPage = typeof pages[number]['id'];

type PlayerProps = {
  initialPage?: PlayerPage;
  onClose: () => void;
  onDevices: () => void;
  onTrackMenu: (trackId: string) => void;
};

export default function Player({ initialPage = 'player', onClose, onDevices, onTrackMenu }: PlayerProps) {
  const [page, setPage] = useState(() => pages.findIndex((item) => item.id === initialPage));
  const [availableHeight, setAvailableHeight] = useState(0);
  const { width, height } = useWindowDimensions();
  const { track, album, state, actions } = usePlaybackState();
  const pagerGesture = useNativeGesture();
  const sheetOffset = useSharedValue(0);
  const smallScreen = height < 750;
  const artSize = Math.min(width - 52, 440, Math.max(144, (availableHeight || height - 360) - 83));
  const isFavorite = state.favorites.includes(track.id);
  const dismiss = usePanGesture({
    activeOffsetY: 8,
    failOffsetX: [-14, 14],
    onUpdate: (event) => { sheetOffset.value = Math.max(0, event.translationY); },
    onDeactivate: (event) => {
      if (event.translationY > 76 || event.velocityY > 740) {
        sheetOffset.value = withTiming(height, { duration: 160 }, (finished) => {
          if (finished) scheduleOnRN(onClose);
        });
      } else {
        sheetOffset.value = withSpring(0, { damping: 24, stiffness: 280 });
      }
    },
    onFinalize: (event) => {
      if (event.canceled) sheetOffset.value = withSpring(0);
    },
  });
  const sheetStyle = useAnimatedStyle(() => ({ transform: [{ translateY: sheetOffset.value }] }));
  const selectPage = (index: number) => {
    if (index === page) return;
    selectionFeedback();
    setPage(index);
  };

  return (
    <Animated.View style={[styles.screen, sheetStyle]}>
      <View style={[StyleSheet.absoluteFill, { backgroundColor: album.color }]} pointerEvents="none">
        <Image source={album.artwork} blurRadius={70} contentFit="cover" transition={210} style={styles.backdropArt} />
        <LinearGradient
          colors={['#11101B8A', '#181322AF', '#100E18', '#0E0C15']}
          locations={[0, 0.39, 0.85, 1]}
          style={StyleSheet.absoluteFill}
        />
      </View>
      <SafeAreaView style={styles.safe} edges={['top', 'bottom', 'left', 'right']}>
        <GestureDetector gesture={dismiss}>
          <View style={styles.grabberTouch}>
            <Pressable accessibilityRole="button" accessibilityLabel="Close player" onPress={onClose} style={styles.grabberPress} hitSlop={6}>
              <View style={styles.grabber} />
            </Pressable>
          </View>
        </GestureDetector>
        <View style={styles.modeRail} accessibilityRole="tablist">
          {pages.map((item, index) => {
            const selected = page === index;
            return (
              <Pressable
                key={item.id}
                accessibilityRole="tab"
                accessibilityLabel={item.id === 'player' ? 'Now playing' : item.label}
                accessibilityState={{ selected }}
                onPress={() => selectPage(index)}
                style={({ pressed }) => [styles.mode, selected && styles.activeMode, pressed && styles.controlPressed]}
              >
                <Icon name={item.icon} size={15} color={selected ? c.ink : c.muted} />
                <Text style={[styles.modeName, selected && styles.activeModeName]}>{item.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <View style={styles.deckFrame} onLayout={(event) => setAvailableHeight(event.nativeEvent.layout.height)}>
          <PageDeck
            gesture={pagerGesture}
            page={page}
            onPageChange={setPage}
            pages={[
              <LyricsPage key={track.id} visible={page === 0} />,
              <View style={styles.nowPlaying}>
                <View style={[styles.artShadow, { width: artSize, height: artSize }]}>
                  <Cover source={album.artwork} size={artSize} radius={21} />
                </View>
                <View style={styles.metadata}>
                  <View style={styles.trackCopy}>
                    <Text numberOfLines={1} style={[styles.trackTitle, smallScreen && styles.compactTitle]}>{track.title}</Text>
                    <Text numberOfLines={1} style={styles.artist}>{track.artist}</Text>
                  </View>
                  <PlayerButton
                    icon={isFavorite ? 'heart.fill' : 'heart'}
                    label={isFavorite ? 'Remove from favorites' : 'Favorite song'}
                    selected={isFavorite}
                    onPress={() => { selectionFeedback(); actions.toggleFavorite(track.id); }}
                    style={styles.trackAction}
                    color={isFavorite ? c.lilac : c.text}
                  />
                  <PlayerButton icon="ellipsis" label="Song options" onPress={() => onTrackMenu(track.id)} style={styles.trackAction} />
                </View>
              </View>,
              <QueuePage pagerGesture={pagerGesture} onTrackMenu={onTrackMenu} />,
            ]}
          />
        </View>
        <Transport key={track.id} compact={smallScreen} onDevices={onDevices} />
      </SafeAreaView>
    </Animated.View>
  );
}

function LyricsPage({ visible }: { visible: boolean }) {
  const { track, album, position, actions } = usePlayback();
  const lines = track.lyrics ?? [];
  const step = track.duration / (lines.length + 2);
  const active = Math.min(lines.length - 1, Math.max(0, Math.floor(position / step) - 1));
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const lineCenters = useRef<number[]>([]);
  const [viewport, setViewport] = useState(0);

  useEffect(() => {
    const center = lineCenters.current[active];
    if (visible && viewport && center !== undefined) {
      scroll.current?.scrollTo({ y: Math.max(0, center - viewport * 0.33), animated: active > 0 });
    }
  }, [active, visible, viewport]);

  return (
    <View style={styles.lyricPage}>
      <View style={styles.lyricTrack}>
        <Cover source={album.artwork} size={45} radius={9} />
        <View style={styles.trackCopy}>
          <Text numberOfLines={1} style={styles.lyricTrackTitle}>{track.title}</Text>
          <Text numberOfLines={1} style={styles.lyricTrackArtist}>{track.artist}</Text>
        </View>
      </View>
      {lines.length ? (
        <ScrollView
          ref={scroll}
          contentInsetAdjustmentBehavior="never"
          onLayout={(event) => setViewport(event.nativeEvent.layout.height)}
          contentContainerStyle={{ paddingTop: 22, paddingBottom: viewport * 0.6 }}
          showsVerticalScrollIndicator={false}
        >
          {lines.map((line, index) => (
            <Pressable
              key={`${index}-${line}`}
              accessibilityRole="button"
              accessibilityHint="Seek to this line"
              accessibilityState={{ selected: index === active }}
              onLayout={(event) => {
                const { y, height } = event.nativeEvent.layout;
                lineCenters.current[index] = y + height / 2;
              }}
              onPress={() => { selectionFeedback(); actions.seek((index + 1) * step); }}
              style={styles.lyricLine}
            >
              <Text style={[styles.lyric, index === active && styles.lyricActive]}>{line}</Text>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <View style={styles.noLyrics}>
          <Icon name="quote.bubble" size={29} color={c.quiet} />
          <Text style={styles.noLyricsTitle}>No lyrics available</Text>
        </View>
      )}
    </View>
  );
}

function Transport({ compact, onDevices }: { compact: boolean; onDevices: () => void }) {
  const { track, state, device, position, actions } = usePlayback();
  const [scrubbing, setScrubbing] = useState(false);
  const [draft, setDraft] = useState(position);
  const scrubRef = useRef({ active: false, position });
  const shown = scrubbing ? draft : position;
  const seekEditing = (editing: boolean) => {
    scrubRef.current.active = editing;
    if (editing) {
      scrubRef.current.position = position;
      setDraft(position);
    } else {
      actions.seek(scrubRef.current.position);
    }
    setScrubbing(editing);
  };
  const seekChange = (seconds: number) => {
    scrubRef.current.position = seconds;
    if (scrubRef.current.active) setDraft(seconds);
    else actions.seek(seconds);
  };

  return (
    <View style={[styles.transport, compact && styles.transportCompact]}>
      <TransportSlider label="Playback position" value={shown} maximum={track.duration} onChange={seekChange} onEdit={seekEditing} />
      <View style={styles.timeRow}>
        <Text style={styles.time}>{formatTime(shown)}</Text>
        <Text style={styles.time}>−{formatTime(Math.max(0, track.duration - shown))}</Text>
      </View>
      <View style={[styles.transportButtons, compact && styles.transportButtonsCompact]}>
        <PlayerButton icon="backward.fill" label="Previous track" size={27} onPress={() => { selectionFeedback(); actions.previous(); }} />
        <PlayerButton
          icon={state.playing ? 'pause.fill' : 'play.fill'}
          label={state.playing ? 'Pause' : 'Play'}
          size={29}
          color={c.ink}
          onPress={() => { selectionFeedback(); actions.playPause(); }}
          style={[styles.primaryButton, compact && styles.primaryButtonCompact]}
        />
        <PlayerButton icon="forward.fill" label="Next track" size={27} onPress={() => { selectionFeedback(); actions.next(); }} />
      </View>
      <View style={styles.volumeRow}>
        <Icon name="speaker.fill" size={13} color={c.muted} />
        <View style={styles.volumeSlider}>
          <TransportSlider label="Volume" value={state.volume} maximum={1} onChange={actions.setVolume} />
        </View>
        <Icon name="speaker.wave.3.fill" size={15} color={c.muted} />
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Playback device: ${device.name}`}
        onPress={() => { selectionFeedback(); onDevices(); }}
        style={({ pressed }) => [styles.output, pressed && styles.controlPressed]}
      >
        <View style={styles.deviceSignal} />
        <Icon name={device.icon} size={15} color={c.lilac} />
        <Text numberOfLines={1} style={styles.deviceName}>{device.name}</Text>
        <Icon name="chevron.up.chevron.down" size={10} color={c.muted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#100E18' },
  safe: { flex: 1 },
  backdropArt: { width: '110%', height: '86%', opacity: 0.62 },
  grabberTouch: { height: 24, alignItems: 'center', justifyContent: 'center' },
  grabberPress: { width: 105, height: 24, alignItems: 'center', justifyContent: 'center' },
  grabber: { width: 32, height: 4, borderRadius: 2, backgroundColor: '#FFFFFF66' },
  modeRail: {
    flexDirection: 'row', alignSelf: 'center', borderRadius: 24, borderWidth: 1, borderColor: c.stroke,
    backgroundColor: '#1B17266B', padding: 3, marginTop: 5, marginBottom: 9, gap: 2,
  },
  mode: { minWidth: 82, minHeight: 34, paddingHorizontal: 12, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 20 },
  activeMode: { backgroundColor: c.lilac },
  modeName: { fontSize: 12, fontWeight: '600', color: c.muted },
  activeModeName: { color: c.ink },
  controlPressed: { opacity: 0.66 },
  deckFrame: { flex: 1 },
  nowPlaying: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24, gap: 14 },
  artShadow: { borderRadius: 21, backgroundColor: '#191624', boxShadow: '0 12px 34px #00000055' },
  metadata: { width: '100%', maxWidth: 440, minHeight: 60, flexDirection: 'row', alignItems: 'center', gap: 5 },
  trackCopy: { minWidth: 0, flex: 1 },
  trackTitle: { fontSize: 30, fontWeight: '700', letterSpacing: -1, color: c.text },
  compactTitle: { fontSize: 25 },
  artist: { marginTop: 3, color: c.muted, fontWeight: '500', fontSize: 16 },
  trackAction: { borderRadius: 22, backgroundColor: c.surface, borderWidth: 1, borderColor: c.stroke },
  lyricPage: { flex: 1, paddingHorizontal: 25 },
  lyricTrack: { flexDirection: 'row', gap: 11, alignItems: 'center', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: c.stroke },
  lyricTrackTitle: { color: c.text, fontWeight: '700', fontSize: 17 },
  lyricTrackArtist: { color: c.muted, marginTop: 2, fontSize: 13 },
  lyricLine: { paddingBottom: 21 },
  lyric: { color: '#BAB1CB86', fontWeight: '700', fontSize: 32, letterSpacing: -0.7, maxWidth: 530 },
  lyricActive: { color: c.text },
  noLyrics: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  noLyricsTitle: { color: c.muted, fontSize: 16, fontWeight: '600' },
  transport: { width: '100%', maxWidth: 500, alignSelf: 'center', paddingHorizontal: 25, paddingTop: 8, paddingBottom: 6 },
  transportCompact: { paddingTop: 2, paddingBottom: 2 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -1, paddingHorizontal: 1 },
  time: { color: c.quiet, fontVariant: ['tabular-nums'], fontSize: 12, fontWeight: '600' },
  transportButtons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly', marginTop: 12, marginBottom: 10 },
  transportButtonsCompact: { marginTop: 6, marginBottom: 5 },
  primaryButton: { width: 66, height: 66, borderRadius: 33, backgroundColor: c.lilac },
  primaryButtonCompact: { width: 56, height: 56, borderRadius: 28 },
  volumeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  volumeSlider: { flex: 1 },
  output: { alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 7, maxWidth: '100%', marginTop: 9, paddingHorizontal: 13, minHeight: 40, borderRadius: 22, backgroundColor: c.surface, borderWidth: 1, borderColor: c.stroke },
  deviceSignal: { width: 5, height: 5, borderRadius: 2.5, backgroundColor: '#BCE9CD' },
  deviceName: { color: c.lilac, fontSize: 12, fontWeight: '700', flexShrink: 1 },
});
