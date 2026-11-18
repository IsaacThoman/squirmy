import { useEffect, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { GestureDetector, useNativeGesture, usePanGesture } from 'react-native-gesture-handler';
import Animated, { Easing, Extrapolation, interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { formatTime } from './catalog';
import { MiniPlayerContent } from './MiniPlayer';
import type { PlayerOrigin } from './player/PlayerOrigin';
import { usePlayback, usePlaybackState } from './playback';
import { Cover, Icon } from './ui';
import PageDeck from './player/PageDeck';
import QueuePage from './player/QueuePage';
import TransportSlider from './player/TransportSlider';
import { PlayerButton, playerColors as c, selectionFeedback } from './player/design';

const pageIndex = { lyrics: 0, player: 1, queue: 2 } as const;
const artworkRadius = 21;
const artworkGap = 14;
const grabberHeight = 32;
const metadataHeight = 60;
const expandMotion = { duration: 390, easing: Easing.out(Easing.cubic) };
const collapseMotion = { duration: 290, easing: Easing.inOut(Easing.cubic) };

type PlayerPage = keyof typeof pageIndex;

type PlayerProps = {
  initialPage?: PlayerPage;
  origin: PlayerOrigin | null;
  onClose: () => void;
  onDevices: () => void;
  onTrackMenu: (trackId: string) => void;
};

export default function Player({ initialPage = 'player', origin, onClose, onDevices, onTrackMenu }: PlayerProps) {
  const [page, setPage] = useState<number>(pageIndex[initialPage]);
  const [availableHeight, setAvailableHeight] = useState(0);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const top = insets.top || initialWindowMetrics?.insets.top || 0;
  const bottom = insets.bottom || initialWindowMetrics?.insets.bottom || 0;
  const { track, album, state, actions } = usePlaybackState();
  const pagerGesture = useNativeGesture();
  const reduceMotion = useReducedMotion();
  const bubble = reduceMotion ? null : origin;
  const progress = useSharedValue(bubble ? 0 : 1);
  const closing = useSharedValue(false);
  const smallScreen = height < 750;
  const artSize = Math.min(width - insets.left - insets.right - 48, 440,
    Math.max(96, (availableHeight || height - 360) - artworkGap - metadataHeight));
  const artX = (width + insets.left - insets.right - artSize) / 2;
  const artY = top + grabberHeight + Math.max(0, (availableHeight - artSize - artworkGap - metadataHeight) / 2);
  const shareArtwork = bubble !== null && page === pageIndex.player;
  const isFavorite = state.favorites.includes(track.id);
  const hasLayout = availableHeight > 0;

  useEffect(() => {
    if (bubble && hasLayout && !closing.get()) progress.set(withTiming(1, expandMotion));
  }, [bubble, closing, hasLayout, progress]);

  const close = () => {
    if (closing.get()) return;
    if (reduceMotion) {
      onClose();
      return;
    }
    closing.set(true);
    progress.set(withTiming(0, collapseMotion, (finished) => {
      if (finished) scheduleOnRN(onClose);
    }));
  };

  const dismiss = usePanGesture({
    activeOffsetY: 8,
    failOffsetX: [-14, 14],
    onActivate: () => {
      if (!reduceMotion && !closing.value) progress.value = 1;
    },
    onUpdate: (event) => {
      if (!reduceMotion && !closing.value) {
        progress.value = 1 - Math.min(1, Math.max(0, event.translationY) / (height * 0.7));
      }
    },
    onDeactivate: (event) => {
      if (closing.value) return;
      if (!event.canceled && (event.translationY > 88 || event.velocityY > 760)) {
        closing.value = true;
        if (reduceMotion) {
          scheduleOnRN(onClose);
          return;
        }
        progress.value = withTiming(0, collapseMotion, (finished) => {
          if (finished) scheduleOnRN(onClose);
        });
      } else if (!reduceMotion) {
        progress.value = withSpring(1, { damping: 28, stiffness: 300, overshootClamping: true });
      }
    },
  });

  const frameStyle = useAnimatedStyle(() => {
    const p = progress.value;
    if (!bubble) return { opacity: p, transform: [{ translateY: (1 - p) * 42 }] };
    return {
      left: bubble.x * (1 - p),
      top: bubble.y * (1 - p),
      width: bubble.width + (width - bubble.width) * p,
      height: bubble.height + (height - bubble.height) * p,
      borderRadius: (bubble.height / 2) * (1 - p),
    };
  });

  const contentStyle = useAnimatedStyle(() => {
    const p = progress.value;
    if (!bubble) return { opacity: 1 };
    return { opacity: interpolate(p, [0.08, 0.85], [0, 1], Extrapolation.CLAMP) };
  });

  const previewStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.33], [1, 0], Extrapolation.CLAMP),
  }));

  const artStyle = useAnimatedStyle(() => ({
    opacity: !shareArtwork ? 1 : interpolate(progress.value, [0.86, 1], [0, 1], Extrapolation.CLAMP),
  }));

  const floatingArtStyle = useAnimatedStyle(() => {
    if (!bubble || !shareArtwork) return { opacity: 0 };
    const p = progress.value;
    const startX = bubble.compact ? 10 : 12;
    const startY = (bubble.height - bubble.artworkSize) / 2;
    const size = bubble.artworkSize + (artSize - bubble.artworkSize) * p;
    return {
      opacity: interpolate(p, [0.86, 1], [1, 0], Extrapolation.CLAMP),
      left: startX + (artX - startX) * p,
      top: startY + (artY - startY) * p,
      width: size,
      height: size,
      borderRadius: 8 + (artworkRadius - 8) * p,
    };
  });

  const togglePage = (next: number) => {
    selectionFeedback();
    setPage(current => current === next ? pageIndex.player : next);
  };

  return (
    <Animated.View accessibilityViewIsModal style={[styles.screen, frameStyle]}>
      <Animated.View style={[styles.content, { width, height }, contentStyle]}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: album.color }]} pointerEvents="none">
          <Image source={album.artwork} blurRadius={70} contentFit="cover" transition={210} style={styles.backdropArt} />
          <LinearGradient
            colors={['#11101B8A', '#181322AF', '#100E18', '#0E0C15']}
            locations={[0, 0.39, 0.85, 1]}
            style={StyleSheet.absoluteFill}
          />
        </View>
        <View style={[styles.safe, { paddingTop: top, paddingBottom: bottom, paddingLeft: insets.left, paddingRight: insets.right }]}>
          <GestureDetector gesture={dismiss}>
            <View style={styles.grabberTouch}>
              <Pressable accessibilityRole="button" accessibilityLabel="Collapse player" onPress={close} style={styles.grabberPress} hitSlop={6}>
                <View style={styles.grabber} />
              </Pressable>
            </View>
          </GestureDetector>
          <View style={styles.deckFrame} onLayout={(event) => setAvailableHeight(event.nativeEvent.layout.height)}>
            <PageDeck
              gesture={pagerGesture}
              page={page}
              onPageChange={setPage}
              pages={[
                <LyricsPage key={track.id} visible={page === pageIndex.lyrics} />,
                <View style={styles.nowPlaying}>
                  <Animated.View style={[styles.artShadow, { width: artSize, height: artSize }, artStyle]}>
                    <Cover source={album.artwork} size={artSize} radius={artworkRadius} />
                  </Animated.View>
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
          <Transport key={track.id} compact={smallScreen} page={page} onToggle={togglePage} onDevices={onDevices} />
        </View>
      </Animated.View>
      {bubble && (
        <Animated.View pointerEvents="none" style={[styles.preview, { width: bubble.width, height: bubble.height }, previewStyle]}>
          <MiniPlayerContent native={bubble.native} compact={bubble.compact} preview hideArtwork={shareArtwork} />
        </Animated.View>
      )}
      {shareArtwork && (
        <Animated.View pointerEvents="none" style={[styles.floatingArt, floatingArtStyle]}>
          <Cover source={album.artwork} radius={0} style={StyleSheet.absoluteFill} />
        </Animated.View>
      )}
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

function Transport({ compact, page, onToggle, onDevices }: {
  compact: boolean;
  page: number;
  onToggle: (page: number) => void;
  onDevices: () => void;
}) {
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
      <View style={styles.footer}>
        <View style={styles.footerSide}>
          <PlayerButton icon="quote.bubble"
            label={page === pageIndex.lyrics ? 'Hide lyrics' : 'Show lyrics'}
            selected={page === pageIndex.lyrics}
            color={page === pageIndex.lyrics ? c.ink : c.muted}
            onPress={() => onToggle(pageIndex.lyrics)}
            style={[styles.footerButton, page === pageIndex.lyrics && styles.footerSelected]} />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Playback device: ${device.name}`}
          onPress={() => { selectionFeedback(); onDevices(); }}
          style={({ pressed }) => [styles.output, pressed && styles.controlPressed]}
        >
          <View style={styles.outputIcon}>
            <Icon name={device.icon} size={21} color={c.lilac} />
            <View style={styles.deviceSignal} />
          </View>
          <Text numberOfLines={1} style={styles.deviceName}>{device.name}</Text>
        </Pressable>
        <View style={styles.footerSide}>
          <PlayerButton icon="list.bullet"
            label={page === pageIndex.queue ? 'Hide queue' : 'Show queue'}
            selected={page === pageIndex.queue}
            color={page === pageIndex.queue ? c.ink : c.muted}
            onPress={() => onToggle(pageIndex.queue)}
            style={[styles.footerButton, page === pageIndex.queue && styles.footerSelected]} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', backgroundColor: '#25212E', overflow: 'hidden' },
  content: { position: 'absolute', top: 0, left: 0, backgroundColor: '#100E18' },
  preview: { position: 'absolute', top: 0, left: 0 },
  floatingArt: { position: 'absolute', overflow: 'hidden', backgroundColor: '#191624' },
  safe: { flex: 1 },
  backdropArt: { width: '110%', height: '86%', opacity: 0.62 },
  grabberTouch: { height: grabberHeight, alignItems: 'center', justifyContent: 'center' },
  grabberPress: { width: 105, height: grabberHeight, alignItems: 'center', justifyContent: 'center' },
  grabber: { width: 32, height: 4, borderRadius: 2, backgroundColor: '#FFFFFF66' },
  controlPressed: { opacity: 0.66 },
  deckFrame: { flex: 1 },
  nowPlaying: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: 24, gap: artworkGap },
  artShadow: { borderRadius: artworkRadius, backgroundColor: '#191624', boxShadow: '0 12px 34px #00000055' },
  metadata: { width: '100%', maxWidth: 440, minHeight: metadataHeight, flexDirection: 'row', alignItems: 'center', gap: 5 },
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
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: 8 },
  footerSide: { flex: 1, alignItems: 'center' },
  footerButton: { borderRadius: 22, backgroundColor: c.surface, borderWidth: 1, borderColor: c.stroke },
  footerSelected: { backgroundColor: c.lilac, borderColor: c.lilac },
  output: { flex: 1.3, minWidth: 0, alignItems: 'center', minHeight: 56, justifyContent: 'flex-start' },
  outputIcon: { width: 44, height: 39, justifyContent: 'center', alignItems: 'center' },
  deviceSignal: { position: 'absolute', right: 4, top: 8, width: 5, height: 5, borderRadius: 2.5, backgroundColor: '#BCE9CD' },
  deviceName: { color: c.lilac, fontSize: 11, fontWeight: '600' },
});
