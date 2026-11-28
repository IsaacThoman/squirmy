import { z } from 'zod'
import { AlbumAvailability, TrackAvailability, TrackLibrary } from './catalog.js'
import { Id } from './common.js'
import { queryKeys } from './session.js'

/**
 * What changed about catalog and user entities, sent on the socket as `changes`. It sits
 * beside `invalidate`, which names lists whose membership or order changed and so must be
 * fetched again. A change names entities instead, so a client updates only the cached
 * answers that hold them: it patches rows in place where the change carries the new values,
 * and refetches an entity's own queries where it does not. Nothing here asks a client to
 * run a search again, and a patch never moves a row, so lists on screen keep their order.
 *
 * Entity ids are UUIDs, unique across kinds, so a client may patch every cached object
 * whose `id` matches, wherever it is nested.
 */

/** The entities a change can name, with the query key root of their own pages. */
export const ChangedEntity = z.enum(['track', 'album', 'artist', 'playlist'])
export type ChangedEntity = z.infer<typeof ChangedEntity>

export const TrackAvailabilityChange = z.object({ id: Id, availability: TrackAvailability })
export type TrackAvailabilityChange = z.infer<typeof TrackAvailabilityChange>

export const AlbumAvailabilityChange = z.object({
  id: Id,
  availability: AlbumAvailability,
  trackCount: z.number().int(),
  ownedTrackCount: z.number().int(),
})
export type AlbumAvailabilityChange = z.infer<typeof AlbumAvailabilityChange>

/**
 * Fields that read the same wherever the entity shows, for the viewer the change is sent
 * to. A client sets each one only on cached objects that already carry it, so `library`
 * reaches a `TrackSummary` or an `AlbumDetail` and nothing else.
 */
export const EntityFields = z.object({
  liked: z.boolean(),
  wanted: z.boolean(),
  inLibrary: z.boolean(),
  /** A track's is a `TrackLibrary`; an album page's is `collection` or `saved`. */
  library: TrackLibrary.nullable(),
  /** A track's star rating from the viewer (`TrackSummary.rating`), null once removed. */
  rating: z.number().int().min(1).max(5).nullable(),
}).partial()
export type EntityFields = z.infer<typeof EntityFields>

export const EntityChange = z.discriminatedUnion('kind', [
  /**
   * Whether tracks and albums can be played changed: a file arrived or went, a provider
   * answered, missed or recovered. The same for every viewer, so it goes to everyone.
   * Clients set the values on every cached copy; rows turn gray or playable where they are.
   */
  z.object({
    kind: z.literal('availability'),
    tracks: z.array(TrackAvailabilityChange),
    albums: z.array(AlbumAvailabilityChange),
  }),
  /** Per-viewer fields of one entity changed (a like, a library save). Sent to that user only. */
  z.object({ kind: z.literal('patch'), entity: ChangedEntity, id: Id, fields: EntityFields }),
  /**
   * Something only the entities' own pages show changed (an album's track list after a
   * delivery is placed, a playlist's items, a new cover). Clients refetch the queries keyed
   * by them (`queryKeys.album(id)` and so on) and leave lists that merely mention them.
   */
  z.object({ kind: z.literal('updated'), entity: ChangedEntity, ids: z.array(Id) }),
  /** The entities are gone. A page that shows one says so rather than keep the old copy. */
  z.object({ kind: z.literal('deleted'), entity: ChangedEntity, ids: z.array(Id) }),
])
export type EntityChange = z.infer<typeof EntityChange>

export const EntityChanges = z.object({ changes: z.array(EntityChange) })
export type EntityChanges = z.infer<typeof EntityChanges>

/** The query key of an entity's own page, which an `updated` or `deleted` change refetches. */
export function changedEntityKey(entity: ChangedEntity, id: string): readonly unknown[] {
  if (entity === 'track') return queryKeys.track(id)
  if (entity === 'album') return queryKeys.album(id)
  if (entity === 'artist') return queryKeys.artist(id)
  return queryKeys.playlist(id)
}
