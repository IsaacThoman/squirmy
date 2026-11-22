/**
 * Conformance tests through `app.inject`: every call is made in JSON and in XML, and the
 * two must carry the same structure (src/test/subsonic-client.ts). Rows come from the factories; the
 * audio tests with real files are in media.test.ts.
 */
import { eq } from 'drizzle-orm'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { db } from '../../database/client.js'
import { albums, appPasswords, mediaFiles, plays, recordings, releaseLoudness, users } from '../../database/schema.js'
import { startJobs } from '../../jobs/index.js'
import { createAsset } from '../../test/catalog.js'
import { useTestDatabase } from '../../test/database.js'
import { createAlbum, createArtist, createLibraryRoot, createUser } from '../../test/factories.js'
import { createAppPassword } from '../auth/service.js'
import { listHistory } from '../userdata/history.js'
import { likeEntity, listLikes } from '../userdata/likes.js'
import { addPlaylistItems, createPlaylist, getPlaylist } from '../userdata/playlists.js'
import { similarArtists } from '../radio/index.js'
import { getSnapshot } from '../sessions/index.js'
import { resetAuthFailures } from './auth.js'
import { folderId } from './ids.js'
import { extensions } from './handlers/system.js'
import { methodNames } from './endpoints.js'
import { subsonicClient, tokenAuth, type SubsonicClient } from '../../test/subsonic-client.js'

// Similar artists come from Deezer and ListenBrainz, which tests never reach.
vi.mock('../radio/index.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../radio/index.js')>(),
  similarArtists: vi.fn(async () => []),
}))

