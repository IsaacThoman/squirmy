import type { SessionMoveResult } from '@squirmy/client-core'
import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { track } from '@/fixtures/catalog'
import { devices, thisDeviceId } from '@/fixtures/server'
import { formatIdle } from '@/lib/format'
import { dismissToast, toastStore } from '@/lib/toast'
import type { Player, PlayerControls, PlayerState } from '@/player/player-context'
import { renderWithApp } from '@/test/render'
import { DeviceList } from './Devices'
import { PlayerBar } from './PlayerBar'

const song = track('amber')

function player(state: Partial<PlayerState>, moves: { detach?: SessionMoveResult; attach?: SessionMoveResult } = {}) {
  const controls = {
    detach: vi.fn(async () => moves.detach ?? { ok: true }),
    attach: vi.fn(async () => moves.attach ?? { ok: true }),
    transfer: vi.fn(),
    setVolume: vi.fn(),
  }
  const value: PlayerState = {
    current: { track: song, entry: { id: 'e1', trackId: song.id, albumId: null, durationMs: song.durationMs, state: 'ready' } },
    playing: true, waiting: false, blocked: false, volume: 1, volumes: {}, shuffle: false, repeat: 'off', autoplay: false, context: null,
    queue: [], history: [], autoplayQueue: [], devices, thisDeviceId, activeDeviceId: thisDeviceId, lyrics: null,
    detached: false, canDetach: true,
    ...state,
  }
  return { player: { state: value, controls: controls as unknown as PlayerControls } satisfies Player, controls }
}

const toasts = () => toastStore.getSnapshot().map(item => [item.title, item.description].filter(Boolean).join(' / '))
afterEach(() => act(() => { for (const item of toastStore.getSnapshot()) dismissToast(item.id) }))

