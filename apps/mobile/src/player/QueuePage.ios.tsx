import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button, Host, HStack, List, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityLabel, background, dynamicTypeSize, environment, font, foregroundStyle, frame,
  lineLimit, listRowBackground, listRowInsets, listRowSeparator, listStyle, onGeometryChange, opacity, padding, scrollContentBackground,
  scrollDisabled, shapes,
} from '@expo/ui/swift-ui/modifiers';
import { Alert, StyleSheet, useWindowDimensions, View, type LayoutRectangle } from 'react-native';
import Animated, {
  useAnimatedReaction, useAnimatedRef, useAnimatedScrollHandler, useAnimatedStyle, useDerivedValue, useReducedMotion, useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { contextLabel } from '@squirmy/client-core';
import type { TrackSummary } from '@squirmy/contracts';
import { useSharingEnabled, useWantlistEnabled } from '../account/AccountProvider';
import { useRealtime } from '../data/realtime';
import { useCanPlay, useTrackDownload, useViewer } from '../downloads/DownloadsProvider';
import { useLiked, useLikeFailure, useTrack, useWanted, useWantFailure } from '../data/library';
import { trackActions, useDownloadedOnItsOwn, useTrackActionRunner, type TrackAction } from '../library/trackActions';
import { Symbol, TrackActionsMenu, TrackCover, hitShape, plainButton } from '../native/Controls';
import { useAddedBy, useCurrentTrackState, usePlaybackActions, usePlaybackState, type QueueEntry } from '../playback';
import type { QueueProps } from './QueuePage';
import { selectionFeedback } from './design';
import { clipInset, pushedOpacity, restingStop, rowWindow, snapStops, stickyShift, type Band, type RowWindow } from './queueScroll';
import { pendingQueueRow, queuedEntryActions, queuedEntryCommand, queueRow, upNextDetail, upNextTitle, type QueuePosition } from './session';
import { isAccessibilitySize } from '../fontScale';
import { unavailableOpacity, useColors } from '../theme';

/** The page lays out the song playing itself, which the player hands it, so it scrolls with the queue. */
export const queueShowsNowPlaying = true;

/** A row's height at the default text size, as dense as Apple Music's. Rows grow with their text; see `useRowHeights`. */
const rowHeight = 56;
const coverSize = 48;
const listModifiers = [listStyle('plain'), scrollContentBackground('hidden'), scrollDisabled()];
/** Headings and their quieter lines stop growing here, so they stay a line or two beside the lists. */
const headingTextLimit = dynamicTypeSize({ max: 'xxxLarge' });
const headingHeight = 44;
/** Up next shows this many entries at first, and this many more each time more are asked for. */
const upNextPage = 100;
/**
 * Only the rows near the part of the page in view are laid out (`rowWindow`): every row is a
 * SwiftUI row with a React Native cover, and every Fabric commit, one per frame of any animation,
 * walks each mounted view of a scroll view. The window takes in half a screen above and below the
 * view, more than the page scrolls between two moves of the window, which moves on whole chunks of
 * rows at most once every `windowStep` points scrolled.
 */
const windowStep = 240;
const windowChunk = 8;
const rowModifiers = [
  listRowInsets({ top: 0, bottom: 0, leading: 0, trailing: 0 }),
  listRowBackground('clear'),
  listRowSeparator('hidden'),
];
/**
 * Up next and the suggestions are always in edit mode, so each row shows the system's reorder
 * handle, as Apple Music's queue does, and a drag starts from it at once; a press and hold
 * anywhere else on the row picks it up too. A tap still plays the row and its menu button still
 * opens. Edit mode takes the swipes and a press and hold's menu, which is why the row keeps a
 * menu button: everything a swipe did is in it.
 */
const reordering = environment({ key: 'editMode', value: 'active' });

/**
 * The lists sit inside the page's scroll view, so each is exactly as tall as its rows, and rows
 * grow with the text: each reports its height once laid out, and the list is sized to their sum.
 * Until a row has reported it is counted generously, so a row is never cut off by the list's
 * bottom edge.
 */
function useRowHeights() {
  const { fontScale } = useWindowDimensions();
  // The list holds rows to at least the system's minimum row height, which grows with the text;
  // rows hold themselves to more than that, so a row is never taller than what it reports.
  const floor = Math.max(rowHeight, Math.ceil(44 * fontScale));
  // Two lines each of title and artist at accessibility sizes, one each below them.
  const estimate = Math.max(floor, Math.ceil((isAccessibilitySize(fontScale) ? 90 : 46) * fontScale));
  const [heights, setHeights] = useState<Readonly<Record<string, number>>>({});
  const measure = useCallback((id: string, height: number) => {
    setHeights(current => Math.abs((current[id] ?? -1) - height) < 0.5 ? current : { ...current, [id]: height });
  }, []);
  const heightsOf = (entries: readonly QueueEntry[]) => entries.map(entry => heights[entry.id] ?? estimate);
  const total = (entries: readonly QueueEntry[]) => Math.ceil(heightsOf(entries).reduce((sum, height) => sum + height, 0));
  return { floor, measure, total, heightsOf };
}

type RowHeights = ReturnType<typeof useRowHeights>;
/** The lists whose rows are laid out only near the view. */
type ListKey = 'historyRows' | 'upNextRows' | 'autoplayRows';

const headingFont = font({ textStyle: 'headline', weight: 'semibold' });
const detailFont = font({ textStyle: 'footnote' });

/** The parts of the page whose places the scrolling follows. */
type BandKey = 'historyHeading' | 'historyRows' | 'now' | 'toggles' | 'upNextHeading' | 'upNextRows' | 'autoplayHeading' | 'autoplayRows';
type Bands = Partial<Record<BandKey, Band>>;
/** A sticky heading: pinned to the top, or just below `below`, until its part ends where `until` starts. */
type Pin = { key: BandKey; below?: BandKey; until?: BandKey; fades?: boolean };

const pins = {
  history: { key: 'historyHeading', until: 'now' },
  toggles: { key: 'toggles' },
  upNext: { key: 'upNextHeading', below: 'toggles', until: 'autoplayHeading', fades: true },
  autoplay: { key: 'autoplayHeading', below: 'toggles' },
} satisfies Record<string, Pin>;

function pinnedShift(bands: Bands, scrollY: number, pin: Pin) {
  'worklet';
  const band = bands[pin.key];
  if (!band) return 0;
  const pinAt = pin.below ? bands[pin.below]?.height ?? 0 : 0;
  const limit = pin.until ? bands[pin.until]?.y ?? Infinity : Infinity;
  return stickyShift(scrollY, band, pinAt, limit);
}

type Scrolling = { bands: SharedValue<Bands>; scrollY: SharedValue<number>; onBand: (key: BandKey, layout: LayoutRectangle) => void };

/**
 * Laid out and scrolled as Apple Music's queue. It rests on the song playing, with Shuffle,
 * Repeat and Autoplay below it as one row of toggles, then Up next ("Continue Playing") and the
 * Autoplay suggestions as headed lists whose rows carry reorder handles. The history is above,
 * out of view: scrolled into and let go of partway, the page settles back on the song playing
 * or a full screen into the history. The heading of the part in view sticks to the top, under
 * the toggles once the song playing has scrolled away, so the page always says where it is.
 * A row is the song and one menu button, which holds what its heart did, alongside the rest of
 * its actions.
 */
export default function QueuePage({ selected = true, nowPlaying, nowPlayingShift }: QueueProps) {
  const colors = useColors();
  const { session, queue, actions } = usePlaybackState();
  const { history } = queue;
  const historyRows = useRowHeights();
  const upNextRows = useRowHeights();
  const autoplayRows = useRowHeights();
  const { height: screenHeight } = useWindowDimensions();
  const reduceMotion = useReducedMotion();
  const scroll = useAnimatedRef<Animated.ScrollView>();
  // Until the page is laid out, the song playing is expected below the history at its estimated height.
  const estimatedHome = useRef(history.length ? headingHeight + historyRows.total(history) : 0);
  const [home, setHome] = useState(estimatedHome.current);
  const homeY = useSharedValue(estimatedHome.current);
  const scrollY = useSharedValue(estimatedHome.current);
  const bands = useSharedValue<Bands>({});
  const measured = useRef<Bands>({});
  // Where each list starts in the page, and which stretch of it is in view, for the rows laid out.
  const [listTops, setListTops] = useState<Partial<Record<ListKey, number>>>({});
  const [viewChunk, setViewChunk] = useState(() => Math.floor(estimatedHome.current / windowStep));
  useAnimatedReaction(() => Math.floor(scrollY.value / windowStep), (now, before) => {
    if (before !== null && now !== before) scheduleOnRN(setViewChunk, now);
  });
  const placed = useRef(false);
  const [viewport, setViewport] = useState(0);
  const [upNextShown, setUpNextShown] = useState(upNextPage);
  const historyHandlers = useQueueHandlers(true);
  const upNext = useMemo(() => queue.queue.slice(0, upNextShown), [queue.queue, upNextShown]);
  const hidden = queue.queue.length - upNext.length;
  const context = contextLabel(session.context);
  const stops = snapStops(history.length ? home : 0, viewport);
  // Until a list has been laid out, it is taken to start about where it will.
  const view = viewport || screenHeight;
  const viewTop = viewChunk * windowStep;
  const windowOf = (key: ListKey, heights: number[], expectedTop: number) =>
    rowWindow(heights, listTops[key] ?? expectedTop, viewTop, viewTop + view + windowStep, view / 2, windowChunk);
  const historyWindow = windowOf('historyRows', historyRows.heightsOf(history), headingHeight);
  const upNextWindow = windowOf('upNextRows', upNextRows.heightsOf(upNext), home + 160);
  const autoplayWindow = windowOf('autoplayRows', autoplayRows.heightsOf(queue.autoplayQueue), home + 220 + upNextRows.total(upNext));

  const jump = useCallback((y: number) => {
    scrollY.set(y);
    nowPlayingShift?.set(homeY.get() - y);
    scroll.current?.scrollTo({ y, animated: false });
  }, [homeY, nowPlayingShift, scroll, scrollY]);

  const onBand = useCallback((key: BandKey, { y, height }: LayoutRectangle) => {
    const before = measured.current[key];
    if (before && Math.abs(before.y - y) < 0.5 && Math.abs(before.height - height) < 0.5) return;
    measured.current = { ...measured.current, [key]: { y, height } };
    bands.set(measured.current);
    if (key === 'historyRows' || key === 'upNextRows' || key === 'autoplayRows') {
      setListTops(tops => Math.abs((tops[key] ?? -1) - y) < 0.5 ? tops : { ...tops, [key]: y });
    }
    if (key !== 'now') return;
    // The history grows above what is on screen as songs finish; the view keeps its place. The
    // first time, the page is put on the song playing.
    const shift = y - homeY.get();
    homeY.set(y);
    setHome(y);
    if (!placed.current) {
      placed.current = true;
      jump(y);
    } else if (shift) {
      jump(Math.max(0, scrollY.get() + shift));
    }
  }, [bands, homeY, jump, scrollY]);
  const scrolling = useMemo<Scrolling>(() => ({ bands, scrollY, onBand }), [bands, scrollY, onBand]);

  // Opened again, the page is back on the song playing, as Apple Music's queue is.
  useLayoutEffect(() => {
    if (selected && placed.current) jump(homeY.get());
  }, [selected, homeY, jump]);

  // With Reduce Motion the page does not glide to where it rests: once it stops, it is put there.
  const settle = useCallback((offset: number) => {
    const target = restingStop(offset, stops);
    if (target !== null) jump(target);
  }, [jump, stops]);
  const onScroll = useAnimatedScrollHandler({
    onScroll: event => {
      scrollY.value = event.contentOffset.y;
      if (nowPlayingShift) nowPlayingShift.value = homeY.value - event.contentOffset.y;
    },
    onEndDrag: event => {
      if (reduceMotion && !event.velocity?.y) scheduleOnRN(settle, event.contentOffset.y);
    },
    onMomentumEnd: event => {
      if (reduceMotion) scheduleOnRN(settle, event.contentOffset.y);
    },
  });

  const clearHistory = () => Alert.alert('Clear listening history?', undefined, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Clear history', style: 'destructive', onPress: actions.clearHistory },
  ]);
  const toggle = (run: () => void) => () => { selectionFeedback(); run(); };

  return <View style={styles.page} onLayout={({ nativeEvent }) => setViewport(nativeEvent.layout.height)}>
    <Animated.ScrollView ref={scroll} contentOffset={{ x: 0, y: estimatedHome.current }} contentInsetAdjustmentBehavior="never"
      showsVerticalScrollIndicator={false} scrollEventThrottle={16} onScroll={onScroll}
      snapToOffsets={!reduceMotion && stops.length ? stops : undefined} snapToStart={false} snapToEnd={false}
      contentContainerStyle={{ minHeight: home + viewport, paddingBottom: 8 }}>
      {history.length > 0 && <>
        <Sticky pin={pins.history} scrolling={scrolling}>
          <QueueBand height={headingHeight}>
            <HStack>
              <Text modifiers={[headingFont, accessibilityAddTraits(['isHeader'])]}>History</Text>
              <Spacer />
              <TextButton label="Clear" color={colors.muted} onPress={clearHistory} />
            </HStack>
          </QueueBand>
        </Sticky>
        <Clipped band="historyRows" under={pins.history} scrolling={scrolling}>
          <Windowed height={historyRows.total(history)} window={historyWindow}>
            <List modifiers={listModifiers}>
              {history.slice(historyWindow.start, historyWindow.end).map(entry => <VStack key={entry.id} modifiers={rowModifiers}>
                <QueueTrack entry={entry} handlers={historyHandlers} minHeight={historyRows.floor} onHeight={historyRows.measure} />
              </VStack>)}
            </List>
          </Windowed>
        </Clipped>
      </>}
      <View onLayout={({ nativeEvent }) => onBand('now', nativeEvent.layout)}>{nowPlaying}</View>
      <Sticky pin={pins.toggles} scrolling={scrolling}>
        <QueueBand height={52}>
          <HStack spacing={10} modifiers={[padding({ bottom: 6 })]}>
            <QueueMode symbol="shuffle" label="Shuffle" active={session.shuffle} onPress={toggle(actions.toggleShuffle)} />
            <QueueMode symbol={session.repeat === 'one' ? 'repeat.1' : 'repeat'} label={`Repeat ${session.repeat}`}
              active={session.repeat !== 'off'} onPress={toggle(actions.cycleRepeat)} />
            <QueueMode symbol="infinity" label="Autoplay" active={session.autoplay} onPress={toggle(actions.toggleAutoplay)} />
          </HStack>
        </QueueBand>
      </Sticky>
      <Sticky pin={pins.upNext} scrolling={scrolling}>
        {/* As on the web, the queue clears at once: what was in it is still in the album or list it came from. */}
        <QueueHeading title={upNextTitle(context, queue.queue)} detail={upNextDetail(context, queue.queue) ?? 'Songs you queue appear here.'}
          action={queue.queue.length > 0 && <TextButton label="Clear" spoken="Clear queue" color={colors.muted} onPress={actions.clearQueue} />} />
      </Sticky>
      <Clipped band="upNextRows" under={pins.upNext} scrolling={scrolling}>
        {queue.queue.length > 0 && <QueueRows entries={upNext} total={queue.queue.length} rows={upNextRows} window={upNextWindow} />}
        {hidden > 0 && <QueueBand height={44}>
          <TextButton label={`Show ${Math.min(upNextPage, hidden)} more`} color={colors.accent} onPress={() => setUpNextShown(shown => shown + upNextPage)} />
        </QueueBand>}
      </Clipped>
      <Sticky pin={pins.autoplay} scrolling={scrolling}>
        <QueueHeading title="Autoplay" symbol="infinity" symbolColor={session.autoplay ? colors.text : colors.quiet}
          detail={session.autoplay ? 'Similar music will keep playing' : 'Turn on Autoplay to keep listening'} />
      </Sticky>
      <Clipped band="autoplayRows" under={pins.autoplay} scrolling={scrolling}>
        {session.autoplay && <QueueRows entries={queue.autoplayQueue} autoplay rows={autoplayRows} window={autoplayWindow} />}
      </Clipped>
    </Animated.ScrollView>
  </View>;
}

