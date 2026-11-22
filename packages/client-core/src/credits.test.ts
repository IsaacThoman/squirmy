import { describe, expect, it } from 'vitest'
import { creditParts } from './credits.js'

const thundercat = { id: 'a1', name: 'Thundercat' }
const tame = { id: 'a2', name: 'Tame Impala' }
const text = (credit: string, artists: { id: string; name: string }[]) =>
  creditParts(credit, artists).map(part => (part.artist ? `[${part.text}]` : part.text)).join('')

describe('creditParts', () => {
  it('keeps the credit’s join phrases between the linked artists', () => {
    expect(creditParts('Thundercat feat. Tame Impala', [thundercat, tame])).toEqual([
      { text: 'Thundercat', artist: thundercat },
      { text: ' feat. ', artist: null },
      { text: 'Tame Impala', artist: tame },
    ])
    expect(text('Grimes featuring HANA', [{ id: 'g', name: 'Grimes' }, { id: 'h', name: 'HANA' }])).toBe('[Grimes] featuring [HANA]')
    expect(text('Justice feat. Tame Impala, SZA & King Gizzard & the Lizard Wizard', [
      { id: 'j', name: 'Justice' }, tame, { id: 's', name: 'SZA' }, { id: 'k', name: 'King Gizzard & the Lizard Wizard' },
    ])).toBe('[Justice] feat. [Tame Impala], [SZA] & [King Gizzard & the Lizard Wizard]')
  })

  it('ignores case and keeps the credit’s spelling', () => {
    expect(text('THUNDERCAT & tame impala', [thundercat, tame])).toBe('[THUNDERCAT] & [tame impala]')
  })

  it('matches whole words only', () => {
    expect(text('Yeat & Ye', [{ id: 'y', name: 'Ye' }])).toBe('Yeat & [Ye]')
    expect(text('!!! & Ye', [{ id: 'c', name: '!!!' }, { id: 'y', name: 'Ye' }])).toBe('[!!!] & [Ye]')
  })

  it('leaves an artist the credit does not name out of the links', () => {
    expect(text('Thundercat feat. T. Impala', [thundercat, tame])).toBe('[Thundercat] feat. T. Impala')
  })

  it('links a lone artist credited another way as the whole credit', () => {
    expect(creditParts('JAY Z', [{ id: 'j', name: 'JAY-Z' }])).toEqual([{ text: 'JAY Z', artist: { id: 'j', name: 'JAY-Z' } }])
  })

  it('spells the names when the credit names none of several artists, or is empty', () => {
    expect(text('Various', [thundercat, tame, { id: 's', name: 'SZA' }])).toBe('[Thundercat], [Tame Impala] & [SZA]')
    expect(text('', [thundercat, tame])).toBe('[Thundercat] & [Tame Impala]')
  })

  it('is the plain credit without artists', () => {
    expect(creditParts('Unknown artist', [])).toEqual([{ text: 'Unknown artist', artist: null }])
    expect(creditParts('', [])).toEqual([])
  })
})