describe('devices picker', () => {
  it('lists a detached device apart, with what it plays, and never as a place to move playback to', async () => {
    renderWithApp(<DeviceList player={player({}).player} />)
    expect(screen.queryByRole('button', { name: /Kitchen/ })).toBeNull()
    expect(screen.getByText('Playing separately')).toBeInTheDocument()
    const kitchen = screen.getByText('Kitchen').closest('li')!
    expect(await within(kitchen).findByText('Night Swimming · Paused')).toBeInTheDocument()
  })

  it('plays separately at once, and says the other devices are paused', async () => {
    const { player: value, controls } = player({})
    renderWithApp(<DeviceList player={value} />)
    await userEvent.click(screen.getByRole('button', { name: /Play separately on this tab/ }))
    expect(controls.detach).toHaveBeenCalled()
    expect(toasts()).toEqual(['Playing only on this device / Your other devices are paused where they were.'])
  })

  it('says how long a quiet device has been idle, so two of the same name can be told apart', () => {
    const now = Date.UTC(2026, 10, 22, 12)
    const desk = { id: 'desk', name: 'Chrome on macOS', kind: 'web' as const, canPlay: true, isActive: false }
    expect(formatIdle(now - 3 * 3_600_000, now)).toBe(' · Active 3 hours ago')
    expect(formatIdle(now - 60_000, now)).toBe('')
    expect(formatIdle(undefined, now)).toBe('')
    const old = { ...desk, id: 'old', lastSeenAt: Date.now() - 2 * 86_400_000 }
    renderWithApp(<DeviceList player={player({ devices: [...devices, { ...desk, lastSeenAt: Date.now() }, old] }).player} />)
    const rows = screen.getAllByRole('button', { name: /Chrome on macOS/ }).map(row => row.textContent)
    expect(rows).toEqual(['Chrome on macOSWeb browser', 'Chrome on macOSWeb browser · Active 2 days ago'])
  })

  it('lists the other tabs of this browser once, as "Another tab", and never shows a tab number', () => {
    const browser = '0b6f3c1e-8f2a-4c1d-9e7b-2a5d6c7e8f90'
    const tab = (slot: number, extra = {}) => ({ id: slot === 1 ? browser : `${browser}-${slot}`, name: 'Chrome on macOS', kind: 'web' as const, canPlay: true, isActive: false, ...extra })
    const tabs = [tab(1, { isActive: true }), tab(2), tab(3, { name: 'Chrome on macOS (3)' })]
    renderWithApp(<DeviceList player={player({ devices: [...tabs, devices[1]!], thisDeviceId: `${browser}-2`, activeDeviceId: browser }).player} />)
    expect(screen.getByText('Listening on').nextSibling).toHaveTextContent('Another tab')
    expect(screen.getByRole('button', { name: /This browser/ })).toHaveTextContent('Play in this tab')
    expect(screen.queryByText(/\(3\)/)).toBeNull()
    expect(screen.queryByText('Chrome on macOS')).toBeNull()
  })

  it('says "Playing in another tab" in the player bar', () => {
    const browser = '0b6f3c1e-8f2a-4c1d-9e7b-2a5d6c7e8f90'
    const tabs = [{ id: browser, name: 'Chrome on macOS', kind: 'web' as const, canPlay: true, isActive: true }, { id: `${browser}-2`, name: 'Chrome on macOS', kind: 'web' as const, canPlay: true, isActive: false }]
    const value = player({ devices: tabs, thisDeviceId: `${browser}-2`, activeDeviceId: browser }).player
    renderWithApp(<PlayerBar player={value} liked={false} onToggleLike={() => {}} queueOpen={false} onToggleQueue={() => {}} lyricsOpen={false} onToggleLyrics={() => {}} onOpenNowPlaying={() => {}} />)
    expect(screen.getAllByText('Playing in another tab').length).toBeGreaterThan(0)
  })

  it('hides detaching where it cannot work', () => {
    renderWithApp(<DeviceList player={player({ canDetach: false }).player} />)
    expect(screen.queryByRole('button', { name: /Play separately/ })).toBeNull()
  })

  it.each([
    ['offline', 'Can’t do that while offline.'],
    ['too_many_detached', 'Eight devices are already playing separately. Re-attach one first.'],
    ['timeout', 'Couldn’t play separately. Try again.'],
    ['cannot_play', 'Couldn’t play separately.'],
  ])('says why it could not detach (%s), and changes nothing', async (error, message) => {
    renderWithApp(<DeviceList player={player({}, { detach: { ok: false, error } }).player} />)
    await userEvent.click(screen.getByRole('button', { name: /Play separately on this tab/ }))
    expect(toasts()).toEqual([message])
  })

  describe('while this tab plays separately', () => {
    it('shows the ways back, and tells what stopped on rejoining', async () => {
      const { player: value, controls } = player({ detached: true })
      renderWithApp(<DeviceList player={value} />)
      expect(screen.getByText('Playing only on this device')).toBeInTheDocument()
      expect(screen.queryByText('Play on another device')).toBeNull()
      await userEvent.click(screen.getByRole('button', { name: 'Rejoin your other devices' }))
      expect(controls.attach).toHaveBeenCalledWith(undefined)
      expect(toasts()).toEqual(['Rejoined your other devices / Stopped “Amber”.'])
    })

    it('brings its queue along', async () => {
      const { player: value, controls } = player({ detached: true })
      renderWithApp(<DeviceList player={value} />)
      await userEvent.click(screen.getByRole('button', { name: /Bring this queue with me/ }))
      expect(controls.attach).toHaveBeenCalledWith({ bringQueue: true })
    })

    it('offers no queue to bring when there is nothing in it', () => {
      renderWithApp(<DeviceList player={player({ detached: true, current: null, queue: [] }).player} />)
      expect(screen.queryByRole('button', { name: /Bring this queue/ })).toBeNull()
    })

    it('says “Couldn’t rejoin” when it cannot', async () => {
      renderWithApp(<DeviceList player={player({ detached: true }, { attach: { ok: false, error: 'disconnected' } }).player} />)
      await userEvent.click(screen.getByRole('button', { name: 'Rejoin your other devices' }))
      expect(toasts()).toEqual(['Couldn’t rejoin. Try again.'])
    })

    it('marks the player bar “Only on this device”, which opens the picker', async () => {
      const { player: value } = player({ detached: true })
      renderWithApp(<PlayerBar player={value} liked={false} onToggleLike={() => {}} queueOpen={false} onToggleQueue={() => {}} lyricsOpen={false} onToggleLyrics={() => {}} onOpenNowPlaying={() => {}} />)
      await userEvent.click(screen.getByRole('button', { name: 'Only on this device' }))
      expect(await screen.findByRole('button', { name: 'Rejoin your other devices' })).toBeInTheDocument()
    })
  })
})
