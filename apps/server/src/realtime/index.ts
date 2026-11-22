import { fastifyCookie } from '@fastify/cookie'
import type { ServerEvent } from '@squirmy/contracts'
import type { FastifyInstance } from 'fastify'
import { Server } from 'socket.io'
import { devOrigins, getConfig } from '../config.js'
import { getSql } from '../database/client.js'
import { SESSION_COOKIE } from '../lib/auth.js'
import { dropCachedReads } from '../lib/read-cache.js'
import { authenticateToken } from '../modules/auth/service.js'
import type { Realtime, RealtimeServer, RealtimeSocket, RealtimeTarget } from './types.js'

export type { Realtime, RealtimeServer, RealtimeSocket, RealtimeTarget, SocketData } from './types.js'

type QueryKey = readonly unknown[]

/** One target, or several whose sockets each get a message once, even in more than one of them. */
type Targets = RealtimeTarget | readonly RealtimeTarget[]

type Message =
  | { kind: 'event'; target: Targets; event: ServerEvent }
  | { kind: 'invalidate'; target: Targets; keys: QueryKey[] }
  | { kind: 'disconnect'; userId: string; only?: string; except?: string }

const channel = 'squirmy_events'
// Postgres rejects NOTIFY payloads of 8000 bytes or more.
const maxPayloadBytes = 7900

async function notify(message: Message) {
  const payload = JSON.stringify(message)
  if (Buffer.byteLength(payload) > maxPayloadBytes) throw new Error(`Realtime message too large (${message.kind})`)
  await getSql()`select pg_notify(${channel}, ${payload})`
}

/**
 * Sends `event` to the targets' sockets, once per socket however many targets it is in (an
 * admin is in their own room and in `admins`). Works from any process.
 */
export async function publish(target: Targets, event: ServerEvent) {
  await notify({ kind: 'event', target, event })
}

/** Tells the target's clients to refetch these query keys. Works from any process. */
export async function invalidate(target: Targets, keys: readonly QueryKey[]) {
  // At once in this process, so a client that refetches right after its own change never
  // gets the cached answer; other processes drop theirs when the NOTIFY arrives.
  dropCachedReads(target, keys)
  // Keys that do not fit in one notification are split across several.
  const base = Buffer.byteLength(JSON.stringify({ kind: 'invalidate', target, keys: [] }))
  let batch: QueryKey[] = []
  let size = base
  for (const key of keys) {
    const keySize = Buffer.byteLength(JSON.stringify(key)) + 1
    if (batch.length > 0 && size + keySize > maxPayloadBytes) {
      await notify({ kind: 'invalidate', target, keys: batch })
      batch = []
      size = base
    }
    batch.push(key)
    size += keySize
  }
  if (batch.length > 0) await notify({ kind: 'invalidate', target, keys: batch })
}

/**
 * Closes a user's sockets so they reconnect with fresh credentials: all of them, only those
 * of one auth session, or all except one. Works from any process.
 */
export async function disconnectSockets(userId: string, filter: { only?: string; except?: string } = {}) {
  await notify({ kind: 'disconnect', userId, ...filter })
}

/**
 * Whether a handshake that authenticates with the session cookie comes from the app's own
 * pages. WebSocket handshakes get no CORS check, and SameSite=Lax still sends the cookie
 * from sibling subdomains, so a page there could otherwise act as the visitor. Requests
 * without an Origin are not from a cross-origin page: browsers send it on every WebSocket
 * handshake and every cross-origin request.
 */
export function allowedCookieOrigin(origin: string | undefined, host: string | undefined, config: { PUBLIC_URL?: string; devCors: boolean }): boolean {
  if (origin === undefined) return true
  let parsed: URL
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (host !== undefined && parsed.host === host.toLowerCase()) return true
  if (config.PUBLIC_URL && parsed.origin === new URL(config.PUBLIC_URL).origin) return true
  return config.devCors && devOrigins.includes(parsed.origin)
}

/** setTimeout's ceiling (about 24.8 days); later expiries are checked again then. */
const maxTimerMs = 2 ** 31 - 1

function room(target: RealtimeTarget) {
  return target === 'admins' || target === 'all' ? target : `user:${target.user}`
}

/** The sockets of the targets. socket.io emits once per socket across the rooms of one `to`. */
function audience(io: RealtimeServer, target: Targets) {
  const targets: readonly RealtimeTarget[] = Array.isArray(target) ? target : [target as RealtimeTarget]
  return targets.includes('all') ? io : io.to(targets.map(room))
}