/**
 * A heading that sticks (see `pins`). It is drawn over the rows it pins above, which `Clipped`
 * cuts at its bottom edge; the toggles are drawn over the heading a later part pushes up.
 */
function Sticky({ pin, scrolling: { bands, scrollY, onBand }, children }: { pin: Pin; scrolling: Scrolling; children: ReactNode }) {
  const style = useAnimatedStyle(() => {
    const all = bands.value;
    const shift = pinnedShift(all, scrollY.value, pin);
    const band = all[pin.key];
    const pinAt = pin.below ? all[pin.below]?.height ?? 0 : 0;
    return {
      transform: [{ translateY: shift }],
      opacity: pin.fades && band ? pushedOpacity(scrollY.value, band, shift, pinAt) : 1,
    };
  });
  return <Animated.View onLayout={({ nativeEvent }) => onBand(pin.key, nativeEvent.layout)}
    style={[pin.key === 'toggles' ? styles.toggles : styles.sticky, style]}>{children}</Animated.View>;
}

/**
 * Rows that go under the heading pinned over them: the top of the block is cut away down to
 * the heading's bottom edge. The frame moves down by what is cut and its contents up by as
 * much, so they keep their place; the frame lets touches through outside its contents.
 */
function Clipped({ band, under, scrolling: { bands, scrollY, onBand }, children }: {
  band: BandKey; under: Pin; scrolling: Scrolling; children: ReactNode;
}) {
  const cut = useDerivedValue(() => {
    const all = bands.value;
    const block = all[band];
    const heading = all[under.key];
    if (!block || !heading) return 0;
    return clipInset(heading.y + pinnedShift(all, scrollY.value, under) + heading.height, block);
  });
  const frameStyle = useAnimatedStyle(() => ({ transform: [{ translateY: cut.value }] }));
  const contentStyle = useAnimatedStyle(() => ({ transform: [{ translateY: -cut.value }] }));
  return <Animated.View pointerEvents="box-none" onLayout={({ nativeEvent }) => onBand(band, nativeEvent.layout)}
    style={[styles.clip, frameStyle]}>
    <Animated.View style={contentStyle}>{children}</Animated.View>
  </Animated.View>;
}

