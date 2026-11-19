import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { BackHandler, Platform, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { GestureDetector, useCompetingGestures, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  Easing, Extrapolation, interpolate, useAnimatedProps, useAnimatedReaction, useAnimatedStyle, useSharedValue, withDelay,
  withSpring, withTiming,
} from 'react-native-reanimated';
import { initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { formatTime } from './catalog';
import { MiniPlayerContent } from './MiniPlayer';
import {
  grab, progress, settle, sideInsets, travel, usePlayerTransition, type Bubble, type BubbleVariant, type PlayerPage,
} from './player/transition';
import { usePlayback, usePlaybackState } from './playback';
import { Icon } from './ui';
import QueuePage from './player/QueuePage';
import TransportSlider from './player/TransportSlider';
import { CollapseButton, DeviceButton, LyricButton, PlayerButton, TrackMenuButton } from './player/Controls';
import { selectionFeedback } from './player/design';
import { createThemedStyles, useColors } from './theme';

const artworkRadius = 21;
const artworkGap = 14;
const grabberHeight = 32;
const metadataHeight = 60;
const compactArtworkSize = 54;
const compactArtworkRadius = 11;
const artworkInset = 24;
const compactArtworkTop = 7;
const miniCoverRadius = 8;
const cardRadius = 38;
const handover = 50;
const sheetRoutes = ['/devices', '/track-actions', '/session'];
const modeMotion = { duration: 360, easing: Easing.inOut(Easing.cubic) };
const panelMotion = { duration: 210 };
const clamp = Extrapolation.CLAMP;

const Glass = Animated.createAnimatedComponent(BlurView);

type DetailPage = Exclude<PlayerPage, 'player'>;
type Artwork = { x: number; y: number; size: number; radius: number };

/** The artwork on its way between the bubble's cover and its place in the player, `y` from the panel's top. */
function artworkInFlight(bubble: Bubble, follow: number, placed: Artwork) {
  'worklet';
  const coverX = bubble.x + bubble.coverInset;
  const coverY = (bubble.height - bubble.coverSize) / 2;
  // Drop clear of the bubble's title before growing across it.
  const drop = 1 - (1 - follow) ** 3;
  return {
    x: coverX + (placed.x - coverX) * follow,
    y: coverY + (placed.y - coverY) * drop,
    size: bubble.coverSize + (placed.size - bubble.coverSize) * follow,
    radius: miniCoverRadius + (placed.radius - miniCoverRadius) * follow,
    margin: coverY,
  };
}

/**
 * Now Playing stays mounted above the tabs so it can grow out of the mini-player the moment
 * it is touched. Collapsed, it is invisible and lets every touch through.
 */
export default function Player() {
  const colors = useColors();
  const styles = useStyles();
  const router = useRouter();
  const { motion, variants, showPage, close } = usePlayerTransition();
  const [page, setPage] = useState<PlayerPage>('player');
  const [seenLyrics, setSeenLyrics] = useState(false);
  const [seenQueue, setSeenQueue] = useState(false);
  const [availableHeight, setAvailableHeight] = useState(0);
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const top = insets.top || initialWindowMetrics?.insets.top || 0;
  const bottom = insets.bottom || initialWindowMetrics?.insets.bottom || 0;
  const { track, album, state, actions } = usePlaybackState();
  const detail = useSharedValue(0);
  const trackDrag = useSharedValue(0);
  const dragStart = useSharedValue(0);
  const startLead = useSharedValue(1);
  const startFollow = useSharedValue(1);
  const smallScreen = height < 750;
  const artSize = Math.min(width - insets.left - insets.right - 48, 440,
    Math.max(96, (availableHeight || height - 360) - artworkGap - metadataHeight));
  const artX = (width - insets.left - insets.right - artSize) / 2;
  const artY = Math.max(0, (availableHeight - artSize - artworkGap - metadataHeight) / 2);
  const artworkPage = page === 'player';
  const isFavorite = state.favorites.includes(track.id);
  // Phones with a home indicator have rounded displays; a square card would show in their corners.
  const screenCorner = Platform.OS === 'ios' && !Platform.isPad && bottom > 0 ? 40 : 0;

  useEffect(() => {
    showPage.current = (next) => {
      if (next === 'lyrics') setSeenLyrics(true);
      else if (next === 'queue') setSeenQueue(true);
      setPage(next);
      if (!motion.active.get()) detail.set(next === 'player' ? 0 : 1);
    };
    return () => { showPage.current = null; };
  }, [detail, motion, showPage]);

  useEffect(() => {
    detail.set(withTiming(artworkPage ? 0 : 1, modeMotion));
  }, [artworkPage, detail]);

  const rest = () => {
    setPage('player');
    setSeenLyrics(false);
    setSeenQueue(false);
    detail.set(0);
    trackDrag.set(0);
  };
  useAnimatedReaction(
    () => motion.active.value,
    (now, before) => {
      if (before && !now) scheduleOnRN(rest);
    },
  );

  const dismissPan = {
    activeOffsetY: 8,
    failOffsetY: -10,
    failOffsetX: [-14, 14],
    onActivate: (event) => {
      'worklet';
      if (!motion.active.value || !motion.bubble.value) return;
      grab(motion);
      startLead.value = motion.lead.value;
      startFollow.value = motion.follow.value;
      dragStart.value = event.translationY;
    },
    onUpdate: (event) => {
      'worklet';
      const bubble = motion.bubble.value;
      if (!bubble || !motion.dragging.value) return;
      const moved = (event.translationY - dragStart.value) / travel(bubble);
      motion.lead.value = Math.min(1, Math.max(0, startLead.value - moved));
      motion.follow.value = Math.min(1, Math.max(0, startFollow.value - moved));
    },
    onDeactivate: (event) => {
      'worklet';
      if (!motion.active.value) return;
      const bubble = motion.bubble.value;
      const closes = !event.canceled && event.velocityY > -300 && (event.translationY > 88 || event.velocityY > 760);
      settle(motion, !closes, bubble ? -event.velocityY / travel(bubble) : 0);
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
      if (motion.expanding.value) trackDrag.value = Math.max(-48, Math.min(48, event.translationX * 0.32));
    },
    onDeactivate: (event) => {
      const distance = Math.abs(event.translationX);
      if (motion.expanding.value && !event.canceled &&
        (distance > 60 || (distance > 20 && Math.abs(event.velocityX) > 720))) {
        scheduleOnRN(skipTrack, event.translationX);
      }
      trackDrag.value = withSpring(0, { damping: 25, stiffness: 280 });
    },
  });
  const artworkGesture = useCompetingGestures(artworkDismiss, skipSwipe);

  const placedArtwork = (d: number, drag: number): Artwork => {
    'worklet';
    return {
      x: insets.left + artX + (artworkInset - artX) * d + drag * (1 - d),
      y: top + grabberHeight + artY + (compactArtworkTop - artY) * d,
      size: artSize + (compactArtworkSize - artSize) * d,
      radius: artworkRadius + (compactArtworkRadius - artworkRadius) * d,
    };
  };

  const panelStyle = useAnimatedStyle(() => {
    const bubble = motion.bubble.value;
    const { lead, follow } = progress(motion);
    if (!bubble) return { left: 0, top: 0, width, height, borderRadius: 0, opacity: lead };
    const { left, right } = sideInsets(bubble, follow, width);
    const art = artworkInFlight(bubble, follow, placedArtwork(detail.value, trackDrag.value));
    const edge = bubble.y * (1 - lead);
    const floor = bubble.y + bubble.height + (height - bubble.y - bubble.height) * follow;
    return {
      left,
      top: edge,
      width: width - left - right,
      // Never shorter than the artwork it carries: collapsing, the glass closes around the cover last.
      height: Math.max(bubble.height, floor - edge, art.y + art.size + art.margin),
      borderRadius: interpolate(follow, [0, 0.3, 1], [bubble.height / 2, cardRadius, screenCorner]),
      opacity: 1,
    };
  });

  // The page keeps its place on screen sideways and rides the panel's top edge.
  const pageStyle = useAnimatedStyle(() => {
    const bubble = motion.bubble.value;
    return { transform: [{ translateX: bubble ? -sideInsets(bubble, progress(motion).follow, width).left : 0 }] };
  });

  const glassProps = useAnimatedProps(() => ({
    intensity: motion.bubble.value ? interpolate(progress(motion).follow, [0, 0.1, 0.45, 0.6], [0, 70, 70, 0], clamp) : 0,
  }));

  const backdropStyle = useAnimatedStyle(() => ({
    opacity: motion.bubble.value ? interpolate(progress(motion).follow, [0, 0.4], [0, 1], clamp) : 1,
  }));

  const contentStyle = useAnimatedStyle(() => ({
    opacity: motion.bubble.value ? interpolate(progress(motion).lead, [0.3, 0.62], [0, 1], clamp) : 1,
  }));

  // Whatever sits where the bubble's own title rides gives way to it first.
  const grabberStyle = useAnimatedStyle(() => ({
    opacity: motion.bubble.value ? interpolate(progress(motion).lead, [0.72, 0.95], [0, 1], clamp) : 1,
  }));

  const artworkStyle = useAnimatedStyle(() => {
    const placed = placedArtwork(detail.value, trackDrag.value);
    const bubble = motion.bubble.value;
    if (!bubble) return { left: placed.x, top: placed.y, width: placed.size, height: placed.size, borderRadius: placed.radius };
    const { follow } = progress(motion);
    const art = artworkInFlight(bubble, follow, placed);
    return {
      left: art.x - sideInsets(bubble, follow, width).left,
      top: art.y,
      width: art.size,
      height: art.size,
      borderRadius: art.radius,
    };
  });
  const artworkDetailsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(detail.value, [0, 0.44], [1, 0], clamp),
    transform: [{ translateX: trackDrag.value }],
  }));
  const compactDetailsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(detail.value, [0.38, 0.92], [0, 1], clamp) *
      (motion.bubble.value ? interpolate(progress(motion).lead, [0.72, 0.95], [0, 1], clamp) : 1),
  }));
  const lyricsStyle = useAnimatedStyle(() => ({ opacity: withTiming(page === 'lyrics' ? 1 : 0, panelMotion) }));
  const queueStyle = useAnimatedStyle(() => ({ opacity: withTiming(page === 'queue' ? 1 : 0, panelMotion) }));

  const togglePage = (next: DetailPage) => {
    selectionFeedback();
    if (next === 'lyrics') setSeenLyrics(true);
    else setSeenQueue(true);
    setPage(current => current === next ? 'player' : next);
  };
  const openTrackMenu = (trackId: string) => router.push({ pathname: '/track-actions', params: { id: trackId } });
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
        color={isFavorite ? colors.accent : colors.text}
      />
      <TrackMenuButton trackId={track.id} onPress={() => openTrackMenu(track.id)} />
    </>
  );

  return (
    <Overlay>
      <Animated.View style={[styles.panel, panelStyle]}>
        <Glass tint="systemThinMaterial" animatedProps={glassProps} style={StyleSheet.absoluteFill} />
        <Animated.View style={[styles.page, { width, height }, pageStyle]}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: album.color }, backdropStyle]} pointerEvents="none">
            <Image source={album.artwork} blurRadius={70} contentFit="cover" transition={210} style={styles.backdropArt} />
            <LinearGradient
              colors={colors.playerGradient}
              locations={[0, 0.39, 0.85, 1]}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
          <Animated.View style={[styles.safe, { paddingTop: top, paddingBottom: bottom, paddingLeft: insets.left, paddingRight: insets.right }, contentStyle]}>
            <GestureDetector gesture={grabberDismiss}>
              <Animated.View style={[styles.grabberTouch, grabberStyle]}>
                <CollapseButton onPress={close} />
              </Animated.View>
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
                <View style={styles.detailPanel}>
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
                    <QueuePage onTrackMenu={openTrackMenu} />
                  </Animated.View>}
                </View>
              </Animated.View>}
            </View>
            <Transport key={track.id} compact={smallScreen} page={page} onToggle={togglePage}
              onDevices={() => router.push('/devices')} />
          </Animated.View>
        </Animated.View>
        {variants.map(variant => (
          <BubbleContent key={`${variant.native}-${variant.compact}`} variant={variant} width={width} />
        ))}
        <Animated.View pointerEvents="none" style={[styles.artwork, artworkStyle]}>
          <Image source={album.artwork} contentFit="cover" style={StyleSheet.absoluteFill} />
        </Animated.View>
      </Animated.View>
    </Overlay>
  );
}

