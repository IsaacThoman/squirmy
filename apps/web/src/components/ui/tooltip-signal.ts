/**
 * Closes every open tooltip. A layer that opens over the page (Now Playing, a dialog) can open
 * without the pointer leaving the control it rests on: scrolled open from the player bar, say,
 * the heart's tooltip would otherwise stay on top of it, since the pointer never left the heart.
 */
const listeners = new Set<() => void>()

export function closeTooltips() {
  for (const close of listeners) close()
}

/** For `Tooltip`: called when every tooltip should close. Returns the unsubscribe. */
export function onCloseTooltips(close: () => void): () => void {
  listeners.add(close)
  return () => { listeners.delete(close) }
}