function deliver(io: RealtimeServer, message: Message) {
  // Before the clients hear of it, so their refetch cannot be answered from the cache.
  if (message.kind === 'invalidate') dropCachedReads(message.target, message.keys)
  if (message.kind === 'disconnect') {
    for (const socket of io.of('/').sockets.values()) {
      const { userId, authSessionId } = socket.data
      if (userId !== message.userId) continue
      if (message.only && authSessionId !== message.only) continue
      if (message.except && authSessionId === message.except) continue
      socket.disconnect(true)
    }
    return
  }
  const sockets = audience(io, message.target)
  if (message.kind === 'event') sockets.emit('event', message.event)
  else sockets.emit('invalidate', { keys: message.keys })
}

/**
 * Attaches socket.io to the app's HTTP server and starts forwarding NOTIFY messages to
 * rooms. Call before the app listens; closing the app closes both.
 */
export async function startRealtime(app: FastifyInstance): Promise<Realtime> {
  const config = getConfig()
  const handlers: ((socket: RealtimeSocket) => void | Promise<void>)[] = []
  const io: RealtimeServer = new Server(app.server, {
    path: '/socket.io',
    serveClient: false,
    // `session:queue` carries the whole queue (about 150 bytes an entry) on every queue
    // change; compressed it is a tenth of that. Small messages are not worth deflating.
    perMessageDeflate: { threshold: 1024 },
    cors: config.devCors ? { origin: devOrigins, credentials: true } : undefined,
    // Socket.io's default, stated: the largest session command (5000 queue seeds) is
    // about 750 KB of JSON.
    maxHttpBufferSize: 1_000_000,
  })

  io.use(async (socket, next) => {
    const fromAuth = (socket.handshake.auth as { token?: unknown }).token
    const cookie = socket.handshake.headers.cookie
    const viaCookie = typeof fromAuth !== 'string'
    const token = viaCookie ? cookie ? fastifyCookie.parse(cookie)[SESSION_COOKIE] : undefined : fromAuth
    if (viaCookie && token && !allowedCookieOrigin(socket.handshake.headers.origin, socket.handshake.headers.host, config)) {
      return next(new Error('unauthorized'))
    }
    try {
      const session = token ? await authenticateToken(token) : null
      if (!session) return next(new Error('unauthorized'))
      socket.data = { userId: session.user.id, role: session.user.role, authSessionId: session.sessionId, expiresAt: session.expiresAt.getTime() }
      next()
    } catch (error) {
      app.log.error({ err: error }, 'Socket authentication failed')
      next(new Error('unauthorized'))
    }
  })

  io.on('connection', (socket) => {
    // A socket authenticated once would otherwise outlive its session's natural expiry;
    // the client reconnects and authenticates again, which renews a session still in use.
    let expiry: NodeJS.Timeout | undefined
    const expireAt = () => {
      const remaining = socket.data.expiresAt - Date.now()
      if (remaining <= 0) return void socket.disconnect(true)
      expiry = setTimeout(expireAt, Math.min(remaining, maxTimerMs))
      expiry.unref()
    }
    expireAt()
    socket.once('disconnect', () => clearTimeout(expiry))
    void socket.join(`user:${socket.data.userId}`)
    if (socket.data.role === 'admin') void socket.join('admins')
    socket.on('time:sync', (clientTime, ack) => {
      if (typeof ack === 'function') ack({ clientTime, serverTime: Date.now() })
    })
    // Handlers run synchronously up to their first await, so listeners they add before it
    // see the first events the client sends.
    const failed = (error: unknown) => app.log.error({ err: error }, 'Socket connection handler failed')
    for (const handler of handlers) {
      try {
        void Promise.resolve(handler(socket)).catch(failed)
      } catch (error) {
        failed(error)
      }
    }
  })

  const listener = await getSql().listen(channel, (payload) => {
    try {
      deliver(io, JSON.parse(payload) as Message)
    } catch (error) {
      app.log.error({ err: error }, 'Could not deliver a realtime message')
    }
  })

  app.addHook('preClose', async () => {
    await listener.unlisten()
    // Also closes the HTTP server, which Fastify tolerates when it closes it next.
    await io.close()
  })

  return { io, onConnection: (handler) => void handlers.push(handler) }
}
