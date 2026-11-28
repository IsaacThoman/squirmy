import { BlurView } from 'expo-blur';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import { usePathname, useRouter } from 'expo-router';
import { useEffect, useRef, useState, type PropsWithChildren } from 'react';
import { BackHandler, Platform, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
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
import { heartColor } from './library/heart';
import { OfflineBadge } from './library/shared';
import { MiniPlayerContent } from './MiniPlayer';
import {
  grab, progress, settle, sideInsets, travel, usePlayerTransition, type Bubble, type BubbleVariant, type Motion, type PlayerPage,
} from './player/transition';
import { useLoading, usePlaybackState, usePosition } from './playback';
import { DETACHED_LABEL, DETACHED_SYMBOL } from './player/detach';
import { playPauseLabel, STILL_LOADING_LABEL } from './player/loading';
import { artworkTransform, type ArtworkFrame } from './player/artwork';
import { ArtworkPrefetch } from './player/ArtworkPrefetch';
import { usePlaybackStatus } from './player/usePlaybackStatus';
import { usePlayerShown } from './player/visibility';
import { useVolumeSlider } from './player/volume';
import { SleepTimerBadge } from './player/SleepTimerBadge';
import { Icon } from './ui';
import { SystemVolumeSlider } from '../modules/now-playing';
import LyricsPage, { type LyricsHandle } from './player/LyricsPage';
import QueuePage, { queueShowsNowPlaying } from './player/QueuePage';
import TransportSlider from './player/TransportSlider';
import { CollapseButton, DeviceButton, PlayerButton, TrackLinksMenu, TrackMenuButton } from './player/Controls';
import { selectionFeedback } from './player/design';
import { useCurrentTrackHeart } from './player/useCurrentTrackHeart';
import { metadataHeight as metadataHeightFor, rhythm as rhythmFor, tabletArtworkLimit, tabletArtworkSize, tabletPaneWidth, type Rhythm } from './player/layout';
import { seekLanded } from './player/scrub';
import { skipCommits } from './player/skipSwipe';
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
// Instant under Reduce Motion, as Reanimated's timings are by default.
const chromeMotion = { duration: 300, easing: Easing.out(Easing.cubic) };
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
  // Lyrics left to play untouched hide the transport and take the screen down to its bottom edge.
  const [lyricsHideControls, setLyricsHideControls] = useState(false);
  const lyricsPage = useRef<LyricsHandle>(null);
  const [transportHeight, setTransportHeight] = useState(0);
  const [availableHeight, setAvailableHeight] = useState(0);
  const [tabletMetadataHeight, setTabletMetadataHeight] = useState(0);
  const { width, height, fontScale } = useWindowDimensions();
  // The artwork sits right under the grabber, as in Apple Music.
  const headerHeight = grabberHeight;
  const insets = useSafeAreaInsets();
  const top = insets.top || initialWindowMetrics?.insets.top || 0;
  const bottom = insets.bottom || initialWindowMetrics?.insets.bottom || 0;
  const contentWidth = width - insets.left - insets.right;
  const tablet = Platform.OS === 'ios' && Platform.isPad;
  const tabletTransport = tablet && contentWidth >= 540;
  const paneWidth = tablet ? tabletPaneWidth(contentWidth, height, fontScale) : 0;
  const docked = paneWidth > 0;
  const metadataHeight = tablet ? tabletMetadataHeight || Math.ceil(56 * Math.min(fontScale, displayFontScale)) : metadataHeightFor(fontScale);
  const rhythm = rhythmFor(tablet ? Math.min(height, 667) : height);
  const { current, track, actions } = usePlaybackState();
  const loading = useLoading();
  const artwork = track?.album?.artwork;
  const artworkImage = useArtworkImage(artwork, tablet ? tabletArtworkLimit : 440);
  const backdropImage = useArtworkImage(artwork, 300);
  const detail = useSharedValue(0);
  const queueShown = useSharedValue(0);
  const nowPlayingShift = useSharedValue(0);
  const trackDrag = useSharedValue(0);
  const dragStart = useSharedValue(0);
  const startLead = useSharedValue(1);
  const startFollow = useSharedValue(1);
  const paneProgress = useSharedValue(0);
  const paneDragStart = useSharedValue(0);
  const paneOpen = docked && page !== 'player';
  const smallScreen = height < 750;
  const deckHeight = availableHeight || height - (tablet ? 245 : 360);
  const artworkRoom = metadataHeight + rhythm.artworkGap;
  const artSize = tablet ? tabletArtworkSize(contentWidth, deckHeight, artworkRoom) :
    Math.max(1, Math.min(contentWidth - 48, 440, Math.max(96, deckHeight - artworkRoom)));
  const artSizeBesidePane = docked ? tabletArtworkSize(contentWidth - paneWidth, deckHeight, artworkRoom) : artSize;
  const artworkPage = docked || page === 'player';
  const { heart, toggle: toggleLiked } = useCurrentTrackHeart();
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
    queueShown.set(withTiming(!docked && page === 'queue' ? 1 : 0, modeMotion));
  }, [artworkPage, detail, docked, page, queueShown]);

  useEffect(() => {
    paneProgress.set(docked ? withTiming(paneOpen ? 1 : 0, modeMotion) : 0);
  }, [docked, paneOpen, paneProgress]);

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
    else actions.previousTrack();
  };
  const skipSwipe = usePanGesture({
    activeOffsetX: [-14, 14],
    failOffsetY: [-12, 12],
    onUpdate: (event) => {
      if (motion.expanding.value) trackDrag.value = Math.max(-48, Math.min(48, event.translationX * 0.32));
    },
    onDeactivate: (event) => {
      if (motion.expanding.value && !event.canceled && skipCommits(event.translationX, event.velocityX)) {
        scheduleOnRN(skipTrack, event.translationX);
      }
      trackDrag.value = withSpring(0, { damping: 25, stiffness: 280 });
    },
  });
  const artworkGesture = useCompetingGestures(artworkDismiss, skipSwipe);
  const closePane = () => {
    selectionFeedback();
    setPage('player');
  };
  const paneDismiss = usePanGesture({
    enabled: paneOpen,
    activeOffsetX: 14,
    failOffsetX: -14,
    failOffsetY: [-12, 12],
    onActivate: event => { paneDragStart.value = event.translationX; },
    onUpdate: event => {
      paneProgress.value = Math.max(0, Math.min(1, 1 - (event.translationX - paneDragStart.value) / paneWidth));
    },
    onDeactivate: event => {
      if (!event.canceled && (paneProgress.value < 0.66 || event.velocityX > 650)) {
        scheduleOnRN(closePane);
      } else {
        paneProgress.value = withTiming(1, modeMotion);
      }
    },
  });

  const deckWidthStyle = useAnimatedStyle(() => ({ width: contentWidth - paneWidth * paneProgress.value }));
  const paneStyle = useAnimatedStyle(() => ({ transform: [{ translateX: paneWidth * (1 - paneProgress.value) }] }));
  const artworkSlotStyle = useAnimatedStyle(() => ({ height: artSize + (artSizeBesidePane - artSize) * paneProgress.value }));

  // On the iOS queue the song playing scrolls with the page, which draws its artwork and lines
  // once the player has carried them there (`onQueue`); taking them back, the player's start
  // from where the page has them (`queueShift`), no further than just off its edges. Each
  // style reads the shared values itself and passes them in, so it runs again when they change.
  const onQueue = (d: number, shown: number, follow: number) => {
    'worklet';
    return queueShowsNowPlaying && d >= 1 && shown >= 1 && follow >= 1;
  };
  const queueShift = (shown: number, shift: number) => {
    'worklet';
    if (!queueShowsNowPlaying) return 0;
    const reach = compactArtworkTop + compactArtworkSize;
    return Math.max(-reach, Math.min(Math.max(0, availableHeight - reach), shift)) * shown;
  };

  // `pane` is the side pane's progress, passed in so each style that places the artwork reads it itself:
  // a style reruns only for the shared values its own closure reads.
  const placedArtwork = (d: number, drag: number, shift = 0, pane = 0): ArtworkFrame => {
    'worklet';
    const fraction = docked ? pane : 0;
    const size = artSize + (artSizeBesidePane - artSize) * fraction;
    const artX = (contentWidth - paneWidth * fraction - size) / 2;
    const artY = tablet ? Math.max(0, (deckHeight - size - artworkRoom) / 2) : 0;
    return {
      x: insets.left + artX + (artworkInset - artX) * d + drag * (1 - d),
      y: top + headerHeight + artY + (compactArtworkTop - artY) * d + shift,
      size: size + (compactArtworkSize - size) * d,
      radius: artworkRadius + (compactArtworkRadius - artworkRadius) * d,
    };
  };

  const panelStyle = useAnimatedStyle(() => {
    const bubble = motion.bubble.value;
    const { lead, follow } = progress(motion);
    if (!bubble) return { left: 0, top: 0, width, height, borderRadius: 0, opacity: lead };
    const { left, right } = sideInsets(bubble, follow, width);
    const art = artworkInFlight(bubble, follow, placedArtwork(detail.value, trackDrag.value, queueShift(queueShown.value, nowPlayingShift.value), paneProgress.value));
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
  // decoded once, at full size, and nothing is laid out while it flies. It is drawn from the decoded
  // cover itself: a copy resized to the view (`allowDownscaling`) is made on the main thread, which
  // a skip would wait on mid-swipe.
  const artworkFrame = (bubble: Bubble | null, follow: number, d: number, drag: number, shift = 0, pane = 0): ArtworkFrame => {
    'worklet';
    const placed = placedArtwork(d, drag, shift, pane);
    if (!bubble) return placed;
    const art = artworkInFlight(bubble, follow, placed);
    return { ...art, x: art.x - sideInsets(bubble, follow, width).left };
  };
  const artworkStyle = useAnimatedStyle(() => {
    const bubble = motion.bubble.value;
    const follow = progress(motion).follow;
    const frame = artworkFrame(bubble, follow, detail.value, trackDrag.value, queueShift(queueShown.value, nowPlayingShift.value), paneProgress.value);
    const hidden = onQueue(detail.value, queueShown.value, bubble ? follow : 1) ? 0 : 1;
    return { ...artworkTransform(frame, artSize), opacity: hidden };
  });
  const artworkDetailsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(detail.value, [0, 0.44], [1, 0], clamp),
    transform: [{ translateX: trackDrag.value }],
  }));
  const compactDetailsStyle = useAnimatedStyle(() => ({
    opacity: interpolate(detail.value, [0.38, 0.92], [0, 1], clamp) *
      (motion.bubble.value ? interpolate(progress(motion).lead, [0.72, 0.95], [0, 1], clamp) : 1),
  }));
  const compactNowPlayingStyle = useAnimatedStyle(() => ({
    opacity: onQueue(detail.value, queueShown.value, motion.bubble.value ? progress(motion).follow : 1) ? 0 : 1,
    transform: [{ translateY: queueShift(queueShown.value, nowPlayingShift.value) }],
  }));
  const queueArtworkStyle = useAnimatedStyle(() => ({
    opacity: onQueue(detail.value, queueShown.value, motion.bubble.value ? progress(motion).follow : 1) ? 1 : 0,
  }));
  const controlsHidden = !docked && page === 'lyrics' && lyricsHideControls;
  const lyricsStyle = useAnimatedStyle(() => ({
    opacity: withTiming(page === 'lyrics' ? 1 : 0, panelMotion),
    bottom: withTiming(controlsHidden ? -(transportHeight + bottom) : 0, chromeMotion),
  }));
  const transportStyle = useAnimatedStyle(() => ({
    opacity: withTiming(controlsHidden ? 0 : 1, chromeMotion),
    transform: [{ translateY: withTiming(controlsHidden ? 18 : 0, chromeMotion) }],
  }));
  // On iPad the artwork, the title and the transport stay together, centred as one block: the transport
  // rises by half the room the artwork leaves, as the artwork and title sit that far down from the top.
  const transportLiftStyle = useAnimatedStyle(() => {
    const size = artSize + (artSizeBesidePane - artSize) * (docked ? paneProgress.value : 0);
    return { transform: [{ translateY: tablet ? -Math.max(0, deckHeight - size - artworkRoom) / 2 : 0 }] };
  });
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
        selected={heart.selected}
        onPress={toggleLiked}
        color={heartColor(heart, colors, colors.text)}
      />}
      {track && <TrackMenuButton track={track} onPress={() => openTrackMenu(track.id, track.album?.id)} />}
    </>
  );
  const queuePanel = seenQueue && <Animated.View pointerEvents={page === 'queue' ? 'auto' : 'none'}
    accessibilityElementsHidden={page !== 'queue'}
    importantForAccessibility={page === 'queue' ? 'auto' : 'no-hide-descendants'}
    style={[StyleSheet.absoluteFill, queueStyle]}>
    <QueuePage onTrackMenu={openTrackMenu} selected={page === 'queue'} nowPlayingShift={docked ? undefined : nowPlayingShift}
      nowPlaying={!docked && queueShowsNowPlaying && <View style={styles.queueNowPlaying}>
        <Animated.View style={[styles.queueArtwork, queueArtworkStyle]}>
          {artworkImage
            ? <Image source={artworkImage.source} placeholder={artworkImage.placeholder} placeholderContentFit="cover"
              contentFit="cover" style={StyleSheet.absoluteFill} />
            : <View style={styles.noArtwork}><Icon name="music.note" size={22} color={colors.quiet} /></View>}
        </Animated.View>
        <View style={[styles.metadata, styles.queueMetadata]}>{trackDetails(true)}</View>
      </View>} />
  </Animated.View>;
  const lyricsPanel = seenLyrics && <Animated.View pointerEvents={page === 'lyrics' ? 'auto' : 'none'}
    accessibilityElementsHidden={page !== 'lyrics'}
    importantForAccessibility={page === 'lyrics' ? 'auto' : 'no-hide-descendants'}
    style={[StyleSheet.absoluteFill, lyricsStyle]}>
    <LyricsPage key={current?.id ?? 'none'} ref={lyricsPage} selected={page === 'lyrics'} keepControls={docked}
      onControlsHidden={setLyricsHideControls} />
  </Animated.View>;

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
                {/* As on the pages under the player: only downloaded and cached songs play. */}
                <OfflineBadge style={styles.offline} />
                <SleepTimerBadge style={styles.sleepTimer} />
              </Animated.View>
            </GestureDetector>
            <View style={styles.playerStage}>
              <Animated.View style={[styles.deckFrame, docked && deckWidthStyle]}>
                <View style={styles.deckFrame} onLayout={(event) => setAvailableHeight(event.nativeEvent.layout.height)}>
                  <GestureDetector gesture={artworkGesture} touchAction="none">
                    <View collapsable={false} style={[styles.nowPlaying, tablet && styles.tabletNowPlaying, { gap: rhythm.artworkGap }]}
                      pointerEvents={artworkPage ? 'auto' : 'none'} accessibilityElementsHidden={!artworkPage}
                      importantForAccessibility={artworkPage ? 'auto' : 'no-hide-descendants'}>
                      <Animated.View style={artworkSlotStyle} />
                      <Animated.View style={[styles.metadataSlot, tablet ? { maxWidth: Math.max(360, artSize) } : { height: metadataHeight }, artworkDetailsStyle]}>
                        <View style={[styles.metadata, tablet && styles.tabletMetadata]}
                          onLayout={tablet ? event => setTabletMetadataHeight(event.nativeEvent.layout.height) : undefined}>
                          {trackDetails(false)}
                        </View>
                      </Animated.View>
                    </View>
                  </GestureDetector>
                  {!docked && (seenLyrics || seenQueue) && <Animated.View style={[styles.details, compactDetailsStyle]} pointerEvents={artworkPage ? 'none' : 'auto'}
                    accessibilityElementsHidden={artworkPage} importantForAccessibility={artworkPage ? 'no-hide-descendants' : 'auto'}>
                    <Animated.View style={[styles.metadata, styles.compactMetadata, compactNowPlayingStyle]}>{trackDetails(true)}</Animated.View>
                    <View style={styles.detailPanel}>
                      {lyricsPanel}
                      {!queueShowsNowPlaying && queuePanel}
                    </View>
                    {/* Over the song playing too, which scrolls with it. */}
                    {queueShowsNowPlaying && queuePanel}
                  </Animated.View>}
                </View>
                <Animated.View style={transportLiftStyle}>
                  <GestureDetector gesture={transportDismiss}>
                    {/* Lyrics left to play hide the transport; a touch on it keeps it up. */}
                    <Animated.View style={transportStyle} pointerEvents={controlsHidden ? 'none' : 'auto'}
                      accessibilityElementsHidden={controlsHidden} importantForAccessibility={controlsHidden ? 'no-hide-descendants' : 'auto'}
                      onLayout={(event) => setTransportHeight(event.nativeEvent.layout.height)}
                      onTouchStart={() => lyricsPage.current?.touchControls()}>
                      <Transport key={current?.id ?? 'none'} compact={smallScreen || tablet}
                        tabletWidth={tabletTransport ? Math.max(408, artSize + 48) : undefined}
                        rhythm={rhythm} page={page} onToggle={togglePage}
                        onDevices={() => router.push('/devices')} />
                    </Animated.View>
                  </GestureDetector>
                </Animated.View>
              </Animated.View>
              {docked && (seenLyrics || seenQueue) && <GestureDetector gesture={paneDismiss}>
                <Animated.View style={[styles.tabletPane, { width: paneWidth - 12 }, paneStyle]}
                  pointerEvents={paneOpen ? 'auto' : 'none'} accessibilityElementsHidden={!paneOpen}
                  importantForAccessibility={paneOpen ? 'auto' : 'no-hide-descendants'}>
                  <View style={styles.detailPanel}>{lyricsPanel}{queuePanel}</View>
                </Animated.View>
              </GestureDetector>}
            </View>
          </Animated.View>
        </Animated.View>
        {variants.map(variant => (
          <BubbleContent key={`${variant.native}-${variant.compact}`} variant={variant} width={width} />
        ))}
        <Animated.View pointerEvents="none" style={[styles.artwork, { width: artSize, height: artSize }, artworkStyle]}>
          {artworkImage
            ? <Image source={artworkImage.source} placeholder={artworkImage.placeholder} placeholderContentFit="cover"
              contentFit="cover" cachePolicy="memory-disk" allowDownscaling={false} transition={160} style={StyleSheet.absoluteFill} />
            : <NoArtwork base={artSize} frame={artworkFrame} motion={motion} detail={detail} trackDrag={trackDrag} pane={paneProgress} />}
        </Animated.View>
      </Animated.View>
    </Overlay>
  );
}

