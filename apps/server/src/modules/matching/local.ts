/**
 * Local-only catalog rows built from file tags, for "Unmatch" and "forget this match".
 * The library module builds the same kind of rows when files first arrive; these are
 * always new rows, so the MusicBrainz rows the files leave keep their user data.
 */
import path from 'node:path'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import type { Executor } from '../../database/client.js'
import {
  albumArtists, albums, artists, mediaFiles, recordingArtists, recordings, releases, releaseTracks, type FileTags,
} from '../../database/schema.js'
import { newId } from '../../lib/ids.js'
import { creditKey, matchKey } from '../../lib/text.js'

type LocalFile = Pick<typeof mediaFiles.$inferSelect, 'id' | 'rootId' | 'groupKey' | 'relPath' | 'durationMs' | 'tags'>

/** The most common non-empty value, first seen winning ties. */
export function majority<T>(values: (T | null | undefined)[]): T | null {
  const counts = new Map<T, number>()
  for (const value of values) if (value !== null && value !== undefined && value !== '') counts.set(value, (counts.get(value) ?? 0) + 1)
  let best: T | null = null
  let bestCount = 0
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value
      bestCount = count
    }
  }
  return best
}

/** The album artist the tags imply: the tag itself, "Various Artists" for compilations, or the track artist. */
export function taggedAlbumArtist(tags: FileTags[]): string | null {
  const albumArtist = majority(tags.map((tag) => tag.albumArtist?.trim()))
  if (albumArtist) return albumArtist
  const trackArtists = new Set(tags.map((tag) => tag.artist?.trim()).filter(Boolean))
  if (tags.some((tag) => tag.compilation) || trackArtists.size > Math.max(2, tags.length / 2)) return 'Various Artists'
  return majority(tags.map((tag) => tag.artist?.trim()))
}

async function localArtist(tx: Executor, name: string): Promise<string> {
  const key = matchKey(name)
  const [existing] = await tx.select({ id: artists.id }).from(artists)
    .where(and(eq(artists.nameKey, key), isNull(artists.mbid), isNull(artists.mergedIntoId))).limit(1)
  if (existing) return existing.id
  const [row] = await tx.insert(artists).values({ id: newId(), name, sortName: name, nameKey: key }).returning({ id: artists.id })
  return row!.id
}

/**
 * Builds a local-only artist, album, release, recordings and release tracks for each
 * group of `files` and links the files to them. Link columns only; the caller sets the
 * match status.
 */
export async function buildLocalRows(tx: Executor, files: LocalFile[]): Promise<void> {
  const groups = new Map<string, LocalFile[]>()
  for (const file of files) {
    const key = `${file.rootId}\n${file.groupKey ?? ''}`
    groups.set(key, [...(groups.get(key) ?? []), file])
  }
  for (const group of groups.values()) {
    const tags = group.map((file) => file.tags)
    const artistName = taggedAlbumArtist(tags) ?? 'Unknown Artist'
    const title = majority(tags.map((tag) => tag.album?.trim())) ?? 'Unknown Album'
    const year = majority(tags.map((tag) => tag.year))
    const artistId = await localArtist(tx, artistName)
    const albumId = newId()
    const releaseId = newId()
    const discs = Math.max(1, ...tags.map((tag) => tag.disc ?? 1))
    await tx.insert(albums).values({
      id: albumId,
      title,
      artistCredit: artistName,
      primaryArtistId: artistId,
      type: tags.some((tag) => tag.compilation) ? 'compilation' : 'album',
      year,
      releaseDate: year === null ? null : String(year),
      titleKey: matchKey(title),
      matchKey: creditKey(artistName, title),
      canonicalReleaseId: releaseId,
      detailLevel: 1,
    })
    await tx.insert(albumArtists).values({ albumId, position: 0, artistId, creditedName: artistName })
    await tx.insert(releases).values({ id: releaseId, albumId, title, releaseDate: year === null ? null : String(year), trackCount: group.length, discCount: discs, detailLevel: 1 })

    const taken = new Set<string>()
    const ordered = [...group].sort((a, b) => (a.tags.disc ?? 1) - (b.tags.disc ?? 1) || (a.tags.track ?? 999) - (b.tags.track ?? 999) || a.relPath.localeCompare(b.relPath))
    for (const file of ordered) {
      const disc = file.tags.disc ?? 1
      let position = file.tags.track ?? 1
      while (taken.has(`${disc}:${position}`)) position++
      taken.add(`${disc}:${position}`)
      const trackTitle = file.tags.title?.trim() || path.parse(file.relPath).name
      const trackArtist = file.tags.artist?.trim() || artistName
      const trackArtistId = trackArtist === artistName ? artistId : await localArtist(tx, trackArtist)
      const recordingId = newId()
      const releaseTrackId = newId()
      const durationMs = file.durationMs || null
      await tx.insert(recordings).values({
        id: recordingId,
        title: trackTitle,
        artistCredit: trackArtist,
        primaryArtistId: trackArtistId,
        durationMs,
        isrcs: file.tags.isrcs ?? [],
        titleKey: matchKey(trackTitle),
        matchKey: creditKey(trackArtist, trackTitle),
      })
      await tx.insert(recordingArtists).values({ recordingId, position: 0, artistId: trackArtistId, creditedName: trackArtist })
      await tx.insert(releaseTracks).values({ id: releaseTrackId, releaseId, disc, position, recordingId, title: trackTitle, artistCredit: trackArtist, durationMs })
      await tx.update(mediaFiles).set({ recordingId, releaseTrackId, releaseId, albumId, updatedAt: new Date() }).where(eq(mediaFiles.id, file.id))
    }
  }
}

/** Files linked to an album, read for building local rows. */
export async function filesOfAlbum(tx: Executor, albumId: string) {
  return tx.select().from(mediaFiles).where(and(eq(mediaFiles.albumId, albumId), isNull(mediaFiles.missingSince)))
}

/** Deletes local-only releases no file points at any more; their tracks go with them. */
export async function deleteOrphanLocalReleases(tx: Executor, releaseIds: string[]) {
  if (releaseIds.length === 0) return
  const used = await tx.selectDistinct({ id: mediaFiles.releaseId }).from(mediaFiles).where(inArray(mediaFiles.releaseId, releaseIds))
  const keep = new Set(used.map((row) => row.id))
  const orphans = releaseIds.filter((id) => !keep.has(id))
  if (orphans.length > 0) await tx.delete(releases).where(and(inArray(releases.id, orphans), isNull(releases.mbid)))
}
