import path from 'node:path'
import { DEFAULT_ORGANIZE_TEMPLATE, ORGANIZE_TEMPLATE_TOKENS, type OrganizeTemplateInfo } from '@squirmy/contracts'

/**
 * Path templates and file-name sanitizing for managed roots.
 *
 * A template is a `/`-separated path of literal text, `{token}`s and `[optional]`
 * segments. An optional segment is dropped when any token inside it has no value.
 * Every rendered component is sanitized so the result is a valid, portable relative
 * path that cannot leave the root.
 */

export type TemplateToken = (typeof ORGANIZE_TEMPLATE_TOKENS)[number]
/** Token values for one file. A missing or empty value counts as "no value". */
export type TemplateValues = Partial<Record<Exclude<TemplateToken, 'ext'>, string>> & { ext: string }

type Node = { text: string } | { token: TemplateToken } | { optional: Node[] }
/** A validated template: one node list per path component. */
export type ParsedTemplate = { directories: Node[][]; fileName: Node[] }

/** Printed for a token with no value outside an optional segment. */
const placeholders: Record<Exclude<TemplateToken, 'ext'>, string> = {
  albumartist: 'Unknown Artist',
  artist: 'Unknown Artist',
  album: 'Unknown Album',
  year: 'Unknown Year',
  disc: '1',
  track: '00',
  title: 'Untitled',
}

const descriptions: Record<TemplateToken, string> = {
  albumartist: 'The album\'s artist credit, or Various Artists for a compilation',
  artist: 'The track\'s artist credit',
  album: 'The album title',
  year: 'The album\'s year',
  disc: 'The disc number, only on releases with more than one disc',
  track: 'The track number, zero-padded to at least two digits',
  title: 'The track title',
  ext: 'The file\'s extension, lowercase; the file name must end with .{ext}',
}

/** The default template and every token with its description, for `GET /admin/organize/template`. */
export function templateInfo(): OrganizeTemplateInfo {
  return { defaultTemplate: DEFAULT_ORGANIZE_TEMPLATE, tokens: ORGANIZE_TEMPLATE_TOKENS.map((token) => ({ token, description: descriptions[token] })) }
}

/** Each path component is capped at this many bytes of UTF-8, extension included. */
export const MAX_COMPONENT_BYTES = 200

export class TemplateError extends Error {}

