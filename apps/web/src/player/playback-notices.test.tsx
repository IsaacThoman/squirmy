import { ApiError } from '@squirmy/client-core'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, type Mock } from 'vitest'
import { AppRoutes } from '@/App'
import { album } from '@/fixtures/catalog'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'

/** What the player's status line says, wherever it shows (the bar, Now Playing). */
const lines = () => [...new Set([...document.querySelectorAll('p[data-tone]')].map(line => line.textContent ?? ''))]

describe('telling failures', () => {
  const lowTide = album('low-tide')
  const [song, edit] = lowTide.discs[0].tracks
  const titles = lines

  async function playLowTide() {
    const fake = fakeServices()
    renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, fake.services)
    // The album's play button comes first; its first song has the same name.
    await userEvent.click((await screen.findAllByRole('button', { name: 'Play Low Tide' }))[0]!)
    await waitFor(() => expect(fake.socket.session.current?.state).toBe('preparing'))
    return fake
  }
  const failTrack = (socket: ReturnType<typeof fakeServices>['socket'], trackId: string) =>
    act(() => socket.serverApply({ type: 'setEntryState', trackId, state: 'failed' }))

  it('tells a song further on only at its turn, and one playback stays on as one that could not play', async () => {
    const { socket } = await playLowTide()
    // Still in Up next: nothing is said of it yet.
    failTrack(socket, edit.id)
    await act(() => new Promise(resolve => setTimeout(resolve, 1700)))
    expect(titles()).toEqual([])
    // The session keeps the current song, stopped, as nothing after it plays: it was not skipped.
    failTrack(socket, song.id)
    expect(await screen.findByText(`Couldn’t play “${song.title}”`)).toBeInTheDocument()
    expect(titles()).toEqual([`Couldn’t play “${song.title}”`])
  })

  it('tells lightly of a song the provider does not have, as the server says', async () => {
    const { socket } = await playLowTide()
    // The server says why just before the state that marks it failed.
    act(() => socket.serverEmit('event', { type: 'playback.failed', trackId: song.id, failure: 'unavailable' }))
    failTrack(socket, song.id)
    expect(await screen.findByText(`Skipped “${song.title}” — not available`)).toBeInTheDocument()
    expect(titles().filter(title => /Couldn’t|Can’t/.test(title))).toEqual([])
  })

  it('tells an outage once, and no song after it', async () => {
    const { socket } = await playLowTide()
    act(() => socket.serverEmit('event', { type: 'playback.unavailable', trackId: song.id }))
    act(() => socket.serverSet(session => ({ ...session, playing: false, current: session.current && { ...session.current, state: 'failed' } })))
    expect(await screen.findByText('Can’t load music right now. Playback is paused.')).toBeInTheDocument()
    failTrack(socket, edit.id)
    await act(() => new Promise(resolve => setTimeout(resolve, 50)))
    expect(titles().filter(title => title.startsWith('Couldn’t play'))).toEqual([])
    expect(titles().filter(title => title.startsWith('Can’t load'))).toHaveLength(1)
  })

  it('tells an outage that fails several songs at once as the outage alone', async () => {
    const { socket } = await playLowTide()
    // As the server does when its provider is down: the songs fail in one moment, then it pauses and says so.
    failTrack(socket, edit.id)
    failTrack(socket, song.id)
    act(() => socket.serverEmit('event', { type: 'playback.unavailable', trackId: song.id }))
    act(() => socket.serverSet(session => ({ ...session, playing: false })))
    await act(() => new Promise(resolve => setTimeout(resolve, 1700)))
    expect(titles()).toEqual(['Can’t load music right now. Playback is paused.'])
  })

  it('does not gray out the song playback paused on in an outage, as it does one that failed in a row of errors', async () => {
    const pausedOn = async (kind: 'outage' | 'failures') => {
      const { socket } = await playLowTide()
      act(() => socket.serverEmit('event', { type: 'playback.unavailable', trackId: song.id, kind, reason: kind === 'outage' ? 'Fetching is down.' : null }))
      act(() => socket.serverSet(session => ({ ...session, playing: false, current: session.current && { ...session.current, state: 'failed' } })))
      await screen.findByText(/^Can’t load music right now/)
    }
    await pausedOn('outage')
    expect(screen.queryAllByTitle('Not available')).toEqual([])
    cleanup()
    await pausedOn('failures')
    expect(screen.getAllByTitle('Not available').length).toBeGreaterThan(0)
  })

  it('gives the reason the server knows for an outage', async () => {
    const { socket } = await playLowTide()
    act(() => socket.serverEmit('event', { type: 'playback.unavailable', trackId: song.id, kind: 'outage', reason: 'The server can’t fetch music on demand right now.' }))
    act(() => socket.serverSet(session => ({ ...session, playing: false, current: session.current && { ...session.current, state: 'failed' } })))
    expect(await screen.findByText(/The server can’t fetch music on demand right now\. Playback is paused\.$/)).toBeInTheDocument()
  })

  it('says once that none of the remaining songs are available', async () => {
    const { socket } = await playLowTide()
    act(() => socket.serverEmit('event', { type: 'playback.failed', trackId: edit.id, failure: 'unavailable' }))
    failTrack(socket, edit.id)
    act(() => socket.serverEmit('event', { type: 'playback.failed', trackId: song.id, failure: 'unavailable' }))
    act(() => socket.serverEmit('event', { type: 'playback.unavailable', trackId: song.id, kind: 'exhausted', reason: null }))
    failTrack(socket, song.id)
    expect(await screen.findByText('None of the remaining songs are available')).toBeInTheDocument()
    // The stop takes the place of the run's notice.
    expect(titles()).toEqual(['None of the remaining songs are available'])
  })

  it('counts a run of songs not available in one notice rather than one each', async () => {
    const fake = fakeServices()
    const blueHour = album('blue-hour')
    const tracks = blueHour.discs[0].tracks
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, fake.services)
    await userEvent.click((await screen.findAllByRole('button', { name: 'Play Blue Hour' }))[0]!)
    await waitFor(() => expect(fake.socket.session.current).not.toBeNull())
    // Seeded as on demand, so each is still to be fetched.
    act(() => fake.socket.serverSet(session => ({ ...session, current: session.current && { ...session.current, state: 'preparing' }, queue: session.queue.map(entry => ({ ...entry, state: 'preparing' as const })) })))
    for (const track of tracks.slice(0, 3)) {
      act(() => fake.socket.serverEmit('event', { type: 'playback.failed', trackId: track.id, failure: 'unavailable' }))
      act(() => fake.socket.serverApply({ type: 'setEntryState', trackId: track.id, state: 'failed' }))
    }
    expect(await screen.findByText('Skipped 3 songs — not available')).toBeInTheDocument()
    expect(titles()).toEqual(['Skipped 3 songs — not available'])
  })

  it('says nothing for a fetch that ends outside the session', async () => {
    const { socket } = await playLowTide()
    act(() => socket.serverEmit('event', { type: 'acquisition.updated', jobId: '00000000-0000-4000-8b00-000000000001', trackId: album('afterimage').discs[0].tracks[0].id, status: 'failed' }))
    await act(() => new Promise(resolve => setTimeout(resolve, 50)))
    expect(titles().filter(title => /Couldn’t/.test(title))).toEqual([])
  })
})

