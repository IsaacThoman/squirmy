import { db } from '../database/client.js'
import {
  albumArtists, albums, artists, libraryRoots, mediaFiles, recordingArtists, recordings, releases, releaseTracks, users,
  type FileTags, type UserRole,
} from '../database/schema.js'
import { newId } from '../lib/ids.js'
import { creditKey, matchKey } from '../lib/text.js'

/**
 * Row factories for tests. They write straight to the database, so a test for the read
 * side does not have to run the scanner first.
 */

let counter = 0
const next = () => ++counter

export async function createUser(input: Partial<{ username: string; role: UserRole; canUpload: boolean; canAcquire: boolean; passwordHash: string }> = {}) {
  const username = input.username ?? `user${next()}`
  const [row] = await db.insert(users).values({
    id: newId(),
    username,
    usernameKey: username.toLowerCase(),
    passwordHash: input.passwordHash ?? 'not-a-real-hash',
    role: input.role ?? 'member',
    canUpload: input.canUpload ?? false,
    canAcquire: input.canAcquire ?? false,
  }).returning()
  return row!
}

export async function createArtist(input: Partial<{ name: string; mbid: string }> = {}) {
  const name = input.name ?? `Artist ${next()}`
  const [row] = await db.insert(artists).values({ id: newId(), name, sortName: name, nameKey: matchKey(name), mbid: input.mbid, detailLevel: 1 }).returning()
  return row!
}

export async function createLibraryRoot(input: Partial<{ name: string; path: string; mode: 'read_only' | 'managed' }> = {}) {
  const [row] = await db.insert(libraryRoots).values({
    id: newId(),
    name: input.name ?? 'Music',
    path: input.path ?? `/tmp/squirmy-root-${next()}`,
    mode: input.mode ?? 'read_only',
  }).returning()
  return row!
}

export type AlbumFactoryInput = {
  title?: string
  artist?: { id: string; name: string }
  year?: number
  type?: string
  mbid?: string
  tracks?: { title: string; durationMs?: number; mbid?: string; disc?: number }[]
  /**
   * When set, a media file is created for each track flagged here (all tracks when
   * `true`), which makes those tracks available.
   */
  owned?: boolean | number[]
  rootId?: string
  /** Where the files came from; `provider:<id>` makes them cache, which is in no library by itself. */
  source?: string
}

/** Creates an album with one release, recordings and release tracks, optionally with files. */
export async function createAlbum(input: AlbumFactoryInput = {}) {
  const artist = input.artist ?? await createArtist()
  const title = input.title ?? `Album ${next()}`
  const tracks = input.tracks ?? [{ title: 'Track One' }, { title: 'Track Two' }, { title: 'Track Three' }]
  const albumId = newId()
  const releaseId = newId()

  await db.insert(albums).values({
    id: albumId,
    mbid: input.mbid,
    title,
    artistCredit: artist.name,
    primaryArtistId: artist.id,
    type: input.type ?? 'album',
    year: input.year ?? 2024,
    releaseDate: String(input.year ?? 2024),
    titleKey: matchKey(title),
    matchKey: creditKey(artist.name, title),
    canonicalReleaseId: releaseId,
    detailLevel: 2,
  })
  await db.insert(albumArtists).values({ albumId, position: 0, artistId: artist.id, creditedName: artist.name })
  const ownedIndexes = input.owned === true ? tracks.map((_, index) => index) : Array.isArray(input.owned) ? input.owned : []
  // A track list with tracks nobody has a file for came from a source, and the library keeps
  // it as it is; one built from files only lists tracks that have one.
  const fetchedAt = ownedIndexes.length < tracks.length ? new Date() : null
  await db.insert(releases).values({ id: releaseId, albumId, title, releaseDate: String(input.year ?? 2024), trackCount: tracks.length, detailLevel: 2, fetchedAt })
  const rootId = ownedIndexes.length > 0 ? input.rootId ?? (await createLibraryRoot()).id : undefined
  const positions = new Map<number, number>()
  const created: { recordingId: string; releaseTrackId: string; fileId: string | null; title: string; durationMs: number }[] = []

  for (const [index, track] of tracks.entries()) {
    const disc = track.disc ?? 1
    const position = (positions.get(disc) ?? 0) + 1
    positions.set(disc, position)
    const recordingId = newId()
    const releaseTrackId = newId()
    const durationMs = track.durationMs ?? 180_000 + index * 1000
    await db.insert(recordings).values({
      id: recordingId,
      mbid: track.mbid,
      title: track.title,
      artistCredit: artist.name,
      primaryArtistId: artist.id,
      durationMs,
      titleKey: matchKey(track.title),
      matchKey: creditKey(artist.name, track.title),
    })
    await db.insert(recordingArtists).values({ recordingId, position: 0, artistId: artist.id, creditedName: artist.name })
    await db.insert(releaseTracks).values({ id: releaseTrackId, releaseId, disc, position, recordingId, title: track.title, durationMs })

    let fileId: string | null = null
    if (rootId && ownedIndexes.includes(index)) {
      fileId = newId()
      const tags: FileTags = { title: track.title, artist: artist.name, album: title, albumArtist: artist.name, track: position, disc }
      await db.insert(mediaFiles).values({
        id: fileId,
        rootId,
        relPath: `${artist.name}/${title}/${String(position).padStart(2, '0')} ${track.title}.flac`,
        size: 1_000_000,
        mtime: new Date(),
        container: 'flac',
        codec: 'flac',
        lossless: true,
        bitrate: 900_000,
        sampleRate: 44_100,
        bitDepth: 16,
        channels: 2,
        durationMs,
        tags,
        recordingId,
        releaseTrackId,
        releaseId,
        albumId,
        matchStatus: 'unmatched',
        matchSource: 'tags',
        probeStage: 1,
        source: input.source,
      })
    }
    created.push({ recordingId, releaseTrackId, fileId, title: track.title, durationMs })
  }

  return { albumId, releaseId, artist, title, tracks: created, rootId: rootId ?? null }
}
