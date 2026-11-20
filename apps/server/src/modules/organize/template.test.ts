import { describe, expect, it } from 'vitest'
import {
  defaultTemplate, fileName, foldPath, joinRendered, MAX_COMPONENT_BYTES, parseTemplate, renderTemplate, resolveInRoot,
  sanitizeComponent, truncateBytes, validateTemplate, type TemplateValues,
} from './template.js'

const render = (values: Partial<TemplateValues>, template = defaultTemplate()) =>
  joinRendered(renderTemplate(template, { ext: 'flac', ...values }))

const bytes = (value: string) => Buffer.byteLength(value)

describe('default template', () => {
  it('files a track as Album Artist/Album (Year)/01 Title.ext', () => {
    expect(render({ albumartist: 'Radiohead', album: 'OK Computer', year: '1997', track: '01', title: 'Airbag' }))
      .toBe('Radiohead/OK Computer (1997)/01 Airbag.flac')
  })

  it('drops the year when it is unknown', () => {
    expect(render({ albumartist: 'Radiohead', album: 'OK Computer', track: '01', title: 'Airbag' }))
      .toBe('Radiohead/OK Computer/01 Airbag.flac')
  })

  it('adds a disc prefix only when there is a disc value', () => {
    expect(render({ albumartist: 'A', album: 'B', disc: '2', track: '01', title: 'T' })).toBe('A/B/2-01 T.flac')
    expect(render({ albumartist: 'A', album: 'B', track: '01', title: 'T' })).toBe('A/B/01 T.flac')
  })

  it('drops the whole number prefix when the track number is unknown', () => {
    expect(render({ albumartist: 'A', album: 'B', disc: '2', title: 'T' })).toBe('A/B/T.flac')
  })

  it('uses placeholders for required values that are missing', () => {
    expect(render({ track: '03' })).toBe('Unknown Artist/Unknown Album/03 Untitled.flac')
  })

  it('keeps the extension lowercase', () => {
    expect(joinRendered(renderTemplate(defaultTemplate(), { ext: 'FLAC', albumartist: 'A', album: 'B', title: 'T' }))).toBe('A/B/T.flac')
  })
})

describe('custom templates', () => {
  it('renders every token', () => {
    const template = parseTemplate('{albumartist}/{year} - {album}/{disc}.{track} {artist} - {title}.{ext}')
    expect(render({ albumartist: 'VA', year: '2001', album: 'Hits', disc: '1', track: '07', artist: 'Someone', title: 'Song' }, template))
      .toBe('VA/2001 - Hits/1.07 Someone - Song.flac')
  })

  it('supports nested optional segments', () => {
    const template = parseTemplate('{album}/[[{disc}-]{track}. ]{title}.{ext}')
    expect(render({ album: 'X', track: '1', title: 'T' }, template)).toBe('X/1. T.flac')
    expect(render({ album: 'X', title: 'T' }, template)).toBe('X/T.flac')
  })

  it.each([
    ['', 'must be 1 to 500'],
    ['{title}', 'end with .{ext}'],
    ['{album}/{track}.{ext}', 'must contain {title}'],
    ['{album}/{title}.{ext}.{ext}', 'end with .{ext}'],
    ['{ext}/{title}.{ext}', '{ext} may only appear at the end'],
    ['{bogus}/{title}.{ext}', 'Unknown token {bogus}'],
    ['{album/{title}.{ext}', 'Unknown token'],
    ['{album}}/{title}.{ext}', 'Unmatched }'],
    ['[{album}/{title}.{ext}', 'optional segment may not contain /'],
    ['[{year}/{title}.{ext}', 'optional segment may not contain /'],
    ['{album}/[{year}/{title}.{ext}', 'optional segment may not contain /'],
    ['{album}/[{title}.{ext}', 'Unmatched ['],
    ['{album}]/{title}.{ext}', 'Unmatched ]'],
    ['[Disc]/{title}.{ext}', 'must contain a token'],
    ['/{album}/{title}.{ext}', 'may not start or end with /'],
    ['{album}//{title}.{ext}', 'contain //'],
    ['../{title}.{ext}', '. or .. folders'],
    ['{album}/./{title}.{ext}', '. or .. folders'],
    ['C:/{title}.{ext}', 'may not contain'],
    ['{album}\\{title}.{ext}', 'may not contain'],
    ['{album}/{title}?.{ext}', 'may not contain'],
  ])('rejects %j', (template, message) => {
    expect(validateTemplate(template)).toContain(message)
  })

  it('accepts the default template', () => {
    expect(validateTemplate('{albumartist}/{album}[ ({year})]/[[{disc}-]{track} ]{title}.{ext}')).toBeNull()
  })
})

