import { useRef, type MouseEvent, type PointerEvent } from 'react'

/** How far a finger may move between touching a menu's button and lifting off for it still to be a tap. */
const TAP_SLOP_PX = 10

/**
 * Radix opens a dropdown as soon as the pointer goes down, which a mouse wants. A finger going
 * down may be starting to scroll the page or a rail (a card's or a row's ⋯ is always shown on a
 * touch screen), so a touch or a pen opens the menu on its tap instead: the browser sends no
 * click for a gesture it scrolled with, and one that moved further than a tap is not one either.
 * Keyboard (Enter, Space, ArrowDown) and mouse are left to Radix.
 */
export function useTapToOpen(open: boolean, onOpenChange: (open: boolean) => void) {
  const start = useRef<{ x: number; y: number; open: boolean } | null>(null)
  return {
    onPointerDown: (event: PointerEvent) => {
      start.current = null
      if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
      // Whether it was open: a tap that closes it (from outside) does not open it again.
      start.current = { x: event.clientX, y: event.clientY, open }
      // Stops Radix opening the menu now. It does not stop the browser scrolling.
      event.preventDefault()
    },
    onPointerCancel: () => { start.current = null },
    onClick: (event: MouseEvent) => {
      const from = start.current
      start.current = null
      if (!from || Math.hypot(event.clientX - from.x, event.clientY - from.y) > TAP_SLOP_PX) return
      onOpenChange(!from.open)
    },
  }
}

