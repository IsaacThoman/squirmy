import { z } from 'zod'
import { AlbumSummary, ArtistSummary, TrackSummary } from './catalog.js'

export const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(50).default(10),
})
export type SearchQuery = z.infer<typeof SearchQuery>

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
})
export type SearchResults = z.infer<typeof SearchResults>
