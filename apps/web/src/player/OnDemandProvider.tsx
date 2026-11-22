import { queryKeys } from '@squirmy/contracts'
import { useQueryClient } from '@tanstack/react-query'
import { useMemo, type ReactNode } from 'react'
import { useCurrentUser } from '@/auth/session'
import { useServerEvent } from '@/realtime/realtime-context'
import { OnDemandContext, type OnDemand } from './on-demand-context'

const ended = (status: string) => status === 'completed' || status === 'failed' || status === 'rejected'

/**
 * Music the server fetches for the signed-in user. A fetch that ends refreshes its track, so
 * a song that could not be had turns gray wherever it shows. Fetching is never told on its
 * own: the session's failures are told by the player, for the songs being played.
 */
export function OnDemandProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const user = useCurrentUser()

  useServerEvent('acquisition.updated', event => {
    if (event.trackId && ended(event.status)) void queryClient.invalidateQueries({ queryKey: queryKeys.track(event.trackId) })
  })

  const value = useMemo<OnDemand>(() => ({ viewer: user }), [user])
  return <OnDemandContext value={value}>{children}</OnDemandContext>
}
