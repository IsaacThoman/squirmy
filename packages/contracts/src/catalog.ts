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
 * release, plus owned tracks of that edition that the release does not list.
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
   * True when the artist is in the viewer's library: the viewer saved (hearted) the artist,
   * or it is credited on an album in the viewer's library (the server's collection plus what
   * the viewer saved). Not merely on any file the server holds: fetched-for-play files must
   * not make an artist part of the library.
   */
  inLibrary: z.boolean(),
  /**
   * Whether the viewer saved (hearted) the artist, which their row's menu offers to change.
   * Search results carry it; other answers leave it out, as their pages read `ArtistDetail.liked`.
   */
  liked: z.boolean().optional(),
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
  /**
   * Whether the viewer saved (hearted) the album, which its row's menu offers to change.
   * Search results carry it; other answers leave it out, as their pages read `AlbumDetail.liked`.
   */
  liked: z.boolean().optional(),
})
export type AlbumSummary = z.infer<typeof AlbumSummary>

/**
 * Why a track is in a user's library, the first that holds. `collection`: a file the server's
 * owner brought links it, shared by every user. `album`: it is on an album the user saved, and
 * leaves with that album. `saved`: the user saved (hearted) the track itself, the same as `liked`.
 */
export const TrackLibrary = z.enum(['collection', 'album', 'saved'])
export type TrackLibrary = z.infer<typeof TrackLibrary>

export const CreditRole = z.enum([
  'composer', 'lyricist', 'conductor', 'arranger', 'producer', 'engineer', 'mixer', 'remixer', 'performer', 'ensemble',
])
export type CreditRole = z.infer<typeof CreditRole>

export const TrackCredit = z.object({ artist: ArtistRef, role: CreditRole, instrument: z.string().optional() })
export type TrackCredit = z.infer<typeof TrackCredit>

export const TrackWork = z.object({
  id: Id,
  mbid: z.string().nullable(),
  title: z.string(),
  movementName: z.string().optional(),
  movementNumber: z.number().int().positive().optional(),
  movementTotal: z.number().int().positive().optional(),
})
export type TrackWork = z.infer<typeof TrackWork>

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
  /**
   * The heart: the viewer saved this track to their library (`PUT /me/likes/track/:id`). It
   * is the only library control; Liked Songs lists these tracks.
   */
  liked: z.boolean(),
  explicit: z.boolean().nullable(),
  credits: z.array(TrackCredit).optional(),
  works: z.array(TrackWork).optional(),
  hasLyrics: z.boolean(),
  /**
   * True when the track is in the viewer's library: a collection file links it, the viewer
   * saved (hearted) it, or the viewer saved the album a present file of it belongs to.
   * Shows membership only; the heart is `liked`. Optional so older servers still parse.
   */
  inLibrary: z.boolean().optional(),
  /**
   * Why the track is in the viewer's library, or null when it is not (see `TrackLibrary`).
   * Deprecated: kept for app builds that predate the single heart, which show an Add/Remove
   * entry from it; current clients read `liked` and `inLibrary`. Optional for older servers.
   */
  library: TrackLibrary.nullable().optional(),
  /**
   * The viewer's star rating, 1 to 5, or null when they gave none (`PUT /me/ratings/track/:id`).
   * Clients show it only for a viewer with `showRatings` on. Optional so older servers still parse.
   */
  rating: z.number().int().min(1).max(5).nullable().optional(),
})
export type TrackSummary = z.infer<typeof TrackSummary>

export const AlbumDisc = z.object({
  disc: z.number().int(),
  title: z.string().nullable(),
  tracks: z.array(TrackSummary),
})
export type AlbumDisc = z.infer<typeof AlbumDisc>

/**
 * How good a held copy is, where music apps draw the line: `hi_res_lossless` is lossless
 * above 48 kHz or 16 bits, `lossless` any other lossless file, `lossy` the rest.
 */
export const AudioTier = z.enum(['hi_res_lossless', 'lossless', 'lossy'])
export type AudioTier = z.infer<typeof AudioTier>

