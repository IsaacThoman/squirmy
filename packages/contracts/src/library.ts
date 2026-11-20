import { z } from 'zod'
import { Id, IsoDateTime } from './common.js'

/** `read_only`: scanned in place, never modified. `managed`: the server may rename, move and tag files. */
export const LibraryRootMode = z.enum(['read_only', 'managed'])
export type LibraryRootMode = z.infer<typeof LibraryRootMode>

export const ScanStats = z.object({
  filesSeen: z.number().int(),
  filesAdded: z.number().int(),
  filesChanged: z.number().int(),
  filesMissing: z.number().int(),
  errors: z.number().int(),
})
export type ScanStats = z.infer<typeof ScanStats>

export const LibraryRoot = z.object({
  id: Id,
  name: z.string(),
  path: z.string(),
  mode: LibraryRootMode,
  enabled: z.boolean(),
  watch: z.boolean(),
  scanning: z.boolean(),
  fileCount: z.number().int(),
  lastScanStartedAt: IsoDateTime.nullable(),
  lastScanFinishedAt: IsoDateTime.nullable(),
  lastScanStats: ScanStats.nullable(),
})
export type LibraryRoot = z.infer<typeof LibraryRoot>

export const CreateLibraryRootRequest = z.object({
  name: z.string().trim().min(1).max(80),
  path: z.string().trim().min(1),
  mode: LibraryRootMode.default('read_only'),
  watch: z.boolean().default(true),
})
export type CreateLibraryRootRequest = z.infer<typeof CreateLibraryRootRequest>

export const UpdateLibraryRootRequest = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  mode: LibraryRootMode.optional(),
  enabled: z.boolean().optional(),
  watch: z.boolean().optional(),
})
export type UpdateLibraryRootRequest = z.infer<typeof UpdateLibraryRootRequest>

export const LibraryStats = z.object({
  artists: z.number().int(),
  albums: z.number().int(),
  tracks: z.number().int(),
  files: z.number().int(),
  bytes: z.number().int(),
  durationMs: z.number().int(),
  matched: z.number().int(),
  unmatched: z.number().int(),
  inReview: z.number().int(),
  pending: z.number().int(),
  missing: z.number().int(),
})
export type LibraryStats = z.infer<typeof LibraryStats>

export const JobQueueStats = z.object({
  name: z.string(),
  queued: z.number().int(),
  active: z.number().int(),
  failed: z.number().int(),
})
export type JobQueueStats = z.infer<typeof JobQueueStats>

/** An absolute path; the server's home directory when absent. */
export const DirectoryQuery = z.object({ path: z.string().min(1).optional() })
export type DirectoryQuery = z.infer<typeof DirectoryQuery>

/** `GET /admin/fs?path=` lists directories on the server so the admin UI can pick a root. */
export const DirectoryListing = z.object({
  path: z.string(),
  parent: z.string().nullable(),
  directories: z.array(z.object({ name: z.string(), path: z.string() })),
})
export type DirectoryListing = z.infer<typeof DirectoryListing>
