import { continuesQuery, keepOrder, mergeSearch, playlistScore, searchItemKey, type MergedSearch, type SearchItem } from '@squirmy/client-core'
import { queryKeys, type PlaylistSummary, type SearchKind, type SearchResults } from '@squirmy/contracts'
import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useDebounced } from '@/lib/use-debounced'
import { useEventCallback } from '@/lib/use-event-callback'
import { useViewer } from '@/player/on-demand-context'
import { isNotFound, searchQuery } from './queries'
import { useApi } from './services'

/**
 * One search as the views show it: the library's answer and the catalog's, merged into one
 * ranked list for what is typed.
 */
export type SearchState = {
  /** Null until an answer that may be shown has arrived. */
  results: MergedSearch | null
  /**
   * The results answer an earlier query: kept on screen while the answer for what is typed
   * is on its way, so the list does not empty with every key, drawn faded, with nothing that
   * Enter would open.
   */
  stale: boolean
  /** The catalog's answer for what is typed is still on its way. */
  catalogPending: boolean
  /** The catalog could not be searched for what is typed; the library's results stand alone. */
  catalogFailed: boolean
  /** Neither search could be made. */
  failed: boolean
  /** Neither search exists on this server. */
  unavailable: boolean
  /** Asks both again, after a failure. */
  retry: () => void
  /** A search is being asked again (after Try again): its failure stays shown until the answer. */
  retrying: boolean
}

type Answer = { term: string; data: SearchResults | null; failed: boolean }

/**
 * How long the library's answer waits for the catalog's before it shows alone. The two are
 * ranked together, so a catalog answer arriving after the library's moves rows; most arrive
 * within this, and the previous results stay on screen meanwhile.
 */
export const CATALOG_WAIT_MS = 700

/** The last answer the query gave for the term it was asked, never a placeholder kept from another term. */
function useAnswer(kind: 'library' | 'catalog', term: string) {
  const query = useQuery({ ...searchQuery(useApi(), kind, term), placeholderData: keepPreviousData, retry: 1, meta: { silent: true } })
  const [answer, setAnswer] = useState<Answer | null>(null)
  const fresh = term.length > 0 && !query.isPlaceholderData && query.data !== undefined
  if (fresh && (answer?.term !== term || answer.data !== query.data || answer.failed)) setAnswer({ term, data: query.data, failed: false })
  const failed = term.length > 0 && query.isError && !query.isFetching
  if (failed && (answer?.term !== term || !answer.failed)) setAnswer({ term, data: null, failed: true })
  return { answer, refetch: query.refetch, fetching: query.isFetching }
}

/**
 * Searches as the user types. The library answers in milliseconds, so it is asked at once on
 * every short pause; the catalog needs the network and waits for a longer one. The two are
 * ranked on one scale (client-core's `mergeSearch`), so the list waits for both, or for
 * `CATALOG_WAIT_MS` after the library's, with the last results kept (faded) meanwhile; a slower
 * catalog answer then joins the list where its rows rank. Results never show under a query
 * they do not answer.
 */
