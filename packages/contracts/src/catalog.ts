import { z } from 'zod'
import { Id, page, PageQuery } from './common.js'

/**
 * Where a track's audio can come from, and so how a client presents it. A *requester* is
 * an admin or a member with `canAcquire`; `isPlayable` in client-core is the one rule.
 * - `server`: a file is present on the server. Playable for everyone.
 * - `on_demand`: no file yet, but an acquisition provider can supply one. For a requester
 *   it looks and plays exactly like `server` (the queue entry is `preparing` until the
 *   file arrives, shown as buffering); for anyone else it is unavailable.
 * - `none`: no file and no provider covers it. Unavailable for everyone.
 * Unavailable tracks are gray, do not start, and are labelled "Not available".
 */
export const TrackAvailability = z.enum(['none', 'on_demand', 'server'])
export type TrackAvailability = z.infer<typeof TrackAvailability>

/**
 * `full` and `partial` count owned tracks against the album's track list: its canonical
 * release, plus owned tracks filed under the album that the release does not list.
 * Presentation by viewer (`albumPresentation` and `albumNote` in client-core):
 * - `full`: normal for everyone.
 * - `partial`: normal for everyone; a non-requester's album page says "N of M songs
 *   available" and grays the rest.
 * - `on_demand`: normal for a requester, dimmed for anyone else.
 * - `none`: dimmed for everyone.
 * Requesters never see a count or badge: whether the server holds the files is not theirs
 * to manage. The counts stay for non-requesters and Subsonic.
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
  /**
   * True when the artist is credited on an album in the viewer's library (the server's
   * collection plus what the viewer added), not merely on any file the server holds:
   * fetched-for-play files must not make an artist part of the library.
   */
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
 * Why a track is in a user's library, the first that holds. `collection`: a file the server's
 * owner brought links it, shared by every user and not removable by them. `album`: it is on an
 * album the user added, and leaves with that album. `saved`: the user added the track itself.
 */
export const TrackLibrary = z.enum(['collection', 'album', 'saved'])
export type TrackLibrary = z.infer<typeof TrackLibrary>

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
  /**
   * True when the track is in the viewer's library: a collection file links it, the viewer
   * saved it, or the viewer saved the album a present file of it belongs to. Optional so
   * older servers, which do not send it, still parse.
   */
  inLibrary: z.boolean().optional(),
  /**
   * Why the track is in the viewer's library, or null when it is not (see `TrackLibrary`).
   * Only a `saved` track is one the viewer can remove. Optional for older servers.
   */
  library: TrackLibrary.nullable().optional(),
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
  /**
   * Why the album is in the viewer's library, or null when it is not. `collection`: a file
   * the server's owner brought (scan, upload, inbox) belongs to it, shared by every user and
   * not removable by them. `saved`: the viewer added it. Optional for older servers.
   */
  library: z.enum(['collection', 'saved']).nullable().optional(),
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
  /**
   * Whether `POST /radio/artist/:id` starts a radio for the viewer: something of the artist
   * plays for them (for a requester, fetched on demand included). Absent from servers that
   * predate it; clients then fall back to `inLibrary`, or offer it to requesters.
   */
  radio: z.boolean().optional(),
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
export const TrackSummariesResponse = z.object({
  tracks: z.array(TrackSummary),
  /**
   * For each item of `tracks`, the id the request named. It differs from the item's `id`
   * when that track was merged into another, so a client can file the answer under the id
   * it holds (a queue entry, a playlist item). Optional: older servers do not send it.
   */
  requestedIds: z.array(Id).optional(),
})
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
