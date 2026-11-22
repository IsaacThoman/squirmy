import { useState } from 'react';
import { useAnimatedReaction } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { usePlayerTransition } from './transition';

/**
 * Whether Now Playing is on screen: true from the moment it starts to open until it is
 * back in the mini-player. What only it shows, such as its clock, can stop meanwhile.
 */
export function usePlayerShown(): boolean {
  const { motion } = usePlayerTransition();
  const [shown, setShown] = useState(() => motion.active.get());
  useAnimatedReaction(() => motion.active.value, (now, before) => {
    if (now !== before) scheduleOnRN(setShown, now);
  });
  return shown;
}
