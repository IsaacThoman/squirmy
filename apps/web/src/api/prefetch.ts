import type { AlbumSummary, ArtistSummary } from '@squirmy/contracts'
import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useRef } from 'react'
import { albumQuery, artistQuery, homeQuery, libraryListQuery } from './queries'
import { useApi } from './services'

/**
 * Starting a page's request before it is opened, and drawing its top from what another list
 * already said about it, so opening an album or artist feels immediate.
 */

/** A pointer that rests this long on a link is about to click it. */
export const HOVER_DELAY_MS = 100

type PrefetchTarget = { kind: 'album' | 'artist'; id: string }

export type PrefetchHandlers = {
  onPointerEnter: () => void
  onPointerLeave: () => void
  onPointerDown: () => void
  onFocus: () => void
}

/**
 * Handlers for a link to an album or artist: a hover of 100 ms, a focus or a press fetches
 * the page's detail, unless it is cached and fresh.
 */
export function usePrefetch(target: PrefetchTarget): PrefetchHandlers {
  const api = useApi()
  const client = useQueryClient()
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const { kind, id } = target
  useEffect(() => () => clearTimeout(timer.current), [])
  return useMemo(() => {
    const now = () => {
      clearTimeout(timer.current)
      void (kind === 'album' ? client.prefetchQuery(albumQuery(api, id)) : client.prefetchQuery(artistQuery(api, id)))
    }
    return {
      onPointerEnter: () => {
        clearTimeout(timer.current)
        timer.current = setTimeout(now, HOVER_DELAY_MS)
      },
      onPointerLeave: () => clearTimeout(timer.current),
      onPointerDown: now,
      onFocus: now,
    }
  }, [api, client, kind, id])
}

/** After sign-in, the pages people open first: Home is on screen already, the library is next. */
export function usePrefetchStartPages() {
  const api = useApi()
  const client = useQueryClient()
  useEffect(() => {
    // After the first screen has its data, so these do not compete with it.
    const timer = setTimeout(() => void client.prefetchInfiniteQuery(libraryListQuery(api, 'albums', { sort: 'recent' })), 1500)
    void client.prefetchQuery(homeQuery(api))
    return () => clearTimeout(timer)
  }, [api, client])
}

const MAX_DEPTH = 6

/** The first object in any cached answer that `matches`, looking a few levels into lists and sections. */
function findCached<T>(client: QueryClient, matches: (value: Record<string, unknown>) => boolean): T | undefined {
  const visit = (value: unknown, depth: number): T | undefined => {
    if (!value || typeof value !== 'object' || depth > MAX_DEPTH) return undefined
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = visit(item, depth + 1)
        if (found) return found
      }
      return undefined
    }
    const record = value as Record<string, unknown>
    if (matches(record)) return record as T
    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') {
        const found = visit(child, depth + 1)
        if (found) return found
      }
    }
    return undefined
  }
  for (const query of client.getQueryCache().getAll()) {
    if (query.queryKey[0] === 'admin') continue
    const found = visit(query.state.data, 0)
    if (found) return found
  }
  return undefined
}

/** What a list, a search or another page already knows about an album: enough for its header. */
export function cachedAlbumSummary(client: QueryClient, id: string): AlbumSummary | undefined {
  return findCached<AlbumSummary>(client, value => value.id === id && typeof value.artistCredit === 'string' && typeof value.trackCount === 'number' && Array.isArray(value.artists))
}

export function cachedArtistSummary(client: QueryClient, id: string): ArtistSummary | undefined {
  return findCached<ArtistSummary>(client, value => value.id === id && typeof value.name === 'string' && 'image' in value && typeof value.inLibrary === 'boolean')
}

/** The summary to draw a page's header from while its detail loads; undefined once there is nothing better to show. */
export function useCachedSummary(kind: 'album', id: string, loading: boolean): AlbumSummary | undefined
export function useCachedSummary(kind: 'artist', id: string, loading: boolean): ArtistSummary | undefined
export function useCachedSummary(kind: 'album' | 'artist', id: string, loading: boolean): AlbumSummary | ArtistSummary | undefined {
  const client = useQueryClient()
  return useMemo(() => {
    if (!loading) return undefined
    return kind === 'album' ? cachedAlbumSummary(client, id) : cachedArtistSummary(client, id)
  }, [client, kind, id, loading])
}
