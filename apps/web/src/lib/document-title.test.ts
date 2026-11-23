import { describe, expect, it } from 'vitest'
import { documentTitle } from './document-title'

const song = { title: 'Low Tide', artistCredit: 'Lune Park' }

describe('the tab title', () => {
  it('names the song while it plays, whatever the page', () => {
    expect(documentTitle('Nothing here', song, true)).toBe('Low Tide · Lune Park')
    expect(documentTitle(null, song, true)).toBe('Low Tide · Lune Park')
  })

  it('names the page over a paused song, when the page has a name of its own', () => {
    expect(documentTitle('Nothing here', song, false)).toBe('Nothing here · Squirmy')
    expect(documentTitle(null, song, false)).toBe('Low Tide · Lune Park')
  })

  it('is Squirmy with nothing else to say', () => {
    expect(documentTitle(null, null, false)).toBe('Squirmy')
    expect(documentTitle('Page did not load', null, true)).toBe('Page did not load · Squirmy')
  })
})