/**
 * A version's id: an edition (release) and a tier, `<release id>:<tier>`. Opaque to
 * clients, which only send it back.
 */
export const VersionId = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(hi_res_lossless|lossless|lossy)$/)
export type VersionId = z.infer<typeof VersionId>

/** The files of a version: their tier, the most common codec, sample rate and bit depth, and the mean bitrate. */
export const VersionQuality = z.object({
  tier: AudioTier,
  /** In the vocabulary of `PlaybackSource.codec`: flac, alac, mp3, aac… */
  codec: z.string(),
  sampleRate: z.number().int().nullable(),
  bitDepth: z.number().int().nullable(),
  bitrate: z.number().int().nullable(),
})
export type VersionQuality = z.infer<typeof VersionQuality>

/** What tells one edition from another, as MusicBrainz describes the release. */
const editionFacts = {
  id: VersionId,
  title: z.string(),
  /** MusicBrainz's note that tells pressings apart ("2011 remaster"). */
  disambiguation: z.string().nullable(),
  releaseDate: z.string().nullable(),
  country: z.string().nullable(),
  label: z.string().nullable(),
  catalogNumber: z.string().nullable(),
  /** The release's media as MusicBrainz lists them: "CD", "2×12\" Vinyl", "Digital Media". */
  format: z.string().nullable(),
  /**
   * The files were matched to this edition. False for files on a track list built from tags
   * or a store: the release facts are then those of the release the album is shown as.
   */
  identified: z.boolean(),
  quality: VersionQuality,
}

/**
 * An edition of the album the server holds files of, in one quality tier: the 1973 LP rip,
 * the 2011 remaster in FLAC, the same remaster as MP3. See `AlbumDetail.ownedVersions`.
 */
export const AlbumVersion = z.object({
  ...editionFacts,
  /** Tracks on the edition. */
  trackCount: z.number().int().nonnegative(),
  /** Of those, the ones with a file in this version. */
  ownedTrackCount: z.number().int().nonnegative(),
})
export type AlbumVersion = z.infer<typeof AlbumVersion>

/** A version of one song: an edition of an album it is on, in one tier, with the quality of the best file. */
export const TrackVersion = z.object({
  ...editionFacts,
  albumId: Id,
  albumTitle: z.string(),
})
export type TrackVersion = z.infer<typeof TrackVersion>

/** `GET /tracks/:id/versions`: every version of the song the server holds, for Track info. */
export const TrackVersions = z.object({
  trackId: Id,
  /** The album asked about first, then the best tier first. */
  versions: z.array(TrackVersion),
  /** The user's pick for this song (`PUT /me/versions/track/:id`), or null for Automatic. */
  versionId: VersionId.nullable(),
  /** The user's pick for the album asked about (`albumId`), or null. */
  albumVersionId: VersionId.nullable(),
})
export type TrackVersions = z.infer<typeof TrackVersions>

export const TrackVersionsQuery = z.object({ albumId: Id.optional() })
export type TrackVersionsQuery = z.infer<typeof TrackVersionsQuery>

/** What a pick names: an album's default version, or one song's. */
export const VersionPickType = z.enum(['album', 'track'])
export type VersionPickType = z.infer<typeof VersionPickType>

/** `PUT /me/versions/:type/:id`. `DELETE` goes back to Automatic. */
export const VersionPickRequest = z.object({ versionId: VersionId })
export type VersionPickRequest = z.infer<typeof VersionPickRequest>