/**
 * Covers the screen while the player is up. Touches are taken and released on the animation's
 * own thread, and React hears about the player only once it has settled, so nothing re-renders
 * while it is moving.
 */
function Overlay({ children }: PropsWithChildren) {
  const pathname = usePathname();
  const { motion, close } = usePlayerTransition();
  const [expanded, setExpanded] = useState(false);
  const sheetOpen = sheetRoutes.includes(pathname);

  useAnimatedReaction(
    () => {
      if (!motion.active.value) return false;
      return motion.expanding.value && !motion.dragging.value && motion.lead.value > 0.985 ? true : null;
    },
    (now, before) => {
      if (now !== null && now !== before) scheduleOnRN(setExpanded, now);
    },
  );

  useEffect(() => {
    if (!expanded || sheetOpen) return;
    const back = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => back.remove();
  }, [close, expanded, sheetOpen]);

  const style = useAnimatedStyle(() => ({
    // Collapsed, the overlay draws exactly what the mini-player does. Linger a few frames so the
    // bubble is never empty while its own content comes back.
    opacity: motion.active.value ? 1 : withDelay(handover, withTiming(0, { duration: 0 })),
    // Let touches through to the tabs again once the player is most of the way back in the bubble.
    pointerEvents: motion.active.value && (motion.expanding.value || motion.lead.value > 0.25) ? 'auto' : 'none',
  }));

  return (
    <Animated.View style={[StyleSheet.absoluteFill, style]} aria-modal={expanded} aria-hidden={!expanded}>
      {children}
    </Animated.View>
  );
}

