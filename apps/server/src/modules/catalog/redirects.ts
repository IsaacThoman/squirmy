import { sql } from 'drizzle-orm'
import { db, type Executor } from '../../database/client.js'
import { uuidArray } from './sql.js'

/** Catalog tables whose rows can lose a merge and leave a `merged_into_id` redirect. */
export type MergeableTable = 'artists' | 'albums' | 'recordings'

/**
 * Follows `merged_into_id` redirects. Returns, for each given id that exists, the id of
 * the row it ends up at (itself when it was never merged). Unknown ids are left out.
 * Chains longer than 16 hops are treated as broken and dropped. Pass `executor` to read
 * inside a transaction.
 */
export async function resolveMerged(table: MergeableTable, ids: readonly string[], executor: Executor = db): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await executor.execute<{ origin: string; id: string }>(sql`
    with recursive chain(origin, id, next, depth) as (
      select t.id, t.id, t.merged_into_id, 0 from ${sql.identifier(table)} t where t.id = any(${uuidArray([...new Set(ids)])})
      union all
      select chain.origin, t.id, t.merged_into_id, chain.depth + 1
      from chain join ${sql.identifier(table)} t on t.id = chain.next
      where chain.depth < 16
    )
    select origin, id from chain where next is null`)
  return new Map(rows.map((row) => [row.origin, row.id]))
}

/** `resolveMerged` for one id; null when it does not exist. */
export async function resolveOne(table: MergeableTable, id: string): Promise<string | null> {
  return (await resolveMerged(table, [id])).get(id) ?? null
}