export const AlbumDetail = AlbumSummary.extend({
  releaseDate: z.string().nullable(),
  genres: z.array(z.string()),
  description: z.string().nullable(),
  label: z.string().nullable(),
  durationMs: z.number().int().nonnegative(),
  discs: z.array(AlbumDisc),
  /**
   * The heart: the viewer saved this album to their library (`PUT /me/likes/album/:id`),
   * which also asks the server to fetch what is missing when the viewer may fetch music.
   */
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
   * the server's owner brought (scan, upload, inbox) belongs to it, shared by every user.
   * `saved`: the viewer saved (hearted) it, the same as `liked`; a collection album the viewer
   * also hearted reads `collection`. Optional for older servers.
   */
  library: z.enum(['collection', 'saved']).nullable().optional(),
  /**
   * Other versions of this album: its other editions (a deluxe beside the standard
   * edition, the standard edition from a deluxe) and its lead artist's other rows of the
   * same release, at most 20, the standard edition first. The artist page lists each
   * release once, so these are not in its discography. Optional for older servers.
   */
  versions: z.array(AlbumSummary).optional(),
  /**
   * The editions of this album the server holds files of, one per quality tier (see
   * `AlbumVersion`), oldest edition first and best tier first within one. Clients show a
   * Versions control when there are two or more. Not to be confused with `versions`, which
   * are other album rows. Optional for older servers.
   */
  ownedVersions: z.array(AlbumVersion).optional(),
  /**
   * The version the viewer picked to play by default (`PUT /me/versions/album/:id`): the
   * track list is its edition's, and its files play. Null for Automatic: the album's own
   * edition is listed and each song plays from its best copy. Optional for older servers.
   */
  versionId: VersionId.nullable().optional(),
})
export type AlbumDetail = z.infer<typeof AlbumDetail>

/**
 * The sections of an artist page, in the order clients show them. `album` holds studio
 * albums, and soundtracks too for an artist whose albums are mostly not soundtracks (The
 * Beatles' Help!); `mixtape` holds mixtapes and street albums, which keep `type: 'album'`
 * so older clients still parse them; `appears_on` holds releases led by other artists that
 * credit this one, on the release or on one of its tracks.
 */
export const ARTIST_SECTION_KEYS = ['album', 'mixtape', 'ep', 'single', 'live', 'compilation', 'soundtrack', 'other', 'appears_on'] as const
export const ArtistSectionKey = z.enum(ARTIST_SECTION_KEYS)
export type ArtistSectionKey = z.infer<typeof ArtistSectionKey>

/** How many releases each section of `ArtistDetail` carries; `GET /artists/:id/releases` pages the rest. */
export const ARTIST_SECTION_PREVIEW = 12

/**
 * One section of an artist page: its first `ARTIST_SECTION_PREVIEW` releases, newest first,
 * and how many it has in all. When `total` is larger than `items`, clients offer "See all",
 * which pages `GET /artists/:id/releases?section=<key>`.
 */
export const ArtistSection = z.object({
  /**
   * One of `ARTIST_SECTION_KEYS`. A plain string, so a key a later server adds does not
   * fail an older client: it shows the section under `title`.
   */
  key: z.string(),
  /** An English heading ("Albums", "Appears on"), for a key the client does not know. */
  title: z.string(),
  total: z.number().int().nonnegative(),
  items: z.array(AlbumSummary),
})
export type ArtistSection = z.infer<typeof ArtistSection>

/** Query of `GET /artists/:id/releases`: one section of the artist page, paged. */
export const ArtistReleasesQuery = PageQuery.extend({ section: ArtistSectionKey })
export type ArtistReleasesQuery = z.infer<typeof ArtistReleasesQuery>