/** A list's rows near the view (`window`), at their place in a frame as tall as all of its rows. */
function Windowed({ height, window, children }: { height: number; window: RowWindow; children: ReactNode }) {
  return <View style={[styles.list, { height }]}>
    {window.end > window.start && <Host ignoreSafeArea="container" style={[styles.window, { top: window.above, bottom: window.below }]}>
      {children}
    </Host>}
  </View>;
}

/** A heading or note between the lists, at least `height` tall and taller when its text needs it. */
function QueueBand({ height, children }: { height: number; children: React.ReactNode }) {
  return <Host alignment="leading" ignoreSafeArea="container" matchContents={{ vertical: true }} style={[styles.band, { minHeight: height }]}
    modifiers={[headingTextLimit, frame({ maxWidth: Infinity, minHeight: height, alignment: 'leading' })]}>{children}</Host>;
}

/** A list's heading, with a quieter line under it, as Apple Music's "Continue Playing / From …" and "Autoplay / Similar music will keep playing". */
function QueueHeading({ title, detail, symbol, symbolColor, action }: {
  title: string; detail?: string | null; symbol?: string; symbolColor?: string;
  /** A button at the trailing end, as History's Clear. */
  action?: ReactNode;
}) {
  const colors = useColors();
  const heading = <VStack alignment="leading" spacing={1} modifiers={[padding({ top: 10, bottom: 8 })]}>
    <HStack spacing={6}>
      {symbol && <Symbol name={symbol} size={16} color={symbolColor} />}
      <Text modifiers={[headingFont, accessibilityAddTraits(['isHeader'])]}>{title}</Text>
    </HStack>
    {detail ? <Text modifiers={[detailFont, foregroundStyle(colors.muted), lineLimit(2)]}>{detail}</Text> : null}
  </VStack>;
  return <QueueBand height={detail ? 62 : headingHeight}>
    {action ? <HStack>{heading}<Spacer />{action}</HStack> : heading}
  </QueueBand>;
}

