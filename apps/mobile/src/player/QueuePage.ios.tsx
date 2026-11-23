import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Host, HStack, List, Spacer, SwipeActions, Text, VStack, ZStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityLabel, buttonStyle, disabled, dynamicTypeSize, environment, font, foregroundStyle, frame, labelStyle,
  lineLimit, listRowBackground, listRowInsets, listRowSeparatorTint, listStyle, onGeometryChange, opacity, padding, scrollContentBackground,
  scrollDisabled, tint,
} from '@expo/ui/swift-ui/modifiers';
import { Alert, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import type { TrackSummary } from '@squirmy/contracts';
import { useWantlistEnabled } from '../account/AccountProvider';
import { useRealtime } from '../data/realtime';
import { useCanPlay, useTrackDownload, useViewer } from '../downloads/DownloadsProvider';
import { useLiked, useTrack, useTrackStore, useWanted } from '../data/library';
import { heartButton } from '../library/heart';
import { trackActions, useDownloadedOnItsOwn, useTrackActionRunner, type TrackAction } from '../library/trackActions';
import { IconButton, Symbol, TrackActionsMenu, TrackCover, hitShape, plainButton } from '../native/Controls';
import { useCurrentTrackState, usePlaybackActions, usePlaybackState, type QueueEntry } from '../playback';
import type { QueueProps } from './QueuePage';
import { pendingQueueRow, queuedEntryActions, queuedEntryCommand, queueRow, type QueuePosition } from './session';
import { isAccessibilitySize } from '../fontScale';
import { unavailableOpacity, useColors } from '../theme';

/** A row's height at the default text size. Rows grow with their text; see `useRowHeights`. */
const rowHeight = 58;
const listModifiers = [listStyle('plain'), scrollContentBackground('hidden'), scrollDisabled()];
/**
 * Headings and the controls beside them stop growing here: past it "Play queue" and History
 * no longer fit side by side. The bands that hold them grow with their text up to it.
 */
const headingTextLimit = dynamicTypeSize({ max: 'xxxLarge' });
const headingHeight = 44;
/** Up next shows this many entries at first, and this many more each time more are asked for. */
const upNextPage = 100;
const rowModifiers = [
  listRowInsets({ top: 0, bottom: 0, leading: 0, trailing: 0 }),
  listRowBackground('clear'),
];

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
  const estimate = Math.max(floor, Math.ceil((isAccessibilitySize(fontScale) ? 80 : 40) * fontScale));
  const [heights, setHeights] = useState<Readonly<Record<string, number>>>({});
  const measure = useCallback((id: string, height: number) => {
    setHeights(current => Math.abs((current[id] ?? -1) - height) < 0.5 ? current : { ...current, [id]: height });
  }, []);
  const total = (entries: readonly QueueEntry[]) => Math.ceil(entries.reduce((sum, entry) => sum + (heights[entry.id] ?? estimate), 0));
  return { floor, measure, total };
}

