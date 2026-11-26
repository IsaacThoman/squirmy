import { formatDuration } from '@squirmy/client-core';
import type { QueueEntry } from '@squirmy/contracts';
import { useState } from 'react';
import { SectionList, StyleSheet, Text, View } from 'react-native';
import { useTrack } from '../../data/library';
import { useRealtime } from '../../data/realtime';
import { useCanPlay, useViewer } from '../../downloads/DownloadsProvider';
import { usePlaybackState, type PlaybackActions } from '../../playback';
import { pendingQueueRow, queueRow } from '../../player/session';
import { TvButton, tvColors } from '../ui';
import { PlayerCover, PlayerIconButton, PlayerRow } from './Primitives';

type QueueSection = { title: string; autoplay: boolean };

export function TvQueue() {
  const { session, queue, actions } = usePlaybackState();
  const [options, setOptions] = useState<string | null>(null);
  const [focusModes, setFocusModes] = useState(false);
  const sections = [
    ...(queue.queue.length ? [{ title: 'Up next', data: queue.queue, autoplay: false }] : []),
    ...(session.autoplay && queue.autoplayQueue.length ? [{ title: 'Autoplay suggestions', data: queue.autoplayQueue, autoplay: true }] : []),
  ];

  return (
    <View style={styles.panel}>
      <View style={styles.modes}>
        <TvButton label="Shuffle" selected={session.shuffle} onPress={actions.toggleShuffle}
          hasTVPreferredFocus={focusModes} onFocus={() => setFocusModes(false)} />
        <TvButton label={session.repeat === 'one' ? 'Repeat one' : 'Repeat'} selected={session.repeat !== 'off'} onPress={actions.cycleRepeat} />
        <TvButton label="Autoplay" selected={session.autoplay} onPress={actions.toggleAutoplay} />
      </View>
      <SectionList<QueueEntry, QueueSection>
        style={styles.list}
        sections={sections}
        extraData={options}
        keyExtractor={entry => entry.id}
        contentContainerStyle={styles.rows}
        showsVerticalScrollIndicator={false}
        stickySectionHeadersEnabled={false}
        renderSectionHeader={({ section }) => <Text accessibilityRole="header" style={styles.sectionTitle}>{section.title}</Text>}
        renderItem={({ item, index, section }) => (
          <QueueRow entry={item} autoplay={section.autoplay} index={index} total={section.autoplay ? queue.autoplayQueue.length : queue.queue.length}
            open={options === item.id} actions={actions} onToggle={() => setOptions(options === item.id ? null : item.id)}
            onRemove={() => { setFocusModes(true); actions.removeFromQueue(item.id); setOptions(null); }} />
        )}
        ListEmptyComponent={<Text style={styles.empty}>Your queue is empty.</Text>}
      />
    </View>
  );
}

function QueueRow({ entry, index, total, autoplay, open, actions, onToggle, onRemove }: {
  entry: QueueEntry;
  index: number;
  total: number;
  autoplay: boolean;
  open: boolean;
  actions: PlaybackActions;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const track = useTrack(entry.trackId, entry.albumId);
  const [focusOptions, setFocusOptions] = useState(false);
  const { offline } = useRealtime();
  const playable = useCanPlay(track);
  const viewer = useViewer();
  const { detail, unavailable } = queueRow(entry, track, { offline, playable, viewer });
  const pending = pendingQueueRow(offline);
  const title = track?.title ?? pending.title;

  return (
    <View style={styles.item}>
      <View style={styles.itemRow}>
        <PlayerRow
          title={title}
          detail={detail || pending.detail}
          disabled={unavailable || !track}
          leading={<PlayerCover artwork={track?.album?.artwork} size={52} />}
          trailing={entry.durationMs > 0 ? focused => (
            <Text style={[styles.duration, focused && styles.focusedDuration]}>{formatDuration(entry.durationMs)}</Text>
          ) : undefined}
          onPress={() => actions.playQueueEntry(entry.id)}
        />
        <PlayerIconButton icon="ellipsis" label={`Queue options for ${title}`} selected={open} onPress={onToggle}
          preferred={focusOptions} onFocus={() => setFocusOptions(false)} />
      </View>
      {open && (
        <View style={styles.options}>
          {(autoplay || index > 0) && <TvButton label="Play next" disabled={unavailable}
            onPress={() => { setFocusOptions(!autoplay); actions.promote(entry, track, autoplay); onToggle(); }} />}
          {!autoplay && index < total - 1 && <TvButton label="Move to end"
            onPress={() => { setFocusOptions(true); actions.moveInQueue(entry.id, total - 1); onToggle(); }} />}
          <TvButton label="Remove" onPress={onRemove} />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, minHeight: 0, gap: 20 },
  modes: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 10 },
  list: { flex: 1, minHeight: 0 },
  rows: { paddingRight: 16, paddingBottom: 20 },
  sectionTitle: { color: tvColors.text, fontSize: 24, fontWeight: '600', paddingVertical: 13 },
  empty: { color: tvColors.muted, fontSize: 25, paddingVertical: 20 },
  item: { borderBottomWidth: StyleSheet.hairlineWidth, borderColor: tvColors.border },
  itemRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 4, paddingRight: 6 },
  duration: { color: tvColors.muted, fontSize: 20, fontVariant: ['tabular-nums'] },
  focusedDuration: { color: tvColors.ink },
  options: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, padding: 11 },
});
