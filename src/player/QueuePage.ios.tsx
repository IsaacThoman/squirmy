import { useLayoutEffect, useRef, useState } from 'react';
import { Button, Host, HStack, List, Spacer, SwipeActions, Text, VStack } from '@expo/ui/swift-ui';
import {
  accessibilityAddTraits, accessibilityLabel, buttonStyle, environment, font, foregroundStyle, frame, labelStyle, lineLimit,
  listRowBackground, listRowInsets, listRowSeparatorTint, listStyle, scrollContentBackground, scrollDisabled, tint,
} from '@expo/ui/swift-ui/modifiers';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import { tracks } from '../catalog';
import { IconButton, Symbol, TrackCover, TrackMenu, hitShape, plainButton } from '../native/Controls';
import { usePlaybackState, type QueueEntry } from '../playback';
import { playerColors as c } from './design';
import type { QueueProps } from './QueuePage';

const rowHeight = 54;
const headingHeight = 42;
const rowModifiers = [
  listRowInsets({ top: 0, bottom: 0, leading: 0, trailing: 0 }),
  listRowBackground('clear'),
  listRowSeparatorTint('#FFFFFF22'),
];
const listModifiers = [listStyle('plain'), scrollContentBackground('hidden'), scrollDisabled()];
const titleFont = font({ textStyle: 'headline', weight: 'semibold' });
const detailFont = font({ textStyle: 'footnote' });
const iconOnly = labelStyle('iconOnly');

export default function QueuePage(_props: QueueProps) {
  const { state, actions } = usePlaybackState();
  const historyHeight = state.history.length ? headingHeight + rowHeight * state.history.length : 0;
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null);
  const initialOffset = useRef({ x: 0, y: historyHeight });
  const historyOffset = useRef(historyHeight);
  const scrollY = useRef(historyHeight);
  const [viewport, setViewport] = useState(0);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [editing, setEditing] = useState(false);
  const canEdit = state.queue.length > 1 || (state.autoplay && state.autoplayQueue.length > 1);

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
        {state.history.length > 0 && <Button label={historyVisible ? 'Now playing' : 'History'}
          modifiers={[buttonStyle('plain'), tint(c.lilac), foregroundStyle(c.lilac)]}
          onPress={() => scroll.current?.scrollTo({
            y: historyVisible ? historyHeight : Math.max(0, historyHeight - viewport * 0.8), animated: true,
          })} />}
        {(canEdit || editing) && <IconButton symbol={editing ? 'checkmark' : 'pencil'}
          label={editing ? 'Finish reordering' : 'Reorder queue'} color={c.lilac} size={17} width={36} height={42}
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
      {state.history.length > 0 && <>
        <QueueBand height={headingHeight}>
          <HStack>
            <Text modifiers={[titleFont, accessibilityAddTraits(['isHeader'])]}>Listening history</Text>
            <Spacer />
            <Button label="Clear" onPress={clearHistory} modifiers={[plainButton, foregroundStyle(c.muted)]} />
          </HStack>
        </QueueBand>
        <Host colorScheme="dark" style={[styles.list, { height: rowHeight * state.history.length }]}>
          <List modifiers={listModifiers}>
            {state.history.map(entry => <VStack key={entry.id} modifiers={rowModifiers}>
              <QueueTrack trackId={entry.trackId} onPlay={() => actions.playTrack(entry.trackId)} />
            </VStack>)}
          </List>
        </Host>
      </>}
      <QueueBand height={49}>
        <HStack spacing={12}>
          <QueueMode symbol="shuffle" label="Shuffle" active={state.shuffle} onPress={actions.toggleShuffle} />
          <QueueMode symbol={state.repeat === 'one' ? 'repeat.1' : 'repeat'} label={`Repeat ${state.repeat}`}
            active={state.repeat !== 'off'} onPress={actions.cycleRepeat} />
          <QueueMode symbol="infinity" label="Autoplay" active={state.autoplay} onPress={actions.toggleAutoplay} />
          <Spacer />
        </HStack>
      </QueueBand>
      <QueueBand height={36}>
        <HStack>
          <Text modifiers={[titleFont, accessibilityAddTraits(['isHeader'])]}>Up next</Text>
          <Spacer />
          <Text modifiers={[detailFont, foregroundStyle(c.quiet)]}>{state.queue.length} {state.queue.length === 1 ? 'track' : 'tracks'}</Text>
        </HStack>
      </QueueBand>
      {state.queue.length ? <QueueRows entries={state.queue} editing={editing} /> : (
        <QueueBand height={34}><Text modifiers={[detailFont, foregroundStyle(c.muted)]}>Songs you queue appear here.</Text></QueueBand>
      )}
      <QueueBand height={58}>
        <VStack alignment="leading" spacing={4}>
          <HStack spacing={6}>
            <Symbol name="infinity" size={16} color={state.autoplay ? c.lilac : c.quiet} />
            <Text modifiers={[titleFont, accessibilityAddTraits(['isHeader'])]}>Autoplay</Text>
          </HStack>
          <Text modifiers={[detailFont, foregroundStyle(c.muted)]}>
            {state.autoplay ? 'Similar tracks continue when your queue ends.' : 'Turn on Autoplay to keep listening.'}
          </Text>
        </VStack>
      </QueueBand>
      {state.autoplay && <QueueRows entries={state.autoplayQueue} editing={editing} autoplay />}
    </ScrollView>
  </View>;
}

