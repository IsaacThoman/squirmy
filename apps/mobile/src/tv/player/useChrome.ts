import { useCallback, useEffect, useRef, useState } from 'react';
import { Animated, useTVEventHandler, type TVRemoteEvent } from 'react-native';
import { idleAfterMs, type Chrome } from './model';

/** A press this soon after the controls came back only brought them back. */
const wakeGraceMs = 350;

export type ChromeMotion = {
  /** What is on screen now; changes rarely, so it is state. */
  chrome: Chrome;
  /** The controls rows: shown only while `chrome` is `shown`. */
  controls: Animated.Value;
  /** The scrubber: hidden only when idle. */
  scrubber: Animated.Value;
  /** 1 while idle: the covers settle lower into the space the controls left. */
  settled: Animated.Value;
  /** Whether a press should act, or only bring the controls back. */
  awake: () => boolean;
  /** Menu's first press: the controls go, the scrubber stays. */
  hide: () => void;
};

/**
 * The controls of Now Playing come and go as the system's music app's do. After `idleAfterMs`
 * without a press while `idle` is allowed (music playing), everything but the covers and titles
 * fades and the covers settle lower; Menu hides the controls but leaves the scrubber. Any press
 * brings everything back, and that press does nothing else (`awake`). All of it on the native driver.
 */
export function useChrome(idle: boolean): ChromeMotion {
  const [chrome, setChrome] = useState<Chrome>('shown');
  const controls = useRef(new Animated.Value(1)).current;
  const scrubber = useRef(new Animated.Value(1)).current;
  const settled = useRef(new Animated.Value(0)).current;
  const now = useRef<Chrome>('shown');
  const wokeAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const allowed = useRef(idle);
  allowed.current = idle;

  const show = useCallback((next: Chrome) => {
    if (now.current === next) return;
    now.current = next;
    setChrome(next);
    const duration = next === 'shown' ? 250 : 800;
    Animated.parallel([
      Animated.timing(controls, { toValue: next === 'shown' ? 1 : 0, duration, useNativeDriver: true }),
      Animated.timing(scrubber, { toValue: next === 'idle' ? 0 : 1, duration, useNativeDriver: true }),
      Animated.spring(settled, { toValue: next === 'idle' ? 1 : 0, speed: 6, bounciness: 0, useNativeDriver: true }),
    ]).start();
  }, [controls, scrubber, settled]);

  const restart = useCallback(() => {
    clearTimeout(timer.current);
    if (!allowed.current) return;
    timer.current = setTimeout(() => { if (allowed.current) show('idle'); }, idleAfterMs);
  }, [show]);

  const wake = useCallback(() => {
    if (now.current !== 'shown') {
      wokeAt.current = Date.now();
      show('shown');
    }
    restart();
  }, [restart, show]);

  // Menu is the one press that does not bring them back: its first press is what hides them.
  useTVEventHandler(useCallback((event: TVRemoteEvent) => { if (event.eventType !== 'menu') wake(); }, [wake]));

  // Paused, or with the queue open, the controls come back and stay; playing again starts the count.
  useEffect(() => {
    if (idle) restart();
    else if (now.current === 'idle') wake();
    else clearTimeout(timer.current);
  }, [idle, restart, wake]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const awake = useCallback(() => now.current === 'shown' && Date.now() - wokeAt.current > wakeGraceMs, []);
  const hide = useCallback(() => {
    clearTimeout(timer.current);
    show('menu');
  }, [show]);
  return { chrome, controls, scrubber, settled, awake, hide };
}