const titleFont = font({ textStyle: 'headline', weight: 'semibold' });
const detailFont = font({ textStyle: 'footnote' });
const iconOnly = labelStyle('iconOnly');

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
  const [historyVisible, setHistoryVisible] = useState(false);
  const [editing, setEditing] = useState(false);
  const [upNextShown, setUpNextShown] = useState(upNextPage);
  const historyHandlers = useQueueHandlers(true);
  const upNext = useMemo(() => queue.queue.slice(0, upNextShown), [queue.queue, upNextShown]);
  const hidden = queue.queue.length - upNext.length;
  const canEdit = queue.queue.length > 1 || (session.autoplay && queue.autoplayQueue.length > 1);

  // Until the viewport is known the content is not yet tall enough to open at Up next, so a
  // short queue opened partway into the history; once it is, start at Up next.
  const placed = useRef(false);
  useLayoutEffect(() => {
    if (!viewport || placed.current) return;
    placed.current = true;
    scrollY.current = historyOffset.current;
    setHistoryVisible(false);
    const task = requestAnimationFrame(() => scroll.current?.scrollTo({ y: historyOffset.current, animated: false }));
    return () => cancelAnimationFrame(task);
  }, [viewport]);

  useLayoutEffect(() => {
    const shift = historyHeight - historyOffset.current;
    historyOffset.current = historyHeight;
    if (shift === 0) return;
    const y = Math.max(0, scrollY.current + shift);
    scrollY.current = y;
    setHistoryVisible(y < historyHeight - 16);
    const task = requestAnimationFrame(() => scroll.current?.scrollTo({ y, animated: false }));
    return () => cancelAnimationFrame(task);
  }, [historyHeight]);

  const clearHistory = () => Alert.alert('Clear listening history?', undefined, [
    { text: 'Cancel', style: 'cancel' },
    { text: 'Clear history', style: 'destructive', onPress: actions.clearHistory },
  ]);

  return <View style={styles.page}>
    <QueueBand height={headingHeight}>
      <HStack spacing={7}>
        <Text modifiers={[titleFont, accessibilityAddTraits(['isHeader'])]}>Play queue</Text>
        <Spacer minLength={4} />
        {/* From the history it goes back down to Up next, not to Now Playing. */}
        {history.length > 0 && <TextButton label={historyVisible ? 'Up next' : 'History'} color={colors.accent}
          onPress={() => scroll.current?.scrollTo({
            y: historyVisible ? historyHeight : Math.max(0, historyHeight - viewport * 0.8), animated: true,
          })} />}
        {(canEdit || editing) && <IconButton symbol={editing ? 'checkmark' : 'pencil'}
          label={editing ? 'Finish reordering' : 'Reorder queue'} color={colors.accent} size={17}
          selected={editing} onPress={() => setEditing(!editing)} />}
      </HStack>
    </QueueBand>
    <ScrollView ref={scroll} contentOffset={initialOffset.current} contentInsetAdjustmentBehavior="never"
      showsVerticalScrollIndicator={false} scrollEventThrottle={32}
      onLayout={({ nativeEvent }) => setViewport(nativeEvent.layout.height)}
      contentContainerStyle={{ minHeight: historyHeight + viewport, paddingBottom: 8 }}
      onScroll={({ nativeEvent }) => {
        const { y } = nativeEvent.contentOffset;
        scrollY.current = y;
        setHistoryVisible(y < historyHeight - 16);
      }}>
      {history.length > 0 && <>
        <QueueBand height={headingHeight}>
          <HStack>
            <Text modifiers={[titleFont, accessibilityAddTraits(['isHeader'])]}>Listening history</Text>
            <Spacer />
            <TextButton label="Clear" color={colors.muted} onPress={clearHistory} />
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
      <QueueBand height={52}>
        <HStack spacing={12}>
          <QueueMode symbol="shuffle" label="Shuffle" active={session.shuffle} onPress={actions.toggleShuffle} />
          <QueueMode symbol={session.repeat === 'one' ? 'repeat.1' : 'repeat'} label={`Repeat ${session.repeat}`}
            active={session.repeat !== 'off'} onPress={actions.cycleRepeat} />
          <QueueMode symbol="infinity" label="Autoplay" active={session.autoplay} onPress={actions.toggleAutoplay} />
          <Spacer />
        </HStack>
      </QueueBand>
      <QueueBand height={36}>
        <HStack>
          <Text modifiers={[titleFont, accessibilityAddTraits(['isHeader'])]}>Up next</Text>
          <Spacer />
          <Text modifiers={[detailFont, foregroundStyle(colors.quiet)]}>{queue.queue.length} {queue.queue.length === 1 ? 'track' : 'tracks'}</Text>
        </HStack>
      </QueueBand>
      {queue.queue.length ? <QueueRows entries={upNext} total={queue.queue.length} editing={editing} /> : (
        <QueueBand height={34}><Text modifiers={[detailFont, foregroundStyle(colors.muted)]}>Songs you queue appear here.</Text></QueueBand>
      )}
      {hidden > 0 && <QueueBand height={44}>
        <Button label={`Show ${Math.min(upNextPage, hidden)} more`} onPress={() => setUpNextShown(shown => shown + upNextPage)}
          modifiers={[plainButton, foregroundStyle(colors.accent)]} />
      </QueueBand>}
      <QueueBand height={58}>
        <VStack alignment="leading" spacing={4}>
          <HStack spacing={6}>
            <Symbol name="infinity" size={16} color={session.autoplay ? colors.accent : colors.quiet} />
            <Text modifiers={[titleFont, accessibilityAddTraits(['isHeader'])]}>Autoplay</Text>
          </HStack>
          <Text modifiers={[detailFont, foregroundStyle(colors.muted)]}>
            {session.autoplay ? 'Similar tracks continue when your queue ends.' : 'Turn on Autoplay to keep listening.'}
          </Text>
        </VStack>
      </QueueBand>
      {session.autoplay && <QueueRows entries={queue.autoplayQueue} editing={editing} autoplay />}
    </ScrollView>
  </View>;
}

