import { queryKeys, type LikeEntityType } from '@squirmy/contracts'
import { notFound } from '../../lib/errors.js'
import { resolveOne, type MergeableTable } from '../catalog/redirects.js'
import type { LikeEntityType as StoredEntityType } from '../../database/schema.js'

/** API entity types (`track`) against the names the user tables store (`recording`). */
export const storedType = { track: 'recording', album: 'album', artist: 'artist' } as const satisfies Record<LikeEntityType, StoredEntityType>

/** The catalog table each API entity type lives in. */
export const entityTable: Record<LikeEntityType, MergeableTable> = { track: 'recordings', album: 'albums', artist: 'artists' }

/** Follows merge redirects for a client-supplied id; 404 with `<type>_not_found` when it does not exist. */
export async function resolveEntity(type: LikeEntityType, id: string): Promise<string> {
  const resolved = await resolveOne(entityTable[type], id)
  if (!resolved) throw notFound(`No such ${type}`, `${type}_not_found`)
  return resolved
}

/** The query key of the entity's own page. */
export function entityKey(type: LikeEntityType, id: string) {
  return type === 'track' ? queryKeys.track(id) : type === 'album' ? queryKeys.album(id) : queryKeys.artist(id)
}
