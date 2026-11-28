import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseFile } from 'music-metadata'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { makeTone } from '../../test/audio.js'
import { parseLyricsText } from './lyrics.js'
import { normalizeDate, normalizeTags, rawTags, readGains, splitGenres, tagKey, yearOf } from './tags.js'

const recording = '22222222-2222-4222-8222-222222222222'
const track = '44444444-4444-4444-8444-444444444444'
const release = '11111111-1111-4111-8111-111111111111'
const artistA = '33333333-3333-4333-8333-333333333333'
const artistB = '55555555-5555-4555-8555-555555555555'

const raw = (entries: Record<string, string | string[]>) =>
  rawTags([Object.entries(entries).flatMap(([id, value]) => (Array.isArray(value) ? value : [value]).map((item) => ({ id, value: item })))])

describe('tag normalization', () => {
  it('normalizes native tag names across containers', () => {
    expect(tagKey('TXXX:MusicBrainz Album Id')).toBe('musicbrainzalbumid')
    expect(tagKey('MUSICBRAINZ_ALBUMID')).toBe('musicbrainzalbumid')
    expect(tagKey('----:com.apple.iTunes:MusicBrainz Album Id')).toBe('musicbrainzalbumid')
    expect(tagKey('MusicBrainz/Album Id')).toBe('musicbrainzalbumid')
    expect(tagKey('WM/AlbumArtist')).toBe('albumartist')
  })

  it('reads MusicBrainz ids under every naming, with "track id" meaning the recording', () => {
    const tags = normalizeTags({}, raw({
      'TXXX:MUSICBRAINZ_TRACKID': recording,
      'TXXX:MusicBrainz Release Track Id': track,
      'TXXX:MUSICBRAINZ_ALBUMID': release.toUpperCase(),
      'TXXX:MusicBrainz Artist Id': `${artistA}/${artistB}`,
      'TXXX:MUSICBRAINZ_ALBUMARTISTID': `${artistA}; ${artistB}`,
    }))
    expect(tags).toMatchObject({ mbRecordingId: recording, mbTrackId: track, mbReleaseId: release, mbArtistIds: [artistA, artistB], mbAlbumArtistIds: [artistA, artistB] })
    expect(normalizeTags({}, raw({ MUSICBRAINZ_ALBUMID: 'not an id' })).mbReleaseId).toBeUndefined()
  })

  it('reads a release-type tag as an album type', () => {
    expect(normalizeTags({}, raw({ RELEASETYPE: 'single' })).releaseType).toBe('single')
    expect(normalizeTags({}, raw({ 'TXXX:MusicBrainz Album Type': 'album; live' })).releaseType).toBe('live')
    expect(normalizeTags({}, raw({ '----:com.apple.iTunes:MusicBrainz Album Type': 'EP' })).releaseType).toBe('ep')
    expect(normalizeTags({}, raw({ RELEASETYPE: 'broadcast' })).releaseType).toBe('other')
    expect(normalizeTags({}, raw({})).releaseType).toBeUndefined()
  })

  it('reads numbers, dates, flags and codes in their many spellings', () => {
    const tags = normalizeTags({}, raw({
      TRACKNUMBER: '05/13', DISCNUMBER: '2', DISCTOTAL: '3', DATE: '17.05.2013', COMPILATION: '1', ISRC: 'us-qx9-13-00108; GBAYE0601498', LABEL: 'Columbia', CATALOGNUMBER: '88883716862', UPC: '886443927087',
    }))
    expect(tags).toMatchObject({ track: 5, trackTotal: 13, disc: 2, discTotal: 3, year: 2013, date: '2013', compilation: true, isrcs: ['USQX91300108', 'GBAYE0601498'], label: 'Columbia', catalogNumber: '88883716862', barcode: '886443927087' })
    expect(yearOf('May 2013')).toBe(2013)
    expect(yearOf('05/17/1999')).toBe(1999)
    expect(yearOf('12345')).toBeUndefined()
    expect(normalizeDate('2013-05-17T00:00:00Z')).toBe('2013-05-17')
    expect(normalizeDate('2013-05')).toBe('2013-05')
  })

  it('splits genres sensibly', () => {
    expect(splitGenres(['Electronic; Disco', 'disco|House', 'Rock / Pop'])).toEqual(['Electronic', 'Disco', 'House', 'Rock', 'Pop'])
    expect(splitGenres(['R&B', 'Hip-Hop/Rap', 'Folk, World, & Country'])).toEqual(['R&B', 'Hip-Hop/Rap', 'Folk, World, & Country'])
  })

  it('keeps an explicit multi-value artists tag', () => {
    const tags = normalizeTags({ artist: 'A feat. B' }, raw({ ARTISTS: ['A', 'B'] }))
    expect(tags).toMatchObject({ artist: 'A feat. B', artists: ['A', 'B'] })
    expect(normalizeTags({ artist: 'AC/DC' }, raw({ ARTIST: 'AC/DC' })).artists).toBeUndefined()
  })

  it('reads ReplayGain and Opus R128 gains', () => {
    expect(readGains({}, raw({ REPLAYGAIN_TRACK_GAIN: '-7.50 dB', REPLAYGAIN_TRACK_PEAK: '0.98', REPLAYGAIN_ALBUM_GAIN: '-6 dB', REPLAYGAIN_ALBUM_PEAK: '1.0' })))
      .toEqual({ trackGainDb: -7.5, trackPeak: 0.98, albumGainDb: -6, albumPeak: 1 })
    expect(readGains({}, raw({ R128_TRACK_GAIN: '-2560', R128_ALBUM_GAIN: '256' }))).toMatchObject({ trackGainDb: -5, albumGainDb: 6 })
  })

  it('detects synced and plain lyrics', () => {
    expect(parseLyricsText('[ti:Song]\n[00:01.00]one\n[00:02.00][00:10.00]two\n')).toEqual({ synced: '[ti:Song]\n[00:01.00]one\n[00:02.00][00:10.00]two', plain: 'one\ntwo' })
    expect(parseLyricsText('just\nwords')).toEqual({ synced: null, plain: 'just\nwords' })
    expect(parseLyricsText('[Chorus]\nla la')).toEqual({ synced: null, plain: '[Chorus]\nla la' })
    expect(parseLyricsText('  ')).toBeNull()
  })
})

