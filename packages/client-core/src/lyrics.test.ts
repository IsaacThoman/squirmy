import { describe, expect, it } from 'vitest'
import { parseLrc } from './lyrics.js'

describe('parseLrc', () => {
  it('reads timed lines in order, with repeated stamps, tags and gaps', () => {
    expect(parseLrc('[ar:Someone]\n[00:12.50]Paper boats at noon\n[00:05.00][00:30.25]Hum along\n[00:20.00]\nno stamp\n[01:02.123]Lanterns out')).toEqual([
      { text: 'Hum along', startMs: 5000 },
      { text: 'Paper boats at noon', startMs: 12_500 },
      { text: '', startMs: 20_000 },
      { text: 'Hum along', startMs: 30_250 },
      { text: 'Lanterns out', startMs: 62_123 },
    ])
  })

  it('reads a colon before the hundredths', () => {
    expect(parseLrc('[00:07:25]Under the porch light')[0]!.startMs).toBe(7250)
  })

  it('moves every line earlier for a positive offset and later for a negative one', () => {
    expect(parseLrc('[offset:+500]\n[00:10.00]Ten past\n[00:20.00]Twenty past').map(line => line.startMs)).toEqual([9500, 19_500])
    expect(parseLrc('[offset:-250]\n[00:10.00]Ten past')[0]!.startMs).toBe(10_250)
    expect(parseLrc('[offset: 300]\n[00:10.00]Ten past')[0]!.startMs).toBe(9700)
  })

  it('never puts a line before the start of the song', () => {
    expect(parseLrc('[offset:2000]\n[00:01.00]Too soon')[0]!.startMs).toBe(0)
  })
})
