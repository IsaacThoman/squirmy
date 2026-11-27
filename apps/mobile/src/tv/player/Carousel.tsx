import type { QueueEntry } from '@squirmy/contracts';
import { useIsFocused } from 'expo-router';
import { memo, useEffect, useLayoutEffect, useRef } from 'react';
import { ActivityIndicator, Animated, StyleSheet, Text, View } from 'react-native';
import { useTrack } from '../../data/library';
import { useIsPlaying, useLoading } from '../../playback';
import { Artwork } from '../Artwork';
import { Focusable } from '../Focusable';
import { Menu } from '../Menu';
import { useTrackMenu } from '../menus';
import { colors, type } from '../theme';
import { slideFrom, type Slot } from './model';

export type Inks = { title: string; artist: string };

/** The system's music app: 524 pt covers 40 pt apart, the one playing centred. */
export const coverSize = 524;
const stride = coverSize + 40;
const centreLeft = (1920 - coverSize) / 2;
/** With a panel open the cover playing moves to the left, beside it. */
export const sideLeft = 148;
const toSide = sideLeft - centreLeft;
/** How far the covers settle while the controls are away. */
const settleBy = 40;
/** Focus lifts a cover toward the viewer; its words step down out of the way. */
const wordsShift = 16;

type Props = {
  slots: readonly Slot[];
  /** 0 for the carousel, 1 with a panel open: the neighbours fade and the cover moves aside. */
  aside: Animated.Value;
  /** 1 while the controls are away: the covers settle lower. */
  settled: Animated.Value;
  /** The titles and artists, tinted by the cover playing. */
  inks: Inks;
  panelOpen: boolean;
  /** Whether the remote's press counts, or only wakes the faded controls. */
  awake: () => boolean;
  onSelect: (slot: Slot) => void;
};

/**
 * The covers around the song playing: the last ones played to the left, what comes next to the
 * right, each with its title and artist under it. When the song changes the strip slides along
 * to the new one, as the system's music app's does. The song before, the one playing and the
 * next can be focused: selecting one plays it (the one playing plays and pauses), and holding
 * the click opens its menu.
 */
export const Carousel = memo(function Carousel({ slots, aside, settled, inks, panelOpen, awake, onSelect }: Props) {
  const slide = useRef(new Animated.Value(0)).current;
  const appear = useRef(new Animated.Value(1)).current;
  const previous = useRef<readonly Slot[]>(slots);
  const currentId = slots.find(slot => slot.offset === 0)?.entry.id;

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = slots;
    const wasCurrent = before.find(slot => slot.offset === 0)?.entry.id;
    if (!currentId || wasCurrent === currentId) return;
    const from = slideFrom(before, currentId);
    if (from) {
      // The covers are keyed by entry, so each is drawn at its new place: start the strip where they were.
      slide.setValue(from * stride);
      Animated.spring(slide, { toValue: 0, speed: 10, bounciness: 0, useNativeDriver: true }).start();
    } else {
      appear.setValue(0);
      Animated.timing(appear, { toValue: 1, duration: 450, useNativeDriver: true }).start();
    }
  }, [appear, currentId, slide, slots]);

  const shift = Animated.add(slide, aside.interpolate({ inputRange: [0, 1], outputRange: [0, toSide] }));
  const neighbours = aside.interpolate({ inputRange: [0, 0.6], outputRange: [1, 0], extrapolate: 'clamp' });
  const lower = settled.interpolate({ inputRange: [0, 1], outputRange: [0, settleBy] });
  return <Animated.View style={[styles.strip, { opacity: appear, transform: [{ translateX: shift }, { translateY: lower }] }]}>
    {slots.map(slot => <Animated.View key={slot.entry.id}
      style={[styles.slot, { left: centreLeft + slot.offset * stride }, slot.offset !== 0 && { opacity: neighbours }]}>
      <Cover entry={slot.entry} offset={slot.offset} focusable={!panelOpen && Math.abs(slot.offset) <= 1} awake={awake}
        inks={inks} onSelect={onSelect} />
    </Animated.View>)}
  </Animated.View>;
});

