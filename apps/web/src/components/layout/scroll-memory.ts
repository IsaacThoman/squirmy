import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router'

/**
 * Positions by key, kept for the tab's session so a reload keeps them too, the oldest dropped
 * past `kept`: the history they belong to is far behind.
 */
function positionStore(storageKey: string, kept: number) {
  let positions: Map<string, number> | null = null
  const saved = (): Map<string, number> => {
    if (positions) return positions
    positions = new Map()
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem(storageKey) ?? '[]')
      if (Array.isArray(stored)) for (const entry of stored) if (Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') positions.set(entry[0], entry[1])
    } catch {
      // Storage can be off (a private window); positions then last until the tab reloads.
    }
    return positions
  }
  return {
    get: (key: string) => saved().get(key),
    remember(key: string, value: number) {
      const map = saved()
      map.delete(key)
      map.set(key, value)
      while (map.size > kept) map.delete(map.keys().next().value!)
    },
    store() {
      try {
        sessionStorage.setItem(storageKey, JSON.stringify([...saved()]))
      } catch {
        // As above: nothing to keep it in.
      }
    },
  }
}

/**
 * Where each history entry was scrolled to, by location key. The page scrolls in the shell's
 * own container rather than the window, so the browser's restoration never applies and Back
 * would always land at the top.
 */
const pages = positionStore('squirmy.scroll', 100)
/** How far each rail (a row that scrolls sideways) was scrolled, by location key and rail. */
const rails = positionStore('squirmy.scroll.rails', 300)

/** How long a restore keeps trying while the page fills in below (lists from the network, images). */
export const RESTORE_FOR_MS = 2500
const INPUT_EVENTS = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const

/** Frames the position must hold before a restore ends: a list mounting just after can move it once more. */
const SETTLED_FRAMES = 5

type Axis = 'scrollTop' | 'scrollLeft'

/**
 * Scrolls `scroller` to `position`, again on each frame until it is long enough to get there and
 * the position holds, for at most `RESTORE_FOR_MS`. The reader scrolling, or pressing a key,
 * ends it: their own scroll wins. Returns what stops it early.
 */
function restore(scroller: HTMLElement, position: number, axis: Axis = 'scrollTop'): () => void {
  const started = performance.now()
  let frame = 0
  let held = 0
  const stop = () => {
    cancelAnimationFrame(frame)
    for (const type of INPUT_EVENTS) scroller.removeEventListener(type, stop)
  }
  const step = () => {
    if (Math.abs(scroller[axis] - position) > 1) scroller[axis] = position
    held = Math.abs(scroller[axis] - position) <= 1 ? held + 1 : 0
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
    const onScroll = () => pages.remember(shown.current.key, scroller.scrollTop)
    const store = () => {
      pages.store()
      rails.store()
    }
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
      const top = pages.get(previous.key)
      if (top !== undefined) pages.remember(key, top)
      return
    }
    const top = type === 'POP' ? pages.get(key) : undefined
    if (top !== undefined) return restore(scroller, top)
    if (!samePage) scroller.scrollTo({ top: 0 })
  }, [key, pathname, type, scroller])
}

/**
 * The same for a rail, sideways: Back or Forward to a page returns each of its rails to where it
 * was left, so paging through Recently played, opening an album and coming back keeps the place.
 * `name` tells a page's rails apart (their titles). A rail on a new page starts at its start.
 */
export function useRailScrollMemory(scroller: HTMLElement | null, name: string) {
  const { key } = useLocation()
  const type = useNavigationType()
  const entry = `${key}\u0000${name}`

  useEffect(() => {
    if (!scroller) return
    const onScroll = () => rails.remember(entry, scroller.scrollLeft)
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => scroller.removeEventListener('scroll', onScroll)
  }, [scroller, entry])

  useLayoutEffect(() => {
    if (!scroller) return
    const left = type === 'POP' ? rails.get(entry) : undefined
    // The same page under a new address keeps its place; the rail has not moved.
    if (left === undefined) {
      if (scroller.scrollLeft > 0) rails.remember(entry, scroller.scrollLeft)
      return
    }
    return restore(scroller, left, 'scrollLeft')
  }, [scroller, entry, type])
}
