/**
 * The open dialogs' close functions, the newest last. Radix gives Escape to the newest layer
 * only, and a toast raised while a dialog is open ("Browser renamed") is one: the toaster hands
 * Escape on to the dialog with `closeTopDialog`, so the toast never stands in its way.
 */
const openDialogs: (() => void)[] = []

/** Adds an open dialog; the returned function takes it off again. */
export function registerDialog(close: () => void): () => void {
  openDialogs.push(close)
  return () => { openDialogs.splice(openDialogs.indexOf(close), 1) }
}

/** Closes the newest open dialog for an Escape a toast heard instead of it. False when none is open. */
export function closeTopDialog(event: KeyboardEvent): boolean {
  const close = openDialogs.at(-1)
  if (!close) return false
  // As in the dialog itself: a search field with text clears first.
  if (!holdsEscape(event.target)) close()
  return true
}

/** A search field with text takes Escape to clear itself before a dialog may close. */
export const holdsEscape = (target: EventTarget | null) => target instanceof HTMLInputElement && target.type === 'search' && Boolean(target.value)
