/** Media retrieval: stream, download, cover art and lyrics. */
import { ART_SIZES, type ArtSize } from '@squirmy/contracts'
import { sql } from 'drizzle-orm'
import { db } from '../../../database/client.js'
import { AppError } from '../../../lib/errors.js'
import { matchKey } from '../../../lib/text.js'
import { readOriginal } from '../../artwork/recover.js'
import { rendition } from '../../artwork/renditions.js'
import { trackLyrics } from '../../catalog/pages.js'
import { openStream, selectFile } from '../../streaming/index.js'
import { streamSignal } from '../../streaming/files.js'
import { profiles } from '../../streaming/profiles.js'
import { expectId } from '../ids.js'
import { notFound, sent, type Context, type Handler, type Payload } from '../protocol.js'
import { hasPresentFile, servableArt } from '../sql.js'
import { exactLength, liveEncode, liveMime, planStream } from '../transcode.js'
import { resolve } from './browsing.js'

function rangeHeaders(context: Context) {
  const { request } = context
  return { range: request.headers.range, ifRange: [request.headers['if-range']].flat()[0], head: request.method === 'HEAD' }
}

async function stream(context: Context): Promise<typeof sent> {
  const { params, reply } = context
  const recordingId = await resolve('track', expectId(params.required('id'), 'track').id)
  const selection = await selectFile(recordingId, { quality: 'original' })
  if (!selection) throw notFound('Song')
  const { file } = selection
  const plan = planStream(file, {
    format: params.string('format'),
    maxBitRateKbps: params.int('maxBitRate', 0, { min: 0 }),
    timeOffsetSeconds: params.int('timeOffset', 0, { min: 0 }),
  })
  const estimate = params.bool('estimateContentLength') === true
  const remainingSeconds = (bitrate: number, offset = 0) => Math.max(0, file.durationMs / 1000 - offset) * bitrate / 8

  if (plan.kind === 'live') {
    const headers: Record<string, string> = { 'content-type': liveMime(plan.codec), 'accept-ranges': 'none', 'cache-control': 'private' }
    const bytes = estimate ? Math.ceil(remainingSeconds(plan.bitrate, plan.offsetSeconds)) : undefined
    if (bytes !== undefined) headers['content-length'] = String(bytes)
    // Started before any header is set, so a refusal (no free encoder) is a Subsonic error.
    const body = context.request.method === 'HEAD' ? null : await liveEncode(file, plan, context.user.id)
    reply.code(200).headers(headers)
    if (!body) await reply.send()
    else await reply.send(bytes === undefined ? body : exactLength(body, bytes))
    return sent
  }

  const profile = plan.kind === 'profile' ? plan.profile : 'original'
  const response = await openStream(file, profile, {
    ...rangeHeaders(context),
    userId: context.user.id,
    signal: profile === 'original' ? undefined : streamSignal(reply.raw),
  })
  let body = response.body
  if (estimate && profile !== 'original' && response.headers['content-length'] === undefined) {
    const bytes = Math.ceil(remainingSeconds(profiles[profile].bitrate))
    response.headers['content-length'] = String(bytes)
    if (body) body = exactLength(body, bytes)
  }
  reply.code(response.status).headers(response.headers)
  await reply.send(body ?? undefined)
  return sent
}

async function download(context: Context): Promise<typeof sent> {
  const { params, reply } = context
  const recordingId = await resolve('track', expectId(params.required('id'), 'track').id)
  const selection = await selectFile(recordingId, { quality: 'original' })
  if (!selection) throw notFound('Song')
  const response = await openStream(selection.file, 'original', { ...rangeHeaders(context), download: true })
  reply.code(response.status).headers(response.headers)
  await reply.send(response.body ?? undefined)
  return sent
}

/**
 * The artwork asset an id leads to. `ca-` ids name an asset; album, artist, song and
 * playlist ids (which older clients send) lead to that entity's picture.
 */
async function artworkAsset(value: string): Promise<string | null> {
  const parsed = expectId(value, 'cover', 'album', 'artist', 'track', 'playlist')
  let query
  switch (parsed.kind) {
    case 'cover':
      return parsed.id
    case 'album':
      query = sql`select ${servableArt('artwork_asset_id')} as id from albums where id = ${await resolve('album', parsed.id)}`
      break
    case 'artist':
      query = sql`select ${servableArt('image_asset_id')} as id from artists where id = ${await resolve('artist', parsed.id)}`
      break
    case 'track':
      query = sql`
        select picture.id from media_files f left join albums a on a.id = f.album_id
        cross join lateral (select coalesce(${servableArt('a.artwork_asset_id')}, ${servableArt('f.embedded_art_asset_id')}) as id) picture
        where f.recording_id = ${await resolve('track', parsed.id)} and f.missing_since is null
        order by picture.id is null, f.lossless desc, f.added_at desc limit 1`
      break
    case 'playlist':
      query = sql`
        select ${servableArt('a.artwork_asset_id')} as id from playlist_items i join albums a on a.id = i.album_id
        where i.playlist_id = ${parsed.id} and ${servableArt('a.artwork_asset_id')} is not null order by i.position limit 1`
      break
  }
  const [row] = await db.execute<{ id: string | null }>(query)
  return row?.id ?? null
}

