import type { SessionClientSnapshot } from '@squirmy/client-core'
import { useEffect, useRef } from 'react'
import type { PlayerControls, PositionClock } from './player-context'

const SEEK_STEP_MS = 5000
const VOLUME_STEP = 0.05

/**
 * Elements that use these keys themselves: typing, sliders, menus, listboxes, grids and tabs,
 * and anything in a list (the queue, a track list, lyrics), where the arrows scroll or move
 * through it; and buttons for Space. A region with keys of its own says so with `data-own-keys`.
 */
const ownsArrows = [
  'input', 'textarea', 'select', '[contenteditable=""]', '[contenteditable="true"]',
  '[role="slider"]', '[role="menu"]', '[role="menuitem"]', '[role="listbox"]', '[role="option"]', '[role="tablist"]', '[role="tab"]', '[role="radiogroup"]',
  'ul', 'ol', '[role="list"]', '[role="grid"]', '[role="treegrid"]', '[role="tree"]', '[data-own-keys]',
].join(', ')
const ownsSpace = `${ownsArrows}, button, a[href], summary, [role="button"], [role="switch"], [role="checkbox"]`
/**
 * A dialog owns the keys pressed in it: arrows that read or move through Settings must not
 * turn the music down behind it. Now Playing is the player itself, so it says it hands them on.
 */
const ownsAllKeys = '[role="dialog"]:not([data-player-keys]), [role="alertdialog"]'

/** Whether a key press belongs to the focused element rather than the player. */
export function keyIsTaken(event: Pick<KeyboardEvent, 'key' | 'target' | 'altKey' | 'ctrlKey' | 'metaKey' | 'defaultPrevented'>): boolean {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return true
  const target = event.target instanceof Element ? event.target : null
  return Boolean(target?.closest(event.key === ' ' ? ownsSpace : ownsArrows) || target?.closest(ownsAllKeys))
}

/**
 * Space plays and pauses, ←/→ seek by five seconds and ↑/↓ change the volume of the
 * device that plays, unless the focused element uses the key itself or is inside something
 * that does (`keyIsTaken`).
 */
export function useShortcuts(controls: PlayerControls, clock: PositionClock, snapshot: SessionClientSnapshot, thisDeviceId: string) {
  const latest = useRef(snapshot)
  useEffect(() => { latest.current = snapshot })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key) || keyIsTaken(event)) return
      const { session } = latest.current
      if (!session.current && event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      const volume = session.volumes[session.activeDeviceId ?? thisDeviceId] ?? 1
      switch (event.key) {
        case ' ': return controls.togglePlay()
        case 'ArrowLeft': return controls.seek(clock.get() - SEEK_STEP_MS)
        case 'ArrowRight': return controls.seek(Math.min(clock.get() + SEEK_STEP_MS, session.current!.durationMs || Infinity))
        case 'ArrowUp': return controls.setVolume(volume + VOLUME_STEP)
        case 'ArrowDown': return controls.setVolume(volume - VOLUME_STEP)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [controls, clock, thisDeviceId])
}
