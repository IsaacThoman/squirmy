import { ApiError } from '@squirmy/client-core'
import { MutationCache, notifyManager, QueryCache, QueryClient } from '@tanstack/react-query'
import { signedOut } from '@/auth/session'

// The cache tells its observers about a change in a microtask, not the library's default
// zero-delay timeout. An optimistic update (the heart, a playlist change) then reaches the
// screen before the browser paints the frame of the click: with a timeout the heart showed
// its old state for a frame, and a check right after the click (the providers e2e script)
// saw it empty. Changes in one task are still batched into one notification.
notifyManager.setScheduler(queueMicrotask)

const isUnauthorized = (error: unknown) => error instanceof ApiError && error.status === 401
/** Client errors will not change on a retry; network failures and 5xx might. */
const retriable = (error: unknown) => !(error instanceof ApiError) || error.status === 0 || error.status >= 500

/**
 * A 401 anywhere means the session ended (logged out elsewhere, password changed,
 * account disabled): the route guards then show sign-in. Every other failure is shown where it
 * happened: a page's read by its `QueryState` or `loadFailure`, an action by the control, form or
 * player status line that started it. A background refetch keeps showing what it had.
 */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: error => {
        if (isUnauthorized(error)) signedOut(client)
      },
    }),
    mutationCache: new MutationCache({
      onError: error => {
        if (isUnauthorized(error)) signedOut(client)
      },
    }),
    defaultOptions: {
      // Pages stay in memory for a day so the persisted cache (api/persist.ts) keeps what was visited.
      queries: { staleTime: 30_000, gcTime: 24 * 60 * 60 * 1000, retry: (failures, error) => failures < 2 && retriable(error) },
      mutations: { retry: false },
    },
  })
  return client
}
