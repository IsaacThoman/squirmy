import { z } from 'zod'
import { Id, IsoDateTime, page, PageQuery } from './common.js'

/** A MusicBrainz id. Lowercase or uppercase hex in the usual 8-4-4-4-12 groups. */
export const Mbid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i).transform((value) => value.toLowerCase())
export type Mbid = z.infer<typeof Mbid>

/**
 * Where a file stands in identification. `pending` waits for the matcher, `review` waits
 * for an admin, `unmatched` plays from its tags as a local-only track.
 */
export const MatchStatus = z.enum(['pending', 'matched', 'review', 'unmatched'])
export type MatchStatus = z.infer<typeof MatchStatus>

/**
 * How well a release fits a group of files, each part 0..1. Parts are null when the files
 * carry nothing to compare (no album tag, no year); the score leaves them out.
 */
export const MatchScoreBreakdown = z.object({
  /** Mean similarity of the matched file/track pairs (title and duration). */
  tracks: z.number(),
  /** Share of the files that found a track on the release, weighted by how well each fits. */
  files: z.number(),
  /** Share of the release's tracks the files cover, weighted the same way. Null for a loose track. */
  coverage: z.number().nullable(),
  /** Album title against the release and release-group titles. */
  title: z.number().nullable(),
  /** Album artist against the release's artist credit. */
  artist: z.number().nullable(),
  /** Tagged year against the release and first-release years. */
  year: z.number().nullable(),
})
export type MatchScoreBreakdown = z.infer<typeof MatchScoreBreakdown>

/** One track of a candidate release, with the file assigned to it (if any). */
export const MatchCandidateTrack = z.object({
  disc: z.number().int(),
  position: z.number().int(),
  title: z.string(),
  durationMs: z.number().int().nullable(),
  fileId: Id.nullable(),
  /** 0..1 similarity of the assigned file; null when no file is assigned. */
  similarity: z.number().nullable(),
})
export type MatchCandidateTrack = z.infer<typeof MatchCandidateTrack>

/** A MusicBrainz release scored against a group of files. */
export const MatchCandidate = z.object({
  releaseMbid: z.string(),
  releaseGroupMbid: z.string(),
  title: z.string(),
  artistCredit: z.string(),
  /** YYYY, YYYY-MM or YYYY-MM-DD. */
  date: z.string().nullable(),
  country: z.string().nullable(),
  status: z.string().nullable(),
  /** Medium formats, e.g. "CD" or "2×CD". */
  format: z.string().nullable(),
  label: z.string().nullable(),
  catalogNumber: z.string().nullable(),
  barcode: z.string().nullable(),
  disambiguation: z.string(),
  trackCount: z.number().int(),
  discCount: z.number().int(),
  /** 0..1; at or above the server's `matchAutoAcceptScore` it is applied without review. */
  score: z.number(),
  breakdown: MatchScoreBreakdown,
  tracks: z.array(MatchCandidateTrack),
  /** Files that fit no track (bonus tracks, extras). */
  extraFileIds: z.array(Id),
})
export type MatchCandidate = z.infer<typeof MatchCandidate>

/** What a group's files say about themselves. */
export const MatchGroupSummary = z.object({
  artist: z.string().nullable(),
  album: z.string().nullable(),
  year: z.number().int().nullable(),
  trackCount: z.number().int(),
  /** The files' common folder, relative to the root. */
  folder: z.string(),
})
export type MatchGroupSummary = z.infer<typeof MatchGroupSummary>

/** One file of a review, as its tags describe it. */
export const MatchFile = z.object({
  id: Id,
  relPath: z.string(),
  title: z.string().nullable(),
  artist: z.string().nullable(),
  disc: z.number().int().nullable(),
  track: z.number().int().nullable(),
  durationMs: z.number().int(),
  status: MatchStatus,
  locked: z.boolean(),
})
export type MatchFile = z.infer<typeof MatchFile>

export const MatchReviewStatus = z.enum(['open', 'resolved', 'dismissed'])
export type MatchReviewStatus = z.infer<typeof MatchReviewStatus>

/** An album group whose best candidate scored below the auto-accept threshold. */
export const MatchReview = z.object({
  id: Id,
  rootId: Id,
  groupKey: z.string(),
  status: MatchReviewStatus,
  summary: MatchGroupSummary,
  /** The best candidate's score, or null when there is none. */
  bestScore: z.number().nullable(),
  candidateCount: z.number().int(),
  /** The album the group's files are linked to now. */
  albumId: Id.nullable(),
  createdAt: IsoDateTime,
  resolvedAt: IsoDateTime.nullable(),
})
export type MatchReview = z.infer<typeof MatchReview>

/** A review with everything needed to compare the files with each candidate. */
export const MatchReviewDetail = MatchReview.extend({
  candidates: z.array(MatchCandidate),
  files: z.array(MatchFile),
})
export type MatchReviewDetail = z.infer<typeof MatchReviewDetail>

/** `GET /admin/reviews`: open reviews first, newest first within a status. */
export const MatchReviewQuery = PageQuery.extend({ status: MatchReviewStatus.optional() })
export type MatchReviewQuery = z.infer<typeof MatchReviewQuery>

export const MatchReviewList = page(MatchReview)
export type MatchReviewList = z.infer<typeof MatchReviewList>

/**
 * `POST /admin/reviews/:id/resolve`. A release applies it and locks the files; `keep_local`
 * leaves them local-only and locks them so they are not asked about again; `dismiss`
 * closes the review and marks the files unmatched.
 */
export const ResolveReviewRequest = z.union([
  z.object({ releaseMbid: Mbid }).strict(),
  z.object({ action: z.enum(['keep_local', 'dismiss']) }).strict(),
])
export type ResolveReviewRequest = z.infer<typeof ResolveReviewRequest>

/**
 * `GET /admin/albums/:id/candidates?query=`. Without a query the album is searched from
 * its files' tags. A query may be a release MBID or MusicBrainz release link, "Artist -
 * Album", or an album title by the album's own artist.
 */
export const MatchCandidatesQuery = z.object({ query: z.string().trim().min(1).max(200).optional() })
export type MatchCandidatesQuery = z.infer<typeof MatchCandidatesQuery>

export const MatchCandidateList = z.object({ items: z.array(MatchCandidate) })
export type MatchCandidateList = z.infer<typeof MatchCandidateList>

/**
 * `POST /admin/albums/:id/rematch`. A release applies it and locks the files; an empty
 * body forgets the current match and queues automatic matching again.
 */
export const RematchAlbumRequest = z.object({ releaseMbid: Mbid.optional() }).strict()
export type RematchAlbumRequest = z.infer<typeof RematchAlbumRequest>

/** What a review resolution, rematch or unmatch left behind. */
export const MatchActionResult = z.object({
  /** The album the files are linked to now. */
  albumId: Id.nullable(),
  status: MatchStatus,
  releaseMbid: z.string().nullable(),
  score: z.number().nullable(),
})
export type MatchActionResult = z.infer<typeof MatchActionResult>
