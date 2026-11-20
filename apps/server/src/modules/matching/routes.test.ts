import type { MatchCandidateList, MatchReviewDetail, MatchReviewList } from '@squirmy/contracts'
import { and, eq, sql } from 'drizzle-orm'
import type { FastifyInstance, InjectOptions } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, likes, matchReviews, mediaFiles, recordings, releases } from '../../database/schema.js'
import { startJobs, stopJobs } from '../../jobs/index.js'
import { newId } from '../../lib/ids.js'
import { useTestDatabase } from '../../test/database.js'
import { createLibraryRoot } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { demoAlbums, ingestAlbum } from '../../test/matching.js'
import { matchGroup } from './match.js'

const okComputerGroup = 'b1392450-e666-3926-a536-22c65f834433'
const oknotok = 'd6dc018d-5caa-4e6f-8e9d-d889fcd585f4'
const generic = (_track: unknown, index: number) => ({ title: `Track ${String(index + 1).padStart(2, '0')}` })

type Group = { rootId: string; groupKey: string }
const filesOf = (group: Group) => db.select().from(mediaFiles)
  .where(and(eq(mediaFiles.rootId, group.rootId), eq(mediaFiles.groupKey, group.groupKey))).orderBy(mediaFiles.relPath)

describe('matching routes', () => {
  useTestDatabase()
  useHttpFixtures('musicbrainz')
  let app: FastifyInstance
  let admin: { authorization: string }
  let member: { authorization: string }
  let adminId = ''
  let rootId = ''
  const call = (options: InjectOptions) => app.inject(options)

  beforeAll(async () => {
    await startJobs({ work: false })
    app = await buildApp()
    const setup = await call({ method: 'POST', url: '/api/v1/setup', payload: { username: 'root', password: 'root password' } })
    adminId = setup.json().user.id
    admin = { authorization: `Bearer ${setup.json().token}` }
    await call({ method: 'POST', url: '/api/v1/admin/users', headers: admin, payload: { username: 'mira', password: 'mira password' } })
    const login = await call({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'mira', password: 'mira password' } })
    member = { authorization: `Bearer ${login.json().token}` }
    rootId = (await createLibraryRoot()).id
  })
  afterAll(async () => {
    await app.close()
    await stopJobs()
  })

  it('is for admins only', async () => {
    const id = newId()
    expect((await call({ url: '/api/v1/admin/reviews' })).statusCode).toBe(401)
    expect((await call({ url: '/api/v1/admin/reviews', headers: member })).statusCode).toBe(403)
    expect((await call({ url: '/api/v1/admin/reviews', headers: admin })).json()).toEqual({ items: [], nextCursor: null })
    const routes: InjectOptions[] = [
      { method: 'GET', url: `/api/v1/admin/reviews/${id}` },
      { method: 'POST', url: `/api/v1/admin/reviews/${id}/resolve`, payload: { action: 'dismiss' } },
      { method: 'GET', url: `/api/v1/admin/albums/${id}/candidates` },
      { method: 'POST', url: `/api/v1/admin/albums/${id}/rematch`, payload: {} },
      { method: 'POST', url: `/api/v1/admin/albums/${id}/unmatch` },
    ]
    for (const route of routes) {
      expect((await call(route)).statusCode, route.url as string).toBe(401)
      expect((await call({ ...route, headers: member })).statusCode, route.url as string).toBe(403)
      expect((await call({ ...route, headers: admin })).statusCode, route.url as string).toBe(404)
    }
  })

  it('lists reviews open first, a page at a time, with everything needed to compare', async () => {
    const wall = await ingestAlbum(rootId, demoAlbums.theWall, { tags: generic })
    await matchGroup(rootId, wall.groupKey)
    await db.insert(matchReviews).values({ id: newId(), rootId, groupKey: 'old|group', summary: { artist: null, album: null, year: null, trackCount: 1, folder: 'old' }, status: 'dismissed' })

    const first = await call({ url: '/api/v1/admin/reviews?limit=1', headers: admin })
    const page = first.json() as MatchReviewList
    expect(page.items).toMatchObject([{ status: 'open', groupKey: wall.groupKey, albumId: wall.albumId, summary: { album: 'The Wall', trackCount: 26 } }])
    expect(page.items[0]!.bestScore).toBeLessThan(0.9)
    expect(page.nextCursor).toBe('1')
    const second = (await call({ url: `/api/v1/admin/reviews?limit=1&cursor=${page.nextCursor}`, headers: admin })).json() as MatchReviewList
    expect(second).toMatchObject({ items: [{ status: 'dismissed', groupKey: 'old|group', albumId: null, bestScore: null }], nextCursor: null })
    expect(((await call({ url: '/api/v1/admin/reviews?status=dismissed', headers: admin })).json() as MatchReviewList).items).toHaveLength(1)

    const detail = (await call({ url: `/api/v1/admin/reviews/${page.items[0]!.id}`, headers: admin })).json() as MatchReviewDetail
    expect(detail.files).toHaveLength(26)
    expect(detail.files[0]).toMatchObject({ title: 'Track 01', disc: 1, track: 1, status: 'review', locked: false })
    expect(detail.candidates.length).toBe(page.items[0]!.candidateCount)
    expect(detail.candidates[0]!.tracks.length).toBe(26)
  })

  it('resolves a review with a chosen release and locks the files', async () => {
    const [review] = await db.select().from(matchReviews).where(eq(matchReviews.status, 'open'))
    const detail = (await call({ url: `/api/v1/admin/reviews/${review!.id}`, headers: admin })).json() as MatchReviewDetail
    const chosen = detail.candidates[0]!.releaseMbid
    expect((await call({ method: 'POST', url: `/api/v1/admin/reviews/${review!.id}/resolve`, headers: admin, payload: { releaseMbid: 'nope' } })).statusCode).toBe(400)

    const resolved = await call({ method: 'POST', url: `/api/v1/admin/reviews/${review!.id}/resolve`, headers: admin, payload: { releaseMbid: chosen.toUpperCase() } })
    expect(resolved.json()).toMatchObject({ status: 'matched', releaseMbid: chosen })
    const files = await filesOf(review!)
    expect(files.every((file) => file.matchLocked && file.matchSource === 'manual')).toBe(true)
    expect(files.filter((file) => file.matchStatus === 'matched').length).toBeGreaterThan(20)
    const [release] = await db.select().from(releases).where(eq(releases.id, files[0]!.releaseId!))
    expect(release!.mbid).toBe(chosen)
    expect((await db.select().from(matchReviews).where(eq(matchReviews.id, review!.id)))[0]).toMatchObject({ status: 'resolved', resolvedBy: adminId })
  })

  it('keeps a group local-only, or dismisses its review', async () => {
    for (const [index, action] of (['keep_local', 'dismiss'] as const).entries()) {
      const group = await ingestAlbum(rootId, demoAlbums.theWall, { folder: `review ${index}`, tags: generic })
      await matchGroup(rootId, group.groupKey)
      const [review] = await db.select().from(matchReviews).where(eq(matchReviews.groupKey, group.groupKey))
      const response = await call({ method: 'POST', url: `/api/v1/admin/reviews/${review!.id}/resolve`, headers: admin, payload: { action } })
      expect(response.json()).toEqual({ albumId: group.albumId, status: 'unmatched', releaseMbid: null, score: null })
      const files = await filesOf(group)
      expect(files.every((file) => file.matchStatus === 'unmatched' && file.albumId === group.albumId && file.matchLocked === (action === 'keep_local'))).toBe(true)
      expect((await db.select().from(matchReviews).where(eq(matchReviews.id, review!.id)))[0]!.status).toBe(action === 'keep_local' ? 'resolved' : 'dismissed')
    }
  })

  describe('an owned album', () => {
    let group: Awaited<ReturnType<typeof ingestAlbum>>
    let albumId = ''
    beforeAll(async () => {
      group = await ingestAlbum(rootId, demoAlbums.okComputer)
      await matchGroup(rootId, group.groupKey)
      albumId = group.albumId
    })

    it('lists scored candidates, from the tags or a query', async () => {
      const fromTags = (await call({ url: `/api/v1/admin/albums/${albumId}/candidates`, headers: admin })).json() as MatchCandidateList
      expect(fromTags.items[0]).toMatchObject({ releaseGroupMbid: okComputerGroup, trackCount: 12 })
      expect(fromTags.items[0]!.score).toBeGreaterThan(0.95)

      const named = (await call({ url: `/api/v1/admin/albums/${albumId}/candidates?query=${encodeURIComponent('Radiohead - OK Computer')}`, headers: admin })).json() as MatchCandidateList
      expect(named.items.map((item) => item.releaseMbid)).toEqual(fromTags.items.map((item) => item.releaseMbid))

      const byId = (await call({ url: `/api/v1/admin/albums/${albumId}/candidates?query=https://musicbrainz.org/release/${oknotok}`, headers: admin })).json() as MatchCandidateList
      expect(byId.items).toMatchObject([{ releaseMbid: oknotok, trackCount: 23 }])
      expect(byId.items[0]!.score).toBeLessThan(fromTags.items[0]!.score)

      const byGroup = (await call({ url: `/api/v1/admin/albums/${albumId}/candidates?query=${okComputerGroup}`, headers: admin })).json() as MatchCandidateList
      expect(byGroup.items.length).toBeGreaterThan(1)
      expect(byGroup.items.every((item) => item.releaseGroupMbid === okComputerGroup)).toBe(true)
      expect(byGroup.items[0]!.trackCount).toBe(12)

      const unowned = await db.insert(albums).values({ id: newId(), title: 'Gray', artistCredit: 'Nobody', titleKey: 'gray', matchKey: 'nobody|gray' }).returning()
      expect((await call({ url: `/api/v1/admin/albums/${unowned[0]!.id}/candidates`, headers: admin })).json()).toMatchObject({ error: { code: 'album_not_owned' } })
    })

    it('rematches to a chosen release and locks the files', async () => {
      const missing = await call({ method: 'POST', url: `/api/v1/admin/albums/${albumId}/rematch`, headers: admin, payload: { releaseMbid: '00000000-0000-4000-8000-000000000000' } })
      expect(missing.json()).toMatchObject({ error: { code: 'release_not_found' } })

      const response = await call({ method: 'POST', url: `/api/v1/admin/albums/${albumId}/rematch`, headers: admin, payload: { releaseMbid: oknotok } })
      expect(response.json()).toMatchObject({ albumId, status: 'matched', releaseMbid: oknotok })
      const files = await filesOf(group)
      expect(files.every((file) => file.matchStatus === 'matched' && file.matchLocked && file.matchSource === 'manual')).toBe(true)
      const [release] = await db.select().from(releases).where(eq(releases.id, files[0]!.releaseId!))
      expect(release).toMatchObject({ mbid: oknotok, trackCount: 23 })
      expect((await db.select().from(albums).where(eq(albums.id, albumId)))[0]!.canonicalReleaseId).toBe(release!.id)
    })

    it('forgets a match and queues automatic matching again', async () => {
      const user = (await db.execute<{ id: string }>(sql`select id from users where username_key = 'mira'`))[0]!
      const [airbag] = await filesOf(group)
      await db.insert(likes).values({ userId: user.id, entityType: 'recording', entityId: airbag!.recordingId! })

      const response = await call({ method: 'POST', url: `/api/v1/admin/albums/${albumId}/rematch`, headers: admin, payload: {} })
      const local = response.json().albumId as string
      expect(response.json()).toMatchObject({ status: 'pending', releaseMbid: null })
      expect(local).not.toBe(albumId)
      const files = await filesOf(group)
      expect(files.every((file) => file.matchStatus === 'pending' && !file.matchLocked && file.albumId === local)).toBe(true)
      expect((await db.select().from(albums).where(eq(albums.id, local)))[0]!.mbid).toBeNull()
      const queued = await db.execute<{ singleton_key: string }>(sql`select singleton_key from pgboss.job where name = 'matching.match-album' and state = 'created'`)
      expect(queued.map((job) => job.singleton_key)).toContain(`${rootId}:${group.groupKey}`)

      // The automatic match lands on the MusicBrainz rows again, and the like still resolves.
      await matchGroup(rootId, group.groupKey)
      const rematched = await filesOf(group)
      expect(rematched.every((file) => file.matchStatus === 'matched' && file.albumId === albumId)).toBe(true)
      expect(rematched[0]!.recordingId).toBe(airbag!.recordingId)
      expect((await db.select().from(recordings).where(eq(recordings.id, airbag!.recordingId!)))[0]!.mergedIntoId).toBeNull()
    })

    it('unmatches an album back to local-only rows and locks it', async () => {
      const response = await call({ method: 'POST', url: `/api/v1/admin/albums/${albumId}/unmatch`, headers: admin })
      const local = response.json().albumId as string
      expect(response.json()).toMatchObject({ status: 'unmatched', releaseMbid: null })
      const files = await filesOf(group)
      expect(files.every((file) => file.matchStatus === 'unmatched' && file.matchLocked && file.albumId === local)).toBe(true)
      const [row] = await db.select().from(albums).where(eq(albums.id, local))
      expect(row).toMatchObject({ mbid: null, title: 'OK Computer', artistCredit: 'Radiohead' })
      const [recording] = await db.select().from(recordings).where(eq(recordings.id, files[0]!.recordingId!))
      expect(recording).toMatchObject({ mbid: null, title: 'Airbag' })

      await db.update(mediaFiles).set({ matchStatus: 'pending' }).where(eq(mediaFiles.groupKey, group.groupKey))
      await matchGroup(rootId, group.groupKey)
      expect((await filesOf(group)).every((file) => file.albumId === local)).toBe(true)
    })
  })
})
