import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Host, HStack, List, Spacer, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityLabel, background, dynamicTypeSize, environment, font, foregroundStyle, frame,
  lineLimit, listRowBackground, listRowInsets, listRowSeparatorTint, listStyle, onGeometryChange, opacity, padding, scrollContentBackground,
  scrollDisabled, shapes,
} from '@expo/ui/swift-ui/modifiers';
import { Alert, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { contextLabel } from '@squirmy/client-core';
import type { TrackSummary } from '@squirmy/contracts';
import { useWantlistEnabled } from '../account/AccountProvider';
import { useRealtime } from '../data/realtime';
import { useCanPlay, useTrackDownload, useViewer } from '../downloads/DownloadsProvider';
import { useLiked, useLikeFailure, useTrack, useWanted, useWantFailure } from '../data/library';
import { trackActions, useDownloadedOnItsOwn, useTrackActionRunner, type TrackAction } from '../library/trackActions';
import { Symbol, TrackActionsMenu, TrackCover, hitShape, plainButton } from '../native/Controls';
import { useCurrentTrackState, usePlaybackActions, usePlaybackState, type QueueEntry } from '../playback';
import type { QueueProps } from './QueuePage';
import { selectionFeedback } from './design';
import { pendingQueueRow, queuedEntryActions, queuedEntryCommand, queueRow, upNextDetail, type QueuePosition } from './session';
import { isAccessibilitySize } from '../fontScale';
import { unavailableOpacity, useColors } from '../theme';

/** A row's height at the default text size. Rows grow with their text; see `useRowHeights`. */
const rowHeight = 62;
const coverSize = 46;
const listModifiers = [listStyle('plain'), scrollContentBackground('hidden'), scrollDisabled()];
/** Headings and their quieter lines stop growing here, so they stay a line or two beside the lists. */
const headingTextLimit = dynamicTypeSize({ max: 'xxxLarge' });
const headingHeight = 44;
/** Up next shows this many entries at first, and this many more each time more are asked for. */
const upNextPage = 100;
const rowModifiers = [
  listRowInsets({ top: 0, bottom: 0, leading: 0, trailing: 0 }),
  listRowBackground('clear'),
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
 * grow with the text: each reports its height, and the list is sized to their sum. Until a row
 * has reported it is counted generously, so every row is laid out and measured on the first
 * pass (a row below the list's bottom edge would never be).
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
  const total = (entries: readonly QueueEntry[]) => Math.ceil(entries.reduce((sum, entry) => sum + (heights[entry.id] ?? estimate), 0));
  return { floor, measure, total };
}

const headingFont = font({ textStyle: 'headline', weight: 'semibold' });
const detailFont = font({ textStyle: 'footnote' });

/**
 * Laid out as Apple Music's queue: Shuffle, Repeat and Autoplay as one row of toggles, Up next
 * and the Autoplay suggestions as headed lists whose rows carry reorder handles, and the history
 * above them, reached by scrolling up. A row is the song and one menu button, which holds what
 * its heart did, alongside the rest of its actions.
 */
export default function QueuePage(_props: QueueProps) {
  const colors = useColors();
  const { session, queue, actions } = usePlaybackState();
  const { history } = queue;
  const historyRows = useRowHeights();
  const historyHeight = history.length ? headingHeight + historyRows.total(history) : 0;
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const initialOffset = useRef({ x: 0, y: historyHeight });
  const historyOffset = useRef(historyHeight);
  const scrollY = useRef(historyHeight);
  const [viewport, setViewport] = useState(0);
  const [upNextShown, setUpNextShown] = useState(upNextPage);
  const historyHandlers = useQueueHandlers(true);
  const upNext = useMemo(() => queue.queue.slice(0, upNextShown), [queue.queue, upNextShown]);
  const hidden = queue.queue.length - upNext.length;
  const context = contextLabel(session.context);

  // Until the viewport is known the content is not yet tall enough to open at the toggles, so a
  // short queue opened partway into the history; once it is, start there.
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (!viewport || placed.current) return;
    placed.current = true;
    scrollY.current = historyOffset.current;
    const task = requestAnimationFrame(() => scroll.current?.scrollTo({ y: historyOffset.current, animated: false }));
    return () => cancelAnimationFrame(task);
  }, [viewport]);

  // The history grows above what is on screen as songs finish; keep the view where it was.
  useLayoutEffect(() => {
    const shift = historyHeight - historyOffset.current;
    historyOffset.current = historyHeight;
    if (shift === 0) return;
    const y = Math.max(0, scrollY.current + shift);
    scrollY.current = y;
    const task = requestAnimationFrame(() => scroll.current?.scrollTo({ y, animated: false }));
    return () => cancelAnimationFrame(task);
  }, [historyHeight]);

  const clearHistory = () => Alert.alert('Clear listening history?', undefined, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Clear history', style: 'destructive', onPress: actions.clearHistory },
  ]);
  const toggle = (run: () => void) => () => { selectionFeedback(); run(); };

  return <View style={styles.page}>
    <ScrollView ref={scroll} contentOffset={initialOffset.current} contentInsetAdjustmentBehavior="never"
      showsVerticalScrollIndicator={false} scrollEventThrottle={32}
      onLayout={({ nativeEvent }) => setViewport(nativeEvent.layout.height)}
      contentContainerStyle={{ minHeight: historyHeight + viewport, paddingBottom: 8 }}
      onScroll={({ nativeEvent }) => { scrollY.current = nativeEvent.contentOffset.y; }}>
      {history.length > 0 && <>
        <QueueBand height={headingHeight}>
          <HStack>
            <Text modifiers={[headingFont, accessibilityAddTraits(['isHeader'])]}>History</Text>
            <Spacer />
            <TextButton label="Clear" color={colors.accent} onPress={clearHistory} />
          </HStack>
        </QueueBand>
        <Host ignoreSafeArea="container" style={[styles.list, { height: historyRows.total(history) }]}>
          <List modifiers={listModifiers}>
            {history.map(entry => <VStack key={entry.id} modifiers={[...rowModifiers, listRowSeparatorTint(colors.stroke)]}>
              <QueueTrack entry={entry} handlers={historyHandlers} minHeight={historyRows.floor} onHeight={historyRows.measure} />
            </VStack>)}
          </List>
        </Host>
      </>}
      <QueueBand height={56}>
        <HStack spacing={10}>
          <QueueMode symbol="shuffle" label="Shuffle" active={session.shuffle} onPress={toggle(actions.toggleShuffle)} />
          <QueueMode symbol={session.repeat === 'one' ? 'repeat.1' : 'repeat'} label={`Repeat ${session.repeat}`}
            active={session.repeat !== 'off'} onPress={toggle(actions.cycleRepeat)} />
          <QueueMode symbol="infinity" label="Autoplay" active={session.autoplay} onPress={toggle(actions.toggleAutoplay)} />
        </HStack>
      </QueueBand>
      <QueueHeading title="Up next" detail={upNextDetail(context, queue.queue) ?? 'Songs you queue appear here.'} />
      {queue.queue.length > 0 && <QueueRows entries={upNext} total={queue.queue.length} />}
      {hidden > 0 && <QueueBand height={44}>
        <TextButton label={`Show ${Math.min(upNextPage, hidden)} more`} color={colors.accent} onPress={() => setUpNextShown(shown => shown + upNextPage)} />
      </QueueBand>}
      <QueueHeading title="Autoplay" symbol="infinity" symbolColor={session.autoplay ? colors.accent : colors.quiet}
        detail={session.autoplay ? 'Similar music keeps playing when your queue ends.' : 'Turn on Autoplay to keep listening.'} />
      {session.autoplay && <QueueRows entries={queue.autoplayQueue} autoplay />}
    </ScrollView>
  </View>;
}

