import { z } from 'zod'
import { AlbumSummary, Artwork, TrackSummary } from './catalog.js'
import { Id, IsoDateTime } from './common.js'

export const ReplayPeriod = z.enum(['week', 'month', 'year', 'all', 'review'])
export type ReplayPeriod = z.infer<typeof ReplayPeriod>

const TimeZone = z.string().max(100).refine((value) => {
  if (!/^[a-z][a-z0-9_+/-]*$/i.test(value)) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value })
    return true
  } catch {
    return false
  }
}, 'Use an IANA time zone')

/** GET /me/replay. Calendar periods are interpreted in tz. Weeks start Monday. */
export const ReplayQuery = z.object({
  period: ReplayPeriod.default('month'),
  year: z.coerce.number().int().min(1900).max(9998).optional(),
  tz: TimeZone.default('UTC'),
}).refine((query) => query.period !== 'review' || query.year !== undefined, { path: ['year'], message: 'Choose a review year' })
export type ReplayQuery = z.infer<typeof ReplayQuery>

const Totals = z.object({ plays: z.number().int(), msPlayed: z.number() })
const Window = z.object({ start: IsoDateTime.nullable(), end: IsoDateTime })
const Rank = Totals.extend({
  key: z.string(),
  id: Id.nullable(),
  name: z.string(),
  artist: z.string().nullable(),
})
export const ReplayStats = z.object({
  window: Window,
  previous: Totals.extend(Window.shape).nullable(),
  totals: Totals.extend({ tracks: z.number().int(), artists: z.number().int(), albums: z.number().int() }),
  tracks: z.array(Rank.extend({ track: TrackSummary.nullable() })),
  artists: z.array(Rank.extend({ image: Artwork.nullable() })),
  albums: z.array(Rank.extend({ album: AlbumSummary.nullable() })),
  genres: z.array(Rank),
  clock: z.array(Totals.extend({ weekday: z.number().int().min(1).max(7), hour: z.number().int().min(0).max(23) })),
  streak: z.object({ current: z.number().int(), longest: z.number().int() }),
  discoveries: z.object({
    count: z.number().int(),
    artists: z.array(z.object({ key: z.string(), id: Id.nullable(), name: z.string(), firstPlayedAt: IsoDateTime })),
  }),
  firstYear: z.number().int().nullable(),
})
export type ReplayStats = z.infer<typeof ReplayStats>

export const HistoryExportQuery = z.object({ format: z.enum(['json', 'csv']).default('json') })
export type HistoryExportFormat = z.infer<typeof HistoryExportQuery>['format']

// Exported as a streaming JSON array or the equivalent CSV columns.
export const HistoryExportEntry = z.object({
  id: Id,
  startedAt: IsoDateTime,
  title: z.string(),
  artist: z.string(),
  album: z.string().nullable(),
  recordingId: Id.nullable(),
  albumId: Id.nullable(),
  msPlayed: z.number().int().nullable(),
  completed: z.boolean().nullable(),
  skipped: z.boolean(),
  source: z.string(),
  contextType: z.string().nullable(),
  contextId: z.string().nullable(),
})
export type HistoryExportEntry = z.infer<typeof HistoryExportEntry>

/** One file sent as multipart/form-data to POST /me/history/imports. */
export const HistoryImportSource = z.enum(['listenbrainz', 'lastfm', 'spotify'])
export type HistoryImportSource = z.infer<typeof HistoryImportSource>
export const HistoryImportQuery = z.object({ source: HistoryImportSource })
export const HISTORY_IMPORT_MAX_BYTES = 128 * 1024 ** 2
export const HistoryImport = z.object({
  id: Id,
  source: HistoryImportSource,
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  createdAt: IsoDateTime,
  processed: z.number().int(),
  matched: z.number().int(),
  unmatched: z.number().int(),
  duplicates: z.number().int(),
  ignored: z.number().int(),
  error: z.string().nullable(),
})
export type HistoryImport = z.infer<typeof HistoryImport>
export const HistoryImports = z.object({ items: z.array(HistoryImport) })
export type HistoryImports = z.infer<typeof HistoryImports>
