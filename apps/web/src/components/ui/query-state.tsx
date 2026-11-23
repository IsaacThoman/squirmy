import { CloudOff, RotateCw } from 'lucide-react'
import type { ReactNode } from 'react'
import { errorMessage } from '@/api/errors'
import { cn } from '@/lib/utils'
import { Button } from './button'
import { EmptyState } from './feedback'

/** What a query state needs of a TanStack query, so both plain and infinite queries fit. */
export type QueryLike<T> = {
  data: T | undefined
  error: unknown
  isFetching: boolean
  refetch: () => unknown
}

type LoadErrorProps = {
  /** What did not load, as a sentence: "Your app passwords did not load". */
  title: string
  error?: unknown
  onRetry: () => void
  /** The retry is in flight: the button shows it and cannot be pressed twice. */
  retrying?: boolean
  /**
   * `page` fills a page with the shared empty-state layout. `section` is a quiet box in the place
   * of the panel or list that failed, so the parts of the screen that did load stay usable.
   */
  variant?: 'page' | 'section'
  /** The page variant's heading level: 1 when nothing else titles the page, 2 under a page header. */
  headingLevel?: 1 | 2
  className?: string
}

/**
 * A failed read, said where its content would be, with a way to try again. Every screen uses this
 * rather than leaving its skeleton up: a skeleton says "wait", and after a failure waiting does
 * nothing.
 */
export function LoadError({ title, error, onRetry, retrying = false, variant = 'section', headingLevel = 1, className }: LoadErrorProps) {
  const description = error === undefined ? undefined : errorMessage(error)
  const retry = <Button variant={variant === 'page' ? 'primary' : 'outline'} size={variant === 'page' ? 'md' : 'sm'} pending={retrying} onClick={onRetry}>{!retrying && <RotateCw />}Try again</Button>
  if (variant === 'page') {
    return <div role="alert"><EmptyState icon={<CloudOff />} title={title} description={description} action={retry} headingLevel={headingLevel} className={className} /></div>
  }
  return (
    <div role="alert" className={cn('flex flex-col items-start gap-3 rounded-lg border border-dashed px-4 py-4 sm:flex-row sm:items-center', className)}>
      <CloudOff aria-hidden className="size-5 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{title}</p>
        {description && <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>}
      </div>
      {retry}
    </div>
  )
}

type QueryStateProps<T> = {
  query: QueryLike<T>
  /** Shown until the first answer. */
  loading: ReactNode
  /** Said when the first answer failed; see `LoadError`. */
  errorTitle: string
  variant?: LoadErrorProps['variant']
  errorClassName?: string
  /**
   * Another failure this state handles itself (a 404 that means "Nothing here"). Return a node to
   * show it instead of the retry.
   */
  renderError?: (error: unknown) => ReactNode | undefined
  children: (data: T) => ReactNode
}

/**
 * One query's three states: its skeleton while the first answer is on the way, a retry when it
 * failed, and the content once it came. A failed refetch keeps showing the last answer (the toast
 * or the realtime notice says what went wrong), so content never turns into an error under the
 * reader. Try again puts the skeleton back while it waits: a query with no answer yet drops its
 * error when it fetches again.
 */
export function QueryState<T>({ query, loading, errorTitle, variant, errorClassName, renderError, children }: QueryStateProps<T>) {
  if (query.data !== undefined) return children(query.data)
  if (query.error) {
    const own = renderError?.(query.error)
    if (own !== undefined) return own
    return <LoadError title={errorTitle} error={query.error} variant={variant} className={errorClassName} retrying={query.isFetching} onRetry={() => void query.refetch()} />
  }
  return loading
}
