import { describe, expect, it } from 'vitest'
import { parseLrc, stripWordStamps, wordProgress } from './lyrics.js'

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

describe('Enhanced LRC', () => {
  const enhanced = '[00:12.00]<00:12.00>Paper <00:12.40>boats <00:13.00>at noon<00:14.20>\n[00:15.00]<00:15.00>Hum <00:15.50>along\n[00:30.00]Lanterns out'

  it('times each word from its stamp to the next, and spells the line without the stamps', () => {
    const [first, second, third] = parseLrc(enhanced)
    expect(first).toEqual({
      startMs: 12_000,
      text: 'Paper boats at noon',
      words: [
        { startMs: 12_000, endMs: 12_400, text: 'Paper ' },
        { startMs: 12_400, endMs: 13_000, text: 'boats ' },
        { startMs: 13_000, endMs: 14_200, text: 'at noon' },
      ],
    })
    // No stamp after the last word: it runs at most a second, or until the next line.
    expect(second!.words!.at(-1)).toEqual({ startMs: 15_500, endMs: 16_500, text: 'along' })
    expect(third).toEqual({ startMs: 30_000, text: 'Lanterns out' })
  })

  it('starts text before the first word stamp with the line, and moves words with the offset', () => {
    const [line] = parseLrc('[offset:+200]\n[00:10.00]Under <00:10.80>the porch light<00:12.00>')
    expect(line!.startMs).toBe(9800)
    expect(line!.words).toEqual([
      { startMs: 9800, endMs: 10_600, text: 'Under ' },
      { startMs: 10_600, endMs: 11_800, text: 'the porch light' },
    ])
  })

  it('moves the words of a line sung again along with it', () => {
    const lines = parseLrc('[00:05.00][00:25.00]<00:05.00>Hum <00:05.50>along<00:06.00>')
    expect(lines.map(line => line.words!.map(word => word.startMs))).toEqual([[5000, 5500], [25_000, 25_500]])
  })

  it('ends a last word with the next line when it comes sooner than a second', () => {
    expect(parseLrc('[00:01.00]<00:01.00>Quick\n[00:01.30]Next')[0]!.words![0]!.endMs).toBe(1300)
  })

  it('reads a second line at the same time as its translation', () => {
    expect(parseLrc('[00:10.00]Kami no fune\n[00:10.00]Paper boats\n[00:20.00]Hum along')).toEqual([
      { startMs: 10_000, text: 'Kami no fune', translation: 'Paper boats' },
      { startMs: 20_000, text: 'Hum along' },
    ])
  })

  it('strips word stamps and leaves line stamps and other lines as they were', () => {
    expect(stripWordStamps(enhanced)).toBe('[00:12.00]Paper boats at noon\n[00:15.00]Hum along\n[00:30.00]Lanterns out')
    expect(stripWordStamps('[00:01.00]  Spaced  out')).toBe('[00:01.00]  Spaced  out')
  })
})

describe('wordProgress', () => {
  const words = [{ startMs: 1000, endMs: 1500, text: 'Paper ' }, { startMs: 1600, endMs: 2000, text: 'boats' }]

  it('says which word is sung and how much of it', () => {
    expect(wordProgress(words, 900)).toEqual({ index: -1, fraction: 0 })
    expect(wordProgress(words, 1250)).toEqual({ index: 0, fraction: 0.5 })
    // Between words the last one stays whole.
    expect(wordProgress(words, 1550)).toEqual({ index: 0, fraction: 1 })
    expect(wordProgress(words, 1700)).toEqual({ index: 1, fraction: 0.25 })
    expect(wordProgress(words, 2000)).toEqual({ index: 2, fraction: 0 })
  })
})
