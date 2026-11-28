import { ApiError, type ApiClient } from '@squirmy/client-core'
import { queryKeys, type SetupStatus, type User } from '@squirmy/contracts'
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { createContext, useContext } from 'react'
import { useApi } from '@/api/services'

export const setupStatusKey = queryKeys.setupStatus()
const isAuthKey = (key: readonly unknown[]) => key.length === 1 && (key[0] === setupStatusKey[0] || key[0] === queryKeys.me()[0])

export function useSetupStatus() {
  const api = useApi()
  return useQuery({ queryKey: setupStatusKey, queryFn: () => api.auth.setupStatus() })
}

/** Whether the server has the wantlist on. Off (the default), the app shows no trace of it. */
export function useWantlistEnabled() {
  return useSetupStatus().data?.wantlistEnabled ?? false
}

/** Whether the server lets members make public share links. Off, nothing offers Share. */
export function useSharingEnabled() {
  return useSetupStatus().data?.sharingEnabled ?? false
}

// Set while this browser has signed out but the server has not heard: it was out of reach. The
// session cookie is the server's to end, so until it does this browser counts itself signed out,
// and asks it again each time it would have asked who is signed in.
const signOutPendingKey = 'squirmy.signOutPending'
const storage = () => { try { return window.localStorage } catch { return null } }
export function signOutPending(): boolean {
  try { return storage()?.getItem(signOutPendingKey) === '1' } catch { return false }
}
export function setSignOutPending(pending: boolean) {
  try {
    if (pending) storage()?.setItem(signOutPendingKey, '1')
    else storage()?.removeItem(signOutPendingKey)
  } catch { /* Without storage the sign-out lasts until the page reloads. */ }
}

/** Ends a sign-out the server missed. It is done once the server answers: a 401 too means the session is gone. */
async function finishSignOut(api: ApiClient) {
  await api.auth.logout().then(
    () => setSignOutPending(false),
    (error: unknown) => { if (error instanceof ApiError && error.status === 401) setSignOutPending(false) },
  )
}

// Set while this browser signs out on purpose. The server closes the session's socket as it
// ends it, and the session check that follows finds nobody signed in: no reason to say it ended.
let signingOut = false
export function setSigningOut(value: boolean) {
  signingOut = value
}

/** The signed-in user, or null when signed out. */
export function useMe() {
  const api = useApi()
  const client = useQueryClient()
  return useQuery({
    queryKey: queryKeys.me(),
    queryFn: async () => {
      if (signOutPending()) {
        await finishSignOut(api)
        return null
      }
      return api.auth.me().catch((error: unknown) => {
        if (!(error instanceof ApiError && error.status === 401)) throw error
        // Signed in until now, so the server ended the session (signed out elsewhere, the
        // password changed, the account disabled; the socket closing is what asks): sign-in says so.
        if (!signingOut) signedOut(client)
        return null
      })
    },
  })
}

/** Why sign-in is showing, when it is not the visitor's own doing. */
export type SignInNotice = 'expired' | 'unreachable'
const signInNoticeKey = ['signInNotice'] as const
export const signInNotices: Record<SignInNotice, string> = {
  expired: 'Your session ended. Sign in again to keep listening.',
  unreachable: 'You’re signed out on this browser. The server couldn’t be reached, so it ends the session once it can.',
}

/** What sign-in says about how the visitor got there, if anything. */
export function useSignInNotice(): string | null {
  const { data } = useQuery<SignInNotice | null>({ queryKey: signInNoticeKey, queryFn: () => null, enabled: false, staleTime: Infinity })
  return data ? signInNotices[data] : null
}

/**
 * Switches the cached session to `user`. Everything cached for the previous user is
 * dropped first so nothing of theirs shows for the next one. Signed out, sign-in says
 * `notice` when given.
 */
export function setSignedInUser(client: QueryClient, user: User | null, notice?: SignInNotice) {
  client.removeQueries({ predicate: query => !isAuthKey(query.queryKey) })
  if (user) setSignOutPending(false)
  else if (notice) client.setQueryData(signInNoticeKey, notice)
  client.setQueryData(queryKeys.me(), user)
}

/** The first admin exists now; the cached status says so without asking again. */
export function setSetupDone(client: QueryClient) {
  client.setQueryData<SetupStatus>(setupStatusKey, status => status && { ...status, needsSetup: false })
}

/** The server no longer accepts this browser's session: sign-in says so, as the iOS app does. */
export function signedOut(client: QueryClient) {
  if (client.getQueryData(queryKeys.me())) setSignedInUser(client, null, 'expired')
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
