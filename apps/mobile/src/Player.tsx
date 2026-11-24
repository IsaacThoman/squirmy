import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { ActivityIndicator, BackHandler, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { GestureDetector, useCompetingGestures, usePanGesture } from 'react-native-gesture-handler';
import Animated, {
  Easing, Extrapolation, interpolate, interpolateColor, useAnimatedProps, useAnimatedReaction, useAnimatedStyle, useReducedMotion,
  useSharedValue, withDelay, withSpring, withTiming, type SharedValue,
} from 'react-native-reanimated';
import { initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { formatDuration, formatRemaining } from '@squirmy/client-core';
import { useArtworkImage } from './data/artwork';
import { fallbackTint } from './data/color';
import { useLibraryActions, useLiked, useLikeFailure } from './data/library';
import { heartButton, heartColor } from './library/heart';
import { loadFailure } from './data/errors';
import { useLyrics } from './data/queries';
import { MiniPlayerContent } from './MiniPlayer';
import {
  grab, progress, settle, sideInsets, travel, usePlayerTransition, type Bubble, type BubbleVariant, type Motion, type PlayerPage,
} from './player/transition';
import { useLoading, usePlaybackState, usePosition } from './playback';
import { DETACHED_LABEL, DETACHED_SYMBOL } from './player/detach';
import { playPauseLabel, STILL_LOADING_LABEL } from './player/loading';
import { activeLine, lineInView, lyricLines } from './player/lyrics';
import { artworkTransform, type ArtworkFrame } from './player/artwork';
import { ArtworkPrefetch } from './player/ArtworkPrefetch';
import { usePlaybackStatus } from './player/usePlaybackStatus';
import { usePlayerShown } from './player/visibility';
import { useVolumeSlider } from './player/volume';
import { Icon } from './ui';
import { SystemVolumeSlider } from '../modules/now-playing';
import QueuePage from './player/QueuePage';
import TransportSlider from './player/TransportSlider';
import { CollapseButton, DeviceButton, LyricButton, PlayerButton, TrackLinksMenu, TrackMenuButton } from './player/Controls';
import { selectionFeedback } from './player/design';
import { metadataHeight as metadataHeightFor, rhythm as rhythmFor, type Rhythm } from './player/layout';
import { seekLanded } from './player/scrub';
import { displayFontScale, secondaryFontScale } from './fontScale';
import { createThemedStyles, useColors } from './theme';

const artworkRadius = 21;
const grabberHeight = 32;
const compactArtworkSize = 54;
const compactArtworkRadius = 11;
const artworkInset = 24;
/** The title, the controls and the volume share these edges, as in Apple Music; the artwork may reach past them. */
const edgeInset = 32;
const compactArtworkTop = 7;
const miniCoverRadius = 8;
const cardRadius = 38;
const handover = 50;
const sheetRoutes = ['/devices', '/track-actions', '/add-to-playlist'];
const modeMotion = { duration: 360, easing: Easing.inOut(Easing.cubic) };
const panelMotion = { duration: 210 };
const clamp = Extrapolation.CLAMP;

const Glass = Animated.createAnimatedComponent(BlurView);

type DetailPage = Exclude<PlayerPage, 'player'>;

/** The artwork on its way between the bubble's cover and its place in the player, `y` from the panel's top. */
function artworkInFlight(bubble: Bubble, follow: number, placed: ArtworkFrame): ArtworkFrame & { margin: number } {
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
  const { motion, variants, close } = usePlayerTransition();
  const [page, setPage] = useState<PlayerPage>('player');
  const [seenLyrics, setSeenLyrics] = useState(false);
  const [seenQueue, setSeenQueue] = useState(false);
  const [availableHeight, setAvailableHeight] = useState(0);
  const { width, height, fontScale } = useWindowDimensions();
  const metadataHeight = metadataHeightFor(fontScale);
  const rhythm = rhythmFor(height);
  // The artwork sits right under the grabber, as in Apple Music.
  const headerHeight = grabberHeight;
  const insets = useSafeAreaInsets();
  const top = insets.top || initialWindowMetrics?.insets.top || 0;
  const bottom = insets.bottom || initialWindowMetrics?.insets.bottom || 0;
  const { current, track, actions } = usePlaybackState();
  const loading = useLoading();
  const { setLiked } = useLibraryActions();
  const artwork = track?.album?.artwork;
  const artworkImage = useArtworkImage(artwork, 440);
  const backdropImage = useArtworkImage(artwork, 300);
  const detail = useSharedValue(0);
  const trackDrag = useSharedValue(0);
  const dragStart = useSharedValue(0);
  const startLead = useSharedValue(1);
  const startFollow = useSharedValue(1);
  const smallScreen = height < 750;
  const artSize = Math.min(width - insets.left - insets.right - 48, 440,
    Math.max(96, (availableHeight || height - 360) - rhythm.artworkGap - metadataHeight));
  const artX = (width - insets.left - insets.right - artSize) / 2;
  const artY = 0;
  const artworkPage = page === 'player';
  const isFavorite = useLiked('track', track?.id, track?.liked);
  const heart = heartButton(isFavorite, track?.title ?? '', useLikeFailure('track', track?.id));
  const title = track?.title ?? (current ? '' : 'Not Playing');
  const subtitle = loading === 'slow' ? STILL_LOADING_LABEL : track?.artistCredit ?? '';
  // What playback has to say (a skipped song, a pause the server caused) takes the artist's
  // lines for a while, in the room `metadataHeight` keeps for two: its quieter detail goes on the second.
  const status = usePlaybackStatus();
  const statusLabel = status ? (status.detail ? `${status.message}. ${status.detail}` : status.message) : undefined;
  // Phones with a home indicator have rounded displays; a square card would show in their corners.
  const screenCorner = Platform.OS === 'ios' && !Platform.isPad && bottom > 0 ? 40 : 0;

  useEffect(() => {
    detail.set(withTiming(artworkPage ? 0 : 1, modeMotion));
  }, [artworkPage, detail]);

  useAnimatedReaction(
    () => motion.active.value,
    (now, before) => {
      if (before && !now) trackDrag.set(0);
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
  // Swiping down over the controls closes Now Playing too; the sliders take only sideways drags.
  const transportDismiss = usePanGesture(dismissPan);
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

  const placedArtwork = (d: number, drag: number): ArtworkFrame => {
    'worklet';
    return {
      x: insets.left + artX + (artworkInset - artX) * d + drag * (1 - d),
      y: top + headerHeight + artY + (compactArtworkTop - artY) * d,
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

  // Laid out once at its size in the player and moved there by transforms, so the image is
  // decoded once, at full size, and nothing is laid out while it flies. The styles read the shared
  // values themselves: Reanimated reruns a style only for those its own closure holds.
  const artworkFrame = (bubble: Bubble | null, follow: number, d: number, drag: number): ArtworkFrame => {
    'worklet';
    const placed = placedArtwork(d, drag);
    if (!bubble) return placed;
    const art = artworkInFlight(bubble, follow, placed);
    return { ...art, x: art.x - sideInsets(bubble, follow, width).left };
  };
  const artworkStyle = useAnimatedStyle(() => artworkTransform(
    artworkFrame(motion.bubble.value, progress(motion).follow, detail.value, trackDrag.value), artSize));
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
  const openTrackMenu = (id: string, albumId?: string | null) => router.push({ pathname: '/track-actions', params: { id, albumId: albumId ?? '' } });
  const trackDetails = (compact: boolean) => (
    <>
      <View style={styles.trackCopy}>
        <TrackLinksMenu track={track} accessibilityLabel={[title, statusLabel ?? subtitle].filter(Boolean).join(', ')}>
          {/* Two lines, as Apple Music gives a long title; `metadataHeight` keeps room for both. */}
          <Text numberOfLines={compact ? 1 : 2} maxFontSizeMultiplier={displayFontScale}
            style={compact ? styles.compactTrackTitle : [styles.trackTitle, smallScreen && styles.compactTitle]}>{title}</Text>
          {/* Two lines too: a featured artist ("feat. Pharrell Williams & Nile Rodgers") is part of the credit. */}
          {status
            ? <Text numberOfLines={compact ? 1 : 2} maxFontSizeMultiplier={secondaryFontScale}
              accessibilityLabel={statusLabel}
              style={[compact ? styles.compactTrackArtist : styles.artist, styles.status]}>
              {status.message}{!compact && status.detail ? <Text style={styles.statusDetail}>{`\n${status.detail}`}</Text> : null}
            </Text>
            : <Text numberOfLines={compact ? 1 : 2} maxFontSizeMultiplier={secondaryFontScale} style={compact ? styles.compactTrackArtist : styles.artist}>{subtitle}</Text>}
        </TrackLinksMenu>
      </View>
      {track && <PlayerButton
        icon={heart.icon}
        label={heart.label}
        selected={isFavorite}
        onPress={() => { selectionFeedback(); setLiked('track', track.id, !isFavorite, track.title); }}
        color={heartColor(heart, colors, colors.text)}
      />}
      {track && <TrackMenuButton track={track} onPress={() => openTrackMenu(track.id, track.album?.id)} />}
    </>
  );

  return (
    <Overlay>
      {/* Outside the panel, which is laid out again on every frame of the morph. */}
      <ArtworkPrefetch size={artSize} />
      <Animated.View style={[styles.panel, panelStyle]}>
        <Glass tint="systemThinMaterial" animatedProps={glassProps} style={StyleSheet.absoluteFill} />
        <Animated.View style={[styles.page, { width, height }, pageStyle]}>
          <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: artwork?.color ?? fallbackTint }, backdropStyle]} pointerEvents="none">
            {backdropImage && <Image source={backdropImage.source} placeholder={backdropImage.placeholder} blurRadius={70}
              contentFit="cover" cachePolicy="memory-disk" transition={210} style={styles.backdropArt} />}
            <LinearGradient
              colors={colors.playerGradient}
              locations={[0, 0.39, 0.85, 1]}
              style={StyleSheet.absoluteFill}
            />
          </Animated.View>
          {/* The footer reaches a little into the home indicator's margin, as Apple Music's does. */}
          <Animated.View style={[styles.safe, { paddingTop: top, paddingBottom: Math.max(0, bottom - 14), paddingLeft: insets.left,
            paddingRight: insets.right }, contentStyle]}>
            <GestureDetector gesture={grabberDismiss}>
              <Animated.View style={[styles.grabberTouch, { height: headerHeight }, grabberStyle]}>
                <View style={styles.collapse} pointerEvents="box-none"><CollapseButton onPress={close} /></View>
              </Animated.View>
            </GestureDetector>
            <View style={styles.deckFrame} onLayout={(event) => setAvailableHeight(event.nativeEvent.layout.height)}>
              <GestureDetector gesture={artworkGesture} touchAction="none">
                <View collapsable={false} style={[styles.nowPlaying, { gap: rhythm.artworkGap }]}
                  pointerEvents={artworkPage ? 'auto' : 'none'} accessibilityElementsHidden={!artworkPage}
                  importantForAccessibility={artworkPage ? 'auto' : 'no-hide-descendants'}>
                  <View style={{ height: artSize }} />
                  {/* A fixed height, with the lines in its middle: a one-line title and artist sit as Apple Music's do, and longer ones take the room around them. */}
                  <Animated.View style={[styles.metadataSlot, { height: metadataHeight }, artworkDetailsStyle]}>
                    <View style={styles.metadata}>{trackDetails(false)}</View>
                  </Animated.View>
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
                    <LyricsPage key={current?.id ?? 'none'} selected={page === 'lyrics'} />
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
            <GestureDetector gesture={transportDismiss}>
              <Transport key={current?.id ?? 'none'} compact={smallScreen} rhythm={rhythm} page={page} onToggle={togglePage}
                onDevices={() => router.push('/devices')} />
            </GestureDetector>
          </Animated.View>
        </Animated.View>
        {variants.map(variant => (
          <BubbleContent key={`${variant.native}-${variant.compact}`} variant={variant} width={width} />
        ))}
        <Animated.View pointerEvents="none" style={[styles.artwork, { width: artSize, height: artSize }, artworkStyle]}>
          {artworkImage
            ? <Image source={artworkImage.source} placeholder={artworkImage.placeholder} placeholderContentFit="cover"
              contentFit="cover" cachePolicy="memory-disk" transition={160} style={StyleSheet.absoluteFill} />
            : <NoArtwork base={artSize} frame={artworkFrame} motion={motion} detail={detail} trackDrag={trackDrag} />}
        </Animated.View>
      </Animated.View>
    </Overlay>
  );
}

/** The note shown without artwork, kept at its size as the frame around it grows. */
function NoArtwork({ base, frame, motion, detail, trackDrag }: {
  base: number;
  frame: (bubble: Bubble | null, follow: number, d: number, drag: number) => ArtworkFrame;
  motion: Motion;
  detail: SharedValue<number>;
  trackDrag: SharedValue<number>;
}) {
  const colors = useColors();
  const styles = useStyles();
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: base / frame(motion.bubble.value, progress(motion).follow, detail.value, trackDrag.value).size }],
  }));
  return <View style={styles.noArtwork}>
    <Animated.View style={style}><Icon name="music.note" size={48} color={colors.quiet} /></Animated.View>
  </View>;
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