/** A text button the full 44 pt tall, though its label is one short line. */
function TextButton({ label, spoken = label, color, onPress }: { label: string; spoken?: string; color: string; onPress: () => void }) {
  return <Button onPress={onPress} modifiers={[plainButton, accessibilityLabel(spoken)]}>
    <Text modifiers={[foregroundStyle(color), lineLimit(1), frame({ minWidth: 44, minHeight: 44 }), hitShape]}>{label}</Text>
  </Button>;
}

/** One of the row of toggles: a capsule a third of the width, filled while it is on. 44 pt tall to touch, 36 pt drawn. */
function QueueMode({ symbol, label, active, onPress }: {
  symbol: string; label: string; active: boolean; onPress: () => void;
}) {
  const colors = useColors();
  return <Button onPress={onPress} modifiers={[
    plainButton, accessibilityLabel(label), ...(active ? [accessibilityAddTraits(['isSelected'])] : []),
  ]}>
    <HStack modifiers={[
      frame({ maxWidth: Infinity, minHeight: 36 }), background(active ? colors.accent : colors.chip, shapes.capsule()),
      padding({ vertical: 4 }), hitShape,
    ]}>
      <Symbol name={symbol} size={17} color={active ? colors.onAccent : colors.text} />
    </HStack>
  </Button>;
}