const Cover = memo(function Cover({ entry, offset, focusable, awake, inks, onSelect }: {
  entry: QueueEntry;
  offset: number;
  focusable: boolean;
  inks: Inks;
  awake: () => boolean;
  onSelect: (slot: Slot) => void;
}) {
  const track = useTrack(entry.trackId, entry.albumId);
  const menu = useTrackMenu(track);
  const shift = useRef(new Animated.Value(0)).current;
  useEffect(() => () => shift.stopAnimation(), [shift]);
  const current = offset === 0;
  const title = track?.title ?? '';
  const label = [current ? 'Now playing' : offset < 0 ? 'Previous' : 'Next', title, track?.artistCredit].filter(Boolean).join(', ');
  return <Menu actions={menu.actions} onAction={menu.onAction} title={title}>
    <Focusable
      accessibilityLabel={label}
      focusable={focusable}
      onPress={() => { if (awake()) onSelect({ entry, offset }); }}
      scale={1}
      shadow={false}
      onFocusChange={focused => Animated.spring(shift, { toValue: focused ? wordsShift : 0, speed: 18, bounciness: 2, useNativeDriver: true }).start()}
      style={styles.cover}
    >
      <Artwork artwork={track?.album?.artwork} size={coverSize} radius={18} dim={entry.state === 'failed'} />
      {/* The covers at the edges are cut off by the screen; their words would be too. */}
      {Math.abs(offset) <= 1 && <Animated.View style={[styles.words, { transform: [{ translateY: shift }] }]}>
        <View style={styles.titleLine}>
          {current && <NowIndicator color={inks.title} />}
          <Text numberOfLines={1} style={[styles.title, { color: inks.title }]}>{title}</Text>
          {track?.explicit && <Text style={[styles.explicit, { backgroundColor: inks.artist }]}>E</Text>}
        </View>
        <Text numberOfLines={1} style={[styles.artist, { color: inks.artist }]}>{track?.artistCredit ?? ''}</Text>
      </Animated.View>}
    </Focusable>
  </Menu>;
});

const bars = [430, 570, 370, 500];

/**
 * Before the title of the song playing, as in the system's music app: bars that move while it
 * plays, four dots while it is paused, and a spinner while it waits for its audio. The bars
 * hold still while Now Playing is not on screen (the tab stays mounted).
 */
function NowIndicator({ color }: { color: string }) {
  const loading = useLoading();
  const playing = useIsPlaying();
  const onScreen = useIsFocused();
  if (loading !== 'none') return <ActivityIndicator color={color} style={styles.spinner} />;
  if (!playing) return <View style={styles.dots}>{bars.map(ms => <View key={ms} style={[styles.dot, { backgroundColor: color }]} />)}</View>;
  return <View style={styles.bars}>{bars.map(ms => <Bar key={ms} period={ms} color={color} moving={onScreen} />)}</View>;
}

function Bar({ period, color, moving }: { period: number; color: string; moving: boolean }) {
  const level = useRef(new Animated.Value(0.4)).current;
  useEffect(() => {
    if (!moving) return;
    const loop = Animated.loop(Animated.sequence([
      Animated.timing(level, { toValue: 1, duration: period, useNativeDriver: true }),
      Animated.timing(level, { toValue: 0.3, duration: period, useNativeDriver: true }),
    ]));
    loop.start();
    return () => loop.stop();
  }, [level, moving, period]);
  return <Animated.View style={[styles.bar, { backgroundColor: color, transform: [{ scaleY: level }] }]} />;
}

const styles = StyleSheet.create({
  strip: { position: 'absolute', left: 0, top: 170, width: 1920, height: 640 },
  slot: { position: 'absolute', top: 0, width: coverSize },
  cover: { width: coverSize },
  words: { marginTop: 16, alignItems: 'center', gap: 2, paddingHorizontal: 12 },
  titleLine: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, maxWidth: '100%' },
  title: { ...type.body, fontSize: 29, fontWeight: '500', color: 'rgba(255,255,255,0.92)', flexShrink: 1, textAlign: 'center' },
  artist: { ...type.body, fontSize: 29, color: colors.secondary, textAlign: 'center' },
  explicit: { fontSize: 18, fontWeight: '800', color: colors.background, backgroundColor: colors.secondary, borderRadius: 4, paddingHorizontal: 6, overflow: 'hidden' },
  spinner: { transform: [{ scale: 0.8 }] },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 22 },
  bar: { width: 4, height: 22, borderRadius: 1, transformOrigin: 'bottom' },
  dots: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 22, paddingBottom: 2 },
  dot: { width: 4, height: 4, borderRadius: 1 },
});
