import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseFile, type ILyricsTag } from 'music-metadata'
import { db } from '../../database/client.js'
import { lyrics } from '../../database/schema.js'

export type Lyrics = { synced: string | null; plain: string | null }

const timestamp = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g
const timedLine = /^\s*(?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+/
const metadataLine = /^\s*\[[a-z#]+:.*\]\s*$/i

/**
 * Reads lyrics text. It is synced LRC when most lines that carry text start with a
 * `[mm:ss.xx]` timestamp; the plain version then has timestamps and LRC header lines
 * (`[ar:…]`, `[ti:…]`) removed.
 */
export function parseLyricsText(text: string): Lyrics | null {
  const normalized = text.replace(/\r\n?/g, '\n').trim()
  if (!normalized) return null
  const lines = normalized.split('\n').filter((line) => line.trim() && !metadataLine.test(line))
  const timed = lines.filter((line) => timedLine.test(line)).length
  if (timed === 0 || timed < lines.length / 2) return { synced: null, plain: normalized }
  const plain = lines.map((line) => line.replace(timestamp, '').trim()).join('\n').trim()
  return { synced: normalized, plain: plain || null }
}

const lrcTime = (ms: number) => {
  const minutes = Math.floor(ms / 60_000)
  const seconds = (ms % 60_000) / 1000
  return `[${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}]`
}

// music-metadata's TimestampFormat: 2 is milliseconds; MPEG frame counts are not usable.
const milliseconds = 2

/** The best of a file's embedded lyrics: synced first. */
export function lyricsFromTags(tags: readonly ILyricsTag[] | undefined): Lyrics | null {
  let best: Lyrics | null = null
  for (const tag of tags ?? []) {
    const synced = tag.timeStampFormat === milliseconds && tag.syncText?.length > 0
      ? tag.syncText.map((line) => `${lrcTime(line.timestamp ?? 0)}${line.text}`).join('\n')
      : null
    const candidate = synced ? { synced, plain: tag.text?.trim() || tag.syncText.map((line) => line.text).join('\n') } : parseLyricsText(tag.text ?? '')
    if (candidate && (!best || (candidate.synced && !best.synced))) best = candidate
  }
  return best
}

/**
 * Lyrics for an audio file: a same-named `.lrc` next to it, or lyrics embedded in its
 * tags (read only when the probe saw some). Synced beats plain; on a tie the sidecar wins.
 */
export async function readFileLyrics(file: string, embedded: boolean): Promise<(Lyrics & { source: 'sidecar' | 'embedded' }) | null> {
  const stem = file.slice(0, file.length - path.extname(file).length)
  const sidecarText = await readFile(`${stem}.lrc`, 'utf8').catch(() => readFile(`${stem}.LRC`, 'utf8')).catch(() => null)
  const sidecar = sidecarText === null ? null : parseLyricsText(sidecarText.replace(/^﻿/, ''))
  if (sidecar?.synced || !embedded) return sidecar && { ...sidecar, source: 'sidecar' }
  const metadata = await parseFile(file, { skipCovers: true }).catch(() => null)
  const fromTags = lyricsFromTags(metadata?.common.lyrics)
  if (fromTags && (!sidecar || fromTags.synced)) return { ...fromTags, source: 'embedded' }
  return sidecar && { ...sidecar, source: 'sidecar' }
}

/** Stores a recording's lyrics from its file. Local lyrics replace anything fetched online. */
export async function storeLyrics(recordingId: string, found: Lyrics & { source: string }) {
  const values = { synced: found.synced, plain: found.plain, source: found.source, instrumental: false, fetchedAt: new Date() }
  await db.insert(lyrics).values({ recordingId, ...values }).onConflictDoUpdate({ target: lyrics.recordingId, set: values })
}
