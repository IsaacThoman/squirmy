import { readdirSync, readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The owner's rule: the app has no toasts, nor anything else that floats over the page to say
 * what happened. A control says it in its own place: the heart beside itself, a menu entry on
 * itself, a form under its fields, playback on the player's status line, a risky action in a
 * confirmation first. This fails if a toast comes back by any road; the lint config refuses the
 * same imports (`no-restricted-imports` in `.oxlintrc.json`).
 */
const src = join(import.meta.dirname, '..')
const self = relative(src, import.meta.filename)

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? files(path) : [relative(src, path)]
  })
}

const sources = files(src).filter(file => /\.(tsx?|css)$/.test(file) && file !== self)
const read = (file: string) => readFileSync(join(src, file), 'utf8')

/** The lines of `file` that match `pattern`, as `file:line: text`, for a failure that says where. */
function matches(pattern: RegExp): string[] {
  return sources.flatMap(file => read(file).split('\n').flatMap((line, index) => (pattern.test(line) ? [`${file}:${index + 1}: ${line.trim()}`] : [])))
}

describe('no toasts', () => {
  it('has no file named after one', () => {
    expect(files(src).filter(file => /toast/i.test(file) && file !== self)).toEqual([])
  })

  it('imports no toast library or module', () => {
    expect(matches(/from\s+['"](sonner|react-hot-toast|react-toastify|@radix-ui\/react-toast|[^'"]*\/toast(er)?)['"]/)).toEqual([])
    // radix-ui's bundle has a Toast too.
    expect(matches(/import\s*\{[^}]*\bToast\b[^}]*\}\s*from\s*['"]radix-ui['"]/)).toEqual([])
  })

  it('never calls or renders one', () => {
    expect(matches(/\btoast\s*\(|<Toast(er)?\b|data-toast|ToastPrimitive/)).toEqual([])
  })
})
