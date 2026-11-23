import { useCallback, useEffect, useRef, useState } from 'react';
import { AccessibilityInfo } from 'react-native';

/**
 * The app has no toasts: what happened shows on the control or the screen where it happened.
 * A failure shown that way stays this long, then the control goes back to how it was.
 */
export const failureShownMs = 8000;

/** Says `text` to VoiceOver (TalkBack), for a change that shows only on screen. */
export function announce(text: string) {
  AccessibilityInfo.announceForAccessibility(text);
}

/**
 * Failures shown inline for a few seconds, by key: a heart the server refused, a radio that
 * didn't start. `fail` shows one (again) for `ms`; `drop` takes it away at once, as the next
 * try does.
 */
export function useBriefFailures<V>(ms = failureShownMs) {
  const [failures, setFailures] = useState<ReadonlyMap<string, V>>(() => new Map());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const running = timers.current;
    return () => running.forEach(clearTimeout);
  }, []);
  const drop = useCallback((key: string) => {
    clearTimeout(timers.current.get(key));
    timers.current.delete(key);
    setFailures(current => {
      if (!current.has(key)) return current;
      const next = new Map(current);
      next.delete(key);
      return next;
    });
  }, []);
  const fail = useCallback((key: string, value: V) => {
    clearTimeout(timers.current.get(key));
    timers.current.set(key, setTimeout(() => drop(key), ms));
    setFailures(current => new Map(current).set(key, value));
  }, [drop, ms]);
  return { failures, fail, drop };
}
