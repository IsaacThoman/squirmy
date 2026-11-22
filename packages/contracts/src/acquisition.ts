import { z } from 'zod'
import { Id, IsoDateTime, PageQuery, page } from './common.js'
import { ImportFileResult } from './imports.js'

/**
 * The acquisition provider protocol, version 1. A provider is an HTTP service the
 * operator runs that can supply audio files for music the server does not have.
 * See docs/provider-protocol.md for the narrative version.
 *
 * Schemas prefixed `Provider` describe the wire format between the server and a
 * provider. The rest are the admin and client API.
 */
export const PROVIDER_PROTOCOL_VERSION = 1

/**
 * `assume_available`: the provider claims to cover everything; tracks show as
 * on demand without asking first, and a failed request turns the track gray.
 * `must_resolve`: a track is on demand only after the provider confirmed an offer.
 */
export const ProviderCoverage = z.enum(['assume_available', 'must_resolve'])
export type ProviderCoverage = z.infer<typeof ProviderCoverage>

/** `GET {baseUrl}/capabilities` */
export const ProviderCapabilities = z.object({
  protocol: z.literal(PROVIDER_PROTOCOL_VERSION),
  name: z.string().min(1).max(80),
  coverage: ProviderCoverage,
  /** What can be requested: single recordings, whole albums, or both. */
  kinds: z.array(z.enum(['recording', 'album'])).min(1),
  /** Container/codec names the provider can deliver, e.g. flac, mp3, m4a, opus. */
  formats: z.array(z.string()).default([]),
  /** How many acquire jobs the provider wants to run at once. */
  maxConcurrent: z.number().int().min(1).max(32).default(2),
})
export type ProviderCapabilities = z.infer<typeof ProviderCapabilities>

/** Everything the server knows that identifies a recording. Most fields may be absent. */
export const ProviderRecordingQuery = z.object({
  mbid: z.string().nullable(),
  isrcs: z.array(z.string()),
  title: z.string(),
  artist: z.string(),
  durationMs: z.number().int().nonnegative().nullable(),
  album: z.object({
    title: z.string(),
    /** MusicBrainz release group id. */
    mbid: z.string().nullable(),
    year: z.number().int().nullable(),
    disc: z.number().int().nullable(),
    position: z.number().int().nullable(),
  }).nullable(),
})
export type ProviderRecordingQuery = z.infer<typeof ProviderRecordingQuery>

export const ProviderAlbumQuery = z.object({
  /** MusicBrainz release group id. */
  mbid: z.string().nullable(),
  title: z.string(),
  artist: z.string(),
  year: z.number().int().nullable(),
  barcode: z.string().nullable(),
  tracks: z.array(z.object({
    disc: z.number().int(),
    position: z.number().int(),
    title: z.string(),
    durationMs: z.number().int().nonnegative().nullable(),
    recordingMbid: z.string().nullable(),
    isrcs: z.array(z.string()),
    /**
     * False for a track the server already has: it is listed so the provider can tell the
     * edition apart, but must not be delivered. Absent means wanted.
     */
    wanted: z.boolean().optional(),
  })),
})
export type ProviderAlbumQuery = z.infer<typeof ProviderAlbumQuery>

export const ProviderResolveItem = z.discriminatedUnion('kind', [
  z.object({ ref: z.string(), kind: z.literal('recording'), recording: ProviderRecordingQuery }),
  z.object({ ref: z.string(), kind: z.literal('album'), album: ProviderAlbumQuery }),
])
export type ProviderResolveItem = z.infer<typeof ProviderResolveItem>

/** `POST {baseUrl}/resolve` request. */
export const ProviderResolveRequest = z.object({ items: z.array(ProviderResolveItem).min(1).max(100) })
export type ProviderResolveRequest = z.infer<typeof ProviderResolveRequest>

/** One way the provider can fulfil a request. */
export const ProviderOffer = z.object({
  /** Opaque to the server; sent back in `acquire`. */
  offerId: z.string().min(1).max(500),
  format: z.string(),
  lossless: z.boolean(),
  bitrate: z.number().int().nullable().optional(),
  sampleRate: z.number().int().nullable().optional(),
  bitDepth: z.number().int().nullable().optional(),
  bytes: z.number().int().nullable().optional(),
  /** Rough time to deliver, for the "preparing" UI. */
  etaSeconds: z.number().int().nullable().optional(),
  /**
   * Reserved for purchasing. This version of the server ignores any offer that has a
   * price; free offers omit the field or send null.
   */
  price: z.object({ amount: z.string(), currency: z.string().length(3) }).nullable().optional(),
  expiresAt: IsoDateTime.nullable().optional(),
})
export type ProviderOffer = z.infer<typeof ProviderOffer>

/** `POST {baseUrl}/resolve` response. An item with no offers cannot be supplied. */
export const ProviderResolveResponse = z.object({
  items: z.array(z.object({ ref: z.string(), offers: z.array(ProviderOffer) })),
})
export type ProviderResolveResponse = z.infer<typeof ProviderResolveResponse>

