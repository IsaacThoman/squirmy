import { queryKeys, type EntityChange } from '@squirmy/contracts'
import { act, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { album, track } from '@/fixtures/catalog'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'
import { BATCH_MS } from './RealtimeProvider'

const demo = track('night-swimming-demo')
const resultRows = () => { const list = screen.queryByRole('list', { name: /^Results for/ }); return list ? within(list).getAllByRole('listitem') : [] }
const rowOf = (title: string) => resultRows().find(item => within(item).queryByText(title) !== null)
// The order of the result rows, by their title and detail lines: a row that grays out changes its note, not its place.
const rowOrder = () => resultRows().map(item => [...item.querySelectorAll('span[dir=auto]')].map(span => span.textContent).join(' — '))

afterEach(() => vi.useRealTimers())

describe('realtime changes', () => {
  it('grays out a song a fetch failed for where it is, without running the search again or moving a row', async () => {
    const { services, socket, api } = fakeServices()
    const { queryClient } = renderWithApp(<AppRoutes />, '/search?q=night swimming', services)
    await waitFor(() => expect(rowOf(demo.title)).toBeDefined(), { timeout: 3000 })
    expect(rowOf(demo.title)!).not.toHaveAttribute('title', 'Not available')
    const searches = api.search.catalog.mock.calls.length + api.search.library.mock.calls.length
    const before = rowOrder()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    // What the server sends for every track any user's fetch ends with, many times a minute.
    const changes: EntityChange[] = [{ kind: 'availability', tracks: [{ id: demo.id, availability: 'none' }], albums: [] }]
    act(() => socket.serverEmit('changes', { changes }))
    // Unavailable as rows say it: faded, with "Not available" as their title and note.
    await waitFor(() => expect(rowOf(demo.title)!).toHaveAttribute('title', 'Not available'))

    expect(api.search.catalog.mock.calls.length + api.search.library.mock.calls.length).toBe(searches)
    expect(invalidate).not.toHaveBeenCalled()
    expect(rowOrder()).toEqual(before)
  })

  it('refetches only the page of an entity that changed, and closes one that is gone', async () => {
    const { services, socket, api } = fakeServices()
    const { queryClient } = renderWithApp(<AppRoutes />, '/', services)
    await screen.findByRole('heading', { name: 'Listen now' })
    const blue = album('blue-hour')
    queryClient.setQueryData(queryKeys.album(blue.id), await api.catalog.album(blue.id))
    queryClient.setQueryData(queryKeys.playlist('gone'), { id: 'gone' })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    const reset = vi.spyOn(queryClient, 'resetQueries')

    act(() => socket.serverEmit('changes', { changes: [
      { kind: 'updated', entity: 'album', ids: [blue.id] },
      { kind: 'deleted', entity: 'playlist', ids: ['gone'] },
    ] satisfies EntityChange[] }))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: queryKeys.album(blue.id) }))
    expect(reset).toHaveBeenCalledWith({ queryKey: queryKeys.playlist('gone') })
    expect(invalidate).toHaveBeenCalledTimes(1)
  })

  it('patches a heart or library mark from another device everywhere it is cached', async () => {
    const { services, socket } = fakeServices()
    const { queryClient } = renderWithApp(<AppRoutes />, '/', services)
    await screen.findByRole('heading', { name: 'Listen now' })
    queryClient.setQueryData(['somewhere'], { items: [{ ...demo, liked: false, inLibrary: false, library: null }] })
    act(() => socket.serverEmit('changes', { changes: [
      { kind: 'patch', entity: 'track', id: demo.id, fields: { liked: true, inLibrary: true, library: 'saved' } },
    ] satisfies EntityChange[] }))
    await waitFor(() => expect(queryClient.getQueryData<{ items: typeof demo[] }>(['somewhere'])!.items[0]).toMatchObject({ liked: true, inLibrary: true, library: 'saved' }))
  })

  it('refetches each invalidated query once per burst', async () => {
    const { services, socket } = fakeServices()
    const { queryClient } = renderWithApp(<AppRoutes />, '/', services)
    await screen.findByRole('heading', { name: 'Listen now' })
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')
    vi.useFakeTimers()
    act(() => {
      for (let n = 0; n < 30; n++) socket.serverEmit('invalidate', { keys: [queryKeys.libraryAlbums(), queryKeys.library(), queryKeys.home()] })
    })
    expect(invalidate).not.toHaveBeenCalled()
    act(() => vi.advanceTimersByTime(BATCH_MS))
    expect(invalidate.mock.calls).toEqual([[{ queryKey: queryKeys.library() }], [{ queryKey: queryKeys.home() }]])
  })
})
