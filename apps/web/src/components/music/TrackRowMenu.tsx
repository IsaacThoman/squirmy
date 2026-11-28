import { MoreHorizontal } from 'lucide-react'
import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react'
import { IconButton } from '@/components/ui/icon-button'
import { AnchoredMenu, type MenuEntry } from '@/components/ui/menu'
import { useTapToOpen } from '@/components/ui/use-tap-to-open'

type Opening = {
  anchor: { getBoundingClientRect: () => DOMRect }
  context: boolean
  keyboard: boolean
  opener: HTMLElement | null
}

/**
 * The button and row remain focusable and draggable while their menu is dormant. `longPress:
 * false` leaves a long press to the row (the queue's, where it picks the song up).
 */
export function useTrackRowMenu({ longPress = true }: { longPress?: boolean } = {}) {
  const id = useId()
  const button = useRef<HTMLButtonElement>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [opening, setOpening] = useState<Opening | null>(null)
  const [open, setOpen] = useState(false)
  const clearPress = () => clearTimeout(timer.current)
  useEffect(() => () => clearTimeout(timer.current), [])

  const showButtonMenu = (keyboard: boolean) => {
    const anchor = button.current
    if (!anchor) return
    setOpening({ anchor, context: false, keyboard, opener: anchor })
    setOpen(true)
  }
  const showContextMenu = (x: number, y: number, keyboard = false) => {
    const opener = document.activeElement
    setOpening({
      anchor: { getBoundingClientRect: () => new DOMRect(x, y, 0, 0) },
      context: true,
      keyboard,
      opener: opener instanceof HTMLElement && opener !== document.body ? opener : button.current,
    })
    setOpen(true)
  }
  const tap = useTapToOpen(open, next => {
    if (next) showButtonMenu(false)
    else setOpen(false)
  })
  const rowProps = {
    'data-state': open && opening?.context ? 'open' : undefined,
    onContextMenu: (event: MouseEvent<HTMLElement>) => {
      // A control inside the row that took the press (a song being dragged in the queue) keeps it.
      if (!event.currentTarget.contains(event.target as Node) || event.defaultPrevented) return
      clearPress()
      event.preventDefault()
      showContextMenu(event.clientX, event.clientY)
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      if (!event.currentTarget.contains(event.target as Node) || event.defaultPrevented) return
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return
      event.preventDefault()
      const anchor = (event.target as HTMLElement).getBoundingClientRect()
      showContextMenu(anchor.left, anchor.bottom, true)
    },
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      clearPress()
      if (!longPress || !event.currentTarget.contains(event.target as Node) || event.defaultPrevented) return
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
      const { clientX, clientY } = event
      // Match the long press of the app's other context menus. A moving finger scrolls.
      timer.current = setTimeout(() => showContextMenu(clientX, clientY), 700)
    },
    onPointerUp: clearPress,
    onPointerMove: clearPress,
    onPointerCancel: clearPress,
  }

  const trigger = (title: string, className: string) => (
    <IconButton
      ref={button}
      label={`More options for ${title}`}
      tooltip={false}
      size="sm"
      className={className}
      aria-haspopup="menu"
      aria-expanded={open && !opening?.context}
      aria-controls={open && !opening?.context ? id : undefined}
      data-state={open && !opening?.context ? 'open' : undefined}
      onPointerDown={event => {
        tap.onPointerDown(event)
        if (event.defaultPrevented || event.button !== 0 || event.ctrlKey) return
        if (open) setOpen(false)
        else showButtonMenu(false)
        if (!open) event.preventDefault()
      }}
      onPointerCancel={tap.onPointerCancel}
      onClick={event => {
        if (event.detail === 0) showButtonMenu(true)
        else tap.onClick(event)
      }}
      onKeyDown={event => {
        if (!['Enter', ' ', 'ArrowDown'].includes(event.key)) return
        event.preventDefault()
        if (open && event.key !== 'ArrowDown') setOpen(false)
        else showButtonMenu(true)
      }}
    >
      <MoreHorizontal />
    </IconButton>
  )
  const renderMenu = (entries: () => MenuEntry[]) => opening && (
    <AnchoredMenu
      id={id}
      entries={entries()}
      open={open}
      onOpenChange={setOpen}
      anchor={opening.anchor}
      context={opening.context}
      keyboard={opening.keyboard}
      onCloseAutoFocus={event => {
        event.preventDefault()
        opening.opener?.focus({ preventScroll: true })
        setOpening(null)
      }}
    />
  )

  return { rowProps, trigger, renderMenu, present: opening !== null }
}