/** `POST {baseUrl}/acquire` request. The provider uploads the files to `delivery`. */
export const ProviderAcquireRequest = z.object({
  /** The server's job id. Use it as an idempotency key: the same id may be sent twice. */
  jobId: Id,
  offerId: z.string(),
  delivery: z.object({
    /** POST multipart/form-data here, one or more `file` parts. */
    uploadUrl: z.string().url(),
    /** POST `ProviderDeliveryComplete` here when done or failed. */
    completeUrl: z.string().url(),
    /** Bearer token valid only for this job's two URLs. */
    token: z.string(),
  }),
})
export type ProviderAcquireRequest = z.infer<typeof ProviderAcquireRequest>

export const ProviderAcquireResponse = z.object({
  accepted: z.boolean(),
  /** The provider's own id, used for status polling and cancellation. */
  providerJobId: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  /**
   * Why a job was declined, when the provider knows. `busy`: it cannot take the job now
   * (too many at once); the server tries again later and does not count it against the
   * tracks. Any other value, or none, is a definite refusal.
   */
  reason: z.string().max(40).nullable().optional(),
})
export type ProviderAcquireResponse = z.infer<typeof ProviderAcquireResponse>

/** `GET {baseUrl}/jobs/{providerJobId}`, polled when the provider goes quiet. */
export const ProviderJobStatus = z.object({
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  progress: z.number().min(0).max(1).nullable().optional(),
  error: z.string().nullable().optional(),
})
export type ProviderJobStatus = z.infer<typeof ProviderJobStatus>

/**
 * Answer to a `delivery.uploadUrl` request: what happened to each file part. A file is
 * `rejected` by name or type (see `ImportFileRejection`); a file over the operator's size
 * limit ends the request with 413 and fails the job.
 */
export const ProviderUploadResponse = z.object({ files: z.array(ImportFileResult) })
export type ProviderUploadResponse = z.infer<typeof ProviderUploadResponse>

/** Body the provider posts to `delivery.completeUrl`. */
export const ProviderDeliveryComplete = z.object({
  status: z.enum(['completed', 'failed']),
  error: z.string().nullable().optional(),
})
export type ProviderDeliveryComplete = z.infer<typeof ProviderDeliveryComplete>

// ---------------------------------------------------------------------------
// Admin and client API
// ---------------------------------------------------------------------------

export const AcquisitionProvider = z.object({
  id: Id,
  name: z.string(),
  baseUrl: z.string(),
  enabled: z.boolean(),
  coverage: ProviderCoverage,
  /** Providers are tried in descending priority. */
  priority: z.number().int(),
  capabilities: ProviderCapabilities.nullable(),
  /** When it last answered a connection test or delivered a fetch. */
  lastOkAt: IsoDateTime.nullable(),
  lastError: z.string().nullable(),
  /**
   * Set while the provider is failing: fetches of several different tracks failed with
   * nothing delivered since this time (`lastError` says why). Null while it delivers.
   */
  failingSince: IsoDateTime.nullable(),
})
export type AcquisitionProvider = z.infer<typeof AcquisitionProvider>

/** `GET /admin/acquisition/providers`: every provider, with `nextCursor: null`. */
export const AcquisitionProviderList = page(AcquisitionProvider)
export type AcquisitionProviderList = z.infer<typeof AcquisitionProviderList>

/**
 * `POST /admin/acquisition/providers`. The server calls `GET {baseUrl}/capabilities` right
 * away; an unreachable provider is still saved, with `lastError` set.
 */
export const CreateAcquisitionProviderRequest = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().url(),
  /** Shared secret the server sends as a bearer token. Never returned. */
  secret: z.string().min(8),
  enabled: z.boolean().default(true),
  priority: z.number().int().default(0),
})
export type CreateAcquisitionProviderRequest = z.infer<typeof CreateAcquisitionProviderRequest>

/** `PATCH /admin/acquisition/providers/:id`. Keys left out keep their value, so nothing here has a default. */
export const UpdateAcquisitionProviderRequest = z.object({
  name: z.string().trim().min(1).max(80),
  baseUrl: z.string().url(),
  secret: z.string().min(8),
  enabled: z.boolean(),
  priority: z.number().int(),
  /**
   * Overrides the coverage the provider declares, and survives later `capabilities`
   * answers: an operator whose provider fetches nearly anything sets `assume_available` so
   * search results are playable on first sight instead of after a resolve.
   */
  coverage: ProviderCoverage,
}).partial()
export type UpdateAcquisitionProviderRequest = z.infer<typeof UpdateAcquisitionProviderRequest>

/**
 * `resolving`: asking providers for offers (or waiting for a free slot at the provider).
 * `queued`: the provider accepted the job. `downloading`: files are arriving.
 * `importing`: the delivery is complete and the import pipeline has it. `rejected`: refused
 * by policy or by the provider before anything was fetched.
 */
export const AcquisitionJobStatus = z.enum(['resolving', 'queued', 'downloading', 'importing', 'completed', 'failed', 'rejected'])
export type AcquisitionJobStatus = z.infer<typeof AcquisitionJobStatus>

