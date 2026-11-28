import { readFileSync } from 'node:fs'
import { INCOMING_FOLDER, type MatchCandidate } from '@squirmy/contracts'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { db } from '../../database/client.js'
import {
  albums, artists, imports, likes, matchReviews, mediaFiles, playlistItems, playlists, recordingArtists, recordings, releases, releaseTracks,
} from '../../database/schema.js'
import { drainJobs, enqueue, jobs, startJobs, stopJobs } from '../../jobs/index.js'
import { ProviderError } from '../../lib/http.js'
import { newId } from '../../lib/ids.js'
import { getServerSettings, updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { createLibraryRoot, createUser } from '../../test/factories.js'
import { useHttpFixtures } from '../../test/http.js'
import { demoAlbums, ingestAlbum, ingestLoose, type DemoAlbum } from '../../test/matching.js'
import { matchingModule } from './index.js'
import { matchGroup, sweep } from './match.js'
import { queueNewlyPossibleMatching, retryWithFingerprints } from './retry.js'

const okComputerGroup = 'b1392450-e666-3926-a536-22c65f834433'
const okComputerCd = '52709206-8816-3c12-9ff6-f957f2f1eecf'
const oknotok = 'd6dc018d-5caa-4e6f-8e9d-d889fcd585f4'
const awesomeMixJp = '1b3d7b3f-e224-41f6-a1a5-0a44ca8402ff'
const karmaPolice = '9e2ad5bc-c6f9-40d2-a36f-3122ee2072a3'
const airbag = '4a7fea2e-545b-4c63-bc9a-9943cc3a29d7'

/** The OKNOTOK edition's 23 tracks from its recorded MusicBrainz response, as a rip of it would be tagged. */
const oknotokFixture = JSON.parse(readFileSync(new URL('../../test/http/musicbrainz/get-musicbrainz-org-ws-2-release-d6dc018d-5caa-4e6f-8e9d-d889fcd585f4-inc-artist-credits-label-aeef0f15.json', import.meta.url), 'utf8')) as {
  response: { json: { media: { position: number; tracks: { title: string; length: number }[] }[] } }
}
const oknotokAlbum: DemoAlbum = {
  artist: 'Radiohead', album: 'OK Computer OKNOTOK 1997 2017', year: 2017,
  tracks: oknotokFixture.response.json.media.flatMap((medium) => medium.tracks.map((track) => ({
    title: track.title, durationMs: Math.round(track.length / 1000) * 1000, disc: medium.position,
  }))),
}

type Group = { rootId: string; groupKey: string }

const inGroup = (group: Group) => and(eq(mediaFiles.rootId, group.rootId), eq(mediaFiles.groupKey, group.groupKey))

async function filesOf(group: Group) {
  return db.select().from(mediaFiles).where(inGroup(group)).orderBy(mediaFiles.relPath)
}

async function releaseOf(group: Group) {
  const [file] = await filesOf(group)
  const [release] = await db.select().from(releases).where(eq(releases.id, file!.releaseId!))
  return release!
}

/** Every file's link, as `disc:position → recording MBID`. */
async function links(group: Group) {
  return db.select({ path: mediaFiles.relPath, status: mediaFiles.matchStatus, disc: releaseTracks.disc, position: releaseTracks.position, title: releaseTracks.title, recordingMbid: recordings.mbid })
    .from(mediaFiles)
    .leftJoin(releaseTracks, eq(releaseTracks.id, mediaFiles.releaseTrackId))
    .leftJoin(recordings, eq(recordings.id, mediaFiles.recordingId))
    .where(inGroup(group))
    .orderBy(mediaFiles.relPath)
}

async function queuedJobs(name: string) {
  return db.execute<{ singleton_key: string; data: Record<string, string> }>(sql`select singleton_key, data from pgboss.job where name = ${name} and state = 'created' order by created_on`)
}

describe('matching.match-album', () => {
  useTestDatabase()
  const http = useHttpFixtures('musicbrainz', 'acoustid')
  let rootId = ''

  beforeAll(async () => {
    await matchingModule.jobs!(jobs)
    await startJobs({ work: false })
    rootId = (await createLibraryRoot()).id
  })
  afterAll(stopJobs)

  it('matches clean tags, adopting the local rows and linking every file', async () => {
    const ingested = await ingestAlbum(rootId, demoAlbums.okComputer)
    const recordingIds = ingested.files.map((file) => file.recordingId)
    await matchGroup(rootId, ingested.groupKey)

    const files = await filesOf(ingested)
    expect(files.every((file) => file.matchStatus === 'matched' && file.matchSource === 'search' && !file.matchLocked)).toBe(true)
    expect(files[0]!.matchConfidence).toBeGreaterThan(0.95)
    // Adopted in place: the ids the files (and any user data) pointed at are now MusicBrainz rows.
    expect(files.map((file) => file.albumId)).toEqual(files.map(() => ingested.albumId))
    expect(files.map((file) => file.recordingId)).toEqual(recordingIds)

    const [album] = await db.select().from(albums).where(eq(albums.id, ingested.albumId))
    expect(album).toMatchObject({ mbid: okComputerGroup, title: 'OK Computer', artistCredit: 'Radiohead', type: 'album', year: 1997 })
    const release = await releaseOf(ingested)
    expect(album!.canonicalReleaseId).toBe(release.id)
    expect(release).toMatchObject({ trackCount: 12, discCount: 1, status: 'official', detailLevel: 2 })

    const linked = await links(ingested)
    expect(linked.map((link) => link.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    expect(linked[5]).toMatchObject({ title: 'Karma Police', recordingMbid: karmaPolice })
    const [radiohead] = await db.select().from(artists).where(eq(artists.id, album!.primaryArtistId!))
    expect(radiohead).toMatchObject({ mbid: 'a74b1b7f-71a5-4011-9441-d0b5e4122711', name: 'Radiohead' })

    expect((await queuedJobs('enrichment.album')).map((job) => job.data)).toContainEqual({ albumId: ingested.albumId })
    expect((await queuedJobs('enrichment.artist')).map((job) => job.data)).toContainEqual({ artistId: radiohead!.id })

    // Running it again changes nothing and asks MusicBrainz nothing.
    http.requests.length = 0
    const before = await filesOf(ingested)
    await matchGroup(rootId, ingested.groupKey)
    expect(http.requests).toEqual([])
    expect(await filesOf(ingested)).toEqual(before)
  })

  it('tells the original edition from the deluxe one, both ways', async () => {
    const original = await ingestAlbum(rootId, demoAlbums.okComputer, { folder: 'editions/OK Computer' })
    await matchGroup(rootId, original.groupKey)
    expect(await releaseOf(original)).toMatchObject({ trackCount: 12 })

    const deluxe = await ingestAlbum(rootId, oknotokAlbum)
    await matchGroup(rootId, deluxe.groupKey)
    expect(await releaseOf(deluxe)).toMatchObject({ trackCount: 23, discCount: 2 })
    const linked = await links(deluxe)
    expect(linked.every((link) => link.status === 'matched')).toBe(true)
    expect(linked.find((link) => link.title === 'Lift')).toMatchObject({ disc: 2, position: 3 })
  })

  it('matches a two-disc album ripped into CD1 and CD2 folders', async () => {
    const ingested = await ingestAlbum(rootId, demoAlbums.theWall)
    await matchGroup(rootId, ingested.groupKey)
    expect(await releaseOf(ingested)).toMatchObject({ discCount: 2, trackCount: 26 })
    const linked = await links(ingested)
    expect(linked.every((link) => link.status === 'matched')).toBe(true)
    expect(linked.find((link) => link.path.endsWith('CD2/06 Comfortably Numb.flac'))).toMatchObject({ disc: 2, position: 6 })
    expect(linked.find((link) => link.path.endsWith('CD1/01 In the Flesh?.flac'))).toMatchObject({ disc: 1, position: 1 })
  })

  it('matches a Various Artists compilation with per-track credits', async () => {
    const ingested = await ingestAlbum(rootId, demoAlbums.awesomeMix)
    await matchGroup(rootId, ingested.groupKey)
    const [album] = await db.select().from(albums).where(eq(albums.id, (await filesOf(ingested))[0]!.albumId!))
    expect(album).toMatchObject({ artistCredit: 'Various Artists', type: 'soundtrack' })
    const linked = await links(ingested)
    expect(linked.every((link) => link.status === 'matched')).toBe(true)
    const credits = await db.select({ name: artists.name }).from(recordingArtists)
      .innerJoin(artists, eq(artists.id, recordingArtists.artistId))
      .innerJoin(mediaFiles, eq(mediaFiles.recordingId, recordingArtists.recordingId))
      .where(eq(mediaFiles.groupKey, ingested.groupKey))
    expect(credits.map((credit) => credit.name)).toEqual(expect.arrayContaining(['Blue Swede', 'David Bowie', 'Redbone']))
  })

  it('matches an album in a non-Latin script', async () => {
    const ingested = await ingestAlbum(rootId, demoAlbums.muzaiMoratorium)
    await matchGroup(rootId, ingested.groupKey)
    const linked = await links(ingested)
    expect(linked.every((link) => link.status === 'matched')).toBe(true)
    expect(linked.find((link) => link.path.includes('丸の内'))).toMatchObject({ position: 3, title: '丸の内サディスティック' })
  })

  it('trusts a release id in the tags once the files fit it', async () => {
    const ingested = await ingestAlbum(rootId, demoAlbums.okComputer, { folder: 'tagged/OK Computer', tags: () => ({ mbReleaseId: okComputerCd }) })
    http.requests.length = 0
    await matchGroup(rootId, ingested.groupKey)
    expect(http.requests.some((request) => request.includes('query='))).toBe(false)
    expect((await releaseOf(ingested)).mbid).toBe(okComputerCd)
    expect((await filesOf(ingested)).every((file) => file.matchSource === 'tags-mbid')).toBe(true)
  })

  it('rejects a release id in the tags that the files do not fit', async () => {
    for (const [folder, wrong] of [['wrong/compilation', awesomeMixJp], ['wrong/deluxe', oknotok]] as const) {
      const ingested = await ingestAlbum(rootId, demoAlbums.okComputer, { folder, tags: () => ({ mbReleaseId: wrong }) })
      await matchGroup(rootId, ingested.groupKey)
      const release = await releaseOf(ingested)
      expect(release.mbid).not.toBe(wrong)
      expect(release.trackCount).toBe(12)
      expect((await filesOf(ingested)).every((file) => file.matchStatus === 'matched' && file.matchSource === 'search')).toBe(true)
    }
  })

  it('tries a tagged release group when the tagged release does not fit', async () => {
    const ingested = await ingestAlbum(rootId, demoAlbums.okComputer, {
      folder: 'tagged/release group',
      tags: () => ({ mbReleaseId: oknotok, mbReleaseGroupId: okComputerGroup }),
    })
    await matchGroup(rootId, ingested.groupKey)

    expect(http.requests.some((request) => request.includes(`release-group/${okComputerGroup}`))).toBe(true)
    expect(http.requests.some((request) => request.includes('query='))).toBe(false)
    expect(await releaseOf(ingested)).toMatchObject({ trackCount: 12 })
    expect((await filesOf(ingested)).every((file) => file.matchStatus === 'matched' && file.matchSource === 'tags-mbid')).toBe(true)
  })

  it('finds a release by its barcode before searching by name or ISRC', async () => {
    const ingested = await ingestAlbum(rootId, oknotokAlbum, {
      folder: 'tagged/barcode',
      tags: () => ({ barcode: '0634904086824', isrcs: ['GBAYE9701368'] }),
    })
    await matchGroup(rootId, ingested.groupKey)

    expect(http.requests.filter((request) => request.includes('query='))).toEqual([
      expect.stringContaining('query=barcode%3A634904086824'),
    ])
    expect(await releaseOf(ingested)).toMatchObject({ mbid: oknotok })
    expect((await filesOf(ingested)).every((file) => file.matchStatus === 'matched' && file.matchSource === 'tags-barcode')).toBe(true)
  })

  it('finds the right-size edition by ISRC when the barcode and the search have no hits', async () => {
    const ingested = await ingestAlbum(rootId, demoAlbums.okComputer, {
      folder: 'tagged/isrc',
      tags: (track) => ({
        barcode: '999999999999',
        ...(track.title === 'Karma Police' && { isrcs: ['GBAYE9701368'], title: 'Track 06' }),
      }),
    })
    await matchGroup(rootId, ingested.groupKey)

    expect(http.requests.filter((request) => request.includes('query='))).toEqual([
      expect.stringContaining('query=barcode%3A999999999999'),
      expect.stringContaining('query=release%3A%22OK+Computer%22'),
      expect.stringContaining('query=isrc%3AGBAYE9701368'),
    ])
    expect(await releaseOf(ingested)).toMatchObject({ mbid: okComputerCd })
    expect((await filesOf(ingested)).every((file) => file.matchStatus === 'matched' && file.matchSource === 'tags-isrc')).toBe(true)
    expect((await links(ingested))[5]).toMatchObject({ title: 'Karma Police', recordingMbid: karmaPolice })
  })

  it('opens a review with ranked candidates when the tags are mediocre', async () => {
    const ingested = await ingestAlbum(rootId, { ...demoAlbums.theWall, year: undefined }, {
      folder: 'mediocre/The Wall',
      tags: (_track, index) => ({ title: `Track ${String(index + 1).padStart(2, '0')}` }),
    })
    await matchGroup(rootId, ingested.groupKey)
    const files = await filesOf(ingested)
    expect(files.every((file) => file.matchStatus === 'review' && file.albumId === ingested.albumId)).toBe(true)
    const [review] = await db.select().from(matchReviews).where(eq(matchReviews.groupKey, ingested.groupKey))
    expect(review).toMatchObject({ status: 'open', summary: { artist: 'Pink Floyd', album: 'The Wall', year: null, trackCount: 26, folder: 'mediocre/The Wall' } })
    const candidates = review!.candidates as MatchCandidate[]
    const scores = candidates.map((candidate) => candidate.score)
    expect(scores.length).toBeGreaterThan(1)
    expect(scores).toEqual([...scores].sort((a, b) => b - a))
    expect(scores[0]).toBeLessThan(0.9)
    expect(candidates[0]).toMatchObject({ title: 'The Wall', trackCount: 26, discCount: 2 })
    // Enough to compare without asking MusicBrainz again: every track, with the file put on it.
    expect(candidates[0]!.tracks).toHaveLength(26)
    expect(candidates[0]!.tracks.filter((track) => track.fileId).length).toBeGreaterThan(20)
  })

  it('leaves music it cannot identify local-only', async () => {
    const ingested = await ingestAlbum(rootId, demoAlbums.blueHour)
    await matchGroup(rootId, ingested.groupKey)
    const files = await filesOf(ingested)
    expect(files.every((file) => file.matchStatus === 'unmatched' && file.albumId === ingested.albumId)).toBe(true)
    const [album] = await db.select().from(albums).where(eq(albums.id, ingested.albumId))
    expect(album!.mbid).toBeNull()
  })

  it('never changes locked files', async () => {
    const ingested = await ingestAlbum(rootId, demoAlbums.discovery)
    const locked = ingested.files.slice(0, 2).map((file) => file.id)
    await db.update(mediaFiles).set({ matchLocked: true, matchStatus: 'unmatched' }).where(inArray(mediaFiles.id, locked))
    await matchGroup(rootId, ingested.groupKey)
    const files = await filesOf(ingested)
    for (const file of files) {
      if (locked.includes(file.id)) expect(file).toMatchObject({ matchStatus: 'unmatched', recordingId: ingested.files.find((row) => row.id === file.id)!.recordingId })
      else expect(file.matchStatus).toBe('matched')
    }
  })

  it('attaches files that fit no track to the matched album as extras', async () => {
    const ingested = await ingestAlbum(rootId, {
      ...demoAlbums.okComputer,
      tracks: [...demoAlbums.okComputer.tracks, { title: 'Polyethylene (Parts 1 & 2)', durationMs: 263_000 }],
    }, { folder: 'extras/OK Computer' })
    const bonus = ingested.files.find((file) => file.tags.title?.startsWith('Polyethylene'))!
    await matchGroup(rootId, ingested.groupKey)
    const files = await filesOf(ingested)
    const extra = files.find((file) => file.id === bonus.id)!
    const release = await releaseOf(ingested)
    expect(release.trackCount).toBe(12)
    expect(extra).toMatchObject({ matchStatus: 'unmatched', releaseTrackId: null, releaseId: release.id, albumId: release.albumId, recordingId: bonus.recordingId })
    const [recording] = await db.select().from(recordings).where(eq(recordings.id, bonus.recordingId!))
    expect(recording).toMatchObject({ mbid: null, title: 'Polyethylene (Parts 1 & 2)', mergedIntoId: null })
    expect(files.filter((file) => file.matchStatus === 'matched')).toHaveLength(12)
  })

  it('merges local rows into MusicBrainz rows that already exist, keeping user data', async () => {
    const otherRoot = (await createLibraryRoot()).id
    const user = await createUser()
    const first = await ingestAlbum(otherRoot, demoAlbums.randomAccessMemories, { folder: 'first copy' })
    // User data on the local rows of the first copy: adopted in place.
    const getLucky = first.files.find((file) => file.tags.title === 'Get Lucky')!
    await db.insert(likes).values({ userId: user.id, entityType: 'recording', entityId: getLucky.recordingId! })
    await matchGroup(otherRoot, first.groupKey)
    const [adopted] = await db.select().from(recordings).where(eq(recordings.id, getLucky.recordingId!))
    expect(adopted).toMatchObject({ mergedIntoId: null, title: 'Get Lucky' })
    expect(adopted!.mbid).not.toBeNull()

    // A second copy arrives with its own local rows, and a liked track and a playlist entry.
    const second = await ingestAlbum(otherRoot, demoAlbums.randomAccessMemories, { folder: 'second copy' })
    const contact = second.files.find((file) => file.tags.title === 'Contact')!
    const [playlist] = await db.insert(playlists).values({ id: newId(), ownerId: user.id, name: 'Mix' }).returning()
    await db.insert(playlistItems).values({ id: newId(), playlistId: playlist!.id, position: 0, recordingId: contact.recordingId!, albumId: second.albumId })
    await db.insert(likes).values({ userId: user.id, entityType: 'recording', entityId: contact.recordingId! })
    await matchGroup(otherRoot, second.groupKey)

    const files = await filesOf(second)
    expect(files.every((file) => file.matchStatus === 'matched' && file.albumId === first.albumId)).toBe(true)
    const [localContact] = await db.select().from(recordings).where(eq(recordings.id, contact.recordingId!))
    const matchedContact = files.find((file) => file.id === contact.id)!.recordingId!
    expect(localContact!.mergedIntoId).toBe(matchedContact)
    const [item] = await db.select().from(playlistItems).where(eq(playlistItems.playlistId, playlist!.id))
    expect(item).toMatchObject({ recordingId: matchedContact, albumId: first.albumId })
    const liked = await db.select({ id: likes.entityId }).from(likes).where(eq(likes.userId, user.id))
    expect(liked.map((like) => like.id).sort()).toEqual([getLucky.recordingId, matchedContact].sort())
    const [localAlbum] = await db.select().from(albums).where(eq(albums.id, second.albumId))
    expect(localAlbum!.mergedIntoId).toBe(first.albumId)
    // The second copy's local edition is gone; both copies share the MusicBrainz release.
    expect(new Set(files.map((file) => file.releaseId))).toEqual(new Set([(await releaseOf(first)).id]))
  })

  it('identifies a loose file by its fingerprint once an AcoustID key is set', async () => {
    // Without an album there is nothing to search, so loose files wait for a fingerprint.
    const tagged = await ingestLoose(rootId, 'Singles/bad guy.m4a', { title: 'bad guy', artist: 'Billie Eilish' }, 194_000)
    const untagged = await ingestLoose(rootId, 'misc rips/track01.mp3', {}, 261_000)
    for (const loose of [tagged, untagged]) {
      await matchGroup(rootId, loose.groupKey)
      expect((await filesOf(loose))[0]!.matchStatus).toBe('unmatched')
    }

    await updateServerSettings({ acoustIdKey: 'test-acoustid-key' })
    // A stored fingerprint saves running fpcalc; the lookup fixture is written for it.
    await db.update(mediaFiles).set({ matchStatus: 'pending', fingerprint: 'AQADtKarmaPoliceTestPrint' }).where(eq(mediaFiles.groupKey, untagged.groupKey))
    await matchGroup(rootId, untagged.groupKey)
    const [link] = await links(untagged)
    expect(link).toMatchObject({ status: 'matched', title: 'Karma Police', recordingMbid: karmaPolice })
    expect((await filesOf(untagged))[0]).toMatchObject({ matchSource: 'acoustid', acoustid: '5f8a2c1e-9b7d-4e3a-8c6f-2d1b0a9e8f7c' })
    await updateServerSettings({ acoustIdKey: null })
  })

  it('uses a fingerprint to improve a fuzzy match below the auto-accept threshold', async () => {
    const ingested = await ingestAlbum(rootId, demoAlbums.okComputer, {
      folder: 'mistagged/OK Computer',
      tags: (track) => track.title === 'Airbag' ? { title: 'Track 01' } : {},
    })
    const file = ingested.files[0]!
    await updateServerSettings({ matchAutoAcceptScore: 0.99 })
    try {
      await matchGroup(rootId, ingested.groupKey)
      expect((await filesOf(ingested))[0]).toMatchObject({ matchStatus: 'review' })

      await updateServerSettings({ acoustIdKey: 'test-acoustid-key' })
      await db.update(mediaFiles).set({ matchStatus: 'pending', fingerprint: 'AQADtAirbagTestPrint' }).where(eq(mediaFiles.id, file.id))
      await matchGroup(rootId, ingested.groupKey)

      expect((await filesOf(ingested)).every((row) => row.matchStatus === 'matched')).toBe(true)
      expect(http.requests.some((request) => request.includes('api.acoustid.org'))).toBe(true)
      expect((await links(ingested))[0]).toMatchObject({ title: 'Airbag', recordingMbid: airbag })
      const [review] = await db.select().from(matchReviews).where(eq(matchReviews.groupKey, ingested.groupKey))
      expect(review?.status).toBe('resolved')
    } finally {
      await updateServerSettings({ acoustIdKey: null, matchAutoAcceptScore: 0.9 })
    }
  })

  it('skips fingerprint lookup when a fuzzy match already qualifies', async () => {
    const ingested = await ingestAlbum(rootId, demoAlbums.okComputer, { folder: 'clean/OK Computer' })
    await db.update(mediaFiles).set({ fingerprint: 'AQADtAirbagTestPrint' }).where(eq(mediaFiles.id, ingested.files[0]!.id))
    await updateServerSettings({ acoustIdKey: 'test-acoustid-key' })
    try {
      await matchGroup(rootId, ingested.groupKey)
      const files = await filesOf(ingested)
      expect(files.every((file) => file.matchStatus === 'matched' && file.matchSource === 'search')).toBe(true)
      expect(files[0]!.acoustid).toBeNull()
      expect(http.requests.some((request) => request.includes('api.acoustid.org'))).toBe(false)
    } finally {
      await updateServerSettings({ acoustIdKey: null })
    }
  })

  it('gives unmatched files another go when an AcoustID key is added', async () => {
    const retryRoot = (await createLibraryRoot()).id
    const untagged = await ingestLoose(retryRoot, 'rips/track07.mp3', {}, 200_000)
    const titled = await ingestLoose(retryRoot, 'Singles/Some Song.m4a', { title: 'Some Song', artist: 'Some Artist' }, 180_000)
    const kept = await ingestLoose(retryRoot, 'rips/kept/track01.mp3', {}, 210_000)
    // A named album can reach the fingerprint tier too.
    const searched = await ingestAlbum(retryRoot, { artist: 'Nobody Known', album: 'Nothing Found', tracks: [{ title: 'Silence', durationMs: 100_000 }] })
    await db.update(mediaFiles).set({ matchStatus: 'unmatched' }).where(eq(mediaFiles.rootId, retryRoot))
    await db.update(mediaFiles).set({ matchLocked: true }).where(eq(mediaFiles.groupKey, kept.groupKey))

    const settings = await getServerSettings()
    await queueNewlyPossibleMatching({ ...settings, acoustIdKeySet: false }, { ...settings, acoustIdKeySet: true })
    expect(await queuedJobs('matching.retry-fingerprints')).toHaveLength(1)
    // Nothing changed: nothing is queued.
    await queueNewlyPossibleMatching(settings, settings)
    expect(await queuedJobs('matching.retry-fingerprints')).toHaveLength(1)

    // Loose files of earlier tests in other roots count too.
    expect(await retryWithFingerprints()).toBeGreaterThanOrEqual(3)
    for (const group of [untagged, titled, searched]) expect((await filesOf(group))[0]!.matchStatus).toBe('pending')
    expect((await filesOf(kept))[0]!.matchStatus).toBe('unmatched')
    const keys = (await queuedJobs('matching.match-album')).map((job) => job.singleton_key)
    expect(keys).toEqual(expect.arrayContaining([untagged, titled, searched].map(({ groupKey }) => `${retryRoot}:${groupKey}`)))
    expect(keys).not.toContain(`${retryRoot}:${kept.groupKey}`)
    await db.update(mediaFiles).set({ missingSince: new Date() }).where(eq(mediaFiles.rootId, retryRoot))
  })

  it('sweeps at once when MusicBrainz is switched on', async () => {
    const settings = await getServerSettings()
    const before = (await queuedJobs('matching.sweep')).length
    await queueNewlyPossibleMatching({ ...settings, musicBrainzEnabled: false }, { ...settings, musicBrainzEnabled: true })
    expect(await queuedJobs('matching.sweep')).toHaveLength(before + 1)
  })

  it('also matches a file of the group that was ingested while the match ran', async () => {
    // Its own job has the running job's singleton key, so pg-boss drops it; the running match must pick it up.
    const tracks = demoAlbums.abbeyRoad.tracks
    const early = await ingestAlbum(rootId, { ...demoAlbums.abbeyRoad, tracks: tracks.slice(0, -1) })
    const realFetch = globalThis.fetch
    let late: Promise<unknown> | null = null
    vi.stubGlobal('fetch', (...request: Parameters<typeof fetch>) => {
      late ??= ingestAlbum(rootId, { ...demoAlbums.abbeyRoad, tracks: tracks.slice(-1) }, { tags: () => ({ track: tracks.length }) })
      return late.then(() => realFetch(...request))
    })
    try {
      await matchGroup(rootId, early.groupKey)
    } finally {
      vi.stubGlobal('fetch', realFetch)
    }
    const files = await filesOf(early)
    expect(late).not.toBeNull()
    expect(files).toHaveLength(tracks.length)
    expect(files.filter((file) => file.matchStatus === 'pending').map((file) => file.relPath)).toEqual([])
  })

  it('leaves files pending while MusicBrainz is off, and lets provider failures retry', async () => {
    const ingested = await ingestAlbum(rootId, demoAlbums.slowMotion)
    await updateServerSettings({ musicBrainzEnabled: false })
    await matchGroup(rootId, ingested.groupKey)
    expect(await sweep()).toBe(0)
    expect((await filesOf(ingested)).every((file) => file.matchStatus === 'pending')).toBe(true)
    await updateServerSettings({ musicBrainzEnabled: true })

    const failing = await ingestAlbum(rootId, { artist: 'Error Artist', album: 'Error Album', tracks: [{ title: 'Error', durationMs: 200_000 }] })
    await expect(matchGroup(rootId, failing.groupKey)).rejects.toBeInstanceOf(ProviderError)
    expect((await filesOf(failing))[0]!.matchStatus).toBe('pending')
    await db.update(mediaFiles).set({ missingSince: new Date() }).where(eq(mediaFiles.groupKey, failing.groupKey))
  })

  it('leaves an import\'s files alone until the import has decided its duplicates', async () => {
    const importId = newId()
    await db.insert(imports).values({ id: importId, kind: 'upload', source: 'upload', status: 'processing', step: 'identifying', targetRootId: rootId, stagingPath: '/nowhere' })
    const ingested = await ingestAlbum(rootId, demoAlbums.okComputer, { folder: `${INCOMING_FOLDER}/${importId}/OK Computer` })
    http.requests.length = 0
    await matchGroup(rootId, ingested.groupKey)
    expect(http.requests).toEqual([])
    expect((await filesOf(ingested)).every((file) => file.matchStatus === 'pending')).toBe(true)
    await sweep()
    expect((await queuedJobs('matching.match-album')).map((job) => job.singleton_key)).not.toContain(`${rootId}:${ingested.groupKey}`)

    await db.update(imports).set({ duplicatesDecidedAt: new Date() }).where(eq(imports.id, importId))
    await matchGroup(rootId, ingested.groupKey)
    expect((await filesOf(ingested)).every((file) => file.matchStatus === 'matched')).toBe(true)
  })

  it('sweeps pending groups into jobs, which match them', async () => {
    const sweepRoot = (await createLibraryRoot()).id
    await db.update(mediaFiles).set({ missingSince: new Date() }).where(eq(mediaFiles.matchStatus, 'pending'))
    const abbey = await ingestAlbum(sweepRoot, demoAlbums.abbeyRoad)
    const slow = await ingestAlbum(sweepRoot, demoAlbums.slowMotion)
    expect(await sweep()).toBe(2)
    expect(await sweep()).toBe(0)
    const keys = (await queuedJobs('matching.match-album')).map((job) => job.singleton_key)
    expect(keys).toEqual(expect.arrayContaining([`${sweepRoot}:${abbey.groupKey}`, `${sweepRoot}:${slow.groupKey}`]))

    await stopJobs()
    await matchingModule.jobs!(jobs)
    await startJobs({ work: true })
    await drainJobs({ timeoutMs: 60_000 })
    expect((await filesOf(abbey)).every((file) => file.matchStatus === 'matched')).toBe(true)
    expect((await filesOf(slow)).every((file) => file.matchStatus === 'unmatched')).toBe(true)
    await enqueue('matching.sweep', {})
    await drainJobs()
    const pending = await db.select().from(mediaFiles).where(and(eq(mediaFiles.rootId, sweepRoot), eq(mediaFiles.matchStatus, 'pending')))
    expect(pending).toEqual([])
  })
})
