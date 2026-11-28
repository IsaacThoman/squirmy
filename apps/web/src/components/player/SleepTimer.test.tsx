import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { track } from '@/fixtures/catalog'
import { devices, thisDeviceId } from '@/fixtures/server'
import type { Player, PlayerControls, PlayerState } from '@/player/player-context'
import { renderWithApp } from '@/test/render'
import { SleepTimerButton, SleepTimerChip } from './SleepTimer'

const song = track('night-swimming-demo')
const NOW = 1_800_000_000_000

function player(overrides: Partial<PlayerState> = {}): Player & { setSleepTimer: ReturnType<typeof vi.fn> } {
  const state: PlayerState = {
    current: { track: song, entry: { id: 'entry-1', trackId: song.id, albumId: song.album?.id ?? null, durationMs: 200_000, state: 'ready' } },
    playing: true, waiting: false, blocked: false, volume: 1, volumes: {}, shuffle: false, repeat: 'off', autoplay: false,
    context: { type: 'album', id: song.album?.id ?? null, title: 'Blue Hour' },
    queue: [], history: [], autoplayQueue: [], devices, thisDeviceId, activeDeviceId: thisDeviceId, away: null, lyrics: null, detached: false, canDetach: false,
    canSetSleepTimer: true, serverNow: () => Date.now(),
    ...overrides,
  }
  const setSleepTimer = vi.fn()
  return { state, controls: { setSleepTimer } as unknown as PlayerControls, setSleepTimer }
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
})
afterEach(() => vi.useRealTimers())

describe('SleepTimerButton', () => {
  it('offers the lengths and the ends of the song and of the album, and sets the session’s timer', async () => {
    const value = player()
    renderWithApp(<SleepTimerButton player={value} />)
    await userEvent.click(screen.getByRole('button', { name: 'Sleep timer' }))
    expect(screen.getAllByRole('menuitemradio').map(item => item.textContent)).toEqual([
      '5 minutes', '10 minutes', '15 minutes', '30 minutes', '45 minutes', '1 hour', 'End of song', 'End of album',
    ])
    expect(screen.queryByRole('menuitem', { name: 'Turn off timer' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('menuitemradio', { name: '30 minutes' }))
    expect(value.setSleepTimer).toHaveBeenCalledWith({ kind: 'time', durationMs: 30 * 60_000 })
  })

  it('marks the timer that is set, says what is left, and turns it off', async () => {
    const value = player({ sleepTimer: { kind: 'time', endsAt: NOW + 15 * 60_000, durationMs: 15 * 60_000 } })
    renderWithApp(<SleepTimerButton player={value} />)
    const button = screen.getByRole('button', { name: 'Sleep timer, 15:00 left' })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    await userEvent.click(button)
    expect(screen.getByRole('menuitemradio', { name: '15 minutes' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: '5 minutes' })).toHaveAttribute('aria-checked', 'false')
    await userEvent.click(screen.getByRole('menuitem', { name: 'Turn off timer' }))
    expect(value.setSleepTimer).toHaveBeenCalledWith(null)
  })

  it('is not offered by a server that does not take a timer', () => {
    renderWithApp(<SleepTimerButton player={player({ canSetSleepTimer: false })} />)
    expect(screen.queryByRole('button', { name: /Sleep timer/ })).not.toBeInTheDocument()
  })
})

describe('SleepTimerChip', () => {
  it('shows only while a timer is set, counting down', async () => {
    const { rerender } = renderWithApp(<SleepTimerChip player={player()} />)
    expect(screen.queryByRole('button', { name: /Sleep timer/ })).not.toBeInTheDocument()
    rerender(<SleepTimerChip player={player({ sleepTimer: { kind: 'time', endsAt: NOW + 60 * 60_000, durationMs: 60 * 60_000 } })} />)
    expect(screen.getByRole('button', { name: 'Sleep timer, 1:00:00 left' })).toHaveTextContent('1:00:00')
    await vi.advanceTimersByTimeAsync(61_000)
    expect(screen.getByRole('button', { name: 'Sleep timer, 58:59 left' })).toBeInTheDocument()
  })

  it('says what it waits for when the time left is not known', () => {
    renderWithApp(<SleepTimerChip player={player({ repeat: 'one', sleepTimer: { kind: 'queue' } })} />)
    expect(screen.getByRole('button', { name: 'Sleep timer, end of album' })).toHaveTextContent('End of album')
  })
})