/** A heading or note between the lists, at least `height` tall and taller when its text needs it. */
function QueueBand({ height, children }: { height: number; children: React.ReactNode }) {
  return <Host alignment="leading" matchContents={{ vertical: true }} style={[styles.band, { minHeight: height }]}
    modifiers={[headingTextLimit, frame({ maxWidth: Infinity, minHeight: height, alignment: 'leading' })]}>{children}</Host>;
}

/** A text button the full 44 pt tall, though its label is one short line. */
function TextButton({ label, color, onPress }: { label: string; color: string; onPress: () => void }) {
  return <Button onPress={onPress} modifiers={[plainButton, accessibilityLabel(label)]}>
    <Text modifiers={[foregroundStyle(color), lineLimit(1), frame({ minWidth: 44, minHeight: 44 }), hitShape]}>{label}</Text>
  </Button>;
}

function QueueMode({ symbol, label, active, onPress }: {
  symbol: string; label: string; active: boolean; onPress: () => void;
}) {
  const colors = useColors();
  return <Button onPress={onPress} modifiers={[
    buttonStyle(active ? 'borderedProminent' : 'bordered'),
    tint(active ? colors.accent : colors.muted), accessibilityLabel(label),
    ...(active ? [accessibilityAddTraits(['isSelected'])] : []),
  ]}>
    {/* The bordered style adds 7 pt above and below, so the button is 44 pt tall. */}
    <HStack modifiers={[frame({ width: 35, height: 30 })]}>
      <Symbol name={symbol} size={17} color={active ? colors.onAccent : colors.text} />
    </HStack>
  </Button>;
}

type QueueHandlers = {
  play: (entry: QueueEntry, track: TrackSummary) => void;
  promote: (entry: QueueEntry, autoplay: boolean) => void;
  move: (entry: QueueEntry, index: number) => void;
  remove: (entry: QueueEntry) => void;
  run: ReturnType<typeof useTrackActionRunner>['run'];
  /** A queued row's menu: an action that places the song moves this entry, as the swipe does, rather than queue the song again. */
  runQueued: (entry: QueueEntry, track: TrackSummary, action: TrackAction, position: QueuePosition) => void;
};

/** What queue rows do, in one object that changes only with the session runtime, so rows redraw only for their own entry. */
function useQueueHandlers(history: boolean): QueueHandlers {
  const actions = usePlaybackActions();
  const tracks = useTrackStore();
  const { run } = useTrackActionRunner();
  return useMemo(() => ({
    play: (entry, track) => history ? actions.playNow(track) : actions.playQueueEntry(entry.id),
    promote: (entry, autoplay) => actions.promote(entry, tracks.get(entry.trackId, entry.albumId), autoplay),
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
  }), [actions, history, run, tracks]);
}

function QueueRows({ entries, total = entries.length, editing, autoplay = false }: {
  entries: readonly QueueEntry[]; total?: number; editing: boolean; autoplay?: boolean;
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
    if (source !== index) actions.moveInQueue(entry.id, index);
  };

  return <Host ignoreSafeArea="container" style={[styles.list, { height: rows.total(entries) }]}>
    <List modifiers={[...listModifiers, environment({ key: 'editMode', value: editing ? 'active' : 'inactive' })]}>
      <List.ForEach data={entries} keyExtractor={entry => entry.id} recycling={false}
        onMove={entries.length > 1 ? onMove : undefined}>
        {({ item, index }) => <SwipeActions modifiers={[...rowModifiers, listRowSeparatorTint(colors.stroke)]}>
          <QueueTrack entry={item} handlers={handlers} position={{ index, total, autoplay }} editing={editing}
            minHeight={rows.floor} onHeight={rows.measure} />
          <SwipeActions.Actions edge="leading">
            <Button label="Play next" systemImage="text.line.first.and.arrowtriangle.forward"
              modifiers={[iconOnly, tint(colors.swipeNext)]} onPress={() => handlers.promote(item, autoplay)} />
          </SwipeActions.Actions>
          <SwipeActions.Actions edge="trailing" allowsFullSwipe={false}>
            <Button label="Remove from queue" systemImage="trash" role="destructive"
              modifiers={[iconOnly]} onPress={() => handlers.remove(item)} />
          </SwipeActions.Actions>
        </SwipeActions>}
      </List.ForEach>
    </List>
  </Host>;
}

type QueueTrackProps = {
  entry: QueueEntry;
  handlers: QueueHandlers;
  /** Where a queued entry sits, for its Move up and Move down; left out in the history. */
  position?: QueuePosition;
  /**
   * Reordering: the row is only something to drag, so it leaves out its heart and menu and does
   * not play when touched. The system's reorder handle is narrow (27 pt) and cannot be widened;
   * with nothing else to press beside it, a touch that misses it does nothing.
   */
  editing?: boolean;
  /** The least height of a row, which it grows from with its text. */
  minHeight: number;
  onHeight: (entryId: string, height: number) => void;
};

