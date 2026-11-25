import type { AlbumType } from '@squirmy/contracts'

/**
 * A track time as `m:ss`, e.g. `3:07`. Minutes are not wrapped into hours (`75:00`).
 * Negative and non-finite input counts as 0; partial seconds are dropped.
 */
export function formatDuration(ms: number): string {
  const seconds = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * Time left, as shown at the right of a scrubber: `−1:23` (with a Unicode minus sign).
 * Rounded up to the second, so it reaches `−0:00` only at the very end (rounded down, the
 * last second of every track would read `−0:00`), and elapsed plus remaining always make
 * the whole length.
 */
export function formatRemaining(positionMs: number, durationMs: number): string {
  const left = Math.max(0, durationMs - positionMs)
  return `−${formatDuration(Math.ceil(left / 1000) * 1000)}`
}

/**
 * A total length for album and playlist headers, rounded to whole minutes and at least
 * one: `42 min`, `1 hr 5 min`, `2 hr`.
 */
export function formatTotalDuration(ms: number): string {
  const minutes = Math.max(1, Math.round((Number.isFinite(ms) ? ms : 0) / 60000))
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `${rest} min`
  return rest ? `${hours} hr ${rest} min` : `${hours} hr`
}

/**
 * A count and its noun, with the digits grouped as the device's language groups them:
 * `1 song`, `1,234 songs`. One rule for web and iOS.
 */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

/**
 * How many songs a list has and how long they last, for a list that loads a page at a time:
 * `1,234 songs · 3 hr` once every page is in, `60+ songs` until then (a total from the pages
 * loaded so far would undercount both). `separator` joins the two (`, ` on web).
 */
export function songCountLabel(count: number, { complete = true, durationMs, separator = ' · ' }: {
  complete?: boolean; durationMs: number; separator?: string
}): string {
  if (!complete) return `${count.toLocaleString()}+ songs`
  return `${plural(count, 'song')}${separator}${formatTotalDuration(durationMs)}`
}

const byteUnits = ['B', 'KB', 'MB', 'GB', 'TB']

/**
 * A size in 1024s, one decimal under ten: `512 B`, `2.4 KB`, `118 MB`, `1.2 GB`. A gigabyte
 * here is 1024³ bytes, as the size limits are.
 */
export function formatBytes(bytes: number): string {
  let value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0
  let unit = 0
  while (value >= 1024 && unit < byteUnits.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${byteUnits[unit]}`
}

/** A gigabyte as sizes are shown and limits are set: 1024³ bytes. */
export const GIGABYTE = 1024 ** 3

const albumTypes: Record<AlbumType, string> = {
  album: 'Album', ep: 'EP', single: 'Single', compilation: 'Compilation', live: 'Live', soundtrack: 'Soundtrack', other: 'Release',
}

/** A release type as a word: `Album`, `EP`, `Soundtrack`; `other` reads `Release`. */
export function albumTypeLabel(type: AlbumType): string {
  return albumTypes[type]
}

/**
 * What a release tile on an artist page says under its title: its year and type
 * (`2021 · Album`), or the type alone when the year is not known. One rule for web and iOS.
 */
export function releaseSubtitle(album: { year: number | null; type: AlbumType }): string {
  return [album.year, albumTypeLabel(album.type)].filter(Boolean).join(' · ')
}

const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/**
 * A release date as stored (`2021`, `2021-11` or `2021-11-22`) for an album page:
 * `Nov 22, 2021`, `Nov 2021` or `2021`. Read as written, not as a moment in time, so it is the
 * same date in every time zone and a partial date is not given a day it does not have.
 * Anything else comes back null.
 */
export function formatReleaseDate(date: string): string | null {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/.exec(date)
  if (!match) return null
  const [, year, month, day] = match
  const name = month ? months[Number(month) - 1] : undefined
  if (!name) return year!
  return day && Number(day) >= 1 && Number(day) <= 31 ? `${name} ${Number(day)}, ${year}` : `${name} ${year}`
}
