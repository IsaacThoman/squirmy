import { useRouter } from 'expo-router';
import { useRef } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { GestureDetector, useCompetingGestures, usePanGesture } from 'react-native-gesture-handler';
import { measure, useAnimatedRef, useReducedMotion, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';
import { MiniPlayerContent, type MiniPlayerContentProps } from './player/MiniPlayerContent';
import { useSkipSwipe } from './player/SwipeTitles';
import { grab, miniCoverSize, present, settle, travel, usePlayerTransition } from './player/transition';

export { MiniPlayerContent };

export function MiniPlayer({ compact = false, native = false }: Pick<MiniPlayerContentProps, 'compact' | 'native'>) {
  const router = useRouter();
  const { motion, registerBubble } = usePlayerTransition();
  const bubble = useAnimatedRef<View>();
  const reduceMotion = useReducedMotion();
  const pulling = useSharedValue(false);
  const pullStart = useSharedValue(0);
  const startLead = useSharedValue(0);
  const startFollow = useSharedValue(0);
  const coverSize = miniCoverSize(compact, native);
  const coverInset = compact ? 10 : 12;

  const locate = () => {
    'worklet';
    const frame = measure(bubble);
    if (!frame || frame.width <= 0 || frame.height <= 0) return null;
    return { x: frame.pageX, y: frame.pageY, width: frame.width, height: frame.height, coverSize, coverInset, compact };
  };

  const expand = () => {
    'worklet';
    if (!motion.active.value) present(motion, reduceMotion ? null : locate());
    settle(motion, true);
  };
  const open = () => scheduleOnUI(expand);
  // A touch that became a pull or a swipe is not also a tap on the bubble.
  const moved = useRef(false);
  const markMoved = () => { moved.current = true; };
  const resetMoved = () => { moved.current = false; };
  const tap = () => {
    if (!moved.current) open();
  };
  const swipe = useSkipSwipe(motion, markMoved);

  const pullUp = usePanGesture({
    activeOffsetY: -8,
    failOffsetY: 10,
    failOffsetX: [-16, 16],
    maxPointers: 1,
    onBegin: () => {
      'worklet';
      scheduleOnRN(resetMoved);
    },
    onActivate: (event) => {
      'worklet';
      scheduleOnRN(markMoved);
      if (reduceMotion || motion.expanding.value) return;
      if (!motion.active.value) {
        const frame = locate();
        if (!frame) return;
        present(motion, frame);
      } else if (!motion.bubble.value) {
        return;
      }
      grab(motion);
      startLead.value = motion.lead.value;
      startFollow.value = motion.follow.value;
      pullStart.value = event.translationY;
      pulling.value = true;
    },
    onUpdate: (event) => {
      'worklet';
      const frame = motion.bubble.value;
      if (!pulling.value || !frame) return;
      const moved = (pullStart.value - event.translationY) / travel(frame);
      motion.lead.value = Math.min(1, Math.max(0, startLead.value + moved));
      motion.follow.value = Math.min(1, Math.max(0, startFollow.value + moved));
    },
    onDeactivate: (event) => {
      'worklet';
      const distance = Math.max(0, -event.translationY);
      const opens = !event.canceled && event.velocityY < 300 && (distance >= 60 || event.velocityY <= -500);
      if (pulling.value) {
        pulling.value = false;
        const frame = motion.bubble.value;
        settle(motion, opens, frame ? -event.velocityY / travel(frame) : 0);
      } else if (reduceMotion && opens) {
        expand();
      }
    },
  });

  const onLayout = (event: LayoutChangeEvent) => {
    const { width, height } = event.nativeEvent.layout;
    registerBubble({ compact, native, width, height });
    // Keep the way back accurate if the bubble moves while the player covers it.
    scheduleOnUI(() => {
      'worklet';
      const target = motion.bubble.value;
      if (!motion.active.value || !target || target.compact !== compact) return;
      const frame = locate();
      if (frame) motion.bubble.value = frame;
    });
  };

  // Up opens Now Playing, sideways changes the song: whichever the finger commits to first.
  const gesture = useCompetingGestures(pullUp, swipe.gesture);

  return <GestureDetector gesture={gesture} touchAction="none">
    <View collapsable={false} style={styles.gestureArea} onLayout={onLayout}>
      <MiniPlayerContent compact={compact} native={native} containerRef={bubble}
        swipe={swipe} onOpen={tap} onDevices={() => router.push('/devices')} />
    </View>
  </GestureDetector>;
}

const styles = StyleSheet.create({ gestureArea: { flex: 1 } });
