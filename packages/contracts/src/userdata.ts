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

/**
 * Most items one playlist holds. Adding past it fails with `playlist_full` (409), and the
 * playlist is left as it was. A smart playlist lists at most this many songs, too.
 */
export const PLAYLIST_ITEM_LIMIT = 10_000

/**
 * Smart playlists. A smart playlist has rules instead of items: the server finds its songs
 * each time it is read, so it follows the library as it changes. Its songs are those of
 * `source` with a file on the server (so every one plays) that pass `conditions`, sorted by
 * `sort` and cut to `limit`. Everything is evaluated for the playlist's owner (their library,
 * hearts, ratings and plays), whoever reads it.
 *
 * Conditions test a song and the album of a file of it: a song passes when one of its present
 * files, with that file's album, passes. Text matches ignore case, accents and punctuation the
 * way search does (`matchKey`). Groups nest one level.
 */
export const SmartMatch = z.enum(['all', 'any'])
export type SmartMatch = z.infer<typeof SmartMatch>

/**
 * `library`: the owner's library (what they hearted, and the server's collection when it counts
 * for them). `server`: the server's music, the collection, whatever the owner's library holds.
 */
export const SmartSource = z.enum(['library', 'server'])
export type SmartSource = z.infer<typeof SmartSource>

/** `codec` is the server's lowercase codec name (`flac`, `mp3`, `aac`, `alac`, `opus`…). */
export const SmartTextField = z.enum(['title', 'artist', 'albumArtist', 'album', 'genre', 'codec'])
export type SmartTextField = z.infer<typeof SmartTextField>
export const SmartTextOperator = z.enum(['is', 'isNot', 'contains', 'notContains'])
export type SmartTextOperator = z.infer<typeof SmartTextOperator>
export const SmartTextCondition = z.object({
  field: SmartTextField,
  op: SmartTextOperator,
  value: z.string().trim().min(1).max(200),
})
export type SmartTextCondition = z.infer<typeof SmartTextCondition>

/**
 * `year` is the album's. `playCount` counts the owner's completed plays; `rating` is the owner's
 * stars, 0 when unrated. `bitrateKbps` and `sampleRateHz` are the file's.
 * `between` takes both ends, `value` up to `to`.
 */
export const SmartNumberField = z.enum(['year', 'playCount', 'rating', 'durationMs', 'bitrateKbps', 'sampleRateHz'])
export type SmartNumberField = z.infer<typeof SmartNumberField>
export const SmartNumberOperator = z.enum(['eq', 'ne', 'gt', 'lt', 'between'])
export type SmartNumberOperator = z.infer<typeof SmartNumberOperator>
const ruleNumber = z.number().int().min(0).max(1_000_000_000)
export const SmartNumberCondition = z.object({
  field: SmartNumberField,
  op: SmartNumberOperator,
  value: ruleNumber,
  to: ruleNumber.optional(),
}).refine((condition) => condition.op !== 'between' || (condition.to !== undefined && condition.to >= condition.value), {
  message: 'Give both ends, the first no larger than the second',
  path: ['to'],
})
export type SmartNumberCondition = z.infer<typeof SmartNumberCondition>

/** The album's year falls in the decade starting at `value` (1990 is 1990 to 1999). */
export const SmartDecadeCondition = z.object({
  field: z.literal('decade'),
  op: z.enum(['is', 'isNot']),
  value: z.number().int().min(1000).max(2990).multipleOf(10),
})
export type SmartDecadeCondition = z.infer<typeof SmartDecadeCondition>

/** A calendar day, `YYYY-MM-DD`, in UTC. */
export const IsoDate = z.iso.date()

/**
 * `addedAt`: when the file arrived on the server. `lastPlayed`: the owner's last play, of any
 * length. `inLast` and `notInLast` count back `value` `unit`s from now (never played is not in
 * the last anything); `before` is earlier than the day `value`, `after` that day or later.
 */
export const SmartDateField = z.enum(['addedAt', 'lastPlayed'])
export type SmartDateField = z.infer<typeof SmartDateField>
export const SmartDateOperator = z.enum(['inLast', 'notInLast', 'before', 'after'])
export type SmartDateOperator = z.infer<typeof SmartDateOperator>
export const SmartDateUnit = z.enum(['days', 'weeks', 'months', 'years'])
export type SmartDateUnit = z.infer<typeof SmartDateUnit>
export const SmartDateCondition = z.object({
  field: SmartDateField,
  op: SmartDateOperator,
  value: z.union([z.number().int().min(1).max(36_500), IsoDate]),
  unit: SmartDateUnit.optional(),
}).refine((condition) => (condition.op === 'inLast' || condition.op === 'notInLast')
  ? typeof condition.value === 'number' && condition.unit !== undefined
  : typeof condition.value === 'string', { message: 'A count and a unit, or a date', path: ['value'] })