export function useMergedSearch(typed: string, { catalog: withCatalog = true, playlists }: { catalog?: boolean; playlists?: readonly PlaylistSummary[] } = {}): SearchState {
  const viewer = useViewer()
  const term = typed.trim()
  // What is in the field when the page opens is asked at once: answers already cached (Back to
  // the search page) then show on the first frame instead of after the debounce.
  // What is typed settles before it is trimmed: a space just typed means more is coming, so
  // "blue " does not ask for "blue" on the way to "blue hour".
  const library = useAnswer('library', useDebounced(typed, 60, typed).trim())
  const catalog = useAnswer('catalog', useDebounced(withCatalog ? typed : '', 250, withCatalog ? typed : '').trim())

  const exactLibrary = library.answer?.term === term ? library.answer : null
  const exactCatalog = withCatalog && catalog.answer?.term === term ? catalog.answer : null
  const catalogPending = withCatalog && !exactCatalog
  // The library's answer has waited long enough for the catalog's.
  const [waited, setWaited] = useState<string | null>(null)
  useEffect(() => {
    if (!exactLibrary || !catalogPending) return
    const timer = setTimeout(() => setWaited(exactLibrary.term), CATALOG_WAIT_MS)
    return () => clearTimeout(timer)
  }, [exactLibrary, catalogPending])

  const current = useMemo(() => {
    if (!term) return null
    const ready = exactCatalog || (exactLibrary && (!catalogPending || waited === term))
    if (!ready) return null
    const options = { query: term, ...(playlists ? { playlists: { query: term, items: playlists } } : {}) }
    return {
      term,
      complete: !catalogPending,
      results: mergeSearch(exactLibrary?.data, exactCatalog?.data, viewer, options),
      catalogFailed: Boolean(exactCatalog?.failed),
      failed: Boolean(exactLibrary?.failed && (!withCatalog || exactCatalog?.failed)),
      unavailable: exactLibrary?.data === null && !exactLibrary.failed && (!withCatalog || (exactCatalog?.data === null && !exactCatalog.failed)),
    }
  }, [term, exactLibrary, exactCatalog, catalogPending, waited, withCatalog, playlists, viewer])

  // Once both answers are in, a later answer for the same query (refetched after music became
  // playable, or after a play) keeps the rows where they were shown.
  const [order, setOrder] = useState<{ term: string; keys: string[] } | null>(null)
  const steady = useMemo(() => {
    if (!current?.complete) return current
    const kept = keepOrder(current.results.items, order?.term === current.term ? order.keys : null)
    return { ...current, results: { ...current.results, items: kept.items }, order: kept.order }
  }, [current, order])
  if (steady && 'order' in steady && (order?.term !== steady.term || order.keys.join() !== steady.order.join())) {
    setOrder({ term: steady.term, keys: steady.order })
  }

  // The last results shown, which stand in (faded) while the next query's are on their way.
  const [shown, setShown] = useState(steady)
  if (steady && steady !== shown) setShown(steady)

  const retry = useEventCallback(() => {
    void library.refetch()
    if (withCatalog) void catalog.refetch()
  })
  // Only a failure shown is said to be asked again, so answers in flight otherwise make no new object.
  const retrying = Boolean(steady && (steady.failed || steady.catalogFailed) && (library.fetching || (withCatalog && catalog.fetching)))
  // One object per answer, so views can tell new results from a render.
  return useMemo(() => {
    const base = { catalogPending, retry, retrying: false, catalogFailed: false, failed: false, unavailable: false }
    if (!term) return { ...base, results: null, stale: false, catalogPending: false }
    if (steady) return { ...base, results: steady.results, stale: false, catalogFailed: steady.catalogFailed, failed: steady.failed, unavailable: steady.unavailable, retrying }
    // Only the same search typed on or deleted back stands in, never an unrelated one.
    if (shown?.results && shown.term !== term && continuesQuery(term, shown.term)) return { ...base, results: { ...shown.results, top: null }, stale: true }
    return { ...base, results: null, stale: false }
  }, [term, steady, shown, catalogPending, retry, retrying])
}

/** Rows per page of one kind; the server answers at most 50. */
export const SEARCH_PAGE_SIZE = 30
/** The contract's largest offset. */
const lastOffset = 450

/** One page of a filter's results; it says what it answers, since another filter's or term's pages stand in while one loads. */
type Page = { term: string; kind: SearchKind; offset: number; library: SearchResults | null; catalog: SearchResults | null; catalogFailed: boolean }

const listOf = (answer: SearchResults | null, kind: SearchKind) =>
  (answer ? kind === 'artist' ? answer.artists : kind === 'album' ? answer.albums : answer.tracks : [])

/**
 * One kind's results for a filter, page by page: each page is the library's and the
 * catalog's next `SEARCH_PAGE_SIZE` of that kind, ranked together. The last term's pages
 * stay (faded) while a new term's first page loads, when the new term is the old one typed on
 * or deleted back; another kind's pages or an unrelated term's never stand in. A page that
 * fails after the first stops the paging until it is asked for again (`moreFailed`).
 */