describe('subsonic', () => {
  useTestDatabase()
  let app: FastifyInstance
  let mira: { id: string; username: string; secret: string; client: SubsonicClient }
  let lune: { id: string; username: string; secret: string; client: SubsonicClient }
  let rootId: string
  let blueHour: Awaited<ReturnType<typeof createAlbum>>
  let kites: Awaited<ReturnType<typeof createAlbum>>
  let gray: Awaited<ReturnType<typeof createAlbum>>
  let coverId: string

  async function person(username: string, role: 'admin' | 'member' = 'member') {
    const row = await createUser({ username, role })
    const { secret } = await createAppPassword(row.id, 'Subsonic')
    return { id: row.id, username, secret: secret!, client: subsonicClient(app, { username, secret: secret! }) }
  }

  beforeAll(async () => {
    await startJobs({ work: false })
    app = await buildApp()
    mira = await person('mira', 'admin')
    lune = await person('lune')
    rootId = (await createLibraryRoot({ name: 'Music' })).id
    const vale = await createArtist({ name: 'Mira Vale', mbid: '6f7a3c34-1f1c-4c1b-9b8e-0c7a1d2e3f40' })
    blueHour = await createAlbum({
      title: 'Blue Hour', artist: vale, year: 2021, owned: true, rootId, mbid: '1a2b3c4d-0000-4000-8000-000000000001',
      tracks: [{ title: 'Night Swimming', mbid: '1a2b3c4d-0000-4000-8000-0000000000a1' }, { title: 'Glass' }, { title: 'Tidal' }],
    })
    gray = await createAlbum({ title: 'Gray Album', artist: vale, year: 2019, tracks: [{ title: 'Unowned Song' }] })
    const theKites = await createArtist({ name: 'The Kites' })
    kites = await createAlbum({ title: 'Paper Sky', artist: theKites, year: 1999, owned: [0, 2], rootId, tracks: [{ title: 'Updraft' }, { title: 'Missing Piece' }, { title: 'Landing' }] })
    await createAlbum({ title: 'Nobody Owns This', tracks: [{ title: 'Ghost' }] })
    coverId = (await createAsset()).id
    await db.update(albums).set({ genres: ['Dream Pop', 'Ambient'], artworkAssetId: coverId }).where(eq(albums.id, blueHour.albumId))
    await db.update(albums).set({ genres: ['Rock'] }).where(eq(albums.id, kites.albumId))
    await db.update(recordings).set({ isrcs: ['USX9P2100001'], explicit: false }).where(eq(recordings.id, blueHour.tracks[0]!.recordingId))
    await db.update(mediaFiles).set({ loudnessLufs: -21, truePeakDb: -6 }).where(eq(mediaFiles.id, blueHour.tracks[0]!.fileId!))
    await db.insert(releaseLoudness).values({ releaseId: blueHour.releaseId, loudnessLufs: -20, truePeakDb: -3, fileCount: 3 })
  })
  beforeEach(() => resetAuthFailures())
  afterAll(async () => {
    await app.close()
  })

  const song = (album: Awaited<ReturnType<typeof createAlbum>>, index: number) => `tr-${album.tracks[index]!.recordingId}`

  describe('protocol', () => {
    it('answers GET and form POST, with and without .view, in XML, JSON and JSONP', async () => {
      for (const method of ['GET', 'POST'] as const) {
        for (const view of [false, true]) {
          const body = await mira.client.call('ping', {}, { method, view })
          expect(body).toEqual({ status: 'ok', version: '1.16.1', type: 'squirmy', serverVersion: expect.any(String), openSubsonic: true })
        }
      }
      const xml = await mira.client.raw('ping')
      expect(xml.headers['content-type']).toBe('text/xml; charset=utf-8')
      expect(xml.body).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<subsonic-response xmlns="http:\/\/subsonic.org\/restapi" status="ok" version="1.16.1" type="squirmy" serverVersion="[^"]+" openSubsonic="true"\/>$/)
      const jsonp = await mira.client.raw('ping', { callback: 'handle' }, { format: 'jsonp' })
      expect(jsonp.headers['content-type']).toMatch(/^application\/javascript/)
      expect(jsonp.body).toMatch(/^handle\(\{"subsonic-response":\{"status":"ok".*\}\);$/)
      const noCallback = await mira.client.raw('ping', {}, { format: 'jsonp' })
      expect(noCallback.json()['subsonic-response'].error.code).toBe(10)
    })

    it('reads repeated parameters from the query and the form body together', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/rest/star.view?${new URLSearchParams({ ...tokenAuth(mira), v: '1.16.1', c: 'test', f: 'json', id: song(blueHour, 1) })}`,
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams([['id', song(blueHour, 2)], ['albumId', `al-${blueHour.albumId}`]]).toString(),
      })
      expect(response.json()['subsonic-response'].status).toBe('ok')
      const liked = await listLikes(mira.id, 'track', { limit: 10 })
      expect(liked.items.map((track) => track.id).sort()).toEqual([blueHour.tracks[1]!.recordingId, blueHour.tracks[2]!.recordingId].sort())
      expect((await listLikes(mira.id, 'album', { limit: 10 })).items.map((album) => album.id)).toEqual([blueHour.albumId])
      await mira.client.call('unstar', { id: [song(blueHour, 1), song(blueHour, 2)], albumId: `al-${blueHour.albumId}` })
      expect((await listLikes(mira.id, 'track', { limit: 10 })).items).toEqual([])
    })

    it('answers unknown methods with a Subsonic error, not a bare 404', async () => {
      expect(await mira.client.error('getVideoNonsense')).toBe(0)
      const response = await mira.client.raw('nope/deeper', {}, { format: 'json' })
      expect(response.statusCode).toBe(200)
      expect(response.json()['subsonic-response']).toMatchObject({ status: 'failed', error: { code: 0 } })
    })

    it('allows browser clients on other origins', async () => {
      const preflight = await app.inject({ method: 'OPTIONS', url: '/rest/ping.view', headers: { origin: 'https://client.example', 'access-control-request-method': 'POST' } })
      expect(preflight.statusCode).toBe(204)
      expect(preflight.headers['access-control-allow-origin']).toBe('*')
      expect((await mira.client.raw('ping')).headers['access-control-allow-origin']).toBe('*')
    })

    it('lists exactly the extensions it implements, without credentials', async () => {
      const response = await app.inject({ url: '/rest/getOpenSubsonicExtensions?f=json' })
      expect(response.json()['subsonic-response'].openSubsonicExtensions).toEqual(extensions)
      const body = await mira.client.call('getOpenSubsonicExtensions')
      expect(body.openSubsonicExtensions.map((extension: { name: string }) => extension.name)).toEqual([
        'apiKeyAuthentication', 'formPost', 'indexBasedQueue', 'songLyrics', 'topSongsByArtistId', 'transcodeOffset',
      ])
      // The endpoints each extension needs exist.
      for (const name of ['tokenInfo', 'getPlayQueueByIndex', 'savePlayQueueByIndex', 'getLyricsBySongId']) expect(methodNames).toContain(name)
    })
  })

  describe('authentication', () => {
    const ping = (auth: Record<string, string>) => mira.client.call('ping', {}, { auth, status: undefined })
    const code = async (auth: Record<string, string>) => (await mira.client.json('ping', {}, { auth })).error?.code

    it('accepts an app password as a token, in clear, hex-encoded, or as an API key', async () => {
      expect((await ping(tokenAuth(mira))).status).toBe('ok')
      expect((await ping({ u: 'MIRA', p: mira.secret })).status).toBe('ok')
      expect((await ping({ u: 'mira', p: `enc:${Buffer.from(mira.secret).toString('hex')}` })).status).toBe('ok')
      expect((await ping({ apiKey: mira.secret })).status).toBe('ok')
      expect((await mira.client.call('tokenInfo', {}, { auth: { apiKey: mira.secret } })).tokenInfo).toEqual({ username: 'mira' })
    })

    it('refuses wrong, missing and conflicting credentials with the specified codes', async () => {
      expect(await code({ u: 'mira', p: 'the account password' })).toBe(40)
      expect(await code({ u: 'mira', p: lune.secret })).toBe(40)
      expect(await code(tokenAuth({ username: 'mira', secret: 'wrong' }))).toBe(40)
      expect(await code({ u: 'nobody', p: mira.secret })).toBe(40)
      expect(await code({})).toBe(10)
      expect(await code({ u: 'mira' })).toBe(10)
      expect(await code({ u: 'mira', t: 'abc' })).toBe(10)
      expect(await code({ ...tokenAuth(mira), p: mira.secret })).toBe(43)
      expect(await code({ apiKey: mira.secret, u: 'mira' })).toBe(43)
      expect(await code({ apiKey: 'not-a-key' })).toBe(44)
      expect(await code({ apiKey: '' })).toBe(44)
    })

    it('refuses disabled users and revoked app passwords', async () => {
      const kai = await person('kai')
      expect((await kai.client.json('ping')).status).toBe('ok')
      await db.update(users).set({ disabledAt: new Date() }).where(eq(users.id, kai.id))
      expect((await kai.client.json('ping')).error.code).toBe(40)
      expect((await kai.client.json('ping', {}, { auth: { apiKey: kai.secret } })).error.code).toBe(44)
      await db.update(users).set({ disabledAt: null }).where(eq(users.id, kai.id))
      await db.delete(appPasswords).where(eq(appPasswords.userId, kai.id))
      expect((await kai.client.json('ping')).error.code).toBe(40)
    })

    it('records when an app password was last used', async () => {
      await db.update(appPasswords).set({ lastUsedAt: null }).where(eq(appPasswords.userId, lune.id))
      await lune.client.json('ping')
      const [row] = await db.select().from(appPasswords).where(eq(appPasswords.userId, lune.id))
      expect(Date.now() - row!.lastUsedAt!.getTime()).toBeLessThan(10_000)
    })

    it('limits failed attempts per IP', async () => {
      for (let attempt = 0; attempt < 10; attempt++) expect(await code({ u: 'mira', p: 'guess' })).toBe(40)
      expect(await code({ u: 'mira', p: mira.secret })).toBe(40)
      const elsewhere = await app.inject({ url: `/rest/ping?f=json&${new URLSearchParams({ u: 'mira', p: mira.secret })}`, remoteAddress: '10.9.8.7' })
      expect(elsewhere.json()['subsonic-response'].status).toBe('ok')
    })

    it('needs admin rights for admin methods and for other users', async () => {
      expect(await lune.client.error('startScan')).toBe(50)
      expect(await lune.client.error('getUser', { username: 'mira' })).toBe(50)
      expect((await lune.client.call('getUser', { username: 'lune' })).user).toMatchObject({ username: 'lune', adminRole: false, streamRole: true, folder: [folderId(rootId)] })
      expect((await mira.client.call('getUser', { username: 'lune' })).user.username).toBe('lune')
      expect((await mira.client.call('startScan')).scanStatus).toEqual({ scanning: true, count: expect.any(Number) })
    })
  })

  describe('ids and parameters', () => {
    it('reports missing parameters and ids of the wrong kind or form', async () => {
      expect(await mira.client.error('getAlbum')).toBe(10)
      expect(await mira.client.error('getAlbum', { id: 'banana' })).toBe(70)
      expect(await mira.client.error('getAlbum', { id: blueHour.albumId })).toBe(70)
      expect(await mira.client.error('getAlbum', { id: `tr-${blueHour.albumId}` })).toBe(70)
      expect(await mira.client.error('getAlbum', { id: `al-${blueHour.tracks[0]!.recordingId}` })).toBe(70)
      expect(await mira.client.error('getArtist', { id: 'ar-not-a-uuid' })).toBe(70)
      expect(await mira.client.error('getAlbumList2', { type: 'newest', size: 'ten' })).toBe(0)
      expect(await mira.client.error('getAlbumList2', { type: 'sideways' })).toBe(0)
      expect(await mira.client.error('getAlbumList2', { type: 'byYear', fromYear: 1990 })).toBe(10)
      expect(await mira.client.error('getAlbumList2', { type: 'byGenre' })).toBe(10)
      expect(await mira.client.error('getArtists', { musicFolderId: 12 })).toBe(70)
    })

    it('hides catalog-only music', async () => {
      expect(await mira.client.error('getAlbum', { id: `al-${gray.albumId}` })).toBe(70)
      expect(await mira.client.error('getSong', { id: song(gray, 0) })).toBe(70)
      expect(await mira.client.error('getSong', { id: song(kites, 1) })).toBe(70)
    })
  })

  describe('browsing', () => {
    it('lists music folders and artists by index, owned only', async () => {
      expect((await mira.client.call('getMusicFolders')).musicFolders).toEqual({ musicFolder: [{ id: folderId(rootId), name: 'Music' }] })
      const { artists } = await mira.client.call('getArtists')
      expect(artists.ignoredArticles).toBe('The A An')
      expect(artists.index).toEqual([
        { name: 'K', artist: [expect.objectContaining({ name: 'The Kites', albumCount: 1 })] },
        { name: 'M', artist: [expect.objectContaining({ name: 'Mira Vale', albumCount: 1, musicBrainzId: '6f7a3c34-1f1c-4c1b-9b8e-0c7a1d2e3f40' })] },
      ])
      expect((await mira.client.call('getArtists', { musicFolderId: folderId(rootId) })).artists.index).toHaveLength(2)

      const { indexes } = await mira.client.call('getIndexes')
      expect(indexes.lastModified).toBeGreaterThan(0)
      expect(indexes.index.flatMap((index: { artist: { name: string }[] }) => index.artist.map((artist) => artist.name))).toEqual(['The Kites', 'Mira Vale'])
      expect((await mira.client.call('getIndexes', { ifModifiedSince: indexes.lastModified })).indexes.index).toBeUndefined()
    })

    it('shows an artist with its owned albums', async () => {
      const { artist } = await mira.client.call('getArtist', { id: `ar-${blueHour.artist.id}` })
      expect(artist).toMatchObject({ id: `ar-${blueHour.artist.id}`, name: 'Mira Vale', albumCount: 1 })
      expect(artist.album.map((album: { name: string }) => album.name)).toEqual(['Blue Hour'])
    })

    it('shows an album with its songs and the OpenSubsonic fields', async () => {
      const { album } = await mira.client.call('getAlbum', { id: `al-${blueHour.albumId}` })
      expect(album).toMatchObject({
        id: `al-${blueHour.albumId}`, name: 'Blue Hour', artist: 'Mira Vale', artistId: `ar-${blueHour.artist.id}`,
        coverArt: `ca-${coverId}`, songCount: 3, duration: 543, playCount: 0, year: 2021, genre: 'Dream Pop',
        musicBrainzId: '1a2b3c4d-0000-4000-8000-000000000001', genres: [{ name: 'Dream Pop' }, { name: 'Ambient' }],
        artists: [{ id: `ar-${blueHour.artist.id}`, name: 'Mira Vale' }], displayArtist: 'Mira Vale',
        releaseTypes: ['Album'], originalReleaseDate: { year: 2021 }, isCompilation: false,
      })
      expect(album.created).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/)
      expect(album.song.map((entry: { title: string }) => entry.title)).toEqual(['Night Swimming', 'Glass', 'Tidal'])
      expect(album.song[0]).toEqual({
        id: song(blueHour, 0), parent: `al-${blueHour.albumId}`, isDir: false, title: 'Night Swimming', album: 'Blue Hour',
        artist: 'Mira Vale', track: 1, year: 2021, genre: 'Dream Pop', coverArt: `ca-${coverId}`, size: 1_000_000,
        contentType: 'audio/flac', suffix: 'flac', duration: 180, bitRate: 900, bitDepth: 16, samplingRate: 44_100, channelCount: 2,
        path: 'Mira Vale/Blue Hour/01 Night Swimming.flac', isVideo: false, playCount: 0, discNumber: 1, created: expect.any(String),
        albumId: `al-${blueHour.albumId}`, artistId: `ar-${blueHour.artist.id}`, type: 'music', mediaType: 'song',
        musicBrainzId: '1a2b3c4d-0000-4000-8000-0000000000a1', isrc: ['USX9P2100001'],
        genres: [{ name: 'Dream Pop' }, { name: 'Ambient' }], artists: [{ id: `ar-${blueHour.artist.id}`, name: 'Mira Vale' }],
        displayArtist: 'Mira Vale', albumArtists: [{ id: `ar-${blueHour.artist.id}`, name: 'Mira Vale' }], displayAlbumArtist: 'Mira Vale',
        replayGain: { trackGain: 3, albumGain: 2, trackPeak: 0.501187, albumPeak: 0.707946 }, explicitStatus: 'clean',
      })
      // replayGain is always present, empty when nothing is known.
      expect(album.song[1].replayGain).toEqual({ albumGain: 2, albumPeak: 0.707946 })
      expect(partialGain(await mira.client.call('getSong', { id: song(kites, 0) }))).toEqual({})
      const partial = await mira.client.call('getAlbum', { id: `al-${kites.albumId}` })
      expect(partial.album.song.map((entry: { title: string }) => entry.title)).toEqual(['Updraft', 'Landing'])
      expect(partial.album.songCount).toBe(2)
    })

    it('browses by folder: artist, then album, then songs', async () => {
      const { indexes } = await mira.client.call('getIndexes')
      const vale = indexes.index.find((index: { name: string }) => index.name === 'M').artist[0]
      const artistDirectory = (await mira.client.call('getMusicDirectory', { id: vale.id })).directory
      expect(artistDirectory).toMatchObject({ id: vale.id, name: 'Mira Vale', child: [expect.objectContaining({ id: `al-${blueHour.albumId}`, isDir: true, title: 'Blue Hour', parent: vale.id })] })
      const albumDirectory = (await mira.client.call('getMusicDirectory', { id: artistDirectory.child[0].id })).directory
      expect(albumDirectory).toMatchObject({ id: `al-${blueHour.albumId}`, parent: vale.id, name: 'Blue Hour' })
      expect(albumDirectory.child.map((child: { isDir: boolean; parent: string }) => [child.isDir, child.parent])).toEqual(Array(3).fill([false, `al-${blueHour.albumId}`]))
      expect(await mira.client.error('getMusicDirectory', { id: song(blueHour, 0) })).toBe(70)
    })

    it('counts genres, and describes artists and albums', async () => {
      expect((await mira.client.call('getGenres')).genres.genre).toEqual([
        { value: 'Ambient', songCount: 3, albumCount: 1 },
        { value: 'Dream Pop', songCount: 3, albumCount: 1 },
        { value: 'Rock', songCount: 2, albumCount: 1 },
      ])
      const info = await mira.client.call('getArtistInfo2', { id: `ar-${blueHour.artist.id}` })
      expect(info.artistInfo2).toEqual({ musicBrainzId: '6f7a3c34-1f1c-4c1b-9b8e-0c7a1d2e3f40', similarArtist: [] })
      expect((await mira.client.call('getArtistInfo', { id: song(blueHour, 0) })).artistInfo.musicBrainzId).toBe('6f7a3c34-1f1c-4c1b-9b8e-0c7a1d2e3f40')
      const albumInfo = (await mira.client.call('getAlbumInfo2', { id: `al-${blueHour.albumId}` })).albumInfo
      expect(albumInfo).toEqual({
        musicBrainzId: '1a2b3c4d-0000-4000-8000-000000000001',
        smallImageUrl: `http://localhost:80/api/v1/art/${coverId}/300`,
        mediumImageUrl: `http://localhost:80/api/v1/art/${coverId}/600`,
        largeImageUrl: `http://localhost:80/api/v1/art/${coverId}/1200`,
      })
    })

    it('lists similar artists from the radio module, library artists only', async () => {
      const nobody = await createArtist({ name: 'Not In Library' })
      vi.mocked(similarArtists).mockResolvedValueOnce([
        { artistId: nobody.id, name: nobody.name, score: 0.9 },
        { artistId: kites.artist.id, name: 'The Kites', score: 0.5 },
      ])
      const info = (await mira.client.json('getArtistInfo2', { id: `ar-${blueHour.artist.id}`, includeNotPresent: 'true' })).artistInfo2
      expect(info.similarArtist).toEqual([expect.objectContaining({ id: `ar-${kites.artist.id}`, name: 'The Kites', albumCount: 1 })])
      expect(vi.mocked(similarArtists)).toHaveBeenCalledWith(blueHour.artist.id, { limit: 40 })
    })

    it('finds top and similar songs among owned tracks', async () => {
      const byName = (await mira.client.call('getTopSongs', { artist: 'mira vale', count: 2 })).topSongs.song
      expect(byName).toHaveLength(2)
      const byId = (await mira.client.call('getTopSongs', { id: `ar-${kites.artist.id}` })).topSongs.song
      expect(byId.map((entry: { title: string }) => entry.title).sort()).toEqual(['Landing', 'Updraft'])
      expect((await mira.client.call('getTopSongs', { artist: 'Nobody At All' })).topSongs).toEqual({ song: [] })
      // The radio module suggests; every suggestion is a song the server can play.
      const owned = new Set([...blueHour.tracks, kites.tracks[0]!, kites.tracks[2]!].map((track) => `tr-${track.recordingId}`))
      const similar = (await mira.client.call('getSimilarSongs2', { id: `ar-${kites.artist.id}` }, { varies: true })).similarSongs2.song
      expect(similar.length).toBeGreaterThan(0)
      for (const entry of similar) expect(owned.has(entry.id)).toBe(true)
      const bySong = (await mira.client.call('getSimilarSongs', { id: song(kites, 0), count: 50 }, { varies: true })).similarSongs.song
      expect(bySong.length).toBeGreaterThan(0)
      expect(bySong.map((entry: { id: string }) => entry.id)).not.toContain(song(kites, 0))
      for (const entry of bySong) expect(owned.has(entry.id)).toBe(true)
    })
  })

  describe('lists', () => {
    let many: Awaited<ReturnType<typeof createAlbum>>[]
    beforeAll(async () => {
      const artist = await createArtist({ name: 'Paging Band' })
      many = []
      for (let index = 0; index < 12; index++) {
        many.push(await createAlbum({ title: `Page ${String(index).padStart(2, '0')}`, artist, year: 2000 + index, owned: true, rootId, tracks: [{ title: `Song ${index}` }] }))
      }
    })

    const names = (body: Record<string, any>, key = 'albumList2') => (body[key].album ?? []).map((album: { name?: string; title?: string }) => album.name ?? album.title)

    it('pages through albums alphabetically by name and by artist', async () => {
      const first = names(await mira.client.call('getAlbumList2', { type: 'alphabeticalByName', size: 5 }))
      const second = names(await mira.client.call('getAlbumList2', { type: 'alphabeticalByName', size: 5, offset: 5 }))
      const rest = names(await mira.client.call('getAlbumList2', { type: 'alphabeticalByName', size: 500, offset: 10 }))
      expect([...first, ...second, ...rest]).toEqual(['Blue Hour', ...many.map((album) => album.title), 'Paper Sky'])
      expect(names(await mira.client.call('getAlbumList2', { type: 'alphabeticalByArtist', size: 3 }))).toEqual(['Paper Sky', 'Blue Hour', 'Page 00'])
      // getAlbumList returns the same albums as folders.
      const legacy = await mira.client.call('getAlbumList', { type: 'alphabeticalByName', size: 2 }, { view: true })
      expect(legacy.albumList.album).toEqual([
        expect.objectContaining({ id: `al-${blueHour.albumId}`, isDir: true, title: 'Blue Hour', parent: `ar-${blueHour.artist.id}` }),
        expect.objectContaining({ title: 'Page 00' }),
      ])
    })

    it('lists by year, genre, newest and random', async () => {
      expect(names(await mira.client.call('getAlbumList2', { type: 'byYear', fromYear: 2010, toYear: 2009 }))).toEqual(['Page 10', 'Page 09'])
      expect(names(await mira.client.call('getAlbumList2', { type: 'byYear', fromYear: 1990, toYear: 2001 }))).toEqual(['Paper Sky', 'Page 00', 'Page 01'])
      expect(names(await mira.client.call('getAlbumList2', { type: 'byGenre', genre: 'rock' }))).toEqual(['Paper Sky'])
      expect(names(await mira.client.call('getAlbumList2', { type: 'newest', size: 2 }))).toEqual(['Page 11', 'Page 10'])
      const random = names(await mira.client.call('getAlbumList2', { type: 'random', size: 500 }, { varies: true }))
      expect(random.sort()).toEqual(['Blue Hour', ...many.map((album) => album.title), 'Paper Sky'].sort())
      expect(names(await mira.client.call('getAlbumList2', { type: 'byYear', fromYear: 2000, toYear: 2030, musicFolderId: folderId(rootId), size: 1 }))).toEqual(['Page 00'])
    })

    it('lists starred, highest rated, frequently and recently played albums of the user', async () => {
      await mira.client.call('star', { albumId: [`al-${many[3]!.albumId}`, `al-${gray.albumId}`] })
      expect(names(await mira.client.call('getAlbumList2', { type: 'starred' }))).toEqual(['Page 03'])
      expect(names(await lune.client.call('getAlbumList2', { type: 'starred' }))).toEqual([])
      await mira.client.call('setRating', { id: `al-${many[5]!.albumId}`, rating: 4 })
      await mira.client.call('setRating', { id: `al-${many[6]!.albumId}`, rating: 5 })
      expect(names(await mira.client.call('getAlbumList2', { type: 'highest' }))).toEqual(['Page 06', 'Page 05'])
      const playedAt = Date.now() - 60_000
      // Plays are not idempotent, so this is one JSON call rather than the JSON and XML pair.
      await mira.client.json('scrobble', { id: [song(many[7]!, 0), song(many[8]!, 0), song(many[8]!, 0)], time: [playedAt, playedAt + 1000, playedAt + 2000] })
      expect(names(await mira.client.call('getAlbumList2', { type: 'frequent' }))).toEqual(['Page 08', 'Page 07'])
      expect(names(await mira.client.call('getAlbumList2', { type: 'recent' }))).toEqual(['Page 08', 'Page 07'])
      const [page8] = (await mira.client.call('getAlbumList2', { type: 'recent', size: 1 })).albumList2.album
      expect(page8).toMatchObject({ playCount: 2, played: new Date(playedAt + 2000).toISOString() })
    })

    it('picks random songs and songs by genre', async () => {
      const random = (await mira.client.call('getRandomSongs', { size: 500 }, { varies: true })).randomSongs.song
      expect(random).toHaveLength(3 + 2 + 12)
      expect(new Set(random.map((entry: { id: string }) => entry.id)).size).toBe(random.length)
      expect((await mira.client.call('getRandomSongs', { size: 3 }, { varies: true })).randomSongs.song).toHaveLength(3)
      const rock = (await mira.client.call('getRandomSongs', { genre: 'Rock', size: 10 }, { varies: true })).randomSongs.song
      expect(rock.map((entry: { title: string }) => entry.title).sort()).toEqual(['Landing', 'Updraft'])
      expect((await mira.client.call('getRandomSongs', { fromYear: 2011, toYear: 2015 })).randomSongs.song.map((entry: { title: string }) => entry.title)).toEqual(['Song 11'])
      const dreamPop = (await mira.client.call('getSongsByGenre', { genre: 'dream pop', count: 2, offset: 1 })).songsByGenre.song
      expect(dreamPop.map((entry: { title: string }) => entry.title)).toEqual(['Glass', 'Tidal'])
    })

    it('lists starred artists, albums and songs that are in the library', async () => {
      await likeEntity(lune.id, 'track', gray.tracks[0]!.recordingId)
      await lune.client.call('star', { id: [song(blueHour, 0), `al-${blueHour.albumId}`, `ar-${blueHour.artist.id}`] })
      await lune.client.call('star', { artistId: `ar-${gray.artist.id}` })
      const { starred2 } = await lune.client.call('getStarred2')
      expect(starred2.artist.map((artist: { name: string }) => artist.name)).toEqual(['Mira Vale'])
      expect(starred2.album.map((album: { name: string }) => album.name)).toEqual(['Blue Hour'])
      expect(starred2.song.map((entry: { title: string; starred: string }) => [entry.title, typeof entry.starred])).toEqual([['Night Swimming', 'string']])
      const { starred } = await lune.client.call('getStarred')
      expect(starred.album[0]).toMatchObject({ isDir: true, title: 'Blue Hour' })
      expect(starred.artist[0]).toMatchObject({ name: 'Mira Vale', starred: expect.any(String) })
    })
  })

  describe('search', () => {
    it('finds artists, albums and songs by every word, in the name or the artist', async () => {
      const result = (await mira.client.call('search3', { query: 'vale night' })).searchResult3
      expect(result.song.map((entry: { title: string }) => entry.title)).toEqual(['Night Swimming'])
      expect(result.artist).toEqual([])
      const kitesResult = (await mira.client.call('search3', { query: 'KITES' })).searchResult3
      expect(kitesResult.artist.map((artist: { name: string }) => artist.name)).toEqual(['The Kites'])
      expect(kitesResult.album.map((album: { name: string }) => album.name)).toEqual(['Paper Sky'])
      expect(kitesResult.song.map((entry: { title: string }) => entry.title).sort()).toEqual(['Landing', 'Updraft'])
      expect((await mira.client.call('search3', { query: 'gray' })).searchResult3).toEqual({ artist: [], album: [], song: [] })
      const legacy = (await mira.client.call('search2', { query: 'blue' })).searchResult2
      expect(legacy.album).toEqual([expect.objectContaining({ isDir: true, title: 'Blue Hour' })])
    })

    it('finds a song through a typo, ranked like the apps rank it', async () => {
      const result = (await mira.client.call('search3', { query: 'night swiming' })).searchResult3
      expect(result.song[0]).toMatchObject({ title: 'Night Swimming' })
    })

    it('returns everything for an empty query, paged by the offsets', async () => {
      for (const query of ['', '""']) {
        const seen: string[] = []
        for (let offset = 0; ; offset += 4) {
          const page = (await mira.client.call('search3', { query, songCount: 4, songOffset: offset, artistCount: 0, albumCount: 0 })).searchResult3
          if (page.song.length === 0) break
          expect(page.artist).toEqual([])
          seen.push(...page.song.map((entry: { id: string }) => entry.id))
        }
        expect(seen).toHaveLength(3 + 2 + 12)
        expect(new Set(seen).size).toBe(seen.length)
      }
      const everything = (await mira.client.call('search3', { query: '', artistCount: 1, artistOffset: 1, albumCount: 100 })).searchResult3
      expect(everything.artist.map((artist: { name: string }) => artist.name)).toEqual(['Mira Vale'])
      expect(everything.album).toHaveLength(14)
    })
  })

  describe('annotation', () => {
    it('stars and unstars songs, albums and artists, as Squirmy likes', async () => {
      const kai = await person('kai2')
      await kai.client.call('star', { id: song(kites, 0), artistId: `ar-${kites.artist.id}` })
      expect((await listLikes(kai.id, 'track', { limit: 10 })).items.map((track) => track.id)).toEqual([kites.tracks[0]!.recordingId])
      expect((await listLikes(kai.id, 'artist', { limit: 10 })).items.map((artist) => artist.id)).toEqual([kites.artist.id])
      expect((await kai.client.call('getSong', { id: song(kites, 0) })).song.starred).toMatch(/Z$/)
      await kai.client.call('unstar', { id: [song(kites, 0), `ar-${kites.artist.id}`] })
      expect((await listLikes(kai.id, 'track', { limit: 10 })).items).toEqual([])
      expect(await kai.client.error('star')).toBe(10)
      expect(await kai.client.error('star', { id: `pl-${kites.albumId}` })).toBe(70)
      expect(await kai.client.error('star', { id: `tr-${kites.albumId}` })).toBe(70)
    })

    it('rates, and clears a rating with 0', async () => {
      await mira.client.call('setRating', { id: song(blueHour, 2), rating: 3 })
      expect((await mira.client.call('getSong', { id: song(blueHour, 2) })).song.userRating).toBe(3)
      await mira.client.call('setRating', { id: song(blueHour, 2), rating: 0 })
      expect((await mira.client.call('getSong', { id: song(blueHour, 2) })).song.userRating).toBeUndefined()
      expect(await mira.client.error('setRating', { id: song(blueHour, 2), rating: 6 })).toBe(0)
      expect(await mira.client.error('setRating', { id: song(blueHour, 2) })).toBe(10)
    })

    it('scrobbles plays at their time, and now-playing notices', async () => {
      const kai = await person('kai3')
      await kai.client.call('scrobble', { id: song(blueHour, 1), submission: false }, { method: 'POST' })
      const { nowPlaying } = await kai.client.call('getNowPlaying')
      expect(nowPlaying.entry).toEqual([expect.objectContaining({ id: song(blueHour, 1), username: 'kai3', minutesAgo: 0, playerName: 'vitest', playerId: expect.any(Number) })])
      expect(await db.select().from(plays).where(eq(plays.userId, kai.id))).toEqual([])

      const at = Date.parse('2026-03-01T12:00:00Z')
      await kai.client.json('scrobble', { id: song(blueHour, 1), time: at })
      const [play] = await db.select().from(plays).where(eq(plays.userId, kai.id))
      expect(play).toMatchObject({ recordingId: blueHour.tracks[1]!.recordingId, albumId: blueHour.albumId, client: 'subsonic', completed: true })
      expect(play!.startedAt.toISOString()).toBe('2026-03-01T12:00:00.000Z')
      expect((await listHistory(kai.id, { limit: 5 })).items.map((item) => item.track.id)).toEqual([blueHour.tracks[1]!.recordingId])
      expect((await kai.client.call('getNowPlaying')).nowPlaying).toEqual({ entry: [] })
      const { song: played } = await kai.client.call('getSong', { id: song(blueHour, 1) })
      expect(played).toMatchObject({ playCount: 1, played: '2026-03-01T12:00:00.000Z' })
      expect(await kai.client.error('scrobble', { id: song(gray, 0), time: 'yesterday' })).toBe(0)
      // Seconds mistaken for milliseconds, times 1000 again: tens of thousands of years ahead.
      expect(await kai.client.error('scrobble', { id: song(blueHour, 1), time: at * 1000 })).toBe(0)
    })
  })

  describe('playlists', () => {
    it('creates, reads, renames, edits by index and deletes, as Squirmy playlists', async () => {
      const { playlist } = await mira.client.json('createPlaylist', { name: 'Evening', songId: [song(blueHour, 0), song(kites, 0)] })
      expect(playlist).toMatchObject({ name: 'Evening', owner: 'mira', public: false, songCount: 2, duration: 360, readonly: false, coverArt: `ca-${coverId}` })
      expect(playlist.entry.map((entry: { title: string }) => entry.title)).toEqual(['Night Swimming', 'Updraft'])
      const id = playlist.id.slice(3)

      // A track the server cannot play stays in the playlist, hidden from Subsonic.
      await addPlaylistItems(mira.id, id, [{ trackId: gray.tracks[0]!.recordingId }, { trackId: blueHour.tracks[2]!.recordingId }])
      const read = (await mira.client.call('getPlaylist', { id: playlist.id })).playlist
      expect(read.entry.map((entry: { title: string }) => entry.title)).toEqual(['Night Swimming', 'Updraft', 'Tidal'])
      expect(read.songCount).toBe(3)

      await mira.client.json('updatePlaylist', {
        playlistId: playlist.id, name: 'Late Evening', comment: 'for the drive', public: true,
        songIndexToRemove: [1], songIdToAdd: [song(kites, 2)],
      }, { method: 'POST' })
      const native = await getPlaylist(mira.id, id)
      expect(native).toMatchObject({ name: 'Late Evening', description: 'for the drive', isPublic: true })
      expect(native.items.map((item) => item.track.title)).toEqual(['Night Swimming', 'Unowned Song', 'Tidal', 'Landing'])

      const listed = (await mira.client.call('getPlaylists')).playlists.playlist
      expect(listed).toEqual([expect.objectContaining({ id: playlist.id, name: 'Late Evening', comment: 'for the drive', public: true, songCount: 3 })])
      // Another user sees a public playlist read-only, and cannot change it.
      expect((await lune.client.call('getPlaylists')).playlists.playlist[0]).toMatchObject({ id: playlist.id, readonly: true })
      expect(await lune.client.error('updatePlaylist', { playlistId: playlist.id, name: 'Mine' })).toBe(50)
      expect(await lune.client.error('deletePlaylist', { id: playlist.id })).toBe(50)
      expect(await mira.client.error('updatePlaylist', { playlistId: playlist.id, songIndexToRemove: 3 })).toBe(0)

      // The overwrite form replaces the playable tracks and keeps the hidden one in place.
      const overwritten = (await mira.client.call('createPlaylist', { playlistId: playlist.id, songId: [song(kites, 2), song(blueHour, 0)] }, { varies: true })).playlist
      expect(overwritten.entry.map((entry: { title: string }) => entry.title)).toEqual(['Landing', 'Night Swimming'])
      expect((await getPlaylist(mira.id, id)).items.map((item) => item.track.title)).toEqual(['Landing', 'Unowned Song', 'Night Swimming'])

      await mira.client.json('deletePlaylist', { id: playlist.id })
      expect(await mira.client.error('getPlaylist', { id: playlist.id })).toBe(70)
    })

    it('keeps private playlists private, and lets admins list another user', async () => {
      const own = await createPlaylist(lune.id, { name: 'Secret' })
      expect(await mira.client.error('getPlaylist', { id: `pl-${own.id}` })).toBe(70)
      expect((await mira.client.call('getPlaylists', { username: 'lune' })).playlists.playlist.map((row: { name: string }) => row.name)).toEqual(['Secret'])
      expect(await lune.client.error('getPlaylists', { username: 'mira' })).toBe(50)
      expect(await lune.client.error('createPlaylist', { songId: song(blueHour, 0) })).toBe(10)
      expect(await lune.client.error('createPlaylist', { name: 'Bad', songId: `tr-${own.id}` })).toBe(70)
    })
  })

  describe('play queue', () => {
    it('saves into the Squirmy session and reads it back', async () => {
      const ids = [song(blueHour, 0), song(blueHour, 1), song(kites, 0), song(gray, 0)]
      await mira.client.call('savePlayQueue', { id: ids, current: ids[1], position: 5000 }, { method: 'POST' })
      const snapshot = await getSnapshot(mira.id)
      expect(snapshot.state.current?.trackId).toBe(blueHour.tracks[1]!.recordingId)
      expect(snapshot.state.playing).toBe(false)
      expect(snapshot.state.positionMs).toBe(5000)
      // The unplayable track is dropped by the session.
      expect(snapshot.queue.queue.map((entry) => entry.trackId)).toEqual([kites.tracks[0]!.recordingId])

      const { playQueue } = await mira.client.call('getPlayQueue')
      expect(playQueue).toMatchObject({ current: ids[1], position: 5000, username: 'mira', changedBy: 'vitest' })
      expect(playQueue.entry.map((entry: { id: string }) => entry.id)).toEqual(ids.slice(0, 3))
      const byIndex = (await mira.client.call('getPlayQueueByIndex')).playQueueByIndex
      expect(byIndex).toMatchObject({ currentIndex: 1, position: 5000 })
    })

    it('saves by index, which allows the same song twice', async () => {
      const ids = [song(kites, 0), song(blueHour, 2), song(kites, 0)]
      await mira.client.call('savePlayQueueByIndex', { id: ids, currentIndex: 2, position: 0 })
      const { playQueueByIndex } = await mira.client.call('getPlayQueueByIndex')
      expect(playQueueByIndex.currentIndex).toBe(2)
      expect(playQueueByIndex.entry.map((entry: { id: string }) => entry.id)).toEqual(ids)
      expect((await mira.client.call('getPlayQueue')).playQueue.current).toBe(ids[2])
      expect(await mira.client.error('savePlayQueueByIndex', { id: ids, currentIndex: 3 })).toBe(10)
      expect(await mira.client.error('savePlayQueueByIndex', { id: ids })).toBe(10)
      expect(await mira.client.error('savePlayQueue', { id: ids })).toBe(10)
      expect(await mira.client.error('savePlayQueue', { id: ids, current: song(blueHour, 0) })).toBe(0)
    })

    it('shows changes made in Squirmy and clears with no ids', async () => {
      await mira.client.call('savePlayQueue', { id: [song(blueHour, 0), song(blueHour, 1)], current: song(blueHour, 1) })
      // Clearing leaves the current song: a Squirmy session never drops what it is on.
      await mira.client.call('savePlayQueue')
      const { playQueue } = await mira.client.call('getPlayQueue')
      expect(playQueue.entry.map((entry: { id: string }) => entry.id)).toEqual([song(blueHour, 1)])
      expect(playQueue.changedBy).toBe('vitest')
    })
  })

  describe('every method, every way', () => {
    let playlistForCases = ''
    beforeAll(async () => {
      playlistForCases = (await createPlaylist(mira.id, { name: 'Cases' })).id
      await addPlaylistItems(mira.id, playlistForCases, [{ trackId: blueHour.tracks[0]!.recordingId }])
    })
    // Each method in GET with .view and in form POST without; `call` compares XML and JSON each time.
    const cases: [string, () => Record<string, string | number | string[]>][] = [
      ['ping', () => ({})],
      ['getLicense', () => ({})],
      ['getOpenSubsonicExtensions', () => ({})],
      ['tokenInfo', () => ({})],
      ['getUser', () => ({ username: 'mira' })],
      ['getScanStatus', () => ({})],
      ['getMusicFolders', () => ({})],
      ['getArtists', () => ({})],
      ['getIndexes', () => ({})],
      ['getArtist', () => ({ id: `ar-${blueHour.artist.id}` })],
      ['getAlbum', () => ({ id: `al-${blueHour.albumId}` })],
      ['getSong', () => ({ id: song(blueHour, 0) })],
      ['getMusicDirectory', () => ({ id: `al-${blueHour.albumId}` })],
      ['getGenres', () => ({})],
      ['getArtistInfo', () => ({ id: `ar-${blueHour.artist.id}` })],
      ['getArtistInfo2', () => ({ id: `ar-${blueHour.artist.id}` })],
      ['getAlbumInfo', () => ({ id: `al-${blueHour.albumId}` })],
      ['getAlbumInfo2', () => ({ id: `al-${blueHour.albumId}` })],
      ['getTopSongs', () => ({ artist: 'Mira Vale' })],
      ['getSimilarSongs', () => ({ id: `al-${blueHour.albumId}` })],
      ['getSimilarSongs2', () => ({ id: `ar-${blueHour.artist.id}` })],
      ['getAlbumList', () => ({ type: 'newest' })],
      ['getAlbumList2', () => ({ type: 'alphabeticalByArtist', size: 50 })],
      ['getRandomSongs', () => ({ size: 1 })],
      ['getSongsByGenre', () => ({ genre: 'Rock' })],
      ['getStarred', () => ({})],
      ['getStarred2', () => ({})],
      ['getNowPlaying', () => ({})],
      ['search2', () => ({ query: 'blue' })],
      ['search3', () => ({ query: '' })],
      ['getLyrics', () => ({ artist: 'Mira Vale', title: 'Glass' })],
      ['getLyricsBySongId', () => ({ id: song(blueHour, 0) })],
      ['star', () => ({ id: song(blueHour, 0) })],
      ['unstar', () => ({ id: song(blueHour, 0) })],
      ['setRating', () => ({ id: `al-${blueHour.albumId}`, rating: 2 })],
      ['scrobble', () => ({ id: song(blueHour, 0), submission: 'false' })],
      ['getPlaylists', () => ({})],
      ['getPlaylist', () => ({ id: `pl-${playlistForCases}` })],
      ['createPlaylist', () => ({ name: 'Every Way', songId: [song(blueHour, 0)] })],
      ['getPlayQueue', () => ({})],
      ['savePlayQueue', () => ({ id: [song(blueHour, 0)], current: song(blueHour, 0) })],
      ['getPlayQueueByIndex', () => ({})],
      ['savePlayQueueByIndex', () => ({ id: [song(blueHour, 0)], currentIndex: 0 })],
      ['getPodcasts', () => ({})],
      ['getInternetRadioStations', () => ({})],
      ['getBookmarks', () => ({})],
    ]

    it.each(cases)('%s', async (method, params) => {
      const varies = ['createPlaylist', 'getRandomSongs', 'getSimilarSongs', 'getSimilarSongs2'].includes(method)
      const viaGet = await mira.client.call(method, params(), { method: 'GET', view: true, varies })
      const viaPost = await mira.client.call(method, params(), { method: 'POST', varies })
      const strip = ({ serverVersion: _version, ...rest }: Record<string, unknown>) => rest
      if (!varies && !['getNowPlaying', 'getPlayQueue', 'getPlayQueueByIndex'].includes(method)) {
        expect(strip(viaPost)).toEqual(strip(viaGet))
      }
    })

    it('covers every method it implements', () => {
      const tested = new Set(cases.map(([name]) => name))
      const elsewhere = ['startScan', 'updatePlaylist', 'deletePlaylist', 'stream', 'download', 'getCoverArt', 'getNewestPodcasts', 'getShares']
      expect(methodNames.filter((name) => !tested.has(name) && !elsewhere.includes(name))).toEqual([])
    })
  })

  it('narrows lists to a music folder', async () => {
    const other = await createLibraryRoot({ name: 'Other' })
    const elsewhere = await createAlbum({ title: 'Elsewhere', artist: await createArtist({ name: 'Zed' }), owned: true, rootId: other.id })
    const all = await mira.client.call('getAlbumList2', { type: 'alphabeticalByName', size: 500 })
    expect(names(all)).toContain('Elsewhere')
    const music = await mira.client.call('getAlbumList2', { type: 'alphabeticalByName', size: 500, musicFolderId: folderId(rootId) })
    expect(names(music)).not.toContain('Elsewhere')
    const inOther = await mira.client.call('search3', { query: '', musicFolderId: folderId(other.id) })
    expect(inOther.searchResult3.album.map((album: { name: string }) => album.name)).toEqual(['Elsewhere'])
    expect(inOther.searchResult3.song).toHaveLength(elsewhere.tracks.length)
    expect((await mira.client.call('getMusicFolders')).musicFolders.musicFolder.map((folder: { name: string }) => folder.name)).toEqual(['Music', 'Other'])
  })

  it('lists songs the release does not number after its own, numbered after them', async () => {
    const edition = await createAlbum({ title: 'Plain Edition', artist: await createArtist({ name: 'Yarrow' }), owned: true, rootId, tracks: [{ title: 'First' }, { title: 'Second' }] })
    const bonus = await createAlbum({ owned: true, rootId, tracks: [{ title: 'Extra' }] })
    // Tagged as track 1: a number of the release's own.
    await db.update(mediaFiles).set({ albumId: edition.albumId, releaseId: edition.releaseId, releaseTrackId: null, tags: { title: 'Extra', track: 1 } })
      .where(eq(mediaFiles.id, bonus.tracks[0]!.fileId!))
    const { album } = await mira.client.call('getAlbum', { id: `al-${edition.albumId}` })
    expect(album.song.map((entry: { title: string; track: number; discNumber: number }) => [entry.title, entry.discNumber, entry.track])).toEqual([
      ['First', 1, 1], ['Second', 1, 2], ['Extra', 1, 3],
    ])
  })

  const partialGain = (body: Record<string, any>) => body.song.replayGain
  const names = (body: Record<string, any>) => (body.albumList2.album ?? []).map((album: { name: string }) => album.name)
})
