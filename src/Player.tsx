import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { GestureDetector, useCompetingGestures, usePanGesture } from 'react-native-gesture-handler';
import Animated, { cancelAnimation, Easing, Extrapolation, interpolate, useAnimatedReaction, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { formatTime } from './catalog';
import { MiniPlayerContent } from './MiniPlayer';
import { usePlayerOrigin, type PlayerOrigin } from './player/PlayerOrigin';
import { usePlayback, usePlaybackState } from './playback';
import { Icon } from './ui';
import QueuePage from './player/QueuePage';
import TransportSlider from './player/TransportSlider';
import { CollapseButton, DeviceButton, LyricButton, PlayerButton, TrackMenuButton } from './player/Controls';
import { playerColors as c, selectionFeedback } from './player/design';

const artworkRadius = 21;
const artworkGap = 14;
const grabberHeight = 32;
const metadataHeight = 60;
const compactArtworkSize = 54;
const compactArtworkRadius = 11;
const artworkInset = 24;
const compactArtworkTop = 7;
const modeMotion = { duration: 360, easing: Easing.inOut(Easing.cubic) };
const panelMotion = { duration: 210 };
const expandMotion = { duration: 430, easing: Easing.bezier(0.2, 0.67, 0.28, 1) };
const collapseMotion = { duration: 410, easing: Easing.bezier(0.35, 0.08, 0.26, 1) };
const cancelPullMotion = { duration: 230, easing: Easing.out(Easing.cubic) };
const settleOpen = { damping: 29, stiffness: 270, overshootClamping: true };

type PlayerPage = 'player' | 'lyrics' | 'queue';
type DetailPage = Exclude<PlayerPage, 'player'>;

type PlayerProps = {
  initialPage?: PlayerPage;
  origin: PlayerOrigin | null;
  onClose: () => void;
  onDevices: () => void;
  onTrackMenu: (trackId: string) => void;
};

export default function Player({ initialPage = 'player', origin, onClose, onDevices, onTrackMenu }: PlayerProps) {
  const [page, setPage] = useState<PlayerPage>(initialPage);
  const [seenLyrics, setSeenLyrics] = useState(initialPage === 'lyrics');
  const [seenQueue, setSeenQueue] = useState(initialPage === 'queue');
  const [availableHeight, setAvailableHeight] = useState(0);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const top = insets.top || initialWindowMetrics?.insets.top || 0;
  const bottom = insets.bottom || initialWindowMetrics?.insets.bottom || 0;
  const { track, album, state, actions } = usePlaybackState();
  const reduceMotion = useReducedMotion();
  const bubble = reduceMotion ? null : origin;
  const progress = useSharedValue(bubble ? 0 : 1);
  const dismissStart = useSharedValue(1);
  const closing = useSharedValue(false);
  const detail = useSharedValue(initialPage === 'player' ? 0 : 1);
  const trackDrag = useSharedValue(0);
  const smallScreen = height < 750;
  const artSize = Math.min(width - insets.left - insets.right - 48, 440,
    Math.max(96, (availableHeight || height - 360) - artworkGap - metadataHeight));
  const artX = (width - insets.left - insets.right - artSize) / 2;
  const artY = Math.max(0, (availableHeight - artSize - artworkGap - metadataHeight) / 2);
  const artworkPage = page === 'player';
  const { accessoryInPlayer, miniPull } = usePlayerOrigin();
  const isFavorite = state.favorites.includes(track.id);
  const hasLayout = availableHeight > 0;

  useLayoutEffect(() => {
    if (!bubble) return;
    accessoryInPlayer.set(true);
    return () => {
      accessoryInPlayer.set(false);
      if (bubble.fromPull) miniPull.set(null);
    };
  }, [bubble, accessoryInPlayer, miniPull]);

  useEffect(() => {
    if (bubble && !bubble.fromPull && hasLayout && !closing.get()) progress.set(withTiming(1, expandMotion));
  }, [bubble, closing, hasLayout, progress]);

  const followsPull = !!bubble?.fromPull;
  const travel = Math.max(240, bubble?.y ?? height * 0.7);
  useAnimatedReaction(
    () => followsPull ? miniPull.value : null,
    (pull) => {
      if (!pull || closing.value) return;
      progress.value = Math.min(1, pull.distance / travel);
      if (pull.phase === 'open') {
        progress.value = withSpring(1, { ...settleOpen, velocity: pull.velocity / travel });
      } else if (pull.phase === 'cancel') {
        closing.value = true;
        progress.value = withTiming(0, cancelPullMotion, (finished) => {
          if (finished) scheduleOnRN(onClose);
        });
      }
    },
  );

  useEffect(() => {
    detail.set(withTiming(artworkPage ? 0 : 1, modeMotion));
  }, [artworkPage, detail]);

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

  const dismissPan = {
    activeOffsetY: 8,
    failOffsetY: -10,
    failOffsetX: [-14, 14],
    onActivate: () => {
      'worklet';
      if (!reduceMotion && !closing.value) {
        cancelAnimation(progress);
        dismissStart.value = progress.value;
      }
    },
    onUpdate: (event) => {
      'worklet';
      if (!reduceMotion && !closing.value) {
        progress.value = Math.max(0, Math.min(1, dismissStart.value - event.translationY / travel));
      }
    },
    onDeactivate: (event) => {
      'worklet';
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
        progress.value = withSpring(1, settleOpen);
      }
    },
  } satisfies Parameters<typeof usePanGesture>[0];
  const grabberDismiss = usePanGesture(dismissPan);
  const artworkDismiss = usePanGesture(dismissPan);
  const skipTrack = (direction: number) => {
    selectionFeedback();
    if (direction < 0) actions.next();
    else actions.previous();
  };
  const skipSwipe = usePanGesture({
    activeOffsetX: [-14, 14],
    failOffsetY: [-12, 12],
    onUpdate: (event) => {
      if (!reduceMotion && !closing.value) {
        trackDrag.value = Math.max(-48, Math.min(48, event.translationX * 0.32));
      }
    },
    onDeactivate: (event) => {
      const distance = Math.abs(event.translationX);
      if (!closing.value && !event.canceled &&
        (distance > 60 || (distance > 20 && Math.abs(event.velocityX) > 720))) {
        scheduleOnRN(skipTrack, event.translationX);
      }
      trackDrag.value = withSpring(0, { damping: 25, stiffness: 280 });
    },
  });
  const artworkGesture = useCompetingGestures(artworkDismiss, skipSwipe);

  const frameStyle = useAnimatedStyle(() => {
    const p = progress.value;
    if (!bubble) return { opacity: p, transform: [{ translateY: (1 - p) * 42 }] };
    return {
      left: bubble.x * (1 - p),
      top: bubble.y * (1 - p),
      width: bubble.width + (width - bubble.width) * p,
      height: bubble.height + (height - bubble.height) * p,
      borderRadius: interpolate(p, [0, 0.84, 1], [bubble.height / 2, 32, 0]),
    };
  });

  const backgroundStyle = useAnimatedStyle(() => ({
    opacity: bubble ? interpolate(progress.value, [0, 0.13, 0.34], [0, 0.55, 1], Extrapolation.CLAMP) : 1,
  }));

  // Keep the player laid out at its full size and scale the surface inside the moving frame.
  const surfaceStyle = useAnimatedStyle(() => {
    if (!bubble) return {};
    const p = progress.value;
    return {
      transform: [
        { scaleX: interpolate(p, [0, 1], [bubble.width / width, 1]) },
        { scaleY: interpolate(p, [0, 1], [bubble.height / height, 1]) },
      ],
    };
  });

  const contentStyle = useAnimatedStyle(() => ({
    opacity: bubble ? interpolate(progress.value, [0.25, 0.55, 0.85], [0, 0.65, 1], Extrapolation.CLAMP) : 1,
  }));

  const previewStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0.07, 0.32], [1, 0], Extrapolation.CLAMP),
  }));

  const artworkStyle = useAnimatedStyle(() => {
    const d = detail.value;
    const p = bubble ? progress.value : 1;
    const targetSize = artSize + (compactArtworkSize - artSize) * d;
    const targetRadius = artworkRadius + (compactArtworkRadius - artworkRadius) * d;
    const targetX = insets.left + artX + (artworkInset - artX) * d + trackDrag.value * (1 - d);
    const targetY = top + grabberHeight + artY + (compactArtworkTop - artY) * d;
    const startX = bubble?.compact ? 10 : 12;
    const startSize = bubble?.artworkSize ?? targetSize;
    const startY = bubble ? (bubble.height - startSize) / 2 : targetY;
    const size = startSize + (targetSize - startSize) * p;

    return {
      left: startX + (targetX - startX) * p,
      top: startY + (targetY - startY) * p,
      width: size,
      height: size,
      borderRadius: 8 + (targetRadius - 8) * p,
    };
  });
  const artworkDetailsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(detail.value, [0, 0.44], [1, 0], Extrapolation.CLAMP),
    transform: [{ translateX: trackDrag.value }],
  }));
  const compactDetailsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(detail.value, [0.38, 0.92], [0, 1], Extrapolation.CLAMP),
  }));
  const lyricsStyle = useAnimatedStyle(() => ({ opacity: withTiming(page === 'lyrics' ? 1 : 0, panelMotion) }));
  const queueStyle = useAnimatedStyle(() => ({ opacity: withTiming(page === 'queue' ? 1 : 0, panelMotion) }));

  const togglePage = (next: DetailPage) => {
    selectionFeedback();
    if (next === 'lyrics') setSeenLyrics(true);
    else setSeenQueue(true);
    setPage(current => current === next ? 'player' : next);
  };
  const trackDetails = (compact: boolean) => (
    <>
      <View style={styles.trackCopy}>
        <Text numberOfLines={1} style={compact ? styles.compactTrackTitle : [styles.trackTitle, smallScreen && styles.compactTitle]}>{track.title}</Text>
        <Text numberOfLines={1} style={compact ? styles.compactTrackArtist : styles.artist}>{track.artist}</Text>
      </View>
      <PlayerButton
        icon={isFavorite ? 'heart.fill' : 'heart'}
        label={isFavorite ? 'Remove from favorites' : 'Favorite song'}
        selected={isFavorite}
        onPress={() => { selectionFeedback(); actions.toggleFavorite(track.id); }}
        color={isFavorite ? c.lilac : c.text}
      />
      <TrackMenuButton trackId={track.id} onPress={() => onTrackMenu(track.id)} />
    </>
  );

  return (
    <Animated.View accessibilityViewIsModal style={[styles.screen, frameStyle]}>
      <Animated.View style={[styles.content, { width, height }, surfaceStyle]}>
        <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: album.color }, backgroundStyle]} pointerEvents="none">
          <Image source={album.artwork} blurRadius={70} contentFit="cover" transition={210} style={styles.backdropArt} />
          <LinearGradient
            colors={['#11101B8A', '#181322AF', '#100E18', '#0E0C15']}
            locations={[0, 0.39, 0.85, 1]}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
        <Animated.View style={[styles.safe, { paddingTop: top, paddingBottom: bottom, paddingLeft: insets.left, paddingRight: insets.right }, contentStyle]}>
          <GestureDetector gesture={grabberDismiss}>
            <View style={styles.grabberTouch}>
              <CollapseButton onPress={close} />
            </View>
          </GestureDetector>
          <View style={styles.deckFrame} onLayout={(event) => setAvailableHeight(event.nativeEvent.layout.height)}>
            <GestureDetector gesture={artworkGesture} touchAction="none">
              <View collapsable={false} style={styles.nowPlaying}
                pointerEvents={artworkPage ? 'auto' : 'none'} accessibilityElementsHidden={!artworkPage}
                importantForAccessibility={artworkPage ? 'auto' : 'no-hide-descendants'}>
                <View style={{ height: artSize }} />
                <Animated.View style={[styles.metadata, artworkDetailsStyle]}>{trackDetails(false)}</Animated.View>
              </View>
            </GestureDetector>
            {(seenLyrics || seenQueue) && <Animated.View style={[styles.details, compactDetailsStyle]} pointerEvents={artworkPage ? 'none' : 'auto'}
              accessibilityElementsHidden={artworkPage} importantForAccessibility={artworkPage ? 'no-hide-descendants' : 'auto'}>
              <View style={[styles.metadata, styles.compactMetadata]}>{trackDetails(true)}</View>
              <View style={styles.panel}>
                {seenLyrics && <Animated.View pointerEvents={page === 'lyrics' ? 'auto' : 'none'}
                  accessibilityElementsHidden={page !== 'lyrics'}
                  importantForAccessibility={page === 'lyrics' ? 'auto' : 'no-hide-descendants'}
                  style={[StyleSheet.absoluteFill, lyricsStyle]}>
                  <LyricsPage key={track.id} visible={page === 'lyrics'} />
                </Animated.View>}
                {seenQueue && <Animated.View pointerEvents={page === 'queue' ? 'auto' : 'none'}
                  accessibilityElementsHidden={page !== 'queue'}
                  importantForAccessibility={page === 'queue' ? 'auto' : 'no-hide-descendants'}
                  style={[StyleSheet.absoluteFill, queueStyle]}>
                  <QueuePage onTrackMenu={onTrackMenu} />
                </Animated.View>}
              </View>
            </Animated.View>}
          </View>
          <Transport key={track.id} compact={smallScreen} page={page} onToggle={togglePage} onDevices={onDevices} />
        </Animated.View>
      </Animated.View>
      {bubble && (
        <Animated.View pointerEvents="none" style={[styles.preview, { width: bubble.width, height: bubble.height }, previewStyle]}>
          <MiniPlayerContent native={bubble.native} compact={bubble.compact} preview />
        </Animated.View>
      )}
      <Animated.View pointerEvents="none" style={[styles.artwork, artworkStyle]}>
        <Image source={album.artwork} contentFit="cover" style={StyleSheet.absoluteFill} />
      </Animated.View>
    </Animated.View>
  );
}

