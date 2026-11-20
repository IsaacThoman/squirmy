import type { StreamProfile, StreamQuality } from '@squirmy/contracts'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { mediaFiles } from '../../database/schema.js'
import { codecFamily, parseCodecs, profiles, type MediaFile, type TranscodeProfile } from './profiles.js'

/** Transcode profiles in order of preference for each quality; the first the client decodes wins. */
const preference: Record<StreamQuality, TranscodeProfile[]> = {
  original: ['aac_256', 'mp3_320', 'opus_128', 'mp3_192'],
  high: ['aac_256', 'mp3_320', 'opus_128', 'mp3_192'],
  data_saver: ['opus_128', 'mp3_192', 'aac_256', 'mp3_320'],
}

/**
 * What to serve for `file` at `quality` to a client that decodes `codecs`.
 *
 * - `original` serves the file when the client decodes its codec.
 * - Otherwise the target is the first profile in the quality's preference list the client
 *   decodes: AAC 256k for `original` and `high`, Opus 128k or else MP3 192k for `data_saver`.
 * - A lossy file the client decodes at or below the target bitrate is served as is.
 * - A lossy file below the target that still needs a transcode gets the smallest playable
 *   profile at or above its own bitrate, so no bits are spent that the source never had.
 */
export function chooseProfile(file: Pick<MediaFile, 'codec' | 'container' | 'relPath' | 'lossless' | 'bitrate'>, quality: StreamQuality, codecs: ReadonlySet<string>): StreamProfile {
  const plays = codecs.has(codecFamily(file))
  if (plays && quality === 'original') return 'original'
  const ranked = preference[quality]
  const playable = ranked.filter((profile) => codecs.has(profiles[profile].codec))
  const target = playable[0] ?? ranked[0]!
  const targetBitrate = profiles[target].bitrate
  if (file.lossless || !file.bitrate || file.bitrate > targetBitrate) return target
  if (plays) return 'original'
  const source = file.bitrate
  const enough = playable.filter((profile) => profiles[profile].bitrate >= source && profiles[profile].bitrate <= targetBitrate)
  return enough.sort((a, b) => profiles[a].bitrate - profiles[b].bitrate)[0] ?? target
}

export type FileSelection = { file: MediaFile; profile: StreamProfile }

/**
 * Picks the file to play for a recording and the profile to serve it with. Among present
 * files: those on `albumId` first, then lossless, then higher bitrate. Null when the
 * recording has no present file.
 */
export async function selectFile(recordingId: string, options: { albumId?: string; codecs?: string; quality: StreamQuality }): Promise<FileSelection | null> {
  const [file] = await db.select().from(mediaFiles)
    .where(and(eq(mediaFiles.recordingId, recordingId), isNull(mediaFiles.missingSince)))
    .orderBy(
      ...(options.albumId ? [desc(sql`${mediaFiles.albumId} is not distinct from ${options.albumId}`)] : []),
      desc(mediaFiles.lossless),
      sql`${mediaFiles.bitrate} desc nulls last`,
      desc(mediaFiles.addedAt),
    )
    .limit(1)
  if (!file) return null
  return { file, profile: chooseProfile(file, options.quality, parseCodecs(options.codecs)) }
}
