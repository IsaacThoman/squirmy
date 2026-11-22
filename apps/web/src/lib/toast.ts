/**
 * `key`: a toast with the same key that is still showing is replaced in place rather than
 * joined by another; `revision` counts the replacements.
 */
export type ToastMessage = { id: number; key?: string; revision?: number; title: string; description?: string; action?: { label: string; onClick: () => void } }

let toasts: ToastMessage[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/**
 * Shows a short confirmation at the bottom of the screen and answers its id, for `dismissToast`.
 * A message with the `key` of one showing replaces it; a message already showing is not
 * repeated, and its id is answered instead.
 */
export function toast(message: Omit<ToastMessage, 'id' | 'revision'>): number {
  const keyed = message.key === undefined ? undefined : toasts.find(item => item.key === message.key)
  if (keyed) {
    toasts = toasts.map(item => (item === keyed ? { ...message, id: item.id, revision: (item.revision ?? 0) + 1 } : item))
    emit()
    return keyed.id
  }
  const showing = toasts.find(item => item.title === message.title && item.description === message.description)
  if (showing) return showing.id
  const id = nextId++
  toasts = [...toasts, { ...message, id }]
  emit()
  return id
}

export function dismissToast(id: number) {
  toasts = toasts.filter(item => item.id !== id)
  emit()
}

export const toastStore = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => listeners.delete(listener)
  },
  getSnapshot: () => toasts,
}
