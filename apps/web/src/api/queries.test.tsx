import type { AlbumDetail } from '@squirmy/contracts'
import { QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { album } from '@/fixtures/catalog'
import { fakeServices } from '@/test/fake-services'
import { createQueryClient } from './query-client'
import { TRACK_LIST_POLL_FOR_MS, useAlbum } from './queries'
import { ServicesContext } from './services'

describe('useAlbum', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('asks again for a minute while the songs are looked up, and for another minute after Check again', async () => {
    const { services, api } = fakeServices()
    const pending: AlbumDetail = { ...album('low-tide'), discs: [], trackCount: 0, ownedTrackCount: 0, durationMs: 0, detailPending: true }
    api.catalog.album.mockResolvedValue(pending)
    const client = createQueryClient()
    const wrapper = ({ children }: { children: ReactNode }) => (
      <ServicesContext value={services}><QueryClientProvider client={client}>{children}</QueryClientProvider></ServicesContext>
    )
    const { result } = renderHook(() => useAlbum(pending.id), { wrapper })

    await act(() => vi.advanceTimersByTimeAsync(TRACK_LIST_POLL_FOR_MS + 10_000))
    const spent = api.catalog.album.mock.calls.length
    expect(spent).toBeGreaterThan(10)
    // The minute is over: nothing more is asked by itself.
    await act(() => vi.advanceTimersByTimeAsync(30_000))
    expect(api.catalog.album).toHaveBeenCalledTimes(spent)

    await act(async () => { await result.current.refetch() })
    await act(() => vi.advanceTimersByTimeAsync(10_000))
    expect(api.catalog.album.mock.calls.length).toBeGreaterThan(spent + 2)
  })
})