/** The note shown without artwork, kept at its size as the frame around it grows. */
function NoArtwork({ base, frame, motion, detail, trackDrag, pane }: {
  base: number;
  frame: (bubble: Bubble | null, follow: number, d: number, drag: number, shift: number, pane: number) => ArtworkFrame;
  motion: Motion;
  detail: SharedValue<number>;
  trackDrag: SharedValue<number>;
  pane: SharedValue<number>;
}) {
  const colors = useColors();
  const styles = useStyles();
  const style = useAnimatedStyle(() => ({
    transform: [{ scale: base / frame(motion.bubble.value, progress(motion).follow, detail.value, trackDrag.value, 0, pane.value).size }],
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

function Transport({ compact, tabletWidth, rhythm, page, onToggle, onDevices }: {
  compact: boolean;
  tabletWidth?: number;
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
    <View style={[styles.transport, compact && styles.transportCompact, tabletWidth ? [styles.tabletTransport, { maxWidth: tabletWidth }] : undefined]}>
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
      {/* Choose the sound output in the device sheet. */}
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
            filled={page === 'lyrics'}
            size={22}
            color={colors.muted}
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
            filled={page === 'queue'}
            size={22}
            color={colors.muted}
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
  offline: { position: 'absolute', top: 2, left: artworkInset },
  sleepTimer: { position: 'absolute', top: 2, right: artworkInset },
  playerStage: { flex: 1 },
  deckFrame: { flex: 1 },
  // The artwork at the top, the title's room under it; a tall screen's spare height goes below them.
  nowPlaying: { flex: 1, justifyContent: 'flex-start', alignItems: 'center', paddingHorizontal: edgeInset },
  tabletNowPlaying: { justifyContent: 'center', paddingHorizontal: artworkInset },
  tabletPane: { position: 'absolute', right: 12, top: 0, bottom: 12, overflow: 'hidden' },
  artwork: { position: 'absolute', top: 0, left: 0, overflow: 'hidden', backgroundColor: colors.surface },
  noArtwork: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  details: { ...StyleSheet.absoluteFill, paddingTop: compactArtworkTop },
  detailPanel: { flex: 1 },
  compactMetadata: { alignSelf: 'stretch', width: 'auto', maxWidth: undefined, minHeight: compactArtworkSize,
    marginLeft: artworkInset + compactArtworkSize + 12, marginRight: artworkInset, marginBottom: 9 },
  queueNowPlaying: { flexDirection: 'row', paddingTop: compactArtworkTop, paddingHorizontal: artworkInset, paddingBottom: 9 },
  queueArtwork: { width: compactArtworkSize, height: compactArtworkSize, borderRadius: compactArtworkRadius,
    overflow: 'hidden', backgroundColor: colors.surface },
  queueMetadata: { flex: 1, width: 'auto', maxWidth: undefined, minHeight: compactArtworkSize, marginLeft: 12 },
  compactTrackTitle: { color: colors.text, fontWeight: '700', fontSize: 18 },
  compactTrackArtist: { color: colors.muted, marginTop: 2, fontSize: 14 },
  metadataSlot: { width: '100%', maxWidth: 440, justifyContent: 'center' },
  metadata: { width: '100%', maxWidth: 440, flexDirection: 'row', alignItems: 'center', gap: 5 },
  tabletMetadata: { maxWidth: undefined },
  trackCopy: { minWidth: 0, flex: 1 },
  trackTitle: { fontSize: 30, fontWeight: '700', letterSpacing: -1, color: colors.text },
  compactTitle: { fontSize: 25 },
  artist: { marginTop: 3, color: colors.muted, fontWeight: '500', fontSize: 16 },
  status: { color: colors.accent, fontWeight: '600' },
  statusDetail: { color: colors.muted, fontWeight: '500' },
  transport: { width: '100%', maxWidth: 500, alignSelf: 'center', paddingHorizontal: edgeInset, paddingTop: 8, paddingBottom: 6 },
  transportCompact: { paddingTop: 2, paddingBottom: 2 },
  tabletTransport: { paddingHorizontal: artworkInset },
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
