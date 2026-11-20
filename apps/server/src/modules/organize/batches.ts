import path from 'node:path'
import {
  Id, ORGANIZE_TAGS_NOT_REVERTED, type OrganizeAlbumMoves, type OrganizeBatch, type OrganizeBatchCounts, type OrganizeBatchListQuery,
  type OrganizeBatchList, type OrganizeBatchSummary, type OrganizeMove,
} from '@squirmy/contracts'
import { and, asc, desc, eq, inArray, lt, ne, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { albums, fileMoves, libraryRoots, mediaFiles, organizeBatches } from '../../database/schema.js'
import { badRequest, notFound } from '../../lib/errors.js'
import { NOT_REVERTED, type BatchOptions, type BatchRow } from './journal.js'

/** Read side of the journal: batches shaped for the admin API. */

type CountRow = { batchId: string; kind: string; status: string; count: number; notReverted: number }

async function countMoves(batchIds: string[]): Promise<Map<string, CountRow[]>> {
  const rows = batchIds.length === 0 ? [] : await db.select({
    batchId: fileMoves.batchId,
    kind: fileMoves.kind,
    status: fileMoves.status,
    count: sql<number>`count(*)::int`,
    notReverted: sql<number>`(count(*) filter (where ${fileMoves.error} like ${`${NOT_REVERTED}%`}))::int`,
  }).from(fileMoves)
    .where(and(inArray(fileMoves.batchId, batchIds), ne(fileMoves.kind, 'directory')))
    .groupBy(fileMoves.batchId, fileMoves.kind, fileMoves.status)
  const out = new Map<string, CountRow[]>()
  for (const row of rows) out.set(row.batchId, [...out.get(row.batchId) ?? [], row])
  return out
}

function counts(batch: BatchRow, rows: CountRow[]): OrganizeBatchCounts {
  const sum = (filter: (row: CountRow) => boolean, field: 'count' | 'notReverted' = 'count') =>
    rows.filter(filter).reduce((total, row) => total + row[field], 0)
  const stats = batch.stats ?? {}
  return {
    planned: sum((row) => row.status === 'planned'),
    applied: sum((row) => row.status === 'applied'),
    failed: sum((row) => row.status === 'failed'),
    skipped: sum((row) => row.status === 'skipped'),
    reverted: sum((row) => row.status === 'reverted'),
    notReverted: sum((row) => row.status === 'applied', 'notReverted'),
    sidecars: sum((row) => row.kind === 'sidecar'),
    unchanged: stats.unchanged ?? 0,
    untrusted: stats.untrusted ?? 0,
    tagsWritten: stats.tagsWritten ?? 0,
    tagsSkipped: stats.tagsSkipped ?? 0,
  }
}

function summary(batch: BatchRow, rootName: string, rows: CountRow[]): OrganizeBatchSummary {
  const options = batch.options as BatchOptions
  return {
    id: batch.id,
    rootId: batch.rootId,
    rootName,
    status: batch.status as OrganizeBatchSummary['status'],
    includeUnmatched: options.includeUnmatched,
    writeTags: options.writeTags,
    template: options.template,
    counts: counts(batch, rows),
    createdAt: batch.createdAt.toISOString(),
    appliedAt: batch.appliedAt?.toISOString() ?? null,
    revertedAt: batch.revertedAt?.toISOString() ?? null,
  }
}

/** One batch's summary. */
export async function getBatchSummary(batchId: string): Promise<OrganizeBatchSummary> {
  const [row] = await db.select({ batch: organizeBatches, rootName: libraryRoots.name }).from(organizeBatches)
    .innerJoin(libraryRoots, eq(libraryRoots.id, organizeBatches.rootId)).where(eq(organizeBatches.id, batchId))
  if (!row) throw notFound('Organize batch not found', 'batch_not_found')
  return summary(row.batch, row.rootName, (await countMoves([batchId])).get(batchId) ?? [])
}

/** A batch with every file and sidecar move, grouped by album. */
export async function getBatch(batchId: string): Promise<OrganizeBatch> {
  const head = await getBatchSummary(batchId)
  const rows = await db.select({
    move: fileMoves,
    albumId: albums.id,
    albumTitle: albums.title,
    albumCredit: albums.artistCredit,
  }).from(fileMoves)
    .leftJoin(mediaFiles, eq(mediaFiles.id, fileMoves.fileId))
    .leftJoin(albums, eq(albums.id, mediaFiles.albumId))
    .where(and(eq(fileMoves.batchId, batchId), ne(fileMoves.kind, 'directory')))
    .orderBy(asc(fileMoves.id))

  type Album = { id: string; title: string; credit: string }
  // A sidecar belongs to the album of the audio files that shared its folder.
  const folderAlbum = new Map<string, Album>()
  for (const row of rows) {
    if (row.albumId) folderAlbum.set(path.posix.dirname(row.move.fromRelPath), { id: row.albumId, title: row.albumTitle!, credit: row.albumCredit! })
  }
  const groups = new Map<string | null, OrganizeAlbumMoves>()
  for (const { move, albumId, albumTitle, albumCredit } of rows) {
    const album = albumId ? { id: albumId, title: albumTitle!, credit: albumCredit! } : move.kind === 'sidecar' ? folderAlbum.get(path.posix.dirname(move.fromRelPath)) : undefined
    const key = album?.id ?? null
    let group = groups.get(key)
    if (!group) {
      group = { albumId: key, title: album?.title ?? 'Not on an album', artistCredit: album?.credit ?? null, moves: [] }
      groups.set(key, group)
    }
    group.moves.push(toMove(move))
  }
  const albumsSorted = [...groups.values()].sort((a, b) =>
    Number(a.albumId === null) - Number(b.albumId === null)
    || (a.artistCredit ?? '').localeCompare(b.artistCredit ?? '') || a.title.localeCompare(b.title))
  return { ...head, albums: albumsSorted, notice: head.writeTags ? ORGANIZE_TAGS_NOT_REVERTED : null }
}

function toMove(move: typeof fileMoves.$inferSelect): OrganizeMove {
  return {
    id: move.id,
    kind: move.kind as OrganizeMove['kind'],
    from: move.fromRelPath,
    to: move.toRelPath,
    status: move.status as OrganizeMove['status'],
    reason: move.error,
  }
}

/** Batches, newest first, optionally for one root. The cursor is the last batch id seen. */
export async function listBatches(query: OrganizeBatchListQuery): Promise<OrganizeBatchList> {
  if (query.cursor && !Id.safeParse(query.cursor).success) throw badRequest('Invalid cursor', 'invalid_cursor')
  const rows = await db.select({ batch: organizeBatches, rootName: libraryRoots.name }).from(organizeBatches)
    .innerJoin(libraryRoots, eq(libraryRoots.id, organizeBatches.rootId))
    .where(and(
      query.rootId ? eq(organizeBatches.rootId, query.rootId) : undefined,
      query.cursor ? lt(organizeBatches.id, query.cursor) : undefined,
    ))
    .orderBy(desc(organizeBatches.id))
    .limit(query.limit + 1)
  const page = rows.slice(0, query.limit)
  const moveCounts = await countMoves(page.map((row) => row.batch.id))
  return {
    items: page.map((row) => summary(row.batch, row.rootName, moveCounts.get(row.batch.id) ?? [])),
    nextCursor: rows.length > query.limit ? page[page.length - 1]!.batch.id : null,
  }
}
