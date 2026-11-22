/**
 * Keyset pagination. A list declares its ordering as sort keys; the cursor carries the
 * last row's key values, rendered by Postgres as text so timestamps keep their
 * microseconds. The last key must be unique (an id), which makes the order total and the
 * pages stable under ties and concurrent inserts.
 */
import type { Page } from '@squirmy/contracts'
import { sql, type SQL } from 'drizzle-orm'
import { z } from 'zod'
import { badRequest } from '../../lib/errors.js'

export type SortKey = {
  /** SQL expression over the query's aliases. */
  expression: SQL
  /** Postgres type the cursor value is cast back to. */
  type: 'text' | 'int' | 'uuid' | 'timestamptz'
  descending?: boolean
}

/** A named ordering. The name is stored in the cursor so it cannot be replayed against another list. */
export type Ordering = { name: string; keys: SortKey[] }

const CursorBody = z.object({ o: z.string(), k: z.array(z.string()) })

const valid: Record<SortKey['type'], (value: string) => boolean> = {
  text: () => true,
  int: (value) => /^-?\d{1,10}$/.test(value),
  uuid: (value) => z.uuid().safeParse(value).success,
  timestamptz: (value) => /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d{1,6})?([+-]\d{2}(:?\d{2})?|Z)?$/.test(value),
}

function invalidCursor() {
  return badRequest('The cursor is not valid for this list', 'invalid_cursor')
}

function decode(ordering: Ordering, cursor: string): string[] {
  let body: z.infer<typeof CursorBody>
  try {
    body = CursorBody.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
  } catch {
    throw invalidCursor()
  }
  if (body.o !== ordering.name || body.k.length !== ordering.keys.length) throw invalidCursor()
  if (!ordering.keys.every((key, index) => valid[key.type](body.k[index]!))) throw invalidCursor()
  return body.k
}

function encode(ordering: Ordering, values: string[]): string {
  return Buffer.from(JSON.stringify({ o: ordering.name, k: values })).toString('base64url')
}

/** `order by` list for the ordering. */
export function orderBy(ordering: Ordering): SQL {
  return sql.join(ordering.keys.map((key) => sql`${key.expression} ${sql.raw(key.descending ? 'desc' : 'asc')}`), sql`, `)
}

/** Select-list item `json_build_array(...) as "cursorKeys"` holding the row's key values. */
export function cursorKeys(ordering: Ordering): SQL {
  return sql`json_build_array(${sql.join(ordering.keys.map((key) => sql`(${key.expression})::text`), sql`, `)}) as "cursorKeys"`
}

/** Condition selecting the rows after the cursor; `true` without one. */
export function after(ordering: Ordering, cursor: string | undefined): SQL {
  if (!cursor) return sql`true`
  const values = decode(ordering, cursor)
  const keys = ordering.keys.map((key, index) => ({ ...key, value: sql`${values[index]}::${sql.raw(key.type)}` }))
  const direction = keys[0]!.descending ?? false
  if (keys.every((key) => (key.descending ?? false) === direction)) {
    // A row comparison lets Postgres start an index scan at the cursor.
    const left = sql.join(keys.map((key) => key.expression), sql`, `)
    const right = sql.join(keys.map((key) => key.value), sql`, `)
    return sql`(${left}) ${sql.raw(direction ? '<' : '>')} (${right})`
  }
  return keys.reduceRight<SQL | null>((rest, key) => {
    const beyond = sql`${key.expression} ${sql.raw(key.descending ? '<' : '>')} ${key.value}`
    return rest ? sql`(${beyond} or (${key.expression} = ${key.value} and ${rest}))` : beyond
  }, null)!
}

/**
 * Condition: the first key is at or beyond the cursor's (`true` without one). Redundant
 * with `after`, but where the keys come from two joined tables a row comparison cannot
 * start an index scan, and this can.
 */
export function leadingBound(ordering: Ordering, cursor: string | undefined): SQL {
  if (!cursor) return sql`true`
  const key = ordering.keys[0]!
  return sql`${key.expression} ${sql.raw(key.descending ? '<=' : '>=')} ${decode(ordering, cursor)[0]}::${sql.raw(key.type)}`
}

/**
 * Turns `limit + 1` fetched rows into a page: the extra row only signals that another
 * page exists, and the cursor points at the last row returned.
 */
export function toPage<Row extends { cursorKeys: string[] }, Item>(ordering: Ordering, rows: Row[], limit: number, items: Item[]): Page<Item> {
  const last = rows.length > limit ? rows[limit - 1] : undefined
  return { items: items.slice(0, limit), nextCursor: last ? encode(ordering, last.cursorKeys) : null }
}
