import { copyFile, chmod, chown, rename, stat } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { and, asc, count, eq, max } from 'drizzle-orm'
import { parseFile } from 'music-metadata'
import { File as TagFile, TagTypes } from 'node-taglib-sharp'
import { db } from '../../database/client.js'
import {
  albumArtists, albums, artists, mediaFiles, recordingArtists, recordings, releaseLoudness, releases, releaseTracks, type FileTags,
} from '../../database/schema.js'
import { audioHash } from '../../lib/ffmpeg.js'
import { fsyncPath, removeIfExists } from './files.js'

/**
 * Writing catalog tags into files.
 *
 * Library choice: node-taglib-sharp, chosen by testing it against FLAC, MP3, M4A
 * (AAC and ALAC, with the index before or after the audio), Ogg Vorbis and Opus: every
 * field below reads back through music-metadata and the audio stream hash is unchanged.
 * Other containers are refused. Every write is still verified, because a library bug
 * that damaged audio would be unrecoverable.
 */

/** Extensions whose containers passed every round-trip check. */
export const TAG_WRITABLE = new Set(['flac', 'mp3', 'm4a', 'ogg', 'opus'])

/** What gets written. MusicBrainz ids are only written when the catalog row has one. */
export type TagValues = {
  title: string
  artist: string
  album: string
  albumArtist: string
  track: number
  trackTotal: number
  disc: number
  discTotal: number
  year: number | null
  genres: string[]
  musicbrainz: {
    recordingId: string | null
    releaseId: string | null
    releaseGroupId: string | null
    /** Only the first credited artist's id: multiple ids do not round-trip the same way in every container. */
    artistId: string | null
    albumArtistId: string | null
  }
  /** From measured loudness: gains in dB, peaks linear. */
  replayGain: { trackGain: number; trackPeak: number; albumGain: number | null; albumPeak: number | null } | null
}

const REFERENCE_LUFS = -18

/** Catalog tag values for a file, or null when it is not linked to a release track and album. */
export async function catalogTagValues(fileId: string): Promise<TagValues | null> {
  const [row] = await db.select({
    loudnessLufs: mediaFiles.loudnessLufs,
    truePeakDb: mediaFiles.truePeakDb,
    releaseId: releaseTracks.releaseId,
    recordingId: recordings.id,
    disc: releaseTracks.disc,
    position: releaseTracks.position,
    title: releaseTracks.title,
    trackCredit: releaseTracks.artistCredit,
    recordingCredit: recordings.artistCredit,
    recordingMbid: recordings.mbid,
    releaseMbid: releases.mbid,
    albumId: albums.id,
    albumTitle: albums.title,
    albumCredit: albums.artistCredit,
    albumMbid: albums.mbid,
    year: albums.year,
    genres: albums.genres,
  }).from(mediaFiles)
    .innerJoin(releaseTracks, eq(releaseTracks.id, mediaFiles.releaseTrackId))
    .innerJoin(recordings, eq(recordings.id, releaseTracks.recordingId))
    .innerJoin(releases, eq(releases.id, releaseTracks.releaseId))
    .innerJoin(albums, eq(albums.id, mediaFiles.albumId))
    .where(eq(mediaFiles.id, fileId))
  if (!row) return null

  const [discs] = await db.select({ discs: max(releaseTracks.disc) }).from(releaseTracks).where(eq(releaseTracks.releaseId, row.releaseId))
  const [tracks] = await db.select({ tracks: count() }).from(releaseTracks)
    .where(and(eq(releaseTracks.releaseId, row.releaseId), eq(releaseTracks.disc, row.disc)))
  const [artist] = await db.select({ mbid: artists.mbid }).from(recordingArtists).innerJoin(artists, eq(artists.id, recordingArtists.artistId))
    .where(eq(recordingArtists.recordingId, row.recordingId)).orderBy(asc(recordingArtists.position)).limit(1)
  const [albumArtist] = await db.select({ mbid: artists.mbid }).from(albumArtists).innerJoin(artists, eq(artists.id, albumArtists.artistId))
    .where(eq(albumArtists.albumId, row.albumId)).orderBy(asc(albumArtists.position)).limit(1)
  const [albumLoudness] = await db.select().from(releaseLoudness).where(eq(releaseLoudness.releaseId, row.releaseId))

  const peak = (decibels: number) => Math.round(10 ** (decibels / 20) * 1e6) / 1e6
  const gain = (lufs: number) => Math.round((REFERENCE_LUFS - lufs) * 100) / 100
  return {
    title: row.title,
    artist: row.trackCredit ?? row.recordingCredit,
    album: row.albumTitle,
    albumArtist: row.albumCredit,
    track: row.position,
    trackTotal: tracks?.tracks ?? row.position,
    disc: row.disc,
    discTotal: discs?.discs ?? row.disc,
    year: row.year,
    genres: row.genres,
    musicbrainz: {
      recordingId: row.recordingMbid,
      releaseId: row.releaseMbid,
      releaseGroupId: row.albumMbid,
      artistId: artist?.mbid ?? null,
      albumArtistId: albumArtist?.mbid ?? null,
    },
    replayGain: row.loudnessLufs === null || row.truePeakDb === null ? null : {
      trackGain: gain(row.loudnessLufs),
      trackPeak: peak(row.truePeakDb),
      albumGain: albumLoudness ? gain(albumLoudness.loudnessLufs) : null,
      albumPeak: albumLoudness ? peak(albumLoudness.truePeakDb) : null,
    },
  }
}

