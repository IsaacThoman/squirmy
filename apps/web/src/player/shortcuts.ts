import type { SessionClientSnapshot } from '@squirmy/client-core'
import { useEffect, useRef } from 'react'
import type { PlayerControls, PositionClock } from './player-context'

const SEEK_STEP_MS = 5000
const VOLUME_STEP = 0.05

/** Elements that use these keys themselves: typing, sliders, menus, lists, and buttons for Space. */
const ownsArrows = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="slider"], [role="menu"], [role="menuitem"], [role="listbox"], [role="option"], [role="tablist"], [role="tab"], [role="radiogroup"]'
const ownsSpace = `${ownsArrows}, button, a[href], summary, [role="button"], [role="switch"], [role="checkbox"]`

/** Whether a key press belongs to the focused element rather than the player. */
export function keyIsTaken(event: Pick<KeyboardEvent, 'key' | 'target' | 'altKey' | 'ctrlKey' | 'metaKey' | 'defaultPrevented'>): boolean {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return true
  const target = event.target instanceof Element ? event.target : null
  return Boolean(target?.closest(event.key === ' ' ? ownsSpace : ownsArrows))
}

/**
 * Space plays and pauses, ←/→ seek by five seconds and ↑/↓ change the volume of the
 * device that plays, unless the focused element uses the key itself.
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
