import { act, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
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

describe('PlayerBar at the widths a desktop and a tablet give it', () => {
  /** Lays the bar out `width` px wide: jsdom lays nothing out. */
  const at = (width: number) => vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(width)
  afterEach(() => vi.restoreAllMocks())

  it('shows the whole credit on hover where it is cut short', () => {
    const credit = `${song.artistCredit} feat. Somebody With A Long Name`
    renderWithApp(bar(player('ready', 'entry-long', { ...song, artistCredit: credit })))
    expect(screen.getByRole('region', { name: 'Player' }).querySelector('[data-credit]')).toHaveAttribute('title', credit)
  })

  it('keeps the volume and Now Playing in the bar where they fit, with no More button', () => {
    at(1200)
    renderWithApp(bar(player('ready', 'entry-wide')))
    const region = screen.getByRole('region', { name: 'Player' })
    expect(within(region).getByRole('slider', { name: 'Volume' })).toBeInTheDocument()
    expect(within(region).getByRole('button', { name: 'Now Playing' })).toBeInTheDocument()
    expect(within(region).queryByRole('button', { name: 'More player controls' })).toBeNull()
  })

  it('puts the controls a narrower bar has no room for behind More player controls', async () => {
    at(900)
    const value = player('ready', 'entry-narrow')
    renderWithApp(bar(value))
    const region = screen.getByRole('region', { name: 'Player' })
    expect(within(region).queryByRole('slider', { name: 'Volume' })).toBeNull()
    await userEvent.click(within(region).getByRole('button', { name: 'More player controls' }))
    const more = await screen.findByRole('dialog', { name: 'More player controls' })
    expect(within(more).getByRole('slider', { name: 'Volume' })).toBeInTheDocument()
    expect(within(more).queryByRole('button', { name: 'Now Playing' })).toBeNull()
  })

  it('stacks the transport under the song on a tablet, so the title and credit keep their room', async () => {
    at(504)
    renderWithApp(bar(player('ready', 'entry-tablet')))
    const region = screen.getByRole('region', { name: 'Player' })
    expect(region.querySelector('[data-layout]')).toHaveAttribute('data-layout', 'stacked')
    // With the room a row of its own gives, lyrics stay in the bar; Now Playing joins the volume behind More.
    expect(within(region).getByRole('button', { name: 'Lyrics' })).toBeInTheDocument()
    await userEvent.click(within(region).getByRole('button', { name: 'More player controls' }))
    expect(within(await screen.findByRole('dialog', { name: 'More player controls' })).getByRole('button', { name: 'Now Playing' })).toBeInTheDocument()
  })
})

describe('PlayerBar on a phone on its side', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('keeps one row, with the lyrics and the heart behind More so the title keeps some room', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(486)
    vi.stubGlobal('matchMedia', (media: string) => ({ media, matches: media.includes('orientation: landscape'), addEventListener: () => {}, removeEventListener: () => {} }))
    const value = player('ready', 'entry-landscape')
    renderWithApp(bar(value))
    const region = screen.getByRole('region', { name: 'Player' })
    expect(region.querySelector('[data-layout]')).toHaveAttribute('data-layout', 'row')
    expect(within(region).queryByRole('button', { name: `Save ${song.title} to library` })).toBeNull()
    await userEvent.click(within(region).getByRole('button', { name: 'More player controls' }))
    const more = await screen.findByRole('dialog', { name: 'More player controls' })
    expect(within(more).getByRole('button', { name: 'Lyrics' })).toBeInTheDocument()
    await userEvent.click(within(more).getByRole('button', { name: 'Save to library' }))
  })
})

describe('MiniPlayer with nothing loaded', () => {
  it('still offers the devices, so where the first song plays can be chosen', () => {
    renderWithApp(<MiniPlayer player={player('ready', 'entry-none', song, { current: null })} onOpenNowPlaying={() => {}} />)
    const region = screen.getByRole('region', { name: 'Player' })
    expect(within(region).getByText('Nothing playing')).toBeInTheDocument()
    expect(within(region).getByRole('button', { name: 'Devices' })).toBeInTheDocument()
  })
})

describe('the player\'s status line', () => {
  it('says what happened to playback under the song, in a polite live region', () => {
    renderWithApp(bar(player('ready', 'entry-status', song, { status: { message: 'Skipped “Intro” — not available', tone: 'info', key: 'notice' } })))
    const region = screen.getByRole('region', { name: 'Player' })
    const line = within(region).getByText('Skipped “Intro” — not available')
    expect(line.closest('[role="status"]')).not.toBeNull()
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
  const desk = { id: 'desk', name: 'Desk Mac', kind: 'desktop' as const, canPlay: true, isActive: true }

  it.each([true, false])('uses the colored device button for remote playback (playing=%s)', playing => {
    renderWithApp(bar(player('ready', 'entry-remote', song, { playing, activeDeviceId: desk.id, devices: [...devices, desk] })))
    const region = screen.getByRole('region', { name: 'Player' })
    expect(within(region).getByRole('button', { name: 'Devices' })).toHaveClass('text-primary')
    expect(within(region).queryByText(/^(Playing|Paused) (on|in) /)).toBeNull()
    expect(within(region).queryByRole('button', { name: 'Play here' })).toBeNull()
  })

  it('shows reconnecting status and keeps transfer available in the device picker', () => {
    const value = player('ready', 'entry-away', song, { activeDeviceId: desk.id, away: { id: desk.id, device: desk } })
    renderWithApp(bar(value))
    const region = screen.getByRole('region', { name: 'Player' })
    const trigger = within(region).getByRole('button', { name: 'Devices' })
    expect(trigger).toHaveClass('text-primary')
    expect(within(region).queryByText('Reconnecting to Desk Mac…')).toBeNull()
    act(() => trigger.click())
    const picker = screen.getByRole('dialog', { name: 'Playback devices' })
    expect(within(picker).getByText('Reconnecting to Desk Mac…')).toBeInTheDocument()
    const thisTab = within(picker).getByRole('button', { name: /Play in this tab/ })
    act(() => thisTab.focus())
    expect(value.controls.prepareHere).toHaveBeenCalled()
    act(() => thisTab.click())
    expect(value.controls.transfer).toHaveBeenCalledWith(thisDeviceId)
  })

  it('keeps the artist visible on the mini player while a remote device reconnects', () => {
    const value = player('ready', 'entry-away', song, { activeDeviceId: desk.id, away: { id: desk.id, device: desk } })
    renderWithApp(<MiniPlayer player={value} onOpenNowPlaying={() => {}} />)
    expect(screen.getByText(song.artistCredit)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Devices' })).toHaveClass('text-primary')
    expect(screen.queryByText('Reconnecting to Desk Mac…')).toBeNull()
  })
})
