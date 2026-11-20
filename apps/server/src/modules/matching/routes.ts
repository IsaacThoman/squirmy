import {
  Id, MatchCandidatesQuery, MatchReviewQuery, RematchAlbumRequest, ResolveReviewRequest,
  type MatchActionResult, type MatchCandidate, type MatchCandidateList, type MatchFile, type MatchGroupSummary, type MatchReview,
  type MatchReviewDetail, type MatchReviewList, type MatchReviewStatus,
} from '@squirmy/contracts'
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db, type Transaction } from '../../database/client.js'
import { albums, matchReviews, mediaFiles, releases } from '../../database/schema.js'
import { requireAdmin } from '../../lib/auth.js'
import { conflict, notFound } from '../../lib/errors.js'
import { getServerSettings } from '../../lib/settings.js'
import { enqueue } from '../../jobs/index.js'
import { musicbrainz } from '../metadata/index.js'
import type { MbRelease } from '../metadata/musicbrainz.js'
import { applyMatch, type ApplyResult } from './apply.js'
import { buildLocalRows, filesOfAlbum } from './local.js'
import {
  albumCandidates, announce, closeReview, groupEvidence, groupFiles, matchJobKey, type GroupFile,
} from './match.js'
import { resolveMerged } from './merge.js'
import { evaluate, toCandidate } from './score.js'

const IdParams = z.object({ id: Id })

type ReviewRow = typeof matchReviews.$inferSelect & { albumId: string | null }

/** The album most of the group's present files are linked to. */
const groupAlbum = sql<string | null>`(
  select f.album_id from media_files f
  where f.root_id = match_reviews.root_id and f.group_key = match_reviews.group_key and f.missing_since is null and f.album_id is not null
  group by f.album_id order by count(*) desc limit 1)`

function toReview(row: ReviewRow): MatchReview {
  const candidates = row.candidates as MatchCandidate[]
  return {
    id: row.id,
    rootId: row.rootId,
    groupKey: row.groupKey,
    status: row.status as MatchReviewStatus,
    summary: row.summary as MatchGroupSummary,
    bestScore: candidates[0]?.score ?? null,
    candidateCount: candidates.length,
    albumId: row.albumId,
    createdAt: row.createdAt.toISOString(),
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
  }
}

function toFile(file: GroupFile): MatchFile {
  return {
    id: file.id,
    relPath: file.relPath,
    title: file.tags.title ?? null,
    artist: file.tags.artist ?? null,
    disc: file.tags.disc ?? null,
    track: file.tags.track ?? null,
    durationMs: file.durationMs,
    status: file.matchStatus,
    locked: file.matchLocked,
  }
}

async function loadReview(id: string): Promise<ReviewRow> {
  const [row] = await db.select({ review: matchReviews, albumId: groupAlbum }).from(matchReviews).where(eq(matchReviews.id, id))
  if (!row) throw notFound('No such review')
  return { ...row.review, albumId: row.albumId }
}

async function fetchRelease(mbid: string) {
  if (!(await getServerSettings()).musicBrainzEnabled) throw conflict('MusicBrainz is switched off', 'musicbrainz_disabled')
  const release = await musicbrainz.getRelease(mbid)
  if (!release) throw notFound('MusicBrainz has no such release', 'release_not_found')
  return release
}

/** Applies a release the admin chose to `files` and locks them. */
async function applyManually(tx: Transaction, files: GroupFile[], release: MbRelease, fallback: { artist?: string; album?: string } = {}) {
  const evaluation = evaluate(groupEvidence(files, fallback), release)
  const result = await applyMatch(tx, { release, evaluation, source: 'manual', fileIds: files.map((file) => file.id), locked: true, attachExtras: true })
  return { result, evaluation, release }
}

/**
 * Moves files that sit on MusicBrainz rows back to new local-only rows built from their
 * tags. Files already on local-only rows stay where they are, with the user data on them.
 */
