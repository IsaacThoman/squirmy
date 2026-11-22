import { useLayoutEffect, useRef, useState } from 'react';
import { Button, Host, HStack, List, Spacer, SwipeActions, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityLabel, buttonStyle, environment, font, foregroundStyle, frame, labelStyle, lineLimit,
  listRowBackground, listRowInsets, listRowSeparatorTint, listStyle, opacity, scrollContentBackground, scrollDisabled, tint,
} from '@expo/ui/swift-ui/modifiers';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import type { TrackSummary } from '@squirmy/contracts';
import { useRealtime } from '../data/realtime';
import { useTrackDownload } from '../downloads/DownloadsProvider';
import { useLibraryActions, useLiked, useTrack, useTrackStore } from '../data/library';
import { IconButton, Symbol, TrackCover, TrackMenu, hitShape, plainButton } from '../native/Controls';
import { usePlaybackState, type QueueEntry } from '../playback';
import type { QueueProps } from './QueuePage';
import { useColors } from '../theme';

const rowHeight = 54;
const headingHeight = 42;
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
              <QueueTrack entry={entry} onPlay={track => actions.playNow(track)} />
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
      {queue.queue.length ? <QueueRows entries={queue.queue} editing={editing} /> : (
        <QueueBand height={34}><Text modifiers={[detailFont, foregroundStyle(colors.muted)]}>Songs you queue appear here.</Text></QueueBand>
      )}
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

function QueueRows({ entries, editing, autoplay = false }: {
  entries: readonly QueueEntry[]; editing: boolean; autoplay?: boolean;
}) {
  const colors = useColors();
  const { actions } = usePlaybackState();
  const tracks = useTrackStore();
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
        {({ item, index }) => {
          const promote = () => actions.promote(item, tracks.get(item.trackId, item.albumId), autoplay);
          const remove = () => actions.removeFromQueue(item.id);
          return <SwipeActions modifiers={[...rowModifiers, listRowSeparatorTint(colors.stroke)]}>
            <QueueTrack entry={item} onPlay={() => actions.playQueueEntry(item.id)}>
              {index > 0 && <Button label="Move up" systemImage="chevron.up" onPress={() => actions.moveInQueue(item.id, index - 1)} />}
              {index + 1 < entries.length && <Button label="Move down" systemImage="chevron.down" onPress={() => actions.moveInQueue(item.id, index + 1)} />}
              <Button label="Remove from queue" systemImage="trash" role="destructive" onPress={remove} />
            </QueueTrack>
            <SwipeActions.Actions edge="leading">
              <Button label="Play next" systemImage="text.line.first.and.arrowtriangle.forward"
                modifiers={[iconOnly, tint('#8071D4')]} onPress={promote} />
            </SwipeActions.Actions>
            <SwipeActions.Actions edge="trailing" allowsFullSwipe={false}>
              <Button label="Remove from queue" systemImage="trash" role="destructive"
                modifiers={[iconOnly]} onPress={remove} />
            </SwipeActions.Actions>
          </SwipeActions>;
        }}
      </List.ForEach>
    </List>
  </Host>;
}

/** A queue row. A failed entry is gray and will be skipped, as is one that is not downloaded while offline; a preparing one says so. */
function QueueTrack({ entry, onPlay, children }: {
  entry: QueueEntry; onPlay: (track: TrackSummary) => void; children?: React.ReactNode;
}) {
  const colors = useColors();
  const track = useTrack(entry.trackId, entry.albumId);
  const favorite = useLiked('track', track?.id, track?.liked);
  const { setLiked } = useLibraryActions();
  const { offline } = useRealtime();
  const downloaded = useTrackDownload(entry.trackId)?.state === 'done';
  const failed = entry.state === 'failed' || (offline && !downloaded);
  const detail = entry.state === 'failed' ? 'Couldn’t be fetched' : failed ? 'Not downloaded' : entry.state === 'preparing' ? 'Preparing…' : track?.artistCredit ?? '';
  const title = track?.title ?? '';
  return <HStack spacing={0} modifiers={[frame({ height: rowHeight }), ...(failed ? [opacity(0.45)] : [])]}>
    <Button onPress={() => { if (track && !failed) onPlay(track); }} modifiers={[plainButton, accessibilityLabel(`${title}, ${detail}`)]}>
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
      color={favorite ? colors.accent : colors.muted} selected={favorite} onPress={() => track && setLiked('track', track.id, !favorite)} />
    <TrackMenu track={track}>{children}</TrackMenu>
  </HStack>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  band: { marginHorizontal: 24 },
  list: { marginHorizontal: 24 },
});
