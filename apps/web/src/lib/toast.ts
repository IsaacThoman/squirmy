export type ToastMessage = { id: number; title: string; description?: string; action?: { label: string; onClick: () => void } }

let toasts: ToastMessage[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/** Shows a short confirmation at the bottom of the screen. A message already showing is not repeated. */
export function toast(message: Omit<ToastMessage, 'id'>) {
  if (toasts.some(item => item.title === message.title && item.description === message.description)) return
  toasts = [...toasts, { ...message, id: nextId++ }]
  emit()
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
