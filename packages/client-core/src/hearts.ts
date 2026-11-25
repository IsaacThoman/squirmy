import type { EntityFields, LikeEntityType } from '@squirmy/contracts'

/** Entities a heart puts in the library at once. An album page has no `inLibrary` of its own. */
const joinsLibrary = (type: LikeEntityType) => type === 'track' || type === 'artist'

/**
 * What a heart change shows at once, as the `patch` the server then sends. A saved track or
 * artist is in the library; after a removal only the server knows whether it still is (on the
 * collection, on a saved album), so `inLibrary` waits for its patch.
 */
export function heartFields(type: LikeEntityType, liked: boolean): EntityFields {
  return liked && joinsLibrary(type) ? { liked, inLibrary: true } : { liked }
}

/**
 * The `inLibrary` of the entity as the first answer in `answers` that carries it says, or
 * undefined. Read before `heartFields` is applied, it is what a refusal puts back.
 */
export function cachedInLibrary(answers: Iterable<unknown>, id: string): boolean | undefined {
  for (const data of answers) {
    const found = find(data, id)
    if (found !== undefined) return found
  }
  return undefined
}

function find(data: unknown, id: string): boolean | undefined {
  if (!data || typeof data !== 'object') return undefined
  if (Array.isArray(data)) {
    for (const item of data) {
      const found = find(item, id)
      if (found !== undefined) return found
    }
    return undefined
  }
  const record = data as Record<string, unknown>
  if (record.id === id && typeof record.inLibrary === 'boolean') return record.inLibrary
  for (const value of Object.values(record)) {
    const found = find(value, id)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * What undoes a heart change the server refused: the heart goes back, and so does the
 * `inLibrary` that `heartFields` set, to `inLibraryBefore` (from `cachedInLibrary`). Without
 * it (nothing cached carried the item) there is nothing to put back.
 */
export function heartRollback(type: LikeEntityType, liked: boolean, inLibraryBefore: boolean | undefined): EntityFields {
  const fields: EntityFields = { liked: !liked }
  if (liked && joinsLibrary(type) && inLibraryBefore !== undefined) fields.inLibrary = inLibraryBefore
  return fields
}
