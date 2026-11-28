import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parseLyricsText, readFileLyrics, servedLyrics, ttmlToLrc } from './lyrics.js'

const enhanced = '[ar:Someone]\n[00:12.00]<00:12.00>Paper <00:12.40>boats<00:13.10>\n[00:15.00]<00:15.00>Hum <00:15.50>along'

describe('Enhanced LRC', () => {
  it('keeps the word stamps in the synced text and leaves them out of the plain text', () => {
    expect(parseLyricsText(enhanced)).toEqual({ synced: enhanced, plain: 'Paper boats\nHum along' })
  })

  it('serves line stamps in synced and the words in lines', () => {
    const served = servedLyrics({ trackId: '0190d1f6-0000-7000-8000-000000000001', synced: enhanced, plain: 'Paper <00:12.40>boats', instrumental: false, source: 'sidecar' })
    expect(served.synced).toBe('[ar:Someone]\n[00:12.00]Paper boats\n[00:15.00]Hum along')
    // A plain text stored before word stamps were known is cleaned as it goes out.
    expect(served.plain).toBe('Paper boats')
    expect(served.lines?.[0]).toEqual({
      startMs: 12_000,
      text: 'Paper boats',
      words: [{ startMs: 12_000, endMs: 12_400, text: 'Paper ' }, { startMs: 12_400, endMs: 13_100, text: 'boats' }],
    })
  })

  it('serves plain lyrics as they are, without lines', () => {
    const served = servedLyrics({ trackId: '0190d1f6-0000-7000-8000-000000000001', synced: null, plain: 'just words', instrumental: false, source: 'lrclib' })
    expect(served).toEqual({ trackId: '0190d1f6-0000-7000-8000-000000000001', synced: null, plain: 'just words', instrumental: false, source: 'lrclib' })
  })
})

describe('ttmlToLrc', () => {
  it('times each word from its span, and skips background vocals', () => {
    const ttml = `<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata"><body><div>
      <p begin="00:12.000" end="00:13.100"><span begin="00:12.000" end="00:12.400">Paper</span> <span begin="00:12.400" end="00:13.100">boats</span><span ttm:role="x-bg"><span begin="00:12.500" end="00:13.000">(boats)</span></span></p>
      <p begin="1:02.5" end="1:04"><span begin="62.5s" end="63s">Rock</span> <span begin="63000ms" end="64000ms">&amp; roll</span></p>
    </div></body></tt>`
    expect(ttmlToLrc(ttml)).toBe('[00:12.00]<00:12.00>Paper <00:12.40>boats<00:13.10>\n[01:02.50]<01:02.50>Rock <01:03.00>& roll<01:04.00>')
  })

  it('reads lines timed only by line, and translations in the line or the head', () => {
    const ttml = `<tt xmlns:itunes="http://music.apple.com/lyric-ttml-internal"><head><metadata><iTunesMetadata><translations><translation xml:lang="en">
      <text for="L2">Hum along</text></translation></translations></iTunesMetadata></metadata></head><body><div>
      <p begin="00:05.000" end="00:07.000" itunes:key="L1">Kami no fune<span ttm:role="x-translation">Paper boats</span></p>
      <p begin="00:08.000" end="00:09.000" itunes:key="L2">Hanauta</p>
    </div></body></tt>`
    expect(ttmlToLrc(ttml)).toBe('[00:05.00]Kami no fune\n[00:05.00]Paper boats\n[00:08.00]Hanauta\n[00:08.00]Hum along')
  })

  it('finds nothing in TTML without times', () => {
    expect(ttmlToLrc('<tt><body><p>Untimed</p></body></tt>')).toBeNull()
  })
})

describe('readFileLyrics', () => {
  let dir: string
  beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), 'squirmy-lyrics-')) })
  afterAll(async () => { await rm(dir, { recursive: true, force: true }) })

  it('reads a TTML sidecar when there is no synced LRC', async () => {
    await writeFile(path.join(dir, 'Song.ttml'), '<tt><body><p begin="00:01.000"><span begin="00:01.000" end="00:01.500">Hi</span></p></body></tt>')
    expect(await readFileLyrics(path.join(dir, 'Song.flac'), false)).toEqual({ synced: '[00:01.00]<00:01.00>Hi<00:01.50>', plain: 'Hi', source: 'sidecar' })
  })

  it('prefers a synced LRC sidecar to a TTML one', async () => {
    await writeFile(path.join(dir, 'Other.ttml'), '<tt><body><p begin="00:01.000">From TTML</p></body></tt>')
    await writeFile(path.join(dir, 'Other.lrc'), '[00:02.00]From LRC')
    expect((await readFileLyrics(path.join(dir, 'Other.flac'), false))?.plain).toBe('From LRC')
  })
})
