import { z } from 'zod'
import { AlbumSummary, ArtistSummary, TrackSummary } from './catalog.js'
import { Id } from './common.js'

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(10),
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
   * How exactly it matched: 3 the whole name, 2 the name without edition suffixes, 1 a
   * prefix. Lets a client pick between the library's and the catalog's top results, which
   * are ranked separately. Optional for older servers.
   */
  score: z.number().int().min(1).max(3).optional(),
})
export type SearchTopResult = z.infer<typeof SearchTopResult>

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
})
export type SearchResults = z.infer<typeof SearchResults>