type QueueHandlers = {
  play: (entry: QueueEntry, track: TrackSummary) => void;
  move: (entry: QueueEntry, index: number) => void;
  remove: (entry: QueueEntry, title?: string) => void;
  run: ReturnType<typeof useTrackActionRunner>['run'];
  /** A queued row's menu: an action that places the song moves this entry, rather than queue the song again. */
  runQueued: (entry: QueueEntry, track: TrackSummary, action: TrackAction, position: QueuePosition) => void;
};

/** What queue rows do, in one object that changes only with the session runtime, so rows redraw only for their own entry. */
function useQueueHandlers(history: boolean): QueueHandlers {
  const actions = usePlaybackActions();
  const { run } = useTrackActionRunner();
  return useMemo(() => ({
    play: (entry, track) => history ? actions.playNow(track) : actions.playQueueEntry(entry.id),
    move: (entry, index) => actions.moveInQueue(entry.id, index),
    remove: (entry, title) => actions.removeWithUndo(entry.id, title),
    run,
    runQueued: (entry, track, action, { total, autoplay }) => {
      switch (queuedEntryCommand(action.id)) {
        case 'playEntry': return actions.playQueueEntry(entry.id);
        case 'promote': return actions.promote(entry, track, autoplay);
        case 'moveToEnd':
          if (!autoplay) return actions.moveInQueue(entry.id, total - 1);
          // A suggestion joins the end of the queue and leaves the suggestions, as Play next takes it to the front.
          actions.enqueue([track], 'last');
          return actions.removeFromQueue(entry.id);
        default: return run(track, action);
      }
    },
  }), [actions, history, run]);
}

