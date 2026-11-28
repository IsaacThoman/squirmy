import type { PlaybackQuery, StreamProfile, StreamQuality } from '@squirmy/contracts'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { mediaFiles } from '../../database/schema.js'
import { codecFamily, parseCodecs, profiles, type LegacyProfile, type MediaFile } from './profiles.js'

/** Transcode profiles in order of preference for each quality; the first the client decodes wins. */
const preference: Record<StreamQuality, LegacyProfile[]> = {
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
type Source = Pick<MediaFile, 'codec' | 'container' | 'relPath' | 'lossless' | 'bitrate'>
type Delivery = Pick<PlaybackQuery, 'containers' | 'engine'>

export function chooseProfile(file: Source, quality: StreamQuality, codecs: ReadonlySet<string>, delivery: Delivery = {}): StreamProfile {
  if (delivery.containers === 'fmp4') return chooseFragmentedProfile(file, quality, codecs, delivery.engine)
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

function chooseFragmentedProfile(file: Source, quality: StreamQuality, codecs: ReadonlySet<string>, engine: Delivery['engine']): StreamProfile {
  const opus = codecs.has('opus')
  const mse = engine === 'mse' || (engine === undefined && !opus)
  const family = codecFamily(file)
  let direct: StreamProfile | undefined
  if (!mse && codecs.has(family)) direct = 'original'
  if (mse) {
    if (family === 'mp3' && codecs.has('mp3_mp4')) direct = 'copy_mp4'
    else if (family === 'mp3' && codecs.has('mp3')) direct = 'original'
    else if ((family === 'aac' || family === 'flac') && codecs.has(family)) direct = 'copy_mp4'
  }
  if (quality === 'original') {
    if (direct) return direct
    if (file.lossless && codecs.has('flac')) return 'flac_mp4'
  }
  const target = mse || !opus
    ? (mse && quality === 'data_saver' ? 'aac_mp4_128' : 'aac_mp4_256')
    : (quality === 'data_saver' ? 'opus_mp4_96' : 'opus_mp4_192')
  if (direct && !file.lossless && file.bitrate && file.bitrate <= profiles[target].bitrate) return direct
  // Some MSE clients only advertise FLAC and an MPEG byte stream.
  if (codecs.has(profiles[target].codec)) return target
  if (codecs.has('flac')) return 'flac_mp4'
  if (direct) return direct
  return target
}

export type FileSelection = { file: MediaFile; profile: StreamProfile }

/**
 * Picks the file to play for a recording and the profile to serve it with. Among present
 * files: those on `albumId` first, then lossless, then higher bitrate. Null when the
 * recording has no present file.
 */
export async function selectFile(recordingId: string, options: { albumId?: string; codecs?: string; quality: StreamQuality } & Delivery): Promise<FileSelection | null> {
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
  return { file, profile: chooseProfile(file, options.quality, parseCodecs(options.codecs), options) }
}
