import { z } from 'zod'
import { AlbumSummary } from './catalog.js'
import { Id, IsoDateTime, PageQuery, page } from './common.js'

/**
 * Imports: how new music enters the library through the server. An import is a batch of
 * files from a web upload, the inbox folder, or an acquisition provider. It moves through
 *
 *   receiving → processing (extracting → moving → identifying → filing) → completed | failed
 *
 * While receiving, files wait in the server's staging folder. Processing moves them into
 * the target managed root under `_Incoming/<importId>/`, lets the library pipeline read,
 * identify and match them, and files confidently identified albums into place. Music that
 * could not be identified stays in `_Incoming/<importId>/`, playable, until an admin fixes
 * its match and organizes it.
 *
 * Error codes: `no_managed_root`, `import_root_not_set` (several managed roots and no
 * `importRootId`), `import_root_unavailable`, `import_not_receiving`, `import_empty`,
 * `file_too_large`, `import_too_large`.
 */

/** Folder at the top of a managed root that holds imports until they are filed. */
export const INCOMING_FOLDER = '_Incoming'

export const ImportKind = z.enum(['upload', 'inbox', 'acquisition'])
export type ImportKind = z.infer<typeof ImportKind>

export const ImportStatus = z.enum(['receiving', 'processing', 'completed', 'failed'])
export type ImportStatus = z.infer<typeof ImportStatus>

/** Where a `processing` import is. Null in every other status. */
export const ImportStep = z.enum(['extracting', 'moving', 'identifying', 'filing'])
export type ImportStep = z.infer<typeof ImportStep>

/**
 * Why a file was not taken. `unsupported_type`: not audio, a sidecar (`cover.*` and
 * `folder.*` images, `.lrc`, `.cue`, `.log`) or a `.zip`. `unsafe_path`: absolute, `..`,
 * control characters, too deep or too long. `hidden`: dot files and system folders, which
 * are skipped quietly. `duplicate_name`: the import already has a file at that path.
 * `nested_archive`: a zip inside a zip, which is not extracted. `unsafe_archive`: a zip
 * with an unsafe path, a symbolic link, encryption, or more entries or bytes than the
 * limits allow; nothing in it is extracted. `unreadable_archive`: a damaged zip.
 */
export const ImportFileRejection = z.enum([
  'unsupported_type', 'unsafe_path', 'hidden', 'duplicate_name', 'nested_archive', 'unsafe_archive', 'unreadable_archive',
])
export type ImportFileRejection = z.infer<typeof ImportFileRejection>

export const ImportCounts = z.object({
  /** Files accepted while receiving; an archive counts as one. */
  filesReceived: z.number().int(),
  bytesReceived: z.number().int(),
  /** Files refused by name or type, while receiving or inside archives. */
  filesRejected: z.number().int(),
  /** Files taken out of archives. */
  filesExtracted: z.number().int(),
  archivesRejected: z.number().int(),
  /** Audio files that reached the library root. */
  audioFiles: z.number().int(),
  /** Audio files removed because the library already had the same audio. */
  duplicatesSkipped: z.number().int(),
  /** Audio files nothing could read. They stay for review. */
  unreadable: z.number().int(),
  /** Albums the matcher identified with confidence. */
  albumsIdentified: z.number().int(),
  /** Albums with at least one file filed into place. */
  albumsFiled: z.number().int(),
  filesFiled: z.number().int(),
  /** Audio files still in `_Incoming/<importId>/`. */
  filesLeftForReview: z.number().int(),
})
export type ImportCounts = z.infer<typeof ImportCounts>

export const Import = z.object({
  id: Id,
  kind: ImportKind,
  status: ImportStatus,
  step: ImportStep.nullable(),
  /** The inbox item's name, or what the uploader called the import. */
  label: z.string().nullable(),
  userId: Id.nullable(),
  acquisitionJobId: Id.nullable(),
  targetRootId: Id.nullable(),
  counts: ImportCounts,
  /** True when identification ran out of time and what was still pending was left for review. */
  timedOut: z.boolean(),
  /** Root-relative folder holding files left for review, when there are any. */
  reviewFolder: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  completedAt: IsoDateTime.nullable(),
})
export type Import = z.infer<typeof Import>

/** Why uploads cannot start: the error `POST /imports` would fail with. */
export const ImportUnavailable = z.enum(['no_managed_root', 'import_root_not_set', 'import_root_unavailable'])
export type ImportUnavailable = z.infer<typeof ImportUnavailable>

/**
 * `GET /imports/options`: what an upload may be before one starts, so a client can say why
 * uploading is not possible and refuse files over the limits without sending them.
 */
export const ImportOptions = z.object({
  /** Null when uploads can be filed. */
  unavailable: ImportUnavailable.nullable(),
  /** Largest single file, archives included (`importMaxFileBytes`). */
  maxFileBytes: z.number().int(),
  /** Largest import, counting what its archives extract to (`importMaxBytes`). */
  maxBytes: z.number().int(),
})
export type ImportOptions = z.infer<typeof ImportOptions>

/** `POST /imports`. */
export const CreateImportRequest = z.object({
  label: z.string().trim().min(1).max(200).optional(),
})
export type CreateImportRequest = z.infer<typeof CreateImportRequest>

/** One file part of `POST /imports/:id/files`. `path` is where it lands inside the import. */
export const ImportFileResult = z.object({
  path: z.string(),
  status: z.enum(['accepted', 'rejected']),
  reason: ImportFileRejection.nullable(),
  bytes: z.number().int(),
})
export type ImportFileResult = z.infer<typeof ImportFileResult>

/**
 * `POST /imports/:id/files`, `multipart/form-data` with any number of `file` parts. A text
 * field `relativePath` sent just before a file part names that file's path inside the
 * import, including its name (a dropped folder's `webkitRelativePath`); without one the
 * part's filename is used. A file over the size limits ends the request with 413; files
 * before it are kept.
 */
export const ImportFilesResponse = z.object({
  import: Import,
  files: z.array(ImportFileResult),
})
export type ImportFilesResponse = z.infer<typeof ImportFilesResponse>

/**
 * `GET /imports`, newest first: the caller's own imports, or every import for an admin.
 * Without `kind`, acquisition deliveries are left out: they are cache filled by listening,
 * not music someone added.
 */
export const ImportListQuery = PageQuery.extend({
  status: ImportStatus.optional(),
  kind: ImportKind.optional(),
})
export type ImportListQuery = z.infer<typeof ImportListQuery>

export const ImportList = page(Import)
export type ImportList = z.infer<typeof ImportList>

/**
 * `GET /imports/:id/albums`: the albums an import's present audio files belong to, in title
 * order, with `nextCursor: null`. `filed` is false while any of them is still in
 * `_Incoming/<importId>/`, waiting for review.
 */
export const ImportAlbum = z.object({
  album: AlbumSummary,
  files: z.number().int(),
  filed: z.boolean(),
})
export type ImportAlbum = z.infer<typeof ImportAlbum>

export const ImportAlbumList = page(ImportAlbum)
export type ImportAlbumList = z.infer<typeof ImportAlbumList>
