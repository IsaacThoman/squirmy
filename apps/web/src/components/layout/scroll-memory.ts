import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router'

/**
 * Where each history entry was scrolled to, by location key. The page scrolls in the shell's
 * own container rather than the window, so the browser's restoration never applies and Back
 * would always land at the top. Kept for the tab's session, so a reload keeps them too.
 */
const STORAGE_KEY = 'squirmy.scroll'
const KEPT = 100
let positions: Map<string, number> | null = null

function saved(): Map<string, number> {
  if (positions) return positions
  positions = new Map()
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]')
    if (Array.isArray(stored)) for (const entry of stored) if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') positions.set(entry[0], entry[1])
  } catch {
    // Storage can be off (a private window); positions then last until the tab reloads.
  }
  return positions
}

function remember(key: string, top: number) {
  const map = saved()
  map.delete(key)
  map.set(key, top)
  // The oldest entries go first: the history they belong to is far behind.
  while (map.size > KEPT) map.delete(map.keys().next().value!)
}

function store() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...saved()]))
  } catch {
    // As above: nothing to keep it in.
  }
}

/** How long a restore keeps trying while the page fills in below (lists from the network, images). */
export const RESTORE_FOR_MS = 2500
const INPUT_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

/** Frames the position must hold before a restore ends: a list mounting just after can move it once more. */
const SETTLED_FRAMES = 5

/**
 * Scrolls `scroller` to `top`, again on each frame until the page is tall enough to get there
 * and the position holds, for at most `RESTORE_FOR_MS`. The reader scrolling, or pressing a key,
 * ends it: their own scroll wins. Returns what stops it early.
 */
function restore(scroller: HTMLElement, top: number): () => void {
  const started = performance.now()
  let frame = 0
  let held = 0
  const stop = () => {
    cancelAnimationFrame(frame)
    for (const type of INPUT_EVENTS) scroller.removeEventListener(type, stop)
  }
  const step = () => {
    if (Math.abs(scroller.scrollTop - top) > 1) scroller.scrollTop = top
    held = Math.abs(scroller.scrollTop - top) <= 1 ? held + 1 : 0
    if (held >= SETTLED_FRAMES || performance.now() - started > RESTORE_FOR_MS) return stop()
    frame = requestAnimationFrame(step)
  }
  for (const type of INPUT_EVENTS) scroller.addEventListener(type, stop, { passive: true })
  step()
  return stop
}

/**
 * The shell's scrolling, as a browser does it for whole pages: a new page starts at the top,
 * and Back or Forward returns to where that history entry was left (Home, Search, the library,
 * artist and album pages alike), trying while cached content renders. Replacing the address on
 * the same page, as typing a search or choosing a sort does, does not move it, and the entry
 * keeps its place under its new key.
 */
export function useScrollMemory(scroller: HTMLElement | null) {
  const { key, pathname } = useLocation()
  const type = useNavigationType()
  const shown = useRef({ key, pathname })

  // Recorded as it happens: by the time the next page has rendered, the old position is gone.
  useEffect(() => {
    if (!scroller) return
    const onScroll = () => remember(shown.current.key, scroller.scrollTop)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('pagehide', store)
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      window.removeEventListener('pagehide', store)
      store()
    }
  }, [scroller])

  useLayoutEffect(() => {
    if (!scroller) return
    const previous = shown.current
    shown.current = { key, pathname }
    if (previous.key === key) return
    const samePage = previous.pathname === pathname
    // A replaced entry is the same place under a new key.
    if (type === 'REPLACE' && samePage) {
      const top = saved().get(previous.key)
      if (top !== undefined) remember(key, top)
      return
    }
    const top = type === 'POP' ? saved().get(key) : undefined
    if (top !== undefined) return restore(scroller, top)
    if (!samePage) scroller.scrollTo({ top: 0 })
  }, [key, pathname, type, scroller])
}
