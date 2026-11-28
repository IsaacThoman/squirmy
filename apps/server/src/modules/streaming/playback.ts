import { API_PREFIX, type PlaybackDescriptor, type PlaybackQuery, type PlaybackTiming, type StreamIntent, type StreamProfile } from '@squirmy/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { users } from '../../database/schema.js'
import { sign, verify } from '../../lib/crypto.js'
import { notFound } from '../../lib/errors.js'
import { assertFileAllowed } from '../catalog/explicit.js'
import { resolveOne } from '../catalog/redirects.js'
import { normalizationFor } from '../loudness/normalization.js'
import { versionPicker } from '../sessions/versions.js'
import { fileTimings } from '../sonic/index.js'
import { fragmentedSourceFrames } from './gapless.js'
import { codecFamily, fragmentedEncoder, isFragmented, mimeFor, outputBitDepth, outputSampleRate, parseCodecs, profiles } from './profiles.js'
import { selectFile } from './select.js'
import { readyTranscode } from './transcode.js'

/** How long a signed stream URL stays valid. */
export const STREAM_URL_TTL_MS = 12 * 60 * 60_000

/** The signed parameters of a stream URL. `exp` is in epoch seconds. */
export type StreamSignature = { exp?: string; uid?: string; sig?: string }

const signedMessage = (fileId: string, profile: StreamProfile, userId: string, exp: number) => `${fileId}\n${profile}\n${userId}\n${exp}`

/**
 * A relative stream URL for one user, valid for 12 hours. The signature binds the file,
 * the profile, the user and the expiry. Download and scheduling hints can be added separately.
 */
export function signStreamUrl(fileId: string, profile: StreamProfile, userId: string, options: { download?: boolean; intent?: StreamIntent; now?: number } = {}) {
  const expiresAt = new Date((options.now ?? Date.now()) + STREAM_URL_TTL_MS)
  const exp = Math.floor(expiresAt.getTime() / 1000)
  const params = new URLSearchParams({ exp: String(exp), uid: userId, sig: sign('stream', signedMessage(fileId, profile, userId, exp)) })
  if (options.download) params.set('download', '1')
  if (options.intent) params.set('intent', options.intent)
  const suffix = profile === 'original' ? '' : `/${profile}`
  return { url: `${API_PREFIX}/stream/${fileId}${suffix}?${params}`, expiresAt: new Date(exp * 1000) }
}

/**
 * The user a stream signature was issued to, when it is intact, unexpired, for this file
 * and profile, and the user is still enabled. Null otherwise.
 */
export async function verifyStreamSignature(fileId: string, profile: StreamProfile, { exp, uid, sig }: StreamSignature): Promise<string | null> {
  const expiry = Number(exp)
  if (!uid || !sig || !Number.isInteger(expiry) || expiry * 1000 <= Date.now()) return null
  if (!verify('stream', signedMessage(fileId, profile, uid, expiry), sig)) return null
  const [user] = await db.select({ id: users.id }).from(users).where(and(eq(users.id, uid), isNull(users.disabledAt)))
  return user?.id ?? null
}

/** The file's timing from its sonic analysis (the sonic module's `fileTimings`), or null when it is not analysed. */
async function playbackTiming(recordingId: string, fileId: string): Promise<PlaybackTiming | null> {
  const found = (await fileTimings([recordingId])).get(fileId)
  if (!found || found.audibleEndMs === null) return null
  return { bpm: found.bpm, beatOffsetMs: found.beatOffsetMs, audibleStartMs: found.audibleStartMs, audibleEndMs: found.audibleEndMs, introEndMs: found.introEndMs, outroStartMs: found.outroStartMs }
}

/**
 * `GET /tracks/:id/playback`: picks the file and profile for the recording (after following
 * merges of the recording and of `albumId`; the user's version picks first, see `selectFile`), signs a URL for `userId`, and describes what that URL will deliver. Throws 404
 * `not_available` when the recording has no present file, and 403 `explicit_not_allowed` for
 * an explicit file the user does not allow.
 */
export async function buildPlaybackDescriptor(userId: string, recordingId: string, query: PlaybackQuery): Promise<PlaybackDescriptor> {
  // Queue entries and playlists keep ids that later lost a merge, for the album as well.
  const [target, albumId] = await Promise.all([
    resolveOne('recordings', recordingId).then((id) => id ?? recordingId),
    query.albumId ? resolveOne('albums', query.albumId).then((id) => id ?? query.albumId) : undefined,
  ])
  // A jam's members play the host's version of its songs (`versionPicker`).
  const selection = await selectFile(target, { ...query, albumId, userId: versionPicker(userId, recordingId) })
  if (!selection) throw notFound('No file of this track is available', 'not_available')
  const { file, profile, versionId } = selection
  await assertFileAllowed(userId, file)
  const { url, expiresAt } = signStreamUrl(file.id, profile, userId, query)
  const [normalization, timing] = await Promise.all([normalizationFor(file), playbackTiming(target, file.id)])
  const base = {
    trackId: recordingId,
    albumId: file.albumId,
    fileId: file.id,
    url,
    expiresAt: expiresAt.toISOString(),
    profile,
    durationMs: file.durationMs,
    normalization,
    timing,
    source: {
      codec: codecFamily(file),
      lossless: file.lossless,
      bitrate: file.bitrate,
      sampleRate: file.sampleRate,
      bitDepth: file.bitDepth,
      channels: file.channels,
      bytes: file.size,
      ...(versionId ? { versionId } : {}),
    },
  }
  const frames = isFragmented(profile) ? await fragmentedSourceFrames(file) : file.decodedFrames
  const sourceGapless = frames !== null && file.decodedRate !== null && file.primingFrames !== null
    ? { sampleRate: file.decodedRate, primingFrames: file.primingFrames, frames }
    : null
  if (profile === 'original') {
    return {
      ...base,
      transcoded: false,
      mime: mimeFor(file),
      codec: codecFamily(file),
      lossless: file.lossless,
      bitrate: file.bitrate,
      sampleRate: file.sampleRate,
      bitDepth: file.bitDepth,
      bytes: file.size,
      gapless: sourceGapless,
      transcodeReason: null,
    }
  }
  const spec = profiles[profile]
  const encoder = fragmentedEncoder(profile)
  const cached = await readyTranscode(file, profile)
  const sampleRate = outputSampleRate(file, profile)
  const gapless = profile === 'copy_mp4' ? sourceGapless : encoder && sourceGapless && sampleRate
    ? {
        sampleRate,
        primingFrames: encoder.primingFrames,
        frames: Math.ceil(sourceGapless.frames * sampleRate / sourceGapless.sampleRate),
      }
    : null
  return {
    ...base,
    transcoded: true,
    mime: spec.mime,
    codec: 'codec' in spec ? spec.codec : base.source.codec,
    lossless: profile === 'flac_mp4' || (profile === 'copy_mp4' && file.lossless),
    bitrate: 'bitrate' in spec ? spec.bitrate : file.bitrate,
    sampleRate,
    bitDepth: outputBitDepth(file, profile),
    bytes: cached?.bytes ?? null,
    gapless,
    transcodeReason: profile === 'copy_mp4' ? null : parseCodecs(query.codecs).has(base.source.codec) && query.quality !== 'original' ? 'quality' : 'codec',
  }
}