function LyricsPage({ visible }: { visible: boolean }) {
  const { track, position, actions } = usePlayback();
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
      {lines.length ? (
        <ScrollView
          ref={scroll}
          contentInsetAdjustmentBehavior="never"
          onLayout={(event) => setViewport(event.nativeEvent.layout.height)}
          contentContainerStyle={{ paddingTop: 22, paddingBottom: viewport * 0.6 }}
          showsVerticalScrollIndicator={false}
        >
          {lines.map((line, index) => (
            <View key={index} onLayout={(event) => {
              const { y, height } = event.nativeEvent.layout;
              lineCenters.current[index] = y + height / 2;
            }}>
              <LyricButton line={line} active={index === active}
                onPress={() => { selectionFeedback(); actions.seek((index + 1) * step); }} />
            </View>
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
  page: PlayerPage;
  onToggle: (page: DetailPage) => void;
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
          size={40}
          color={c.text}
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
            label={page === 'lyrics' ? 'Hide lyrics' : 'Show lyrics'}
            selected={page === 'lyrics'}
            size={22}
            color={page === 'lyrics' ? c.lilac : c.muted}
            onPress={() => onToggle('lyrics')} />
        </View>
        <View style={styles.output}>
          <DeviceButton icon={device.icon} name={device.name}
            onPress={() => { selectionFeedback(); onDevices(); }} />
        </View>
        <View style={styles.footerSide}>
          <PlayerButton icon="list.bullet"
            label={page === 'queue' ? 'Hide queue' : 'Show queue'}
            selected={page === 'queue'}
            size={22}
            color={page === 'queue' ? c.lilac : c.muted}
            onPress={() => onToggle('queue')} />
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', overflow: 'hidden' },
  content: { position: 'absolute', top: 0, left: 0, transformOrigin: 'top left' },
  preview: { position: 'absolute', top: 0, left: 0 },
  safe: { flex: 1 },
  backdropArt: { width: '110%', height: '86%', opacity: 0.62 },
  grabberTouch: { height: grabberHeight, alignItems: 'center', justifyContent: 'center' },
  deckFrame: { flex: 1 },
  nowPlaying: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: artworkInset, gap: artworkGap },
  artwork: { position: 'absolute', overflow: 'hidden', backgroundColor: '#191624' },
  details: { ...StyleSheet.absoluteFill, paddingTop: compactArtworkTop },
  panel: { flex: 1 },
  compactMetadata: { alignSelf: 'stretch', width: 'auto', maxWidth: undefined, minHeight: compactArtworkSize,
    marginLeft: artworkInset + compactArtworkSize + 12, marginRight: artworkInset, marginBottom: 9 },
  compactTrackTitle: { color: c.text, fontWeight: '700', fontSize: 18 },
  compactTrackArtist: { color: c.muted, marginTop: 2, fontSize: 14 },
  metadata: { width: '100%', maxWidth: 440, minHeight: metadataHeight, flexDirection: 'row', alignItems: 'center', gap: 5 },
  trackCopy: { minWidth: 0, flex: 1 },
  trackTitle: { fontSize: 30, fontWeight: '700', letterSpacing: -1, color: c.text },
  compactTitle: { fontSize: 25 },
  artist: { marginTop: 3, color: c.muted, fontWeight: '500', fontSize: 16 },
  lyricPage: { flex: 1, paddingHorizontal: 25 },
  noLyrics: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  noLyricsTitle: { color: c.muted, fontSize: 16, fontWeight: '600' },
  transport: { width: '100%', maxWidth: 500, alignSelf: 'center', paddingHorizontal: 25, paddingTop: 8, paddingBottom: 6 },
  transportCompact: { paddingTop: 2, paddingBottom: 2 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -1, paddingHorizontal: 1 },
  time: { color: c.quiet, fontVariant: ['tabular-nums'], fontSize: 12, fontWeight: '600' },
  transportButtons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly', marginTop: 12, marginBottom: 10 },
  transportButtonsCompact: { marginTop: 6, marginBottom: 5 },
  primaryButton: { width: 66, height: 66 },
  primaryButtonCompact: { width: 56, height: 56 },
  volumeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  volumeSlider: { flex: 1 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: 8 },
  footerSide: { flex: 1, alignItems: 'center' },
  output: { flex: 1.3, minWidth: 0 },
});
