import { sql } from 'drizzle-orm'
import { db, type Executor } from '../../database/client.js'
import { uuidArray } from './sql.js'

/** Catalog tables whose rows can lose a merge and leave a `merged_into_id` redirect. */
export type MergeableTable = 'artists' | 'albums' | 'recordings'

/** Longest redirect chain followed; longer ones are treated as broken. */
const maxHops = 16

/**
 * Follows `merged_into_id` redirects. Returns, for each given id that exists, the id of
 * the row it ends up at (itself when it was never merged). Unknown ids are left out.
 * Chains longer than 16 hops are treated as broken and dropped. Pass `executor` to read
 * inside a transaction.
 *
 * One primary-key lookup per hop rather than a recursive CTE: Postgres cannot estimate
 * the recursive step and planned it as a hash join over the whole table, which cost tens
 * of milliseconds for a long list even when nothing was merged. Merged rows are rare, so
 * this is usually a single query.
 */
export async function resolveMerged(table: MergeableTable, ids: readonly string[], executor: Executor = db): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const lookup = (keys: string[]) => executor.execute<{ id: string; next: string | null }>(sql`
    select t.id, t.merged_into_id as next from ${sql.identifier(table)} t where t.id = any(${uuidArray(keys)})`)
  const result = new Map<string, string>()
  // Origins still being followed, by the id their chain has reached.
  let pending = new Map<string, string[]>()
  for (const row of await lookup([...new Set(ids)])) {
    if (row.next === null) result.set(row.id, row.id)
    else pending.set(row.next, [...(pending.get(row.next) ?? []), row.id])
  }
  for (let hop = 1; hop <= maxHops && pending.size > 0; hop++) {
    const reached = pending
    pending = new Map()
    for (const row of await lookup([...reached.keys()])) {
      const origins = reached.get(row.id)!
      if (row.next === null) for (const origin of origins) result.set(origin, row.id)
      else pending.set(row.next, [...(pending.get(row.next) ?? []), ...origins])
    }
  }
  return result
}

/** `resolveMerged` for one id; null when it does not exist. */
export async function resolveOne(table: MergeableTable, id: string): Promise<string | null> {
  return (await resolveMerged(table, [id])).get(id) ?? null
}
