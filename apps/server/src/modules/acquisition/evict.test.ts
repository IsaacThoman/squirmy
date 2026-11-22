import { access, mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { db } from '../../database/client.js'
import { albums, imports, likes, mediaFiles, playbackSessions, playlistItems, playlists, recordings } from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { matchKey } from '../../lib/text.js'
import { useTestDatabase } from '../../test/database.js'
import { createPlay } from '../../test/catalog.js'
import { createAlbum, createArtist, createLibraryRoot, createUser } from '../../test/factories.js'
import { trackAvailability } from '../catalog/availability.js'
import { cacheUsage, configureEviction, discardUnrequested, evictCache } from './evict.js'
import { invalidateAcquisitionPolicy, updateAcquisitionPolicy } from './policy.js'

const MB = 1_000_000
const day = 24 * 60

describe('the provider cache', () => {
  useTestDatabase()
  let rootDir = ''
  let rootId = ''

  beforeAll(async () => {
    rootDir = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-cache-')))
    rootId = (await createLibraryRoot({ path: rootDir, mode: 'managed' })).id
  })
  beforeEach(async () => {
    configureEviction({ graceMs: 60 * 60_000 })
    await updateAcquisitionPolicy({ storageQuotaBytes: 0 })
  })
  afterAll(async () => {
    invalidateAcquisitionPolicy()
    await rm(rootDir, { recursive: true, force: true })
  })

  const onDisk = (relPath: string) => access(path.join(rootDir, relPath)).then(() => true, () => false)
  const present = async (ids: string[]) => (await db.select({ id: mediaFiles.id }).from(mediaFiles).where(inArray(mediaFiles.id, ids))).map((row) => row.id)

  /**
   * One single-track catalog album whose file a provider delivered, written to disk under
   * `_Fetched/`, that arrived `minutesAgo` minutes ago, with a cover beside it.
   */
  async function cached(title: string, minutesAgo = 3 * day, source = 'provider:test') {
    const artist = await createArtist({ name: `Artist ${title}` })
    // A catalog album, as deliveries are placed on the album they were requested from.
    const album = await createAlbum({ title, artist, rootId, owned: true, source, mbid: crypto.randomUUID(), tracks: [{ title }] })
    const track = album.tracks[0]!
    const relPath = `_Fetched/${artist.name}/${title}/01 ${title}.flac`
    await db.update(mediaFiles).set({ relPath, size: MB, addedAt: new Date(Date.now() - minutesAgo * 60_000) }).where(eq(mediaFiles.id, track.fileId!))
    await mkdir(path.dirname(path.join(rootDir, relPath)), { recursive: true })
    await writeFile(path.join(rootDir, relPath), 'audio')
    await writeFile(path.join(rootDir, path.dirname(relPath), 'cover.jpg'), 'image')
    return { albumId: album.albumId, recordingId: track.recordingId, fileId: track.fileId!, relPath }
  }

  it('deletes the least recently played unpinned files to 90% of the limit, and keeps every pinned one', async () => {
    const fan = await createUser()
    const neverPlayed = await cached('Never Played')
    const playedLongAgo = await cached('Long Ago')
    const playedLastWeek = await cached('Last Week')
    const playedTwoDaysAgo = await cached('Two Days Ago')
    await createPlay({ userId: fan.id, recordingId: playedLongAgo.recordingId, minutesAgo: 10 * day })
    await createPlay({ userId: fan.id, recordingId: playedLastWeek.recordingId, minutesAgo: 6 * day })
    await createPlay({ userId: fan.id, recordingId: playedTwoDaysAgo.recordingId, minutesAgo: 2 * day })

    const liked = await cached('Liked Track')
    await db.insert(likes).values({ userId: fan.id, entityType: 'recording', entityId: liked.recordingId })
    const likedAlbum = await cached('Liked Album')
    await db.insert(likes).values({ userId: fan.id, entityType: 'album', entityId: likedAlbum.albumId })
    const savedAlbum = await cached('Saved Album')
    await db.insert(likes).values({ userId: fan.id, entityType: 'album', entityId: savedAlbum.albumId })
    const savedTrack = await cached('Saved Track')
    await db.insert(likes).values({ userId: fan.id, entityType: 'recording', entityId: savedTrack.recordingId })
    const listed = await cached('In A Playlist')
    const [playlist] = await db.insert(playlists).values({ id: newId(), ownerId: fan.id, name: 'Mix' }).returning()
    await db.insert(playlistItems).values({ id: newId(), playlistId: playlist!.id, position: 0, recordingId: listed.recordingId })
    const queued = await cached('Up Next')
    const current = await cached('Playing Now')
    const autoplay = await cached('Autoplay')
    // The queue holds an id that was merged into the file's recording since it was queued.
    const oldId = newId()
    await db.insert(recordings).values({ id: oldId, title: 'Up Next', artistCredit: 'x', titleKey: 'up next', matchKey: matchKey('x up next'), mergedIntoId: queued.recordingId })
    const entry = (trackId: string) => ({ id: newId(), trackId, albumId: null, durationMs: 1000, state: 'ready' })
    await db.insert(playbackSessions).values({
      userId: fan.id,
      state: { state: { current: entry(current.recordingId) }, queue: { queue: [entry(oldId)], autoplayQueue: [entry(autoplay.recordingId)], history: [], playOrder: [], playedInCycle: [] } },
    })
    const recent = await cached('Played An Hour Ago')
    await createPlay({ userId: fan.id, recordingId: recent.recordingId, minutesAgo: 60 })
    const justArrived = await cached('Just Arrived', 5)
    // A file someone brought is never cache, whatever the limit.
    const collection = await cached('Brought By Hand', 30 * day, 'scan')

    const evictable = [neverPlayed, playedLongAgo, playedLastWeek, playedTwoDaysAgo]
    const pinned = [liked, likedAlbum, savedAlbum, savedTrack, listed, queued, current, autoplay, recent, justArrived]
    expect(await cacheUsage()).toEqual({ cachedFiles: 14, cachedBytes: 14 * MB, pinnedBytes: 9 * MB, limitBytes: 0 })

    // Unlimited: nothing goes.
    expect(await evictCache()).toEqual({ files: 0, bytes: 0 })

    // 14 MB against 13.5 MB: down to 12.15 MB takes the two least recently used.
    await updateAcquisitionPolicy({ storageQuotaBytes: 13.5 * MB })
    expect(await evictCache()).toEqual({ files: 2, bytes: 2 * MB })
    expect(await present([neverPlayed.fileId, playedLongAgo.fileId])).toEqual([])
    expect(await onDisk(neverPlayed.relPath)).toBe(false)
    // Its folder went with it, cover and all.
    expect(await readdir(path.join(rootDir, '_Fetched'))).not.toContain(`Artist Never Played`)
    expect(await present([playedLastWeek.fileId, playedTwoDaysAgo.fileId])).toHaveLength(2)
    // The track is fetchable again rather than gone, and its album is still there.
    expect((await trackAvailability([neverPlayed.recordingId])).get(neverPlayed.recordingId)).not.toBe('server')
    expect(await db.select().from(albums).where(eq(albums.id, neverPlayed.albumId))).toHaveLength(1)

    // Far under what pinned files take: everything unpinned goes, nothing pinned does.
    await updateAcquisitionPolicy({ storageQuotaBytes: 1 })
    expect(await evictCache()).toEqual({ files: 2, bytes: 2 * MB })
    expect(await present(evictable.map((file) => file.fileId))).toEqual([])
    expect((await present(pinned.map((file) => file.fileId))).sort()).toEqual(pinned.map((file) => file.fileId).sort())
    for (const file of [...pinned, collection]) expect(await onDisk(file.relPath)).toBe(true)
    expect(await cacheUsage()).toMatchObject({ cachedFiles: 10, cachedBytes: 10 * MB, pinnedBytes: 9 * MB, limitBytes: 1 })

    // Once the arrival grace is over, an unpinned new file goes too; a pin dropping frees its file.
    configureEviction({ graceMs: 0 })
    await db.delete(likes).where(eq(likes.entityId, liked.recordingId))
    expect(await evictCache()).toEqual({ files: 2, bytes: 2 * MB })
    expect(await present([justArrived.fileId, liked.fileId])).toEqual([])
  })

  it('never deletes in a read-only root, and holds a saved album\'s tracks wherever their files sit', async () => {
    const fan = await createUser()
    const backupDir = await realpath(await mkdtemp(path.join(tmpdir(), 'squirmy-backup-')))
    try {
      const backup = await createLibraryRoot({ path: backupDir, mode: 'read_only' })
      const old = await cached('In A Backup')
      await db.update(mediaFiles).set({ rootId: backup.id }).where(eq(mediaFiles.id, old.fileId))
      await mkdir(path.dirname(path.join(backupDir, old.relPath)), { recursive: true })
      await writeFile(path.join(backupDir, old.relPath), 'audio')

      // The saved album lists the song; its delivered file was placed on a single.
      const saved = await createAlbum({ title: 'Saved Album', mbid: crypto.randomUUID(), tracks: [{ title: 'On The Single' }] })
      await db.insert(likes).values({ userId: fan.id, entityType: 'album', entityId: saved.albumId })
      const single = await cached('On The Single')
      await db.update(mediaFiles).set({ recordingId: saved.tracks[0]!.recordingId }).where(eq(mediaFiles.id, single.fileId))

      const loose = await cached('Nobody Keeps This')
      await updateAcquisitionPolicy({ storageQuotaBytes: 1 })
      expect(await evictCache()).toEqual({ files: 1, bytes: MB })
      expect(await present([old.fileId, single.fileId, loose.fileId])).toEqual(expect.arrayContaining([old.fileId, single.fileId]))
      expect(await present([loose.fileId])).toEqual([])
      expect(await access(path.join(backupDir, old.relPath)).then(() => true, () => false)).toBe(true)
    } finally {
      await rm(backupDir, { recursive: true, force: true })
    }
  })

  it('deletes what a delivery brought that was not asked for, and leaves everything else', async () => {
    const asked = await cached('Asked For', 0)
    const extra = await cached('Bonus Track', 0)
    const importId = newId()
    await db.insert(imports).values({
      id: importId, kind: 'acquisition', source: 'provider:test', status: 'completed', stagingPath: path.join(rootDir, 'staging'), targetRootId: rootId,
    })
    await db.update(mediaFiles).set({ importId }).where(inArray(mediaFiles.id, [asked.fileId, extra.fileId]))
    const other = await cached('Not This Delivery', 0)

    expect(await discardUnrequested({ recordingIds: [asked.recordingId], importId })).toBe(1)
    expect((await present([asked.fileId, extra.fileId, other.fileId])).sort()).toEqual([asked.fileId, other.fileId].sort())
    expect(await onDisk(extra.relPath)).toBe(false)
    expect(await discardUnrequested({ recordingIds: [asked.recordingId], importId })).toBe(0)
  })

  it('keeps an unrequested extra that is already in use, and drops one for a track the server has', async () => {
    const fan = await createUser()
    const asked = await cached('Track One', 0)
    // The provider sent the next track too; it became playable and is now up next.
    const queuedExtra = await cached('Track Two', 0)
    await db.insert(playbackSessions).values({
      userId: fan.id, state: { state: { current: null }, queue: { queue: [{ id: 'a', trackId: queuedExtra.recordingId, albumId: null, durationMs: 1, state: 'ready' }] } },
    })
    // And a file tagged as a track the server already has.
    const owned = await createAlbum({ rootId, owned: true, mbid: crypto.randomUUID(), tracks: [{ title: 'Already Here' }] })
    const planted = await cached('Planted', 0)
    await db.update(mediaFiles).set({ recordingId: owned.tracks[0]!.recordingId }).where(eq(mediaFiles.id, planted.fileId))
    await db.insert(likes).values({ userId: fan.id, entityType: 'recording', entityId: owned.tracks[0]!.recordingId })
    const importId = newId()
    await db.insert(imports).values({ id: importId, kind: 'acquisition', source: 'provider:test', status: 'completed', stagingPath: path.join(rootDir, 'staging'), targetRootId: rootId })
    await db.update(mediaFiles).set({ importId }).where(inArray(mediaFiles.id, [asked.fileId, queuedExtra.fileId, planted.fileId]))

    expect(await discardUnrequested({ recordingIds: [asked.recordingId], importId })).toBe(1)
    expect((await present([asked.fileId, queuedExtra.fileId, planted.fileId])).sort()).toEqual([asked.fileId, queuedExtra.fileId].sort())
    expect(await present([owned.tracks[0]!.fileId!])).toHaveLength(1)
  })
})
