/**
 * Audio for share pages. A song plays through a short-lived URL whose key is the share, the
 * file, what to serve and an expiry, sealed with AES-GCM (`encrypt('share-stream', …)`): the
 * page learns no file id, and the key cannot be altered or made up. Every request also checks
 * that the link is still live, that the operator's playback mode still allows what the key
 * asks for, and that the song is still in the shared item, so revoking a link, turning
 * sharing off or switching to previews stops URLs already handed out.
 */
import { API_PREFIX, SHARE_PREVIEW_MS, type SharePlayback, type ShareTrackPlayback, type StreamProfile } from '@squirmy/contracts'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { db } from '../../database/client.js'
import { mediaFiles } from '../../database/schema.js'
import { decrypt, encrypt } from '../../lib/crypto.js'
import { AppError, forbidden, notFound } from '../../lib/errors.js'
import { getServerSettings } from '../../lib/settings.js'
import { explicitAllowed, fileExplicit } from '../catalog/explicit.js'
import { resolveMerged } from '../catalog/redirects.js'
import { mimeFor, profiles, selectFile } from '../streaming/index.js'
import { shareForId, shareNotFound, shareTrack, shareTracks, type ShareRow } from './links.js'
import { PREVIEW_MIME } from './preview.js'

/**
 * How long a song's URL works. Long enough for a long track's seeks and Range requests; the
 * link itself is checked on each of them, so this only bounds a copied URL.
 */
export const SHARE_STREAM_TTL_MS = 3 * 60 * 60_000

/** What a key serves: a whole-file profile, or the server-cut preview. */
export type ShareStreamProfile = StreamProfile | 'preview'

const StreamKey = z.object({ s: z.uuid(), f: z.uuid(), p: z.string(), e: z.number().int() })
export type ShareStreamKey = { shareId: string; fileId: string; profile: ShareStreamProfile; expiresAt: number }

export function sealStreamKey(key: ShareStreamKey): string {
  return encrypt('share-stream', JSON.stringify({ s: key.shareId, f: key.fileId, p: key.profile, e: key.expiresAt }))
}

/** The key's contents, or null for anything that is not an intact, unexpired key. */
export function openStreamKey(sealed: string, now = Date.now()): ShareStreamKey | null {
  let parsed
  try {
    parsed = StreamKey.safeParse(JSON.parse(decrypt('share-stream', sealed)))
  } catch {
    return null
  }
  if (!parsed.success || parsed.data.e <= now) return null
  return { shareId: parsed.data.s, fileId: parsed.data.f, profile: parsed.data.p as ShareStreamProfile, expiresAt: parsed.data.e }
}

const songUnavailable = () => notFound('This song is not available', 'not_available')

/**
 * A link plays only what its creator may: explicit content turned off for them (their own
 * setting or an admin's) keeps explicit files off their links, URLs already handed out
 * included. The answer is the one for any song that does not play, so a stranger learns
 * nothing about the account.
 */
async function assertSharerAllows(share: ShareRow, file: { tags: { explicit?: boolean } | null; recordingId: string | null }) {
  if (await fileExplicit(file) && !await explicitAllowed(share.userId)) throw songUnavailable()
}

const playbackOff = () => new AppError(403, 'share_playback_off', 'This server does not play shared music')

/** `GET /share/:token/tracks/:id/playback` for a live link. */
export async function shareTrackPlayback(share: ShareRow, trackId: string, codecs: string | undefined): Promise<ShareTrackPlayback> {
  const { sharePlayback } = await getServerSettings()
  if (sharePlayback === 'off') throw playbackOff()
  const ref = await shareTrack(share, trackId)
  if (!ref) throw notFound('This song is not on the shared page', 'not_available')
  // The creator's version picks: the page plays the copies they would hear.
  const selection = await selectFile(trackId, { albumId: ref.albumId ?? undefined, codecs, quality: 'high', userId: share.userId })
  if (!selection) throw songUnavailable()
  const { file } = selection
  await assertSharerAllows(share, file)
  const preview = sharePlayback === 'previews'
  const profile: ShareStreamProfile = preview ? 'preview' : selection.profile
  const expiresAt = Date.now() + SHARE_STREAM_TTL_MS
  const key = sealStreamKey({ shareId: share.id, fileId: file.id, profile, expiresAt })
  return {
    url: `${API_PREFIX}/share/stream?key=${key}`,
    expiresAt: new Date(expiresAt).toISOString(),
    mime: preview ? PREVIEW_MIME : profile === 'original' ? mimeFor(file) : profiles[profile as keyof typeof profiles].mime,
    preview,
    durationMs: preview ? Math.min(file.durationMs, SHARE_PREVIEW_MS) : file.durationMs,
  }
}

/** Whether the operator's mode lets a key of this profile play. */
export function modeAllows(mode: SharePlayback, profile: ShareStreamProfile): boolean {
  if (mode === 'off') return false
  return mode === 'full' || profile === 'preview'
}

/**
 * The file a stream key may play right now, with the live link it belongs to. Throws 404 for
 * a key that is not intact or has expired, a link that no longer works, or a song no longer
 * in the shared item; 403 when the operator's mode no longer allows what the key asks for.
 */
export async function authorizeShareStream(sealed: string) {
  const key = openStreamKey(sealed)
  if (!key) throw shareNotFound()
  const share = await shareForId(key.shareId)
  const { sharePlayback } = await getServerSettings()
  if (sharePlayback === 'off') throw playbackOff()
  if (!modeAllows(sharePlayback, key.profile)) throw forbidden('This server plays only previews of shared music', 'share_previews_only')
  const [file] = await db.select().from(mediaFiles).where(eq(mediaFiles.id, key.fileId))
  if (!file?.recordingId || file.missingSince) throw songUnavailable()
  await assertSharerAllows(share, file)
  const refs = await shareTracks(share)
  const current = await resolveMerged('recordings', refs.map((ref) => ref.id))
  if (!refs.some((ref) => (current.get(ref.id) ?? ref.id) === file.recordingId)) throw songUnavailable()
  return { share, file, profile: key.profile }
}
