import type { PlaybackQuery, StreamProfile, StreamQuality } from '@squirmy/contracts'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { mediaFiles } from '../../database/schema.js'
import { filePreferences } from '../catalog/versions.js'
import { codecFamily, outputBitDepth, outputSampleRate, parseCodecs, profiles, type LegacyProfile, type MediaFile } from './profiles.js'

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

export type FileSelection = {
  file: MediaFile
  profile: StreamProfile
  /** The version the file is of (`catalog/versions.ts`), when it is on an album. */
  versionId: string | null
}

/** What reaches the client from `file` as `profile`: lossless or not, and how fine. */
function delivered(file: MediaFile, profile: StreamProfile) {
  if (profile === 'original') return { lossless: file.lossless, fineness: file.lossless ? (file.sampleRate ?? 0) * (file.bitDepth ?? 16) : file.bitrate ?? 0 }
  const lossless = profile === 'flac_mp4' || (profile === 'copy_mp4' && file.lossless)
  if (lossless) return { lossless, fineness: (outputSampleRate(file, profile) ?? 0) * (outputBitDepth(file, profile) ?? 16) }
  const spec = profiles[profile]
  return { lossless, fineness: 'bitrate' in spec && spec.bitrate ? spec.bitrate : file.bitrate ?? 0 }
}

/**
 * Picks the file to play for a recording and the profile to serve it with. Among present
 * files, in order: the one in the user's pick for the song; those on `albumId`; those in
 * the user's pick for their own album; the best the client receives (lossless first, then
 * finer, then the file as it is over a transcode); then lossless, higher bitrate, newest.
 * The album comes before quality so a hi-res single never takes over a song mid-album.
 * See docs/architecture.md, "Editions and versions". Null when the recording has no
 * present file.
 */
export async function selectFile(
  recordingId: string,
  options: { albumId?: string; codecs?: string; quality: StreamQuality; userId?: string } & Delivery,
): Promise<FileSelection | null> {
  const files = await db.select().from(mediaFiles)
    .where(and(eq(mediaFiles.recordingId, recordingId), isNull(mediaFiles.missingSince)))
    .orderBy(desc(mediaFiles.lossless), sql`${mediaFiles.bitrate} desc nulls last`, desc(mediaFiles.addedAt), mediaFiles.id)
  if (files.length === 0) return null
  const codecs = parseCodecs(options.codecs)
  const preferences = await filePreferences(options.userId, recordingId, files.map((file) => file.id))
  const ranked = files.map((file, order) => {
    const profile = chooseProfile(file, options.quality, codecs, options)
    const preference = preferences.get(file.id)
    const reaches = delivered(file, profile)
    const key = [
      preference?.songPick ? 0 : 1,
      options.albumId && file.albumId !== options.albumId ? 1 : 0,
      preference?.albumPick ? 0 : 1,
      reaches.lossless ? 0 : 1,
      -reaches.fineness,
      profile === 'original' ? 0 : 1,
      // The query's order: lossless, higher bitrate, newest.
      order,
    ]
    return { file, profile, key, versionId: preference?.versionId ?? null }
  })
  ranked.sort((a, b) => {
    for (let index = 0; index < a.key.length; index++) if (a.key[index] !== b.key[index]) return a.key[index]! - b.key[index]!
    return 0
  })
  const { file, profile, versionId } = ranked[0]!
  return { file, profile, versionId }
}
