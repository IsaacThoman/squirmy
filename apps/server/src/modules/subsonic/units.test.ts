/** Pure parts of the Subsonic module: the serializer, ids, the stream plan, LRC and playlist merges. */
import { describe, expect, it } from 'vitest'
import { mergeVisible } from './handlers/playlists.js'
import { parseLrc } from './handlers/media.js'
import { folderId, parseId } from './ids.js'
import { Params } from './protocol.js'
import { serialize } from './serialize.js'
import { planStream } from './transcode.js'

describe('serialize', () => {
  // envelope() reads the server version from the config; the fields are spelled out instead.
  const body = {
    status: 'ok', version: '1.16.1', type: 'squirmy', serverVersion: '1.2.3', openSubsonic: true,
    album: {
      id: 'al-1', name: 'Rock & "Roll" <Live>', songCount: 2, isCompilation: false, missing: undefined, nothing: null,
      genres: [{ name: 'Rock' }, { name: 'Pop' }],
      isrc: ['A1', 'B2'],
      originalReleaseDate: { year: 2001 },
      song: [{ id: 'tr-1', title: 'One' }],
      empty: [],
    },
    genre: { value: 'Jazz', songCount: 3 },
  }

  it('writes primitives as attributes, objects and arrays as children, value as text', () => {
    const { contentType, body: xml } = serialize('xml', body)
    expect(contentType).toBe('text/xml; charset=utf-8')
    expect(xml).toBe([
      '<?xml version="1.0" encoding="UTF-8"?>\n',
      `<subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="1.16.1" type="squirmy" serverVersion="1.2.3" openSubsonic="true">`,
      '<album id="al-1" name="Rock &amp; &quot;Roll&quot; &lt;Live&gt;" songCount="2" isCompilation="false">',
      '<genres name="Rock"/><genres name="Pop"/><isrc>A1</isrc><isrc>B2</isrc><originalReleaseDate year="2001"/><song id="tr-1" title="One"/>',
      '</album>',
      '<genre songCount="3">Jazz</genre>',
      '</subsonic-response>',
    ].join(''))
  })

  it('writes the same object as JSON, without null fields, and as JSONP', () => {
    const json = JSON.parse(serialize('json', body).body)
    expect(json['subsonic-response'].album).toEqual({
      id: 'al-1', name: 'Rock & "Roll" <Live>', songCount: 2, isCompilation: false,
      genres: [{ name: 'Rock' }, { name: 'Pop' }], isrc: ['A1', 'B2'], originalReleaseDate: { year: 2001 }, song: [{ id: 'tr-1', title: 'One' }], empty: [],
    })
    expect(serialize('jsonp', body, 'cb').body).toMatch(/^cb\(\{"subsonic-response":.*\}\);$/)
  })

  it('drops characters XML cannot carry', () => {
    expect(serialize('xml', { a: { b: 'bell\u0007tab\t' } }).body).toContain('<a b="belltab\t"/>')
  })
})

describe('ids and parameters', () => {
  it('parses prefixed ids and rejects anything else', () => {
    const uuid = '01a1f9d2-0000-7000-8000-000000000001'
    expect(parseId(`al-${uuid}`)).toEqual({ kind: 'album', id: uuid })
    expect(parseId(`AL-${uuid}`)).toBeNull()
    expect(parseId(`al-${uuid.toUpperCase()}`)).toEqual({ kind: 'album', id: uuid })
    expect(parseId(uuid)).toBeNull()
    expect(parseId('xx-1')).toBeNull()
  })

  it('gives each root a stable 31-bit folder id', () => {
    const id = folderId('01a1f9d2-0000-7000-8000-000000000001')
    expect(id).toBe(folderId('01a1f9d2-0000-7000-8000-000000000001'))
    expect(id).toBeGreaterThanOrEqual(0)
    expect(id).toBeLessThan(2 ** 31)
  })

  it('reads repeated values, integers and booleans', () => {
    const params = Params.from({ id: ['a', 'b'], size: '20', big: '9000', yes: 'true', no: '0' }, { id: 'c' })
    expect(params.all('id')).toEqual(['a', 'b', 'c'])
    expect(params.int('size', 10)).toBe(20)
    expect(params.int('absent', 10)).toBe(10)
    expect(params.int('big', 10, { max: 500 })).toBe(500)
    expect(params.bool('yes')).toBe(true)
    expect(params.bool('no')).toBe(false)
    expect(() => params.int('yes', 1)).toThrow(/Invalid value/)
    expect(() => params.required('absent')).toThrow(/Required parameter is missing: absent/)
  })
})

