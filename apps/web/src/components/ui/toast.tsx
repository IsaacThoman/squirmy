import { X } from 'lucide-react'
import { Toast as ToastPrimitive } from 'radix-ui'
import { useSyncExternalStore } from 'react'
import { dismissToast, toastStore } from '@/lib/toast'

export function Toaster() {
  const toasts = useSyncExternalStore(toastStore.subscribe, toastStore.getSnapshot)
  return (
    <ToastPrimitive.Provider duration={3500} swipeDirection="down">
      {toasts.map(item => (
        <ToastPrimitive.Root
          key={item.id}
          onOpenChange={open => { if (!open) dismissToast(item.id) }}
          className="flex w-full items-center gap-3 rounded-2xl bg-foreground py-3 pl-4 pr-2 text-background shadow-float animate-slide-in data-[state=closed]:animate-exit data-[swipe=move]:translate-y-(--radix-toast-swipe-move-y) data-[swipe=end]:animate-exit"
        >
          <div className="min-w-0 flex-1">
            <ToastPrimitive.Title className="text-sm font-semibold">{item.title}</ToastPrimitive.Title>
            {item.description && <ToastPrimitive.Description className="mt-0.5 text-[13px] opacity-75">{item.description}</ToastPrimitive.Description>}
          </div>
          {item.action && (
            <ToastPrimitive.Action altText={item.action.label} onClick={item.action.onClick}
              className="h-8 rounded-full px-3 text-[13px] font-bold text-background underline-offset-2 hover:underline">
              {item.action.label}
            </ToastPrimitive.Action>
          )}
          <ToastPrimitive.Close aria-label="Dismiss" className="flex size-8 items-center justify-center rounded-full opacity-70 transition hover:bg-background/15 hover:opacity-100">
            <X className="size-4" />
          </ToastPrimitive.Close>
        </ToastPrimitive.Root>
      ))}
      <ToastPrimitive.Viewport className="fixed bottom-[calc(var(--player-height,0px)+1rem)] left-1/2 z-[60] flex w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2 outline-none" />
    </ToastPrimitive.Provider>
  )
}
