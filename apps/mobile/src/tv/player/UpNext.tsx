import { contextLabel } from '@squirmy/client-core';
import type { QueueEntry } from '@squirmy/contracts';
import { memo, useMemo, useRef, type ComponentRef } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTrack } from '../../data/library';
import { useRealtime } from '../../data/realtime';
import { useCanPlay, useViewer } from '../../downloads/DownloadsProvider';
import { trackDuration } from '../../library/duration';
import { useCurrentTrackState, usePlaybackActions, usePlaybackState, type PlaybackActions } from '../../playback';
import {
  pendingQueueRow, queuedEntryActions, queuedEntryCommand, queueRow, upNextDetail, upNextTitle, type QueuePosition,
} from '../../player/session';
import { Icon } from '../../ui';
import { Artwork } from '../Artwork';
import { Focusable } from '../Focusable';
import { Menu, type MenuAction } from '../Menu';
import { useTrackMenu } from '../menus';
import { colors, type } from '../theme';

/** The history is long; the TV lists the last of it, as far back as anyone scrolls with a remote. */
const historyShown = 30;
/** Up next lists this many, and says how many more follow. */
const upNextShown = 100;

type Kind = 'history' | 'now' | 'queued';

/**
 * The queue beside the cover, laid out as the phone's: what played (above, out of view at first),
 * the song playing, then Up Next ("Continue Playing" while it all comes from what is playing) and
 * the autoplay suggestions. Selecting a row plays it; holding the click opens its menu, which moves
 * a queued song (Play next, Move up or down, Move to end) or takes it out of the queue.
 */
export function UpNext() {
  const { session, queue } = usePlaybackState();
  const actions = usePlaybackActions();
  const scroll = useRef<ComponentRef<typeof ScrollView>>(null);
  const placed = useRef(false);
  const context = contextLabel(session.context);
  const history = useMemo(() => queue.history.slice(-historyShown), [queue.history]);
  const upNext = useMemo(() => queue.queue.slice(0, upNextShown), [queue.queue]);
  const more = queue.queue.length - upNext.length;
  const current = session.current;
  return <ScrollView ref={scroll} style={styles.scroll} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
    {history.length > 0 && <>
      <Heading title="History" />
      {history.map(entry => <Row key={entry.id} entry={entry} kind="history" actions={actions} />)}
    </>}
    {current && <View onLayout={event => {
      // The page opens on the song playing, with what played above it, out of view.
      if (placed.current) return;
      placed.current = true;
      scroll.current?.scrollTo({ y: Math.max(0, event.nativeEvent.layout.y - 70), animated: false });
    }}>
      <Heading title="Now Playing" />
      <Row entry={current} kind="now" actions={actions} preferred />
    </View>}
    <Heading title={upNextTitle(context, queue.queue)} detail={upNextDetail(context, queue.queue) ?? 'Songs you queue appear here.'} />
    {upNext.map((entry, index) => <Row key={entry.id} entry={entry} kind="queued" actions={actions}
      index={index} total={queue.queue.length} />)}
    {more > 0 && <Text style={styles.more}>{`And ${more} more`}</Text>}
    <Heading title="Autoplay" icon="infinity"
      detail={session.autoplay ? 'Similar music will keep playing' : 'Turn on Autoplay to keep listening'} />
    {session.autoplay && queue.autoplayQueue.map((entry, index) => <Row key={entry.id} entry={entry} kind="queued" actions={actions}
      index={index} total={queue.autoplayQueue.length} autoplay />)}
  </ScrollView>;
}

function Heading({ title, detail, icon }: { title: string; detail?: string; icon?: string }) {
  return <View style={styles.heading}>
    <View style={styles.headingLine}>
      {icon && <Icon name={icon} size={30} color={colors.text} />}
      <Text accessibilityRole="header" style={styles.headingTitle}>{title}</Text>
    </View>
    {detail ? <Text style={styles.headingDetail}>{detail}</Text> : null}
  </View>;
}

const placement = { up: 'queue:up', down: 'queue:down', remove: 'queue:remove' } as const;

/**
 * A song in the queue. Its menu is the song's menu, where an action that places the song moves
 * this entry instead of queueing it again, as on the phone, with Move up, Move down and Remove.
 * A queued row takes its place as numbers, so a row whose place has not changed is not drawn again.
 */
