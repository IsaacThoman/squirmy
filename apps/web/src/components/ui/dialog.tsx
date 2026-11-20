import { X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useState, type ComponentProps, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from './button'
import { IconButton } from './icon-button'

export const Dialog = DialogPrimitive.Root
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

type DialogContentProps = ComponentProps<typeof DialogPrimitive.Content> & {
  title: string
  description?: ReactNode
}

export function DialogContent({ title, description, className, children, ...props }: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="fixed inset-0 z-50 animate-fade-in bg-black/40 backdrop-blur-[2px] data-[state=closed]:animate-exit" />
      <DialogPrimitive.Content
        className={cn('fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 flex-col gap-5 overflow-y-auto rounded-3xl bg-sheet p-6 shadow-float focus:outline-none', className)}
        {...props}
      >
        <div className="flex items-start gap-4 animate-enter">
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <DialogPrimitive.Title className="text-xl font-bold tracking-tight">{title}</DialogPrimitive.Title>
            {description
              ? <DialogPrimitive.Description className="text-sm leading-relaxed text-muted">{description}</DialogPrimitive.Description>
              : <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>}
          </div>
          <DialogPrimitive.Close asChild><IconButton label="Close" tooltip={false} size="sm" className="-mr-2 -mt-1"><X /></IconButton></DialogPrimitive.Close>
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-wrap justify-end gap-2 pt-1', className)} {...props} />
}

type ConfirmDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirmLabel: string
  /** Closes the dialog once it resolves; a rejection keeps it open. */
  onConfirm: () => Promise<unknown>
}

/** Asks before something that cannot be undone. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel, onConfirm }: ConfirmDialogProps) {
  const [pending, setPending] = useState(false)
  const confirm = async () => {
    setPending(true)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch {
      // The caller reports the failure; the dialog stays so it can be retried.
    } finally {
      setPending(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={title} description={description}>
        <DialogFooter>
          <DialogClose asChild><Button variant="ghost">Cancel</Button></DialogClose>
          <Button variant="danger" pending={pending} onClick={() => void confirm()}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