describe('real files', () => {
  let directory = ''
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'squirmy-tags-'))
  })
  afterAll(async () => {
    await rm(directory, { recursive: true, force: true })
  })

  const tags = { title: 'T', artist: 'A', album_artist: 'AA', album: 'Album', track: '3/9', disc: '1/2', date: '2001-02-03', genre: 'Rock; Pop', MUSICBRAINZ_ALBUMID: release, MUSICBRAINZ_TRACKID: recording, MUSICBRAINZ_ARTISTID: artistA }

  for (const format of ['flac', 'mp3', 'ogg', 'opus', 'm4a'] as const) {
    it(`normalizes the tags of a ${format} file`, async () => {
      const file = await makeTone(directory, { path: `t.${format}`, durationSec: 1, tags })
      const metadata = await parseFile(file)
      const normalized = normalizeTags(metadata.common, rawTags(Object.values(metadata.native)))
      expect(normalized).toMatchObject({ title: 'T', artist: 'A', albumArtist: 'AA', album: 'Album', track: 3, trackTotal: 9, disc: 1, discTotal: 2, year: 2001, genres: ['Rock', 'Pop'] })
      // ffmpeg cannot write freeform MP4 atoms, so only the other containers carry the ids.
      if (format !== 'm4a') expect(normalized).toMatchObject({ mbReleaseId: release, mbRecordingId: recording, mbArtistIds: [artistA] })
    })
  }
})

describe('less common ID3 and MP4 tags', () => {
  it('reads involved people, musician instruments and the POPM byte', () => {
    const raw = rawTags([[
      { id: 'TIPL', value: { engineer: ['Ada Fitch'], mix: ['Eli Birch'] } },
      { id: 'TMCL', value: { 'bass clarinet': ['Jun Moss'] } },
      { id: 'POPM', value: { email: 'test@example.invalid', rating: 0 } },
      { id: 'POPM', value: { email: 'test@example.invalid', rating: 196 } },
      { id: 'TXXX:ITUNESADVISORY', value: '2' },
      { id: 'TXXX:MOVEMENTNUMBER', value: '03/08' },
    ]])
    expect(normalizeTags({}, raw)).toEqual({
      credits: [
        { role: 'engineer', name: 'Ada Fitch' }, { role: 'mixer', name: 'Eli Birch' },
        { role: 'performer', name: 'Jun Moss', instrument: 'bass clarinet' },
      ],
      ratingHint: { source: 'popm', value: 196 }, explicit: false, movementNumber: 3, movementTotal: 8,
    })
  })

  it('distinguishes unrated from clean and reads the alternate MP4 explicit advisory', () => {
    const tags = (value: number) => normalizeTags({}, rawTags([[{ id: 'rtng', value }, { id: 'RATING', value: '4' }]]))
    expect(tags(0).explicit).toBeUndefined()
    expect(tags(2).explicit).toBe(false)
    expect(tags(4)).toMatchObject({ explicit: true, ratingHint: { source: 'rating', value: 4 } })
  })
})
