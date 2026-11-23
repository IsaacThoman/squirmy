import { useRef, useState } from 'react';
import { I18nManager, StyleSheet, View } from 'react-native';
import { GestureDetector, useCompetingGestures, usePanGesture, useTapGesture } from 'react-native-gesture-handler';
import { createThemedStyles } from '../theme';

type TransportSliderProps = {
  label: string;
  value: number;
  maximum: number;
  accessibilityStep: number;
  valueText?: string;
  onChange: (value: number) => void;
  onPreview?: (value: number | null) => void;
};

export default function TransportSlider({
  label, value, maximum, accessibilityStep, valueText, onChange, onPreview,
}: TransportSliderProps) {
  const styles = useStyles();
  const width = useRef(0);
  const percent = maximum > 0 ? (value / maximum) * 100 : 0;
  const positionAt = (x: number) => {
    if (!width.current) return value;
    const fraction = Math.min(1, Math.max(0, x / width.current));
    return (I18nManager.isRTL ? 1 - fraction : fraction) * maximum;
  };
  const update = onPreview ?? onChange;
  // As on Apple Music: the track thickens while a finger drags it.
  const [dragging, setDragging] = useState(false);
  // Only a sideways drag scrubs: one that moves up or down first is someone scrolling or
  // reaching past the bar, and with no thumb to grab it would jump to wherever the finger was.
  const drag = usePanGesture({
    runOnJS: true,
    maxPointers: 1,
    activeOffsetX: [-8, 8],
    failOffsetY: [-12, 12],
    onActivate: ({ x }) => {
      setDragging(true);
      update(positionAt(x));
    },
    onUpdate: ({ x }) => update(positionAt(x)),
    onDeactivate: ({ x, canceled }) => {
      setDragging(false);
      if (!canceled) onChange(positionAt(x));
      onPreview?.(null);
    },
  });
  // A touch that wanders off is not a tap either, so a vertical drag that the pan let go of does not seek when it lifts.
  const tap = useTapGesture({
    runOnJS: true,
    maxDistance: 10,
    onDeactivate: ({ x, canceled }) => {
      if (!canceled) onChange(positionAt(x));
    },
  });
  const gesture = useCompetingGestures(drag, tap);

  return (
    <GestureDetector gesture={gesture} touchAction="none">
      <View
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ min: 0, max: 100, now: Math.round(percent), text: valueText }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={({ nativeEvent: { actionName } }) => {
          if (actionName === 'increment') onChange(Math.min(maximum, value + accessibilityStep));
          if (actionName === 'decrement') onChange(Math.max(0, value - accessibilityStep));
        }}
        onLayout={({ nativeEvent: { layout } }) => { width.current = layout.width; }}
        style={styles.touch}
      >
        <View pointerEvents="none" style={[styles.track, dragging && styles.trackDragging]}>
          <View style={[styles.fill, { width: `${percent}%` }]} />
        </View>
      </View>
    </GestureDetector>
  );
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  // A 44pt touch target around a thin track, without taking 44pt of the layout.
  touch: { height: 44, marginVertical: -8, justifyContent: 'center' },
  // No thumb: a thin track at rest, the same 6pt as the system volume slider beside it, and 10pt while dragged.
  track: { height: 6, borderRadius: 3, backgroundColor: colors.sliderTrack, overflow: 'hidden' },
  trackDragging: { height: 10, borderRadius: 5 },
  fill: { height: '100%', borderRadius: 5, backgroundColor: colors.accent },
}));
