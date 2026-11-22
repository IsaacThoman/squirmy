import { timingSafeEqual } from 'node:crypto'
import {
  AcquireQuery, AcquisitionJobListQuery, CreateAcquisitionProviderRequest, Id, ProviderDeliveryComplete, UpdateAcquisitionPolicy, UpdateAcquisitionProviderRequest,
  type AcquireResponse, type AcquisitionJob, type AcquisitionJobList, type AcquisitionJobStatus, type AcquisitionPolicy, type AcquisitionProvider, type AcquisitionUsage,
  type AcquisitionProviderList, type ClearProviderMissesResponse, type ImportFileResult, type Ok, type ProviderUploadResponse,
} from '@squirmy/contracts'
import { and, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { z } from 'zod'
import { db } from '../../database/client.js'
import { acquisitionJobs, acquisitionProviders, albums, recordings, users } from '../../database/schema.js'
import { requireAdmin, requireUser } from '../../lib/auth.js'
import { hashToken } from '../../lib/crypto.js'
import { AppError, badRequest, conflict, unauthorized } from '../../lib/errors.js'
import { getServerSettings } from '../../lib/settings.js'
import { addImportFile } from '../imports/index.js'
import {
  completeDelivery, DELIVERING, ensureImport, finishJob, loadJob, providerFailed, markDownloading, requestAlbum, requestTrack, touchJob, type JobRow,
} from './jobs.js'
import { cacheUsage, evictWhenOver } from './evict.js'
import { getAcquisitionPolicy, updateAcquisitionPolicy } from './policy.js'
import { clearProviderMisses, createProvider, deleteProvider, listProviders, testProvider, updateProvider } from './providers.js'

const IdParams = z.object({ id: Id })
const JobParams = z.object({ jobId: Id })
/** Delivery requests per job and address per minute. */
const deliveryRateLimit = 120
/** File and field parts per upload request. */
const maxParts = 2_000
/**
 * Explicit acquire requests per user per minute: enough for a device downloading a long
 * playlist track by track. Playback asks the server directly, not through these routes.
 */
const acquireRateLimit = 120

/**
 * What one job may receive in all: room for each requested track at the per-file limit with
 * a quarter to spare, and four files per track (audio, cover, lyrics, cue sheet) plus two.
 * Past either the delivery is refused with 413 and the job fails, so a provider cannot fill
 * the disk through one job. The cache limit is not part of it: a delivery someone is
 * waiting for is always taken, and the cache is brought back under its limit by eviction.
 */
export function deliveryBudget(job: Pick<JobRow, 'recordingIds'>, policy: Pick<AcquisitionPolicy, 'maxFileBytes'>) {
  const tracks = Math.max(1, job.recordingIds.length)
  return { maxImportBytes: Math.ceil(tracks * policy.maxFileBytes * 1.25), maxFiles: tracks * 4 + 2 }
}

/** Jobs as the admin API shows them, newest first. */
async function selectJobs(where: SQL | undefined, limit: number): Promise<AcquisitionJob[]> {
  const rows = await db.select({
    job: acquisitionJobs,
    providerName: acquisitionProviders.name,
    requestedBy: users.username,
    title: sql<string | null>`coalesce(${recordings.title} || ' — ' || ${recordings.artistCredit}, ${albums.title} || ' — ' || ${albums.artistCredit})`,
  }).from(acquisitionJobs)
    .innerJoin(acquisitionProviders, eq(acquisitionProviders.id, acquisitionJobs.providerId))
    .leftJoin(users, eq(users.id, acquisitionJobs.requestedBy))
    .leftJoin(recordings, eq(recordings.id, acquisitionJobs.recordingId))
    .leftJoin(albums, eq(albums.id, acquisitionJobs.albumId))
    .where(where)
    .orderBy(desc(acquisitionJobs.id)).limit(limit)
  return rows.map(({ job, providerName, requestedBy, title }) => ({
    id: job.id,
    providerId: job.providerId,
    providerName,
    requestedBy,
    trackId: job.recordingId,
    albumId: job.albumId,
    title: title ?? 'Unknown',
    status: job.status as AcquisitionJobStatus,
    error: job.error,
    importId: job.importId,
    origin: job.origin,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  }))
}

async function listJobs(query: AcquisitionJobListQuery): Promise<AcquisitionJobList> {
  if (query.cursor && !Id.safeParse(query.cursor).success) throw badRequest('Invalid cursor', 'invalid_cursor')
  const rows = await selectJobs(and(
    query.status ? eq(acquisitionJobs.status, query.status) : undefined,
    query.cursor ? lt(acquisitionJobs.id, query.cursor) : undefined,
  ), query.limit + 1)
  const items = rows.slice(0, query.limit)
  return { items, nextCursor: rows.length > query.limit ? items[items.length - 1]!.id : null }
}

const jobsById = (ids: readonly string[]) => selectJobs(inArray(acquisitionJobs.id, [...ids]), ids.length)

/** The job whose bearer token the request carries, while it may still deliver. */
async function deliveringJob(request: FastifyRequest, jobId: string): Promise<JobRow> {
  const header = request.headers.authorization
  const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : ''
  const job = await loadJob(jobId)
  const given = Buffer.from(hashToken(token))
  const expected = Buffer.from(job?.uploadTokenHash ?? '')
  if (!job || !token || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw unauthorized('This token is not valid for this delivery', 'invalid_delivery_token')
  }
  if (!DELIVERING.includes(job.status as AcquisitionJobStatus)) throw conflict('This job no longer accepts deliveries', 'job_not_active')
  return job
}

/** Routes of the acquisition module: admin, explicit requests, and provider deliveries. */
export async function acquisitionRoutes(app: FastifyInstance) {
  const deliveryLimit = app.createRateLimit({
    max: deliveryRateLimit,
    timeWindow: 60_000,
    keyGenerator: (request) => `acquisition-delivery:${(request.params as { jobId?: string }).jobId}:${request.ip}`,
  })
  const limitDeliveries = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await deliveryLimit(request)
    if (result.isAllowed || !result.isExceeded) return
    reply.header('retry-after', result.ttlInSeconds)
    throw new AppError(429, 'rate_limited', `Too many delivery requests. Try again in ${result.ttlInSeconds} seconds.`)
  }
  const acquireLimit = app.createRateLimit({
    max: acquireRateLimit,
    timeWindow: 60_000,
    keyGenerator: (request) => `acquire:${request.user?.id ?? request.ip}`,
  })
  const limitAcquires = async (request: FastifyRequest, reply: FastifyReply) => {
    const result = await acquireLimit(request)
    if (result.isAllowed || !result.isExceeded) return
    reply.header('retry-after', result.ttlInSeconds)
    throw new AppError(429, 'rate_limited', `Too many requests. Try again in ${result.ttlInSeconds} seconds.`)
  }

  app.get('/admin/acquisition/providers', async (request): Promise<AcquisitionProviderList> => {
    requireAdmin(request)
    return { items: await listProviders(), nextCursor: null }
  })

  app.post('/admin/acquisition/providers', async (request, reply): Promise<AcquisitionProvider> => {
    requireAdmin(request)
    const body = CreateAcquisitionProviderRequest.parse(request.body)
    reply.code(201)
    return createProvider(body)
  })

  app.patch('/admin/acquisition/providers/:id', async (request): Promise<AcquisitionProvider> => {
    requireAdmin(request)
    return updateProvider(IdParams.parse(request.params).id, UpdateAcquisitionProviderRequest.parse(request.body))
  })

  app.delete('/admin/acquisition/providers/:id', async (request): Promise<Ok> => {
    requireAdmin(request)
    await deleteProvider(IdParams.parse(request.params).id)
    return { ok: true }
  })

  app.post('/admin/acquisition/providers/:id/test', async (request): Promise<AcquisitionProvider> => {
    requireAdmin(request)
    return testProvider(IdParams.parse(request.params).id)
  })

  app.post('/admin/acquisition/providers/:id/clear-misses', async (request): Promise<ClearProviderMissesResponse> => {
    requireAdmin(request)
    return clearProviderMisses(IdParams.parse(request.params).id)
  })

  app.get('/admin/acquisition/policy', async (request): Promise<AcquisitionPolicy> => {
    requireAdmin(request)
    return getAcquisitionPolicy()
  })

  app.patch('/admin/acquisition/policy', async (request): Promise<AcquisitionPolicy> => {
    requireAdmin(request)
    return updateAcquisitionPolicy(UpdateAcquisitionPolicy.parse(request.body))
  })

  app.get('/admin/acquisition/jobs', async (request): Promise<AcquisitionJobList> => {
    requireAdmin(request)
    return listJobs(AcquisitionJobListQuery.parse(request.query))
  })

  app.get('/admin/acquisition/usage', async (request): Promise<AcquisitionUsage> => {
    requireAdmin(request)
    return cacheUsage()
  })

  app.post('/tracks/:id/acquire', { preHandler: limitAcquires }, async (request, reply): Promise<AcquireResponse> => {
    const user = requireUser(request)
    const { albumId, origin } = AcquireQuery.parse(request.query)
    const job = await requestTrack(user.id, IdParams.parse(request.params).id, albumId ?? null, origin ?? 'library')
    reply.code(202)
    return { items: await jobsById([job.id]) }
  })

  app.post('/albums/:id/acquire', { preHandler: limitAcquires }, async (request, reply): Promise<AcquireResponse> => {
    const user = requireUser(request)
    const albumId = IdParams.parse(request.params).id
    // Fetching never adds to a library: only the heart does (`PUT /me/likes/album/:id`, which
    // asks for the files itself). This used to save the album for the default origin, so any
    // caller that only meant to fetch put albums in the user's library unasked.
    const { origin = 'library' } = AcquireQuery.parse(request.query)
    const jobs = await requestAlbum(user.id, albumId, origin)
    reply.code(202)
    return { items: await jobsById(jobs.map((job) => job.id)) }
  })

  app.post('/acquisition/deliveries/:jobId/files', { preHandler: limitDeliveries }, async (request): Promise<ProviderUploadResponse> => {
    const job = await deliveringJob(request, JobParams.parse(request.params).jobId)
    if (!request.isMultipart()) throw badRequest('Send the files as multipart/form-data', 'not_multipart')
    const policy = await getAcquisitionPolicy()
    const { importMaxFileBytes } = await getServerSettings()
    const budget = deliveryBudget(job, policy)
    const importId = await ensureImport(job)
    await markDownloading(job.id)
    const files: ImportFileResult[] = []
    let relativePath: string | undefined
    try {
      // Our own byte count enforces the limit; the parser's is one byte looser so ours speaks first.
      for await (const part of request.parts({ limits: { fileSize: Math.min(policy.maxFileBytes, importMaxFileBytes) + 1, parts: maxParts } })) {
        if (part.type === 'field') {
          if (part.fieldname === 'relativePath') relativePath = String(part.value)
          continue
        }
        files.push(await addImportFile(importId, {
          filename: part.filename, relativePath, stream: part.file, maxFileBytes: policy.maxFileBytes, ...budget, rejectEmptyAudio: true,
        }))
        relativePath = undefined
      }
    } catch (error) {
      if (error instanceof AppError && error.status === 413) {
        await finishJob(job.id, { status: 'failed', error: `The delivery went over the limit: ${error.message}`, missed: job.recordingIds })
      }
      throw error
    }
    await touchJob(job.id)
    // The cache limit is kept by evicting, not by refusing what a listener is waiting for.
    await evictWhenOver()
    return { files }
  })

  app.post('/acquisition/deliveries/:jobId/complete', { preHandler: limitDeliveries }, async (request): Promise<Ok> => {
    const job = await deliveringJob(request, JobParams.parse(request.params).jobId)
    const body = ProviderDeliveryComplete.parse(request.body)
    if (body.status === 'failed') {
      await providerFailed(job, `The provider failed: ${body.error ?? 'no reason given'}`, body)
    } else {
      await completeDelivery(job.id)
    }
    return { ok: true }
  })
}