async function detach(tx: Transaction, files: GroupFile[]): Promise<string | null> {
  const releaseIds = [...new Set(files.flatMap((file) => (file.releaseId ? [file.releaseId] : [])))]
  const backed = new Set(releaseIds.length === 0 ? [] : (await tx.select({ id: releases.id }).from(releases)
    .where(and(inArray(releases.id, releaseIds), isNotNull(releases.mbid)))).map((row) => row.id))
  await buildLocalRows(tx, files.filter((file) => !file.releaseId || backed.has(file.releaseId)))
  const [first] = await tx.select({ albumId: mediaFiles.albumId }).from(mediaFiles).where(eq(mediaFiles.id, files[0]!.id))
  return first?.albumId ?? null
}

function groupsOf(files: GroupFile[]) {
  const groups = new Map<string, { rootId: string; groupKey: string }>()
  for (const file of files) if (file.groupKey) groups.set(matchJobKey(file.rootId, file.groupKey), { rootId: file.rootId, groupKey: file.groupKey })
  return [...groups.values()]
}

async function ownedAlbum(id: string) {
  const albumId = await resolveMerged(db, albums, id)
  const [album] = await db.select().from(albums).where(eq(albums.id, albumId))
  if (!album) throw notFound('No such album')
  const files = await filesOfAlbum(db, album.id)
  if (files.length === 0) throw notFound('No files are linked to that album', 'album_not_owned')
  return { album, files }
}

function matched(result: ApplyResult, releaseMbid: string, evaluation: { score: number; pairs: unknown[] }): MatchActionResult {
  return { albumId: result.albumId, status: evaluation.pairs.length > 0 ? 'matched' : 'unmatched', releaseMbid, score: evaluation.score }
}