describe('fresh track details', () => {
  it('reads a song again once the server fetched it, and a track an invalidation names', async () => {
    const { services, socket, api } = fakeServices()
    const lowTide = album('low-tide')
    const [song, edit] = lowTide.discs[0].tracks
    renderWithApp(<AppRoutes />, `/album/${lowTide.id}`, services)
    await userEvent.click((await screen.findAllByRole('button', { name: 'Play Low Tide' }))[0]!)
    await waitFor(() => expect(socket.session.current?.state).toBe('preparing'))
    const asked = () => api.catalog.trackSummaries.mock.calls.flatMap(([request]) => request.tracks.map(track => track.id))
    const before = asked().length
    act(() => socket.serverApply({ type: 'setEntryState', trackId: song.id, state: 'ready' }))
    await waitFor(() => expect(asked().slice(before)).toContain(song.id))
    act(() => socket.serverEmit('invalidate', { keys: [['track', edit.id]] }))
    await waitFor(() => expect(asked().slice(before)).toContain(edit.id))
  })
})

describe('a track the server refuses to stream', () => {
  it('stays, paused and told, when the listener picked it: no other song starts', async () => {
    const { services, socket, api } = fakeServices()
    const blueHour = album('blue-hour')
    const [first] = blueHour.discs[0].tracks
    api.streaming.playback.mockRejectedValueOnce(new ApiError(404, 'not_found', 'Not found'))
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await userEvent.click((await screen.findAllByRole('button', { name: 'Play Blue Hour' }))[0]!)
    expect(await screen.findByText(`Couldn’t play “${first.title}”`)).toBeInTheDocument()
    await waitFor(() => expect(socket.session.playing).toBe(false))
    expect(socket.session.current?.trackId).toBe(first.id)
    expect(lines().join(' ')).not.toMatch(/Skipped/)
  })

  it('is told and skipped when playback came to it by itself', async () => {
    const { services, socket, api } = fakeServices()
    const blueHour = album('blue-hour')
    // Next, not a song picked by name, brings it on. (A shuffle started on a random song, now and
    // then one the fake server never fetches, which made this test fail a sixth of the time.)
    const [first, refused] = blueHour.discs[0].tracks
    // The rest fail as the fake's do: no audio in tests, a failure the client retries.
    const playback = api.streaming.playback as unknown as Mock<(trackId: string) => Promise<never>>
    playback.mockImplementation(async trackId => {
      throw trackId === refused.id ? new ApiError(404, 'not_found', 'Not found') : new Error('No audio in tests')
    })
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await userEvent.click((await screen.findAllByRole('button', { name: 'Play Blue Hour' }))[0]!)
    await waitFor(() => expect(socket.session.current?.trackId).toBe(first.id))
    await userEvent.click(screen.getAllByRole('button', { name: 'Next' })[0]!)
    expect(await screen.findByText(`Couldn’t play “${refused.title}”. Skipped.`)).toBeInTheDocument()
    await waitFor(() => expect(socket.session.current?.trackId).not.toBe(refused.id))
  })
})
