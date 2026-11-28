import { LastFmConnectStart, ScrobblingStatus, type ScrobbleTarget } from '@squirmy/contracts'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { plays, releases, scrobbleDeliveries, users } from '../../database/schema.js'
import { drainJobs, jobs, schedule, startJobs } from '../../jobs/index.js'
import { setRateLimitsEnabled } from '../../lib/http.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { body, errorCode, signIn } from '../../test/api.js'
import { createPlay } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist, createUser } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { savePlay } from '../sessions/plays.js'
import { updateUserSettings } from '../userdata/settings.js'
import { loadScrobbling, saveConnection } from './connections.js'
import { deliverScrobbles, MAX_ATTEMPTS, sweepScrobbles } from './delivery.js'
import { scrobbleModule } from './index.js'
import { announceNowPlaying } from './nowplaying.js'
import { lastFmState } from './routes.js'

// The cron schedule would sweep at arbitrary moments during the tests; they sweep themselves.
vi.mock('../../jobs/index.js', async (importOriginal) => ({ ...(await importOriginal<object>()), schedule: vi.fn(async () => {}) }))

const lastFmKeys = { lastFmKey: 'test-lastfm-key', lastFmSecret: 'test-lastfm-secret' }

describe('scrobble', () => {
  useTestDatabase()
  let app: FastifyInstance

  beforeAll(async () => {
    app = await buildApp()
  })
  afterAll(async () => {
    await app.close()
  })

  const status = async (headers: Record<string, string>) =>
    body(await app.inject({ method: 'GET', url: '/api/v1/me/scrobbling', headers }), ScrobblingStatus)
  const service = (current: ScrobblingStatus, target: ScrobbleTarget) => current.services.find((one) => one.target === target)!

  describe('connecting accounts', () => {
    const http = useHttpFixtures('listenbrainz', 'lastfm')

    it('connects ListenBrainz with a token it validates, and keeps the token secret', async () => {
      const user = await signIn()
      expect(service(await status(user.headers), 'listenbrainz')).toEqual({
        target: 'listenbrainz', available: true, connected: false, account: null, enabled: false, needsAttention: false,
        lastError: null, connectedAt: null, pending: 0, failed: 0,
      })

      const invalid = await app.inject({ method: 'PUT', url: '/api/v1/me/scrobbling/listenbrainz', headers: user.headers, payload: { token: 'invalid-user-token' } })
      expect(errorCode(invalid, 400)).toBe('invalid_token')

      const connected = body(await app.inject({ method: 'PUT', url: '/api/v1/me/scrobbling/listenbrainz', headers: user.headers, payload: { token: 'valid-user-token' } }), ScrobblingStatus)
      expect(service(connected, 'listenbrainz')).toMatchObject({ connected: true, account: 'squirmy-test', enabled: true, needsAttention: false })
      expect(http.requests).toEqual(['GET https://api.listenbrainz.org/1/validate-token', 'GET https://api.listenbrainz.org/1/validate-token'])
      const [row] = await db.select({ settings: users.settings }).from(users).where(eq(users.id, user.id))
      expect(JSON.stringify(row!.settings)).not.toContain('valid-user-token')
      expect((await loadScrobbling(user.id)).connections.listenbrainz!.credential).toBe('valid-user-token')
      expect(JSON.stringify(connected)).not.toContain('valid-user-token')

      const removed = body(await app.inject({ method: 'DELETE', url: '/api/v1/me/scrobbling/listenbrainz', headers: user.headers }), ScrobblingStatus)
      expect(service(removed, 'listenbrainz')).toMatchObject({ connected: false, account: null, enabled: false })
      expect((await loadScrobbling(user.id)).connections).toEqual({})
    })

    it('says when Last.fm is not configured on the server', async () => {
      const user = await signIn()
      expect(service(await status(user.headers), 'lastfm')).toMatchObject({ available: false, connected: false })
      const response = await app.inject({ method: 'POST', url: '/api/v1/me/scrobbling/lastfm/start', headers: user.headers })
      expect(errorCode(response, 409)).toBe('lastfm_not_configured')
    })

    it('connects Last.fm through the browser approval and its callback', async () => {
      await updateServerSettings(lastFmKeys)
      const user = await signIn()
      expect(service(await status(user.headers), 'lastfm').available).toBe(true)
      const { url } = body(await app.inject({ method: 'POST', url: '/api/v1/me/scrobbling/lastfm/start', headers: { ...user.headers, host: 'music.example.test' } }), LastFmConnectStart)
      const approval = new URL(url)
      expect(approval.origin + approval.pathname).toBe('https://www.last.fm/api/auth/')
      expect(approval.searchParams.get('api_key')).toBe('test-lastfm-key')
      const callback = new URL(approval.searchParams.get('cb')!)
      expect(callback.origin + callback.pathname).toBe('http://music.example.test/api/v1/scrobbling/lastfm/callback')
      const state = callback.searchParams.get('state')!

      const land = (query: string) => app.inject({ method: 'GET', url: `/api/v1/scrobbling/lastfm/callback?${query}` })
      expect((await land(`state=${state}&token=unauthorized-token`)).headers.location).toBe('/settings?lastfm=denied')
      const connected = await land(`state=${state}&token=authorized-token`)
      expect(connected.statusCode).toBe(302)
      expect(connected.headers.location).toBe('/settings?lastfm=connected')
      expect(service(await status(user.headers), 'lastfm')).toMatchObject({ connected: true, account: 'squirmy-test', enabled: true })
      expect((await loadScrobbling(user.id)).connections.lastfm!.credential).toBe('test-session-key')

      const removed = body(await app.inject({ method: 'DELETE', url: '/api/v1/me/scrobbling/lastfm', headers: user.headers }), ScrobblingStatus)
      expect(service(removed, 'lastfm')).toMatchObject({ connected: false, enabled: false })
    })

    it('returns an app that started the Last.fm approval to its own address', async () => {
      await updateServerSettings(lastFmKeys)
      const user = await signIn()
      const start = (returnTo: string) => app.inject({ method: 'POST', url: '/api/v1/me/scrobbling/lastfm/start', headers: user.headers, payload: { returnTo } })
      const { url } = body(await start('squirmy://settings'), LastFmConnectStart)
      const callback = new URL(new URL(url).searchParams.get('cb')!)
      expect(callback.searchParams.get('return')).toBe('squirmy://settings')
      const state = callback.searchParams.get('state')!
      const land = (query: string) => app.inject({ method: 'GET', url: `/api/v1/scrobbling/lastfm/callback?${query}` })
      const returning = `state=${encodeURIComponent(state)}&return=${encodeURIComponent('squirmy://settings')}`

      expect((await land(`${returning}&token=unauthorized-token`)).headers.location).toBe('squirmy://settings?lastfm=denied')
      // Only the address the state signs is followed: dropped or swapped, the browser goes to the web app.
      expect((await land(`state=${encodeURIComponent(state)}&token=authorized-token`)).headers.location).toBe('/settings?lastfm=invalid_state')
      expect((await land(`state=${encodeURIComponent(state)}&return=${encodeURIComponent('squirmy-dev://settings')}&token=authorized-token`)).headers.location)
        .toBe('/settings?lastfm=invalid_state')
      expect((await land(`state=${encodeURIComponent(state)}&return=${encodeURIComponent('https://evil.example.test/')}&token=authorized-token`)).headers.location)
        .toBe('/settings?lastfm=invalid_state')
      expect((await loadScrobbling(user.id)).connections).toEqual({})

      const connected = await land(`${returning}&token=authorized-token`)
      expect(connected.statusCode).toBe(302)
      expect(connected.headers.location).toBe('squirmy://settings?lastfm=connected')
      expect(service(await status(user.headers), 'lastfm')).toMatchObject({ connected: true, account: 'squirmy-test' })

      // An expired state still returns to the app that signed it, to say so there.
      const expired = lastFmState(user.id, Date.now() - 11 * 60_000, 'squirmy-dev://settings')
      expect((await land(`state=${encodeURIComponent(expired)}&return=${encodeURIComponent('squirmy-dev://settings')}&token=authorized-token`)).headers.location)
        .toBe('squirmy-dev://settings?lastfm=invalid_state')
    })

    it('refuses to return a Last.fm approval anywhere but the app', async () => {
      await updateServerSettings(lastFmKeys)
      const user = await signIn()
      for (const returnTo of ['https://evil.example.test/settings', 'javascript://alert(1)', '//evil.example.test', 'squirmy', 'squirmy:/settings', 'squirmy://set tings', `squirmy://${'a'.repeat(200)}`]) {
        const response = await app.inject({ method: 'POST', url: '/api/v1/me/scrobbling/lastfm/start', headers: user.headers, payload: { returnTo } })
        expect(response.statusCode, returnTo).toBe(400)
      }
    })

    it('refuses a Last.fm callback whose state is forged, expired or for another purpose', async () => {
      const user = await createUser()
      const other = await createUser()
      const land = (state: string) => app.inject({ method: 'GET', url: `/api/v1/scrobbling/lastfm/callback?state=${encodeURIComponent(state)}&token=authorized-token` })
      const good = lastFmState(user.id)
      const [, expiry, signature] = good.split('.')
      for (const state of [
        `${other.id}.${expiry}.${signature}`,
        `${user.id}.${Number(expiry) + 60}.${signature}`,
        lastFmState(user.id, Date.now() - 11 * 60_000),
        `${user.id}.${expiry}`,
        'nonsense',
      ]) {
        expect((await land(state)).headers.location, state).toBe('/settings?lastfm=invalid_state')
      }
      expect((await app.inject({ method: 'GET', url: `/api/v1/scrobbling/lastfm/callback?state=${good}` })).headers.location).toBe('/settings?lastfm=invalid_state')
      expect(http.requests).toEqual([])
      expect((await loadScrobbling(user.id)).connections).toEqual({})
      expect((await loadScrobbling(other.id)).connections).toEqual({})
    })
  })

  describe('delivery', () => {
    type Call = { url: string; body: string }
    const calls: Call[] = []
    let failWith: ((call: Call) => Response | null) | null = null
    let delayMs = 0

    /** The services, as far as these tests need them. */
    function answer(call: Call): Response {
      const failure = failWith?.(call)
      if (failure) return failure
      if (call.url.startsWith('https://api.listenbrainz.org/')) return Response.json({ status: 'ok' })
      const params = new URLSearchParams(call.body)
      if (params.get('method') === 'track.updateNowPlaying') return Response.json({ nowplaying: {} })
      const count = [...params.keys()].filter((key) => key.startsWith('timestamp[')).length
      return Response.json({ scrobbles: { '@attr': { accepted: count, ignored: 0 } } })
    }

    const listens = (target: ScrobbleTarget) => calls.filter((call) => call.url.startsWith(target === 'listenbrainz' ? 'https://api.listenbrainz.org/' : 'https://ws.audioscrobbler.com/'))
    const lbPayload = (call: Call) => JSON.parse(call.body) as { listen_type: string; payload: { listened_at?: number; track_metadata: Record<string, unknown> & { additional_info: Record<string, unknown> } }[] }
    const lastFmParams = (call: Call) => Object.fromEntries(new URLSearchParams(call.body))
    const flush = async () => {
      await sweepScrobbles()
      await drainJobs()
    }
    const deliveries = (userId: string) => db.select({ playId: scrobbleDeliveries.playId, target: scrobbleDeliveries.target, status: scrobbleDeliveries.status, attempts: scrobbleDeliveries.attempts, lastError: scrobbleDeliveries.lastError })
      .from(scrobbleDeliveries).innerJoin(plays, eq(plays.id, scrobbleDeliveries.playId)).where(eq(plays.userId, userId))
    /** Moves every failed attempt of the user far enough into the past for the backoff to allow a retry. */
    const backdate = (userId: string) => db.execute(sql`
      update scrobble_deliveries d set updated_at = now() - interval '7 hours' from plays p where p.id = d.play_id and p.user_id = ${userId}`)

    let album: Awaited<ReturnType<typeof createAlbum>>

    beforeAll(async () => {
      await updateServerSettings(lastFmKeys)
      await scrobbleModule.jobs!(jobs)
      await startJobs({ work: true })
      const artist = await createArtist({ name: 'Mark Ronson', mbid: 'c3c82bdc-d9e7-4836-9746-c24ead47ca19' })
      album = await createAlbum({
        artist, title: 'Uptown Special', mbid: 'a8d5e6c1-3f0c-4c8b-9a7e-2a6a2d1c0f11', owned: true,
        tracks: [{ title: 'Uptown’s First Finale', durationMs: 120_000 }, { title: 'Uptown Funk', durationMs: 269_000, mbid: '33b6b148-9dce-4894-902d-d218ecc30666' }],
      })
      await db.update(releases).set({ mbid: '0d7a6f3e-1111-4c22-9a33-5b8e2e0c7a44' }).where(eq(releases.id, album.releaseId))
    })
    beforeEach(() => {
      calls.length = 0
      failWith = null
      delayMs = 0
      setRateLimitsEnabled(false)
      vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
        const call = { url: input.toString(), body: typeof init?.body === 'string' ? init.body : '' }
        calls.push(call)
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
        return answer(call)
      })
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      setRateLimitsEnabled(true)
    })

    async function listener(targets: ScrobbleTarget[] = ['listenbrainz', 'lastfm']) {
      const user = await createUser()
      for (const target of targets) await saveConnection(user.id, target, `${target}-credential`, `${target}-account`)
      return user
    }

    const play = (userId: string, track = album.tracks[1]!, options: { minutesAgo?: number; completed?: boolean } = {}) =>
      createPlay({ userId, recordingId: track.recordingId, albumId: album.albumId, minutesAgo: options.minutesAgo ?? 0, completed: options.completed })

    it('runs the sweep every minute', () => {
      expect(schedule).toHaveBeenCalledWith('scrobble.sweep', '* * * * *')
    })

    it('sends each completed play once, with the MusicBrainz ids and track details the services want', async () => {
      const user = await listener()
      const first = await play(user.id, album.tracks[0]!)
      const second = await play(user.id)
      await play(user.id, album.tracks[1]!, { completed: false })
      await savePlay(user.id, {
        id: newId(), entryId: 'short-play', recordingId: album.tracks[0]!.recordingId, albumId: album.albumId, deviceId: null,
        durationMs: 6000, msPlayed: 4000, startedAt: Date.now(), countedTo: Date.now() + 4000,
      })
      await flush()

      const [lb] = listens('listenbrainz')
      expect(listens('listenbrainz')).toHaveLength(1)
      expect(lb!.url).toBe('https://api.listenbrainz.org/1/submit-listens')
      const submitted = lbPayload(lb!)
      expect(submitted.listen_type).toBe('import')
      expect(submitted.payload.map((listen) => listen.listened_at)).toEqual([first.startedAt, second.startedAt].map((at) => Math.floor(at.getTime() / 1000)))
      expect(submitted.payload[1]!.track_metadata).toEqual({
        artist_name: 'Mark Ronson',
        track_name: 'Uptown Funk',
        release_name: 'Uptown Special',
        additional_info: {
          submission_client: 'Squirmy',
          media_player: 'Squirmy',
          recording_mbid: '33b6b148-9dce-4894-902d-d218ecc30666',
          release_mbid: '0d7a6f3e-1111-4c22-9a33-5b8e2e0c7a44',
          release_group_mbid: 'a8d5e6c1-3f0c-4c8b-9a7e-2a6a2d1c0f11',
          artist_mbids: ['c3c82bdc-d9e7-4836-9746-c24ead47ca19'],
          duration_ms: 269_000,
          tracknumber: 2,
        },
      })

      const [lastFm] = listens('lastfm')
      expect(listens('lastfm')).toHaveLength(1)
      expect(lastFmParams(lastFm!)).toMatchObject({
        method: 'track.scrobble',
        sk: 'lastfm-credential',
        'artist[0]': 'Mark Ronson', 'track[0]': 'Uptown’s First Finale', 'trackNumber[0]': '1', 'duration[0]': '120',
        'timestamp[0]': String(Math.floor(first.startedAt.getTime() / 1000)),
        'artist[1]': 'Mark Ronson', 'track[1]': 'Uptown Funk', 'album[1]': 'Uptown Special', 'albumArtist[1]': 'Mark Ronson',
        'trackNumber[1]': '2', 'duration[1]': '269', 'mbid[1]': '33b6b148-9dce-4894-902d-d218ecc30666',
      })
      expect(lastFmParams(lastFm!)['mbid[0]']).toBeUndefined()

      expect(await deliveries(user.id)).toHaveLength(4)
      expect((await deliveries(user.id)).every((row) => row.status === 'sent' && row.attempts === 1)).toBe(true)
      calls.length = 0
      await flush()
      await flush()
      expect(calls).toEqual([])
    })

    it('sends a single play as a single listen', async () => {
      const user = await listener(['listenbrainz'])
      await play(user.id)
      await flush()
      expect(lbPayload(listens('listenbrainz')[0]!).listen_type).toBe('single')
    })

    it('batches oldest first within each service’s limit', async () => {
      const user = await listener()
      const started = Date.now()
      await db.insert(plays).values(Array.from({ length: 60 }, (_, index) => ({
        id: newId(), userId: user.id, recordingId: album.tracks[index % 2]!.recordingId, albumId: album.albumId,
        startedAt: new Date(started + (60 - index) * 1000), msPlayed: 100_000, completed: true,
      })))
      await flush()
      const lastFmBatches = listens('lastfm').map(lastFmParams)
      expect(lastFmBatches.map((params) => Object.keys(params).filter((key) => key.startsWith('timestamp[')).length)).toEqual([50, 10])
      const timestamps = lastFmBatches.flatMap((params) => Object.entries(params).filter(([key]) => key.startsWith('timestamp[')).map(([, value]) => Number(value)))
      expect(timestamps).toEqual(timestamps.toSorted((a, b) => a - b))
      expect(new Set(timestamps).size).toBe(60)
      expect(listens('listenbrainz').map((call) => lbPayload(call).payload.length)).toEqual([60])
    })

    it('retries failures with backoff, never sends a play twice, and gives up after repeated failures', async () => {
      const user = await signIn()
      await saveConnection(user.id, 'listenbrainz', 'lb-credential', 'lb-account')
      failWith = () => Response.json({ error: 'Something broke' }, { status: 500 })
      const first = await play(user.id)
      await flush()
      expect(listens('listenbrainz')).toHaveLength(1)
      expect(await deliveries(user.id)).toEqual([{ playId: first.id, target: 'listenbrainz', status: 'pending', attempts: 1, lastError: 'listenbrainz: Something broke' }])
      expect(service(await status(user.headers), 'listenbrainz')).toMatchObject({ pending: 1, failed: 0, lastError: 'listenbrainz: Something broke', needsAttention: false })

      // Too soon for another attempt.
      await flush()
      expect(listens('listenbrainz')).toHaveLength(1)

      failWith = null
      await backdate(user.id)
      await flush()
      expect(listens('listenbrainz')).toHaveLength(2)
      expect(await deliveries(user.id)).toMatchObject([{ status: 'sent', attempts: 2, lastError: null }])
      expect(service(await status(user.headers), 'listenbrainz')).toMatchObject({ pending: 0, lastError: null })
      await backdate(user.id)
      await flush()
      expect(listens('listenbrainz')).toHaveLength(2)

      failWith = () => Response.json({ error: 'Still broken' }, { status: 500 })
      const second = await play(user.id)
      await flush()
      await db.update(scrobbleDeliveries).set({ attempts: MAX_ATTEMPTS - 1 }).where(eq(scrobbleDeliveries.playId, second.id))
      await backdate(user.id)
      await flush()
      expect((await deliveries(user.id)).find((row) => row.playId === second.id)).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS })
      const sent = listens('listenbrainz').length
      failWith = null
      await backdate(user.id)
      await flush()
      expect(listens('listenbrainz')).toHaveLength(sent)
      expect(service(await status(user.headers), 'listenbrainz')).toMatchObject({ pending: 0, failed: 1 })
    })

    it('submits each play exactly once across concurrent sweeps and deliveries', async () => {
      const user = await listener(['listenbrainz'])
      for (let index = 0; index < 5; index++) await play(user.id, album.tracks[index % 2]!, { minutesAgo: -index / 60 })
      delayMs = 50
      await Promise.all([sweepScrobbles(), sweepScrobbles(), deliverScrobbles(user.id, 'listenbrainz'), sweepScrobbles(), deliverScrobbles(user.id, 'listenbrainz')])
      await drainJobs()
      await flush()
      const submitted = listens('listenbrainz').flatMap((call) => lbPayload(call).payload)
      expect(submitted).toHaveLength(5)
      expect((await deliveries(user.id)).map((row) => row.status)).toEqual(Array(5).fill('sent'))
    })

    it('never scrobbles plays from before the connection', async () => {
      const user = await createUser()
      await play(user.id, album.tracks[0]!, { minutesAgo: 10 })
      await saveConnection(user.id, 'lastfm', 'lastfm-credential', 'lastfm-account')
      const after = await play(user.id)
      await flush()
      expect(await deliveries(user.id)).toMatchObject([{ playId: after.id, status: 'sent' }])
      expect(listens('lastfm').map(lastFmParams).map((params) => params['track[0]'])).toEqual(['Uptown Funk'])
    })

    it('keeps waiting plays when the same account reconnects, and drops them for a different account', async () => {
      const user = await listener(['listenbrainz'])
      failWith = () => Response.json({ error: 'Down' }, { status: 500 })
      await play(user.id)
      await flush()
      await saveConnection(user.id, 'listenbrainz', 'new-credential', 'listenbrainz-account')
      expect(await deliveries(user.id)).toMatchObject([{ status: 'pending' }])
      await saveConnection(user.id, 'listenbrainz', 'other-credential', 'someone-else')
      expect(await deliveries(user.id)).toEqual([])
    })

    it('stops when the user switches a service off', async () => {
      const user = await listener(['lastfm'])
      await updateUserSettings(user.id, { scrobbleLastFm: false })
      const whileOff = await play(user.id)
      await flush()
      expect(calls).toEqual([])
      expect(await deliveries(user.id)).toMatchObject([{ playId: whileOff.id, status: 'skipped' }])

      await updateUserSettings(user.id, { scrobbleLastFm: true })
      const whileOn = await play(user.id, album.tracks[0]!)
      await flush()
      expect(listens('lastfm').map(lastFmParams)).toMatchObject([{ 'track[0]': 'Uptown’s First Finale' }])
      expect((await deliveries(user.id)).find((row) => row.playId === whileOn.id)?.status).toBe('sent')
    })

    it('flags rejected credentials instead of retrying, and resumes once the user reconnects', async () => {
      const user = await signIn()
      await saveConnection(user.id, 'listenbrainz', 'revoked-token', 'lb-account')
      await saveConnection(user.id, 'lastfm', 'revoked-session', 'lastfm-account')
      failWith = (call) => call.url.includes('listenbrainz')
        ? Response.json({ code: 401, error: 'Invalid authorization token.' }, { status: 401 })
        : Response.json({ error: 9, message: 'Invalid session key - Please re-authenticate' }, { status: 403 })
      await play(user.id)
      await flush()
      const flagged = await status(user.headers)
      for (const target of ['listenbrainz', 'lastfm'] as const) {
        expect(service(flagged, target)).toMatchObject({ connected: true, needsAttention: true, pending: 1 })
        expect(service(flagged, target).lastError).toMatch(/Invalid/)
      }
      expect((await deliveries(user.id)).map((row) => row.attempts)).toEqual([0, 0])

      await backdate(user.id)
      await flush()
      expect(calls).toHaveLength(2)

      failWith = null
      await saveConnection(user.id, 'listenbrainz', 'fresh-token', 'lb-account')
      await flush()
      expect(listens('listenbrainz')).toHaveLength(2)
      expect(service(await status(user.headers), 'listenbrainz')).toMatchObject({ needsAttention: false, pending: 0 })
      expect((await deliveries(user.id)).find((row) => row.target === 'lastfm')?.status).toBe('pending')
    })

    it('waits while Last.fm is not configured on the server', async () => {
      const user = await listener(['lastfm'])
      await updateServerSettings({ lastFmKey: null })
      try {
        await play(user.id)
        await flush()
        expect(calls).toEqual([])
        expect(await deliveries(user.id)).toMatchObject([{ status: 'pending', attempts: 0 }])
      } finally {
        await updateServerSettings(lastFmKeys)
      }
      await flush()
      expect(listens('lastfm')).toHaveLength(1)
    })

    it('announces now playing to each connected, switched-on service', async () => {
      const user = await listener()
      await announceNowPlaying(user.id, { recordingId: album.tracks[1]!.recordingId, albumId: album.albumId })
      const [lb] = listens('listenbrainz')
      expect(lbPayload(lb!)).toMatchObject({ listen_type: 'playing_now', payload: [{ track_metadata: { track_name: 'Uptown Funk' } }] })
      expect(lbPayload(lb!).payload[0]!.listened_at).toBeUndefined()
      expect(listens('lastfm').map(lastFmParams)).toMatchObject([{ method: 'track.updateNowPlaying', track: 'Uptown Funk', mbid: '33b6b148-9dce-4894-902d-d218ecc30666' }])

      // Best effort: a failure is dropped, not retried or recorded.
      calls.length = 0
      failWith = () => Response.json({ error: 'Down' }, { status: 500 })
      await announceNowPlaying(user.id, { recordingId: album.tracks[0]!.recordingId, albumId: album.albumId })
      expect(calls).toHaveLength(2)
      expect(Object.values((await loadScrobbling(user.id)).connections).map((connection) => connection.lastError)).toEqual([null, null])

      calls.length = 0
      await updateUserSettings(user.id, { scrobbleListenBrainz: false, scrobbleLastFm: false })
      await announceNowPlaying(user.id, { recordingId: album.tracks[1]!.recordingId, albumId: album.albumId })
      expect(calls).toEqual([])
    })
  })
})
