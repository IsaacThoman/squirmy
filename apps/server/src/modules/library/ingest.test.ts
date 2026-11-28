import { mkdtemp, realpath, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { and, asc, eq, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { acquisitionJobs, acquisitionProviders, albumArtists, albums, artists, imports, mediaFiles, ratings, recordingArtists, recordings } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { updateServerSettings } from '../../lib/settings.js'
import { artistDetail } from '../catalog/pages.js'
import { trackSummaries } from '../catalog/summaries.js'
import { mergeRecording } from '../matching/merge.js'
import { songs } from '../subsonic/songs.js'
import { createAlbum, createArtist, createUser } from '../../test/factories.js'
import { startJobs, stopJobs } from '../../jobs/index.js'
import { makeAlbum, makeTone } from '../../test/audio.js'
import { useTestDatabase } from '../../test/database.js'
import { ingestGroup } from './ingest.js'
import { probeFile } from './probe.js'
import { stopProgress } from './progress.js'
import { insertRoot } from './roots.js'
import { scanRoot } from './scan.js'

// Jobs are run by hand, so each test picks the order in which the two groups are ingested.
// The worker runs them concurrently and either may take the catalog lock first.
describe('ingesting a group that lost a file', () => {
  useTestDatabase()
  let library = ''
  let rootId = ''

  const filesUnder = (folder: string) => db.select().from(mediaFiles)
    .where(and(eq(mediaFiles.rootId, rootId), sql`${mediaFiles.relPath} like ${`${folder}/%`}`)).orderBy(asc(mediaFiles.relPath))
  const fileById = async (id: string) => (await db.select().from(mediaFiles).where(eq(mediaFiles.id, id)))[0]!
  const albumTitle = async (id: string) => (await db.select({ title: albums.title }).from(albums).where(eq(albums.id, id)))[0]?.title

  beforeAll(async () => {
    library = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-ingest-')))
    await startJobs({ work: false })
    rootId = (await insertRoot({ name: 'Music', path: library, mode: 'read_only', watch: false })).id
  })
  afterAll(async () => {
    await stopJobs()
    // Its debounce timers would otherwise fire after the database is gone.
    await stopProgress()
    await rm(library, { recursive: true, force: true })
  })

  it('reads tagged credits, movements and advisories, keeping the rating on the file', async () => {
    await updateServerSettings({ musicBrainzEnabled: false, deezerEnabled: false })
    const user = await createUser()
    const folder = 'Juniper Ensemble/Nocturnes'
    const [firstPath] = await makeAlbum(library, {
      artist: 'Juniper Ensemble', album: 'Nocturnes', folder,
      tags: { COMPOSER: 'Mara Finch', WORK: 'Nocturne in A minor', MOVEMENTTOTAL: 2 },
      tracks: [
        { title: 'Dusk', tags: {
          MOVEMENT: 'Andante', MOVEMENTNUMBER: 1, ITUNESADVISORY: 1, FMPS_RATING: 0.8,
          LYRICIST: 'Eli Reed', CONDUCTOR: 'Leah Reed', ARRANGER: 'Mara Finch', PRODUCER: 'Iona Reed',
          ENGINEER: 'Jules Reed', MIXER: 'Jo Reed', REMIXER: 'Jamie Reed', ORCHESTRA: 'Juniper Ensemble',
          'PERFORMER:viola da gamba': 'Nora Moss', COMMENT: 'From the chamber sessions',
        } },
        { title: 'Dawn', tags: { MOVEMENTNAME: 'Allegro', MOVEMENTNUMBER: 2, ITUNESADVISORY: 2 } },
      ],
    })
    await scanRoot({ rootId, paths: [folder] })
    for (const file of await filesUnder(folder)) await probeFile({ fileId: file.id })
    const groupKey = (await filesUnder(folder))[0]!.groupKey!
    await ingestGroup({ rootId, groupKey })
    const [first, second] = await filesUnder(folder)
    const refs = [first!, second!].map((file) => ({ id: file.recordingId! }))
    const [dusk, dawn] = await trackSummaries(user.id, refs)
    expect(dusk!.credits?.map(({ role }) => role).sort()).toEqual([
      'arranger', 'composer', 'conductor', 'engineer', 'ensemble', 'lyricist', 'mixer', 'performer', 'producer', 'remixer',
    ])
    expect(dusk!.credits).toContainEqual(expect.objectContaining({ role: 'performer', artist: expect.objectContaining({ name: 'Nora Moss' }), instrument: 'viola da gamba' }))
    const composer = dusk!.credits!.find((credit) => credit.role === 'composer')!.artist
    expect(dusk).toMatchObject({ explicit: true, works: [{ title: 'Nocturne in A minor', movementName: 'Andante', movementNumber: 1, movementTotal: 2 }] })
    expect(dawn).toMatchObject({ explicit: false, works: [{ id: dusk!.works![0]!.id, movementName: 'Allegro', movementNumber: 2 }] })
    expect(first!.tags.ratingHint).toEqual({ source: 'fmps', value: 0.8 })
    expect(await db.select().from(ratings)).toEqual([])
    const page = await artistDetail(user.id, composer.id)
    expect(page.topTracks).toEqual([])
    expect(page.composedOrProduced?.map((track) => track.title)).toEqual(['Dawn', 'Dusk'])
    const [song] = await songs(user.id, refs)
    expect(song).toMatchObject({
      displayComposer: 'Mara Finch', explicitStatus: 'explicit', comment: 'From the chamber sessions',
      works: [{ name: 'Nocturne in A minor' }], movements: [{ name: 'Andante', number: 1, count: 2 }],
      contributors: expect.arrayContaining([{ role: 'performer', subRole: 'viola da gamba', artist: { id: expect.stringMatching(/^ar-/), name: 'Nora Moss' } }]),
    })
    expect(song?.userRating).toBeUndefined()

    // An older file's unchanged audio is re-probed on a scan, without restarting analysis.
    await db.update(mediaFiles).set({ tagVersion: 0, probeStage: 2, tags: {} }).where(eq(mediaFiles.id, first!.id))
    await scanRoot({ rootId, paths: [folder] })
    await probeFile({ fileId: first!.id })
    expect(await fileById(first!.id)).toMatchObject({ tagVersion: 1, probeStage: 2, tags: { explicit: true } })

    // Local metadata follows a file through a recording merge and goes away when retagged.
    const match = (await createAlbum({ title: 'Canonical Nocturnes', tracks: [{ title: 'Dusk', mbid: newId() }] })).tracks[0]!
    await mergeRecording(first!.recordingId!, match.recordingId)
    expect((await trackSummaries(user.id, [{ id: match.recordingId }]))[0]).toMatchObject({ explicit: true, works: dusk!.works })
    await makeTone(library, { path: first!.relPath, tags: { title: 'Dusk', artist: 'Juniper Ensemble', album: 'Nocturnes', track: 1 } })
    const later = new Date(first!.mtime.getTime() + 60_000)
    await utimes(firstPath!, later, later)
    await scanRoot({ rootId, paths: [folder] })
    await probeFile({ fileId: first!.id })
    await ingestGroup({ rootId, groupKey })
    expect((await fileById(first!.id)).tags.ratingHint).toBeUndefined()
    const refreshed = await fileById(first!.id)
    expect(refreshed.groupKey).toBe(groupKey)
    expect(refreshed.tags.work).toBeUndefined()
    const [retagged] = await trackSummaries(user.id, [{ id: refreshed.recordingId! }])
    expect(retagged).toMatchObject({ explicit: null })
    expect(retagged?.works).toBeUndefined()
    expect(retagged?.credits).toBeUndefined()
  })

  for (const order of ['left', 'joined'] as const) {
    it(`keeps the album with the files that stay when the group it ${order} is ingested first`, async () => {
      const folder = `Mira Vale/Blue Hour (${order})`
      const album = `Blue Hour (${order})`
      await makeAlbum(library, {
        artist: 'Mira Vale', album, folder,
        tracks: ['Night Swimming', 'Soft Signal', 'Underwater Light'].map((title) => ({ title, durationSec: 1 })),
      })
      await scanRoot({ rootId, paths: [folder] })
      for (const file of await filesUnder(folder)) await probeFile({ fileId: file.id })
      await ingestGroup({ rootId, groupKey: (await filesUnder(folder))[0]!.groupKey! })
      const [kept, other, leaving] = await filesUnder(folder) as [typeof mediaFiles.$inferSelect, typeof mediaFiles.$inferSelect, typeof mediaFiles.$inferSelect]
      const albumId = kept.albumId!
      expect([other.albumId, leaving.albumId]).toEqual([albumId, albumId])

      // Retag the last track onto an album of its own. The mtime is set explicitly so the
      // scan sees a change however close together the two writes were.
      const absolute = path.join(library, leaving.relPath)
      await makeTone(library, { path: leaving.relPath, durationSec: 1, tags: { title: 'Underwater Light', artist: 'Mira Vale', album_artist: 'Mira Vale', album: 'Underwater Light', track: 1 } })
      const later = new Date(leaving.mtime.getTime() + 60_000)
      await utimes(absolute, later, later)
      expect(await scanRoot({ rootId, paths: [folder] })).toMatchObject({ filesChanged: 1 })
      await probeFile({ fileId: leaving.id })
      const joined = (await fileById(leaving.id)).groupKey!
      expect(joined).not.toBe(kept.groupKey)

      const groups = order === 'left' ? [kept.groupKey!, joined] : [joined, kept.groupKey!]
      for (const groupKey of groups) await ingestGroup({ rootId, groupKey })

      expect((await fileById(kept.id)).albumId).toBe(albumId)
      expect((await fileById(other.id)).albumId).toBe(albumId)
      expect(await albumTitle(albumId)).toBe(album)
      const moved = (await fileById(leaving.id)).albumId!
      expect(moved).not.toBe(albumId)
      expect(await albumTitle(moved)).toBe('Underwater Light')
    })
  }
})

// Provider deliveries: the tags name artists the store's way; the request names the catalog's.
describe('ingesting a provider delivery', () => {
  useTestDatabase()
  let library = ''
  let rootId = ''

  beforeAll(async () => {
    library = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-ingest-delivery-')))
    await startJobs({ work: false })
    rootId = (await insertRoot({ name: 'Music', path: library, mode: 'managed', watch: false })).id
  })
  afterAll(async () => {
    await stopJobs()
    await stopProgress()
    await rm(library, { recursive: true, force: true })
  })

  /** A delivered file for an acquisition job asking for `recordingIds` (of `albumId`), ingested. */
  async function deliver(input: { folder: string; artist: string; album: string; title: string; recordingIds: string[]; albumId: string }) {
    const [provider] = await db.select({ id: acquisitionProviders.id }).from(acquisitionProviders).limit(1)
    const providerId = provider?.id ?? (await db.insert(acquisitionProviders).values({ id: newId(), name: 'Mock', baseUrl: 'http://mock.invalid', secretEncrypted: 'x' }).returning())[0]!.id
    const importId = newId()
    await db.insert(imports).values({ id: importId, kind: 'acquisition', source: 'provider', stagingPath: library })
    await db.insert(acquisitionJobs).values({
      id: newId(), providerId, recordingIds: input.recordingIds, albumId: input.albumId, importId, idempotencyKey: newId(), status: 'importing',
    })
    await makeTone(library, { path: `${input.folder}/01 ${input.title}.flac`, durationSec: 1, tags: { title: input.title, artist: input.artist, album_artist: input.artist, album: input.album, track: 1 } })
    await scanRoot({ rootId, paths: [input.folder] })
    const [file] = await db.select().from(mediaFiles).where(sql`${mediaFiles.relPath} like ${`${input.folder}/%`}`)
    await db.update(mediaFiles).set({ importId }).where(eq(mediaFiles.id, file!.id))
    await probeFile({ fileId: file!.id })
    const [probed] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, file!.id))
    await ingestGroup({ rootId, groupKey: probed!.groupKey! })
    return (await db.select().from(mediaFiles).where(eq(mediaFiles.id, file!.id)))[0]!
  }

  const creditsOf = async (recordingId: string) => (await db.select({ artistId: recordingArtists.artistId }).from(recordingArtists)
    .where(eq(recordingArtists.recordingId, recordingId)).orderBy(recordingArtists.position)).map((row) => row.artistId)

  it('credits a played track to the artists it was requested under, whatever its tags say', async () => {
    const mira = await createArtist({ name: 'Mira Vale' })
    const harbor = await createAlbum({ artist: mira, title: 'Glass Harbor', tracks: [{ title: 'Low Tide' }] })
    const before = (await db.select({ id: artists.id }).from(artists)).length
    // The store spells the artist its own way.
    const file = await deliver({ folder: '_Incoming/one', artist: 'MIRA VALE (Official)', album: 'Glass Harbor', title: 'Low Tide', recordingIds: [harbor.tracks[0]!.recordingId], albumId: harbor.albumId })
    expect((await db.select({ id: artists.id }).from(artists)).length).toBe(before)
    expect(await creditsOf(file.recordingId!)).toEqual([mira.id])
    const [built] = await db.select({ albumId: albumArtists.artistId }).from(albumArtists).where(eq(albumArtists.albumId, file.albumId!))
    expect(built!.albumId).toBe(mira.id)
  })

  it('splits a whole store credit into the requested artists of an album delivery', async () => {
    const grimes = await createArtist({ name: 'Grimes' })
    const vadakin = await createArtist({ name: 'VADAKIN' })
    const single = await createAlbum({ artist: grimes, title: 'ACCELERANDO', tracks: [{ title: 'ACCELERANDO' }, { title: 'ACCELERANDO (Extended)' }] })
    for (const track of single.tracks) {
      await db.insert(recordingArtists).values({ recordingId: track.recordingId, position: 1, artistId: vadakin.id, creditedName: 'VADAKIN', joinPhrase: '' })
      await db.execute(sql`update recording_artists set join_phrase = ' & ' where recording_id = ${track.recordingId} and position = 0`)
      await db.update(recordings).set({ artistCredit: 'Grimes & VADAKIN' }).where(eq(recordings.id, track.recordingId))
    }
    const before = (await db.select({ id: artists.id }).from(artists)).length
    // Two recordings asked for, so the tags are read; Deezer joins the credit with a comma.
    const file = await deliver({ folder: '_Incoming/two', artist: 'Grimes, VADAKIN', album: 'ACCELERANDO', title: 'ACCELERANDO', recordingIds: single.tracks.map((track) => track.recordingId), albumId: single.albumId })
    expect((await db.select({ id: artists.id }).from(artists)).length).toBe(before)
    expect(await creditsOf(file.recordingId!)).toEqual([grimes.id, vadakin.id])
  })

  it('still builds artists from tags for files nobody asked for', async () => {
    await makeTone(library, { path: 'Elsewhere/01 Tune.flac', durationSec: 1, tags: { title: 'Tune', artist: 'Brand New Band', album: 'Elsewhere', track: 1 } })
    await scanRoot({ rootId, paths: ['Elsewhere'] })
    const [file] = await db.select().from(mediaFiles).where(sql`${mediaFiles.relPath} like 'Elsewhere/%'`)
    await probeFile({ fileId: file!.id })
    const [probed] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, file!.id))
    await ingestGroup({ rootId, groupKey: probed!.groupKey! })
    expect(await db.select({ id: artists.id }).from(artists).where(eq(artists.name, 'Brand New Band'))).toHaveLength(1)
  })
})