async function getCoverArt({ params, reply }: Context): Promise<typeof sent> {
  const value = params.required('id')
  const assetId = await artworkAsset(value)
  if (!assetId) throw notFound('Cover art')
  const size = params.int('size', 0, { min: 0 })
  // A `ca-` id names immutable bytes; other ids may lead to a new picture later. Only an
  // image is cacheable: a missing original may be rebuilt soon.
  const cacheControl = value.startsWith('ca-') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600'
  try {
    if (size === 0) {
      const { asset, bytes } = await readOriginal(assetId)
      await reply.header('cache-control', cacheControl).type(asset.mime ?? 'application/octet-stream').send(bytes)
    } else {
      const rendered: ArtSize = ART_SIZES.find((candidate) => candidate >= size) ?? ART_SIZES.at(-1)!
      const image = await rendition(assetId, rendered)
      await reply.header('cache-control', cacheControl).type('image/webp').send(image)
    }
  } catch (error) {
    if (error instanceof AppError && error.status === 404) throw notFound('Cover art')
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw notFound('Cover art')
    throw error
  }
  return sent
}

/** LRC timestamps (`[mm:ss.xx]`, several per line allowed) as lines in time order, and the `[offset:]` tag. */
export function parseLrc(text: string): { lines: { start: number; value: string }[]; offset: number } {
  const lines: { start: number; value: string }[] = []
  let offset = 0
  for (const raw of text.split(/\r?\n/)) {
    const tag = /^\s*\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw)
    if (tag) offset = Number(tag[1])
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)]
    if (stamps.length === 0) continue
    const value = raw.replace(/\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]/g, '').trim()
    for (const [, minutes, secondsPart, fraction] of stamps) {
      const ms = fraction ? Number(fraction.padEnd(3, '0')) : 0
      lines.push({ start: Number(minutes) * 60_000 + Number(secondsPart) * 1000 + ms, value })
    }
  }
  return { lines: lines.sort((a, b) => a.start - b.start), offset }
}

async function getLyricsBySongId({ params }: Context): Promise<Payload> {
  const recordingId = await resolve('track', expectId(params.required('id'), 'track').id)
  const [info] = await db.execute<{ title: string; artistCredit: string }>(sql`
    select title, artist_credit as "artistCredit" from recordings where id = ${recordingId}`)
  const lyrics = await trackLyrics(recordingId).catch((error: unknown) => {
    if (error instanceof AppError && error.status === 404) return null
    throw error
  })
  const display = { displayArtist: info?.artistCredit, displayTitle: info?.title, lang: 'und' }
  const structured: Payload[] = []
  if (lyrics?.synced) {
    const { lines, offset } = parseLrc(lyrics.synced)
    if (lines.length > 0) structured.push({ ...display, offset: offset || undefined, synced: true, line: lines })
  }
  if (structured.length === 0 && lyrics?.plain) {
    structured.push({ ...display, synced: false, line: lyrics.plain.split(/\r?\n/).map((value) => ({ value })) })
  }
  return { lyricsList: { structuredLyrics: structured } }
}

/** Classic getLyrics: plain lyrics of an owned song found by artist and title. */
async function getLyrics({ params }: Context): Promise<Payload> {
  const artist = params.string('artist')
  const title = params.string('title')
  if (!title) return { lyrics: { artist, title } }
  const [row] = await db.execute<{ plain: string | null; synced: string | null; artist: string; title: string }>(sql`
    select l.plain, l.synced, r.artist_credit as artist, r.title from recordings r join lyrics l on l.recording_id = r.id
    where r.title_key = ${matchKey(title)} and r.merged_into_id is null and (l.plain is not null or l.synced is not null)
      ${artist ? sql`and split_part(r.match_key, '|', 1) = ${matchKey(artist)}` : sql``}
      and ${hasPresentFile('recording_id', 'r.id')}
    limit 1`)
  if (!row) return { lyrics: { artist, title } }
  const value = row.plain ?? parseLrc(row.synced!).lines.map((line) => line.value).join('\n')
  return { lyrics: { artist: row.artist, title: row.title, value } }
}

export const mediaEndpoints: Record<string, Handler> = {
  stream,
  download,
  getCoverArt,
  getLyrics,
  getLyricsBySongId,
}
