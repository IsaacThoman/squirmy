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

function player(state: 'preparing' | 'ready', entryId = 'entry-1'): Player {
  const value: PlayerState = {
    current: { track: song, entry: { id: entryId, trackId: song.id, albumId: song.album?.id ?? null, durationMs: song.durationMs, state } },
    playing: true, volume: 1, volumes: {}, shuffle: false, repeat: 'off', autoplay: false, context: null,
    queue: [], history: [], autoplayQueue: [], devices, thisDeviceId, activeDeviceId: thisDeviceId, lyrics: null,
  }
  return { state: value, controls: new Proxy({}, { get: () => vi.fn() }) as PlayerControls }
}

const bar = (value: Player) => (
  <PlayerBar player={value} liked={false} onToggleLike={() => {}} queueOpen={false} onToggleQueue={() => {}} lyricsOpen={false} onToggleLyrics={() => {}} onOpenNowPlaying={() => {}} />
)

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }))
afterEach(() => vi.useRealTimers())

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

  it('does the same on a phone', () => {
    renderWithApp(<MiniPlayer player={player('preparing', 'entry-phone')} onOpenNowPlaying={() => {}} />)
    const region = screen.getByRole('region', { name: 'Player' })
    expect(within(region).getByText(song.artistCredit)).toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(STILL_LOADING_MS + 100) })
    expect(within(region).getByText('Still loading…')).toBeInTheDocument()
  })
})
