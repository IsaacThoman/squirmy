import { mergeSearch, type MergedSearch } from '@squirmy/client-core'
import type { SearchResults } from '@squirmy/contracts'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useDebounced } from '@/lib/use-debounced'
import { useViewer } from '@/player/on-demand-context'
import { searchQuery } from './queries'
import { useApi } from './services'

/**
 * One search as the views show it: the library's answer and the catalog's, merged into one
 * set of results for what is typed.
 */
export type SearchState = {
  /** Null until an answer that may be shown has arrived. */
  results: MergedSearch | null
  /**
   * The results answer a shorter query that what is typed starts with: kept on screen while
   * the next answer is on its way so the list does not empty with every key, drawn faded,
   * with no top result and nothing that Enter would open.
   */
  stale: boolean
  /** The catalog's answer for what is typed is still on its way: its results join at the end. */
  catalogPending: boolean
  /** Neither search exists on this server. */
  unavailable: boolean
}

type Answer = { term: string; data: SearchResults | null }

/** The last answer the query gave for the term it was asked, never a placeholder kept from another term. */
function useAnswer(kind: 'library' | 'catalog', term: string) {
  const query = useQuery({ ...searchQuery(useApi(), kind, term), placeholderData: keepPreviousData, meta: { silent: true } })
  const [answer, setAnswer] = useState<Answer | null>(null)
  const fresh = term.length > 0 && !query.isPlaceholderData && query.data !== undefined
  if (fresh && (answer?.term !== term || answer.data !== query.data)) setAnswer({ term, data: query.data })
  return answer
}

const startsWith = (text: string, prefix: string) => text.toLocaleLowerCase().startsWith(prefix.toLocaleLowerCase())

/**
 * Searches as the user types. The library answers in milliseconds, so it is asked at once on
 * every short pause; the catalog needs the network and waits for a longer one. Library
 * results show as soon as they arrive and catalog results are appended after them, so rows on
 * screen do not move when the catalog answers. Results never show under a query they do not
 * answer: while the answer for what is typed is on its way, the last one stays only when it
 * answers the start of it (typing on), faded.
 */
export function useMergedSearch(typed: string, { catalog: withCatalog = true }: { catalog?: boolean } = {}): SearchState {
  const viewer = useViewer()
  const term = typed.trim()
  const library = useAnswer('library', useDebounced(term, 60, ''))
  const catalogTerm = useDebounced(term, 250, '')
  const catalog = useAnswer('catalog', withCatalog ? catalogTerm : '')
  // One object per answer, so views can tell new results from a render.
  return useMemo(() => {
    if (!term) return { results: null, stale: false, catalogPending: false, unavailable: false }
    const exactLibrary = library?.term === term ? library : null
    const exactCatalog = withCatalog && catalog?.term === term ? catalog : null
    const catalogPending = withCatalog && !exactCatalog
    const unavailable = exactLibrary?.data === null && (!withCatalog || exactCatalog?.data === null)
    if (exactLibrary || exactCatalog) {
      return { results: mergeSearch(exactLibrary?.data, exactCatalog?.data, viewer), stale: false, catalogPending, unavailable }
    }
    // Typing on: the shorter query's library results stand in, with no top result of their own.
    if (library?.data && startsWith(term, library.term)) {
      return { results: { ...mergeSearch(library.data, null, viewer), top: null }, stale: true, catalogPending, unavailable: false }
    }
    return { results: null, stale: false, catalogPending, unavailable: false }
  }, [term, library, catalog, withCatalog, viewer])
}
