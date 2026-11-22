import { act, screen, within } from '@testing-library/react'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { track } from '@/fixtures/catalog'
import { devices, thisDeviceId } from '@/fixtures/server'
import type { Player, PlayerControls, PlayerState } from '@/player/player-context'
import { STILL_LOADING_MS } from '@/player/use-still-loading'
import { renderWithApp } from '@/test/render'
import { MiniPlayer, PlayerBar } from './PlayerBar'

const song = track('night-swimming-demo')

function player(state: 'preparing' | 'ready', entryId = 'entry-1', current = song, overrides: Partial<PlayerState> = {}): Player {
  const value: PlayerState = {
    current: { track: current, entry: { id: entryId, trackId: current.id, albumId: current.album?.id ?? null, durationMs: current.durationMs, state } },
    playing: true, waiting: state === 'preparing', blocked: false, volume: 1, volumes: {}, shuffle: false, repeat: 'off', autoplay: false, context: null,
    queue: [], history: [], autoplayQueue: [], devices, thisDeviceId, activeDeviceId: thisDeviceId, lyrics: null, detached: false, canDetach: false,
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
