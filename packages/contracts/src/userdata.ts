import { z } from 'zod'
import { AlbumSummary, ArtistSummary, Artwork, TrackSummary } from './catalog.js'
import { Id, IsoDateTime, page } from './common.js'

/**
 * `PUT/DELETE /me/likes/:type/:id`, both idempotent: the heart, the one way to save something
 * to a library. A user's library is the server's collection plus what they saved, so saving
 * never needs a file and removing deletes nothing but the save. Saving an album or track also
 * asks for its missing files when the user may fetch music. Saving an unknown id is 404.
 * `PUT` answers `Ok`, `DELETE` an `UnlikeResponse`. `GET /me/likes/:type` lists the saves,
 * newest first (Liked Songs).
 */
export const LikeEntityType = z.enum(['track', 'album', 'artist'])
export type LikeEntityType = z.infer<typeof LikeEntityType>

/**
 * Query of `PUT /me/likes/:type/:id`. `savedAt`: when the save was made, for Undo of a removal,
 * which passes back the `savedAt` the removal answered so the item returns to its place in
 * Recently added and Liked Songs instead of the top. A time in the future is taken as now.
 */
export const LikeQuery = z.object({ savedAt: IsoDateTime.optional() })
export type LikeQuery = z.infer<typeof LikeQuery>

/** Answer of `DELETE /me/likes/:type/:id`: when the removed save was made, null when there was none. */
export const UnlikeResponse = z.object({ ok: z.literal(true), savedAt: IsoDateTime.nullable() })
export type UnlikeResponse = z.infer<typeof UnlikeResponse>

/**
 * `PUT/DELETE /me/library/:type/:id`: deprecated aliases of `PUT/DELETE /me/likes/:type/:id`,
 * kept for app builds from before the single heart. They write the same save.
 */
export const LibraryEntityType = z.enum(['album', 'track'])
export type LibraryEntityType = z.infer<typeof LibraryEntityType>

export const PlaylistSummary = z.object({
  id: Id,
  name: z.string(),
  description: z.string().nullable(),
  ownerId: Id,
  ownerName: z.string(),
  isPublic: z.boolean(),
  trackCount: z.number().int(),
  durationMs: z.number().int(),
  /** Up to four covers from the playlist's first tracks, for a mosaic. */
  artworks: z.array(Artwork),
  updatedAt: IsoDateTime,
})
export type PlaylistSummary = z.infer<typeof PlaylistSummary>

export const PlaylistItem = z.object({ itemId: Id, addedAt: IsoDateTime, track: TrackSummary })
export type PlaylistItem = z.infer<typeof PlaylistItem>

export const PlaylistDetail = PlaylistSummary.extend({ items: z.array(PlaylistItem) })
export type PlaylistDetail = z.infer<typeof PlaylistDetail>

/** `GET /api/v1/playlists`: your playlists and other users' public ones, recently updated first. */
export const PlaylistPage = page(PlaylistSummary)
export type PlaylistPage = z.infer<typeof PlaylistPage>

/**
 * One item of the Library's All (`GET /library/items`, sorted by `LibraryItemsSort`): an
 * album or artist in the user's library, a playlist they can see, or Liked Songs, which is
 * always there. Defined here rather than in catalog.ts because it holds a `PlaylistSummary`.
 *
 * `playedAt` is when the user last started playback from it: Play, Shuffle or a song of its
 * page (or a card's Play), on any device. Songs started from Search, Home, a radio or the
 * queue, and playback that carries on by itself, do not count. Null when never.
 */
const playedAt = IsoDateTime.nullable()
/** The user pinned it (`PUT /me/pins/:kind/:id`): it heads the list. Missing from servers before pins. */
const pinned = z.boolean().optional()
export const LibraryItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('album'), album: AlbumSummary, playedAt, pinned }),
  z.object({ kind: z.literal('artist'), artist: ArtistSummary, playedAt, pinned }),
  z.object({ kind: z.literal('playlist'), playlist: PlaylistSummary, playedAt, pinned }),
  z.object({ kind: z.literal('liked'), playedAt, pinned }),
])
export type LibraryItem = z.infer<typeof LibraryItem>

