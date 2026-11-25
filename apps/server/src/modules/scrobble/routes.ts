import {
  ConnectListenBrainzRequest, isLastFmReturn, LastFmConnectRequest, type LastFmConnectStart, type LastFmOutcome, type ScrobblingStatus,
} from '@squirmy/contracts'
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

const CallbackQuery = z.object({ state: z.string().optional(), token: z.string().optional(), return: z.string().optional() })

/** What a state signs: the user, the expiry and, for an app, where the browser returns to. */
const stateMessage = (userId: string, expiry: string, returnTo?: string) => returnTo ? `${userId}.${expiry}.${returnTo}` : `${userId}.${expiry}`

/**
 * `<userId>.<expiry in epoch seconds>.<signature>`: binds the callback to the user who started it,
 * and to the app address it returns to (sent next to it as `return`), so neither can be swapped.
 */
export function lastFmState(userId: string, now = Date.now(), returnTo?: string): string {
  const expiry = String(Math.floor(now / 1000) + STATE_TTL_SECONDS)
  return `${userId}.${expiry}.${sign(statePurpose, stateMessage(userId, expiry, returnTo))}`
}

/**
 * What a callback's state vouches for: the user it was issued to (null once it expired) and the
 * return address signed with it. Null when it is forged, or the return address was changed.
 */
export function verifyLastFmState(state: string, returnTo?: string, now = Date.now()): { userId: string | null; returnTo?: string } | null {
  const [userId, expiry, signature, extra] = state.split('.')
  if (!userId || !expiry || !signature || extra !== undefined || !verify(statePurpose, stateMessage(userId, expiry, returnTo), signature)) return null
  if (returnTo !== undefined && !isLastFmReturn(returnTo)) return null
  return { userId: Number(expiry) * 1000 > now ? userId : null, returnTo }
}

/** The server's public origin, for the callback URL Last.fm sends the browser back to. */
function origin(request: FastifyRequest): string {
  const configured = getConfig().PUBLIC_URL
  return configured ? configured.replace(/\/+$/, '') : `${request.protocol}://${request.host}`
}

/** Where the browser lands after the Last.fm approval: the app that started it, else the web app's settings page. */
function settingsPage(outcome: LastFmOutcome, returnTo?: string): string {
  if (!returnTo) return `/settings?lastfm=${outcome}`
  const url = new URL(returnTo)
  url.searchParams.set('lastfm', outcome)
  return url.toString()
}

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
    const { returnTo } = LastFmConnectRequest.parse(request.body ?? {})
    const query = new URLSearchParams({ state: lastFmState(user.id, Date.now(), returnTo), ...(returnTo && { return: returnTo }) })
    const callback = `${origin(request)}/api/v1/scrobbling/lastfm/callback?${query}`
    const url = (await targetAvailable('lastfm')) ? await lastfm.getAuthUrl(callback) : null
    if (!url) throw new AppError(409, 'lastfm_not_configured', 'Last.fm is not set up on this server: an admin needs to add an API key and secret')
    return { url }
  })

  // Reached by the browser from Last.fm, possibly one without a Squirmy session (a phone's
  // browser session), so the signed state is what identifies the user. An app's return address
  // is followed only when the state signs it; a forged one goes to the web app.
  app.get('/scrobbling/lastfm/callback', async (request, reply) => {
    const query = CallbackQuery.parse(request.query)
    const state = query.state ? verifyLastFmState(query.state, query.return) : null
    const land = (outcome: LastFmOutcome) => reply.redirect(settingsPage(outcome, state?.returnTo))
    const userId = state?.userId
    if (!userId || !query.token) return land('invalid_state')
    try {
      const session = await lastfm.getSession(query.token)
      if (!session) return land('denied')
      await saveConnection(userId, 'lastfm', session.sessionKey, session.username)
    } catch (error) {
      if (error instanceof ProviderError) return land('error')
      // The user was deleted since the state was issued.
      if (error instanceof AppError && error.status === 404) return land('invalid_state')
      throw error
    }
    await invalidateScrobbling(userId)
    return land('connected')
  })

  app.delete('/me/scrobbling/lastfm', async (request): Promise<ScrobblingStatus> => {
    const user = requireUser(request)
    await removeConnection(user.id, 'lastfm')
    await invalidateScrobbling(user.id)
    return scrobblingStatus(user.id)
  })
}