/** A heading or note between the lists, at least `height` tall and taller when its text needs it. */
function QueueBand({ height, children }: { height: number; children: React.ReactNode }) {
  return <Host alignment="leading" ignoreSafeArea="container" matchContents={{ vertical: true }} style={[styles.band, { minHeight: height }]}
    modifiers={[headingTextLimit, frame({ maxWidth: Infinity, minHeight: height, alignment: 'leading' })]}>{children}</Host>;
}

/** A list's heading, with a quieter line under it, as Apple Music's "Continue Playing / From …". */
function QueueHeading({ title, detail, symbol, symbolColor }: {
  title: string; detail?: string | null; symbol?: string; symbolColor?: string;
}) {
  const colors = useColors();
  return <QueueBand height={detail ? 62 : headingHeight}>
    <VStack alignment="leading" spacing={2} modifiers={[padding({ top: 14, bottom: 6 })]}>
      <HStack spacing={6}>
        {symbol && <Symbol name={symbol} size={16} color={symbolColor} />}
        <Text modifiers={[headingFont, accessibilityAddTraits(['isHeader'])]}>{title}</Text>
      </HStack>
      {detail ? <Text modifiers={[detailFont, foregroundStyle(colors.muted), lineLimit(2)]}>{detail}</Text> : null}
    </VStack>
  </QueueBand>;
}

