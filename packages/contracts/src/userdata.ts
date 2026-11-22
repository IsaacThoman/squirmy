import { z } from 'zod'
import { AlbumSummary, ArtistSummary, Artwork, TrackSummary } from './catalog.js'
import { Id, IsoDateTime, page } from './common.js'

export const LikeEntityType = z.enum(['track', 'album', 'artist'])
export type LikeEntityType = z.infer<typeof LikeEntityType>

/**
 * `PUT/DELETE /me/library/:type/:id`, both answering `Ok` and idempotent. A user's library
 * is the server's collection plus what they saved here, so saving never needs a file and
 * removing deletes nothing but the save. Saving an unknown id is 404.
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
 * Most items one playlist holds. Adding past it fails with `playlist_full` (409), and the
 * playlist is left as it was.
 */
export const PLAYLIST_ITEM_LIMIT = 10_000
/** Most playlists one user owns. Creating another fails with `too_many_playlists` (409). */
export const PLAYLIST_LIMIT = 1000

export const CreatePlaylistRequest = z.object({
  name: z.string().trim().min(1).max(120),
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

/** One rail on the Home screen. */
export const HomeSection = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('albums'), id: z.string(), title: z.string(), albums: z.array(AlbumSummary) }),
  z.object({ kind: z.literal('artists'), id: z.string(), title: z.string(), artists: z.array(ArtistSummary) }),
  z.object({ kind: z.literal('tracks'), id: z.string(), title: z.string(), tracks: z.array(TrackSummary) }),
  z.object({ kind: z.literal('playlists'), id: z.string(), title: z.string(), playlists: z.array(PlaylistSummary) }),
])
export type HomeSection = z.infer<typeof HomeSection>
export const HomeResponse = z.object({ sections: z.array(HomeSection) })
export type HomeResponse = z.infer<typeof HomeResponse>

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
