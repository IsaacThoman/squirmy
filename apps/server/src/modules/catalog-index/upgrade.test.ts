import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { drizzle } from 'drizzle-orm/postgres-js'
import { migrate } from 'drizzle-orm/postgres-js/migrator'
import { expect, it } from 'vitest'
import { getConfig } from '../../config.js'
import { db, getSql } from '../../database/client.js'
import { runMigrations } from '../../database/migrate.js'
import { lyrics } from '../../database/schema.js'
import { drainJobs, jobs, startJobs } from '../../jobs/index.js'
import { useTestDatabase } from '../../test/database.js'
import { buildDump, testCatalog } from '../../test/catalog-index-dump.js'
import { createAlbum, createUser } from '../../test/factories.js'
import { librarySearchIndexNames, searchIndexValidity } from '../search/indexes.js'
import { searchLibrary } from '../search/library.js'
import { searchLyrics } from '../search/scopes.js'
import { importCanonicalDump } from './import.js'
import { catalogIndexModule } from './index.js'
import { isCatalogIndexReady, searchCatalogIndex } from './search.js'
import { dropCatalogIndex, getCatalogIndexStatus } from './status.js'

useTestDatabase()

async function migrateBeforeUniversalSearch() {
  const source = new URL('../../../drizzle/', import.meta.url)
  const folder = path.join(getConfig().SQUIRMY_DATA_DIR, 'legacy-migrations')
  const journal = JSON.parse(await readFile(new URL('meta/_journal.json', source), 'utf8')) as { entries: { tag: string }[] }
  const upgrade = journal.entries.findIndex(({ tag }) => tag.endsWith('_universal_search'))
  expect(upgrade).toBeGreaterThan(0)
  journal.entries = journal.entries.slice(0, upgrade)
  await mkdir(path.join(folder, 'meta'), { recursive: true })
  await writeFile(path.join(folder, 'meta/_journal.json'), JSON.stringify(journal))
  await Promise.all(journal.entries.map(({ tag }) => copyFile(new URL(`${tag}.sql`, source), path.join(folder, `${tag}.sql`))))

  // Rebuild only this test's database at the schema an upgrade actually starts from.
  const sql = getSql()
  await sql`drop schema drizzle, public cascade`
  await sql`create schema public`
  await migrate(drizzle(sql), { migrationsFolder: folder })
}

const definitions = (names: readonly string[]) => getSql()<{ definition: string }[]>`
  select indexdef as definition from pg_indexes
  where schemaname = 'public' and indexname = any(${names}::name[]) order by indexname`

const catalogDefinitions = () => getSql()<{ definition: string }[]>`
  select indexdef as definition from pg_indexes
  where schemaname = 'public' and tablename = 'catalog_index' order by indexname`

it('keeps search available across an upgrade and repairs a cancelled concurrent build', async () => {
  const freshLibrary = await definitions(librarySearchIndexNames)
  expect(freshLibrary).toHaveLength(4)
  expect(await catalogDefinitions()).toHaveLength(4)
  await migrateBeforeUniversalSearch()
  const user = await createUser()
  const album = await createAlbum({ owned: true, tracks: [{ title: '宇多田ヒカル' }, { title: 'Lantern Song' }] })
  const recording = album.tracks[0]!
  await db.insert(lyrics).values({ recordingId: recording.recordingId, source: 'embedded', plain: 'lantern harbor' })
  const sql = getSql()
  await sql`
    insert into catalog_index (kind, mbid, name, artist_name, album_name, name_key, score, head) values
    ('recording', gen_random_uuid(), 'Yesterday', 'The Beatles', 'Help!', 'yesterday', 1, false),
    ('recording', gen_random_uuid(), '宇多田ヒカル', null, null, '宇多田ヒカル', 1, true)`
  await sql`insert into catalog_index_imports (id, state, recordings) values (gen_random_uuid(), 'active', 2)`
  await runMigrations()
  expect(await catalogDefinitions()).toHaveLength(4)
  expect(await definitions(librarySearchIndexNames)).toEqual([])
  expect(await isCatalogIndexReady()).toBe(true)
  expect(await getCatalogIndexStatus()).toMatchObject({ searchUpgrade: 'pending' })

  const catalog = (query: string) => searchCatalogIndex(query, { kinds: ['recording'] })
  const library = (query: string) => searchLibrary(user.id, query, 10, { types: ['track'], scope: 'server' })
  const lyric = () => searchLyrics(user.id, 'lantern harbor', 10, 0, 'server', {})
  expect(await catalog('yest')).toMatchObject([{ name: 'Yesterday' }])
  expect(await catalog('宇多田')).toMatchObject([{ name: '宇多田ヒカル' }])
  expect(await catalog('beatles yesterday')).toEqual([])
  expect(await library('宇多田')).toMatchObject({ tracks: [recording.recordingId] })
  expect(await library('lantern sng')).toMatchObject({ tracks: [album.tracks[1]!.recordingId] })
  expect(await lyric()).toEqual([])

  const writer = await sql.reserve()
  try {
    // Hold a writer open so the concurrent build has an invalid entry while it waits.
    await writer`begin`
    await writer`update catalog_index set score = score`
    await catalogIndexModule.jobs!(jobs)
    await startJobs({ work: true })
    await catalogIndexModule.start!({ role: 'api' })
    expect(await getCatalogIndexStatus()).toMatchObject({ searchUpgrade: 'pending' })
    await catalogIndexModule.start!({ role: 'worker' })
    await expect.poll(async () => (await getCatalogIndexStatus()).searchUpgrade, { timeout: 10_000 }).toBe('building')
    expect(await catalog('宇多田')).toMatchObject([{ name: '宇多田ヒカル' }])
    expect(await catalog('宇多田ひかる')).toEqual([])
    await expect(dropCatalogIndex()).rejects.toMatchObject({ code: 'catalog_index_maintenance_running' })
    await catalogIndexModule.stop!()
    expect((await searchIndexValidity(['catalog_index_unicode'])).get('catalog_index_unicode')).toBe(false)
  } finally {
    await writer`rollback`
    writer.release()
    await catalogIndexModule.stop!()
  }

  await drainJobs()
  await catalogIndexModule.start!({ role: 'worker' })
  await drainJobs()
  expect(await getCatalogIndexStatus()).toMatchObject({ searchUpgrade: 'ready' })
  expect(await catalog('beatles yesterday')).toMatchObject([{ name: 'Yesterday' }])
  expect(await catalog('yesterday help')).toMatchObject([{ name: 'Yesterday' }])
  expect(await catalog('宇多田ひかる')).toMatchObject([{ name: '宇多田ヒカル' }])
  expect(await library('宇多田ひかる')).toMatchObject({ tracks: [recording.recordingId] })
  expect(await lyric()).toMatchObject([{ track: { id: recording.recordingId } }])
  expect(await definitions(librarySearchIndexNames)).toEqual(freshLibrary)

  const upgradedCatalog = await catalogDefinitions()
  expect(upgradedCatalog).toHaveLength(7)
  const dump = path.join(getConfig().SQUIRMY_DATA_DIR, 'dump.tar.zst')
  await writeFile(dump, buildDump(testCatalog()))
  await importCanonicalDump({ source: dump })
  expect(await catalogDefinitions()).toEqual(upgradedCatalog)
  await catalogIndexModule.stop!()
})