describe('planStream', () => {
  const flac = { codec: 'FLAC', container: 'FLAC', relPath: 'a.flac', lossless: true, bitrate: 900_000 }
  const mp3 = { codec: 'MPEG 1 Layer 3', container: 'MPEG', relPath: 'a.mp3', lossless: false, bitrate: 256_000 }

  it('serves the original unless something asks for a change', () => {
    expect(planStream(flac, {})).toEqual({ kind: 'original' })
    expect(planStream(flac, { format: 'raw', maxBitRateKbps: 64, timeOffsetSeconds: 10 })).toEqual({ kind: 'original' })
    expect(planStream(mp3, { maxBitRateKbps: 320 })).toEqual({ kind: 'original' })
    expect(planStream(mp3, { format: 'mp3' })).toEqual({ kind: 'original' })
    expect(planStream(flac, { format: 'flv' })).toEqual({ kind: 'original' })
  })

  it('uses the best cached profile of the codec within the limit', () => {
    expect(planStream(flac, { maxBitRateKbps: 320 })).toEqual({ kind: 'profile', profile: 'mp3_320' })
    expect(planStream(flac, { maxBitRateKbps: 256 })).toEqual({ kind: 'profile', profile: 'mp3_192' })
    expect(planStream(mp3, { maxBitRateKbps: 192 })).toEqual({ kind: 'profile', profile: 'mp3_192' })
    expect(planStream(flac, { format: 'mp3' })).toEqual({ kind: 'profile', profile: 'mp3_320' })
    expect(planStream(flac, { format: 'opus' })).toEqual({ kind: 'profile', profile: 'opus_128' })
    expect(planStream(mp3, { format: 'm4a' })).toEqual({ kind: 'profile', profile: 'aac_256' })
  })

  it('encodes live below every profile and from an offset', () => {
    expect(planStream(flac, { maxBitRateKbps: 128 })).toEqual({ kind: 'live', codec: 'mp3', bitrate: 128_000, offsetSeconds: 0 })
    expect(planStream(flac, { format: 'opus', maxBitRateKbps: 96 })).toEqual({ kind: 'live', codec: 'opus', bitrate: 96_000, offsetSeconds: 0 })
    expect(planStream(flac, { maxBitRateKbps: 8 })).toEqual({ kind: 'live', codec: 'mp3', bitrate: 32_000, offsetSeconds: 0 })
    expect(planStream(flac, { timeOffsetSeconds: 30 })).toEqual({ kind: 'live', codec: 'mp3', bitrate: 320_000, offsetSeconds: 30 })
    // A lossy source is never encoded above its own bitrate.
    expect(planStream(mp3, { timeOffsetSeconds: 30 })).toEqual({ kind: 'live', codec: 'mp3', bitrate: 256_000, offsetSeconds: 30 })
  })
})

describe('parseLrc', () => {
  it('reads every timestamp of a line, in time order, with the offset tag', () => {
    expect(parseLrc('[ti:Song]\n[offset:-120]\n[00:10.5]Ten\n[00:02.25][01:00.000]Again\nno time')).toEqual({
      offset: -120,
      lines: [{ start: 2250, value: 'Again' }, { start: 10_500, value: 'Ten' }, { start: 60_000, value: 'Again' }],
    })
  })
})

describe('mergeVisible', () => {
  const items = [
    { itemId: 'a', visible: true }, { itemId: 'hidden', visible: false }, { itemId: 'b', visible: true }, { itemId: 'c', visible: true },
  ]
  it('keeps hidden items in their places and fills the visible slots in order', () => {
    expect(mergeVisible(items, [{ itemId: 'c' }, { trackId: 'x' }])).toEqual([{ itemId: 'c' }, { itemId: 'hidden' }, { trackId: 'x' }])
    expect(mergeVisible(items, [{ itemId: 'a' }, { itemId: 'b' }, { itemId: 'c' }, { trackId: 'y' }])).toEqual([
      { itemId: 'a' }, { itemId: 'hidden' }, { itemId: 'b' }, { itemId: 'c' }, { trackId: 'y' },
    ])
    expect(mergeVisible(items, [])).toEqual([{ itemId: 'hidden' }])
  })
})
