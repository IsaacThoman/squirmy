import { queryKeys } from '@squirmy/contracts'
import { QueryClient } from '@tanstack/react-query'
import { act, fireEvent, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { AppRoutes } from '@/App'
import { album, home, libraryArtists, summary, track } from '@/fixtures/catalog'
import { fakeServices } from '@/test/fake-services'
import { renderWithApp } from '@/test/render'
import { cachedAlbumSummary, cachedArtistSummary, HOVER_DELAY_MS } from './prefetch'

describe('cached summaries', () => {
  it('finds an album or artist in any list already cached, and nothing else', () => {
    const client = new QueryClient()
    const blueHour = album('blue-hour')
    client.setQueryData([...queryKeys.libraryAlbums(), { sort: 'recent' }], { pages: [{ items: [summary(blueHour)], nextCursor: null }], pageParams: [undefined] })
    client.setQueryData(queryKeys.home(), home)
    expect(cachedAlbumSummary(client, blueHour.id)).toEqual(summary(blueHour))
    expect(cachedArtistSummary(client, libraryArtists[0]!.id)).toEqual(libraryArtists[0])
    // A track only names its album; that is not enough for a header.
    client.setQueryData(queryKeys.home(), { sections: [{ kind: 'tracks', id: 'on-repeat', title: 'On repeat', tracks: [track('amber')] }] })
    expect(cachedAlbumSummary(client, track('amber').album!.id)).toBeUndefined()
    expect(cachedAlbumSummary(client, 'missing')).toBeUndefined()
  })
})

describe('album page', () => {
  it('shows a skeleton when nothing about the album is cached', async () => {
    const { services, api } = fakeServices()
    const blueHour = album('blue-hour')
    api.catalog.album.mockImplementation(() => new Promise(() => {}))
    renderWithApp(<AppRoutes />, `/album/${blueHour.id}`, services)
    expect(await screen.findByRole('status', { name: 'Loading' })).toBeInTheDocument()
    expect(screen.queryByRole('heading', { name: blueHour.title })).toBeNull()
  })

  it('draws the header from a cached list at once', async () => {
    const { services, api } = fakeServices()
    const blueHour = album('blue-hour')
    api.catalog.album.mockImplementation(() => new Promise(() => {}))
    api.catalog.home.mockImplementation(async () => ({ sections: [{ id: 'recently-added', kind: 'albums' as const, title: 'Recently added', albums: [summary(blueHour)] }] }))
    renderWithApp(<AppRoutes />, '/', services)
    const card = await screen.findByRole('link', { name: blueHour.title })
    fireEvent.click(card)
    expect(await screen.findByRole('heading', { level: 1, name: blueHour.title })).toBeInTheDocument()
    expect(screen.getByRole('status', { name: `Loading ${blueHour.title}` })).toBeInTheDocument()
  })
})

describe('prefetch', () => {
  it('loads an album after the pointer rests on its card, not when it passes over', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { services, api } = fakeServices()
      const blueHour = album('blue-hour')
      api.catalog.home.mockImplementation(async () => ({ sections: [{ id: 'recently-added', kind: 'albums' as const, title: 'Recently added', albums: [summary(blueHour)] }] }))
      renderWithApp(<AppRoutes />, '/', services)
      const card = await screen.findByRole('link', { name: blueHour.title })
      api.catalog.album.mockClear()
      fireEvent.pointerEnter(card)
      fireEvent.pointerLeave(card)
      await act(() => vi.advanceTimersByTimeAsync(HOVER_DELAY_MS * 2))
      expect(api.catalog.album).not.toHaveBeenCalled()
      fireEvent.pointerEnter(card)
      await act(() => vi.advanceTimersByTimeAsync(HOVER_DELAY_MS))
      expect(api.catalog.album).toHaveBeenCalledWith(blueHour.id)
    } finally {
      vi.useRealTimers()
    }
  })
})
