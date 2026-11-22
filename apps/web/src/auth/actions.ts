import { queryKeys, type User } from '@squirmy/contracts'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { forgetPersistedCache } from '@/api/persist'
import { useApi } from '@/api/services'

/**
 * Ends this browser's session. The pages kept for the next visit are deleted, then the page
 * reloads at sign-in, which drops the rest from memory: cached data, the socket, the audio engine.
 */
export function useLogout(): () => void {
  const api = useApi()
  const queryClient = useQueryClient()
  const { mutate } = useMutation({
    mutationFn: () => api.auth.logout(),
    onSuccess: async () => {
      await forgetPersistedCache(queryClient.getQueryData<User | null>(queryKeys.me())?.id)
      window.location.replace('/login')
    },
  })
  return () => mutate()
}
