/**
 * Test helpers: a Subsonic client over `app.inject` that asks for XML and JSON and checks
 * that both carry the same structure, plus the small XML reader that needs.
 */
import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance, LightMyRequestResponse } from 'fastify'
import { expect } from 'vitest'

export type XmlNode = { name: string; attributes: Record<string, string>; children: XmlNode[]; text: string }

const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const decode = (value: string) => value.replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (_, name: string) => name.startsWith('#') ? String.fromCharCode(Number(name.slice(1))) : entities[name]!)

/** Reads the XML this server writes: elements, attributes and text; no CDATA, comments or DTDs. */
export function parseXml(xml: string): XmlNode {
  let at = xml.indexOf('<', xml.startsWith('<?xml') ? xml.indexOf('?>') + 2 : 0)
  function node(): XmlNode {
    const open = /^<([\w:-]+)((?:\s+[\w:-]+="[^"]*")*)\s*(\/?)>/.exec(xml.slice(at))
    if (!open) throw new Error(`Malformed XML at ${at}: ${xml.slice(at, at + 40)}`)
    at += open[0].length
    const attributes: Record<string, string> = {}
    for (const [, key, value] of open[2]!.matchAll(/([\w:-]+)="([^"]*)"/g)) attributes[key!] = decode(value!)
    const result: XmlNode = { name: open[1]!, attributes, children: [], text: '' }
    if (open[3]) return result
    for (;;) {
      const next = xml.indexOf('<', at)
      result.text += decode(xml.slice(at, next))
      at = next
      if (xml.startsWith(`</${result.name}>`, at)) {
        at += result.name.length + 3
        return result
      }
      result.children.push(node())
    }
  }
  return node()
}

/**
 * One shape for both formats, so they can be compared: every field becomes an array of
 * child shapes or a string, which is all XML can say. JSON arrays and objects become
 * children; JSON primitives become attribute strings, and `value` the text.
 */
type Shape = { [key: string]: string | Shape[] }

export function xmlShape(element: XmlNode): Shape {
  const shape: Shape = { ...element.attributes }
  if (element.text.trim() || (element.name === 'cue' && element.text)) shape.value = element.text
  for (const child of element.children) shape[child.name] = [...(shape[child.name] as Shape[] | undefined) ?? [], xmlShape(child)]
  return shape
}

export function jsonShape(value: Record<string, unknown>): Shape {
  const shape: Shape = {}
  for (const [key, field] of Object.entries(value)) {
    const items = Array.isArray(field) ? field : typeof field === 'object' && field !== null ? [field] : null
    if (!items) {
      // XML cannot tell an empty text from none.
      if (!(key === 'value' && field === '')) shape[key] = String(field)
      continue
    }
    if (items.length === 0) continue
    shape[key] = items.map((item) => typeof item === 'object' ? jsonShape(item as Record<string, unknown>) : { value: String(item) })
  }
  return shape
}

export type Credentials = { username: string; secret: string }

export type CallOptions = {
  format?: 'xml' | 'json' | 'jsonp'
  method?: 'GET' | 'POST'
  view?: boolean
  /** Replaces the default token credentials. */
  auth?: Record<string, string>
  headers?: Record<string, string>
  jsonBody?: Record<string, unknown>
}

type ParamValue = string | number | boolean | (string | number)[] | undefined

export function tokenAuth({ username, secret }: Credentials): Record<string, string> {
  const salt = randomBytes(6).toString('hex')
  return { u: username, s: salt, t: createHash('md5').update(secret + salt).digest('hex') }
}

/** A Subsonic client for one user. */
export function subsonicClient(app: FastifyInstance, credentials: Credentials) {
  async function raw(endpoint: string, params: Record<string, ParamValue> = {}, options: CallOptions = {}): Promise<LightMyRequestResponse> {
    const search = new URLSearchParams({ v: '1.16.1', c: 'vitest', ...(options.auth ?? tokenAuth(credentials)) })
    if (options.format) search.set('f', options.format)
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined) continue
      for (const item of [value].flat()) search.append(key, String(item))
    }
    const url = `/rest/${endpoint}${options.view ? '.view' : ''}`
    if (options.jsonBody) {
      return app.inject({ method: 'POST', url: `${url}?${search}`, headers: { 'content-type': 'application/json', ...options.headers }, payload: options.jsonBody })
    }
    if (options.method === 'POST') {
      return app.inject({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded', ...options.headers }, payload: search.toString() })
    }
    return app.inject({ method: 'GET', url: `${url}?${search}`, headers: options.headers })
  }

  /** The `subsonic-response` object of a JSON call. */
  async function json(endpoint: string, params: Record<string, ParamValue> = {}, options: CallOptions = {}) {
    const response = await raw(endpoint, params, { ...options, format: 'json' })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['content-type']).toMatch(/^application\/json/)
    return (response.json() as { 'subsonic-response': Record<string, unknown> })['subsonic-response'] as Record<string, any>
  }

  async function xml(endpoint: string, params: Record<string, ParamValue> = {}, options: CallOptions = {}) {
    const response = await raw(endpoint, params, { ...options, format: 'xml' })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['content-type']).toMatch(/^text\/xml/)
    const root = parseXml(response.body)
    expect(root.name).toBe('subsonic-response')
    expect(root.attributes.xmlns).toBe('http://subsonic.org/restapi')
    return root
  }

  /**
   * Calls the method in JSON and in XML and checks that both have the same structure.
   * Returns the JSON body. `status` defaults to ok. A method whose answer differs between
   * two calls (random picks, creations) is compared by its top-level elements only.
   */
  async function call(endpoint: string, params: Record<string, ParamValue> = {}, options: CallOptions & { status?: 'ok' | 'failed'; varies?: boolean } = {}) {
    const body = await json(endpoint, params, options)
    const root = await xml(endpoint, params, options)
    const { xmlns: _xmlns, ...attributes } = root.attributes
    const fromXml = xmlShape({ ...root, attributes })
    const fromJson = jsonShape(body)
    if (options.varies) expect(Object.keys(fromXml).sort()).toEqual(Object.keys(fromJson).sort())
    else expect(fromXml).toEqual(fromJson)
    expect(body.status, JSON.stringify(body.error)).toBe(options.status ?? 'ok')
    return body
  }

  /** Calls a method that must fail, and returns its error code (checked in both formats). */
  async function error(endpoint: string, params: Record<string, ParamValue> = {}, options: CallOptions = {}): Promise<number> {
    const body = await call(endpoint, params, { ...options, status: 'failed' })
    return body.error.code as number
  }

  return { raw, json, xml, call, error }
}

export type SubsonicClient = ReturnType<typeof subsonicClient>
