/**
 * Renders a response payload in the `subsonic-response` envelope, as XML or JSON(P).
 *
 * Payloads are plain objects, written the way the JSON examples in the specification
 * look. XML follows the same rules as every other Subsonic server:
 *
 * - a string, number or boolean is an attribute, except a field named `value`, which is
 *   the element's text (`<genre songCount="3">Rock</genre>`, `<line start="0">…</line>`);
 * - an object is a child element named after its field;
 * - an array is one child element per item, named after the field; items that are
 *   strings or numbers become the element's text (`<isrc>USSM18300073</isrc>`);
 * - null and undefined are left out, in both formats.
 */
import { getVersion } from '../../lib/version.js'
import { API_VERSION, type Payload } from './protocol.js'

export type Format = 'xml' | 'json' | 'jsonp'

const XMLNS = 'http://subsonic.org/restapi'

export function envelope(status: 'ok' | 'failed', payload: Payload): Payload {
  return { status, version: API_VERSION, type: 'squirmy', serverVersion: getVersion(), openSubsonic: true, ...payload }
}

const escapeMap: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }
// Characters XML 1.0 cannot carry at all; tags occasionally contain them.
// oxlint-disable-next-line no-control-regex
const forbidden = /[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g

function escapeXml(value: string): string {
  return value.replace(forbidden, '').replace(/[&<>"']/g, (char) => escapeMap[char]!)
}

const isPrimitive = (value: unknown): value is string | number | boolean =>
  typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'

function element(name: string, value: unknown, extraAttributes = ''): string {
  if (isPrimitive(value)) return `<${name}>${escapeXml(String(value))}</${name}>`
  const attributes: string[] = []
  const children: string[] = []
  let text: string | undefined
  for (const [key, field] of Object.entries(value as Payload)) {
    if (field === undefined || field === null) continue
    if (key === 'value' && isPrimitive(field)) text = escapeXml(String(field))
    else if (isPrimitive(field)) attributes.push(` ${key}="${escapeXml(String(field))}"`)
    else if (Array.isArray(field)) for (const item of field) children.push(element(key, item))
    else children.push(element(key, field))
  }
  const open = `<${name}${extraAttributes}${attributes.join('')}`
  const body = (text ?? '') + children.join('')
  return body ? `${open}>${body}</${name}>` : `${open}/>`
}

/** Drops null and undefined fields so JSON matches XML, where they cannot appear. */
function prune(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(prune)
  if (value && typeof value === 'object') {
    const result: Payload = {}
    for (const [key, field] of Object.entries(value)) if (field !== undefined && field !== null) result[key] = prune(field)
    return result
  }
  return value
}

/** The response body and its content type. `callback` is required for JSONP and checked by the caller. */
export function serialize(format: Format, body: Payload, callback?: string): { contentType: string; body: string } {
  if (format === 'xml') {
    return {
      contentType: 'text/xml; charset=utf-8',
      body: `<?xml version="1.0" encoding="UTF-8"?>\n${element('subsonic-response', body, ` xmlns="${XMLNS}"`)}`,
    }
  }
  const json = JSON.stringify({ 'subsonic-response': prune(body) })
  if (format === 'jsonp') return { contentType: 'application/javascript; charset=utf-8', body: `${callback}(${json});` }
  return { contentType: 'application/json; charset=utf-8', body: json }
}
