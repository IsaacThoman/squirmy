import type { CatalogIndexImport, CatalogIndexStatus } from '@squirmy/contracts'
import { desc, eq } from 'drizzle-orm'
import { db, getSql } from '../../database/client.js'
import { catalogIndexImports } from '../../database/schema.js'
import { conflict } from '../../lib/errors.js'
import { catalogSearchUpgradeState, catalogUpgradeLock } from './indexes.js'

function toImport(row: typeof catalogIndexImports.$inferSelect): CatalogIndexImport {
  return {
    id: row.id,
    state: row.state,
    phase: row.phase,
    source: row.source,
    dumpDate: row.dumpDate?.toISOString() ?? null,
    recordingsPerArtist: row.recordingsPerArtist,
    bytesRead: row.bytesRead,
    totalBytes: row.totalBytes,
    rowsRead: row.rowsRead,
    error: row.error,
    resumes: row.resumes,
    resumedAt: row.resumedAt?.toISOString() ?? null,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt?.toISOString() ?? null,
  }
}

/** What the admin screen shows: the index in use, its size, and the newest import if it is another one. */
export async function getCatalogIndexStatus(): Promise<CatalogIndexStatus> {
  const [active] = await db.select().from(catalogIndexImports).where(eq(catalogIndexImports.state, 'active'))
  const [latest] = await db.select().from(catalogIndexImports).orderBy(desc(catalogIndexImports.startedAt)).limit(1)
  const [size] = await getSql()<{ bytes: string }[]>`select pg_total_relation_size('catalog_index') as bytes`
  return {
    ready: Boolean(active),
    dumpDate: active?.dumpDate?.toISOString() ?? null,
    importedAt: active?.finishedAt?.toISOString() ?? null,
    counts: { artists: active?.artists ?? 0, albums: active?.albums ?? 0, recordings: active?.recordings ?? 0 },
    sizeBytes: Number(size?.bytes ?? 0),
    searchUpgrade: active ? await catalogSearchUpgradeState() : null,
    active: active ? toImport(active) : null,
    latest: latest && latest.id !== active?.id ? toImport(latest) : null,
  }
}

/** Empties the index and marks it dropped. Search reports not ready until the next import. */
export async function dropCatalogIndex() {
  await getSql().begin(async (sql) => {
    // An exclusive table lock waiting behind a concurrent build would block new search reads.
    const [row] = await sql<{ locked: boolean }[]>`
      select pg_try_advisory_xact_lock(hashtext(${catalogUpgradeLock})) as locked`
    if (!row?.locked) throw conflict('Search index maintenance is running. Try removing the index again after the current build.', 'catalog_index_maintenance_running')
    await sql`truncate catalog_index`
    await sql`update catalog_index_imports set state = 'dropped' where state = 'active'`
  })
}
