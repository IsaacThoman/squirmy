import { useEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router'

/** How long Back keeps trying to reach the remembered place while the page fills in. */
const RESTORE_MS = 1000

/**
 * The shell's scrolling, as a browser does it for whole pages: a new page starts at the top,
 * and Back or Forward returns to where that history entry was left (search results, a long
 * list), trying for a moment while cached content renders. Replacing the address on the same
 * page, as typing a search does, does not move it.
 */
export function useScrollMemory(scroller: HTMLElement | null) {
  const { key, pathname } = useLocation()
  const navigation = useNavigationType()
  const positions = useRef(new Map<string, number>())
  const shownPath = useRef<string | null>(null)

  useEffect(() => {
    if (!scroller) return
    const remember = () => positions.current.set(key, scroller.scrollTop)
    scroller.addEventListener('scroll', remember, { passive: true })
    return () => scroller.removeEventListener('scroll', remember)
  }, [scroller, key])

  useEffect(() => {
    if (!scroller) return
    const newPage = shownPath.current !== pathname
    shownPath.current = pathname
    const target = navigation === 'POP' ? positions.current.get(key) : undefined
    if (target === undefined) {
      if (newPage) scroller.scrollTo({ top: 0 })
      return
    }
    const started = performance.now()
    let frame = 0
    const attempt = () => {
      scroller.scrollTo({ top: target })
      if (Math.abs(scroller.scrollTop - target) > 1 && performance.now() - started < RESTORE_MS) frame = requestAnimationFrame(attempt)
    }
    attempt()
    return () => cancelAnimationFrame(frame)
  }, [scroller, key, pathname, navigation])
}
