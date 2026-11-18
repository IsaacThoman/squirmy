import { useRouter } from 'expo-router';
import { useRef, type ComponentRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { GestureDetector, usePanGesture } from 'react-native-gesture-handler';
import { useReducedMotion } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { MiniPlayerContent, type MiniPlayerContentProps } from './player/MiniPlayerContent';
import { miniCoverSize, usePlayerOrigin } from './player/PlayerOrigin';

export { MiniPlayerContent };

type BubbleView = ComponentRef<typeof View>;

export function MiniPlayer({ compact = false, native = false }: Pick<MiniPlayerContentProps, 'compact' | 'native'>) {
  const router = useRouter();
  const { origin, miniPull, accessoryInPlayer } = usePlayerOrigin();
  const bubble = useRef<BubbleView>(null);
  const opening = useRef(false);
  const reduceMotion = useReducedMotion();

  const open = (fromPull: boolean) => {
    if (opening.current || accessoryInPlayer.get() || !bubble.current) return;
    opening.current = true;
    bubble.current.measureInWindow((x, y, width, height) => {
      opening.current = false;
      const hasOrigin = width > 0 && height > 0;
      if (fromPull && !hasOrigin) {
        miniPull.set(null);
        return;
      }
      origin.current = hasOrigin
        ? { x, y, width, height, compact, native, fromPull, artworkSize: miniCoverSize(compact, native) }
        : null;
      router.push({ pathname: '/player', params: { fromMini: '1' } });
    });
  };

  const pullUp = usePanGesture({
    activeOffsetY: -8,
    failOffsetY: 10,
    failOffsetX: [-16, 16],
    maxPointers: 1,
    onActivate: (event) => {
      'worklet';
      if (reduceMotion || accessoryInPlayer.value) return;
      miniPull.value = { phase: 'dragging', distance: Math.max(0, -event.translationY) };
      scheduleOnRN(open, true);
    },
    onUpdate: (event) => {
      'worklet';
      if (miniPull.value?.phase !== 'dragging') return;
      miniPull.value = { phase: 'dragging', distance: Math.max(0, -event.translationY) };
    },
    onDeactivate: (event) => {
      'worklet';
      const distance = Math.max(0, -event.translationY);
      const opens = !event.canceled && (distance >= 65 || (distance >= 16 && event.velocityY <= -650));
      if (reduceMotion) {
        if (opens) scheduleOnRN(open, false);
      } else if (miniPull.value?.phase === 'dragging') {
        miniPull.value = opens
          ? { phase: 'open', distance, velocity: Math.max(0, -event.velocityY) }
          : { phase: 'cancel', distance };
      }
    },
  });

  return <GestureDetector gesture={pullUp} touchAction="none">
    <View collapsable={false} style={styles.gestureArea}>
      <MiniPlayerContent compact={compact} native={native} containerRef={bubble}
        onOpen={() => open(false)} onDevices={() => router.push('/devices')} />
    </View>
  </GestureDetector>;
}

const styles = StyleSheet.create({ gestureArea: { flex: 1 } });
