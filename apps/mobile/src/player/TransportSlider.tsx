import { useRef } from 'react';
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
  const drag = usePanGesture({
    runOnJS: true,
    maxPointers: 1,
    onActivate: ({ x }) => update(positionAt(x)),
    onUpdate: ({ x }) => update(positionAt(x)),
    onDeactivate: ({ x, canceled }) => {
      if (!canceled) onChange(positionAt(x));
      onPreview?.(null);
    },
  });
  const tap = useTapGesture({
    runOnJS: true,
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
        <View pointerEvents="none" style={styles.track}>
          <View style={[styles.fill, { width: `${percent}%` }]} />
        </View>
      </View>
    </GestureDetector>
  );
}

const useStyles = createThemedStyles(colors => StyleSheet.create({
  // A 44pt touch target around a thin track, without taking 44pt of the layout.
  touch: { height: 44, marginVertical: -8, justifyContent: 'center' },
  track: { height: 6, borderRadius: 3, backgroundColor: colors.stroke, overflow: 'hidden' },
  fill: { height: '100%', borderRadius: 3, backgroundColor: colors.accent },
}));
