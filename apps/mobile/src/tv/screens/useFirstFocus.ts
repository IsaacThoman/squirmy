import { useCallback, useState } from 'react';

/**
 * Preferred focus for a screen's first focus only. A tile in a list is unmounted as it scrolls
 * out of the list's window and mounted fresh when it comes back, so one that still asked for
 * focus then would pull focus to itself; `Focusable` forgets the request per instance, which a
 * remount undoes. `preferred` stays true until the first focus lands anywhere inside the view
 * given `onFocusCapture`.
 */
export function useFirstFocus() {
  const [placed, setPlaced] = useState(false);
  const onFocusCapture = useCallback(() => setPlaced(true), []);
  return { preferred: !placed, onFocusCapture };
}
