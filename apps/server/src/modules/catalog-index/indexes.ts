import postgres from 'postgres'
import { getConfig } from '../../config.js'
import { getSql } from '../../database/client.js'
import { librarySearchIndexNames, librarySearchIndexes, searchIndexValidity } from '../search/indexes.js'

export const catalogUpgradeLock = 'squirmy:catalog-index-upgrade'
const searchUpgradeLock = 'squirmy:search-index-upgrade'

const definitions = {
  unicode: 'using gin (search_unicode_bigrams(name_key)) where head',
  artist_title: 'using btree (kind, search_name_key(artist_name) collate "C", name_key collate "C") where artist_name is not null',
  album_title: 'using btree (kind, search_name_key(album_name) collate "C", name_key collate "C") where album_name is not null',
}
type CatalogSearchIndex = keyof typeof definitions
export const catalogSearchIndexes = Object.keys(definitions) as CatalogSearchIndex[]
const catalogIndexName = (index: CatalogSearchIndex) => `catalog_index_${index}`
const catalogIndexNames = catalogSearchIndexes.map(catalogIndexName)

/** The same definitions apply to a fresh import's staging table and an upgraded live table. */
export function createCatalogSearchIndex(table: 'catalog_index' | 'catalog_index_next', index: CatalogSearchIndex) {
  const concurrently = table === 'catalog_index' ? ' concurrently if not exists' : ''
  return `create index${concurrently} ${table}_${index} on ${table} ${definitions[index]}`
}

export async function validCatalogSearchIndexes(sql: postgres.ISql = getSql()) {
  const valid = await searchIndexValidity(catalogIndexNames, sql)
  return new Set(catalogSearchIndexes.filter((index) => valid.get(catalogIndexName(index))))
}

export async function catalogSearchUpgradeState(): Promise<'pending' | 'building' | 'ready'> {
  if ((await validCatalogSearchIndexes()).size === catalogSearchIndexes.length) return 'ready'
  const [row] = await getSql()<{ building: boolean }[]>`
    select exists (
      select from pg_stat_progress_create_index where relid = 'catalog_index'::regclass
    ) as building`
  return row?.building ? 'building' : 'pending'
}

async function canUpgradeCatalogSearchIndexes(sql: postgres.ISql) {
  const [row] = await sql<{ needed: boolean }[]>`
    select exists (select from catalog_index_imports where state = 'active')
       and not exists (select from catalog_index_imports where state in ('running', 'interrupted'))
       as needed`
  return Boolean(row?.needed)
}

export async function searchUpgradeNeeded() {
  const sql = getSql()
  const [row] = await sql<{ free: boolean }[]>`
    select pg_try_advisory_xact_lock(hashtext(${searchUpgradeLock})) as free`
  if (!row?.free) return false
  const valid = await searchIndexValidity([...librarySearchIndexNames, ...catalogIndexNames], sql)
  if (librarySearchIndexNames.some((name) => !valid.get(name))) return true
  return catalogIndexNames.some((name) => !valid.get(name)) && await canUpgradeCatalogSearchIndexes(sql)
}

/** One statement at a time, so a completed index is its own durable checkpoint. */
export async function upgradeSearchIndexes(signal: AbortSignal) {
  const sql = postgres(getConfig().DATABASE_URL, {
    max: 1, max_lifetime: null, prepare: false, onnotice: () => {},
    connection: { application_name: 'squirmy-catalog-index-upgrade' },
  })
  let query: postgres.PendingQuery<postgres.Row[]> | undefined
  const cancel = () => { void query?.cancel() }
  signal.addEventListener('abort', cancel)
  const run = async (statement: string) => {
    signal.throwIfAborted()
    query = sql.unsafe(statement)
    try {
      await query
    } finally {
      query = undefined
    }
  }
  const tryLock = async (key: string) => {
    const [row] = await sql<{ locked: boolean }[]>`select pg_try_advisory_lock(hashtext(${key})) as locked`
    return Boolean(row?.locked)
  }
  const rebuild = async (name: string, present: boolean, create: string) => {
    // IF NOT EXISTS alone would skip an invalid index left by an interrupted build.
    if (present) await run(`drop index concurrently if exists ${name}`)
    await run(create)
  }
  try {
    // Keep the lock on the session running DDL, including if this worker dies.
    if (!await tryLock(searchUpgradeLock) || signal.aborted) return
    const library = await searchIndexValidity(librarySearchIndexNames, sql)
    for (const name of librarySearchIndexNames) {
      if (!library.get(name)) await rebuild(name, library.has(name), `create index concurrently if not exists ${name} ${librarySearchIndexes[name]}`)
    }
    // Import swaps and admin removals use this lock too, so a retry cannot drop a
    // replacement's index. Avoid holding it while building the library's indexes.
    if (!await canUpgradeCatalogSearchIndexes(sql) || !await tryLock(catalogUpgradeLock) || signal.aborted) return
    const valid = await searchIndexValidity(catalogIndexNames, sql)
    for (const index of catalogSearchIndexes) {
      const name = catalogIndexName(index)
      if (valid.get(name)) continue
      if (!await canUpgradeCatalogSearchIndexes(sql)) break
      await rebuild(name, valid.has(name), createCatalogSearchIndex('catalog_index', index))
    }
  } finally {
    signal.removeEventListener('abort', cancel)
    await sql.end({ timeout: 5 })
  }
}
