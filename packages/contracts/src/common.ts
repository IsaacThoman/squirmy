import { z } from 'zod'

/** Every native route lives under this prefix. */
export const API_PREFIX = '/api/v1'

export const Id = z.uuid()
export type Id = z.infer<typeof Id>

/** ISO 8601 timestamp with offset, e.g. 2026-11-20T08:14:00.000Z. */
export const IsoDateTime = z.iso.datetime({ offset: true })

export const PageQuery = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
})
export type PageQuery = z.infer<typeof PageQuery>

export function page<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() })
}
export type Page<T> = { items: T[]; nextCursor: string | null }

/** Body of every non-2xx response. `code` is stable and machine readable. */
export const ApiErrorBody = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
})
export type ApiErrorBody = z.infer<typeof ApiErrorBody>

export const Ok = z.object({ ok: z.literal(true) })
export type Ok = z.infer<typeof Ok>
