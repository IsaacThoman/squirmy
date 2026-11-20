import { ConnectListenBrainzRequest, type LastFmConnectStart, type ScrobblingStatus } from '@squirmy/contracts'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { getConfig } from '../../config.js'
import { requireUser } from '../../lib/auth.js'
import { sign, verify } from '../../lib/crypto.js'
import { AppError, badRequest } from '../../lib/errors.js'
import { ProviderError } from '../../lib/http.js'
import { lastfm, listenbrainz } from '../metadata/index.js'
import { removeConnection, saveConnection } from './connections.js'
import { targetAvailable } from './delivery.js'
import { invalidateScrobbling, scrobblingStatus } from './status.js'

/** How long a Last.fm approval may take before its state expires. */
const STATE_TTL_SECONDS = 10 * 60
const statePurpose = 'lastfm-connect-state'

const CallbackQuery = z.object({ state: z.string().optional(), token: z.string().optional() })

/** `<userId>.<expiry in epoch seconds>.<signature>`: binds the callback to the user who started it. */
export function lastFmState(userId: string, now = Date.now()): string {
  const message = `${userId}.${Math.floor(now / 1000) + STATE_TTL_SECONDS}`
  return `${message}.${sign(statePurpose, message)}`
}

/** The user a state was issued to, or null when it is forged or expired. */
export function verifyLastFmState(state: string, now = Date.now()): string | null {
  const [userId, expiry, signature] = state.split('.')
  if (!userId || !expiry || !signature || !verify(statePurpose, `${userId}.${expiry}`, signature)) return null
  return Number(expiry) * 1000 > now ? userId : null
}

/** The server's public origin, for the callback URL Last.fm sends the browser back to. */
function origin(request: FastifyRequest): string {
  const configured = getConfig().PUBLIC_URL
  return configured ? configured.replace(/\/+$/, '') : `${request.protocol}://${request.host}`
}

/** Where the browser lands after the Last.fm approval: the web app's settings page. */
const settingsPage = (outcome: 'connected' | 'denied' | 'invalid_state' | 'error') => `/settings?lastfm=${outcome}`

export async function scrobbleRoutes(app: FastifyInstance) {
  app.get('/me/scrobbling', async (request): Promise<ScrobblingStatus> => scrobblingStatus(requireUser(request).id))

  app.put('/me/scrobbling/listenbrainz', async (request): Promise<ScrobblingStatus> => {
    const user = requireUser(request)
    const { token } = ConnectListenBrainzRequest.parse(request.body)
    const account = await listenbrainz.validateToken(token)
    if (!account) throw badRequest('ListenBrainz did not accept that token', 'invalid_token')
    await saveConnection(user.id, 'listenbrainz', token, account.userName)
    await invalidateScrobbling(user.id)
    return scrobblingStatus(user.id)
  })

  app.delete('/me/scrobbling/listenbrainz', async (request): Promise<ScrobblingStatus> => {
    const user = requireUser(request)
    await removeConnection(user.id, 'listenbrainz')
    await invalidateScrobbling(user.id)
    return scrobblingStatus(user.id)
  })

  app.post('/me/scrobbling/lastfm/start', async (request): Promise<LastFmConnectStart> => {
    const user = requireUser(request)
    const callback = `${origin(request)}/api/v1/scrobbling/lastfm/callback?state=${lastFmState(user.id)}`
    const url = (await targetAvailable('lastfm')) ? await lastfm.getAuthUrl(callback) : null
    if (!url) throw new AppError(409, 'lastfm_not_configured', 'Last.fm is not set up on this server: an admin needs to add an API key and secret')
    return { url }
  })

  // Reached by the browser from Last.fm, possibly one without a Squirmy session (a phone's
  // system browser), so the signed state is what identifies the user.
  app.get('/scrobbling/lastfm/callback', async (request, reply) => {
    const query = CallbackQuery.parse(request.query)
    const userId = query.state ? verifyLastFmState(query.state) : null
    if (!userId || !query.token) return reply.redirect(settingsPage('invalid_state'))
    try {
      const session = await lastfm.getSession(query.token)
      if (!session) return reply.redirect(settingsPage('denied'))
      await saveConnection(userId, 'lastfm', session.sessionKey, session.username)
    } catch (error) {
      if (error instanceof ProviderError) return reply.redirect(settingsPage('error'))
      // The user was deleted since the state was issued.
      if (error instanceof AppError && error.status === 404) return reply.redirect(settingsPage('invalid_state'))
      throw error
    }
    await invalidateScrobbling(userId)
    return reply.redirect(settingsPage('connected'))
  })

  app.delete('/me/scrobbling/lastfm', async (request): Promise<ScrobblingStatus> => {
    const user = requireUser(request)
    await removeConnection(user.id, 'lastfm')
    await invalidateScrobbling(user.id)
    return scrobblingStatus(user.id)
  })
}