function LyricsPage({ selected }: { selected: boolean }) {
  const colors = useColors();
  const styles = useStyles();
  const shown = usePlayerShown();
  const visible = selected && shown;
  const { track, actions } = usePlaybackState();
  const lyrics = useLyrics(track);
  const { lines, synced } = lyricLines(lyrics.data);
  const position = usePosition(visible && synced);
  const active = synced ? Math.max(0, activeLine(lines, position)) : -1;
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const lineCenters = useRef<number[]>([]);
  const [viewport, setViewport] = useState(0);
  // Whether the active line has been laid out. Lines lay out after the page appears, and while
  // paused the active line never changes, so without this the page would open on the first
  // lines with the current one somewhere below.
  const [placed, setPlaced] = useState(false);
  // Scrolling by hand stops the page following the song, so a reader can look ahead or back;
  // "Back to current line" resumes it, as on Apple Music, and so does scrolling back to the sung
  // line, tapping a line or leaving the page. No timer pulls a reader back while they read.
  const [following, setFollowing] = useState(true);
  const momentum = useRef(false);
  const follows = following || !synced;

  useEffect(() => {
    if (!visible) setFollowing(true);
  }, [visible]);

  useEffect(() => {
    const center = lineCenters.current[active];
    if (visible && follows && viewport && center !== undefined) {
      scroll.current?.scrollTo({ y: Math.max(0, center - viewport * 0.33), animated: active > 0 });
    }
  }, [active, visible, viewport, placed, follows]);

  const browse = () => setFollowing(false);
  const settle = (offset: number) => {
    if (lineInView(lineCenters.current[active], offset, viewport)) setFollowing(true);
  };

  // Loading, none and failed look different: a failed request is not a song without lyrics.
  // A request waiting for the connection (paused) has failed for now, too.
  const failure = lyrics.isError || (lyrics.isPending && lyrics.fetchStatus === 'paused') ? loadFailure(lyrics.error) : null;
  const empty: { icon: string; title: string; detail?: string; retry?: boolean } | null = lyrics.data?.instrumental
    ? { icon: 'music.note', title: 'Instrumental' }
    : failure ? { icon: failure.connection ? 'wifi.exclamationmark' : 'exclamationmark.circle', title: 'Couldn’t load lyrics',
      detail: failure.description, retry: failure.retry }
      : lyrics.isLoading ? null : { icon: 'quote.bubble', title: 'No lyrics available' };

  return (
    <View style={styles.lyricPage}>
      {lines.length ? (
        <ScrollView
          ref={scroll}
          contentInsetAdjustmentBehavior="never"
          onLayout={(event) => setViewport(event.nativeEvent.layout.height)}
          contentContainerStyle={{ paddingTop: 22, paddingBottom: viewport * 0.6 }}
          showsVerticalScrollIndicator={false}
          onScrollBeginDrag={browse}
          onMomentumScrollBegin={() => { momentum.current = true; }}
          // A drag that ends without a fling has come to rest; one with a fling rests when its momentum ends.
          onScrollEndDrag={({ nativeEvent }) => {
            momentum.current = false;
            if (!nativeEvent.velocity?.y) settle(nativeEvent.contentOffset.y);
          }}
          onMomentumScrollEnd={({ nativeEvent }) => {
            if (!momentum.current) return;
            momentum.current = false;
            settle(nativeEvent.contentOffset.y);
          }}
        >
          {lines.map((line, index) => (
            <View key={index} onLayout={(event) => {
              const { y, height } = event.nativeEvent.layout;
              lineCenters.current[index] = y + height / 2;
              if (index === active) setPlaced(true);
            }}>
              <LyricButton line={line.text} active={!synced || index === active}
                onPress={line.startMs === null ? undefined : () => { selectionFeedback(); setFollowing(true); actions.seek(line.startMs!); }} />
            </View>
          ))}
        </ScrollView>
      ) : null}
      {lines.length > 0 && !follows && (
        <Pressable accessibilityRole="button" onPress={() => { selectionFeedback(); setFollowing(true); }}
          style={({ pressed }) => [styles.backToLine, pressed && styles.pressed]}>
          <Icon name="arrow.up.arrow.down" size={14} color={colors.accent} />
          <Text maxFontSizeMultiplier={secondaryFontScale} style={styles.backToLineText}>Back to current line</Text>
        </Pressable>
      )}
      {lines.length ? null : empty ? (
        <View style={styles.noLyrics}>
          <Icon name={empty.icon} size={29} color={colors.quiet} />
          <Text style={styles.noLyricsTitle}>{empty.title}</Text>
          {empty.detail && <Text style={styles.noLyricsDetail}>{empty.detail}</Text>}
          {empty.retry && <Pressable accessibilityRole="button" hitSlop={10} onPress={() => { selectionFeedback(); void lyrics.refetch(); }}
            style={({ pressed }) => [styles.retry, pressed && styles.pressed]}>
            <Text style={styles.retryText}>Try again</Text>
          </Pressable>}
        </View>
      ) : (
        <View style={styles.noLyrics} accessible accessibilityLabel="Loading lyrics">
          <ActivityIndicator color={colors.muted} />
        </View>
      )}
    </View>
  );
}