/** A text button the full 44 pt tall, though its label is one short line. */
function TextButton({ label, color, onPress }: { label: string; color: string; onPress: () => void }) {
  return <Button onPress={onPress} modifiers={[plainButton, accessibilityLabel(label)]}>
    <Text modifiers={[foregroundStyle(color), lineLimit(1), frame({ minWidth: 44, minHeight: 44 }), hitShape]}>{label}</Text>
  </Button>;
}

/** One of the row of toggles: a capsule a third of the width, filled while it is on. 44 pt tall to touch, 34 pt drawn. */
function QueueMode({ symbol, label, active, onPress }: {
  symbol: string; label: string; active: boolean; onPress: () => void;
}) {
  const colors = useColors();
  return <Button onPress={onPress} modifiers={[
    plainButton, accessibilityLabel(label), ...(active ? [accessibilityAddTraits(['isSelected'])] : []),
  ]}>
    <HStack modifiers={[
      frame({ maxWidth: Infinity, minHeight: 34 }), background(active ? colors.accent : colors.chip, shapes.capsule()),
      padding({ vertical: 5 }), hitShape,
    ]}>
      <Symbol name={symbol} size={17} color={active ? colors.onAccent : colors.text} />
    </HStack>
  </Button>;
}

type QueueHandlers = {
  play: (entry: QueueEntry, track: TrackSummary) => void;
  move: (entry: QueueEntry, index: number) => void;
  remove: (entry: QueueEntry) => void;
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
    remove: entry => actions.removeFromQueue(entry.id),
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

function QueueRows({ entries, total = entries.length, autoplay = false }: {
  entries: readonly QueueEntry[]; total?: number; autoplay?: boolean;
}) {
  const colors = useColors();
  const actions = usePlaybackActions();
  const handlers = useQueueHandlers(false);
  const rows = useRowHeights();
  if (!entries.length) return null;

  const onMove = ([source]: number[], destination: number) => {
    const entry = entries[source];
    if (!entry) return;
    const index = destination > source ? destination - 1 : destination;
    if (source !== index) {
      selectionFeedback();
      actions.moveInQueue(entry.id, index);
    }
  };

  return <Host ignoreSafeArea="container" style={[styles.list, { height: rows.total(entries) }]}>
    <List modifiers={[...listModifiers, reordering]}>
      <List.ForEach data={entries} keyExtractor={entry => entry.id} recycling={false}
        onMove={entries.length > 1 ? onMove : undefined}>
        {({ item, index }) => <VStack modifiers={[...rowModifiers, listRowSeparatorTint(colors.stroke)]}>
          <QueueTrack entry={item} handlers={handlers} position={{ index, total, autoplay }}
            minHeight={rows.floor} onHeight={rows.measure} />
        </VStack>}
      </List.ForEach>
    </List>
  </Host>;
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
  const wanted = useWanted(track?.id);
  const wantFailure = useWantFailure(track?.id);
  const viewer = useViewer();
  const row = queueRow(entry, track, { playable, offline, viewer });
  const failed = row.unavailable;
  // Without its summary a row has nothing to show or act on: it says why, and offers no menu.
  const pending = track ? null : pendingQueueRow(offline);
  const title = track?.title ?? '';
  const detail = pending?.detail || row.detail;
  const listed = track ? trackActions(track, { liked: favorite, likeFailure, playable, offline, current, download, onItsOwn, wantlist, wanted, wantFailure, viewer }) : [];
  const actions = position ? queuedEntryActions(listed, position) : listed;
  // A failed or gray song fades its cover, and its text takes colors that stay readable (3:1).
  const label = accessibilityLabel([pending?.title ?? title, detail].filter(Boolean).join(', '));
  const body = <HStack spacing={12} modifiers={[frame({ minHeight: 44 }), padding({ vertical: 8 }), hitShape]}>
    <ZStack modifiers={failed ? [opacity(unavailableOpacity)] : []}><TrackCover track={track} size={coverSize} radius={6} /></ZStack>
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
    <Button label="Remove from queue" systemImage="trash" role="destructive" onPress={() => handlers.remove(entry)} />
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
});
