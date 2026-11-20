import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { mediaFiles, recordings } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist, createUser } from '../../test/factories.js'
import { resolveOne } from '../catalog/redirects.js'
import { buildPlaybackDescriptor } from '../streaming/playback.js'
import type { JobRow } from './jobs.js'
import { verifyDelivery } from './verify.js'

const mbid = () => crypto.randomUUID()

describe('delivery verification', () => {
  useTestDatabase()

  /** A requested recording nobody owns. */
  async function requested(input: { title?: string; artist?: { id: string; name: string }; mbid?: string; durationMs?: number; isrcs?: string[] } = {}) {
    const album = await createAlbum({ artist: input.artist, tracks: [{ title: input.title ?? 'Asked For', mbid: input.mbid, durationMs: input.durationMs ?? 200_000 }] })
    const id = album.tracks[0]!.recordingId
    if (input.isrcs) await db.update(recordings).set({ isrcs: input.isrcs }).where(eq(recordings.id, id))
    return { id, artist: album.artist }
  }

  /** A file an import brought in, linked to a recording of its own. */
  async function delivered(importId: string, input: { title?: string; artist?: { id: string; name: string }; mbid?: string; durationMs?: number; isrcs?: string[] } = {}) {
    const durationMs = input.durationMs ?? 200_000
    const album = await createAlbum({ artist: input.artist, owned: true, tracks: [{ title: input.title ?? 'Asked For', mbid: input.mbid, durationMs }] })
    const track = album.tracks[0]!
    await db.update(mediaFiles).set({ importId, source: 'provider:test', durationMs, tags: { isrcs: input.isrcs ?? [] } }).where(eq(mediaFiles.id, track.fileId!))
    return { id: track.recordingId, fileId: track.fileId! }
  }

  const job = (recordingIds: string[], importId: string) => ({ recordingIds, importId }) as JobRow
  const mergedInto = async (id: string) => (await db.select({ to: recordings.mergedIntoId }).from(recordings).where(eq(recordings.id, id)))[0]!.to

  it('merges a requested search stub into the identified row the file was matched to, and the stub id still plays', async () => {
    const importId = newId()
    const artist = await createArtist({ name: 'Stub Artist' })
    const stub = await requested({ artist })
    const full = await delivered(importId, { artist, mbid: mbid() })
    expect(await verifyDelivery(job([stub.id], importId))).toEqual([stub.id])
    expect(await mergedInto(stub.id)).toBe(full.id)
    expect(await mergedInto(full.id)).toBeNull()
    expect(await resolveOne('recordings', stub.id)).toBe(full.id)
    const user = await createUser()
    const descriptor = await buildPlaybackDescriptor(user.id, stub.id, { quality: 'original', codecs: 'flac' })
    expect(descriptor).toMatchObject({ trackId: stub.id, fileId: full.fileId })
  })

  it('merges a local-only row from the tags into an identified requested row', async () => {
    const importId = newId()
    const artist = await createArtist({ name: 'Known Artist' })
    const wanted = await requested({ artist, mbid: mbid() })
    const local = await delivered(importId, { artist })
    expect(await verifyDelivery(job([wanted.id], importId))).toEqual([wanted.id])
    expect(await mergedInto(local.id)).toBe(wanted.id)
    expect((await db.select().from(mediaFiles).where(eq(mediaFiles.id, local.fileId)))[0]!.recordingId).toBe(wanted.id)
  })

  it('keeps the requested row when neither has a MusicBrainz id', async () => {
    const importId = newId()
    const artist = await createArtist()
    const wanted = await requested({ artist })
    const local = await delivered(importId, { artist })
    expect(await verifyDelivery(job([wanted.id], importId))).toEqual([wanted.id])
    expect(await mergedInto(local.id)).toBe(wanted.id)
  })

  it('accepts the same title and artist within the length tolerance, a featured credit, or a shared ISRC', async () => {
    const artist = await createArtist({ name: 'Main Act' })
    const close = await requested({ artist, title: 'Close Enough', durationMs: 200_000 })
    const closeImport = newId()
    await delivered(closeImport, { artist, title: 'Close Enough', durationMs: 204_500 })
    expect(await verifyDelivery(job([close.id], closeImport))).toEqual([close.id])

    const remaster = await requested({ artist, title: 'Old Song (Remastered 2009)', durationMs: 150_000 })
    const remasterImport = newId()
    await delivered(remasterImport, { artist, title: 'Old Song', durationMs: 151_000 })
    expect(await verifyDelivery(job([remaster.id], remasterImport))).toEqual([remaster.id])

    const featuring = await createArtist({ name: 'Main Act feat. Guest' })
    const featured = await requested({ artist, title: 'Duet' })
    const featuredImport = newId()
    await delivered(featuredImport, { artist: featuring, title: 'Duet' })
    expect(await verifyDelivery(job([featured.id], featuredImport))).toEqual([featured.id])

    const coded = await requested({ artist, title: 'Original Title', isrcs: ['GBAAA0000001'] })
    const codedImport = newId()
    await delivered(codedImport, { artist, title: 'Retitled Upload', durationMs: 100_000, isrcs: ['gbaaa0000001'] })
    expect(await verifyDelivery(job([coded.id], codedImport))).toEqual([coded.id])
  })

  it('refuses a different length, a different title, and two different MusicBrainz recordings', async () => {
    const artist = await createArtist({ name: 'Strict Act' })
    const cases = [
      { wanted: { durationMs: 200_000 }, got: { durationMs: 206_000 } },
      { wanted: { title: 'Song A' }, got: { title: 'Song B' } },
      { wanted: { title: 'Song A (Live)' }, got: { title: 'Song A' } },
      { wanted: { mbid: mbid() }, got: { mbid: mbid() } },
    ]
    for (const { wanted, got } of cases) {
      const importId = newId()
      const asked = await requested({ artist, ...wanted })
      const file = await delivered(importId, { artist, ...got })
      expect(await verifyDelivery(job([asked.id], importId)), JSON.stringify({ wanted, got })).toEqual([])
      expect(await mergedInto(asked.id)).toBeNull()
      expect(await mergedInto(file.id)).toBeNull()
    }
  })

  it('checks each track of an album delivery once', async () => {
    const importId = newId()
    const artist = await createArtist({ name: 'Album Act' })
    const first = await requested({ artist, title: 'Side A' })
    const second = await requested({ artist, title: 'Side B' })
    const missing = await requested({ artist, title: 'Side C' })
    await delivered(importId, { artist, title: 'Side A' })
    await delivered(importId, { artist, title: 'Side B' })
    expect(await verifyDelivery(job([first.id, second.id, missing.id], importId))).toEqual([first.id, second.id])
  })
})