/** The `media_files.tags` fields that change when these values are written. */
export function writtenFileTags(values: TagValues): Partial<FileTags> {
  return {
    title: values.title,
    artist: values.artist,
    album: values.album,
    albumArtist: values.albumArtist,
    track: values.track,
    trackTotal: values.trackTotal,
    disc: values.disc,
    discTotal: values.discTotal,
    ...(values.year ? { year: values.year } : {}),
    ...(values.genres.length > 0 ? { genres: values.genres } : {}),
    ...(values.musicbrainz.recordingId ? { mbRecordingId: values.musicbrainz.recordingId } : {}),
    ...(values.musicbrainz.releaseId ? { mbReleaseId: values.musicbrainz.releaseId } : {}),
    ...(values.musicbrainz.releaseGroupId ? { mbReleaseGroupId: values.musicbrainz.releaseGroupId } : {}),
  }
}

export type TagWriteResult =
  | { written: true; size: number; mtime: Date }
  | { written: false; reason: string }

/**
 * Writes tags into `file` without ever risking it: the tags go into a copy in the same
 * directory (`temp`), the copy is re-read and its audio stream hash compared with the
 * original's, and only then does the copy atomically replace the original. Any failed
 * check deletes the copy and leaves the original untouched.
 *
 * `expectedAudioHash`, when given, must match the original, so a file that is not the
 * one the library knows is never rewritten. Problems with the file are reported as a
 * reason, never thrown.
 */
export async function writeTags(file: string, values: TagValues, options: { temp: string; expectedAudioHash?: string | null }): Promise<TagWriteResult> {
  const extension = path.extname(file).slice(1).toLowerCase()
  if (!TAG_WRITABLE.has(extension)) return { written: false, reason: `Writing tags into .${extension} files is not supported` }
  try {
    return await writeVerified(file, values, options)
  } catch (error) {
    await removeIfExists(options.temp)
    return { written: false, reason: error instanceof TagCheckError ? error.message : `Tags could not be written (${(error as Error).message})` }
  }
}

async function writeVerified(file: string, values: TagValues, options: { temp: string; expectedAudioHash?: string | null }): Promise<TagWriteResult> {
  const before = await stat(file)
  const originalHash = await audioHash(file).catch(() => {
    throw new TagCheckError('The audio stream could not be read')
  })
  if (options.expectedAudioHash && options.expectedAudioHash !== originalHash) {
    throw new TagCheckError('The audio does not match what the library has on record')
  }

  await removeIfExists(options.temp)
  await copyFile(file, options.temp, constants.COPYFILE_EXCL)
  try {
    applyTags(options.temp, values)
  } catch (error) {
    throw new TagCheckError(`The tag library could not write this file (${(error as Error).message})`)
  }
  const mismatched = await mismatchedFields(options.temp, values)
  if (mismatched.length > 0) throw new TagCheckError(`Tags did not read back correctly: ${mismatched.join(', ')}`)
  if (await audioHash(options.temp) !== originalHash) throw new TagCheckError('Writing tags would have changed the audio')

  await chmod(options.temp, before.mode & 0o7777)
  await chown(options.temp, before.uid, before.gid).catch(() => {})
  await fsyncPath(options.temp)
  const now = await stat(file)
  if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) throw new TagCheckError('The file changed while its tags were being written')
  await rename(options.temp, file)
  await fsyncPath(path.dirname(file))
  const after = await stat(file)
  return { written: true, size: after.size, mtime: after.mtime }
}