/** Liked Songs has no row of its own; this id stands for it where an id is needed, as in `PUT /me/pins/liked/:id`. */
export const LIKED_SONGS_ID = '00000000-0000-0000-0000-000000000000'

/**
 * `PUT/DELETE /me/pins/:kind/:id`, both idempotent and answering `Ok`: pins an item of the
 * Library's All to its top, or unpins it. The first page of `GET /library/items` (no cursor)
 * starts with the pinned items, most recently pinned first, whatever the sort, and the rest of
 * the list leaves them out; so that page holds up to `limit` items beyond the pins. A pin shows
 * while its item is in the library (a playlist while the user may see it), and under a genre
 * only pinned albums of that genre show. Album and artist ids follow merges; an unknown id is
 * 404. Liked Songs is pinned with `LIKED_SONGS_ID`. More than `LIBRARY_PIN_LIMIT` pins is
 * `too_many_pins` (409); pins whose item left the library do not count.
 */
export const LibraryPinKind = z.enum(['album', 'artist', 'playlist', 'liked'])
export type LibraryPinKind = z.infer<typeof LibraryPinKind>

/** Most items one user pins. */
export const LIBRARY_PIN_LIMIT = 50

export const LibraryItemPage = page(LibraryItem)
export type LibraryItemPage = z.infer<typeof LibraryItemPage>

/**
 * Most items one playlist holds. Adding past it fails with `playlist_full` (409), and the
 * playlist is left as it was.
 */
export const PLAYLIST_ITEM_LIMIT = 10_000
/** Most playlists one user owns. Creating another fails with `too_many_playlists` (409). */
export const PLAYLIST_LIMIT = 1000

/** Longest playlist name, counted after trimming. */
export const PLAYLIST_NAME_MAX_LENGTH = 120

export const CreatePlaylistRequest = z.object({
  name: z.string().trim().min(1).max(PLAYLIST_NAME_MAX_LENGTH),
  description: z.string().max(2000).nullable().optional(),
  isPublic: z.boolean().optional(),
})
export type CreatePlaylistRequest = z.infer<typeof CreatePlaylistRequest>
export const UpdatePlaylistRequest = CreatePlaylistRequest.partial()
export type UpdatePlaylistRequest = z.infer<typeof UpdatePlaylistRequest>

/**
 * Appends tracks in order. `albumId` defaults to the album the track would be shown in.
 * With `skipDuplicates`, tracks already in the playlist (or repeated in the request) are left out.
 */
export const AddPlaylistItemsRequest = z.object({
  tracks: z.array(z.object({ trackId: Id, albumId: Id.nullable().optional() })).min(1).max(1000),
  skipDuplicates: z.boolean().optional(),
})
export type AddPlaylistItemsRequest = z.infer<typeof AddPlaylistItemsRequest>

export const MovePlaylistItemRequest = z.object({ itemId: Id, toIndex: z.number().int().min(0) })
export type MovePlaylistItemRequest = z.infer<typeof MovePlaylistItemRequest>

/** One play, newest first. Back-to-back plays of the same track are collapsed into the latest. */
export const HistoryItem = z.object({ playedAt: IsoDateTime, track: TrackSummary })
export type HistoryItem = z.infer<typeof HistoryItem>
export const HistoryPage = page(HistoryItem)
export type HistoryPage = z.infer<typeof HistoryPage>

/**
 * A mix made for the user (Home's Made for you): a few artists they play who belong together,
 * by the artists' genres, similar-artist data and what the user plays side by side, with
 * songs they love and songs like them. Made once a day, so a mix stays the same all day; its
 * id stays the same from day to day (it is a slot, "Mix 1"), while its songs change.
 */
export const MixSummary = z.object({
  id: Id,
  /** "Mix 1 · Indie, Folk": the slot and the mix's leading genres, or its first artists without genres. */
  name: z.string(),
  /** Its leading artists: "Mira Vale, Low Tide and more". */
  description: z.string(),
  /** Up to four covers of different albums, for a mosaic. */
  artworks: z.array(Artwork),
  trackCount: z.number().int(),
  durationMs: z.number().int(),
  /** When its songs were picked. */
  generatedAt: IsoDateTime,
})
export type MixSummary = z.infer<typeof MixSummary>

