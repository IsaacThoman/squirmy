/**
 * The request side of the Subsonic protocol: parameters, error codes and the context a
 * handler receives. Every handler returns a plain payload object, which serialize.ts
 * renders as XML or JSON, or sends a binary reply itself and returns `sent`.
 */
import type { FastifyReply, FastifyRequest } from 'fastify'
import type { AuthUser } from '../../lib/auth.js'

/** The Subsonic API version this server speaks. */
export const API_VERSION = '1.16.1'

/** Error codes from the Subsonic and OpenSubsonic specifications. */
export const ErrorCode = {
  generic: 0,
  missingParameter: 10,
  wrongCredentials: 40,
  tokenAuthUnsupported: 41,
  authMechanismUnsupported: 42,
  conflictingAuth: 43,
  invalidApiKey: 44,
  notAuthorized: 50,
  notFound: 70,
} as const

/** A failure reported inside a 200 response, as Subsonic clients expect. */
export class SubsonicError extends Error {
  constructor(readonly code: number, message: string) {
    super(message)
    this.name = 'SubsonicError'
  }
}

export const missingParameter = (name: string) => new SubsonicError(ErrorCode.missingParameter, `Required parameter is missing: ${name}`)
export const invalidParameter = (name: string) => new SubsonicError(ErrorCode.generic, `Invalid value for parameter: ${name}`)
export const notFound = (what: string) => new SubsonicError(ErrorCode.notFound, `${what} not found`)
export const notAuthorized = () => new SubsonicError(ErrorCode.notAuthorized, 'User is not authorized for the given operation')

/**
 * Request parameters from the query string and a form body together. A name may repeat
 * (`id=1&id=2`), so every value is kept; the single-value readers take the first.
 */
export class Params {
  constructor(private readonly values: ReadonlyMap<string, readonly string[]>) {}

  static from(...sources: unknown[]): Params {
    const values = new Map<string, string[]>()
    for (const source of sources) {
      if (!source || typeof source !== 'object') continue
      for (const [name, value] of Object.entries(source)) {
        const list = values.get(name) ?? []
        for (const item of [value].flat()) if (typeof item === 'string') list.push(item)
        values.set(name, list)
      }
    }
    return new Params(values)
  }

  has(name: string): boolean {
    return (this.values.get(name)?.length ?? 0) > 0
  }

  all(name: string): readonly string[] {
    return this.values.get(name) ?? []
  }

  string(name: string): string | undefined {
    return this.values.get(name)?.[0]
  }

  required(name: string): string {
    const value = this.string(name)
    if (value === undefined || value === '') throw missingParameter(name)
    return value
  }

  /** An integer, clamped to `max`. Absent or empty gives `fallback`; anything else that is not an integer is an error. */
  int(name: string, fallback: number, options?: { min?: number; max?: number }): number
  int(name: string, fallback?: undefined, options?: { min?: number; max?: number }): number | undefined
  int(name: string, fallback?: number, options: { min?: number; max?: number } = {}): number | undefined {
    const raw = this.string(name)
    if (raw === undefined || raw.trim() === '') return fallback
    if (!/^-?\d+$/.test(raw.trim())) throw invalidParameter(name)
    const value = Number(raw)
    if (options.min !== undefined && value < options.min) throw invalidParameter(name)
    return options.max === undefined ? value : Math.min(value, options.max)
  }

  bool(name: string): boolean | undefined {
    const raw = this.string(name)?.trim().toLowerCase()
    if (raw === undefined || raw === '') return undefined
    if (raw === 'true' || raw === '1') return true
    if (raw === 'false' || raw === '0') return false
    throw invalidParameter(name)
  }
}

/** What a handler sees. `baseUrl` is the origin clients reach the server at. */
export type Context = {
  user: AuthUser
  params: Params
  /** The `c` parameter: the client's name. */
  client: string
  request: FastifyRequest
  reply: FastifyReply
  baseUrl: string
}

/** Returned by handlers that wrote a binary reply themselves. */
export const sent = Symbol('sent')

export type Payload = Record<string, unknown>
export type Handler = (context: Context) => Promise<Payload | typeof sent>
