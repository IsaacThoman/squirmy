/** `225000` → `3:45`; an hour or more → `1:02:05`. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = String(total % 60).padStart(2, '0')
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`
}

/** A collection's length in words: `34 min`, `1 hr 12 min`. */
export function formatTotalDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60000))
  const hours = Math.floor(minutes / 60)
  return hours ? `${hours} hr ${minutes % 60} min` : `${minutes} min`
}

export function plural(count: number, one: string, many = `${one}s`): string {
  return `${count.toLocaleString()} ${count === 1 ? one : many}`
}

export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value.toFixed(value < 10 && unit > 0 ? 1 : 0)} ${units[unit]}`
}

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

export function formatDate(iso: string): string {
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
