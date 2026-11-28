import { createReadStream } from 'node:fs'
import { pipeline, Readable } from 'node:stream'
import { JSONParser, type ParsedElementInfo } from '@streamparser/json-node'
import { parse } from 'csv-parse'
import { z } from 'zod'
import type { HistoryImportSource } from '@squirmy/contracts'

const Text = z.string().trim().min(1).max(1000).refine(value => !value.includes('\0'))
const optionalText = (value: unknown) => Text.safeParse(value).data ?? null
const Milliseconds = z.number().int().min(0).max(2_147_483_647)
const ListenBrainz = z.object({
  listened_at: z.number().int(),
  track_metadata: z.object({
    track_name: Text,
    artist_name: Text,
    release_name: z.unknown(),
    additional_info: z.object({ duration_played_ms: z.unknown(), duration_played: z.unknown() }).optional(),
  }),
})
const Spotify = z.object({
  ts: z.iso.datetime({ offset: true }),
  ms_played: Milliseconds,
  master_metadata_track_name: Text,
  master_metadata_album_artist_name: Text,
  master_metadata_album_album_name: z.unknown(),
  spotify_track_uri: z.string().regex(/^spotify:track:[A-Za-z0-9]+$/).max(100).nullish(),
})

export type ImportedListen = {
  startedAt: Date
  title: string
  artist: string
  album: string | null
  msPlayed: number | null
  sourceTrack: string | null
}

function dateOf(value: number): Date | null {
  return Number.isFinite(value) && value >= Date.UTC(1900, 0, 1) && value <= Date.now() ? new Date(value) : null
}

export function parseListen(source: HistoryImportSource, value: unknown): ImportedListen | null {
  if (source === 'listenbrainz') {
    const row = ListenBrainz.safeParse(value).data
    if (!row) return null
    const startedAt = dateOf(row.listened_at * 1000)
    if (!startedAt) return null
    const { artist_name: artist, track_name: title, release_name, additional_info: info } = row.track_metadata
    const seconds = typeof info?.duration_played === 'number' ? info.duration_played * 1000 : undefined
    const msPlayed = Milliseconds.safeParse(info?.duration_played_ms).data ?? Milliseconds.safeParse(seconds).data ?? null
    return { startedAt, title, artist, album: optionalText(release_name), msPlayed, sourceTrack: null }
  }
  if (source === 'spotify') {
    const row = Spotify.safeParse(value).data
    if (!row) return null
    const startedAt = dateOf(Date.parse(row.ts) - row.ms_played)
    if (!startedAt) return null
    return {
      startedAt, title: row.master_metadata_track_name, artist: row.master_metadata_album_artist_name,
      album: optionalText(row.master_metadata_album_album_name), msPlayed: row.ms_played, sourceTrack: row.spotify_track_uri ?? null,
    }
  }
  const row = z.array(z.string()).safeParse(value).data
  if (!row) return null
  const [rawArtist, rawAlbum, rawTitle, rawTime] = row
  const artist = optionalText(rawArtist)
  const title = optionalText(rawTitle)
  const time = rawTime?.trim() ?? ''
  // The common export uses UTC (either Unix seconds or "29 May 2013 21:15").
  const timestamp = /^\d{9,10}$/.test(time) ? Number(time) * 1000
    : /^\d{1,2} [a-z]{3} \d{4},? \d{2}:\d{2}(:\d{2})?$/i.test(time) ? Date.parse(`${time} UTC`)
      : z.iso.datetime({ offset: true }).safeParse(time).success ? Date.parse(time) : NaN
  const startedAt = dateOf(timestamp)
  return startedAt && title && artist ? { startedAt, title, artist, album: optionalText(rawAlbum), msPlayed: null, sourceTrack: null } : null
}

function csvColumns(row: string[]): number[] | null {
  const names = row.map(value => value.trim().toLowerCase())
  const indices = [
    names.indexOf('artist'), names.indexOf('album'),
    names.findIndex(name => name === 'track' || name === 'title'),
    names.findIndex(name => ['timestamp', 'uts', 'date'].includes(name)),
  ]
  return indices.every(index => index >= 0) ? indices : null
}

export class HistoryFormatError extends Error {}

export async function* readListens(file: string, source: HistoryImportSource, jsonLines: boolean) {
  const input = createReadStream(file, { highWaterMark: 16 * 1024 })
  const chunks = input.iterator()
  let prefix: Buffer | undefined
  let array = false
  if (source !== 'lastfm') {
    for (;;) {
      const chunk = await chunks.next()
      if (chunk.done) break
      const firstCharacter = (chunk.value as Buffer).toString().trimStart()[0]
      if (firstCharacter === undefined) continue
      prefix = Buffer.from((chunk.value as Buffer).toString().startsWith('﻿') ? chunk.value.subarray(3) : chunk.value)
      array = firstCharacter === '['
      break
    }
  }
  async function* contents() {
    try {
      if (prefix) yield prefix
      yield* chunks
    } finally {
      input.destroy()
    }
  }
  const parser = source === 'lastfm' ? parse({ bom: true, relax_column_count: true, skip_empty_lines: true, max_record_size: 64 * 1024 })
    : new JSONParser({
      paths: array ? ['$.*'] : jsonLines ? ['$'] : ['$.payload.listens.*', '$.listens.*'],
      keepStack: false,
      ...(!array && jsonLines && { separator: '' }),
    })
  const stream = pipeline(Readable.from(contents()), parser, () => {})
  let first = true
  let columns: number[] | null = null
  try {
    for await (const value of stream as AsyncIterable<string[] | ParsedElementInfo>) {
      if (Array.isArray(value)) {
        if (first) columns = csvColumns(value)
        if (!first || !columns) yield parseListen(source, columns?.map(index => value[index] ?? '') ?? value)
        first = false
      } else if ((!array && jsonLines) || Array.isArray(value.parent)) {
        yield parseListen(source, value.value)
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new HistoryFormatError('The uploaded file is missing')
    if ((error as NodeJS.ErrnoException).syscall) throw error
    throw new HistoryFormatError('The file contains invalid JSON or CSV')
  } finally {
    stream.destroy()
  }
}