class TagCheckError extends Error {}

function applyTags(file: string, values: TagValues) {
  const tagFile = TagFile.createFromPath(file)
  try {
    const hadId3v1 = (tagFile.tagTypesOnDisk & TagTypes.Id3v1) !== 0
    const tag = tagFile.tag
    tag.title = values.title
    tag.performers = [values.artist]
    tag.album = values.album
    tag.albumArtists = [values.albumArtist]
    tag.track = values.track
    tag.trackCount = values.trackTotal
    tag.disc = values.disc
    tag.discCount = values.discTotal
    if (values.year) tag.year = values.year
    if (values.genres.length > 0) tag.genres = values.genres
    const mb = values.musicbrainz
    if (mb.recordingId) tag.musicBrainzTrackId = mb.recordingId
    if (mb.releaseId) tag.musicBrainzReleaseId = mb.releaseId
    if (mb.releaseGroupId) tag.musicBrainzReleaseGroupId = mb.releaseGroupId
    if (mb.artistId) tag.musicBrainzArtistId = mb.artistId
    if (mb.albumArtistId) tag.musicBrainzReleaseArtistId = mb.albumArtistId
    const gain = values.replayGain
    if (gain) {
      tag.replayGainTrackGain = gain.trackGain
      tag.replayGainTrackPeak = gain.trackPeak
      if (gain.albumGain !== null && gain.albumPeak !== null) {
        tag.replayGainAlbumGain = gain.albumGain
        tag.replayGainAlbumPeak = gain.albumPeak
      }
    }
    // taglib adds an ID3v1 tag to every MP3; keep only one that was already there.
    if (!hadId3v1) tagFile.removeTags(TagTypes.Id3v1)
    tagFile.save()
  } finally {
    tagFile.dispose()
  }
}

/** Fields whose read-back value differs from what was written. */
async function mismatchedFields(file: string, values: TagValues): Promise<string[]> {
  const { common } = await parseFile(file, { duration: false, skipCovers: true })
  const mb = values.musicbrainz
  const gain = values.replayGain
  const close = (actual: number | undefined, expected: number, tolerance: number) => actual !== undefined && Math.abs(actual - expected) <= tolerance
  const checks: [string, boolean][] = [
    ['title', common.title === values.title],
    ['artist', common.artist === values.artist],
    ['album', common.album === values.album],
    ['album artist', common.albumartist === values.albumArtist],
    ['track', common.track.no === values.track && common.track.of === values.trackTotal],
    ['disc', common.disk.no === values.disc && common.disk.of === values.discTotal],
    ['year', !values.year || common.year === values.year],
    ['genre', values.genres.length === 0 || JSON.stringify(common.genre) === JSON.stringify(values.genres)],
    ['MusicBrainz recording id', !mb.recordingId || common.musicbrainz_recordingid === mb.recordingId],
    ['MusicBrainz release id', !mb.releaseId || common.musicbrainz_albumid === mb.releaseId],
    ['MusicBrainz release group id', !mb.releaseGroupId || common.musicbrainz_releasegroupid === mb.releaseGroupId],
    ['MusicBrainz artist id', !mb.artistId || common.musicbrainz_artistid?.[0] === mb.artistId],
    ['MusicBrainz album artist id', !mb.albumArtistId || common.musicbrainz_albumartistid?.[0] === mb.albumArtistId],
    ['ReplayGain track gain', !gain || close(common.replaygain_track_gain?.dB, gain.trackGain, 0.01)],
    ['ReplayGain track peak', !gain || close(common.replaygain_track_peak?.ratio, gain.trackPeak, 1e-5)],
    ['ReplayGain album gain', gain?.albumGain == null || close(common.replaygain_album_gain?.dB, gain.albumGain, 0.01)],
    ['ReplayGain album peak', gain?.albumPeak == null || close(common.replaygain_album_peak?.ratio, gain.albumPeak, 1e-5)],
  ]
  return checks.filter(([, ok]) => !ok).map(([name]) => name)
}
