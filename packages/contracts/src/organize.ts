import { z } from 'zod'
import { Id, IsoDateTime, PageQuery, page } from './common.js'

/**
 * Organizing a managed library root: the server plans where every identified file
 * should live, shows the plan, applies it as one batch and can undo it.
 *
 * Undo moves files back. It does not restore tags: tags written by a batch stay
 * written after the batch is reverted.
 */

/** Tokens a path template may use. `{disc}` only has a value on multi-disc releases. */
export const ORGANIZE_TEMPLATE_TOKENS = ['albumartist', 'artist', 'album', 'year', 'disc', 'track', 'title', 'ext'] as const

/**
 * The template used when a root has none. Text in square brackets is dropped when a
 * token inside it has no value, so an album without a year has no "()" and a
 * single-disc album has no disc prefix.
 */
export const DEFAULT_ORGANIZE_TEMPLATE = '{albumartist}/{album}[ ({year})]/[[{disc}-]{track} ]{title}.{ext}'

export const OrganizeTemplateToken = z.object({
  token: z.enum(ORGANIZE_TEMPLATE_TOKENS),
  /** One line for a UI to show next to the token. */
  description: z.string(),
})
export type OrganizeTemplateToken = z.infer<typeof OrganizeTemplateToken>

/** `GET /admin/organize/template`: what a template editor needs, so no client hard-codes it. */
export const OrganizeTemplateInfo = z.object({
  /** Used by every root whose `template` is null. */
  defaultTemplate: z.string(),
  tokens: z.array(OrganizeTemplateToken),
})
export type OrganizeTemplateInfo = z.infer<typeof OrganizeTemplateInfo>

/** What the admin UI says about undo when a batch writes tags. */
export const ORGANIZE_TAGS_NOT_REVERTED =
  'Undo moves files back to where they were, but tags written by this batch stay as they are.'

export const OrganizePreviewRequest = z.object({
  rootId: Id,
  /** Only files on these albums. All albums in the root when omitted. */
  albumIds: z.array(Id).min(1).max(1000).optional(),
  /**
   * Also file music that is not confidently identified, named from its own tags.
   * Off by default: only matched or manually locked files move.
   */
  includeUnmatched: z.boolean().default(false),
  /** Write catalog tags into identified files while organizing. Not undone by revert. */
  writeTags: z.boolean().default(false),
  /**
   * Also file music waiting in the root's `_Incoming` folder, such as an import left for
   * review whose match an admin has since fixed. Off by default.
   */
  includeIncoming: z.boolean().default(false),
})
export type OrganizePreviewRequest = z.infer<typeof OrganizePreviewRequest>

/** `planned` → `applying` → `applied` (or `failed` when nothing could be applied) → `reverting` → `reverted`. */
export const OrganizeBatchStatus = z.enum(['planned', 'applying', 'applied', 'failed', 'reverting', 'reverted'])
export type OrganizeBatchStatus = z.infer<typeof OrganizeBatchStatus>

export const OrganizeMoveStatus = z.enum(['planned', 'applied', 'reverted', 'failed', 'skipped'])
export type OrganizeMoveStatus = z.infer<typeof OrganizeMoveStatus>

/** `audio`: a library file. `sidecar`: a cover, `.lrc`, `.ttml`, `.cue` or other file travelling with its album. */
export const OrganizeMoveKind = z.enum(['audio', 'sidecar'])
export type OrganizeMoveKind = z.infer<typeof OrganizeMoveKind>

export const OrganizeMove = z.object({
  id: Id,
  kind: OrganizeMoveKind,
  /** Paths relative to the root, with forward slashes. Equal when only tags are written. */
  from: z.string(),
  to: z.string(),
  status: OrganizeMoveStatus,
  /** Why it was skipped or failed, why its tags were not written, or why undo left it in place. */
  reason: z.string().nullable(),
})
export type OrganizeMove = z.infer<typeof OrganizeMove>

/** Moves of one album. `albumId` is null for files not linked to an album. */
export const OrganizeAlbumMoves = z.object({
  albumId: Id.nullable(),
  title: z.string(),
  artistCredit: z.string().nullable(),
  moves: z.array(OrganizeMove),
})
export type OrganizeAlbumMoves = z.infer<typeof OrganizeAlbumMoves>

export const OrganizeBatchCounts = z.object({
  /** Moves waiting to be applied. */
  planned: z.number().int(),
  applied: z.number().int(),
  failed: z.number().int(),
  /** Moves the planner or apply left alone, with a reason. */
  skipped: z.number().int(),
  reverted: z.number().int(),
  /** Applied moves that undo left in place, with a reason. */
  notReverted: z.number().int(),
  /** Sidecar moves among all of the above. */
  sidecars: z.number().int(),
  /** Files already where the template puts them. */
  unchanged: z.number().int(),
  /** Files left alone because their identification is not trusted. */
  untrusted: z.number().int(),
  tagsWritten: z.number().int(),
  tagsSkipped: z.number().int(),
})
export type OrganizeBatchCounts = z.infer<typeof OrganizeBatchCounts>

export const OrganizeBatchSummary = z.object({
  id: Id,
  rootId: Id,
  rootName: z.string(),
  status: OrganizeBatchStatus,
  includeUnmatched: z.boolean(),
  writeTags: z.boolean(),
  /** The template the batch was planned with. */
  template: z.string(),
  counts: OrganizeBatchCounts,
  createdAt: IsoDateTime,
  appliedAt: IsoDateTime.nullable(),
  revertedAt: IsoDateTime.nullable(),
})
export type OrganizeBatchSummary = z.infer<typeof OrganizeBatchSummary>

/** `POST /admin/organize/preview` and `GET /admin/organize/batches/:id`. */
export const OrganizeBatch = OrganizeBatchSummary.extend({
  albums: z.array(OrganizeAlbumMoves),
  /** Text for the UI about what undo does not restore; {@link ORGANIZE_TAGS_NOT_REVERTED} when the batch writes tags. */
  notice: z.string().nullable(),
})
export type OrganizeBatch = z.infer<typeof OrganizeBatch>

/** `GET /admin/organize/batches`, newest first. */
export const OrganizeBatchListQuery = PageQuery.extend({
  rootId: Id.optional(),
})
export type OrganizeBatchListQuery = z.infer<typeof OrganizeBatchListQuery>

export const OrganizeBatchList = page(OrganizeBatchSummary)
export type OrganizeBatchList = z.infer<typeof OrganizeBatchList>

/**
 * `POST /admin/organize/batches/:id/apply` and `/revert` start a job and answer at once
 * with the batch as it is then; follow progress with `GET /admin/organize/batches/:id`.
 */
export const OrganizeBatchAccepted = OrganizeBatchSummary
export type OrganizeBatchAccepted = z.infer<typeof OrganizeBatchAccepted>
