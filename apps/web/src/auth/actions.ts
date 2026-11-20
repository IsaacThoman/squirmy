import { useMutation } from '@tanstack/react-query'
import { useApi } from '@/api/services'

/**
 * Ends this browser's session. The page then reloads at sign-in, which also drops every
 * trace of the session from memory: cached data, the socket, the audio engine.
 */
export function useLogout(): () => void {
  const api = useApi()
  const { mutate } = useMutation({ mutationFn: () => api.auth.logout(), onSuccess: () => window.location.replace('/login') })
  return () => mutate()
}
