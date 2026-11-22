import { apiRoutes } from '@squirmy/client-core'
import { API_PREFIX } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { describe, expect, it, vi } from 'vitest'
import { buildApp } from './app.js'
import { useTestDatabase } from './test/database.js'

/** Every route the app registers, seen through an `onRoute` hook on the instance `buildApp` creates. */
const registered = vi.hoisted(() => [] as { method: string; url: string }[])
vi.mock('fastify', async (load) => {
  const actual = await load<typeof import('fastify')>()
  const create = ((...args: unknown[]) => {
    const app = (actual.default as (...options: unknown[]) => FastifyInstance)(...args)
    app.addHook('onRoute', (route) => {
      for (const method of [route.method].flat()) registered.push({ method, url: route.url })
    })
    return app
  }) as typeof actual.default
  return { ...actual, default: create }
})

/** Native routes clients never call through the API client, and why. */
const notForClients = new Set([
  // Signed URLs from a playback descriptor; `streamUrl` resolves them.
  'GET /stream/:',
  'GET /stream/:/:',
  // Plain image URLs, built by `artworkUrl`.
  'GET /art/:/:',
  // Last.fm sends the browser here after the user approves the connection.
  'GET /scrobbling/lastfm/callback',
  // Acquisition providers deliver here with their job's token (docs/provider-protocol.md).
  'POST /acquisition/deliveries/:/files',
  'POST /acquisition/deliveries/:/complete',
  // Deprecated aliases of PUT/DELETE /me/likes/:type/:id for app builds from before the
  // single heart; current clients save with the heart.
  'PUT /me/library/:/:',
  'DELETE /me/library/:/:',
])

/**
 * Client methods that landed with their contracts before the server route, so clients can
 * build against them. Each entry fails the test once the server registers it: whoever adds
 * the route deletes its line.
 */
const awaitingServer = new Set<string>([])

/** `METHOD /path` with every parameter written as `:`, so names do not have to agree. */
const normalize = (route: string) => route.replace(/:\w+/g, ':')

describe('the API client', () => {
  useTestDatabase()

  it('has a method for every native route, and calls only routes that exist', async () => {
    const app = await buildApp()
    await app.ready()
    const native = new Set(registered
      // HEAD comes with every GET; OPTIONS is CORS.
      .filter((route) => route.url.startsWith(`${API_PREFIX}/`) && route.method !== 'HEAD' && route.method !== 'OPTIONS')
      .map((route) => normalize(`${route.method} ${route.url.slice(API_PREFIX.length)}`)))
    await app.close()
    const covered = new Set(Object.values(apiRoutes).map(normalize))

    expect([...native].filter((route) => !covered.has(route) && !notForClients.has(route)).sort(), 'routes with no client method').toEqual([])
    expect([...covered].filter((route) => !native.has(route) && !awaitingServer.has(route)).sort(), 'client methods with no route').toEqual([])
    expect([...notForClients].filter((route) => !native.has(route)), 'stale exceptions').toEqual([])
    expect([...awaitingServer].filter((route) => native.has(route) || !covered.has(route)), 'routes no longer awaiting the server').toEqual([])
  })
})
