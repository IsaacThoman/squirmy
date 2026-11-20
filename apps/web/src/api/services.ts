import { createApiClient, type ApiClient } from '@squirmy/client-core'
import type { SquirmySocket } from '@squirmy/client-core/socket'
import { createContext, useContext } from 'react'
import { io } from 'socket.io-client'

/** What the app talks to. Tests swap in fakes. */
export type Services = {
  api: ApiClient
  /** Creates the signed-in user's realtime socket, not yet connected. */
  createSocket: () => SquirmySocket
}

/** Same origin: the page and the API share a host, so the session cookie authenticates both. */
export function createServices(): Services {
  return {
    api: createApiClient({ baseUrl: '', client: 'web', validate: import.meta.env.DEV }),
    createSocket: () => io({ path: '/socket.io', withCredentials: true, autoConnect: false }),
  }
}

export const ServicesContext = createContext<Services | null>(null)

function useServices(): Services {
  const services = useContext(ServicesContext)
  if (!services) throw new Error('useApi needs a ServicesContext')
  return services
}

export function useApi(): ApiClient {
  return useServices().api
}

export function useSocketFactory(): Services['createSocket'] {
  return useServices().createSocket
}
