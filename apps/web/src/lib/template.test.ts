import { DEFAULT_ORGANIZE_TEMPLATE, ORGANIZE_TEMPLATE_TOKENS } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { templateExample } from './template'

describe('templateExample', () => {
  it('fills the default template with the sample track', () => {
    expect(templateExample(DEFAULT_ORGANIZE_TEMPLATE, ORGANIZE_TEMPLATE_TOKENS)).toBe('Mira Vale/Blue Hour (2019)/2-03 Paper Boats.flac')
  })

  it('fills only the tokens the server lists', () => {
    expect(templateExample('{artist}/{title}.{ext}', ORGANIZE_TEMPLATE_TOKENS)).toBe('Mira Vale feat. Lune Park/Paper Boats.flac')
    expect(templateExample('{albumartist}/{title}.{ext}', ['title', 'ext'])).toBeNull()
    expect(templateExample('{genre}/{title}.{ext}', ORGANIZE_TEMPLATE_TOKENS)).toBeNull()
  })

  it('gives up on brackets that do not match', () => {
    expect(templateExample('{album}/[{track} {title}.{ext}', ORGANIZE_TEMPLATE_TOKENS)).toBeNull()
    expect(templateExample('{album}]/{title}.{ext}', ORGANIZE_TEMPLATE_TOKENS)).toBeNull()
    expect(templateExample('{album/{title}.{ext}', ORGANIZE_TEMPLATE_TOKENS)).toBeNull()
  })
})
