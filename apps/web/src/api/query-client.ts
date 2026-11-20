import { ApiError } from '@squirmy/client-core'
import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query'
import { errorMessage } from '@/api/errors'
import { signedOut } from '@/auth/session'
import { toast } from '@/lib/toast'

declare module '@tanstack/react-query' {
  interface Register {
    /** `silent`: the screen shows the failure itself. */
    queryMeta: { silent?: boolean }
    /** `inline`: the form shows the failure next to its fields. */
    mutationMeta: { inline?: boolean }
  }
}

const isUnauthorized = (error: unknown) => error instanceof ApiError && error.status === 401
/** Client errors will not change on a retry; network failures and 5xx might. */
const retriable = (error: unknown) => !(error instanceof ApiError) || error.status === 0 || error.status >= 500

/**
 * A 401 anywhere means the session ended (logged out elsewhere, password changed,
 * account disabled): the route guards then show sign-in. Other failures become a toast
 * with the server's message, except background refetches, which keep showing what they had.
 */
export function createQueryClient(): QueryClient {
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        if (isUnauthorized(error)) return signedOut(client)
        if (query.meta?.silent || query.state.data !== undefined) return
        toast({ title: errorMessage(error) })
      },
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        if (isUnauthorized(error)) return signedOut(client)
        if (!mutation.meta?.inline) toast({ title: errorMessage(error) })
      },
    }),
    defaultOptions: {
      queries: { staleTime: 30_000, retry: (failures, error) => failures < 2 && retriable(error) },
      mutations: { retry: false },
    },
  })
  return client
}
