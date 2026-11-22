import { eq, sql } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import sharp from 'sharp'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, assets, externalIds, mediaFiles } from '../../database/schema.js'
import { startJobs, stopJobs } from '../../jobs/index.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { assignAlbumArtwork, remoteImage, storeImage } from '../artwork/index.js'
import { albumSummaries } from '../catalog/summaries.js'
import { albumsMissingCovers, fallbackCover, resetCoverSweep } from './covers.js'

/** HYPE MEDIA JAPAN: Hype Selects, Vol. 1, released a week before the fixtures were recorded. */
const freshGroup = '6c5f8e76-87b9-4480-8d2f-432180feba69'
/** Pullin' Plugs! V7: no cover at the Cover Art Archive. */
const coverlessGroup = '18cf83bd-c54c-4c97-b91f-bb64bbc7c340'
const discographyCover = (mbid: string) => `https://coverartarchive.org/release-group/${mbid}/front-500`
const okComputerOnDeezer = '14879699'

async function queued(name: string) {
  return (await db.execute<{ albumId: string }>(sql`select data->>'albumId' as "albumId" from pgboss.job where name = ${name} and state = 'created'`)).map((row) => row.albumId)
}

const artworkOf = async (albumId: string) => (await db.select({ id: albums.artworkAssetId }).from(albums).where(eq(albums.id, albumId)))[0]!.id

describe('fallback covers', () => {
  useTestDatabase()
  const http = useHttpFixtures('coverart', 'deezer')
  let app: FastifyInstance

  beforeAll(async () => {
    await startJobs({ work: false })
    app = await buildApp()
  })
  afterAll(async () => {
    await app.close()
    await stopJobs()
  })

  const art = (id: string) => app.inject({ method: 'GET', url: `/api/v1/art/${id}/300` })

  /** A discography row as artist detail writes it: no track list of its own yet, the archive's group front as a lazy cover. */
  async function discographyRow(mbid: string) {
    const album = await createAlbum({ mbid })
    const cover = await remoteImage(discographyCover(mbid), { kind: 'cover' })
    await assignAlbumArtwork(album.albumId, cover.id, { onlyIfEmpty: false })
    return { ...album, coverId: cover.id }
  }

  it('shows a new release\'s cover from the original while the archive\'s sized one is not there yet', async () => {
    const album = await discographyRow(freshGroup)
    expect((await art(album.coverId)).statusCode).toBe(200)
    expect((await db.select().from(assets).where(eq(assets.id, album.coverId)))[0]).toMatchObject({ status: 'ready', width: 32 })
    expect(await artworkOf(album.albumId)).toBe(album.coverId)
    expect(await queued('enrichment.cover')).not.toContain(album.albumId)
  })

  it('gives an album whose cover the archive does not have the cover of its Deezer page, and no id that answers 404 meanwhile', async () => {
    const album = await discographyRow(coverlessGroup)
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: okComputerOnDeezer, entityId: album.albumId })

    expect((await art(album.coverId)).statusCode).toBe(404)
    expect(await artworkOf(album.albumId)).toBeNull()
    expect((await albumSummaries([album.albumId]))[0]!.artwork).toBeNull()
    expect(await queued('enrichment.cover')).toContain(album.albumId)

    expect(await fallbackCover(album.albumId)).toBe(true)
    const [cover] = await db.select().from(assets).where(eq(assets.id, (await artworkOf(album.albumId))!))
    expect(cover).toMatchObject({ kind: 'cover', status: 'remote', remoteUrl: 'https://cdn-images.dzcdn.net/images/cover/05a186e0a859a36f9cd51cdae2158fe1/1000x1000-000000-80-0-0.jpg' })
    expect((await albumSummaries([album.albumId]))[0]!.artwork?.id).toBe(cover!.id)
    // An album that has a cover again keeps it.
    expect(await fallbackCover(album.albumId)).toBe(false)
  })

  it('prefers the picture in the album\'s own files over another source', async () => {
    const album = await createAlbum({ owned: true, tracks: [{ title: 'Only' }] })
    // Never asked: the file's picture comes first.
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: '424242', entityId: album.albumId })
    const picture = await storeImage(await sharp({ create: { width: 64, height: 64, channels: 3, background: '#aa3355' } }).png().toBuffer(), { kind: 'embedded', source: 'test:embedded' })
    await db.update(mediaFiles).set({ embeddedArtAssetId: picture.id }).where(eq(mediaFiles.id, album.tracks[0]!.fileId!))
    const before = http.requests.length

    expect(await fallbackCover(album.albumId)).toBe(true)
    expect(await artworkOf(album.albumId)).toBe(picture.id)
    expect(http.requests.slice(before)).toEqual([])
  })

  it('has the sweep queue albums without a cover that have a source, once a day', async () => {
    resetCoverSweep()
    const withDeezer = await createAlbum()
    await db.update(albums).set({ artworkAssetId: null }).where(eq(albums.id, withDeezer.albumId))
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: '999999999999', entityId: withDeezer.albumId })
    const sourceless = await createAlbum()

    const first = await albumsMissingCovers()
    expect(first).toContain(withDeezer.albumId)
    expect(first).not.toContain(sourceless.albumId)
    expect(await albumsMissingCovers()).not.toContain(withDeezer.albumId)
    // Deezer no longer has that page: nothing to show, and nothing breaks.
    expect(await fallbackCover(withDeezer.albumId)).toBe(false)
    expect(await artworkOf(withDeezer.albumId)).toBeNull()
  })
})
