import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import {
  StyleSheet, Text, View, type AccessibilityActionEvent, type AccessibilityActionInfo, type LayoutChangeEvent, type StyleProp, type TextStyle,
} from 'react-native';
import { usePanGesture, type PanGesture } from 'react-native-gesture-handler';
import Animated, {
  cancelAnimation, Easing, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming, type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';
import type { QueueEntry, SessionQueue, SessionState } from '@squirmy/contracts';
import { useTrack } from '../data/library';
import { usePlaybackActions } from '../playback';
import { selectionFeedback } from './design';
import { landedPage, nextEntry, previousEntry, skipCommits, skipDirection, swipeOffset, type PendingSkip } from './skipSwipe';
import type { Motion } from './transition';

// Barely overshoots, so a title springing back never shows its neighbour's edge.
const springBack = { damping: 30, stiffness: 320 };
const fadeOutMs = 90;
const fadeInMs = 160;
/** How long a skip may take to show in the session before the titles go back to the song that plays. */
const confirmMs = 600;

type Shown = { id: string | null; page: number };

/**
 * A swipe sideways on the mini-player that changes the song. It owns the strip of titles the
 * bubble draws (`SwipeTitles`): the strip follows the finger on the UI thread, and past the
 * threshold (`skipCommits`) it finishes the slide, then plays the song it slid to.
 */
export type SkipSwipe = {
  gesture: PanGesture;
  /** The strip's offset in points: minus its page times its width, plus the finger. */
  scroll: SharedValue<number>;
  /** The page the UI thread has the strip on, or on its way to. */
  page: SharedValue<number>;
  width: SharedValue<number>;
  /** The strip's opacity, which cross-fades a skip in place of the slide with Reduce Motion. */
  fade: SharedValue<number>;
  canNext: SharedValue<boolean>;
  canPrevious: SharedValue<boolean>;
  /** The song and page the strip last rendered. */
  shown: RefObject<Shown>;
  pending: RefObject<PendingSkip | null>;
  /** Changes the song as a finished swipe does, without the slide: VoiceOver's actions. */
  skip: (direction: 1 | -1) => void;
};

/**
 * `motion` keeps the swipe off while Now Playing covers the bubble. `onActivate` runs on the
 * JS thread when the swipe takes the touch, so a tap that turned into a swipe opens nothing.
 */
export function useSkipSwipe(motion: Motion, onActivate: () => void): SkipSwipe {
  const actions = usePlaybackActions();
  const reduceMotion = useReducedMotion();
  const scroll = useSharedValue(0);
  const page = useSharedValue(0);
  const width = useSharedValue(0);
  const fade = useSharedValue(1);
  const canNext = useSharedValue(false);
  const canPrevious = useSharedValue(false);
  const dragging = useSharedValue(false);
  const shown = useRef<Shown>({ id: null, page: 0 });
  const pending = useRef<PendingSkip | null>(null);

  const play = (direction: 1 | -1) => {
    if (direction > 0) actions.next();
    else actions.previousTrack();
  };
  // The strip has slid to the next page: play that song. If the session does not move to it
  // (nothing was there after all), put the strip back on the song that plays.
  const land = (direction: 1 | -1) => {
    const skip: PendingSkip = { from: shown.current.id ?? '', direction };
    pending.current = skip;
    play(direction);
    setTimeout(() => {
      if (pending.current !== skip) return;
      pending.current = null;
      const back = shown.current.page;
      scheduleOnUI(() => {
        'worklet';
        if (dragging.value || page.value === back) return;
        page.value = back;
        scroll.value = withSpring(-back * width.value, springBack);
      });
    }, confirmMs);
  };
  const landRef = useRef(land);
  landRef.current = land;
  const landNow = (direction: 1 | -1) => landRef.current(direction);
  const activateRef = useRef(onActivate);
  activateRef.current = onActivate;
  const activated = () => activateRef.current();

  const gesture = usePanGesture({
    activeOffsetX: [-12, 12],
    failOffsetY: [-10, 10],
    maxPointers: 1,
    onActivate: () => {
      'worklet';
      if (motion.active.value || width.value <= 0) return;
      // A skip still sliding into place plays its song now (its animation's callback) and the
      // new swipe carries on from where the strip is.
      cancelAnimation(scroll);
      dragging.value = true;
      scheduleOnRN(activated);
    },
    onUpdate: (event) => {
      'worklet';
      if (!dragging.value || reduceMotion) return;
      scroll.value = -page.value * width.value + swipeOffset(event.translationX, width.value, canNext.value, canPrevious.value);
    },
    onDeactivate: (event) => {
      'worklet';
      if (!dragging.value) return;
      dragging.value = false;
      const span = width.value;
      const direction = skipDirection(event.translationX);
      const open = direction > 0 ? canNext.value : canPrevious.value;
      if (event.canceled || !open || !skipCommits(event.translationX, event.velocityX)) {
        scroll.value = withSpring(-page.value * span, springBack);
        return;
      }
      page.value += direction;
      const target = -page.value * span;
      scheduleOnRN(selectionFeedback);
      if (reduceMotion) {
        fade.value = withTiming(0, { duration: fadeOutMs }, () => {
          'worklet';
          scroll.value = target;
          fade.value = withTiming(1, { duration: fadeInMs });
          scheduleOnRN(landNow, direction);
        });
        return;
      }
      // Finish at the finger's pace, quickly either way.
      const remaining = Math.abs(target - scroll.value);
      const speed = Math.max(Math.abs(event.velocityX), 900);
      const duration = Math.min(260, Math.max(140, (remaining / speed) * 1500));
      scroll.value = withTiming(target, { duration, easing: Easing.out(Easing.cubic) }, () => {
        'worklet';
        scheduleOnRN(landNow, direction);
      });
    },
  });

  return { gesture, scroll, page, width, fade, canNext, canPrevious, shown, pending, skip: play };
}

export type TitleLine = { key: string; title: string; subtitle: string };

/**
 * VoiceOver's way to do what the swipe does: the bubble's actions rotor offers Next track and
 * Previous track while there is a song that way. Activating the bubble still opens Now Playing.
 */
export function skipActions(swipe: SkipSwipe | undefined, open: (() => void) | undefined, hasPrevious: boolean, hasNext: boolean) {
  const accessibilityActions: AccessibilityActionInfo[] = [
    { name: 'activate' },
    ...(swipe && hasNext ? [{ name: 'next', label: 'Next track' }] : []),
    ...(swipe && hasPrevious ? [{ name: 'previous', label: 'Previous track' }] : []),
  ];
  const onAccessibilityAction = ({ nativeEvent }: AccessibilityActionEvent) => {
    if (nativeEvent.actionName === 'activate') open?.();
    else if (nativeEvent.actionName === 'next') swipe?.skip(1);
    else if (nativeEvent.actionName === 'previous') swipe?.skip(-1);
  };
  return { accessibilityActions, onAccessibilityAction };
}

function useLine(entry: QueueEntry | null): TitleLine | null {
  const track = useTrack(entry?.trackId, entry?.albumId);
  if (!entry) return null;
  return { key: entry.id, title: track?.title ?? '', subtitle: track?.artistCredit ?? '' };
}

/**
 * The songs a swipe would go to, as the session would play them (shuffle, repeat and
 * Autoplay included), on whichever device plays: null where there is none.
 */
export function useSkipNeighbours(session: SessionState, queue: SessionQueue): { previous: TitleLine | null; next: TitleLine | null } {
  const entries = { ...session, ...queue };
  return { previous: useLine(previousEntry(entries)), next: useLine(nextEntry(entries)) };
}

/**
 * The bubble's title and subtitle, between the cover and the buttons, with the songs before
 * and after on the pages either side, clipped out of sight until a swipe brings one in. A
 * subtitle the neighbours share (the same artist, or a playback status, which is about the
 * session rather than the song) stays where it is while the titles slide.
 */
export function SwipeTitles({
  swipe, current, previous, next, twoLines, statusShown, titleStyle, subtitleStyle, maxFontSizeMultiplier,
}: {
  swipe?: SkipSwipe;
  current: TitleLine;
  previous: TitleLine | null;
  next: TitleLine | null;
  twoLines: boolean;
  /** The subtitle is a playback status rather than the song's artist. */
  statusShown: boolean;
  titleStyle: StyleProp<TextStyle>;
  subtitleStyle: StyleProp<TextStyle>;
  maxFontSizeMultiplier?: number;
}) {
  const [width, setWidth] = useState(0);
  const [shown, setShown] = useState<Shown>(() => ({ id: current.key, page: swipe?.shown.current.page ?? 0 }));
  const page = landedPage(shown, current.key, swipe?.pending.current ?? null);
  if (shown.id !== current.key) setShown({ id: current.key, page });

  useLayoutEffect(() => {
    if (!swipe) return;
    swipe.shown.current = { id: current.key, page };
    if (swipe.pending.current && swipe.pending.current.from !== current.key) swipe.pending.current = null;
  }, [current.key, page, swipe]);

  const hasNext = next !== null;
  const hasPrevious = previous !== null;
  useLayoutEffect(() => {
    if (!swipe) return;
    swipe.canNext.value = hasNext;
    swipe.canPrevious.value = hasPrevious;
  }, [hasNext, hasPrevious, swipe]);

  useLayoutEffect(() => {
    if (!swipe || width <= 0) return;
    const { scroll: offset, page: onPage, width: span } = swipe;
    scheduleOnUI(() => {
      'worklet';
      span.value = width;
      offset.value = -onPage.value * width;
    });
  }, [swipe, width]);

  // Only the shared values go to the UI thread: a worklet that captured `swipe` would freeze its refs.
  const scroll = swipe?.scroll;
  const fade = swipe?.fade;
  const slide = useAnimatedStyle(() => scroll && fade ? {
    opacity: fade.value,
    transform: [{ translateX: scroll.value }],
  } : {});

  const neighbours = width > 0 && swipe ? [{ slot: -1, line: previous }, { slot: 1, line: next }] : [];
  const pages = [{ slot: 0, line: current }, ...neighbours].filter((item): item is { slot: number; line: TitleLine } => item.line !== null);
  const fixedSubtitle = twoLines && (statusShown || pages.every(item => item.line.subtitle === current.subtitle));
  const hidden = styles.hidden;
  const lines = (line: TitleLine, subtitleShown: boolean, titleShown = true) => <>
    <Text numberOfLines={1} maxFontSizeMultiplier={maxFontSizeMultiplier} style={[titleStyle, !titleShown && hidden]}>{line.title || ' '}</Text>
    {twoLines && <Text numberOfLines={1} maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={[subtitleStyle, !subtitleShown && hidden]}>{line.subtitle || ' '}</Text>}
  </>;

  const onLayout = (event: LayoutChangeEvent) => setWidth(Math.round(event.nativeEvent.layout.width));

  return <View style={styles.clip} onLayout={onLayout} pointerEvents="none"
    accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
    {/* Sizes the strip, and holds a subtitle that stays put. */}
    <View style={styles.lines}>{lines(current, fixedSubtitle, false)}</View>
    <Animated.View style={[StyleSheet.absoluteFill, slide]}>
      {pages.map(({ slot, line }) => (
        <View key={page + slot} style={[styles.page, width > 0 ? { left: (page + slot) * width, width } : styles.fill]}>
          {lines(line, !fixedSubtitle)}
        </View>
      ))}
    </Animated.View>
  </View>;
}

const styles = StyleSheet.create({
  clip: { flex: 1, overflow: 'hidden', justifyContent: 'center' },
  lines: { gap: 1 },
  page: { position: 'absolute', top: 0, bottom: 0, justifyContent: 'center', gap: 1 },
  fill: { left: 0, right: 0 },
  hidden: { opacity: 0 },
});
