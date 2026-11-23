import { X } from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import { createContext, useContext, useEffect, useRef, useState, type ComponentProps, type FormEvent, type ReactNode } from 'react'
import { cn } from '@/lib/utils'
import { Button } from './button'
import { holdsEscape, registerDialog } from './dialog-stack'
import { FormError } from './input'

/**
 * What takes focus back when a dialog closes: what had it as the dialog opened. A menu's item
 * leaves with its menu, so for one the button that opened the menu stands in (for a submenu's
 * item, the outermost menu's button).
 */
function openerOf(element: Element | null): HTMLElement | null {
  let opener = element instanceof HTMLElement && element !== document.body ? element : null
  for (let menu = opener?.closest('[role="menu"]'); opener && menu; menu = opener?.closest('[role="menu"]')) {
    const trigger = document.getElementById(menu.getAttribute('aria-labelledby') ?? '')
    opener = trigger instanceof HTMLElement && trigger !== opener ? trigger : null
  }
  return opener
}

/**
 * What had focus as the dialog opened, read while it renders open: by the time its effects run,
 * focus has often moved in already (a field's `autoFocus` takes it as the dialog mounts), so
 * neither an effect nor Radix's `onOpenAutoFocus` sees the opener every time.
 */
function useOpener(open: boolean | undefined) {
  const [opener, setOpener] = useState(() => (open ? openerOf(document.activeElement) : null))
  const [wasOpen, setWasOpen] = useState(open)
  if (open !== wasOpen) {
    setWasOpen(open)
    if (open) setOpener(openerOf(document.activeElement))
  }
  return opener
}

const OpenerContext = createContext<HTMLElement | null>(null)

/**
 * Gives focus back to what opened the dialog. Radix gives it to the dialog's Trigger, and many
 * dialogs have none (Quick Search from ⌘K, Settings from ⌘, or a menu): focus would fall to the
 * page's body and the next Tab start again from the top. Radix asks where focus goes once the
 * content is gone, after its closing animation, and also when the host unmounts the dialog as it
 * closes; a timer of our own runs too early for the first (focus is still inside, on its way out).
 */
function useCloseAutoFocus(onCloseAutoFocus?: (event: Event) => void) {
  const opener = useContext(OpenerContext)
  return (event: Event) => {
    onCloseAutoFocus?.(event)
    // Without an opener that can take focus, Radix gives it to the Trigger, if there is one.
    if (event.defaultPrevented || !opener?.isConnected || opener.matches(':disabled')) return
    event.preventDefault()
    opener.focus({ preventScroll: true })
  }
}

/** Radix's dialog root, registered while open so a toast's Escape still reaches it. */
export function Dialog({ open, onOpenChange, ...props }: ComponentProps<typeof DialogPrimitive.Root>) {
  const latest = useRef(onOpenChange)
  useEffect(() => { latest.current = onOpenChange })
  useEffect(() => {
    if (!open) return
    // Known to the toaster, which hands this dialog the Escape a toast hears first.
    return registerDialog(() => latest.current?.(false))
  }, [open])
  const opener = useOpener(open)
  return <OpenerContext value={opener}><DialogPrimitive.Root open={open} onOpenChange={onOpenChange} {...props} /></OpenerContext>
}

export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close
export const DialogTitle = DialogPrimitive.Title

export const dialogOverlayClass = 'fixed inset-0 z-50 animate-fade-in bg-black/50 data-[state=closed]:animate-fade-out'
// The width leaves a margin on phones; a caller's `max-w-*` narrows it without undoing that margin.
// The margins grow to the screen's safe area (the page draws under notches and the home bar, with
// `viewport-fit=cover`), the larger inset on both sides since the dialog stays centered. A caller
// sizing the dialog to the screen uses `--dialog-inset-x` and `--dialog-inset-y` the same way.
export const dialogSurfaceClass = 'fixed left-1/2 top-1/2 z-50 [--dialog-inset-x:max(1rem,env(safe-area-inset-left),env(safe-area-inset-right))] [--dialog-inset-y:max(1rem,env(safe-area-inset-top),env(safe-area-inset-bottom))] max-h-[calc(100dvh-var(--dialog-inset-y)*2)] w-[calc(100%-var(--dialog-inset-x)*2)] -translate-x-1/2 -translate-y-1/2 animate-enter rounded-lg border bg-background text-foreground shadow-lg outline-none data-[state=closed]:animate-exit'
// A 32px target; the icon sits where a 16px one would, 24px in from the corner. On a touch
// screen the target reaches 44px past the box, without moving the icon.
export const dialogCloseClass = 'absolute right-2 top-2 flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring pointer-coarse:after:absolute pointer-coarse:after:-inset-1.5 [&_svg]:size-4'

const typesInto = (element: Element | null): element is HTMLElement =>
  element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || (element instanceof HTMLInputElement && !['button', 'checkbox', 'radio', 'range', 'submit', 'reset'].includes(element.type))

/**
 * Keeps the field being typed into in sight while the dialog gets shorter. A phone's keyboard
 * shrinks the viewport after the field took focus, and the dialog (as tall as the viewport allows)
 * shrinks with it, which can leave the focused field below its visible part: the browser scrolls a
 * field into view when it takes focus, not when the space around it changes.
 */
function useFocusedFieldInView() {
  useEffect(() => {
    let frame = 0
    const reveal = () => {
      cancelAnimationFrame(frame)
      // After the layout for the new size.
      frame = requestAnimationFrame(() => {
        const active = document.activeElement
        if (typesInto(active) && active.closest('[role="dialog"]')) active.scrollIntoView({ block: 'nearest' })
      })
    }
    const viewport = window.visualViewport
    window.addEventListener('resize', reveal)
    viewport?.addEventListener('resize', reveal)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', reveal)
      viewport?.removeEventListener('resize', reveal)
    }
  }, [])
}

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
export function DialogContent({ title, description, className, children, onEscapeKeyDown, onCloseAutoFocus, ...props }: DialogContentProps) {
  useFocusedFieldInView()
  const closeAutoFocus = useCloseAutoFocus(onCloseAutoFocus)
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={dialogOverlayClass} />
      <DialogPrimitive.Content
        // Without a description nothing describes it, rather than the title read twice.
        {...(description ? {} : { 'aria-describedby': undefined })}
        onEscapeKeyDown={keepEscapeForSearch(onEscapeKeyDown)}
        onCloseAutoFocus={closeAutoFocus}
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
export function DialogFrame({ className, children, showClose = true, onEscapeKeyDown, onCloseAutoFocus, ...props }: ComponentProps<typeof DialogPrimitive.Content> & { showClose?: boolean }) {
  useFocusedFieldInView()
  const closeAutoFocus = useCloseAutoFocus(onCloseAutoFocus)
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className={dialogOverlayClass} />
      <DialogPrimitive.Content aria-describedby={undefined} onEscapeKeyDown={keepEscapeForSearch(onEscapeKeyDown)} onCloseAutoFocus={closeAutoFocus} className={cn(dialogSurfaceClass, className)} {...props}>
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