function QueueBand({ height, children }: { height: number; children: React.ReactNode }) {
  return <Host colorScheme="dark" alignment="leading" style={[styles.band, { height }]}>{children}</Host>;
}

function QueueMode({ symbol, label, active, onPress }: {
  symbol: string; label: string; active: boolean; onPress: () => void;
}) {
  return <Button onPress={onPress} modifiers={[
    buttonStyle(active ? 'borderedProminent' : 'bordered'),
    tint(active ? c.lilac : c.muted), accessibilityLabel(label),
    ...(active ? [accessibilityAddTraits(['isSelected'])] : []),
  ]}>
    <HStack modifiers={[frame({ width: 35, height: 24 })]}>
      <Symbol name={symbol} size={17} color={active ? c.ink : c.text} />
    </HStack>
  </Button>;
}

function QueueRows({ entries, editing, autoplay = false }: {
  entries: readonly QueueEntry[]; editing: boolean; autoplay?: boolean;
}) {
  const { actions } = usePlaybackState();
  if (!entries.length) return null;

  const onMove = ([source]: number[], destination: number) => {
    const entry = entries[source];
    if (!entry) return;
    const index = destination > source ? destination - 1 : destination;
    if (source !== index) actions.moveInQueue(entry.id, index);
  };

  return <Host colorScheme="dark" style={[styles.list, { height: entries.length * rowHeight }]}>
    <List modifiers={[...listModifiers, environment({ key: 'editMode', value: editing ? 'active' : 'inactive' })]}>
      <List.ForEach data={entries} keyExtractor={entry => entry.id} recycling={false}
        onMove={entries.length > 1 ? onMove : undefined}>
        {({ item, index }) => {
          const promote = () => {
            if (autoplay) {
              actions.addToQueue(item.trackId, 'next');
              actions.removeFromQueue(item.id);
            } else actions.moveInQueue(item.id, 0);
          };
          const remove = () => actions.removeFromQueue(item.id);
          return <SwipeActions modifiers={rowModifiers}>
            <QueueTrack trackId={item.trackId} onPlay={() => actions.playQueueEntry(item.id)}>
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

function QueueTrack({ trackId, onPlay, children }: {
  trackId: string; onPlay: () => void; children?: React.ReactNode;
}) {
  const track = tracks[trackId];
  const { state, actions } = usePlaybackState();
  const favorite = state.favorites.includes(trackId);
  return <HStack spacing={0} modifiers={[frame({ height: rowHeight })]}>
    <Button onPress={onPlay} modifiers={[plainButton, accessibilityLabel(`${track.title}, ${track.artist}`)]}>
      <HStack spacing={10} modifiers={[frame({ minHeight: 44 }), hitShape]}>
        <TrackCover trackId={trackId} size={38} />
        <VStack alignment="leading" spacing={3}>
          <Text modifiers={[font({ textStyle: 'subheadline', weight: 'semibold' }), lineLimit(1)]}>{track.title}</Text>
          <Text modifiers={[font({ textStyle: 'caption' }), foregroundStyle(c.muted), lineLimit(1)]}>{track.artist}</Text>
        </VStack>
        <Spacer minLength={4} />
      </HStack>
    </Button>
    <IconButton symbol={favorite ? 'heart.fill' : 'heart'} size={17}
      label={favorite ? `Remove ${track.title} from favorites` : `Favorite ${track.title}`}
      color={favorite ? c.lilac : c.muted} selected={favorite} onPress={() => actions.toggleFavorite(trackId)} />
    <TrackMenu trackId={trackId}>{children}</TrackMenu>
  </HStack>;
}

const styles = StyleSheet.create({
  page: { flex: 1 },
  band: { marginHorizontal: 24 },
  list: { marginHorizontal: 24 },
});
