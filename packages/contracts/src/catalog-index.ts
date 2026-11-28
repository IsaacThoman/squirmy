import { z } from 'zod'
import { Id, IsoDateTime } from './common.js'

/**
 * The optional local search index built from MusicBrainz canonical data dumps.
 * See docs/local-search-index.md.
 */

export const CatalogIndexKind = z.enum(['artist', 'album', 'recording'])
export type CatalogIndexKind = z.infer<typeof CatalogIndexKind>

/**
 * `active` is the import whose index is in use; at most one import is `running` or
 * `interrupted`. `interrupted`: a restart of the server stopped it, and a worker carries
 * on from its last checkpoint shortly. Only an admin's cancel ends an import `cancelled`.
 */
export const CatalogIndexImportState = z.enum(['running', 'interrupted', 'active', 'failed', 'cancelled', 'replaced', 'dropped'])
export type CatalogIndexImportState = z.infer<typeof CatalogIndexImportState>

/** `download`: streaming the dump into staging tables. `build`: deriving rows and indexes. `swap`: replacing the index. */
export const CatalogIndexImportPhase = z.enum(['download', 'build', 'swap'])
export type CatalogIndexImportPhase = z.infer<typeof CatalogIndexImportPhase>

export const CatalogIndexImport = z.object({
  id: Id,
  state: CatalogIndexImportState,
  phase: CatalogIndexImportPhase.nullable(),
  /** URL or server path of the dump. */
  source: z.string().nullable(),
  /** When MetaBrainz produced the dump. */
  dumpDate: IsoDateTime.nullable(),
  recordingsPerArtist: z.number().int().nullable(),
  /** Compressed bytes read so far, out of `totalBytes` when the size is known. */
  bytesRead: z.number().int(),
  totalBytes: z.number().int().nullable(),
  /** Recording rows read from the dump so far. */
  rowsRead: z.number().int(),
  error: z.string().nullable(),
  /** How many times a restart stopped the import and it carried on from its last checkpoint. */
  resumes: z.number().int(),
  /** When it last carried on after a restart. */
  resumedAt: IsoDateTime.nullable(),
  startedAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
})
export type CatalogIndexImport = z.infer<typeof CatalogIndexImport>

/** `GET /admin/catalog-index` */
export const CatalogIndexStatus = z.object({
  /** True when an index is in place and search can use it. */
  ready: z.boolean(),
  dumpDate: IsoDateTime.nullable(),
  importedAt: IsoDateTime.nullable(),
  counts: z.object({ artists: z.number().int(), albums: z.number().int(), recordings: z.number().int() }),
  /** Disk used by the index table and its indexes. */
  sizeBytes: z.number().int(),
  /** Unicode and composite search indexes for the active import, if any. */
  searchUpgrade: z.enum(['pending', 'building', 'ready']).nullable().optional(),
  /** The import in use, if any. */
  active: CatalogIndexImport.nullable(),
  /** The newest import when it is not the active one: running, interrupted, failed or cancelled. */
  latest: CatalogIndexImport.nullable(),
})
export type CatalogIndexStatus = z.infer<typeof CatalogIndexStatus>

/** `POST /admin/catalog-index/import`. Answered with 202 once the job is queued. */
export const StartCatalogIndexImport = z.object({
  /** A `.tar.zst` dump URL, or a path on the server. Default: the newest published dump. */
  source: z.string().trim().min(1).max(2000).optional(),
  /** Size knob: keep at most this many recordings per artist credit, best first. Null keeps all. */
  recordingsPerArtist: z.number().int().min(1).max(100_000).nullable().default(null),
})
export type StartCatalogIndexImport = z.infer<typeof StartCatalogIndexImport>