export async function matchingRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    requireAdmin(request)
  })

  app.get('/admin/reviews', async (request): Promise<MatchReviewList> => {
    const query = MatchReviewQuery.parse(request.query)
    const offset = query.cursor ? Number.parseInt(query.cursor, 10) || 0 : 0
    const rows = await db.select({ review: matchReviews, albumId: groupAlbum }).from(matchReviews)
      .where(query.status ? eq(matchReviews.status, query.status) : undefined)
      .orderBy(sql`${matchReviews.status} = 'open' desc`, desc(matchReviews.createdAt), desc(matchReviews.id))
      .limit(query.limit + 1)
      .offset(offset)
    const items = rows.slice(0, query.limit).map((row) => toReview({ ...row.review, albumId: row.albumId }))
    return { items, nextCursor: rows.length > query.limit ? String(offset + query.limit) : null }
  })

  app.get('/admin/reviews/:id', async (request): Promise<MatchReviewDetail> => {
    const { id } = IdParams.parse(request.params)
    const review = await loadReview(id)
    const files = await groupFiles(db, review.rootId, review.groupKey, false)
    return { ...toReview(review), candidates: review.candidates as MatchCandidate[], files: files.map(toFile) }
  })

  app.post('/admin/reviews/:id/resolve', async (request): Promise<MatchActionResult> => {
    const admin = requireAdmin(request)
    const { id } = IdParams.parse(request.params)
    const body = ResolveReviewRequest.parse(request.body)
    const review = await loadReview(id)
    const files = await groupFiles(db, review.rootId, review.groupKey, false)
    if (files.length === 0) throw conflict('The review has no files left', 'no_files')
    const fileIds = files.map((file) => file.id)

    if ('releaseMbid' in body) {
      const release = await fetchRelease(body.releaseMbid)
      const outcome = await db.transaction(async (tx) => {
        const applied = await applyManually(tx, files, release)
        await closeReview(tx, review.rootId, review.groupKey, 'resolved', admin.id)
        return applied
      })
      await announce(outcome.result.albumIds, outcome.result.artistIds)
      return matched(outcome.result, outcome.release.mbid, outcome.evaluation)
    }

    const albumId = await db.transaction(async (tx) => {
      if (body.action === 'dismiss') {
        await tx.update(mediaFiles).set({ matchStatus: 'unmatched', matchConfidence: null, updatedAt: new Date() })
          .where(and(inArray(mediaFiles.id, fileIds), eq(mediaFiles.matchStatus, 'review')))
        await tx.update(matchReviews).set({ status: 'dismissed', resolvedBy: admin.id, resolvedAt: new Date() }).where(eq(matchReviews.id, id))
        return review.albumId
      }
      const local = await detach(tx, files)
      await tx.update(mediaFiles).set({ matchStatus: 'unmatched', matchLocked: true, matchSource: 'manual', matchConfidence: null, updatedAt: new Date() })
        .where(inArray(mediaFiles.id, fileIds))
      await tx.update(matchReviews).set({ status: 'resolved', resolvedBy: admin.id, resolvedAt: new Date() }).where(eq(matchReviews.id, id))
      return local
    })
    await announce(albumId ? [albumId, review.albumId ?? albumId] : [], [])
    return { albumId, status: 'unmatched', releaseMbid: null, score: null }
  })

  app.get('/admin/albums/:id/candidates', async (request): Promise<MatchCandidateList> => {
    const { id } = IdParams.parse(request.params)
    const { query } = MatchCandidatesQuery.parse(request.query)
    const { album, files } = await ownedAlbum(id)
    const evidence = { ...groupEvidence(files, { artist: album.artistCredit, album: album.title }), mode: 'album' as const }
    const found = await albumCandidates(evidence, files, query)
    return { items: found.map((entry) => toCandidate(entry.release, entry.evaluation)) }
  })

  app.post('/admin/albums/:id/rematch', async (request): Promise<MatchActionResult> => {
    const admin = requireAdmin(request)
    const { id } = IdParams.parse(request.params)
    const body = RematchAlbumRequest.parse(request.body ?? {})
    const { album, files } = await ownedAlbum(id)
    const groups = groupsOf(files)

    if (body.releaseMbid) {
      const release = await fetchRelease(body.releaseMbid)
      const outcome = await db.transaction(async (tx) => {
        const applied = await applyManually(tx, files, release, { artist: album.artistCredit, album: album.title })
        for (const group of groups) await closeReview(tx, group.rootId, group.groupKey, 'resolved', admin.id)
        return applied
      })
      await announce(outcome.result.albumIds, outcome.result.artistIds)
      return matched(outcome.result, outcome.release.mbid, outcome.evaluation)
    }

    const albumId = await db.transaction(async (tx) => {
      const local = album.mbid ? await detach(tx, files) : album.id
      await tx.update(mediaFiles).set({ matchStatus: 'pending', matchLocked: false, matchSource: 'tags', matchConfidence: null, updatedAt: new Date() })
        .where(inArray(mediaFiles.id, files.map((file) => file.id)))
      for (const group of groups) {
        await enqueue('matching.match-album', group, { singletonKey: matchJobKey(group.rootId, group.groupKey), tx })
      }
      return local
    })
    await announce([album.id, ...(albumId ? [albumId] : [])], [])
    return { albumId, status: 'pending', releaseMbid: null, score: null }
  })

  app.post('/admin/albums/:id/unmatch', async (request): Promise<MatchActionResult> => {
    const admin = requireAdmin(request)
    const { id } = IdParams.parse(request.params)
    const { album, files } = await ownedAlbum(id)
    const albumId = await db.transaction(async (tx) => {
      const local = album.mbid ? await detach(tx, files) : album.id
      await tx.update(mediaFiles).set({ matchStatus: 'unmatched', matchLocked: true, matchSource: 'manual', matchConfidence: null, updatedAt: new Date() })
        .where(inArray(mediaFiles.id, files.map((file) => file.id)))
      for (const group of groupsOf(files)) await closeReview(tx, group.rootId, group.groupKey, 'resolved', admin.id)
      return local
    })
    await announce([album.id, ...(albumId ? [albumId] : [])], [])
    return { albumId, status: 'unmatched', releaseMbid: null, score: null }
  })
}