/**
 * Why a job was started, which orders waiting jobs (`play` first, then `prefetch`,
 * `download`, `library`). `play`: the current queue entry. `prefetch`: an upcoming entry.
 * `library`: added to someone's library or an explicit request. `download`: a device is
 * downloading it.
 */
export const AcquisitionOrigin = z.enum(['play', 'prefetch', 'library', 'download'])
export type AcquisitionOrigin = z.infer<typeof AcquisitionOrigin>

export const AcquisitionJob = z.object({
  id: Id,
  providerId: Id,
  providerName: z.string(),
  /** Username of whoever asked; null once that user is deleted. */
  requestedBy: z.string().nullable(),
  trackId: Id.nullable(),
  albumId: Id.nullable(),
  title: z.string(),
  status: AcquisitionJobStatus,
  error: z.string().nullable(),
  /** The import that received the delivery, once files arrived. */
  importId: Id.nullable(),
  /** Optional for older servers. */
  origin: AcquisitionOrigin.optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
})
export type AcquisitionJob = z.infer<typeof AcquisitionJob>

/** `GET /admin/acquisition/jobs`: newest first. */
export const AcquisitionJobListQuery = PageQuery.extend({ status: AcquisitionJobStatus.optional() })
export type AcquisitionJobListQuery = z.infer<typeof AcquisitionJobListQuery>
export const AcquisitionJobList = page(AcquisitionJob)
export type AcquisitionJobList = z.infer<typeof AcquisitionJobList>

/**
 * Query of `POST /tracks/:id/acquire` and `POST /albums/:id/acquire`. `albumId` (tracks
 * only) is the album the track is played from, so the request names it. `origin` defaults
 * to `library`; a device downloading music says `download`. Play and prefetch requests come
 * from the server itself, so clients cannot claim them.
 */
export const AcquireQuery = z.object({
  albumId: Id.optional(),
  origin: z.enum(['library', 'download']).optional(),
})
export type AcquireQuery = z.infer<typeof AcquireQuery>

/**
 * `POST /tracks/:id/acquire` and `POST /albums/:id/acquire` (202). The jobs now working on
 * the request: an existing job when one is already in flight, one job for an album the
 * provider takes whole, or one per missing track otherwise. Error codes: `acquire_not_allowed`
 * (the user may not trigger fetches), `already_available`, `not_available` (no enabled
 * provider covers it), `acquire_limit_reached` (429: a member has too many fetches
 * running). The cache limit never refuses a request; it evicts instead.
 */
export const AcquireResponse = z.object({ items: z.array(AcquisitionJob) })
export type AcquireResponse = z.infer<typeof AcquireResponse>

/** Operator policy for on-demand fetching, stored with the server settings. */
export const AcquisitionPolicy = z.object({
  /** Prefer lossless offers when a provider returns several. */
  preferLossless: z.boolean().default(true),
  /** Reject deliveries larger than this per file. */
  maxFileBytes: z.number().int().min(0).default(500 * 1024 ** 2),
  /**
   * Cache limit for files delivered by providers. Reaching it evicts the least recently
   * played unpinned files instead of refusing a fetch, so playback never fails on it.
   * 0 means unlimited.
   */
  storageQuotaBytes: z.number().int().min(0).default(0),
  /** Fail a job whose provider has not delivered after this long. */
  timeoutSeconds: z.number().int().min(30).max(86_400).default(900),
  /** Managed library root that receives the files. Null means the root imports go to (`importRootId`). */
  targetRootId: Id.nullable().default(null),
  /**
   * Origin the delivery URLs handed to providers start with, e.g. `http://app:4747` for
   * a provider in another container. Null means `PUBLIC_URL`, else `http://localhost:<PORT>`.
   */
  deliveryBaseUrl: z.string().url().nullable().default(null),
})
export type AcquisitionPolicy = z.infer<typeof AcquisitionPolicy>

/**
 * `GET /admin/acquisition/usage`: the provider cache against its limit. Pinned files (saved,
 * liked, in a playlist or a stored queue, or played in the last day) are never evicted.
 * `limitBytes` is `storageQuotaBytes`, 0 for unlimited.
 */
export const AcquisitionUsage = z.object({
  cachedFiles: z.number().int().nonnegative(),
  cachedBytes: z.number().int().nonnegative(),
  pinnedBytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().nonnegative(),
})
export type AcquisitionUsage = z.infer<typeof AcquisitionUsage>

/** `PATCH /admin/acquisition/policy`. Keys left out keep their value. */
export const UpdateAcquisitionPolicy = z.object({
  preferLossless: z.boolean(),
  maxFileBytes: z.number().int().min(0),
  storageQuotaBytes: z.number().int().min(0),
  timeoutSeconds: z.number().int().min(30).max(86_400),
  targetRootId: Id.nullable(),
  deliveryBaseUrl: z.string().url().nullable(),
}).partial()
export type UpdateAcquisitionPolicy = z.infer<typeof UpdateAcquisitionPolicy>
