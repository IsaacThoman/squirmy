import { z } from 'zod'
import { Artwork } from './catalog.js'
import { Id, IsoDateTime, page } from './common.js'

/** What a share link points at. */
export const ShareKind = z.enum(['album', 'playlist', 'track'])
export type ShareKind = z.infer<typeof ShareKind>

/**
 * What a share page may play, set by the operator (`ServerSettings.sharePlayback`): `off` shows
 * the page without audio, `previews` the first `SHARE_PREVIEW_MS` of each song, `full` the songs.
 */
export const SharePlayback = z.enum(['off', 'previews', 'full'])
export type SharePlayback = z.infer<typeof SharePlayback>

/** Length of a share preview. The server cuts the audio itself, so a client cannot ask for more. */
export const SHARE_PREVIEW_MS = 30_000

/**
 * How long a new link lasts. `never` lasts until its creator or an admin revokes it, the
 * creator's account is disabled or deleted, the item goes away, or the operator turns sharing off.
 */
export const ShareExpiry = z.enum(['1d', '7d', '30d', 'never'])
export type ShareExpiry = z.infer<typeof ShareExpiry>

/** Most links one account may hold, expired ones included until they are cleaned up. */
export const SHARE_LIMIT = 500

/** `POST /me/shares`. A playlist must be one the creator can see: theirs, or public. */
export const CreateShareRequest = z.object({
  kind: ShareKind,
  id: Id,
  /** For a track: the album it was shared from, which decides its cover and file. */
  albumId: Id.nullable().optional(),
  expiresIn: ShareExpiry.default('7d'),
})
export type CreateShareRequest = z.infer<typeof CreateShareRequest>

/**
 * A link, as its creator (`GET /me/shares`) and admins (`GET /admin/shares`) see it. The token is
 * stored only as a hash, so `url` is only on the answer to `POST /me/shares`.
 */
export const ShareLink = z.object({
  id: Id,
  kind: ShareKind,
  /** The album, playlist or track it points at. */
  targetId: Id,
  title: z.string(),
  /** The album's or track's artist; null for a playlist. */
  subtitle: z.string().nullable(),
  artwork: Artwork.nullable(),
  createdAt: IsoDateTime,
  /** Null for a link that does not expire. */
  expiresAt: IsoDateTime.nullable(),
  expired: z.boolean(),
  /** How many times the public page was opened. */
  openCount: z.number().int().nonnegative(),
  lastOpenedAt: IsoDateTime.nullable(),
  /** Who made it. Only admins' lists carry it. */
  createdBy: z.object({ id: Id, username: z.string() }).optional(),
  /** The page's path on this server, `/s/<token>`: only on create, the one time the token exists. */
  url: z.string().optional(),
})
export type ShareLink = z.infer<typeof ShareLink>

export const ShareLinkPage = page(ShareLink)
export type ShareLinkPage = z.infer<typeof ShareLinkPage>

/** One song on a share page. Nothing about who shared it, and no file or library details. */
export const PublicShareTrack = z.object({
  /** The track (recording) id, which `GET /share/:token/tracks/:id/playback` takes. */
  id: Id,
  title: z.string(),
  artistCredit: z.string(),
  /** The album it is shown from; null on an album's own page, where it is the album. */
  albumTitle: z.string().nullable(),
  artwork: Artwork.nullable(),
  /** 0 when unknown. */
  durationMs: z.number().int().nonnegative(),
  disc: z.number().int().nullable(),
  position: z.number().int().nullable(),
  explicit: z.boolean().nullable(),
  /** False when the server has no file of it: the page shows it as unavailable. */
  available: z.boolean(),
}).strict()
export type PublicShareTrack = z.infer<typeof PublicShareTrack>

/**
 * `GET /share/:token`, without a session: what the public page shows and nothing else. A
 * playlist shows its current songs, not a copy taken when the link was made.
 */
export const PublicShare = z.object({
  kind: ShareKind,
  title: z.string(),
  /** The album's or track's artist credit; null for a playlist. */
  artistCredit: z.string().nullable(),
  year: z.number().int().nullable(),
  artwork: Artwork.nullable(),
  durationMs: z.number().int().nonnegative(),
  tracks: z.array(PublicShareTrack),
  playback: SharePlayback,
  expiresAt: IsoDateTime.nullable(),
  /** The operator's name for the server, which the page names as where the music is from. */
  serverName: z.string(),
}).strict()
export type PublicShare = z.infer<typeof PublicShare>

/** `GET /share/:token/tracks/:id/playback`. */
export const ShareTrackQuery = z.object({
  /** Codecs the browser decodes, as for `GET /tracks/:id/playback`; only used for `full`. */
  codecs: z.string().max(200).optional(),
})
export type ShareTrackQuery = z.infer<typeof ShareTrackQuery>

/**
 * A short-lived URL that plays one song of a share. It names neither the file nor the share:
 * it is opaque, and the server checks the link is still live on every request.
 */
export const ShareTrackPlayback = z.object({
  url: z.string(),
  expiresAt: IsoDateTime,
  mime: z.string(),
  /** True when the URL plays only the first `SHARE_PREVIEW_MS`. */
  preview: z.boolean(),
  /** What the URL plays: the preview's length, or the whole song's. */
  durationMs: z.number().int().nonnegative(),
}).strict()
export type ShareTrackPlayback = z.infer<typeof ShareTrackPlayback>