/** The mini-player's own content, riding the top of the panel until the player has taken shape. */
function BubbleContent({ variant, width }: { variant: BubbleVariant; width: number }) {
  const styles = useStyles();
  const { motion } = usePlayerTransition();
  const style = useAnimatedStyle(() => {
    const bubble = motion.bubble.value;
    if (!bubble || bubble.compact !== variant.compact) return { opacity: 0, transform: [{ translateX: 0 }] };
    const { lead, follow } = progress(motion);
    return {
      opacity: interpolate(lead, [0.5, 0.85], [1, 0], clamp),
      transform: [{ translateX: bubble.x - sideInsets(bubble, follow, width).left }],
    };
  });
  return (
    <Animated.View pointerEvents="none" style={[styles.bubbleContent, { width: variant.width, height: variant.height }, style]}>
      <MiniPlayerContent native={variant.native} compact={variant.compact} preview />
    </Animated.View>
  );
}

function LyricsPage({ visible }: { visible: boolean }) {
  const colors = useColors();
  const styles = useStyles();
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
          <Icon name="quote.bubble" size={29} color={colors.quiet} />
          <Text style={styles.noLyricsTitle}>No lyrics available</Text>
        </View>
      )}
    </View>
  );
}

/** The only part of the transport that follows the playback clock, so each tick redraws just this. */
function Scrubber() {
  const styles = useStyles();
  const { track, position, actions } = usePlayback();
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
    <>
      <TransportSlider label="Playback position" value={shown} maximum={track.duration} onChange={seekChange} onEdit={seekEditing} />
      <View style={styles.timeRow}>
        <Text style={styles.time}>{formatTime(shown)}</Text>
        <Text style={styles.time}>−{formatTime(Math.max(0, track.duration - shown))}</Text>
      </View>
    </>
  );
}

