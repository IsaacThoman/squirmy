import { describe, expect, it } from 'vitest'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { useHttpFixtures } from '../../test/http.js'
import { cleanExtract, getImage, getWikipediaSummary } from './wikidata.js'

const radiohead = 'Q44190'
const joyDivision = 'Q172763'

describe('wikidata', () => {
  useTestDatabase()
  const http = useHttpFixtures('wikidata')

  it('builds a Commons image URL at the requested width', async () => {
    expect(await getImage(radiohead, { width: 800 })).toEqual({
      url: 'https://commons.wikimedia.org/wiki/Special:FilePath/RadioheadO2211125_composite.jpg?width=800',
      fileName: 'RadioheadO2211125 composite.jpg',
      pageUrl: 'https://commons.wikimedia.org/wiki/File:RadioheadO2211125_composite.jpg',
    })
  })

  it('returns null for an entity without an image', async () => {
    expect(await getImage(joyDivision)).toBeNull()
  })

  it('returns the English Wikipedia summary with attribution', async () => {
    const summary = await getWikipediaSummary(radiohead)
    expect(summary).toMatchObject({ title: 'Radiohead', sourceUrl: 'https://en.wikipedia.org/wiki/Radiohead' })
    expect(summary!.text).toMatch(/^Radiohead are an English rock band/)
    expect(summary!.license).toContain('CC BY-SA')
    expect((await getWikipediaSummary(joyDivision))!.text).toContain('Joy Division')
  })

  it('drops the separators of the parentheticals the summary left out', () => {
    expect(cleanExtract("The members are Thom Yorke ; brothers Jonny Greenwood and Colin Greenwood (bass); Ed O'Brien ; and Philip Selway (drums)."))
      .toBe("The members are Thom Yorke; brothers Jonny Greenwood and Colin Greenwood (bass); Ed O'Brien; and Philip Selway (drums).")
    expect(cleanExtract('Björk Guðmundsdóttir ( ; born 1965) is an Icelandic singer .')).toBe('Björk Guðmundsdóttir (born 1965) is an Icelandic singer.')
    expect(cleanExtract('Sigur Rós ( ) are a band ,  from Reykjavík.')).toBe('Sigur Rós are a band, from Reykjavík.')
  })

  it('ignores malformed ids and stays quiet when switched off', async () => {
    expect(await getImage('not-a-qid')).toBeNull()
    await updateServerSettings({ wikidataEnabled: false })
    expect(await getImage(radiohead)).toBeNull()
    expect(await getWikipediaSummary(radiohead)).toBeNull()
    expect(http.requests).toEqual([])
    await updateServerSettings({ wikidataEnabled: true })
  })
})
