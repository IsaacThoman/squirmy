import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { I18nManager, StyleSheet, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import { SliderBar } from '../../modules/now-playing';
import { startScrub, type Scrub } from './scrub';
import { createThemedStyles, useColors } from '../theme';

type TransportSliderProps = {
  label: string;
  value: number;
  maximum: number;
  accessibilityStep: number;
  valueText?: string;
  onChange: (value: number) => void;
  onPreview?: (value: number | null) => void;
  /** A finger has started or stopped dragging. */
  onScrubbing?: (scrubbing: boolean) => void;
};

/**
 * A thumbless slider, dragged as Apple Music's: the value moves by how far the finger moves,
 * from wherever it was, so touching down never jumps and a tap changes nothing. Past an end
 * the track stretches a little and springs back on release, with a light tap of haptics on
 * arriving at an end. On iOS the track is a native `UISlider`.
 */
export default function TransportSlider({
  label, value, maximum, accessibilityStep, valueText, onChange, onPreview, onScrubbing,
}: TransportSliderProps) {
  const styles = useStyles();
  const colors = useColors();
  const width = useRef(0);
  const scrub = useRef<Scrub | null>(null);
  const fraction = maximum > 0 ? Math.min(1, Math.max(0, value / maximum)) : 0;
  const update = onPreview ?? onChange;
  // As on Apple Music: the track thickens while a finger drags it.
  const [dragging, setDragging] = useState(false);
  const [stretch, setStretch] = useState(0);
  // Declared before the gesture: its callbacks capture what they use when they are made.
  const move = (translation: number) => {
    const point = scrub.current?.move(translation);
    if (!point) return;
    if (point.reachedEnd) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setStretch(point.stretch);
    update(point.value);
  };
  // Only a sideways drag scrubs: one that moves up or down first is someone scrolling, or
  // swiping Now Playing away, and is left to them.
  const drag = usePanGesture({
    runOnJS: true,
    maxPointers: 1,
    activeOffsetX: [-8, 8],
    failOffsetY: [-12, 12],
    onActivate: ({ translationX }) => {
      scrub.current = startScrub(value, width.current, maximum, I18nManager.isRTL);
      setDragging(true);
      onScrubbing?.(true);
      move(translationX);
    },
    onUpdate: ({ translationX }) => move(translationX),
    onDeactivate: ({ canceled }) => {
      const committed = scrub.current?.release(canceled) ?? null;
      scrub.current = null;
      setDragging(false);
      setStretch(0);
      onScrubbing?.(false);
      if (committed !== null) onChange(committed);
      onPreview?.(null);
    },
  });

  return (
    <GestureDetector gesture={drag} touchAction="pan-y">
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(fraction * 100), text: valueText }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={({ nativeEvent: { actionName } }) => {
          if (actionName === 'increment') onChange(Math.min(maximum, value + accessibilityStep));
          if (actionName === 'decrement') onChange(Math.max(0, value - accessibilityStep));
        }}
        onLayout={({ nativeEvent: { layout } }) => { width.current = layout.width; }}
        style={styles.touch}
      >
        {SliderBar
          ? <SliderBar pointerEvents="none" value={fraction} active={dragging} stretch={stretch}
            tint={colors.accent} trackTint={colors.sliderTrack} style={styles.native} />
          : <View pointerEvents="none" style={[styles.track, dragging && styles.trackDragging,
            { marginLeft: Math.min(stretch, 0), marginRight: -Math.max(stretch, 0) }]}>
            <View style={[styles.fill, { width: `${fraction * 100}%` }]} />
          </View>}
      </View>
    </GestureDetector>
  );
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  // A 44pt touch target around a thin track, without taking 44pt of the layout.
  touch: { height: 44, marginVertical: -8, justifyContent: 'center' },
  native: { height: 44 },
  // No thumb: a thin track at rest, the same 6pt as the system volume slider, and 10pt while dragged.
  track: { height: 6, borderRadius: 3, backgroundColor: colors.sliderTrack, overflow: 'hidden' },
  trackDragging: { height: 10, borderRadius: 5 },
  fill: { height: '100%', backgroundColor: colors.accent },
}));
