import { CreateLibraryRootRequest, Id, queryKeys, UpdateLibraryRootRequest, type LibraryRoot, type LibraryRootList, type LibraryStats, type Ok, type ScanRootResponse } from '@squirmy/contracts'
import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { db } from '../../database/client.js'
import { libraryRoots } from '../../database/schema.js'
import { requireAdmin } from '../../lib/auth.js'
import { conflict, notFound } from '../../lib/errors.js'
import { invalidate } from '../../realtime/index.js'
import { lockCatalog, removeOrphans } from './cleanup.js'
import { invalidateSoon } from './progress.js'
import { insertRoot, listRoots, requestScan, resolveRootPath } from './roots.js'
import { refreshWatchers } from './watch.js'

const IdParams = z.object({ id: Id })

async function getRoot(id: string): Promise<LibraryRoot> {
  const [root] = await listRoots(db, id)
  if (!root) throw notFound('No such library root')
  return root
}

async function libraryStats(): Promise<LibraryStats> {
  const [files] = await db.execute<Omit<LibraryStats, 'artists'>>(sql`
    select
      count(*) filter (where missing_since is null)::int as files,
      coalesce(sum(size) filter (where missing_since is null), 0)::float8 as bytes,
      coalesce(sum(duration_ms) filter (where missing_since is null), 0)::float8 as "durationMs",
      count(distinct recording_id) filter (where missing_since is null)::int as tracks,
      count(distinct album_id) filter (where missing_since is null)::int as albums,
      count(*) filter (where missing_since is null and match_status = 'matched')::int as matched,
      count(*) filter (where missing_since is null and match_status = 'unmatched')::int as unmatched,
      count(*) filter (where missing_since is null and match_status = 'review')::int as "inReview",
      count(*) filter (where missing_since is null and match_status = 'pending')::int as pending,
      count(*) filter (where missing_since is not null)::int as missing
    from media_files`)
  const [credited] = await db.execute<{ artists: number }>(sql`
    select count(*)::int as artists from (
      select aa.artist_id from album_artists aa where aa.album_id in (select album_id from media_files where missing_since is null)
      union
      select ra.artist_id from recording_artists ra where ra.recording_id in (select recording_id from media_files where missing_since is null)
    ) owned`)
  return { artists: credited?.artists ?? 0, ...files! }
}

export async function libraryRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request) => {
    requireAdmin(request)
  })

  app.get('/admin/library/roots', async (): Promise<LibraryRootList> => ({ items: await listRoots(), nextCursor: null }))

  app.post('/admin/library/roots', async (request, reply): Promise<LibraryRoot> => {
    const body = CreateLibraryRootRequest.parse(request.body)
    const root = await insertRoot({ ...body, path: await resolveRootPath(body.path) })
    await requestScan(root.id)
    await refreshWatchers()
    await invalidate('admins', [queryKeys.adminRoots()])
    reply.code(201)
    return getRoot(root.id)
  })

  app.patch('/admin/library/roots/:id', async (request): Promise<LibraryRoot> => {
    const { id } = IdParams.parse(request.params)
    const body = UpdateLibraryRootRequest.parse(request.body)
    const [before] = await db.select({ enabled: libraryRoots.enabled }).from(libraryRoots).where(eq(libraryRoots.id, id))
    if (!before) throw notFound('No such library root')
    await db.update(libraryRoots).set({ ...body, updatedAt: new Date() }).where(eq(libraryRoots.id, id))
    if (!before.enabled && body.enabled) await requestScan(id)
    await refreshWatchers()
    await invalidate('admins', [queryKeys.adminRoots()])
    return getRoot(id)
  })

  // Forgets the root's files and the catalog rows only they used. Nothing on disk is touched.
  app.delete('/admin/library/roots/:id', async (request): Promise<Ok> => {
    const { id } = IdParams.parse(request.params)
    const deleted = await db.transaction(async (tx) => {
      await lockCatalog(tx)
      const rows = await tx.delete(libraryRoots).where(eq(libraryRoots.id, id)).returning({ id: libraryRoots.id })
      if (rows.length > 0) await removeOrphans(tx)
      return rows.length > 0
    })
    if (!deleted) throw notFound('No such library root')
    await refreshWatchers()
    await invalidate('admins', [queryKeys.adminRoots()])
    invalidateSoon([queryKeys.library(), queryKeys.home()])
    return { ok: true }
  })

  app.post('/admin/library/roots/:id/scan', async (request, reply): Promise<ScanRootResponse> => {
    const { id } = IdParams.parse(request.params)
    const root = await getRoot(id)
    if (!root.enabled) throw conflict('Enable the root before scanning it', 'root_disabled')
    const queued = await requestScan(id)
    await invalidate('admins', [queryKeys.adminRoots()])
    reply.code(202)
    return { queued }
  })

  app.get('/admin/library/stats', async (): Promise<LibraryStats> => libraryStats())
}
