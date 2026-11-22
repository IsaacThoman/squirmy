import { AlbumSummary, ArtistSummary, TrackSummary } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albums, artists, likes, lyrics, mediaFiles, recordingArtists, recordings } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { createAsset } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist, createUser } from '../../test/factories.js'
import { albumSummaries, artistSummaries, trackSummaries } from './summaries.js'

describe('summaries', () => {
  useTestDatabase()

  it('builds track summaries in input order with album context, likes and lyrics', async () => {
    const user = await createUser()
    const artist = await createArtist({ name: 'Mira Vale' })
    const guest = await createArtist({ name: 'Lune Park' })
    const original = await createAlbum({ artist, title: 'First Light', owned: true, tracks: [{ title: 'Dawn' }, { title: 'Noon', disc: 2 }] })
    const cover = await createAsset()
    await db.update(albums).set({ artworkAssetId: cover.id }).where(eq(albums.id, original.albumId))
    const [dawn, noon] = original.tracks
    await db.insert(recordingArtists).values({ recordingId: dawn!.recordingId, position: 1, artistId: guest.id, creditedName: 'Lune Park', joinPhrase: '' })
    await db.insert(likes).values({ userId: user.id, entityType: 'recording', entityId: noon!.recordingId })
    await db.insert(lyrics).values({ recordingId: dawn!.recordingId, plain: 'la la', source: 'embedded' })

    // The same recording on a compilation the user does not own.
    const compilation = await createAlbum({ title: 'Best Of', tracks: [{ title: 'Other' }, { title: 'Dawn' }] })
    const compilationTrack = compilation.tracks[1]!.recordingId
    const unknown = newId()

    const result = await trackSummaries(user.id, [
      { id: noon!.recordingId },
      { id: unknown },
      { id: dawn!.recordingId },
      { id: dawn!.recordingId, albumId: compilation.albumId },
      { id: compilationTrack },
    ])
    for (const track of result) TrackSummary.parse(track)
    expect(result.map((track) => track.title)).toEqual(['Noon', 'Dawn', 'Dawn', 'Dawn'])

    const [noonSummary, dawnSummary, dawnInCompilation, unowned] = result
    expect(noonSummary).toMatchObject({ liked: true, hasLyrics: false, disc: 2, position: 1, availability: 'server' })
    expect(noonSummary!.album).toEqual({ id: original.albumId, title: 'First Light', artwork: { id: cover.id, color: '#112233', thumbhash: 'AAAA' } })
    expect(dawnSummary).toMatchObject({ liked: false, hasLyrics: true, disc: 1, position: 1, durationMs: dawn!.durationMs })
    expect(dawnSummary!.artists).toEqual([{ id: artist.id, name: 'Mira Vale' }, { id: guest.id, name: 'Lune Park' }])
    // An explicit album context wins even when the album itself is not owned.
    expect(dawnInCompilation!.album?.id).toBe(compilation.albumId)
    // Without a context or an owned file, the first release track decides.
    expect(unowned).toMatchObject({ availability: 'none', album: { id: compilation.albumId, artwork: null }, position: 2 })
  })

  it('prefers the album of an owned file over the first release track', async () => {
    const user = await createUser()
    const first = await createAlbum({ tracks: [{ title: 'Echo' }] })
    const owned = await createAlbum({ tracks: [{ title: 'Other' }], owned: true })
    // Link the owned album's file to the recording of the earlier, unowned album.
    await db.update(mediaFiles).set({ recordingId: first.tracks[0]!.recordingId }).where(eq(mediaFiles.id, owned.tracks[0]!.fileId!))
    const [summary] = await trackSummaries(user.id, [{ id: first.tracks[0]!.recordingId }])
    expect(summary).toMatchObject({ album: { id: owned.albumId }, availability: 'server', disc: null, position: null })
  })

  it('follows merge redirects for tracks, album contexts, albums and artists', async () => {
    const user = await createUser()
    const winner = await createAlbum({ owned: true })
    const loser = await createAlbum()
    const loserArtist = await createArtist()
    await db.update(recordings).set({ mergedIntoId: winner.tracks[0]!.recordingId }).where(eq(recordings.id, loser.tracks[0]!.recordingId))
    await db.update(albums).set({ mergedIntoId: winner.albumId }).where(eq(albums.id, loser.albumId))
    await db.update(artists).set({ mergedIntoId: winner.artist.id }).where(eq(artists.id, loserArtist.id))

    const [track] = await trackSummaries(user.id, [{ id: loser.tracks[0]!.recordingId, albumId: loser.albumId }])
    expect(track).toMatchObject({ id: winner.tracks[0]!.recordingId, album: { id: winner.albumId }, availability: 'server' })
    expect((await albumSummaries([loser.albumId])).map((album) => album.id)).toEqual([winner.albumId])
    expect((await artistSummaries([loserArtist.id])).map((artist) => artist.id)).toEqual([winner.artist.id])
  })

  it('shows a catalog stub in the album its hint was merged into', async () => {
    const user = await createUser()
    const winner = await createAlbum({ title: 'Kept' })
    const loser = await createAlbum({ title: 'Stub' })
    await db.update(albums).set({ mergedIntoId: winner.albumId }).where(eq(albums.id, loser.albumId))
    const stub = newId()
    await db.insert(recordings).values({ id: stub, title: 'Lone', artistCredit: 'x', titleKey: 'lone', matchKey: 'x|lone', albumHintId: loser.albumId })
    const [summary] = await trackSummaries(user.id, [{ id: stub }])
    expect(summary!.album).toMatchObject({ id: winner.albumId, title: 'Kept' })
  })

  it('summarizes albums and artists with availability and library membership', async () => {
    const owner = await createArtist({ name: 'Owned Artist' })
    const stranger = await createArtist({ name: 'Catalog Artist' })
    const partial = await createAlbum({ artist: owner, owned: [1], type: 'ep', year: 2019 })
    const none = await createAlbum({ artist: stranger, type: 'mixtape' })

    const result = await albumSummaries([none.albumId, partial.albumId, newId(), none.albumId])
    for (const album of result) AlbumSummary.parse(album)
    expect(result.map((album) => [album.id, album.availability, album.ownedTrackCount, album.type])).toEqual([
      [none.albumId, 'none', 0, 'other'],
      [partial.albumId, 'partial', 1, 'ep'],
      [none.albumId, 'none', 0, 'other'],
    ])
    expect(result[1]).toMatchObject({ year: 2019, trackCount: 3, artists: [{ id: owner.id, name: 'Owned Artist' }] })

    const artistList = await artistSummaries([stranger.id, owner.id])
    for (const artist of artistList) ArtistSummary.parse(artist)
    expect(artistList.map((artist) => [artist.name, artist.inLibrary])).toEqual([['Catalog Artist', false], ['Owned Artist', true]])
  })

  it('returns nothing for nothing', async () => {
    const user = await createUser()
    expect(await trackSummaries(user.id, [])).toEqual([])
    expect(await trackSummaries(user.id, [{ id: newId() }])).toEqual([])
    expect(await albumSummaries([])).toEqual([])
    expect(await artistSummaries([newId()])).toEqual([])
  })
})
