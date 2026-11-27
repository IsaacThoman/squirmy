import { formatDuration, formatRemaining } from '@squirmy/client-core';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, TVFocusGuideView, useTVEventHandler, View, type TVRemoteEvent } from 'react-native';
import { useCurrentDurationMs, usePlaybackActions, usePositionEvery } from '../../playback';
import { seekLanded } from '../../player/scrub';
import { colors, tv } from '../theme';
import { elapsedLeft, progressOf, seekSettleMs, seekStep, steppedPosition } from './model';

const barWidth = 1920 - tv.gutter * 2;
const barHeight = 14;
/** Resting, the bar is a hairline; focused, it thickens to its full height, as the system's does. */
const restingScale = 0.3;
const timeWidth = 120;

type Props = {
  /** False while the controls are faded away: the first press only brings them back. */
  awake: () => boolean;
  disabled?: boolean;
  /** Ticks only while Now Playing is on screen. */
  live: boolean;
  hasTVPreferredFocus?: boolean;
};

/**
 * The playhead, the only part of Now Playing that changes with the clock, so the only part that
 * re-renders four times a second. Focused, left and right on the remote move the playhead ten
 * seconds a press (thirty while held), and playback follows once the presses stop; select plays
 * and pauses, as in the system's players.
 */
export const Scrubber = memo(function Scrubber({ awake, disabled, live, hasTVPreferredFocus }: Props) {
  const position = usePositionEvery(250, live);
  const duration = useCurrentDurationMs();
  const actions = usePlaybackActions();
  const [focused, setFocused] = useState(false);
  // Where the remote has moved the playhead, before playback seeks there.
  const [preview, setPreview] = useState<number | null>(null);
  // Where playback was sent, shown until it reports a position near it.
  const [landing, setLanding] = useState<number | null>(null);
  const settle = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const thickness = useRef(new Animated.Value(restingScale)).current;
  const seekable = !disabled && duration > 0;

  useEffect(() => {
    if (landing !== null && seekLanded(position, landing)) setLanding(null);
  }, [landing, position]);
  // A seek that never lands (refused, or another device gone) lets the clock show again.
  useEffect(() => {
    if (landing === null) return;
    const timer = setTimeout(() => setLanding(null), 4000);
    return () => clearTimeout(timer);
  }, [landing]);
  useEffect(() => () => clearTimeout(settle.current), []);
  useEffect(() => {
    Animated.spring(thickness, { toValue: focused ? 1 : restingScale, speed: 20, bounciness: 2, useNativeDriver: true }).start();
  }, [focused, thickness]);

  const shown = preview ?? landing ?? position;
  const latest = useRef({ shown, seekable, duration, focused, actions });
  latest.current = { shown, seekable, duration, focused, actions };

  const commit = useCallback((to: number) => {
    clearTimeout(settle.current);
    setPreview(null);
    setLanding(to);
    latest.current.actions.seek(to);
  }, []);

  useTVEventHandler(useCallback((event: TVRemoteEvent) => {
    const { focused: on, seekable: can, shown: from, duration: length } = latest.current;
    if (!on || !can || !awake()) return;
    const step = seekStep(event.eventType);
    if (step === null) return;
    // A tap reports once, when it ends; a hold reports when it begins and again when it ends.
    const held = event.eventType.startsWith('long');
    const action = String(event.eventKeyAction);
    if (held ? action !== '0' : action === '0') return;
    const to = steppedPosition(from, step, length);
    setPreview(to);
    clearTimeout(settle.current);
    settle.current = setTimeout(() => commit(to), seekSettleMs);
  }, [awake, commit]));

  const select = () => {
    if (!awake()) return;
    if (preview !== null) return commit(preview);
    actions.playPause();
  };

  const progress = progressOf(shown, duration);
  const elapsed = formatDuration(Math.min(shown, duration || shown));
  return <TVFocusGuideView trapFocusLeft trapFocusRight style={styles.guide}>
    <Pressable
      accessibilityRole="adjustable"
      accessibilityLabel="Track position"
      accessibilityValue={{ text: `${elapsed} of ${formatDuration(duration)}` }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={({ nativeEvent }) => {
        if (!seekable) return;
        commit(steppedPosition(shown, nativeEvent.actionName === 'increment' ? 10_000 : -10_000, duration));
      }}
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocus={() => setFocused(true)}
      onBlur={() => {
        setFocused(false);
        if (preview !== null) commit(preview);
      }}
      onPress={select}
      tvParallaxProperties={{ enabled: false }}
      style={styles.hit}
    >
      <Animated.View style={[styles.bar, { transform: [{ scaleY: thickness }] }]}>
        <View style={[styles.fill, focused && styles.fillFocused, { width: `${progress * 100}%` }]} />
      </Animated.View>
      <View style={[styles.playhead, { left: progress * barWidth - 1.5 }, preview !== null && styles.playheadMoving]} />
      <View style={styles.times}>
        <Text style={[styles.time, focused && styles.timeFocused, { left: elapsedLeft(progress, barWidth, timeWidth) }]}>{elapsed}</Text>
        <Text style={[styles.time, styles.remaining, focused && styles.timeFocused]}>{duration > 0 ? formatRemaining(shown, duration) : ''}</Text>
      </View>
    </Pressable>
  </TVFocusGuideView>;
});

const styles = StyleSheet.create({
  guide: { width: barWidth, alignSelf: 'center' },
  hit: { width: barWidth, height: 70, paddingTop: 14 },
  bar: { height: barHeight, borderRadius: barHeight / 2, backgroundColor: 'rgba(255,255,255,0.2)', overflow: 'hidden' },
  fill: { position: 'absolute', left: 0, top: 0, bottom: 0, backgroundColor: 'rgba(255,255,255,0.32)' },
  fillFocused: { backgroundColor: 'rgba(255,255,255,0.72)' },
  playhead: { position: 'absolute', top: 14 - 3, width: 3, height: barHeight + 6, borderRadius: 1.5, backgroundColor: colors.text },
  playheadMoving: { backgroundColor: colors.accent },
  times: { height: 34, marginTop: 10 },
  time: { position: 'absolute', top: 0, width: timeWidth, textAlign: 'center', fontSize: 25, fontWeight: '600', color: colors.secondary, fontVariant: ['tabular-nums'] },
  remaining: { right: 0, textAlign: 'right' },
  timeFocused: { color: colors.text },
});