export const ArtistDetail = ArtistSummary.extend({
  sortName: z.string().nullable(),
  /** Tells same-name artists apart ("1960s British band"); clients show it beside the name. */
  disambiguation: z.string().nullable(),
  bio: z.string().nullable(),
  bioUrl: z.string().nullable(),
  genres: z.array(z.string()),
  /** The heart: the viewer saved (follows) this artist, which puts it in their library. */
  liked: z.boolean(),
  topTracks: z.array(TrackSummary),
  composedOrProduced: z.array(TrackSummary).optional(),
  /**
   * The artist's own releases (led by the artist), newest first, each release once: rows
   * of one release (editions, store copies) show as the one that stands for it. Only the
   * releases `sections` carries, so a large discography stays a small page: clients that
   * know `sections` use it instead. Older clients group this by `type`.
   */
  albums: z.array(AlbumSummary),
  /**
   * Releases led by other artists that credit this one, newest first ("Appears on"); like
   * `albums`, only the first page of that section. Absent from servers that predate it,
   * which listed them in `albums`.
   */
  appearsOn: z.array(AlbumSummary).optional(),
  /**
   * The page's release sections in display order, empty ones left out. Absent from
   * servers that predate it; clients then group `albums` by `type`.
   */
  sections: z.array(ArtistSection).optional(),
  /** How many releases the artist leads (every section but `appears_on`). Optional for older servers. */
  releaseCount: z.number().int().nonnegative().optional(),
  /**
   * How many of those have a file on the server, which is what plays for a viewer who
   * cannot fetch music ("12 of 40 releases available"). Optional for older servers.
   */
  ownedReleaseCount: z.number().int().nonnegative().optional(),
  similar: z.array(ArtistSummary),
  /**
   * Whether `POST /radio/artist/:id` starts a radio for the viewer: something of the artist
   * plays for them (for a requester, fetched on demand included). Absent from servers that
   * predate it; clients then fall back to `inLibrary`, or offer it to requesters.
   */
  radio: z.boolean().optional(),
  /**
   * As on `AlbumDetail`: the profile and discography are still being fetched. The page
   * shows what is known (a provider's discography first, then MusicBrainz's as it comes
   * in), and invalidations of the artist follow as it fills in.
   */
  detailPending: z.literal(true).optional(),
})
export type ArtistDetail = z.infer<typeof ArtistDetail>

/** A word of a synced line and when it is sung, in milliseconds into the song. */
export const LyricWord = z.object({
  startMs: z.number().int().nonnegative(),
  endMs: z.number().int().nonnegative(),
  /** The word as written, with the space after it: a line's words joined spell its text. */
  text: z.string(),
})
export type LyricWord = z.infer<typeof LyricWord>

export const LyricLine = z.object({
  startMs: z.number().int().nonnegative(),
  /** Empty for an instrumental gap. */
  text: z.string(),
  /** Each word's time, when the lyrics have them (Enhanced LRC or TTML word timing). */
  words: z.array(LyricWord).optional(),
  /** A translation or romanization the lyrics give for the line. */
  translation: z.string().optional(),
})
export type LyricLine = z.infer<typeof LyricLine>

export const Lyrics = z.object({
  trackId: Id,
  /**
   * LRC text with [mm:ss.xx] timestamps, when synced lyrics exist. Only line stamps: word
   * timing, where there is some, is in `lines`.
   */
  synced: z.string().nullable(),
  plain: z.string().nullable(),
  instrumental: z.boolean(),
  source: z.string(),
  /**
   * `synced` read into lines, with each word's time and a line's translation when the lyrics
   * have them. Optional: older servers send only `synced`, which clients then read themselves.
   */
  lines: z.array(LyricLine).optional(),
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

/**
 * Orders of `GET /library/items`, the Library's All: `played` (the default) puts what the
 * user last started playback from first (see `LibraryItem.playedAt`), then what they never
 * played, most recently added first; the rest are the album list's orders. Under `title`
 * an artist goes by its name and a playlist by its own; under `artist` (the creator) an
 * artist goes by its name ahead of its albums, a playlist by its owner, Liked Songs by the
 * user; under `year` only albums have one, so the rest follow the albums without a year.
 */
export const LibraryItemsSort = z.enum(['played', 'recent', 'title', 'artist', 'year'])
export type LibraryItemsSort = z.infer<typeof LibraryItemsSort>

/** Query of `GET /library/items`. A genre keeps the list to the albums that carry it. */
export const LibraryItemsQuery = PageQuery.extend({
  sort: LibraryItemsSort.default('played'),
  genre: z.string().min(1).optional(),
})
export type LibraryItemsQuery = z.infer<typeof LibraryItemsQuery>

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
