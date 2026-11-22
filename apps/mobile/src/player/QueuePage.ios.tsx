import { memo, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Button, Host, HStack, List, Spacer, SwipeActions, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityLabel, buttonStyle, environment, font, foregroundStyle, frame, labelStyle, lineLimit,
  listRowBackground, listRowInsets, listRowSeparatorTint, listStyle, opacity, scrollContentBackground, scrollDisabled, tint,
} from '@expo/ui/swift-ui/modifiers';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import type { TrackSummary } from '@squirmy/contracts';
import { useWantlistEnabled } from '../account/AccountProvider';
import { useRealtime } from '../data/realtime';
import { useCanPlay, useTrackDownload, useViewer } from '../downloads/DownloadsProvider';
import { useLiked, useSaved, useTrack, useTrackStore } from '../data/library';
import { trackActions, useDownloadedOnItsOwn, useTrackActionRunner } from '../library/trackActions';
import { IconButton, Symbol, TrackActionsMenu, TrackCover, hitShape, plainButton } from '../native/Controls';
import { useCurrentTrackState, usePlaybackActions, usePlaybackState, type QueueEntry } from '../playback';
import type { QueueProps } from './QueuePage';
import { queueRow } from './session';
import { useColors } from '../theme';

const rowHeight = 54;
const headingHeight = 42;
/** Up next shows this many entries at first, and this many more each time more are asked for. */
const upNextPage = 100;
const rowModifiers = [
  listRowInsets({ top: 0, bottom: 0, leading: 0, trailing: 0 }),
  listRowBackground('clear'),
];
const listModifiers = [listStyle('plain'), scrollContentBackground('hidden'), scrollDisabled()];
const titleFont = font({ textStyle: 'headline', weight: 'semibold' });
const detailFont = font({ textStyle: 'footnote' });
const iconOnly = labelStyle('iconOnly');

export default function QueuePage(_props: QueueProps) {
  const colors = useColors();
  const { session, queue, actions } = usePlaybackState();
  const { history } = queue;
  const historyHeight = history.length ? headingHeight + rowHeight * history.length : 0;
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
    <QueueBand height={42}>
      <HStack spacing={11}>
        <Text modifiers={[titleFont, accessibilityAddTraits(['isHeader'])]}>Play queue</Text>
        <Spacer minLength={4} />
        {history.length > 0 && <Button label={historyVisible ? 'Now playing' : 'History'}
          modifiers={[buttonStyle('plain'), tint(colors.accent), foregroundStyle(colors.accent)]}
          onPress={() => scroll.current?.scrollTo({
            y: historyVisible ? historyHeight : Math.max(0, historyHeight - viewport * 0.8), animated: true,
          })} />}
        {(canEdit || editing) && <IconButton symbol={editing ? 'checkmark' : 'pencil'}
          label={editing ? 'Finish reordering' : 'Reorder queue'} color={colors.accent} size={17} width={36} height={42}
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
            <Button label="Clear" onPress={clearHistory} modifiers={[plainButton, foregroundStyle(colors.muted)]} />
          </HStack>
        </QueueBand>
        <Host style={[styles.list, { height: rowHeight * history.length }]}>
          <List modifiers={listModifiers}>
            {history.map(entry => <VStack key={entry.id} modifiers={[...rowModifiers, listRowSeparatorTint(colors.stroke)]}>
              <QueueTrack entry={entry} handlers={historyHandlers} />
            </VStack>)}
          </List>
        </Host>
      </>}
      <QueueBand height={49}>
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

function QueueBand({ height, children }: { height: number; children: React.ReactNode }) {
  return <Host alignment="leading" style={[styles.band, { height }]}>{children}</Host>;
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
    <HStack modifiers={[frame({ width: 35, height: 24 })]}>
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
  }), [actions, history, run, tracks]);
}

