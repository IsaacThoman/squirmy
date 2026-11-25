import { ApiError } from '@squirmy/client-core'
import { queryKeys, type User } from '@squirmy/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { forgetPersistedCache } from '@/api/persist'
import { useApi } from '@/api/services'
import { setSignedInUser, setSignOutPending } from './session'

/**
 * Ends this browser's session. The pages kept for the next visit are deleted, then the page
 * reloads at sign-in, which drops the rest from memory: cached data, the socket, the audio engine.
 *
 * When the server can't be reached, this browser signs out all the same, as the iOS app does:
 * sign-in shows at once and says why, and the server is told the next time the app asks it who
 * is signed in. Without a reload, since the page would load to "Can’t reach the server".
 */
export function useLogout(): () => void {
  const api = useApi()
  const queryClient = useQueryClient()
  const { mutate } = useMutation({
    mutationFn: async () => {
      // A 401 means the server has ended the session already.
      const reached = await api.auth.logout().then(() => true, (error: unknown) => error instanceof ApiError && error.status === 401)
      await forgetPersistedCache(queryClient.getQueryData<User | null>(queryKeys.me())?.id)
      return reached
    },
    onSuccess: reached => {
      if (reached) return window.location.replace('/login')
      setSignOutPending(true)
      setSignedInUser(queryClient, null, 'unreachable')
    },
  })
  return () => mutate()
}
