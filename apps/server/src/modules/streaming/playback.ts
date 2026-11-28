import { API_PREFIX, type PlaybackDescriptor, type PlaybackQuery, type StreamProfile } from '@squirmy/contracts'
import { and, eq, isNull } from 'drizzle-orm'
import { db } from '../../database/client.js'
import { users } from '../../database/schema.js'
import { sign, verify } from '../../lib/crypto.js'
import { notFound } from '../../lib/errors.js'
import { resolveOne } from '../catalog/redirects.js'
import { normalizationFor } from '../loudness/normalization.js'
import { codecFamily, mimeFor, outputSampleRate, profiles } from './profiles.js'
import { selectFile } from './select.js'
import { readyTranscode } from './transcode.js'

/** How long a signed stream URL stays valid. */
export const STREAM_URL_TTL_MS = 12 * 60 * 60_000

/** The signed parameters of a stream URL. `exp` is in epoch seconds. */
export type StreamSignature = { exp?: string; uid?: string; sig?: string }

const signedMessage = (fileId: string, profile: StreamProfile, userId: string, exp: number) => `${fileId}\n${profile}\n${userId}\n${exp}`

/**
 * A relative stream URL for one user, valid for 12 hours. The signature binds the file,
 * the profile, the user and the expiry; `download=1` only changes the response headers.
 */
export function signStreamUrl(fileId: string, profile: StreamProfile, userId: string, options: { download?: boolean; now?: number } = {}) {
  const expiresAt = new Date((options.now ?? Date.now()) + STREAM_URL_TTL_MS)
  const exp = Math.floor(expiresAt.getTime() / 1000)
  const params = new URLSearchParams({ exp: String(exp), uid: userId, sig: sign('stream', signedMessage(fileId, profile, userId, exp)) })
  if (options.download) params.set('download', '1')
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

/**
 * `GET /tracks/:id/playback`: picks the file and profile for the recording (after following
 * merges of the recording and of `albumId`), signs a URL for `userId`, and describes what that URL will deliver. Throws 404
 * `not_available` when the recording has no present file.
 */
export async function buildPlaybackDescriptor(userId: string, recordingId: string, query: PlaybackQuery): Promise<PlaybackDescriptor> {
  // Queue entries and playlists keep ids that later lost a merge, for the album as well.
  const [target, albumId] = await Promise.all([
    resolveOne('recordings', recordingId).then((id) => id ?? recordingId),
    query.albumId ? resolveOne('albums', query.albumId).then((id) => id ?? query.albumId) : undefined,
  ])
  const selection = await selectFile(target, { albumId, codecs: query.codecs, quality: query.quality })
  if (!selection) throw notFound('No file of this track is available', 'not_available')
  const { file, profile } = selection
  const { url, expiresAt } = signStreamUrl(file.id, profile, userId, { download: query.download })
  const base = {
    trackId: recordingId,
    albumId: file.albumId,
    fileId: file.id,
    url,
    expiresAt: expiresAt.toISOString(),
    profile,
    durationMs: file.durationMs,
    normalization: await normalizationFor(file),
  }
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
      gapless: file.decodedFrames !== null && file.decodedRate !== null && file.primingFrames !== null
        ? { sampleRate: file.decodedRate, primingFrames: file.primingFrames, frames: file.decodedFrames }
        : null,
    }
  }
  const spec = profiles[profile]
  const cached = await readyTranscode(file, profile)
  return {
    ...base,
    transcoded: true,
    mime: spec.mime,
    codec: spec.codec,
    lossless: false,
    bitrate: spec.bitrate,
    sampleRate: outputSampleRate(file, profile) ?? file.sampleRate,
    bitDepth: null,
    bytes: cached?.bytes ?? null,
    gapless: null,
  }
}