describe('sanitizeComponent', () => {
  it.each([
    ['AC/DC', 'AC_DC'],
    ['What?: A <Story> "of" a|b*c\\d', 'What__ A _Story_ _of_ a_b_c_d'],
    ['tab\there\nnewline\u0000nul\u007fdel', 'tab here newline nul del'],
    ['  lots   of\u00a0\u2003space  ', 'lots of space'],
    ['Trailing dots...', 'Trailing dots'],
    ['Trailing space . . ', 'Trailing space'],
    ['...And Justice for All', 'And Justice for All'],
    ['.hidden', 'hidden'],
    ['.', '_'],
    ['..', '_'],
    ['', '_'],
    ['   ', '_'],
    ['???', '___'],
    ['CON', 'CON_'],
    ['con', 'con_'],
    ['Nul', 'Nul_'],
    ['COM1', 'COM1_'],
    ['lpt9', 'lpt9_'],
    ['COM¹', 'COM¹_'],
    ['CON.flac', 'CON_.flac'],
    ['aux .txt', 'aux_.txt'],
    ['Console', 'Console'],
    ['CONCERT', 'CONCERT'],
    ['COM10', 'COM10'],
  ])('%j → %j', (input, output) => {
    expect(sanitizeComponent(input)).toBe(output)
  })

  it('normalizes to NFC', () => {
    const decomposed = 'Beyonce\u0301'
    expect(sanitizeComponent(decomposed)).toBe('Beyoncé')
    expect(sanitizeComponent(decomposed)).toBe(sanitizeComponent('Beyoncé'))
  })

  it('replaces lone surrogates instead of producing invalid UTF-8', () => {
    expect(sanitizeComponent('a\ud800b')).toBe('a\ufffdb')
  })

  it('uses the fallback for names that sanitize to nothing', () => {
    expect(sanitizeComponent('...', 'Unknown Album')).toBe('Unknown Album')
  })

  it('caps a component at 200 bytes without splitting characters', () => {
    for (const unit of ['a', 'é', '日本', '😀', '👩‍👩‍👧‍👦', 'e\u0301']) {
      const out = sanitizeComponent(unit.repeat(300))
      expect(bytes(out)).toBeLessThanOrEqual(MAX_COMPONENT_BYTES)
      expect(bytes(out)).toBeGreaterThan(MAX_COMPONENT_BYTES - 30)
      expect(Buffer.from(out).toString()).toBe(out)
      // Whole graphemes only: the output is made of complete copies of the unit.
      expect(out.split(unit.normalize('NFC')).every((part) => part === '')).toBe(true)
    }
  })

  it('does not leave a trailing space or dot after truncating', () => {
    const out = sanitizeComponent(`${'a'.repeat(199)} b`)
    expect(out).toBe('a'.repeat(199))
  })

  it('is idempotent', () => {
    for (const input of ['CON', ' .x. ', 'a/b', '日本'.repeat(80), 'COM1 .txt', 'Ω\u0000']) {
      const once = sanitizeComponent(input)
      expect(sanitizeComponent(once)).toBe(once)
    }
  })
})

describe('file names', () => {
  it('keeps the extension when a long title is truncated', () => {
    const name = render({ albumartist: 'A', album: 'B', track: '01', title: '日本語'.repeat(100) }).split('/')[2]!
    expect(name.endsWith('.flac')).toBe(true)
    expect(bytes(name)).toBeLessThanOrEqual(MAX_COMPONENT_BYTES)
  })

  it('keeps a disambiguating suffix when truncating', () => {
    const name = fileName('x'.repeat(300), 'flac', ' (2)')
    expect(name.endsWith('x (2).flac')).toBe(true)
    expect(bytes(name)).toBe(MAX_COMPONENT_BYTES)
  })

  it('keeps a reserved stem safe before the extension', () => {
    expect(render({ albumartist: 'Prn', album: 'Aux', title: 'Con', track: '' })).toBe('Prn_/Aux_/Con_.flac')
  })

  it('strips dots before the extension', () => {
    expect(render({ albumartist: 'A', album: 'B', title: 'Why...' })).toBe('A/B/Why.flac')
  })
})

describe('paths', () => {
  it('truncates by bytes', () => {
    expect(truncateBytes('abc', 2)).toBe('ab')
    expect(truncateBytes('éé', 3)).toBe('é')
  })

  it('folds case and normalization', () => {
    expect(foldPath('ABC/Déjà')).toBe(foldPath('abc/de\u0301ja\u0300'))
    expect(foldPath('Straße')).toBe(foldPath('STRASSE'))
  })

  it('refuses paths that leave the root', () => {
    expect(resolveInRoot('/music', 'a/b.flac')).toBe('/music/a/b.flac')
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', '', '.', 'a/..']) {
      expect(() => resolveInRoot('/music', bad)).toThrow(/outside/)
    }
  })
})
