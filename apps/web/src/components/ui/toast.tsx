import { X } from 'lucide-react'
import { Toast as ToastPrimitive } from 'radix-ui'
import { useSyncExternalStore } from 'react'
import { createPortal } from 'react-dom'
import { dismissToast, toastStore } from '@/lib/toast'
import { closeTopDialog } from './dialog-stack'

/**
 * Rendered beside the app rather than in it: an open dialog hides everything else from screen
 * readers, but leaves live regions alone, and the toasts it raises ("Browser renamed") must stay
 * reachable. Radix announces each toast itself, so the region stays quiet (`off`).
 */
export function Toaster() {
  return createPortal(<div aria-live="off"><Toasts /></div>, document.body)
}

function Toasts() {
  const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot)
  return (
    <ToastPrimitive.Provider duration={3500} swipeDirection="down">
      {toasts.map(item => (
        <ToastPrimitive.Root
          key={item.id}
          onOpenChange={open => { if (!open) dismissToast(item.id) }}
          // A toast is the newest layer, so it hears Escape before an open dialog would. Unless
          // focus is in the toast, Escape is the dialog's: it closes that, and the toast stays.
          onEscapeKeyDown={event => {
            if (event.target instanceof Element && event.target.closest('[data-toast]')) return
            if (closeTopDialog(event)) event.preventDefault()
          }}
          data-toast=""
          className="flex w-full items-center gap-3 rounded-lg border bg-popover py-2.5 pl-4 pr-2 text-popover-foreground shadow-lg animate-slide-in data-[state=closed]:animate-exit data-[swipe=move]:translate-y-(--radix-toast-swipe-move-y) data-[swipe=end]:animate-exit"
        >
          <div className="min-w-0 flex-1">
            <ToastPrimitive.Title className="text-sm font-medium">{item.title}</ToastPrimitive.Title>
            {item.description && <ToastPrimitive.Description className="mt-0.5 line-clamp-3 text-xs text-muted-foreground">{item.description}</ToastPrimitive.Description>}
          </div>
          {item.action && (
            <ToastPrimitive.Action altText={item.action.label} onClick={item.action.onClick}
              className="h-7 rounded-md px-2 text-xs font-medium text-primary underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring">
              {item.action.label}
            </ToastPrimitive.Action>
          )}
          <ToastPrimitive.Close aria-label="Dismiss" className="flex size-7 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <X className="size-4" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport className="fixed bottom-[calc(var(--player-height,0px)+1rem)] left-1/2 z-[60] flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2 outline-none" />
    </ToastPrimitive.Provider>
  )
}
