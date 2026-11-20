import { and, eq } from 'drizzle-orm'
import { beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import {
  albumArtists, albums, artists, assets, externalIds, likes, lyrics, mediaFiles, playlistItems, playlists, plays, ratings,
  recordingArtists, recordings, releases, releaseTracks, wants,
} from '../../database/schema.js'
import { newId, newPublicId } from '../../lib/ids.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist, createUser } from '../../test/factories.js'
import { mergeAlbum, mergeArtist, mergeRecording, resolveMerged } from './merge.js'

const older = new Date('2024-01-01T00:00:00Z')
const newer = new Date('2025-01-01T00:00:00Z')

async function snapshot() {
  return {
    likes: await db.select().from(likes).orderBy(likes.userId, likes.entityId),
    ratings: await db.select().from(ratings).orderBy(ratings.userId, ratings.entityId),
    wants: await db.select().from(wants).orderBy(wants.userId, wants.entityId),
    items: await db.select().from(playlistItems).orderBy(playlistItems.id),
    plays: await db.select().from(plays).orderBy(plays.id),
    files: await db.select().from(mediaFiles).orderBy(mediaFiles.id),
    tracks: await db.select().from(releaseTracks).orderBy(releaseTracks.id),
    recordings: await db.select().from(recordings).orderBy(recordings.id),
    albums: await db.select().from(albums).orderBy(albums.id),
    artists: await db.select().from(artists).orderBy(artists.id),
  }
}

async function asset() {
  const [row] = await db.insert(assets).values({ id: newPublicId(), kind: 'cover', source: 'test', sha256: newId(), mime: 'image/jpeg', width: 1, height: 1, bytes: 1, storagePath: 'x' }).returning()
  return row!.id
}

describe('merges', () => {
  useTestDatabase()
  let first: Awaited<ReturnType<typeof createUser>>
  let second: Awaited<ReturnType<typeof createUser>>
  let playlistId = ''

  beforeAll(async () => {
    first = await createUser()
    second = await createUser()
    const [playlist] = await db.insert(playlists).values({ id: newId(), ownerId: first.id, name: 'Mix' }).returning()
    playlistId = playlist!.id
  })

  it('merges a recording, keeping the older like, rating and want', async () => {
    const local = await createAlbum({ title: 'Local', owned: true, tracks: [{ title: 'Airbag' }] })
    const matched = await createAlbum({ title: 'Matched', mbid: newId(), tracks: [{ title: 'Airbag', mbid: newId() }] })
    const from = local.tracks[0]!.recordingId
    const into = matched.tracks[0]!.recordingId
    const redirected = (await createAlbum({ tracks: [{ title: 'Airbag (old)' }] })).tracks[0]!.recordingId
    await db.update(recordings).set({ mergedIntoId: from }).where(eq(recordings.id, redirected))
    await db.update(recordings).set({ isrcs: ['GBAYE9701274'] }).where(eq(recordings.id, from))
    await db.update(recordings).set({ isrcs: ['GBBKS1700107'] }).where(eq(recordings.id, into))

    await db.insert(likes).values([
      { userId: first.id, entityType: 'recording', entityId: from, createdAt: older },
      { userId: first.id, entityType: 'recording', entityId: into, createdAt: newer },
      { userId: second.id, entityType: 'recording', entityId: from, createdAt: newer },
    ])
    await db.insert(ratings).values([
      { userId: first.id, entityType: 'recording', entityId: from, rating: 5, updatedAt: older },
      { userId: first.id, entityType: 'recording', entityId: into, rating: 2, updatedAt: newer },
      { userId: second.id, entityType: 'recording', entityId: into, rating: 3, updatedAt: older },
    ])
    await db.insert(wants).values([
      { userId: first.id, entityType: 'recording', entityId: from, createdAt: newer },
      { userId: first.id, entityType: 'recording', entityId: into, createdAt: older, fulfilledAt: newer },
    ])
    await db.insert(playlistItems).values({ id: newId(), playlistId, position: 0, recordingId: from, albumId: local.albumId })
    await db.insert(plays).values({ id: newId(), userId: first.id, recordingId: from, albumId: local.albumId })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'recording', externalId: '3135556', entityId: from })
    await db.insert(lyrics).values({ recordingId: from, plain: 'in the next world war', source: 'embedded' })

    await mergeRecording(from, into)
    const after = await snapshot()

    expect(await db.select({ userId: likes.userId, entityId: likes.entityId, createdAt: likes.createdAt }).from(likes).where(eq(likes.entityType, 'recording'))).toEqual(
      expect.arrayContaining([{ userId: first.id, entityId: into, createdAt: older }, { userId: second.id, entityId: into, createdAt: newer }]),
    )
    expect(after.likes.filter((like) => like.entityId === from)).toEqual([])
    expect(after.ratings.filter((rating) => rating.entityId === into).map((rating) => [rating.userId, rating.rating]).sort()).toEqual([[first.id, 5], [second.id, 3]].sort())
    expect(after.wants).toMatchObject([{ userId: first.id, entityId: into, createdAt: older, fulfilledAt: newer }])
    expect(after.items[0]).toMatchObject({ recordingId: into })
    expect(after.plays[0]).toMatchObject({ recordingId: into })
    expect(after.files.find((file) => file.id === local.tracks[0]!.fileId)).toMatchObject({ recordingId: into })
    expect(after.tracks.find((track) => track.id === local.tracks[0]!.releaseTrackId)).toMatchObject({ recordingId: into })
    expect(await db.select().from(externalIds)).toMatchObject([{ entityId: into }])
    expect(await db.select().from(lyrics)).toMatchObject([{ recordingId: into, plain: 'in the next world war' }])
    const byId = new Map(after.recordings.map((row) => [row.id, row]))
    expect(byId.get(from)!.mergedIntoId).toBe(into)
    expect(byId.get(redirected)!.mergedIntoId).toBe(into)
    expect(byId.get(into)!.isrcs.sort()).toEqual(['GBAYE9701274', 'GBBKS1700107'])
    expect(await resolveMerged(db, recordings, from)).toBe(into)

    // Idempotent, and a merge back the other way would loop.
    await mergeRecording(from, into)
    expect(await snapshot()).toEqual(after)
    await mergeRecording(into, into)
    await expect(mergeRecording(into, from)).rejects.toMatchObject({ code: 'merge_cycle' })
  })

  it('keeps the winner’s lyrics and credits when it has its own', async () => {
    const local = await createAlbum({ tracks: [{ title: 'Lucky' }] })
    const matched = await createAlbum({ mbid: newId(), tracks: [{ title: 'Lucky', mbid: newId() }] })
    const from = local.tracks[0]!.recordingId
    const into = matched.tracks[0]!.recordingId
    await db.insert(lyrics).values([{ recordingId: from, plain: 'local', source: 'embedded' }, { recordingId: into, plain: 'synced', source: 'lrclib' }])
    await mergeRecording(from, into)
    expect(await db.select({ plain: lyrics.plain }).from(lyrics).where(eq(lyrics.recordingId, into))).toEqual([{ plain: 'synced' }])
    expect(await db.select().from(lyrics).where(eq(lyrics.recordingId, from))).toEqual([])
    expect(await db.select({ artistId: recordingArtists.artistId }).from(recordingArtists).where(eq(recordingArtists.recordingId, into))).toEqual([{ artistId: matched.artist.id }])
  })

  it('merges an album, its editions and what points at it', async () => {
    const local = await createAlbum({ title: 'Discovery', owned: true })
    const matched = await createAlbum({ title: 'Discovery', mbid: newId() })
    const artwork = await asset()
    await db.update(albums).set({ artworkAssetId: artwork }).where(eq(albums.id, local.albumId))
    await db.insert(likes).values([
      { userId: first.id, entityType: 'album', entityId: local.albumId, createdAt: older },
      { userId: first.id, entityType: 'album', entityId: matched.albumId, createdAt: newer },
    ])
    await db.insert(wants).values({ userId: second.id, entityType: 'album', entityId: local.albumId })
    await db.insert(playlistItems).values({ id: newId(), playlistId, position: 1, recordingId: local.tracks[0]!.recordingId, albumId: local.albumId })
    await db.insert(plays).values({ id: newId(), userId: second.id, recordingId: local.tracks[1]!.recordingId, albumId: local.albumId })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'album', externalId: '302127', entityId: local.albumId })

    await mergeAlbum(local.albumId, matched.albumId)
    const after = await snapshot()
    const [winner] = await db.select().from(albums).where(eq(albums.id, matched.albumId))
    expect(winner).toMatchObject({ artworkAssetId: artwork, canonicalReleaseId: matched.releaseId, mergedIntoId: null })
    expect(after.albums.find((album) => album.id === local.albumId)!.mergedIntoId).toBe(matched.albumId)
    expect(await db.select().from(releases).where(eq(releases.id, local.releaseId))).toMatchObject([{ albumId: matched.albumId }])
    expect(after.files.filter((file) => file.albumId === local.albumId)).toEqual([])
    expect(after.likes.filter((like) => like.entityType === 'album')).toMatchObject([{ entityId: matched.albumId, createdAt: older }])
    expect(after.wants.filter((want) => want.entityType === 'album')).toMatchObject([{ userId: second.id, entityId: matched.albumId }])
    expect(after.items.find((item) => item.position === 1)).toMatchObject({ albumId: matched.albumId })
    expect(after.plays.find((play) => play.userId === second.id)).toMatchObject({ albumId: matched.albumId })
    expect(await db.select().from(externalIds).where(eq(externalIds.entityType, 'album'))).toMatchObject([{ entityId: matched.albumId }])
    // The winner keeps its own credits.
    expect(await db.select({ artistId: albumArtists.artistId }).from(albumArtists).where(eq(albumArtists.albumId, matched.albumId))).toEqual([{ artistId: matched.artist.id }])

    await mergeAlbum(local.albumId, matched.albumId)
    expect(await snapshot()).toEqual(after)
  })

  it('merges an artist and every credit to it', async () => {
    const local = await createArtist({ name: 'Daft Punk' })
    const matched = await createArtist({ name: 'Daft Punk', mbid: newId() })
    const image = await asset()
    await db.update(artists).set({ imageAssetId: image }).where(eq(artists.id, local.id))
    const album = await createAlbum({ artist: local })
    await db.insert(likes).values([
      { userId: first.id, entityType: 'artist', entityId: local.id, createdAt: newer },
      { userId: first.id, entityType: 'artist', entityId: matched.id, createdAt: older },
    ])
    await db.insert(ratings).values({ userId: second.id, entityType: 'artist', entityId: local.id, rating: 4 })
    await db.insert(externalIds).values({ provider: 'deezer', entityType: 'artist', externalId: '27', entityId: local.id })

    await mergeArtist(local.id, matched.id)
    const after = await snapshot()
    expect(after.artists.find((artist) => artist.id === local.id)!.mergedIntoId).toBe(matched.id)
    expect(after.artists.find((artist) => artist.id === matched.id)!.imageAssetId).toBe(image)
    expect(after.albums.find((row) => row.id === album.albumId)!.primaryArtistId).toBe(matched.id)
    expect(await db.select().from(albumArtists).where(eq(albumArtists.albumId, album.albumId))).toMatchObject([{ artistId: matched.id }])
    expect(after.recordings.filter((recording) => album.tracks.some((track) => track.recordingId === recording.id)).every((recording) => recording.primaryArtistId === matched.id)).toBe(true)
    expect(await db.select().from(recordingArtists).where(eq(recordingArtists.artistId, local.id))).toEqual([])
    expect(after.likes.filter((like) => like.entityType === 'artist')).toMatchObject([{ entityId: matched.id, createdAt: older }])
    expect(await db.select().from(ratings).where(and(eq(ratings.entityType, 'artist'), eq(ratings.entityId, matched.id)))).toMatchObject([{ userId: second.id, rating: 4 }])
    expect(await db.select().from(externalIds).where(eq(externalIds.entityType, 'artist'))).toMatchObject([{ entityId: matched.id }])

    await mergeArtist(local.id, matched.id)
    expect(await snapshot()).toEqual(after)
  })

  it('runs inside a caller’s transaction and rolls back with it', async () => {
    const local = await createArtist({ name: 'Lune Park' })
    const matched = await createArtist({ name: 'Lune Park', mbid: newId() })
    await expect(db.transaction(async (tx) => {
      await mergeArtist(local.id, matched.id, tx)
      throw new Error('abort')
    })).rejects.toThrow('abort')
    expect((await db.select().from(artists).where(eq(artists.id, local.id)))[0]!.mergedIntoId).toBeNull()
  })
})