/** The only part of the transport that follows the playback clock, so each tick redraws just this. */
function Scrubber() {
  const styles = useStyles();
  const colors = useColors();
  const reduceMotion = useReducedMotion();
  const { durationMs: duration, current, actions } = usePlaybackState();
  // Collapsed, Now Playing stays mounted but unseen; its clock waits until it opens again.
  const position = usePosition(usePlayerShown());
  const [draft, setDraft] = useState<number | null>(null);
  // Where the last drag let go, shown until playback reports it, so the bar never flicks back meanwhile.
  const [landing, setLanding] = useState<number | null>(null);
  const shown = Math.min(draft ?? landing ?? position, duration || Infinity);
  const elapsed = formatDuration(shown);
  const scrubbing = useSharedValue(0);

  useEffect(() => {
    if (landing !== null && seekLanded(position, landing)) setLanding(null);
  }, [landing, position]);
  useEffect(() => {
    if (landing === null) return;
    // A seek that never lands, such as one the server refused, lets go after a while.
    const timer = setTimeout(() => setLanding(null), 2500);
    return () => clearTimeout(timer);
  }, [landing]);

  // While a finger scrubs, the times grow a little and brighten, as Apple Music's do; with
  // Reduce Motion they only brighten.
  const timeStyle = useAnimatedStyle(() => ({
    color: interpolateColor(scrubbing.value, [0, 1], [colors.quiet, colors.text]),
    transform: [{ scale: reduceMotion ? 1 : 1 + 0.12 * scrubbing.value }],
  }));

  return (
    <>
      <TransportSlider
        label="Playback position"
        value={shown}
        maximum={duration}
        accessibilityStep={10_000}
        valueText={elapsed}
        onChange={value => {
          if (!current) return;
          setLanding(value);
          actions.seek(value);
        }}
        onPreview={setDraft}
        onScrubbing={active => { scrubbing.set(withTiming(active ? 1 : 0, { duration: active ? 160 : 260 })); }}
      />
      <View style={styles.timeRow}>
        <Animated.Text maxFontSizeMultiplier={secondaryFontScale} style={[styles.time, styles.timeStart, timeStyle]}>{elapsed}</Animated.Text>
        <Animated.Text maxFontSizeMultiplier={secondaryFontScale} style={[styles.time, styles.timeEnd, timeStyle]}>
          {formatRemaining(shown, duration)}
        </Animated.Text>
      </View>
    </>
  );
}