function QueueRows({ entries, total = entries.length, autoplay = false, rows, window }: {
  entries: readonly QueueEntry[]; total?: number; autoplay?: boolean; rows: RowHeights; window: RowWindow;
}) {
  const actions = usePlaybackActions();
  const handlers = useQueueHandlers(false);
  if (!entries.length) return null;

  // The list holds the window's rows, so its indexes count from the window's first row.
  const onMove = ([moved]: number[], to: number) => {
    const source = moved + window.start;
    const destination = to + window.start;
    const entry = entries[source];
    if (!entry) return;
    const index = destination > source ? destination - 1 : destination;
    if (source !== index) {
      selectionFeedback();
      actions.moveInQueue(entry.id, index);
    }
  };

  return <Windowed height={rows.total(entries)} window={window}>
    <List modifiers={[...listModifiers, reordering]}>
      <List.ForEach data={entries.slice(window.start, window.end)} keyExtractor={entry => entry.id} recycling={false}
        onMove={entries.length > 1 ? onMove : undefined}>
        {({ item, index }) => <VStack modifiers={rowModifiers}>
          <QueueTrack entry={item} handlers={handlers} position={{ index: index + window.start, total, autoplay }}
            minHeight={rows.floor} onHeight={rows.measure} />
        </VStack>}
      </List.ForEach>
    </List>
  </Windowed>;
}

type QueueTrackProps = {
  entry: QueueEntry;
  handlers: QueueHandlers;
  /** Where a queued entry sits, for its Move up and Move down; left out in the history. */
  position?: QueuePosition;
  /** The least height of a row, which it grows from with its text. */
  minHeight: number;
  onHeight: (entryId: string, height: number) => void;
};

/**
 * A queue row: the song and its menu, which holds Save to library with the rest. A tap plays
 * it. History rows have the same menu button rather than a press and hold's, so every row of the
 * page works alike. A failed entry is gray and will be skipped, as is one that is not on the phone
 * while offline.
 */