/** A queue row. A failed entry is gray and will be skipped, as is one that is not on the phone while offline. */
const QueueTrack = memo(function QueueTrack({ entry, handlers, position, editing = false, minHeight, onHeight }: QueueTrackProps) {
  const colors = useColors();
  const { fontScale } = useWindowDimensions();
  // At accessibility sizes a title and its artists wrap, and the row grows to hold them.
  const lines = isAccessibilitySize(fontScale) ? [] : [lineLimit(1)];
  const track = useTrack(entry.trackId, entry.albumId);
  const favorite = useLiked('track', track?.id, track?.liked);
  const { offline } = useRealtime();
  const download = useTrackDownload(entry.trackId);
  const onItsOwn = useDownloadedOnItsOwn(track?.id, download);
  const playable = useCanPlay(track);
  const current = useCurrentTrackState(track?.id);
  const wantlist = useWantlistEnabled();
  const wanted = useWanted(track?.id);
  const viewer = useViewer();
  const row = queueRow(entry, track, { playable, offline, viewer });
  const failed = row.unavailable;
  // Without its summary a row has nothing to show or act on: it says why, and offers no heart or menu.
  const pending = track ? null : pendingQueueRow(offline);
  const title = track?.title ?? '';
  const detail = pending?.detail || row.detail;
  const listed = track ? trackActions(track, { liked: favorite, playable, offline, current, download, onItsOwn, wantlist, wanted, viewer }) : [];
  const actions = position ? queuedEntryActions(listed, position) : listed;
  const heart = heartButton(favorite, title);
  // A failed or gray song fades its cover, and its text takes colors that stay readable (3:1);
  // the heart and menu keep their full color, since they still work.
  return <HStack spacing={0} modifiers={[frame({ minHeight }), onGeometryChange(({ height }) => onHeight(entry.id, height))]}>
    <Button onPress={() => { if (track && !failed) handlers.play(entry, track); }}
      modifiers={[plainButton, disabled(editing), accessibilityLabel([pending?.title ?? title, detail].filter(Boolean).join(', '))]}>
      <HStack spacing={10} modifiers={[frame({ minHeight: 44 }), hitShape]}>
        <ZStack modifiers={failed ? [opacity(unavailableOpacity)] : []}><TrackCover track={track} size={38} /></ZStack>
        <VStack alignment="leading" spacing={3} modifiers={[padding({ vertical: 6 })]}>
          <Text modifiers={[font({ textStyle: 'subheadline', weight: 'semibold' }), ...lines,
            ...(pending ? [foregroundStyle(colors.muted)] : failed ? [foregroundStyle(colors.fadedTitle)] : [])]}>{pending?.title ?? title}</Text>
          {detail ? <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(failed ? colors.fadedCredit : colors.muted), ...lines]}>{detail}</Text> : null}
        </VStack>
        <Spacer minLength={4} />
      </HStack>
    </Button>
    {track && !editing && <IconButton symbol={heart.icon} size={17} label={heart.label}
      color={favorite ? colors.accent : colors.muted} selected={heart.selected}
      onPress={() => handlers.run(track, { id: favorite ? 'unlike' : 'like', title, icon: 'heart' })} />}
    {track && !editing && <TrackActionsMenu actions={actions} label={`More options for ${title}`}
      onRun={action => position ? handlers.runQueued(entry, track, action, position) : handlers.run(track, action)}>
      {position && position.index > 0 && <Button label="Move up" systemImage="chevron.up" onPress={() => handlers.move(entry, position.index - 1)} />}
      {position && position.index + 1 < position.total && <Button label="Move down" systemImage="chevron.down" onPress={() => handlers.move(entry, position.index + 1)} />}
      {position && <Button label="Remove from queue" systemImage="trash" role="destructive" onPress={() => handlers.remove(entry)} />}
    </TrackActionsMenu>}
  </HStack>;
}, (a, b) => a.entry === b.entry && a.handlers === b.handlers && a.position?.index === b.position?.index
  && a.position?.total === b.position?.total && a.position?.autoplay === b.position?.autoplay && a.editing === b.editing
  && a.minHeight === b.minHeight && a.onHeight === b.onHeight);

const styles = StyleSheet.create({
  page: { flex: 1 },
  band: { marginHorizontal: 24 },
  list: { marginHorizontal: 24 },
});
