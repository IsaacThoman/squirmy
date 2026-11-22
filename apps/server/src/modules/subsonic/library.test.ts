/**
 * Decision 41: Subsonic lists the user's library, restricted to tracks with a present file.
 * Files a provider delivered for playing are cache and stay out of every list; a saved album
 * or track brings its cached files in for the user who saved it.
 */
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { libraryItems } from '../../database/schema.js'
import { startJobs } from '../../jobs/index.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist, createLibraryRoot, createUser } from '../../test/factories.js'
import { subsonicClient, type SubsonicClient } from '../../test/subsonic-client.js'
import { createAppPassword } from '../auth/service.js'
import { likeEntity } from '../userdata/likes.js'
import { addPlaylistItems, createPlaylist } from '../userdata/playlists.js'

describe('subsonic library', () => {
  useTestDatabase()
  let app: FastifyInstance
  let mira: { id: string; client: SubsonicClient }
  let lune: { id: string; client: SubsonicClient }
  let rootId: string
  let sampled: Awaited<ReturnType<typeof createAlbum>>
  let kept: Awaited<ReturnType<typeof createAlbum>>
  let single: Awaited<ReturnType<typeof createAlbum>>

  async function person(username: string) {
    const row = await createUser({ username })
    const { secret } = await createAppPassword(row.id, 'Subsonic')
    return { id: row.id, client: subsonicClient(app, { username, secret: secret! }) }
  }

  const albumIds = async (who: typeof mira, type = 'alphabeticalByName') =>
    ((await who.client.json('getAlbumList2', { type, size: 500 })).albumList2.album ?? []).map((album: { id: string }) => album.id)
  const artistNames = async (who: typeof mira) =>
    ((await who.client.json('getArtists')).artists.index ?? []).flatMap((index: { artist: { name: string }[] }) => index.artist.map((artist) => artist.name))
  /** Every song of an empty search3, as sync clients page through it. */
  const syncedSongs = async (who: typeof mira) =>
    ((await who.client.json('search3', { query: '', songCount: 500, albumCount: 0, artistCount: 0 })).searchResult3.song ?? [])
      .map((song: { id: string }) => song.id)
  const randomSongs = async (who: typeof mira) =>
    ((await who.client.json('getRandomSongs', { size: 500 })).randomSongs.song ?? []).map((song: { id: string }) => song.id).sort()
  const songId = (album: typeof sampled, index: number) => `tr-${album.tracks[index]!.recordingId}`
  const albumId = (album: typeof sampled) => `al-${album.albumId}`

  beforeAll(async () => {
    await startJobs({ work: false })
    app = await buildApp()
    mira = await person('mira')
    lune = await person('lune')
    rootId = (await createLibraryRoot({ name: 'Music' })).id
    // Everything played once and fetched for it: cache, in nobody's library.
    sampled = await createAlbum({
      title: 'Sampled', artist: await createArtist({ name: 'Fetched Band' }), owned: true, rootId, source: 'provider:deezer',
      tracks: [{ title: 'Heard Once' }, { title: 'Heard Twice' }],
    })
    kept = await createAlbum({
      title: 'Kept Album', artist: await createArtist({ name: 'Saved Band' }), owned: [0, 1], rootId, source: 'provider:deezer',
      tracks: [{ title: 'First Kept' }, { title: 'Second Kept' }, { title: 'Not Fetched Yet' }],
    })
    single = await createAlbum({
      title: 'Single Album', artist: await createArtist({ name: 'Single Band' }), owned: [0, 1], rootId, source: 'provider:deezer',
      tracks: [{ title: 'The Saved Song' }, { title: 'Its Neighbor' }],
    })
  })
  afterAll(async () => {
    await app.close()
  })

  it('lists nothing while the server holds only cached files', async () => {
    for (const type of ['alphabeticalByName', 'newest', 'random', 'alphabeticalByArtist']) expect(await albumIds(mira, type)).toEqual([])
    expect(await artistNames(mira)).toEqual([])
    expect((await mira.client.json('getIndexes')).indexes.index ?? []).toEqual([])
    expect((await mira.client.json('getGenres')).genres.genre ?? []).toEqual([])
    expect(await syncedSongs(mira)).toEqual([])
    const sync = (await mira.client.json('search3', { query: '' })).searchResult3
    expect([sync.artist ?? [], sync.album ?? [], sync.song ?? []]).toEqual([[], [], []])
    // A query finds nothing either, though the native library search ranks cached files.
    const found = (await mira.client.json('search3', { query: 'heard' })).searchResult3
    expect([found.artist ?? [], found.album ?? [], found.song ?? []]).toEqual([[], [], []])
    expect(await randomSongs(mira)).toEqual([])
    expect(await mira.client.error('getAlbum', { id: albumId(sampled) })).toBe(70)
  })

  it('still finds a cached song by id, and stars and playlists that name one', async () => {
    expect((await mira.client.json('getSong', { id: songId(sampled, 0) })).song).toMatchObject({ id: songId(sampled, 0), title: 'Heard Once' })

    await likeEntity(mira.id, 'track', sampled.tracks[0]!.recordingId)
    await likeEntity(mira.id, 'album', sampled.albumId)
    const starred = (await mira.client.json('getStarred2')).starred2
    expect((starred.song ?? []).map((song: { id: string }) => song.id)).toEqual([songId(sampled, 0)])
    // The album is not in her library, so it is not listed as one.
    expect(starred.album ?? []).toEqual([])

    const playlist = await createPlaylist(mira.id, { name: 'Picked' })
    await addPlaylistItems(mira.id, playlist.id, [{ trackId: sampled.tracks[1]!.recordingId }])
    const listed = (await mira.client.json('getPlaylist', { id: `pl-${playlist.id}` })).playlist
    expect(listed.songCount).toBe(1)
    expect(listed.entry.map((song: { id: string }) => song.id)).toEqual([songId(sampled, 1)])
  })

  it("lists a saved album's present tracks for the user who saved it only", async () => {
    await db.insert(libraryItems).values({ userId: mira.id, entityType: 'album', entityId: kept.albumId })
    expect(await albumIds(mira)).toEqual([albumId(kept)])
    expect(await albumIds(mira, 'newest')).toEqual([albumId(kept)])
    expect(await artistNames(mira)).toEqual(['Saved Band'])
    const album = (await mira.client.json('getAlbum', { id: albumId(kept) })).album
    expect(album.songCount).toBe(2)
    expect(album.song.map((song: { id: string }) => song.id)).toEqual([songId(kept, 0), songId(kept, 1)])
    expect(await syncedSongs(mira)).toEqual([songId(kept, 0), songId(kept, 1)].sort())
    expect(await randomSongs(mira)).toEqual([songId(kept, 0), songId(kept, 1)].sort())
    expect((await mira.client.json('search3', { query: 'kept' })).searchResult3.album.map((one: { id: string }) => one.id)).toEqual([albumId(kept)])

    // Lune did not save it.
    expect(await albumIds(lune)).toEqual([])
    expect(await artistNames(lune)).toEqual([])
    expect(await syncedSongs(lune)).toEqual([])
    expect(await randomSongs(lune)).toEqual([])
    expect(await lune.client.error('getAlbum', { id: albumId(kept) })).toBe(70)
  })

  it('lists a saved song without its album', async () => {
    await db.insert(libraryItems).values({ userId: lune.id, entityType: 'recording', entityId: single.tracks[0]!.recordingId })
    expect(await syncedSongs(lune)).toEqual([songId(single, 0)])
    expect(await randomSongs(lune)).toEqual([songId(single, 0)])
    expect((await lune.client.json('search3', { query: 'saved song' })).searchResult3.song.map((one: { id: string }) => one.id)).toEqual([songId(single, 0)])
    // Saving one song does not put its album in the library, as in Squirmy's own apps.
    expect(await albumIds(lune)).toEqual([])
  })

  it('lists the collection for everyone', async () => {
    const scanned = await createAlbum({ title: 'On Disk', artist: await createArtist({ name: 'Scanned Band' }), owned: true, rootId, tracks: [{ title: 'From The Scan' }] })
    expect(await albumIds(lune)).toEqual([albumId(scanned)])
    expect(await albumIds(mira)).toEqual([albumId(kept), albumId(scanned)])
    expect(await artistNames(lune)).toEqual(['Scanned Band'])
    expect(await syncedSongs(lune)).toEqual([songId(scanned, 0), songId(single, 0)].sort())
  })
})
