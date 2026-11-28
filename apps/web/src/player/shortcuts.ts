import { followsJam, type SessionClientSnapshot } from '@squirmy/client-core'
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

/**
 * Where a letter key (M, S, R, L, Q, Y, F, /, ?) is typed or picks an item rather than reaching the
 * app: fields, menus and lists that jump to what is typed, and dialogs but Now Playing.
 * `data-own-keys` is not here: the regions that say it (full screen's buttons) own the arrows only.
 */
const ownsLetters = [
  'input', 'textarea', 'select', '[contenteditable=""]', '[contenteditable="true"]',
  '[role="menu"]', '[role="menuitem"]', '[role="listbox"]', '[role="option"]', '[role="combobox"]', '[role="tree"]',
].join(', ')

/** Whether a letter key's press belongs to the focused element rather than the app's shortcuts. */
export function letterIsTaken(event: Pick<KeyboardEvent, 'target' | 'altKey' | 'ctrlKey' | 'metaKey' | 'defaultPrevented' | 'isComposing'>): boolean {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return true
  const target = event.target instanceof Element ? event.target : null
  return Boolean(target?.closest(ownsLetters) || target?.closest(ownsAllKeys))
}

/** Whether a key press belongs to the focused element rather than the player. */
export function keyIsTaken(event: Pick<KeyboardEvent, 'key' | 'target' | 'altKey' | 'ctrlKey' | 'metaKey' | 'defaultPrevented'>): boolean {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return true
  const target = event.target instanceof Element ? event.target : null
  return Boolean(target?.closest(event.key === ' ' ? ownsSpace : ownsArrows) || target?.closest(ownsAllKeys))
}

/**
 * Space plays and pauses, ←/→ seek by five seconds (with Shift, go to the previous or next song)
 * and ↑/↓ change the volume of the device that plays, unless the focused element uses the key
 * itself or is inside something that does (`keyIsTaken`). The shell has the letter keys. While
 * this user follows someone's jam only the volume keys work, as only the volume does in the player.
 */
export function useShortcuts(controls: PlayerControls, clock: PositionClock, snapshot: SessionClientSnapshot, thisDeviceId: string) {
  const latest = useRef(snapshot)
  useEffect(() => { latest.current = snapshot })

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' '].includes(event.key) || keyIsTaken(event)) return
      const { session } = latest.current
      const volumeKey = event.key === 'ArrowUp' || event.key === 'ArrowDown'
      // In someone's jam the host plays, pauses and seeks, so those keys are as the dimmed buttons: nothing. The volume is the listener's own.
      if (!volumeKey && (!session.current || followsJam(session))) return
      event.preventDefault()
      // Held down, Shift+arrow would skip song after song.
      if (event.shiftKey && event.repeat && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return
      const volume = session.volumes[session.activeDeviceId ?? thisDeviceId] ?? 1
      switch (event.key) {
        case ' ': return controls.togglePlay()
        case 'ArrowLeft': return event.shiftKey ? controls.previous() : controls.seek(clock.get() - SEEK_STEP_MS)
        case 'ArrowRight': return event.shiftKey ? controls.next() : controls.seek(Math.min(clock.get() + SEEK_STEP_MS, session.current!.durationMs || Infinity))
        case 'ArrowUp': return controls.setVolume(volume + VOLUME_STEP)
        case 'ArrowDown': return controls.setVolume(volume - VOLUME_STEP)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [controls, clock, thisDeviceId])
}