const tokens = new Set<string>(ORGANIZE_TEMPLATE_TOKENS)
const forbiddenInLiterals = /[<>:"\\|?*\p{Cc}]/u

/** Parses and validates a template. Throws {@link TemplateError} with a message for the admin. */
export function parseTemplate(template: string): ParsedTemplate {
  if (template.length === 0 || template.length > 500) throw new TemplateError('A template must be 1 to 500 characters long')
  if (forbiddenInLiterals.test(template)) throw new TemplateError('A template may not contain < > : " \\ | ? * or control characters')

  const components: Node[][] = [[]]
  const stack: Node[][] = [components[0]!]
  let index = 0
  while (index < template.length) {
    const char = template[index]!
    const current = stack[stack.length - 1]!
    if (char === '{') {
      const end = template.indexOf('}', index)
      const name = end === -1 ? '' : template.slice(index + 1, end)
      if (!tokens.has(name)) throw new TemplateError(`Unknown token ${end === -1 ? template.slice(index) : `{${name}}`}`)
      current.push({ token: name as TemplateToken })
      index = end + 1
      continue
    }
    if (char === '[') {
      const optional: Node[] = []
      current.push({ optional })
      stack.push(optional)
    } else if (char === ']') {
      if (stack.length === 1) throw new TemplateError('Unmatched ]')
      if (!hasToken(current)) throw new TemplateError('An optional segment must contain a token')
      stack.pop()
    } else if (char === '}') {
      throw new TemplateError('Unmatched }')
    } else if (char === '/') {
      if (stack.length > 1) throw new TemplateError('An optional segment may not contain /')
      const next: Node[] = []
      components.push(next)
      stack[0] = next
    } else {
      const last = current[current.length - 1]
      if (last && 'text' in last) last.text += char
      else current.push({ text: char })
    }
    index += 1
  }
  if (stack.length > 1) throw new TemplateError('Unmatched [')

  for (const component of components) {
    if (component.length === 0) throw new TemplateError('A template may not start or end with /, or contain //')
    const literal = component.every((node) => 'text' in node) ? (component[0] as { text: string }).text.trim() : null
    if (literal === '.' || literal === '..') throw new TemplateError('A template may not contain . or .. folders')
  }
  const fileName = components.pop()!
  const ext = fileName.findIndex((node) => 'token' in node && node.token === 'ext')
  const beforeExt = fileName[fileName.length - 2]
  if (ext !== fileName.length - 1 || !beforeExt || !('text' in beforeExt) || !beforeExt.text.endsWith('.')) {
    throw new TemplateError('The file name must end with .{ext}')
  }
  if (!hasToken(fileName, 'title')) throw new TemplateError('The file name must contain {title}')
  if (hasToken([...components.flat(), ...fileName.slice(0, -1)], 'ext')) throw new TemplateError('{ext} may only appear at the end')
  return { directories: components, fileName: fileName.slice(0, -1) }
}

/** The message for an invalid template, or null when it is valid. */
export function validateTemplate(template: string): string | null {
  try {
    parseTemplate(template)
    return null
  } catch (error) {
    if (error instanceof TemplateError) return error.message
    throw error
  }
}

/** The parsed default template. */
export const defaultTemplate = (): ParsedTemplate => parseTemplate(DEFAULT_ORGANIZE_TEMPLATE)

function hasToken(nodes: Node[], name?: TemplateToken): boolean {
  return nodes.some((node) => 'token' in node ? !name || node.token === name : 'optional' in node && hasToken(node.optional, name))
}

function render(nodes: Node[], values: TemplateValues, optional: boolean): string | null {
  let out = ''
  for (const node of nodes) {
    if ('text' in node) out += node.text
    else if ('optional' in node) out += render(node.optional, values, true) ?? ''
    else {
      const value = node.token === 'ext' ? values.ext : values[node.token]?.trim()
      if (!value) {
        if (optional) return null
        out += placeholders[node.token as Exclude<TemplateToken, 'ext'>]
      } else out += value
    }
  }
  return out
}

/** A rendered, sanitized target: folder names, then a file stem and extension kept apart so a suffix can go between them. */
export type RenderedPath = { directories: string[]; stem: string; extension: string }

/** Renders a template for one file. Every component comes out sanitized. */
export function renderTemplate(template: ParsedTemplate, values: TemplateValues): RenderedPath {
  const extension = sanitizeExtension(values.ext)
  const directories = template.directories.map((nodes) => sanitizeComponent(render(nodes, values, false)!))
  // The stem keeps the "." before {ext}; sanitizing drops trailing dots.
  return { directories, stem: sanitizeStem(render(template.fileName, values, false)!, extension), extension }
}

/**
 * The relative path for a rendered target. `suffix` (such as " (2)") goes before the
 * extension and survives truncation.
 */
export function joinRendered(target: RenderedPath, suffix = ''): string {
  return [...target.directories, fileName(target.stem, target.extension, suffix)].join('/')
}

/** A file name from a stem and an extension, truncated so the suffix and extension always fit. */
export function fileName(stem: string, extension: string, suffix = ''): string {
  const tail = `${suffix}${extension ? `.${extension}` : ''}`
  return `${sanitizeStem(stem, extension, Buffer.byteLength(suffix))}${tail}`
}

function sanitizeStem(stem: string, extension: string, reserve = 0): string {
  const budget = MAX_COMPONENT_BYTES - reserve - (extension ? Buffer.byteLength(extension) + 1 : 0)
  return sanitizeComponent(stem, 'Untitled', budget)
}

/** A lowercase extension of letters and digits, at most 16 characters. */
export function sanitizeExtension(extension: string): string {
  return extension.replace(/^\./, '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16)
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
// A UTF-16 surrogate without its partner cannot be encoded as UTF-8.
const loneSurrogate = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g
const reservedNames = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])$/i

/**
 * Makes one path component safe on Linux, macOS, Windows and SMB shares:
 * NFC, no control characters, no `< > : " / \ | ? *`, single spaces, no leading dots
 * (hidden files, `..`), no trailing dots or spaces, no Windows device names, at most
 * `maxBytes` of UTF-8 cut on a character boundary, and never empty. Idempotent.
 */
export function sanitizeComponent(value: string, fallback = '_', maxBytes = MAX_COMPONENT_BYTES): string {
  let out = value.replace(loneSurrogate, '\ufffd').normalize('NFC')
    .replace(/\p{Cc}/gu, ' ')
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/gu, ' ')
    .replace(/^[\s.]+/u, '')
  out = trimEnd(truncateBytes(trimEnd(out), maxBytes))
  // A Windows device name is reserved with any extension: "CON", "con.txt", "Nul .flac".
  const dot = out.indexOf('.')
  const base = dot === -1 ? out : out.slice(0, dot)
  if (reservedNames.test(base.trimEnd())) out = `${base.trimEnd()}_${dot === -1 ? '' : out.slice(dot)}`
  return out || (fallback === '_' ? '_' : sanitizeComponent(fallback, '_', maxBytes))
}

function trimEnd(value: string): string {
  return value.replace(/[\s.]+$/u, '')
}

/** Cuts a string to at most `maxBytes` of UTF-8 without splitting a grapheme. */
export function truncateBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value
  let out = ''
  let bytes = 0
  for (const { segment } of segmenter.segment(value)) {
    const size = Buffer.byteLength(segment)
    if (bytes + size > maxBytes) break
    out += segment
    bytes += size
  }
  return out
}

/**
 * Case- and normalization-insensitive key for a path, matching how case-insensitive
 * file systems (macOS, Windows, most SMB shares) compare names. "Straße" and "STRASSE"
 * collide, which errs on the side of reporting a collision.
 */
export function foldPath(value: string): string {
  return value.normalize('NFC').toUpperCase().toLowerCase()
}

/**
 * Resolves a stored relative path against a root and refuses anything that would
 * land outside it.
 */
export function resolveInRoot(root: string, relPath: string): string {
  const base = path.resolve(root)
  const resolved = path.resolve(base, relPath)
  if (relPath === '' || path.isAbsolute(relPath) || !resolved.startsWith(base + path.sep)) {
    throw new Error(`Path ${JSON.stringify(relPath)} is outside the library root`)
  }
  return resolved
}