const QueueTrack = memo(function QueueTrack({ entry, handlers, position, minHeight, onHeight }: QueueTrackProps) {
  const colors = useColors();
  const { fontScale } = useWindowDimensions();
  // At accessibility sizes a title and its artists wrap, and the row grows to hold them.
  const lines = isAccessibilitySize(fontScale) ? [] : [lineLimit(1)];
  const track = useTrack(entry.trackId, entry.albumId);
  const favorite = useLiked('track', track?.id, track?.liked);
  const likeFailure = useLikeFailure('track', track?.id);
  const { offline } = useRealtime();
  const download = useTrackDownload(entry.trackId);
  const onItsOwn = useDownloadedOnItsOwn(track?.id, download);
  const playable = useCanPlay(track);
  const current = useCurrentTrackState(track?.id);
  const wantlist = useWantlistEnabled();
  const sharing = useSharingEnabled();
  const wanted = useWanted(track?.id);
  const wantFailure = useWantFailure(track?.id);
  const viewer = useViewer();
  const row = queueRow(entry, track, { playable, offline, viewer });
  const failed = row.unavailable;
  // Without its summary a row has nothing to show or act on: it says why, and offers no menu.
  const pending = track ? null : pendingQueueRow(offline);
  const title = track?.title ?? '';
  const addedBy = useAddedBy(entry);
  const detail = [pending?.detail || row.detail, addedBy && `Added by ${addedBy}`].filter(Boolean).join(' · ');
  const listed = track ? trackActions(track, { liked: favorite, likeFailure, playable, offline, current, download, onItsOwn, wantlist, wanted, wantFailure, viewer, sharing }) : [];
  const actions = position ? queuedEntryActions(listed, position) : listed;
  // A failed or gray song fades its cover, and its text takes colors that stay readable (3:1).
  const label = accessibilityLabel([pending?.title ?? title, detail].filter(Boolean).join(', '));
  const body = <HStack spacing={12} modifiers={[frame({ minHeight: 44 }), padding({ vertical: 4 }), hitShape]}>
    <ZStack modifiers={failed ? [opacity(unavailableOpacity)] : []}><TrackCover track={track} size={coverSize} radius={5} /></ZStack>
    <VStack alignment="leading" spacing={2}>
      <Text modifiers={[font({ textStyle: 'body' }), ...lines,
        ...(pending ? [foregroundStyle(colors.muted)] : failed ? [foregroundStyle(colors.fadedTitle)] : [])]}>{pending?.title ?? title}</Text>
      {detail ? <Text modifiers={[font({ textStyle: 'subheadline' }), foregroundStyle(failed ? colors.fadedCredit : colors.muted), ...lines]}>{detail}</Text> : null}
    </VStack>
    <Spacer minLength={4} />
  </HStack>;
  const run = (action: TrackAction) => {
    if (!track) return;
    if (position) handlers.runQueued(entry, track, action, position);
    else handlers.run(track, action);
  };
  // A queued song whose summary has not loaded can still be moved or taken out of the queue.
  const placement = position && <>
    {position.index > 0 && <Button label="Move up" systemImage="chevron.up" onPress={() => handlers.move(entry, position.index - 1)} />}
    {position.index + 1 < position.total && <Button label="Move down" systemImage="chevron.down" onPress={() => handlers.move(entry, position.index + 1)} />}
    <Button label="Remove from queue" systemImage="trash" role="destructive" onPress={() => handlers.remove(entry, track?.title)} />
  </>;
  return <HStack spacing={0} modifiers={[frame({ minHeight }), onGeometryChange(({ height }) => onHeight(entry.id, height))]}>
    <Button onPress={() => { if (track && !failed) handlers.play(entry, track); }} modifiers={[plainButton, label]}>{body}</Button>
    {(track || position) && <TrackActionsMenu actions={actions} label={`More options for ${title || 'this song'}`} color={colors.muted} onRun={run}>
      {placement}
    </TrackActionsMenu>}
  </HStack>;
}, (a, b) => a.entry === b.entry && a.handlers === b.handlers && a.position?.index === b.position?.index
  && a.position?.total === b.position?.total && a.position?.autoplay === b.position?.autoplay
  && a.minHeight === b.minHeight && a.onHeight === b.onHeight);

const styles = StyleSheet.create({
  page: { flex: 1 },
  band: { marginHorizontal: 24 },
  list: { marginHorizontal: 24 },
  window: { position: 'absolute', left: 0, right: 0 },
  sticky: { zIndex: 1 },
  toggles: { zIndex: 2 },
  clip: { overflow: 'hidden' },
});
