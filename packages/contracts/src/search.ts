import { z } from 'zod'
import { AlbumSummary, ArtistSummary, TrackSummary } from './catalog.js'
import { Id } from './common.js'

/** The kinds of result a search lists. */
export const SearchKind = z.enum(['artist', 'album', 'track'])
export type SearchKind = z.infer<typeof SearchKind>

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(10),
  /** Only this kind; the other lists come back empty. For a client's filter, which pages one kind. */
  type: SearchKind.optional(),
  /** Skips this many results of each kind: the next page of a `type` search. */
  offset: z.coerce.number().int().min(0).max(450).default(0),
})
export type SearchQuery = z.infer<typeof SearchQuery>

/**
 * The single result a client can lead with, one of the items in `artists`, `albums` or
 * `tracks`. Chosen by how exactly its name matches the query (the whole name, or artist
 * and title together, also with edition suffixes such as "(Deluxe Edition)" or a leading
 * article dropped; then the name starting with the query; then a name one typo away),
 * ties broken by the article as typed, popularity, the order of the lists, then artist
 * before album before track.
 */
export const SearchTopResult = z.object({
  type: z.enum(['artist', 'album', 'track']),
  id: Id,
  /**
   * How exactly it matched: 3 the whole name as typed (edition suffixes ignored), 2 the
   * whole name only once a leading article is ignored, 1 a prefix or one typo. A higher
   * score is a match the ranking above puts first. Lets a client pick between the
   * library's and the catalog's top results, which are ranked separately. Optional for
   * older servers.
   */
  score: z.number().int().min(1).max(3).optional(),
})
export type SearchTopResult = z.infer<typeof SearchTopResult>

/**
 * One result's place in the single list a client shows, all kinds mixed. `score` is 0..1:
 * how well the name matches the query (the whole name, its start, a word of it, its
 * artist), scaled by how prominent the item is (the provider's fans and play counts, the
 * viewer's library, plays and likes), so a famous artist whose name starts with the query
 * leads an obscure one named exactly that. Scores of the library's and the catalog's
 * answers to the same query are on one scale and may be compared.
 */
export const SearchRanked = z.object({
  type: SearchKind,
  id: Id,
  score: z.number().min(0).max(1),
})
export type SearchRanked = z.infer<typeof SearchRanked>

/**
 * Shape of both `GET /search/library` and `GET /search/catalog`.
 * Catalog results are stored as stub catalog rows before they are returned, so every
 * item has a normal id and opens through the normal artist/album/track routes.
 */
export const SearchResults = z.object({
  artists: z.array(ArtistSummary),
  albums: z.array(AlbumSummary),
  tracks: z.array(TrackSummary),
  /** Which provider answered a catalog search: deezer, musicbrainz, local-index. */
  provider: z.string().nullable(),
  /**
   * The best match across kinds, or null when no name matches the query at least as a
   * prefix. Optional so clients and servers without it keep working; ignoring it is fine.
   */
  top: SearchTopResult.nullable().optional(),
  /**
   * Every item of the lists, best first across kinds. The catalog's answer also scores the
   * library answer's items for the same query, offset and limit (the provider may know how
   * popular they are), so it can name ids that are only in that answer; a client takes the
   * higher score of an item named twice and skips ids it has no item for. Optional: older
   * servers leave it out.
   */
  ranked: z.array(SearchRanked).optional(),
})
export type SearchResults = z.infer<typeof SearchResults>
