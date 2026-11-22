import { ApiError } from '@squirmy/client-core'
import { queryKeys, type SetupStatus, type User } from '@squirmy/contracts'
import { useQuery, type QueryClient } from '@tanstack/react-query'
import { createContext, useContext } from 'react'
import { useApi } from '@/api/services'

export const setupStatusKey = ['setup-status'] as const
const isAuthKey = (key: readonly unknown[]) => key.length === 1 && (key[0] === setupStatusKey[0] || key[0] === queryKeys.me()[0])

export function useSetupStatus() {
  const api = useApi()
  return useQuery({ queryKey: setupStatusKey, queryFn: () => api.auth.setupStatus(), meta: { silent: true } })
}

/** The signed-in user, or null when signed out. */
export function useMe() {
  const api = useApi()
  return useQuery({
    queryKey: queryKeys.me(),
    queryFn: () => api.auth.me().catch((error: unknown) => {
      if (error instanceof ApiError && error.status === 401) return null
      throw error
    }),
    meta: { silent: true },
  })
}

/**
 * Switches the cached session to `user`. Everything cached for the previous user is
 * dropped first so nothing of theirs shows for the next one.
 */
export function setSignedInUser(client: QueryClient, user: User | null) {
  client.removeQueries({ predicate: query => !isAuthKey(query.queryKey) })
  client.setQueryData(queryKeys.me(), user)
}

/** The first admin exists now; the cached status says so without asking again. */
export function setSetupDone(client: QueryClient) {
  client.setQueryData<SetupStatus>(setupStatusKey, status => status && { ...status, needsSetup: false })
}

/** The server no longer accepts this browser's session. */
export function signedOut(client: QueryClient) {
  if (client.getQueryData(queryKeys.me())) setSignedInUser(client, null)
}

export const CurrentUserContext = createContext<User | null>(null)

/** The signed-in user. Only valid inside the signed-in routes. */
export function useCurrentUser(): User {
  const user = useContext(CurrentUserContext)
  if (!user) throw new Error('useCurrentUser needs a signed-in route')
  return user
}

/** Where to go after signing in: a path inside the app, never another origin. */
export function safeNext(next: string | null): string {
  if (!next) return '/'
  try {
    // Parsed as the browser will, so backslashes, tabs and newlines cannot turn it into another origin.
    const url = new URL(next, window.location.origin)
    return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : '/'
  } catch {
    return '/'
  }
}
