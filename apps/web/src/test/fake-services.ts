import { ApiError, type ApiClient } from '@squirmy/client-core'
import type { SquirmySocket } from '@squirmy/client-core/socket'
import type { SetupStatus, User } from '@squirmy/contracts'
import { vi } from 'vitest'
import type { Services } from '@/api/services'
import { appPasswords, currentUser, invites, jobs, serverSettings, users } from '@/fixtures/server'

type Listener = (...args: never[]) => void

/** Enough of a socket.io socket for the realtime provider: events can be fired at it with `serverEmit`. */
export class FakeSocket {
  connected = false
  active = false
  private readonly listeners = new Map<string, Set<Listener>>()

  on(event: string, listener: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set())
    this.listeners.get(event)!.add(listener)
    return this
  }

  off(event: string, listener: Listener) {
    this.listeners.get(event)?.delete(listener)
    return this
  }

  connect() {
    this.active = true
    this.connected = true
    this.serverEmit('connect')
    return this
  }

  disconnect() {
    this.active = false
    if (this.connected) {
      this.connected = false
      this.serverEmit('disconnect', 'io client disconnect')
    }
    return this
  }

  /** Delivers an event as if the server (or socket.io itself) sent it. */
  serverEmit(event: string, ...args: unknown[]) {
    for (const listener of [...(this.listeners.get(event) ?? [])]) (listener as (...values: unknown[]) => void)(...args)
  }
}

const list = <T>(items: T[]) => ({ items, nextCursor: null })

export type FakeOptions = { status?: Partial<SetupStatus>; user?: User | null }

/** An API answering from the fixtures, signed in as the fixture admin unless told otherwise. Every method is a mock. */
export function fakeServices({ status, user = currentUser }: FakeOptions = {}) {
  const socket = new FakeSocket()
  const api = {
    auth: {
      setupStatus: vi.fn(async () => ({ needsSetup: false, version: '0.0.0', serverName: 'Squirmy', registrationRequiresInvite: true, ...status })),
      me: vi.fn(async () => {
        if (user) return user
        throw new ApiError(401, 'unauthorized', 'Sign in to continue')
      }),
      login: vi.fn(async () => ({ user: currentUser, token: 'token' })),
      register: vi.fn(async () => ({ user: currentUser, token: 'token' })),
      setup: vi.fn(async () => ({ user: currentUser, token: 'token' })),
      logout: vi.fn(async () => ({ ok: true as const })),
      changePassword: vi.fn(async () => ({ ok: true as const })),
      appPasswords: vi.fn(async () => list(appPasswords)),
      createAppPassword: vi.fn(async ({ name }: { name: string }) => ({ ...appPasswords[0], name, secret: 'sq-secret' })),
      deleteAppPassword: vi.fn(async () => ({ ok: true as const })),
    },
    admin: {
      users: vi.fn(async () => list(users)),
      createUser: vi.fn(async () => users[1]),
      updateUser: vi.fn(async (id: string, patch: Partial<User>) => ({ ...users.find(candidate => candidate.id === id)!, ...patch })),
      deleteUser: vi.fn(async () => ({ ok: true as const })),
      invites: vi.fn(async () => list(invites)),
      createInvite: vi.fn(async () => invites[0]),
      deleteInvite: vi.fn(async () => ({ ok: true as const })),
      settings: vi.fn(async () => serverSettings),
      updateSettings: vi.fn(async (patch: object) => ({ ...serverSettings, ...patch })),
      jobs: vi.fn(async () => jobs),
      directories: vi.fn(async ({ path }: { path?: string } = {}) => ({
        path: path ?? '/home/alex', parent: '/home', directories: [{ name: 'Music', path: `${path ?? '/home/alex'}/Music` }],
      })),
    },
    library: {
      createRoot: vi.fn(async (): Promise<unknown> => {
        throw new ApiError(404, 'not_found', 'Not found')
      }),
    },
  }
  const services: Services = { api: api as unknown as ApiClient, createSocket: () => socket as unknown as SquirmySocket }
  return { services, api, socket }
}