function QueueRows({ entries, total = entries.length, editing, autoplay = false }: {
  entries: readonly QueueEntry[]; total?: number; editing: boolean; autoplay?: boolean;
}) {
  const colors = useColors();
  const actions = usePlaybackActions();
  const handlers = useQueueHandlers(false);
  if (!entries.length) return null;

  const onMove = ([source]: number[], destination: number) => {
    const entry = entries[source];
    if (!entry) return;
    const index = destination > source ? destination - 1 : destination;
    if (source !== index) actions.moveInQueue(entry.id, index);
  };

  return <Host style={[styles.list, { height: entries.length * rowHeight }]}>
    <List modifiers={[...listModifiers, environment({ key: 'editMode', value: editing ? 'active' : 'inactive' })]}>
      <List.ForEach data={entries} keyExtractor={entry => entry.id} recycling={false}
        onMove={entries.length > 1 ? onMove : undefined}>
        {({ item, index }) => <SwipeActions modifiers={[...rowModifiers, listRowSeparatorTint(colors.stroke)]}>
          <QueueTrack entry={item} handlers={handlers} position={{ index, total, autoplay }} />
          <SwipeActions.Actions edge="leading">
            <Button label="Play next" systemImage="text.line.first.and.arrowtriangle.forward"
              modifiers={[iconOnly, tint('#8071D4')]} onPress={() => handlers.promote(item, autoplay)} />
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
  position?: { index: number; total: number; autoplay: boolean };
};

/** A queue row. A failed entry is gray and will be skipped, as is one that is not on the phone while offline. */
const QueueTrack = memo(function QueueTrack({ entry, handlers, position }: QueueTrackProps) {
  const colors = useColors();
  const track = useTrack(entry.trackId, entry.albumId);
  const favorite = useLiked('track', track?.id, track?.liked);
  const { offline } = useRealtime();
  const download = useTrackDownload(entry.trackId);
  const onItsOwn = useDownloadedOnItsOwn(track?.id, download);
  const playable = useCanPlay(track);
  const current = useCurrentTrackState(track?.id);
  const wantlist = useWantlistEnabled();
  const viewer = useViewer();
  const { detail, unavailable: failed } = queueRow(entry, track, { playable, offline, viewer });
  const title = track?.title ?? '';
  const saved = useSaved('track', track?.id, track?.inLibrary);
  const actions = track ? trackActions(track, { liked: favorite, playable, offline, current, download, onItsOwn, wantlist, saved, viewer }) : [];
  return <HStack spacing={0} modifiers={[frame({ height: rowHeight }), ...(failed ? [opacity(0.45)] : [])]}>
    <Button onPress={() => { if (track && !failed) handlers.play(entry, track); }} modifiers={[plainButton, accessibilityLabel(`${title}, ${detail}`)]}>
      <HStack spacing={10} modifiers={[frame({ minHeight: 44 }), hitShape]}>
        <TrackCover track={track} size={38} />
        <VStack alignment="leading" spacing={3}>
          <Text modifiers={[font({ textStyle: 'subheadline', weight: 'semibold' }), lineLimit(1)]}>{title}</Text>
          <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(colors.muted), lineLimit(1)]}>{detail}</Text>
        </VStack>
        <Spacer minLength={4} />
      </HStack>
    </Button>
    <IconButton symbol={favorite ? 'heart.fill' : 'heart'} size={17}
      label={favorite ? `Unlike ${title}` : `Like ${title}`}
      color={favorite ? colors.accent : colors.muted} selected={favorite}
      onPress={() => track && handlers.run(track, { id: favorite ? 'unlike' : 'like', title, icon: 'heart' })} />
    <TrackActionsMenu actions={actions} onRun={action => track && handlers.run(track, action)} label={`More options for ${title || 'this song'}`}>
      {position && position.index > 0 && <Button label="Move up" systemImage="chevron.up" onPress={() => handlers.move(entry, position.index - 1)} />}
      {position && position.index + 1 < position.total && <Button label="Move down" systemImage="chevron.down" onPress={() => handlers.move(entry, position.index + 1)} />}
      {position && <Button label="Remove from queue" systemImage="trash" role="destructive" onPress={() => handlers.remove(entry)} />}
    </TrackActionsMenu>
  </HStack>;
}, (a, b) => a.entry === b.entry && a.handlers === b.handlers && a.position?.index === b.position?.index
  && a.position?.total === b.position?.total && a.position?.autoplay === b.position?.autoplay);

const styles = StyleSheet.create({
  page: { flex: 1 },
  band: { marginHorizontal: 24 },
  list: { marginHorizontal: 24 },
});
