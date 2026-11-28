import { z } from 'zod'
import { Id } from './common.js'

const text = z.string().trim().max(500)
const number = z.number().int().min(1).max(9999).nullable()
const names = z.array(text.min(1)).max(40)

export const editableCreditRoles = ['composer', 'lyricist', 'arranger', 'producer'] as const
export const AlbumTagPatch = z.object({
  album: text,
  albumArtist: text,
  date: z.string().regex(/^(?:18|19|20|21)\d{2}(?:-(?:0[1-9]|1[0-2])(?:-(?:0[1-9]|[12]\d|3[01]))?)?$/).refine(date => {
    if (date.length !== 10) return true
    const parsed = new Date(date)
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(date)
  }, 'Enter a valid date').nullable(),
  genres: names,
  compilation: z.boolean(),
  discTotal: number,
}).partial()
export type AlbumTagPatch = z.infer<typeof AlbumTagPatch>

export const TrackTagPatch = z.object({
  title: text,
  artist: text,
  track: number,
  disc: number,
  composer: names,
  lyricist: names,
  arranger: names,
  producer: names,
}).partial()
export type TrackTagPatch = z.infer<typeof TrackTagPatch>

export const TagEdit = z.object({
  album: AlbumTagPatch,
  tracks: z.array(z.object({ id: Id, revision: z.string(), tags: TrackTagPatch })).min(1).max(2000)
    .refine(tracks => new Set(tracks.map(track => track.id)).size === tracks.length, 'Repeated file'),
  cover: z.object({
    mode: z.enum(['folder', 'embedded', 'both']),
    image: z.union([
      z.object({ assetId: Id }),
      z.object({ base64: z.base64().max(8 * 1024 * 1024) }),
    ]),
  }).optional(),
})
export type TagEdit = z.infer<typeof TagEdit>

export const TagEditor = z.object({
  tracks: z.array(z.object({
    id: Id, revision: z.string(), path: z.string(), group: z.string(), matchLocked: z.boolean(), reason: z.string().nullable(),
    tags: AlbumTagPatch.extend(TrackTagPatch.shape),
  })),
  covers: z.array(z.object({ id: Id, width: z.number().nullable(), height: z.number().nullable() })),
})
export type TagEditor = z.infer<typeof TagEditor>

export const TagEditResult = z.object({
  written: z.array(Id),
  errors: z.array(z.object({ path: z.string(), reason: z.string() })),
})
export type TagEditResult = z.infer<typeof TagEditResult>

export const HygieneFile = z.object({
  id: Id, albumId: Id.nullable(), album: z.string().nullable(),
  title: z.string(), artist: z.string(), path: z.string(), folder: z.string(),
  codec: z.string(), container: z.string(), lossless: z.boolean(), bitrate: z.number().nullable(),
  bitDepth: z.number().nullable(), sampleRate: z.number().nullable(), durationMs: z.number(),
  managed: z.boolean(), revision: z.string(),
})
export type HygieneFile = z.infer<typeof HygieneFile>

export const DuplicateGroup = z.object({
  id: z.string(), label: z.string(),
  reason: z.enum(['recording', 'audio', 'tags', 'album']),
  files: z.array(HygieneFile),
  bestId: Id.nullable(),
})
export type DuplicateGroup = z.infer<typeof DuplicateGroup>

export const DuplicatePage = z.object({ items: z.array(DuplicateGroup), nextCursor: z.string().nullable() })
export type DuplicatePage = z.infer<typeof DuplicatePage>
export const QualityPage = z.object({ items: z.array(HygieneFile), nextCursor: Id.nullable() })
export type QualityPage = z.infer<typeof QualityPage>

export const HealthStatus = z.enum(['healthy', 'decode_error', 'hash_changed', 'no_hash', 'unavailable'])
export type HealthStatus = z.infer<typeof HealthStatus>

export const HealthPage = z.object({
  items: z.array(HygieneFile.extend({
    status: HealthStatus.nullable(), checkedAt: z.iso.datetime().nullable(),
    detail: z.string().nullable(), pending: z.boolean(),
  })),
  nextCursor: Id.nullable(),
})
export type HealthPage = z.infer<typeof HealthPage>

export const HygienePageQuery = z.object({ cursor: Id.optional() })
export const DuplicateQuery = z.object({ cursor: z.string().max(1200).optional(), kind: z.enum(['recordings', 'albums']).default('recordings') })
export type DuplicateQuery = z.infer<typeof DuplicateQuery>
export const RemoveDuplicate = z.object({
  revision: z.string(), keepId: Id, reason: DuplicateGroup.shape.reason.exclude(['album']),
})
export type RemoveDuplicate = z.infer<typeof RemoveDuplicate>
