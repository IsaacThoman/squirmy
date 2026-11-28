import {
  ApproveTvPairing, LookupTvPairing, pairingAlphabet, PollTvPairing, StartTvPairing,
  type Ok, type TvPairing, type TvPairingPoll, type TvPairingPreview,
} from '@squirmy/contracts'
import { and, eq, gt, isNull, lte } from 'drizzle-orm'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { randomInt } from 'node:crypto'
import { renderSVG } from 'uqr'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { authSessions, tvPairings, users } from '../../database/schema.js'
import { requireUser } from '../../lib/auth.js'
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js'
import { hashToken, randomToken, sign } from '../../lib/crypto.js'
import { newId } from '../../lib/ids.js'
import { addressKey } from '../../lib/proxy.js'
import { limiter } from './routes.js'
import { createSession, toUser } from './service.js'

const lifetimeMs = 10 * 60_000
const initialInterval = 5
const hashUserCode = (code: string) => sign('tv-pairing-code', code)
const unavailable = () => notFound('This code has expired or was already used. Start a new pairing on the TV or speaker.', 'pairing_unavailable')

function interactiveSession(request: FastifyRequest) {
  const user = requireUser(request)
  if (!request.authSessionId) throw forbidden('Sign in to Squirmy to approve a TV or speaker.', 'interactive_session_required')
  return { user, sessionId: request.authSessionId }
}

function verificationPage(request: FastifyRequest) {
  // PUBLIC_URL supports a phone off the TV's LAN and preserves the browser's existing session.
  const root = getConfig().PUBLIC_URL ?? `${request.protocol}://${request.host}`
  const url = URL.parse(root)
  if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.href.length > 1000) throw badRequest('The server address cannot be used for TV pairing.')
  return new URL('/pair', url.origin)
}

export async function tvPairingRoutes(app: FastifyInstance) {
  const issueLimit = limiter(app, 'pairing-issue', 10, request => addressKey(request.ip))
  const pollLimit = limiter(app, 'pairing-poll', 120, request => addressKey(request.ip))
  const approveLimit = limiter(app, 'pairing-approve', 20, request => request.user?.id ?? addressKey(request.ip))
  const lookupLimit = limiter(app, 'pairing-lookup', 20, request => request.user?.id ?? addressKey(request.ip))
  await app.register(async (pairing) => {
    pairing.addHook('onRequest', async (_request, reply) => { reply.header('cache-control', 'no-store') })

    pairing.post('/start', { preHandler: issueLimit }, async (request): Promise<TvPairing> => {
      const { device } = StartTvPairing.parse(request.body)
      const verificationUrl = verificationPage(request)
      const now = Date.now()
      const expiresAt = new Date(now + lifetimeMs)
      await db.delete(tvPairings).where(lte(tvPairings.expiresAt, new Date(now)))
      for (let attempt = 0; attempt < 3; attempt++) {
        const code = Array.from({ length: 8 }, () => pairingAlphabet[randomInt(pairingAlphabet.length)]).join('')
        const userCode = `${code.slice(0, 4)}-${code.slice(4)}`
        verificationUrl.searchParams.set('code', userCode)
        const qr = renderSVG(verificationUrl.toString(), { ecc: 'M', border: 4, whiteColor: '#fff' })
        const deviceCode = randomToken()
        const [row] = await db.insert(tvPairings).values({
          id: newId(), deviceCodeHash: hashToken(deviceCode), userCodeHash: hashUserCode(code),
          deviceId: device.id, deviceName: device.name, deviceKind: device.kind, ipAddress: request.ip,
          userAgent: request.headers['user-agent']?.slice(0, 500),
          intervalSeconds: initialInterval, nextPollAt: new Date(now + initialInterval * 1000), expiresAt,
        }).onConflictDoNothing().returning({ id: tvPairings.id })
        if (row) return {
          deviceCode, userCode, verificationUrl: verificationUrl.toString(),
          qrCode: `data:image/svg+xml;base64,${Buffer.from(qr).toString('base64')}`,
          expiresAt: expiresAt.toISOString(), expiresInSeconds: lifetimeMs / 1000, intervalSeconds: initialInterval,
        }
      }
      throw conflict('Could not start a TV pairing. Try again.')
    })

    pairing.post('/lookup', { preHandler: lookupLimit }, async (request): Promise<TvPairingPreview> => {
      interactiveSession(request)
      const { code } = LookupTvPairing.parse(request.body)
      const [preview] = await db.select({ id: tvPairings.id, deviceName: tvPairings.deviceName, ipAddress: tvPairings.ipAddress, deviceKind: tvPairings.deviceKind })
        .from(tvPairings).where(and(
          eq(tvPairings.userCodeHash, hashUserCode(code)), isNull(tvPairings.approverSessionId), gt(tvPairings.expiresAt, new Date()),
        ))
      if (!preview) throw unavailable()
      return preview
    })

    pairing.post('/approve', { preHandler: approveLimit }, async (request): Promise<Ok> => {
      const { sessionId } = interactiveSession(request)
      const { id, code } = ApproveTvPairing.parse(request.body)
      const [approved] = await db.update(tvPairings).set({ approverSessionId: sessionId })
        .where(and(eq(tvPairings.id, id), eq(tvPairings.userCodeHash, hashUserCode(code)),
          isNull(tvPairings.approverSessionId), gt(tvPairings.expiresAt, new Date())))
        .returning({ id: tvPairings.id })
      if (!approved) throw unavailable()
      return { ok: true }
    })

    pairing.post('/poll', { preHandler: pollLimit }, async (request): Promise<TvPairingPoll> => {
      const { deviceCode } = PollTvPairing.parse(request.body)
      return db.transaction(async (tx) => {
        const [row] = await tx.select().from(tvPairings).where(eq(tvPairings.deviceCodeHash, hashToken(deviceCode))).for('update')
        const now = Date.now()
        if (!row || row.expiresAt.getTime() <= now) throw unavailable()
        const tooFast = row.nextPollAt.getTime() > now
        if (tooFast || !row.approverSessionId) {
          const intervalSeconds = tooFast ? Math.min(60, row.intervalSeconds + 5) : row.intervalSeconds
          await tx.update(tvPairings).set({ intervalSeconds, nextPollAt: new Date(now + intervalSeconds * 1000) }).where(eq(tvPairings.id, row.id))
          return { status: tooFast ? 'slow_down' : 'pending', intervalSeconds }
        }
        const [approver] = await tx.select({ userId: authSessions.userId }).from(authSessions).where(eq(authSessions.id, row.approverSessionId))
        if (!approver) throw unavailable()
        // Follow password changes' lock order so a revocation cannot slip between this check and creating the TV session.
        const [user] = await tx.select().from(users).where(eq(users.id, approver.userId)).for('share')
        const [session] = await tx.select({ id: authSessions.id }).from(authSessions).where(and(
          eq(authSessions.id, row.approverSessionId), gt(authSessions.expiresAt, new Date()),
        )).for('share')
        if (!session || !user || user.disabledAt || row.expiresAt.getTime() <= Date.now()) throw unavailable()
        const kind = row.deviceKind
        const { token } = await createSession(tx, {
          userId: user.id, device: { id: row.deviceId, name: row.deviceName, kind },
          clientKind: kind, userAgent: row.userAgent ?? undefined, method: kind === 'speaker' ? 'speaker_pairing' : 'tv_pairing',
        })
        await tx.delete(tvPairings).where(eq(tvPairings.id, row.id))
        return { status: 'approved', session: { user: toUser(user), token } }
      })
    })
  }, { prefix: '/auth/tv-pairing' })
}