const Row = memo(function Row({ entry, kind, index, total, autoplay = false, actions, preferred }: {
  entry: QueueEntry;
  kind: Kind;
  /** A queued song's place in its list (the queue, or the autoplay suggestions with `autoplay`), and that list's length. */
  index?: number;
  total?: number;
  autoplay?: boolean;
  actions: PlaybackActions;
  preferred?: boolean;
}) {
  const position: QueuePosition | undefined = index === undefined || total === undefined ? undefined : { index, total, autoplay };
  const track = useTrack(entry.trackId, entry.albumId);
  const { offline } = useRealtime();
  const playable = useCanPlay(track);
  const viewer = useViewer();
  const playing = useCurrentTrackState(kind === 'now' ? track?.id : undefined);
  const menu = useTrackMenu(track);
  const row = queueRow(entry, track, { playable, offline, viewer });
  const pending = track ? null : pendingQueueRow(offline);
  const title = pending?.title ?? track?.title ?? '';
  const detail = pending?.detail || row.detail;
  const items: MenuAction[] = position ? [
    ...(track ? queuedEntryActions(menu.actions, position) : []),
    ...(position.autoplay ? [] : [
      ...(position.index > 0 ? [{ id: placement.up, title: 'Move up', image: 'chevron.up' }] : []),
      ...(position.index + 1 < position.total ? [{ id: placement.down, title: 'Move down', image: 'chevron.down' }] : []),
    ]),
    { id: placement.remove, title: 'Remove from queue', image: 'trash', destructive: true },
  ] : menu.actions;
  const onAction = (id: string) => {
    if (position) {
      if (id === placement.up) return actions.moveInQueue(entry.id, position.index - 1);
      if (id === placement.down) return actions.moveInQueue(entry.id, position.index + 1);
      if (id === placement.remove) return actions.removeFromQueue(entry.id);
      switch (queuedEntryCommand(id)) {
        case 'playEntry': return actions.playQueueEntry(entry.id);
        case 'promote': return actions.promote(entry, track, position.autoplay);
        case 'moveToEnd':
          if (!position.autoplay) return actions.moveInQueue(entry.id, position.total - 1);
          // A suggestion joins the end of the queue and leaves the suggestions.
          if (track) actions.enqueue([track], 'last');
          return actions.removeFromQueue(entry.id);
      }
    }
    menu.onAction(id);
  };
  const select = () => {
    if (kind === 'now') return actions.playPause();
    if (row.unavailable || !track) return;
    if (kind === 'history') actions.playNow(track);
    else actions.playQueueEntry(entry.id);
  };
  return <Menu actions={items} onAction={onAction} title={title}>
    <Focusable
      accessibilityLabel={[title, detail].filter(Boolean).join(', ')}
      onPress={select}
      hasTVPreferredFocus={preferred}
      scale={1.02}
      liftStyle={({ focused }) => [styles.row, focused && styles.focused]}
    >
      {({ focused }) => <>
        <View style={[styles.cover, row.unavailable && styles.faded]}>
          <Artwork artwork={track?.album?.artwork} size={80} radius={8} focusEffect={false} />
          {playing && <View style={styles.marker}>
            <Icon name={playing === 'playing' ? 'waveform' : 'pause.fill'} size={30} color={colors.text} />
          </View>}
        </View>
        <View style={styles.words}>
          <View style={styles.titleLine}>
            <Text numberOfLines={1} style={[styles.title, kind === 'now' && !focused && styles.now, (pending || row.unavailable) && styles.quiet]}>{title}</Text>
            {track?.explicit && <Text style={styles.explicit}>E</Text>}
          </View>
          {detail ? <Text numberOfLines={1} style={styles.detail}>{detail}</Text> : null}
        </View>
        <Text style={[styles.duration, focused && styles.durationFocused]}>{entry.durationMs > 0 ? trackDuration(entry.durationMs) : ''}</Text>
      </>}
    </Focusable>
  </Menu>;
});

const styles = StyleSheet.create({
  scroll: { flex: 1 },
  content: { paddingTop: 20, paddingBottom: 60 },
  heading: { paddingHorizontal: 24, paddingTop: 30, paddingBottom: 12, gap: 2 },
  headingLine: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headingTitle: { ...type.headline, fontWeight: '700' },
  headingDetail: { ...type.subhead },
  more: { ...type.subhead, paddingHorizontal: 24, paddingVertical: 16 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 24, paddingHorizontal: 24, paddingVertical: 12, borderRadius: 18 },
  focused: { backgroundColor: 'rgba(255,255,255,0.22)' },
  cover: { width: 80, height: 80 },
  faded: { opacity: 0.4 },
  marker: { ...StyleSheet.absoluteFill, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  words: { flex: 1, gap: 2 },
  titleLine: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  title: { ...type.body, fontSize: 31, fontWeight: '600', flexShrink: 1 },
  now: { color: colors.accent },
  quiet: { color: colors.tertiary },
  explicit: { fontSize: 17, fontWeight: '800', color: colors.background, backgroundColor: colors.secondary, borderRadius: 4, paddingHorizontal: 5, overflow: 'hidden' },
  detail: { ...type.subhead, fontSize: 27 },
  duration: { ...type.body, color: colors.secondary, fontVariant: ['tabular-nums'] },
  durationFocused: { color: colors.text },
});
