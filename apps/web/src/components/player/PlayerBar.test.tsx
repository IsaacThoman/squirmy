import { act, screen, within } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { track } from '@/fixtures/catalog'
import { devices, thisDeviceId } from '@/fixtures/server'
import type { Player, PlayerControls, PlayerState } from '@/player/player-context'
import { STILL_LOADING_MS } from '@/player/use-still-loading'
import { renderWithApp } from '@/test/render'
import { MiniPlayer, PlayerBar } from './PlayerBar'
import { VolumeControl } from './Transport'

const song = track('night-swimming-demo')

function player(state: 'preparing' | 'ready', entryId = 'entry-1', current = song, overrides: Partial<PlayerState> = {}): Player {
  const value: PlayerState = {
    current: { track: current, entry: { id: entryId, trackId: current.id, albumId: current.album?.id ?? null, durationMs: current.durationMs, state } },
    playing: true, waiting: state === 'preparing', blocked: false, volume: 1, volumes: {}, shuffle: false, repeat: 'off', autoplay: false, context: null,
    queue: [], history: [], autoplayQueue: [], devices, thisDeviceId, activeDeviceId: thisDeviceId, away: null, lyrics: null, detached: false, canDetach: false,
    ...overrides,
  }
  // One mock per control, so a test can ask what was called.
  const mocks = new Map<PropertyKey, ReturnType<typeof vi.fn>>()
  const controls = new Proxy({}, { get: (_, key) => mocks.get(key) ?? mocks.set(key, vi.fn()).get(key) }) as PlayerControls
  return { state: value, controls }
}

const bar = (value: Player) => (
  <PlayerBar player={value} liked={false} onToggleLike={() => {}} queueOpen={false} onToggleQueue={() => {}} lyricsOpen={false} onToggleLyrics={() => {}} onOpenNowPlaying={() => {}} />
)

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => vi.useRealTimers())

describe('PlayerBar', () => {
  it('links each of the song\'s artists to its own page', () => {
    const lead = song.artists[0]!
    const guest = { id: '01a20236-8dd0-77ed-9c01-ab24582bf8cf', name: 'Guest Artist' }
    renderWithApp(bar(player('ready', 'entry-credits', { ...song, artistCredit: `${lead.name} feat. ${guest.name}`, artists: [lead, guest] })))
    const region = screen.getByRole('region', { name: 'Player' })
    expect(within(region).getByRole('link', { name: lead.name })).toHaveAttribute('href', `/artist/${lead.id}`)
    expect(within(region).getByRole('link', { name: guest.name })).toHaveAttribute('href', `/artist/${guest.id}`)
  })
})

describe('PlayerBar while the music is on its way', () => {
  it('spins the play button as for buffering and keeps the artist under the title', () => {
    renderWithApp(bar(player('preparing')))
    const region = screen.getByRole('region', { name: 'Player' })
    expect(within(within(region).getByRole('button', { name: 'Pause' })).getByRole('status', { name: 'Loading' })).toBeInTheDocument()
    expect(within(region).getByRole('link', { name: song.artistCredit })).toBeInTheDocument()
    expect(region.textContent).not.toMatch(/preparing|loading/i)
  })

  it('says “Still loading…” after eight seconds, and nothing before', () => {
    renderWithApp(bar(player('preparing', 'entry-slow')))
    const region = screen.getByRole('region', { name: 'Player' })
    act(() => { vi.advanceTimersByTime(STILL_LOADING_MS - 100) })
    expect(within(region).queryByText('Still loading…')).toBeNull()
    act(() => { vi.advanceTimersByTime(200) })
    expect(within(region).getByText('Still loading…')).toBeInTheDocument()
    expect(within(region).queryByRole('link', { name: song.artistCredit })).toBeNull()
  })

  it('goes back to the artist once the music plays', () => {
    const session = { arrive: () => {} }
    function Bar() {
      const [state, setState] = useState<'preparing' | 'ready'>('preparing')
      useEffect(() => { session.arrive = () => setState('ready') })
      return bar(player(state, 'entry-back'))
    }
    renderWithApp(<Bar />)
    act(() => { vi.advanceTimersByTime(STILL_LOADING_MS + 100) })
    expect(screen.getByText('Still loading…')).toBeInTheDocument()
    act(() => session.arrive())
    expect(screen.queryByText('Still loading…')).toBeNull()
    expect(screen.queryByRole('status', { name: 'Loading' })).toBeNull()
  })

  it('spins too while a song the server has is still loading or buffering, and says so after eight seconds', () => {
    renderWithApp(bar(player('ready', 'entry-stream', song, { waiting: true })))
    const region = screen.getByRole('region', { name: 'Player' })
    expect(within(within(region).getByRole('button', { name: 'Pause' })).getByRole('status', { name: 'Loading' })).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(STILL_LOADING_MS + 100) })
    expect(within(region).getByText('Still loading…')).toBeInTheDocument()
  })

  it('does the same on a phone', () => {
    renderWithApp(<MiniPlayer player={player('preparing', 'entry-phone')} onOpenNowPlaying={() => {}} />)
    const region = screen.getByRole('region', { name: 'Player' })
    expect(within(region).getByText(song.artistCredit)).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(STILL_LOADING_MS + 100) })
    expect(within(region).getByText('Still loading…')).toBeInTheDocument()
  })
})

