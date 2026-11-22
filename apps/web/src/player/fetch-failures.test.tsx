import { ApiError } from '@squirmy/client-core'
import type { QueueEntry } from '@squirmy/contracts'
import { act, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { AppRoutes } from '@/App'
import { album } from '@/fixtures/catalog'
import { dismissToast, toastStore } from '@/lib/toast'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'
import { failedFetches, watchedOf, type SessionEntries } from './fetch-failures'

const entry = (id: string, state: QueueEntry['state'] = 'preparing'): QueueEntry => ({ id, trackId: `t-${id}`, albumId: null, durationMs: 1000, state })
const session = (current: QueueEntry | null, queue: QueueEntry[], history: QueueEntry[] = []): SessionEntries => ({ current, queue, autoplayQueue: [], history })

describe('failedFetches', () => {
  const [a, b, c, d] = ['a', 'b', 'c', 'd'].map(id => entry(id))

  it('tells the current song the session skipped as failed', () => {
    expect(failedFetches(watchedOf(session(a, [b, c])), session(b, [c]))).toEqual([{ entry: a, held: false }])
  })

  it('does not tell a current song skipped by hand, which goes to the history', () => {
    expect(failedFetches(watchedOf(session(a, [b, c])), session(b, [c], [a]))).toEqual([])
  })

  it('tells the next song when its fetch fails', () => {
    const failed = { ...b, state: 'failed' as const }
    expect(failedFetches(watchedOf(session(a, [b, c])), session(a, [failed, c]))).toEqual([{ entry: failed, held: false }])
  })

  it('says nothing of a song further down the queue', () => {
    expect(failedFetches(watchedOf(session(a, [b, c, d])), session(a, [b, { ...c, state: 'failed' }, d]))).toEqual([])
  })

  it('marks a current song the session kept as failed: the end of the queue, or an outage it tells itself', () => {
    const failed = { ...a, state: 'failed' as const }
    expect(failedFetches(watchedOf(session(a, [b])), session(failed, [b]))).toEqual([{ entry: failed, held: true }])
  })

  it('tells nothing twice', () => {
    const failed = { ...b, state: 'failed' as const }
    const after = session(a, [failed, c])
    expect(failedFetches(watchedOf(after), after)).toEqual([])
  })
})

describe('telling failures', () => {
  afterEach(() => act(() => { for (const item of toastStore.getSnapshot()) dismissToast(item.id) }))
  const lowTide = album('low-tide')
  const [song, edit] = lowTide.discs[0].tracks
  const titles = () => toastStore.getSnapshot().map(item => `${item.title} ${item.description ?? ''}`.trim())

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

  it('tells once, by name, a song that was current or next and could not be had', async () => {
    const { socket } = await playLowTide()
    failTrack(socket, edit.id)
    expect(await screen.findByText(`Couldn’t play “${edit.title}”`)).toBeInTheDocument()
    // The last song: the session keeps it current, stopped, and it is told once no outage is.
    failTrack(socket, song.id)
    expect(await screen.findByText(`Couldn’t play “${song.title}”`, {}, { timeout: 3000 })).toBeInTheDocument()
    expect(titles().filter(title => title.startsWith('Couldn’t play'))).toEqual([`Couldn’t play “${edit.title}” Skipped.`, `Couldn’t play “${song.title}” Skipped.`])
  })

  it('tells an outage once, and no song after it', async () => {
    const { socket } = await playLowTide()
    act(() => socket.serverSet(session => ({ ...session, playing: false, current: session.current && { ...session.current, state: 'failed' } })))
    act(() => socket.serverEmit('event', { type: 'playback.unavailable', trackId: song.id }))
    expect(await screen.findByText('Can’t load music right now')).toBeInTheDocument()
    failTrack(socket, edit.id)
    // Past the wait for the outage notice: the paused song is not told on its own either.
    await act(() => new Promise(resolve => setTimeout(resolve, 1700)))
    expect(titles().filter(title => title.startsWith('Couldn’t play'))).toEqual([])
    expect(titles().filter(title => title.startsWith('Can’t load'))).toHaveLength(1)
  })

  it('says nothing for a fetch that ends outside the session', async () => {
    const { socket } = await playLowTide()
    act(() => socket.serverEmit('event', { type: 'acquisition.updated', jobId: '00000000-0000-4000-8b00-000000000001', trackId: album('afterimage').discs[0].tracks[0].id, status: 'failed' }))
    await act(() => new Promise(resolve => setTimeout(resolve, 50)))
    expect(titles().filter(title => /Couldn’t/.test(title))).toEqual([])
  })
})

describe('a track the server refuses to stream', () => {
  afterEach(() => act(() => { for (const item of toastStore.getSnapshot()) dismissToast(item.id) }))

  it('is told once and skipped', async () => {
    const { services, socket, api } = fakeServices()
    const blueHour = album('blue-hour')
    const [first, second] = blueHour.discs[0].tracks
    api.streaming.playback.mockRejectedValueOnce(new ApiError(404, 'not_found', 'Not found'))
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    await userEvent.click((await screen.findAllByRole('button', { name: 'Play Blue Hour' }))[0]!)
    expect(await screen.findByText(`Couldn’t play “${first.title}”`)).toBeInTheDocument()
    await waitFor(() => expect(socket.session.current?.trackId).toBe(second.id))
  })
})
