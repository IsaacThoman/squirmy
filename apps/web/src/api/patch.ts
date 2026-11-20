/**
 * A copy of `data` in which every object whose `id` is `id` has the fields of `patch` it
 * already carries set to their new values. Unchanged parts keep their identity, and the
 * same `data` comes back when nothing matched. Ids are UUIDs, unique across entity types,
 * so one call updates a like everywhere it shows: album pages, lists, playlists, search.
 */
export function patchEntity<T>(data: T, id: string, patch: Record<string, unknown>): T {
  if (Array.isArray(data)) {
    let changed = false
    const next = data.map(item => {
      const patched = patchEntity(item, id, patch)
      if (patched !== item) changed = true
      return patched
    })
    return (changed ? next : data) as T
  }
  if (!data || typeof data !== 'object') return data
  const record = data as Record<string, unknown>
  let next: Record<string, unknown> | null = null
  if (record.id === id) {
    for (const [key, value] of Object.entries(patch)) {
      if (key in record && record[key] !== value) (next ??= { ...record })[key] = value
    }
  }
  for (const [key, value] of Object.entries(record)) {
    if (!value || typeof value !== 'object') continue
    const patched = patchEntity(value, id, patch)
    if (patched !== value) (next ??= { ...record })[key] = patched
  }
  return (next ?? data) as T
}
