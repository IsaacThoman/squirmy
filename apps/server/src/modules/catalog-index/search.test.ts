import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { getConfig } from '../../config.js'
import { getSql } from '../../database/client.js'
import { useTestDatabase } from '../../test/database.js'
import { buildDump, testCatalog, type Catalog } from '../../test/catalog-index-dump.js'
import { importCanonicalDump } from './import.js'
import { isCatalogIndexReady, searchCatalogIndex } from './search.js'

let catalog: Catalog

const top = async (query: string, kind: 'artist' | 'album' | 'recording') =>
  (await searchCatalogIndex(query, { kinds: [kind], limit: 5 }))[0]

describe('searchCatalogIndex', () => {
  useTestDatabase()

  beforeAll(async () => {
    expect(await isCatalogIndexReady()).toBe(false)
    expect(await searchCatalogIndex('yesterday')).toEqual([])
    catalog = testCatalog()
    const file = path.join(getConfig().SQUIRMY_DATA_DIR, 'dump.tar.zst')
    await writeFile(file, buildDump(catalog))
    await importCanonicalDump({ source: file })
  })

  it('is ready once an import is active', async () => {
    expect(await isCatalogIndexReady()).toBe(true)
  })

  it('returns every kind, at most `limit` of each, best first', async () => {
    const results = await searchCatalogIndex('yesterday', { limit: 1 })
    expect(results.map((result) => result.kind).sort()).toEqual(['album', 'recording'])
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score)
    for (const result of results) expect(result.score).toBeGreaterThan(0)
  })

  it('puts the famous version of a song first', async () => {
    const results = await searchCatalogIndex('yesterday', { kinds: ['recording'] })
    expect(results.map((result) => [result.name, result.artistName])).toEqual([['Yesterday', 'The Beatles'], ['Yesterday', 'Small Town Band']])
    expect(results[0]).toMatchObject({ kind: 'recording', mbid: catalog.ids['recording:beatles-yesterday'], albumName: 'Help!' })
  })

  it('makes sense after three or four characters', async () => {
    expect(await top('bea', 'artist')).toMatchObject({ name: 'The Beatles' })
    expect(await top('abb', 'album')).toMatchObject({ name: 'Abbey Road', artistName: 'The Beatles', albumName: null })
    expect(await top('bohe', 'recording')).toMatchObject({ name: 'Bohemian Rhapsody', artistName: 'Queen' })
    expect(await top('yest', 'recording')).toMatchObject({ name: 'Yesterday', artistName: 'The Beatles' })
  })

  it('tolerates typos', async () => {
    expect(await top('beatels', 'artist')).toMatchObject({ name: 'The Beatles' })
    expect(await top('bohemian rapsody', 'recording')).toMatchObject({ name: 'Bohemian Rhapsody' })
  })

  it('ignores case, punctuation and diacritics', async () => {
    expect(await top('BEYONCE', 'artist')).toMatchObject({ name: 'Beyoncé' })
    expect(await top('sigur ros', 'artist')).toMatchObject({ name: 'Sigur Rós' })
    expect(await top('agaetis', 'album')).toMatchObject({ name: 'Ágætis byrjun' })
    // The famous near match still comes first; the punctuated exact name is right behind it.
    const albums = await searchCatalogIndex('ABBEY RD', { kinds: ['album'] })
    expect(albums.slice(0, 2).map((album) => album.name)).toEqual(['Abbey Road', 'Abbey Rd. Tribute'])
  })

  it('finds names in any script by prefix', async () => {
    expect(await top('東京', 'recording')).toMatchObject({ name: '東京', artistName: 'くるり' })
  })

  it('prefers an exact name over a fuzzy one of similar fame', async () => {
    expect(await top('help', 'album')).toMatchObject({ name: 'Help!' })
    expect(await top('the beatles', 'artist')).toMatchObject({ name: 'The Beatles' })
  })

  it('finds rows outside the fuzzy head by their name', async () => {
    await getSql()`update catalog_index set head = false where mbid = ${catalog.ids['recording:obscure']!}`
    expect(await top('kalomine', 'recording')).toMatchObject({ name: 'Kalomine Ravozeti', artistName: 'Nobody Special' })
    expect(await top('kalomine ravozeti', 'recording')).toMatchObject({ name: 'Kalomine Ravozeti' })
    expect(await top('ravozeti', 'recording')).toBeUndefined()
  })

  it('returns nothing for a query without letters or digits', async () => {
    expect(await searchCatalogIndex('?!')).toEqual([])
    expect(await searchCatalogIndex('zzzzqqq')).toEqual([])
  })
})
