import { spawnSync } from 'node:child_process'
import { writeFile } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { Readable } from 'node:stream'
import { zstdCompressSync } from 'node:zlib'
import { desc, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it } from 'vitest'
import { getConfig } from '../../config.js'
import { db, getSql } from '../../database/client.js'
import { catalogIndexImports } from '../../database/schema.js'
import { useTestDatabase } from '../../test/database.js'
import { findLatestDump, spawnZstd } from './dump.js'
import { buildDump, tarEnd, tarFile, testCatalog } from '../../test/catalog-index-dump.js'
import { cancelImport, ImportCancelledError, importCanonicalDump } from './import.js'
import { readTar } from './tar.js'

const servers: { close: () => void }[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

/** Serves `body` on localhost. With `gate`, sends the first `split` bytes and waits for the gate before the rest. */
async function serve(body: Buffer, options: { gate?: Promise<void>; split?: number; listing?: string } = {}) {
  const pending: ServerResponse[] = []
  const server = createServer((request, response) => {
    if (options.listing && request.url?.endsWith('/')) {
      response.end(options.listing)
      return
    }
    pending.push(response)
    response.writeHead(200, { 'content-length': body.length })
    const split = options.split ?? body.length
    response.write(body.subarray(0, split))
    void (options.gate ?? Promise.resolve()).then(() => response.end(body.subarray(split)), () => response.destroy())
  })
  server.keepAliveTimeout = 1
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  servers.push({ close: () => { for (const response of pending) response.destroy(); server.close() } })
  return `http://127.0.0.1:${port}`
}

function gate() {
  let open!: () => void
  let fail!: (error: Error) => void
  const promise = new Promise<void>((resolve, reject) => { open = resolve; fail = reject })
  promise.catch(() => {})
  return { promise, open, fail }
}

async function writeDump(name: string, dump: Buffer) {
  const file = path.join(getConfig().SQUIRMY_DATA_DIR, name)
  await writeFile(file, dump)
  return file
}

async function names(kind: string) {
  const rows = await getSql()<{ name: string }[]>`select name from catalog_index where kind = ${kind} order by score desc, name`
  return rows.map((row) => row.name)
}

async function stagingTables() {
  const rows = await getSql()<{ name: string }[]>`
    select tablename as name from pg_tables where tablename like 'catalog\\_index\\_%' and tablename <> 'catalog_index_imports'`
  return rows.map((row) => row.name)
}

async function waitForRunningImport() {
  for (let i = 0; i < 200; i++) {
    const [row] = await db.select().from(catalogIndexImports).where(eq(catalogIndexImports.state, 'running'))
    if (row && row.bytesRead > 0) return row
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('The import never started')
}

describe('importCanonicalDump', () => {
  useTestDatabase()

  it('streams a dump from a file through to searchable rows', async () => {
    const catalog = testCatalog()
    const file = await writeDump('first.tar.zst', buildDump(catalog))
    const result = await importCanonicalDump({ source: file })

    expect(result).toMatchObject({ artists: 9, albums: 11, recordings: catalog.recordings.length })
    expect(result.dumpDate?.toISOString()).toBe('2026-11-17T08:00:03.201Z')

    const [byName] = await getSql()<{ name: string; artist_name: string; album_name: string; name_key: string }[]>`
      select name, artist_name, album_name, name_key from catalog_index where mbid = ${catalog.ids['recording:quoted']!}`
    expect(byName).toEqual({
      name: 'Theme Time Radio Hour "Friends & Neighbors"',
      artist_name: 'Bob Dylan',
      album_name: 'Theme Time Radio Hour, Season 1',
      name_key: 'theme time radio hour friends and neighbors',
    })
    const [multiline] = await getSql()<{ name: string }[]>`select name from catalog_index where mbid = ${catalog.ids['recording:multiline']!}`
    expect(multiline?.name).toBe('Line one\nline two')
    const [escapes] = await getSql()<{ name: string }[]>`select name from catalog_index where mbid = ${catalog.ids['recording:escapes']!}`
    expect(escapes?.name).toBe('Tab\there and back\\slash')

    // Albums are release groups, and every artist with a name of its own is there.
    const [abbey] = await getSql()<{ mbid: string; artist_name: string }[]>`select mbid, artist_name from catalog_index where kind = 'album' and name = 'Abbey Road'`
    expect(abbey).toEqual({ mbid: catalog.ids['album:Abbey Road'], artist_name: 'The Beatles' })
    expect(await names('artist')).toContain('くるり')
    expect((await names('artist'))[0]).toBe('The Beatles')

    const [row] = await db.select().from(catalogIndexImports).where(eq(catalogIndexImports.id, result.id))
    expect(row).toMatchObject({ state: 'active', phase: null, recordings: catalog.recordings.length, rowsRead: catalog.recordings.length })
    expect(await stagingTables()).toEqual([])
  })

  it('ranks by popularity: versions, editions and the size of the artist', async () => {
    const recordings = await names('recording')
    expect(recordings.indexOf('Yesterday')).toBeLessThan(recordings.indexOf('Bohemian Rhapsody'))
    expect(recordings.indexOf('Bohemian Rhapsody')).toBeLessThan(recordings.indexOf('Kalomine Ravozeti'))
    const albums = await names('album')
    expect(albums.slice(0, 2)).toEqual(['Abbey Road', 'Help!'])
  })

  it('discovers the newest dump and downloads it over HTTP', async () => {
    const dump = buildDump(testCatalog())
    const base = await serve(dump, {
      listing: [
        '<a href="musicbrainz-canonical-dump-20261103-080003/">musicbrainz-canonical-dump-20261103-080003/</a>',
        '<a href="musicbrainz-canonical-dump-20261117-080003/">musicbrainz-canonical-dump-20261117-080003/</a>',
      ].join('\n'),
    })
    const latest = await findLatestDump(`${base}/canonical_data/`)
    expect(latest).toBe(`${base}/canonical_data/musicbrainz-canonical-dump-20261117-080003/musicbrainz-canonical-dump-20261117-080003.tar.zst`)

    const result = await importCanonicalDump({ indexUrl: `${base}/canonical_data/` })
    const [row] = await db.select().from(catalogIndexImports).where(eq(catalogIndexImports.id, result.id))
    expect(row).toMatchObject({ state: 'active', source: latest, bytesRead: dump.length, totalBytes: dump.length })
    const states = await db.select({ state: catalogIndexImports.state }).from(catalogIndexImports)
    expect(states.filter((state) => state.state === 'active')).toHaveLength(1)
  })

  it('keeps serving the old index during an import and swaps in the new one at the end', async () => {
    const dump = buildDump(testCatalog({ prefix: 'New ' }))
    const wait = gate()
    const url = await serve(dump, { gate: wait.promise, split: 4096 })
    const running = importCanonicalDump({ source: `${url}/dump.tar.zst` })
    await waitForRunningImport()

    expect(await names('recording')).toContain('Yesterday')
    await expect(importCanonicalDump({ source: url })).rejects.toMatchObject({ status: 409 })

    wait.open()
    await running
    const recordings = await names('recording')
    expect(recordings).toContain('New Yesterday')
    expect(recordings).not.toContain('Yesterday')
  })

  it('leaves the current index untouched when an import fails', async () => {
    const before = await names('recording')
    const dump = buildDump(testCatalog({ prefix: 'Broken ' }))
    const file = await writeDump('truncated.tar.zst', dump.subarray(0, Math.floor(dump.length * 0.8)))
    await expect(importCanonicalDump({ source: file })).rejects.toThrow()

    expect(await names('recording')).toEqual(before)
    expect(await stagingTables()).toEqual([])
    const [latest] = await db.select().from(catalogIndexImports).orderBy(desc(catalogIndexImports.startedAt)).limit(1)
    expect(latest).toMatchObject({ state: 'failed' })
    expect(latest?.error).toBeTruthy()
  })

  it('rejects an archive that is not a canonical dump', async () => {
    const file = await writeDump('other.tar.zst', zstdCompressSync(Buffer.concat([tarFile('notes/README', Buffer.from('hello')), tarEnd()])))
    await expect(importCanonicalDump({ source: file })).rejects.toThrow(/has no canonical_musicbrainz_data.csv/)
  })

  it('stops when cancelled from another process and drops its staging tables', async () => {
    const before = await names('recording')
    const wait = gate()
    const url = await serve(buildDump(testCatalog({ prefix: 'Cancelled ' })), { gate: wait.promise, split: 4096 })
    const running = importCanonicalDump({ source: url })
    await waitForRunningImport()
    expect(await cancelImport()).toBe(true)

    await expect(running).rejects.toBeInstanceOf(ImportCancelledError)
    wait.fail(new Error('cancelled'))
    expect(await names('recording')).toEqual(before)
    expect(await stagingTables()).toEqual([])
    const [latest] = await db.select().from(catalogIndexImports).orderBy(desc(catalogIndexImports.startedAt)).limit(1)
    expect(latest).toMatchObject({ state: 'cancelled', error: null })
    expect(await cancelImport()).toBe(false)
  })

  it('stops on an abort signal', async () => {
    const wait = gate()
    const url = await serve(buildDump(testCatalog({ prefix: 'Aborted ' })), { gate: wait.promise, split: 4096 })
    const controller = new AbortController()
    const running = importCanonicalDump({ source: url, signal: controller.signal })
    await waitForRunningImport()
    controller.abort()
    await expect(running).rejects.toBeInstanceOf(ImportCancelledError)
    wait.fail(new Error('aborted'))
    expect(await stagingTables()).toEqual([])
  })

  it('keeps only the best recordings of each artist when asked to', async () => {
    const catalog = testCatalog()
    const file = await writeDump('capped.tar.zst', buildDump(catalog))
    const result = await importCanonicalDump({ source: file, recordingsPerArtist: 5 })
    const [beatles] = await getSql()<{ count: number }[]>`
      select count(*)::int as count from catalog_index where kind = 'recording' and artist_name = 'The Beatles'`
    expect(beatles?.count).toBe(5)
    // The Beatles' first five, in canonical order: the Help! and Abbey Road tracks, not the live tapes.
    expect(await names('recording')).not.toContain('Live Tape Track 1')
    const [row] = await db.select().from(catalogIndexImports).where(eq(catalogIndexImports.id, result.id))
    expect(row?.recordingsPerArtist).toBe(5)
  })
})

describe.skipIf(spawnSync('zstd', ['--version']).error)('spawnZstd', () => {
  it('decompresses through the zstd program', async () => {
    const dump = buildDump(testCatalog())
    const paths: string[] = []
    for await (const entry of readTar(spawnZstd(Readable.from([dump])))) paths.push(entry.path.split('/').at(-1)!)
    expect(paths).toEqual(['TIMESTAMP', 'COPYING', 'canonical_musicbrainz_data.csv', 'canonical_recording_redirect.csv', 'canonical_release_redirect.csv'])
  })

  it('reports corrupt input', async () => {
    const consume = async () => {
      for await (const chunk of spawnZstd(Readable.from([Buffer.from('not zstd at all')]))) void chunk
    }
    await expect(consume()).rejects.toThrow(/zstd failed/)
  })
})