export type SmartDateCondition = z.infer<typeof SmartDateCondition>

/** `liked`: the owner hearted the song itself (it is in Liked Songs). `lossless`: the file's codec is. */
export const SmartBooleanCondition = z.object({ field: z.enum(['liked', 'lossless']), value: z.boolean() })
export type SmartBooleanCondition = z.infer<typeof SmartBooleanCondition>

export const SmartCondition = z.discriminatedUnion('field', [
  SmartTextCondition, SmartNumberCondition, SmartDecadeCondition, SmartDateCondition, SmartBooleanCondition,
])
export type SmartCondition = z.infer<typeof SmartCondition>
export type SmartField = SmartCondition['field']

/** Most conditions in one group, and in a whole rule set. */
export const SMART_CONDITION_LIMIT = 50

/** Conditions joined by `match`. Groups hold conditions only, so rules nest one level. */
export const SmartGroup = z.object({ match: SmartMatch, conditions: z.array(SmartCondition).min(1).max(SMART_CONDITION_LIMIT) })
export type SmartGroup = z.infer<typeof SmartGroup>

/**
 * How a smart playlist is ordered. `random` is shuffled once a day (UTC), the same for every
 * reader that day, so a limited random playlist is a fresh pick daily rather than on every read.
 */
export const SmartSort = z.enum(['random', 'mostPlayed', 'leastPlayed', 'recentlyAdded', 'recentlyPlayed', 'title', 'artist', 'year'])
export type SmartSort = z.infer<typeof SmartSort>

/** Shown in a group's place where a client expects one: `{ field } | { match }`. */
export const SmartRule = z.union([SmartCondition, SmartGroup])
export type SmartRule = z.infer<typeof SmartRule>

export const SmartPlaylistRules = z.object({
  source: SmartSource,
  match: SmartMatch,
  /** None: every song of the source. */
  conditions: z.array(SmartRule).max(SMART_CONDITION_LIMIT),
  sort: SmartSort,
  /** Most songs it lists; null for all of them (up to `PLAYLIST_ITEM_LIMIT`). */
  limit: z.number().int().min(1).max(PLAYLIST_ITEM_LIMIT).nullable(),
}).refine((rules) => rules.conditions.reduce((count, rule) => count + ('match' in rule ? rule.conditions.length : 1), 0) <= SMART_CONDITION_LIMIT, {
  message: `At most ${SMART_CONDITION_LIMIT} conditions`,
  path: ['conditions'],
})
export type SmartPlaylistRules = z.infer<typeof SmartPlaylistRules>

/** `POST /playlists/smart/preview`: how many songs these rules find for the user right now. */
export const SmartPlaylistPreview = z.object({ trackCount: z.number().int(), durationMs: z.number().int() })
export type SmartPlaylistPreview = z.infer<typeof SmartPlaylistPreview>

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
  /** A smart playlist: its songs come from its rules, and nobody adds, moves or removes them. Missing from older servers. */
  smart: z.boolean().optional(),
})
export type PlaylistSummary = z.infer<typeof PlaylistSummary>

/**
 * One song of a playlist. In a smart playlist `itemId` is the track's id and `addedAt` when its
 * file arrived on the server.
 */
export const PlaylistItem = z.object({ itemId: Id, addedAt: IsoDateTime, track: TrackSummary })
export type PlaylistItem = z.infer<typeof PlaylistItem>

export const PlaylistDetail = PlaylistSummary.extend({
  items: z.array(PlaylistItem),
  /** A smart playlist's rules; null for one with items. Missing from older servers. */
  rules: SmartPlaylistRules.nullable().optional(),
})
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

/** Most playlists one user owns. Creating another fails with `too_many_playlists` (409). */
export const PLAYLIST_LIMIT = 1000

/** Longest playlist name, counted after trimming. */
export const PLAYLIST_NAME_MAX_LENGTH = 120

/**
 * With `rules`, the playlist is smart. A playlist stays the kind it was made: updating the
 * `rules` of one with items is `not_smart_playlist` (409), and adding, moving or removing
 * items of a smart one is `smart_playlist` (409).
 */
export const CreatePlaylistRequest = z.object({
  name: z.string().trim().min(1).max(PLAYLIST_NAME_MAX_LENGTH),
  description: z.string().max(2000).nullable().optional(),
  isPublic: z.boolean().optional(),
  rules: SmartPlaylistRules.optional(),
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
