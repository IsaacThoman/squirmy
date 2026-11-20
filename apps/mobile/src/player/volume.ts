import { useEffect, useRef, useState } from 'react';

/** Volume commands while a slider is dragged go out at most this often. */
const intervalMs = 150;

/**
 * A volume slider's value: what the finger sets while it drags, the session's otherwise.
 * Changes reach `send` at a steady pace and the last one always arrives.
 */
export function useVolumeSlider(value: number, send: (value: number) => void) {
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef(value);
  const sender = useRef(send);
  sender.current = send;
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);
  const change = (next: number) => {
    latest.current = next;
    setDraft(next);
    if (timer.current) return;
    sender.current(next);
    timer.current = setTimeout(() => {
      timer.current = null;
      sender.current(latest.current);
      setDraft(null);
    }, intervalMs);
  };
  return [draft ?? value, change] as const;
}
