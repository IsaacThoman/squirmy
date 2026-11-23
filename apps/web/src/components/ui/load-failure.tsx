import type { ReactNode } from 'react'
import { LoadError, type QueryLike } from './query-state'

/**
 * The `LoadError` for a query whose first answer failed, or undefined while it loads or once it
 * answered. For views that take their data as props: the page hands them this beside the data, and
 * they show it where they would show their skeleton. (A file of its own: fast refresh needs
 * `query-state.tsx` to export only components.)
 */
export function loadFailure(query: QueryLike<unknown>, title: string, className?: string): ReactNode | undefined {
  if (query.data !== undefined || !query.error) return undefined
  return <LoadError title={title} error={query.error} className={className} retrying={query.isFetching} onRetry={() => void query.refetch()} />
}
