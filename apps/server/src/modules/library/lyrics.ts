import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { parseLrc, stripWordStamps } from '@squirmy/client-core'
import type { Lyrics as ServedLyrics } from '@squirmy/contracts'
import { parseFile, type ILyricsTag } from 'music-metadata'
import { db } from '../../database/client.js'
import { lyrics } from '../../database/schema.js'

export type Lyrics = { synced: string | null; plain: string | null }

const timestamp = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g
const timedLine = /^\s*(?:\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\])+/
const metadataLine = /^\s*\[[a-z#]+:.*\]\s*$/i
const wordStamp = /<\d{1,3}:\d{2}(?:[.:]\d{1,3})?>/g

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
  // Enhanced LRC's word stamps (`<mm:ss.xx>`) go from the plain text too.
  const plain = lines.map((line) => line.replace(timestamp, '').replace(wordStamp, '').replace(/\s{2,}/g, ' ').trim()).join('\n').trim()
  return { synced: normalized, plain: plain || null }
}

const clock = (ms: number) => {
  const hundredths = Math.round(ms / 10)
  const minutes = Math.floor(hundredths / 6000)
  const seconds = (hundredths % 6000) / 100
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(2).padStart(5, '0')}`
}
const lrcTime = (ms: number) => `[${clock(ms)}]`
const wordTime = (ms: number) => `<${clock(ms)}>`

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (text: string) => text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
  if (name[0] === '#') return String.fromCodePoint(name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1)))
  return entities[name.toLowerCase()] ?? whole
})
const attribute = (attributes: string, name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`).exec(attributes)?.slice(1).find((value) => value !== undefined)

/** A TTML time (`00:01:02.5`, `01:02.5`, `62.5s`, `62500ms`) in milliseconds, or null. */
function ttmlTime(value: string | undefined): number | null {
  if (!value) return null
  const unit = /^([\d.]+)(h|m|s|ms)$/.exec(value.trim())
  if (unit) return Number(unit[1]) * { h: 3_600_000, m: 60_000, s: 1000, ms: 1 }[unit[2] as 'h' | 'm' | 's' | 'ms']
  const parts = value.trim().split(':').map(Number)
  if (!parts.length || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) return null
  return parts.reduce((total, part) => total * 60 + part, 0) * 1000
}

/**
 * TTML lyrics (as Apple Music's are written, with a `<span begin end>` per word or only a
 * `<p begin>` per line) as Enhanced LRC, the one form lyrics are kept in. Background vocals
 * (`ttm:role="x-bg"`) are left out; a translation, in the line (`x-translation`) or in the head's
 * `<translations>` by line key, becomes a second line at the same time. Null when nothing is timed.
 */
export function ttmlToLrc(xml: string): string | null {
  const translations = new Map<string, string>()
  for (const [, key, text] of xml.matchAll(/<text\b[^>]*?\bfor\s*=\s*"([^"]+)"[^>]*>([\s\S]*?)<\/text>/g)) {
    translations.set(key!, decode(text!.replace(/<[^>]+>/g, '')).trim())
  }
  const out: string[] = []
  for (const [, attributes, body] of xml.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/g)) {
    const begin = ttmlTime(attribute(attributes!, 'begin'))
    if (begin === null) continue
    // Each piece of text belongs to the innermost span around it; `roles` says which spans to leave out.
    const stack: { begin: number | null; end: number | null; role: string | undefined }[] = []
    const words: { startMs: number; endMs: number | null; text: string }[] = []
    let line = ''
    let translation = ''
    for (const [, closing, tag, tagAttributes, text] of body!.matchAll(/<(\/?)(span|br)\b([^>]*?)\/?>|([^<]+)/g)) {
      if (tag === 'br') { line += ' '; continue }
      if (tag) {
        if (closing) stack.pop()
        else stack.push({ begin: ttmlTime(attribute(tagAttributes!, 'begin')), end: ttmlTime(attribute(tagAttributes!, 'end')), role: attribute(tagAttributes!, 'ttm:role') })
        continue
      }
      const piece = decode(text!).replace(/\s+/g, ' ')
      const roles = stack.map((span) => span.role)
      if (roles.includes('x-bg')) continue
      if (roles.includes('x-translation') || roles.includes('x-roman')) { translation += piece; continue }
      line += piece
      const timed = stack.findLast((span) => span.begin !== null)
      if (timed && piece.trim()) words.push({ startMs: timed.begin!, endMs: timed.end, text: piece })
      else if (words.length) words.at(-1)!.text += piece
    }
    const text = line.replace(/\s+/g, ' ').trim()
    if (words.length) {
      const last = words.at(-1)!
      out.push(lrcTime(begin) + words.map((word) => `${wordTime(word.startMs)}${word.text}`).join('').trimEnd() + (last.endMs === null ? '' : wordTime(last.endMs)))
    } else out.push(lrcTime(begin) + text)
    const key = attribute(attributes!, 'itunes:key')
    const second = translation.replace(/\s+/g, ' ').trim() || (key ? translations.get(key) : undefined)
    if (second && second !== text) out.push(lrcTime(begin) + second)
  }
  return out.length ? out.join('\n') : null
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
 * Lyrics for an audio file: a same-named `.lrc` (or timed `.ttml`) next to it, or lyrics embedded in its
 * tags (read only when the probe saw some). Synced beats plain; on a tie the sidecar wins.
 */
export async function readFileLyrics(file: string, embedded: boolean): Promise<(Lyrics & { source: 'sidecar' | 'embedded' }) | null> {
  const stem = file.slice(0, file.length - path.extname(file).length)
  const sidecarText = await readFile(`${stem}.lrc`, 'utf8').catch(() => readFile(`${stem}.LRC`, 'utf8')).catch(() => null)
  let sidecar = sidecarText === null ? null : parseLyricsText(sidecarText.replace(/^﻿/, ''))
  if (!sidecar?.synced) {
    const ttml = await readFile(`${stem}.ttml`, 'utf8').catch(() => readFile(`${stem}.TTML`, 'utf8')).catch(() => null)
    const timed = ttml === null ? null : ttmlToLrc(ttml)
    if (timed) sidecar = parseLyricsText(timed)
  }
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

/**
 * A stored row as clients get it. The row keeps its lyrics as they came, Enhanced LRC's word
 * stamps included; `synced` goes out with line stamps only, so a client that reads only lines
 * shows the words without them, and `lines` carries the words' times and the translations.
 */
export function servedLyrics(row: Omit<ServedLyrics, 'lines'>): ServedLyrics {
  if (!row.synced) return { ...row, plain: row.plain && stripWordStamps(row.plain) }
  return { ...row, synced: stripWordStamps(row.synced), plain: row.plain && stripWordStamps(row.plain), lines: parseLrc(row.synced) }
}
