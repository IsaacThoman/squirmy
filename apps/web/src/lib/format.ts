import { formatReleaseDate } from '@squirmy/client-core'

// One set of formatters for both apps, so a length reads the same on the web and on iOS.
export { formatBytes, formatDuration, formatReleaseDate, formatRemaining, formatTotalDuration, plural } from '@squirmy/client-core'

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' })
const steps: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60],
]

/** `2 days ago`, `just now`. `now` is injectable so tests and screenshots stay stable. */
export function formatRelative(iso: string, now = Date.now()): string {
  const seconds = (new Date(iso).getTime() - now) / 1000
  for (const [unit, size] of steps) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit)
  }
  return 'just now'
}

/**
 * " · Active 3 hours ago" for a device last seen (epoch ms) a while ago: what tells apart
 * two devices of the same name, such as a tab left open on another computer. Nothing for
 * one in use now, or from a server that does not say.
 */
export function formatIdle(lastSeenAt: number | undefined, now = Date.now()): string {
  if (lastSeenAt === undefined || now - lastSeenAt < 5 * 60_000) return ''
  return ` · Active ${formatRelative(new Date(lastSeenAt).toISOString(), now)}`
}

/** `12:40 PM` for a time today, `Nov 21, 12:40 PM` for an earlier day. */
export function formatClock(iso: string, now = Date.now()): string {
  const date = new Date(iso)
  const today = date.toDateString() === new Date(now).toDateString()
  return date.toLocaleString('en', { ...(today ? {} : { month: 'short', day: 'numeric' }), hour: 'numeric', minute: '2-digit' })
}

/**
 * `Nov 21, 2026`. A date without a time (`2026-11-05`, `1985`) is a calendar date and is
 * printed as written; only a timestamp is shown in the viewer's time zone.
 */
export function formatDate(iso: string): string {
  if (/^\d{4}(-\d{2}){0,2}$/.test(iso)) return formatReleaseDate(iso) ?? iso
  return new Date(iso).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })
}

const GIB = 1024 ** 3
const MIB = 1024 ** 2
const scaled = (unit: number) => ({
  format: (bytes: unknown) => String(Math.round((Number(bytes) / unit) * 10) / 10),
  parse: (text: string) => (text.trim() ? Math.round(Number(text) * unit) : Number.NaN),
})

/** Byte sizes edited in GB or MB, to one decimal: the `format` and `parse` of a settings field. */
export const inGigabytes = scaled(GIB)
export const inMegabytes = scaled(MIB)
