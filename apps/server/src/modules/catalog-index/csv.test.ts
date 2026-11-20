import { describe, expect, it } from 'vitest'
import { parseCsv } from './csv.js'

async function parse(text: string, chunkSize = text.length || 1): Promise<string[][]> {
  const bytes = Buffer.from(text)
  async function* chunks() {
    for (let i = 0; i < bytes.length; i += chunkSize) yield bytes.subarray(i, i + chunkSize)
  }
  const rows: string[][] = []
  for await (const batch of parseCsv(chunks())) rows.push(...batch)
  return rows
}

const nasty = [
  'id,name,note\n',
  '1,plain,"with, comma"\n',
  '2,"quote ""inside""","line\nbreak"\n',
  '3,,empty middle\r\n',
  '4,trailing empty,\n',
  '\n',
  '5,"Beyoncé — 東京","crlf\r\ninside"\n',
  '6,"",last without newline',
].join('')

const expected = [
  ['id', 'name', 'note'],
  ['1', 'plain', 'with, comma'],
  ['2', 'quote "inside"', 'line\nbreak'],
  ['3', '', 'empty middle'],
  ['4', 'trailing empty', ''],
  ['5', 'Beyoncé — 東京', 'crlf\r\ninside'],
  ['6', '', 'last without newline'],
]

describe('parseCsv', () => {
  it('handles quotes, embedded separators, CRLF, blank lines and Unicode', async () => {
    expect(await parse(nasty)).toEqual(expected)
  })

  it('gives the same rows whatever the chunk boundaries, even inside a multibyte character', async () => {
    for (const size of [1, 2, 3, 5, 7, 64]) expect(await parse(nasty, size)).toEqual(expected)
  })

  it('rejects a quoted field that never closes', async () => {
    await expect(parse('a,"open\n')).rejects.toThrow(/inside a quoted field/)
  })

  it('rejects text after a closing quote', async () => {
    await expect(parse('a,"b"c\n')).rejects.toThrow(/after a closing quote/)
  })
})