/**
 * `GET /mixes/:id`: the mix with its songs in play order, only those the user can play now.
 * Play it with `playTracks` and the context `{ type: 'mix', id, title: name }`. Another
 * user's mix, or one gone since, is 404.
 */
export const MixDetail = MixSummary.extend({ tracks: z.array(TrackSummary) })
export type MixDetail = z.infer<typeof MixDetail>

/**
 * A radio the user played, for Jump back in: started from a track or an artist (the radio's
 * context id is `track:<id>` or `artist:<id>`). Started again with `POST /radio/track/:id`
 * or `/radio/artist/:id`. `title` is the track's or artist's name, `subtitle` the track's
 * artist; `albumId` the track's album, the page a track radio's card opens.
 */
export const RadioSummary = z.object({
  seed: z.enum(['track', 'artist']),
  id: Id,
  title: z.string(),
  subtitle: z.string().nullable(),
  albumId: Id.nullable(),
  artwork: Artwork.nullable(),
})
export type RadioSummary = z.infer<typeof RadioSummary>

/** One card of a Home rail that holds several kinds of things (Jump back in, Made for you). */
export const HomeItem = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('album'), album: AlbumSummary }),
  z.object({ kind: z.literal('artist'), artist: ArtistSummary }),
  z.object({ kind: z.literal('playlist'), playlist: PlaylistSummary }),
  z.object({ kind: z.literal('liked') }),
  z.object({ kind: z.literal('mix'), mix: MixSummary }),
  z.object({ kind: z.literal('radio'), radio: RadioSummary }),
])
export type HomeItem = z.infer<typeof HomeItem>

/**
 * One rail on the Home screen. Every kind is a titled row of one sort of card, so each app
 * draws a section by its kind alone; the id only says which rail it is (for a See all, and
 * for tests). Apps skip a kind they do not know, which is how older apps take a newer server.
 */
export const HomeSection = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('albums'), id: z.string(), title: z.string(), albums: z.array(AlbumSummary) }),
  z.object({ kind: z.literal('artists'), id: z.string(), title: z.string(), artists: z.array(ArtistSummary) }),
  z.object({ kind: z.literal('tracks'), id: z.string(), title: z.string(), tracks: z.array(TrackSummary) }),
  z.object({ kind: z.literal('playlists'), id: z.string(), title: z.string(), playlists: z.array(PlaylistSummary) }),
  z.object({ kind: z.literal('items'), id: z.string(), title: z.string(), items: z.array(HomeItem) }),
])
export type HomeSection = z.infer<typeof HomeSection>
export const HomeResponse = z.object({ sections: z.array(HomeSection) })
export type HomeResponse = z.infer<typeof HomeResponse>

/**
 * Query of `GET /home`.
 *
 * - `layout`: `personal` is the Home of this release (Jump back in, Made for you, Because you
 *   listened to, Your top artists, Rediscover…). Without it the server answers the rails of
 *   earlier releases (Recently played first), which app builds from before it know how to draw.
 * - `tz`: the device's IANA time zone ("Europe/Berlin"). With it, the personal Home puts first
 *   the rails that hold what the user plays at this time of day. An unknown zone is ignored.
 */
export const HomeQuery = z.object({
  layout: z.enum(['personal']).optional(),
  tz: z.string().max(64).optional(),
})
export type HomeQuery = z.infer<typeof HomeQuery>

/** `PUT/DELETE /me/wants/:type/:id`. */
export const WantEntityType = z.enum(['album', 'track'])
export type WantEntityType = z.infer<typeof WantEntityType>

/** An item of `GET /me/wants`, newest first. `fulfilledAt` is set once an import completed it. */
export const WantItem = z.discriminatedUnion('type', [
  z.object({ type: z.literal('album'), wantedAt: IsoDateTime, fulfilledAt: IsoDateTime.nullable(), album: AlbumSummary }),
  z.object({ type: z.literal('track'), wantedAt: IsoDateTime, fulfilledAt: IsoDateTime.nullable(), track: TrackSummary }),
])
export type WantItem = z.infer<typeof WantItem>
export const WantPage = page(WantItem)
export type WantPage = z.infer<typeof WantPage>