describe('PlayerBar while the browser holds the audio back', () => {
  it('shows Play, which plays', () => {
    const value = player('ready', 'entry-blocked', song, { playing: false, blocked: true })
    renderWithApp(bar(value))
    const region = screen.getByRole('region', { name: 'Player' })
    act(() => within(region).getByRole('button', { name: 'Play' }).click())
    expect(value.controls.togglePlay).toHaveBeenCalled()
    expect(within(region).queryByRole('button', { name: 'Pause' })).toBeNull()
  })
})

describe('VolumeControl', () => {
  it('unmutes to the volume muted elsewhere, for the same device', () => {
    const changed = vi.fn()
    const { unmount } = renderWithApp(<VolumeControl volume={0.6} deviceId="speaker" onChange={changed} />)
    act(() => screen.getByRole('button', { name: 'Mute' }).click())
    expect(changed).toHaveBeenLastCalledWith(0)
    unmount()
    // Another view of the same device, opened while muted.
    renderWithApp(<VolumeControl volume={0} deviceId="speaker" onChange={changed} />)
    act(() => screen.getByRole('button', { name: 'Unmute' }).click())
    expect(changed).toHaveBeenLastCalledWith(0.6)
  })
})

describe('PlayerBar while another device holds the session', () => {
  it('says it is paused there when it is', () => {
    const other = devices.find(device => device.id !== thisDeviceId && device.canPlay)!
    renderWithApp(bar(player('ready', 'entry-elsewhere', song, { playing: false, activeDeviceId: other.id })))
    const region = screen.getByRole('region', { name: 'Player' })
    expect(within(region).getByText(/^Paused (on|in) /)).toBeInTheDocument()
    expect(within(region).queryByText(/^Playing (on|in) /)).toBeNull()
  })
})

describe('PlayerBar while the playing device is away', () => {
  const desk = { id: 'desk', name: 'Desk Mac', kind: 'desktop' as const, canPlay: true, isActive: true }
  const away = (overrides: Partial<PlayerState> = {}) => player('ready', 'entry-away', song, { activeDeviceId: desk.id, away: { id: desk.id, device: desk }, ...overrides })

  it('says it is reconnecting to that device rather than playing on it, and still offers to play here', () => {
    const value = away()
    renderWithApp(bar(value))
    const region = screen.getByRole('region', { name: 'Player' })
    expect(within(region).getByText('Reconnecting to Desk Mac…')).toBeInTheDocument()
    expect(within(region).queryByText(/^(Playing|Paused) (on|in) /)).toBeNull()
    // Pointing at Play here still gets the music ready, as for any other device.
    const playHere = within(region).getByRole('button', { name: 'Play here' })
    act(() => playHere.focus())
    expect(value.controls.prepareHere).toHaveBeenCalled()
  })

  it('says reconnecting, not paused, while the session waits for it paused', () => {
    renderWithApp(bar(away({ playing: false })))
    expect(screen.getByText('Reconnecting to Desk Mac…')).toBeInTheDocument()
    expect(screen.queryByText(/^Paused (on|in) /)).toBeNull()
  })

  it('says so on a phone too', () => {
    renderWithApp(<MiniPlayer player={away()} onOpenNowPlaying={() => {}} />)
    expect(screen.getByText('Reconnecting to Desk Mac…')).toBeInTheDocument()
  })

  it('goes back to "Playing on" or "Paused on" once the device is listed again', () => {
    const { unmount } = renderWithApp(bar(away({ away: null, devices: [...devices, desk] })))
    expect(screen.getByText('Playing on Desk Mac')).toBeInTheDocument()
    unmount()
    renderWithApp(bar(away({ away: null, devices: [...devices, desk], playing: false })))
    expect(screen.getByText('Paused on Desk Mac')).toBeInTheDocument()
  })
})