function Transport({ compact, rhythm, page, onToggle, onDevices }: {
  compact: boolean;
  rhythm: Rhythm;
  page: PlayerPage;
  onToggle: (page: DetailPage) => void;
  onDevices: () => void;
}) {
  const colors = useColors();
  const styles = useStyles();
  const { session, output, volume, actions, remote, detached } = usePlaybackState();
  const loading = useLoading();
  const [shownVolume, setVolume] = useVolumeSlider(volume, value => actions.setVolume(output.id, value));

  return (
    <View style={[styles.transport, compact && styles.transportCompact]}>
      <Scrubber />
      <View style={[styles.transportButtons, { marginTop: rhythm.buttonsTop, marginBottom: rhythm.buttonsBottom }]}>
        <PlayerButton icon="backward.fill" label="Previous track" size={27} onPress={() => { selectionFeedback(); actions.previous(); }} />
        <PlayerButton
          icon={session.playing ? 'pause.fill' : 'play.fill'}
          label={playPauseLabel(session.playing, loading)}
          busy={loading !== 'none'}
          size={40}
          color={colors.text}
          onPress={() => { selectionFeedback(); actions.playPause(); }}
          style={[styles.primaryButton, compact && styles.primaryButtonCompact]}
        />
        <PlayerButton icon="forward.fill" label="Next track" size={27} onPress={() => { selectionFeedback(); actions.next(); }} />
      </View>
      {/* The speakers sit at the scrubber's ends, the track centred between them. Where this phone's
          sound goes (AirPlay, Bluetooth) is chosen in the device sheet. */}
      <View style={styles.volumeRow}>
        <Icon name="speaker.fill" size={13} color={colors.muted} style={styles.volumeLow} />
        <View style={styles.volumeSlider}>
          {/* This phone's volume is the system's, which the side buttons move too; another device's is the session's. */}
          {!remote && SystemVolumeSlider
            ? <SystemVolumeSlider tint={colors.accent} trackTint={colors.sliderTrack} style={styles.systemVolume} />
            : <TransportSlider label={`Volume, ${output.name}`} value={shownVolume} maximum={1} accessibilityStep={0.1} onChange={setVolume} />}
        </View>
        <Icon name="speaker.wave.3.fill" size={15} color={colors.muted} style={styles.volumeHigh} />
      </View>
      <View style={[styles.footer, { paddingTop: rhythm.footerTop }]}>
        <View style={styles.footerSide}>
          <PlayerButton icon="quote.bubble"
            label={page === 'lyrics' ? 'Hide lyrics' : 'Show lyrics'}
            selected={page === 'lyrics'}
            size={22}
            color={page === 'lyrics' ? colors.accent : colors.muted}
            onPress={() => onToggle('lyrics')} />
        </View>
        <View style={styles.output}>
          <DeviceButton highlighted={remote || detached} icon={detached ? DETACHED_SYMBOL : output.icon} name={detached ? DETACHED_LABEL : output.name}
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
  grabberTouch: { alignItems: 'center' },
  collapse: { position: 'absolute', top: 0, left: 0, right: 0, alignItems: 'center' },
  deckFrame: { flex: 1 },
  // The artwork at the top, the title's room under it; a tall screen's spare height goes below them.
  nowPlaying: { flex: 1, justifyContent: 'flex-start', alignItems: 'center', paddingHorizontal: edgeInset },
  artwork: { position: 'absolute', top: 0, left: 0, overflow: 'hidden', backgroundColor: colors.surface },
  noArtwork: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  details: { ...StyleSheet.absoluteFill, paddingTop: compactArtworkTop },
  detailPanel: { flex: 1 },
  compactMetadata: { alignSelf: 'stretch', width: 'auto', maxWidth: undefined, minHeight: compactArtworkSize,
    marginLeft: artworkInset + compactArtworkSize + 12, marginRight: artworkInset, marginBottom: 9 },
  compactTrackTitle: { color: colors.text, fontWeight: '700', fontSize: 18 },
  compactTrackArtist: { color: colors.muted, marginTop: 2, fontSize: 14 },
  metadataSlot: { width: '100%', maxWidth: 440, justifyContent: 'center' },
  metadata: { width: '100%', maxWidth: 440, flexDirection: 'row', alignItems: 'center', gap: 5 },
  trackCopy: { minWidth: 0, flex: 1 },
  trackTitle: { fontSize: 30, fontWeight: '700', letterSpacing: -1, color: colors.text },
  compactTitle: { fontSize: 25 },
  artist: { marginTop: 3, color: colors.muted, fontWeight: '500', fontSize: 16 },
  status: { color: colors.accent, fontWeight: '600' },
  statusDetail: { color: colors.muted, fontWeight: '500' },
  lyricPage: { flex: 1, paddingHorizontal: 25 },
  noLyrics: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12 },
  noLyricsTitle: { color: colors.muted, fontSize: 16, fontWeight: '600', textAlign: 'center' },
  noLyricsDetail: { color: colors.quiet, fontSize: 14, textAlign: 'center', marginTop: -6 },
  retry: { minHeight: 44, paddingHorizontal: 16, justifyContent: 'center' },
  retryText: { color: colors.accent, fontSize: 16, fontWeight: '700' },
  // Floats over the lyrics' bottom edge, clear of the lines' own touches, 44 pt tall.
  backToLine: { position: 'absolute', bottom: 12, alignSelf: 'center', flexDirection: 'row', alignItems: 'center', gap: 7, minHeight: 44,
    paddingHorizontal: 18, borderRadius: 22, backgroundColor: colors.sheet, borderWidth: StyleSheet.hairlineWidth, borderColor: colors.stroke },
  backToLineText: { color: colors.accent, fontSize: 15, fontWeight: '700' },
  pressed: { opacity: 0.65 },
  transport: { width: '100%', maxWidth: 500, alignSelf: 'center', paddingHorizontal: edgeInset, paddingTop: 8, paddingBottom: 6 },
  transportCompact: { paddingTop: 2, paddingBottom: 2 },
  timeRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -1, paddingHorizontal: 1 },
  time: { color: colors.quiet, fontVariant: ['tabular-nums'], fontSize: 12, fontWeight: '600' },
  // Each time grows from the end it sits at.
  timeStart: { transformOrigin: 'left top' },
  timeEnd: { transformOrigin: 'right top' },
  transportButtons: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-evenly' },
  primaryButton: { width: 66, height: 66 },
  primaryButtonCompact: { width: 56, height: 56 },
  volumeRow: { flexDirection: 'row', alignItems: 'center' },
  // The speakers' outer edges at the scrubber's ends, and the same room between each and the track.
  // speaker.fill draws about 2 pt inside its 13 pt box; speaker.wave.3.fill about 1 pt inside its 15 pt one.
  volumeLow: { marginLeft: -2, marginRight: 10 },
  volumeHigh: { marginLeft: 11, marginRight: -1 },
  volumeSlider: { flex: 1 },
  // The whole bar takes touches, 44pt tall, laid out as the 28pt the other sliders take.
  systemVolume: { height: 44, marginVertical: -8 },
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start' },
  footerSide: { flex: 1, alignItems: 'center' },
  // The sides hold one 44 pt button each, centred under the previous and next buttons as in
  // Apple Music; the device's name, such as "Only on this device", gets the rest.
  output: { flex: 1.4, minWidth: 0 },
}));