function Transport({ compact, page, onToggle, onDevices }: {
  compact: boolean;
  page: PlayerPage;
  onToggle: (page: DetailPage) => void;
  onDevices: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const { state, device, actions } = usePlaybackState();

  return (
    <View style={[styles.transport, compact && styles.transportCompact]}>
      <Scrubber />
      <View style={[styles.transportButtons, compact && styles.transportButtonsCompact]}>
        <PlayerButton icon="backward.fill" label="Previous track" size={27} onPress={() => { selectionFeedback(); actions.previous(); }} />
        <PlayerButton
          icon={state.playing ? 'pause.fill' : 'play.fill'}
          label={state.playing ? 'Pause' : 'Play'}
          size={40}
          color={colors.text}
          onPress={() => { selectionFeedback(); actions.playPause(); }}
          style={[styles.primaryButton, compact && styles.primaryButtonCompact]}
        />
        <PlayerButton icon="forward.fill" label="Next track" size={27} onPress={() => { selectionFeedback(); actions.next(); }} />
      </View>
      <View style={styles.volumeRow}>
        <Icon name="speaker.fill" size={13} color={colors.muted} />
        <View style={styles.volumeSlider}>
          <TransportSlider label="Volume" value={state.volume} maximum={1} onChange={actions.setVolume} />
        </View>
        <Icon name="speaker.wave.3.fill" size={15} color={colors.muted} />
      </View>
      <View style={styles.footer}>
        <View style={styles.footerSide}>
          <PlayerButton icon="quote.bubble"
            label={page === 'lyrics' ? 'Hide lyrics' : 'Show lyrics'}
            selected={page === 'lyrics'}
            size={22}
            color={page === 'lyrics' ? colors.accent : colors.muted}
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
            color={page === 'queue' ? colors.accent : colors.muted}
            onPress={() => onToggle('queue')} />
        </View>
      </View>
    </View>
  );
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  panel: { position: 'absolute', overflow: 'hidden', borderCurve: 'continuous' },
  page: { position: 'absolute', top: 0, left: 0 },
  bubbleContent: { position: 'absolute', top: 0, left: 0 },
  safe: { flex: 1 },
  backdropArt: { width: '110%', height: '86%', opacity: 0.62 },
  grabberTouch: { height: grabberHeight, alignItems: 'center', justifyContent: 'center' },
  deckFrame: { flex: 1 },
  nowPlaying: { flex: 1, justifyContent: 'center', alignItems: 'center', paddingHorizontal: artworkInset, gap: artworkGap },
  artwork: { position: 'absolute', overflow: 'hidden', backgroundColor: colors.surface },
  details: { ...StyleSheet.absoluteFill, paddingTop: compactArtworkTop },
  detailPanel: { flex: 1 },
  compactMetadata: { alignSelf: 'stretch', width: 'auto', maxWidth: undefined, minHeight: compactArtworkSize,
    marginLeft: artworkInset + compactArtworkSize + 12, marginRight: artworkInset, marginBottom: 9 },
  compactTrackTitle: { color: colors.text, fontWeight: '700', fontSize: 18 },
  compactTrackArtist: { color: colors.muted, marginTop: 2, fontSize: 14 },
  metadata: { width: '100%', maxWidth: 440, minHeight: metadataHeight, flexDirection: 'row', alignItems: 'center', gap: 5 },
  trackCopy: { minWidth: 0, flex: 1 },
  trackTitle: { fontSize: 30, fontWeight: '700', letterSpacing: -1, color: colors.text },
  compactTitle: { fontSize: 25 },
  artist: { marginTop: 3, color: colors.muted, fontWeight: '500', fontSize: 16 },
  lyricPage: { flex: 1, paddingHorizontal: 25 },
  noLyrics: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  noLyricsTitle: { color: colors.muted, fontSize: 16, fontWeight: '600' },
  transport: { width: '100%', maxWidth: 500, alignSelf: 'center', paddingHorizontal: 25, paddingTop: 8, paddingBottom: 6 },
  transportCompact: { paddingTop: 2, paddingBottom: 2 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -1, paddingHorizontal: 1 },
  time: { color: colors.quiet, fontVariant: ['tabular-nums'], fontSize: 12, fontWeight: '600' },
  transportButtons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly', marginTop: 12, marginBottom: 10 },
  transportButtonsCompact: { marginTop: 6, marginBottom: 5 },
  primaryButton: { width: 66, height: 66 },
  primaryButtonCompact: { width: 56, height: 56 },
  volumeRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  volumeSlider: { flex: 1 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: 8 },
  footerSide: { flex: 1, alignItems: 'center' },
  output: { flex: 1.3, minWidth: 0 },
}));
