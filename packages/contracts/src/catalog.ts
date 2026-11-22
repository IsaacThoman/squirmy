import { z } from 'zod'
import { Id, page, PageQuery } from './common.js'

/**
 * Whether a track can be played.
 * - `server`: a file is present on the server.
 * - `on_demand`: no file yet, but an acquisition provider can supply one. Playing it
 *   puts the queue entry in `preparing` until the file arrives.
 * - `none`: catalog only. Rendered gray.
 */
export const TrackAvailability = z.enum(['none', 'on_demand', 'server'])
export type TrackAvailability = z.infer<typeof TrackAvailability>

/**
 * `full` and `partial` count owned tracks against the album's track list: its canonical
 * release, plus owned tracks filed under the album that the release does not list.
 */
export const AlbumAvailability = z.enum(['none', 'on_demand', 'partial', 'full'])
export type AlbumAvailability = z.infer<typeof AlbumAvailability>

/** Pixel sizes served by `GET /api/v1/art/:id/:size`. Images are square WebP. */
export const ART_SIZES = [96, 300, 600, 1200] as const
export type ArtSize = (typeof ART_SIZES)[number]

export const Artwork = z.object({
  id: Id,
  /** Dominant color as #rrggbb, used for album backgrounds. */
  color: z.string().nullable(),
  /** Base64 ThumbHash placeholder. */
  thumbhash: z.string().nullable(),
})
export type Artwork = z.infer<typeof Artwork>

export const ArtistRef = z.object({ id: Id, name: z.string() })
export type ArtistRef = z.infer<typeof ArtistRef>

export const AlbumType = z.enum(['album', 'ep', 'single', 'compilation', 'live', 'soundtrack', 'other'])
export type AlbumType = z.infer<typeof AlbumType>

export const ArtistSummary = z.object({
  id: Id,
  mbid: z.string().nullable(),
  name: z.string(),
  image: Artwork.nullable(),
  /** True when at least one owned track credits this artist. */
  inLibrary: z.boolean(),
})
export type ArtistSummary = z.infer<typeof ArtistSummary>

export const AlbumRef = z.object({ id: Id, title: z.string(), artwork: Artwork.nullable() })
export type AlbumRef = z.infer<typeof AlbumRef>

export const AlbumSummary = z.object({
  id: Id,
  mbid: z.string().nullable(),
  title: z.string(),
  /** Display string, e.g. "Mira Vale & Lune Park". */
  artistCredit: z.string(),
  artists: z.array(ArtistRef),
  year: z.number().int().nullable(),
  type: AlbumType,
  artwork: Artwork.nullable(),
  availability: AlbumAvailability,
  trackCount: z.number().int(),
  ownedTrackCount: z.number().int(),
})
export type AlbumSummary = z.infer<typeof AlbumSummary>

/**
 * A track is a recording. `id` is the recording id; `album` is the album it is being
 * shown in, which decides the artwork and which file is preferred for playback.
 */
export const TrackSummary = z.object({
  id: Id,
  mbid: z.string().nullable(),
  title: z.string(),
  artistCredit: z.string(),
  artists: z.array(ArtistRef),
  /** 0 when unknown. */
  durationMs: z.number().int().nonnegative(),
  album: AlbumRef.nullable(),
  disc: z.number().int().nullable(),
  position: z.number().int().nullable(),
  availability: TrackAvailability,
  liked: z.boolean(),
  explicit: z.boolean().nullable(),
  hasLyrics: z.boolean(),
})
export type TrackSummary = z.infer<typeof TrackSummary>

export const AlbumDisc = z.object({
  disc: z.number().int(),
  title: z.string().nullable(),
  tracks: z.array(TrackSummary),
})
export type AlbumDisc = z.infer<typeof AlbumDisc>

export const AlbumDetail = AlbumSummary.extend({
  releaseDate: z.string().nullable(),
  genres: z.array(z.string()),
  description: z.string().nullable(),
  label: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  discs: z.array(AlbumDisc),
  liked: z.boolean(),
  wanted: z.boolean(),
  /**
   * True when the page was answered while its detail (track list, edition) was still
   * being fetched: what it shows is not final, and an invalidation of the album follows.
   * Absent otherwise.
   */
  detailPending: z.literal(true).optional(),
})
export type AlbumDetail = z.infer<typeof AlbumDetail>

export const ArtistDetail = ArtistSummary.extend({
  sortName: z.string().nullable(),
  disambiguation: z.string().nullable(),
  bio: z.string().nullable(),
  bioUrl: z.string().nullable(),
  genres: z.array(z.string()),
  liked: z.boolean(),
  topTracks: z.array(TrackSummary),
  /** Whole discography, newest first. Clients group by `type`. */
  albums: z.array(AlbumSummary),
  similar: z.array(ArtistSummary),
  /** As on `AlbumDetail`: the profile and discography are still being fetched. */
  detailPending: z.literal(true).optional(),
})
export type ArtistDetail = z.infer<typeof ArtistDetail>

export const Lyrics = z.object({
  trackId: Id,
  /** LRC text with [mm:ss.xx] timestamps, when synced lyrics exist. */
  synced: z.string().nullable(),
  plain: z.string().nullable(),
  instrumental: z.boolean(),
  source: z.string(),
})
export type Lyrics = z.infer<typeof Lyrics>

export const LibrarySort = z.enum(['recent', 'title', 'artist', 'year'])
export type LibrarySort = z.infer<typeof LibrarySort>

/** Query of `GET /library/albums`, `/library/artists` and `/library/tracks`. */
export const LibraryQuery = PageQuery.extend({
  sort: LibrarySort.default('recent'),
  /** Only items with this genre, matched case-insensitively. */
  genre: z.string().min(1).optional(),
})
export type LibraryQuery = z.infer<typeof LibraryQuery>

/** An item of `GET /library/genres`, sorted by name. */
export const GenreSummary = z.object({ name: z.string(), albumCount: z.number().int() })
export type GenreSummary = z.infer<typeof GenreSummary>

/** Query of `GET /tracks/:id`: the album the track is shown in (see `TrackSummary.album`). */
export const TrackQuery = z.object({ albumId: Id.optional() })
export type TrackQuery = z.infer<typeof TrackQuery>

/** `POST /api/v1/tracks/summaries` hydrates queue entries and playlists in one call. */
export const TrackSummariesRequest = z.object({
  tracks: z.array(z.object({ id: Id, albumId: Id.nullable().optional() })).max(500),
})
export type TrackSummariesRequest = z.infer<typeof TrackSummariesRequest>
export const TrackSummariesResponse = z.object({ tracks: z.array(TrackSummary) })
export type TrackSummariesResponse = z.infer<typeof TrackSummariesResponse>

/** Responses of the library lists and of `GET /me/likes/:type`. */
export const TrackPage = page(TrackSummary)
export type TrackPage = z.infer<typeof TrackPage>
export const AlbumPage = page(AlbumSummary)
export type AlbumPage = z.infer<typeof AlbumPage>
export const ArtistPage = page(ArtistSummary)
export type ArtistPage = z.infer<typeof ArtistPage>
export const GenrePage = page(GenreSummary)
export type GenrePage = z.infer<typeof GenrePage>