export function useSearchPages(typed: string, kind: SearchKind | null) {
  const api = useApi()
  const viewer = useViewer()
  const term = useDebounced(typed, 250, typed).trim()
  const query = useInfiniteQuery({
    queryKey: [...queryKeys.search(), 'pages', kind, term],
    enabled: kind !== null && term.length > 0,
    initialPageParam: 0,
    queryFn: async ({ pageParam: offset, signal }): Promise<Page> => {
      const params = { q: term, limit: SEARCH_PAGE_SIZE, type: kind!, offset }
      const [library, catalog] = await Promise.allSettled([api.search.library(params, { signal }), api.search.catalog(params, { signal })])
      if (library.status === 'rejected' && catalog.status === 'rejected') throw library.reason
      const value = (result: PromiseSettledResult<SearchResults>) => (result.status === 'fulfilled' ? result.value : null)
      // A server without search answers 404 for both: an empty page.
      const missing = (result: PromiseSettledResult<SearchResults>) => result.status === 'rejected' && isNotFound(result.reason)
      return { term, kind: kind!, offset, library: value(library), catalog: value(catalog), catalogFailed: catalog.status === 'rejected' && !missing(catalog) }
    },
    getNextPageParam: (last: Page, pages: Page[]) => {
      const full = [last.library, last.catalog].some(answer => listOf(answer, kind!).length >= SEARCH_PAGE_SIZE)
      const next = last.offset + SEARCH_PAGE_SIZE
      // An older server ignores `offset` and answers the first page again: nothing new, so the end.
      const earlier = new Set(pages.slice(0, -1).flatMap(page => [page.library, page.catalog].flatMap(answer => listOf(answer, kind!).map(item => item.id))))
      const fresh = [last.library, last.catalog].some(answer => listOf(answer, kind!).some(item => !earlier.has(item.id)))
      return full && fresh && next <= lastOffset ? next : undefined
    },
    placeholderData: keepPreviousData,
    staleTime: 60_000,
    retry: 1,
    meta: { silent: true },
  })
  const items = useMemo(() => {
    const seen = new Set<string>()
    const list: SearchItem[] = []
    for (const page of query.data?.pages ?? []) {
      for (const item of mergeSearch(page.library, page.catalog, viewer, { query: term }).items) {
        const key = searchItemKey(item)
        // An older server ignores `type` and answers every kind.
        if (item.type === kind && !seen.has(key)) {
          seen.add(key)
          list.push(item)
        }
      }
    }
    return list
  }, [query.data, viewer, kind, term])
  const answered = query.data?.pages[0]
  // Pages kept from another kind or an unrelated term answer nothing that is asked: none stand in.
  const related = answered !== undefined && answered.kind === kind && (answered.term === typed.trim() || continuesQuery(typed.trim(), answered.term))
  return {
    items: related ? items : null,
    /** The pages shown are another term's, kept while this one's load. */
    stale: query.isPlaceholderData || term !== typed.trim(),
    loading: query.isFetching && !query.isFetchingNextPage,
    loadingMore: query.isFetchingNextPage,
    hasMore: Boolean(query.hasNextPage),
    loadMore: () => void query.fetchNextPage(),
    failed: query.isError && !query.data,
    /**
     * The next page failed (after its one retry). The list stops asking for it as its end comes
     * into view, which would retry it without end, until `loadMore` is called again.
     */
    moreFailed: query.isFetchNextPageError,
    error: query.error,
    catalogFailed: query.data?.pages.some(page => page.catalogFailed) ?? false,
    retry: () => void query.refetch(),
  }
}

/** The viewer's playlists whose name matches, best first. */
export function matchingPlaylists(query: string, playlists: readonly PlaylistSummary[]): SearchItem[] {
  return playlists
    .map(playlist => ({ playlist, score: playlistScore(query, playlist.name) }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ playlist }) => ({ type: 'playlist', playlist }))
}
