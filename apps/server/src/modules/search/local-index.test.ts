import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SearchResults } from '@squirmy/contracts'
import { and, eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { getConfig } from '../../config.js'
import { db } from '../../database/client.js'
import { albums, artists, externalIds, recordings } from '../../database/schema.js'
import { body, signIn } from '../../test/api.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { buildDump, testCatalog, type Catalog } from '../catalog-index/fixtures.js'
import { importCanonicalDump } from '../catalog-index/import.js'
import { materialize } from './materialize.js'
import { searchCatalog } from './providers.js'

describe('catalog search from the local index', () => {
  useTestDatabase()
  // Any request to Deezer or MusicBrainz would fail: the index answers alone.
  const http = useHttpFixtures()
  let app: FastifyInstance
  let user: Awaited<ReturnType<typeof signIn>>
  let catalog: Catalog

  const search = async (q: string) =>
    body(await app.inject({ url: `/api/v1/search/catalog?q=${encodeURIComponent(q)}&limit=5`, headers: user.headers }), SearchResults)

  beforeAll(async () => {
    app = await buildApp()
    user = await signIn()
    catalog = testCatalog()
    const file = path.join(getConfig().SQUIRMY_DATA_DIR, 'dump.tar.zst')
    await writeFile(file, buildDump(catalog))
    await importCanonicalDump({ source: file })
  })
  afterAll(async () => {
    await app.close()
  })

  it('answers from the index and stores MBID stubs', async () => {
    const results = await search('beatles')
    expect(results.provider).toBe('local-index')
    expect(http.requests).toEqual([])

    const beatles = results.artists.find((artist) => artist.name === 'The Beatles')!
    expect(beatles.mbid).toBe(catalog.ids['artist:The Beatles'])
    const [artist] = await db.select().from(artists).where(eq(artists.id, beatles.id))
    expect(artist).toMatchObject({ mbid: beatles.mbid, detailLevel: 0, nameKey: 'the beatles' })
    expect(await db.select({ externalId: externalIds.externalId }).from(externalIds)
      .where(and(eq(externalIds.provider, 'musicbrainz'), eq(externalIds.entityType, 'artist'), eq(externalIds.entityId, beatles.id))))
      .toEqual([{ externalId: beatles.mbid }])

    const help = (await search('help')).albums.find((album) => album.title === 'Help!')!
    expect(help).toMatchObject({ mbid: catalog.ids['album:Help!'], availability: 'none', artists: [{ id: beatles.id, name: 'The Beatles' }] })
    expect(help.artwork).not.toBeNull()
  })

  it('gives tracks the album they are best known from', async () => {
    const results = await search('yesterday')
    const yesterday = results.tracks.find((track) => track.mbid === catalog.ids['recording:beatles-yesterday'])!
    expect(yesterday).toMatchObject({ title: 'Yesterday', artistCredit: 'The Beatles', availability: 'none' })
    const [album] = await db.select().from(albums).where(eq(albums.mbid, catalog.ids['album:Help!']!))
    expect(yesterday.album?.id).toBe(album!.id)
    const [row] = await db.select().from(recordings).where(eq(recordings.id, yesterday.id))
    expect(row).toMatchObject({ mbid: yesterday.mbid, albumHintId: album!.id })
  })

  it("matches the user's own copy and leaves it to the library answer", async () => {
    const queen = await createArtist({ name: 'Queen' })
    const opera = await createAlbum({ title: 'A Night at the Opera', artist: queen, owned: true, tracks: [{ title: 'Bohemian Rhapsody' }] })
    const { provider, results: found } = await searchCatalog('bohemian rhapsody', 5)
    expect((await materialize(provider!.idSource, found)).tracks[0]).toBe(opera.tracks[0]!.recordingId)
    const results = await search('bohemian rhapsody')
    expect(results.tracks.map((track) => track.id)).not.toContain(opera.tracks[0]!.recordingId)
    const library = body(await app.inject({ url: '/api/v1/search/library?q=bohemian+rhapsody&limit=5', headers: user.headers }), SearchResults)
    expect(library.tracks[0]).toMatchObject({ id: opera.tracks[0]!.recordingId, availability: 'server', album: { id: opera.albumId } })
  })
})
