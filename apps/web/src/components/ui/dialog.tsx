import { X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { useEffect, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from './button'
import { holdsEscape, registerDialog } from './dialog-stack'
import { FormError } from './input'

/** Radix's dialog root, registered while open so a toast's Escape still reaches it. */
export function Dialog({ open, onOpenChange, ...props }: ComponentProps<typeof DialogPrimitive.Root>) {
  const latest = useRef(onOpenChange)
  useEffect(() => { latest.current = onOpenChange })
  useEffect(() => {
    if (!open) return
    // Known to the toaster, which hands this dialog the Escape a toast hears first.
    return registerDialog(() => latest.current?.(false))
  }, [open])
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} {...props} />
}

export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close
export const DialogTitle = DialogPrimitive.Title

export const dialogOverlayClass = 'fixed inset-0 z-50 animate-fade-in bg-black/50 data-[state=closed]:animate-fade-out'
// The width leaves a margin on phones; a caller's `max-w-*` narrows it without undoing that margin.
export const dialogSurfaceClass = 'fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 animate-enter rounded-lg border bg-background text-foreground shadow-lg outline-none data-[state=closed]:animate-exit'
// A 32px target; the icon sits where a 16px one would, 24px in from the corner.
export const dialogCloseClass = 'absolute right-2 top-2 flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4'

/**
 * Escape first clears a search field that has text, as it does outside a dialog; the next one
 * closes. The dialog hears Escape before the field does, so it has to hold back itself.
 */
function keepEscapeForSearch(onEscapeKeyDown?: (event: KeyboardEvent) => void) {
  return (event: KeyboardEvent) => {
    if (holdsEscape(event.target)) event.preventDefault()
    onEscapeKeyDown?.(event)
  }
}


type DialogContentProps = ComponentProps<typeof DialogPrimitive.Content> & {
  title: string
  description?: ReactNode
}

/** A titled dialog. For a custom layout (the settings and search dialogs), use `DialogFrame`. */
export function DialogContent({ title, description, className, children, onEscapeKeyDown, ...props }: DialogContentProps) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={dialogOverlayClass} />
      <DialogPrimitive.Content
        // Without a description nothing describes it, rather than the title read twice.
        {...(description ? {} : { 'aria-describedby': undefined })}
        onEscapeKeyDown={keepEscapeForSearch(onEscapeKeyDown)}
        className={cn(dialogSurfaceClass, 'flex flex-col gap-4 overflow-y-auto p-6 sm:max-w-md', className)}
        {...props}
      >
        <div className="flex flex-col gap-2 pr-6">
          <DialogPrimitive.Title className="text-lg font-semibold leading-none">{title}</DialogPrimitive.Title>
          {description && <DialogPrimitive.Description className="text-sm text-muted-foreground">{description}</DialogPrimitive.Description>}
        </div>
        {children}
        <DialogPrimitive.Close aria-label="Close" className={dialogCloseClass}><X /></DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

/** The dialog surface alone: the caller lays it out and must render a `DialogTitle`. */
export function DialogFrame({ className, children, showClose = true, onEscapeKeyDown, ...props }: ComponentProps<typeof DialogPrimitive.Content> & { showClose?: boolean }) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={dialogOverlayClass} />
      <DialogPrimitive.Content aria-describedby={undefined} onEscapeKeyDown={keepEscapeForSearch(onEscapeKeyDown)} className={cn(dialogSurfaceClass, className)} {...props}>
        {children}
        {showClose && <DialogPrimitive.Close aria-label="Close" className={dialogCloseClass}><X /></DialogPrimitive.Close>}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  )
}

export function DialogFooter({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)} {...props} />
}

type DialogFormProps = {
  onSubmit: () => void
  /** `form` is the failure that belongs to no field, shown above the buttons. */
  errors: { form?: string }
  pending: boolean
  submitLabel: string
  disabled?: boolean
  children: ReactNode
}

/** A dialog's form: its fields, the failure that belongs to no field, then Cancel and submit. */
export function DialogForm({ onSubmit, errors, pending, submitLabel, disabled, children }: DialogFormProps) {
  const submit = (event: FormEvent) => {
    event.preventDefault()
    onSubmit()
  }
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      {children}
      <FormError message={errors.form} />
      <DialogFooter>
        <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
        <Button type="submit" variant="primary" pending={pending} disabled={disabled}>{submitLabel}</Button>
      </DialogFooter>
    </form>
  )
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
          <DialogClose asChild><Button variant="outline">Cancel</Button></DialogClose>
          <Button variant="danger" pending={pending} onClick={() => void confirm()}>{confirmLabel}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
