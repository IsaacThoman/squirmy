import { describe, expect, it } from 'vitest'
import { AlbumDetail, TrackSummary, VersionId } from './catalog.js'

const id = '00000000-0000-4000-8000-000000000001'
const track = {
  id, mbid: null, title: 'Tone', artistCredit: 'Test', artists: [], durationMs: 1000, album: null,
  disc: null, position: null, availability: 'on_demand', liked: false, explicit: null, hasLyrics: false,
}
const album = {
  id, mbid: null, title: 'Album', artistCredit: 'Test', artists: [], year: null, type: 'album', artwork: null,
  availability: 'partial', trackCount: 2, ownedTrackCount: 1, releaseDate: null, genres: [], description: null,
  label: null, durationMs: 0, discs: [{ disc: 1, title: null, tracks: [track] }], liked: false, wanted: false,
}

describe('library membership on catalog items', () => {
  it('still reads payloads from servers that do not send it', () => {
    expect(TrackSummary.parse(track).inLibrary).toBeUndefined()
    expect(AlbumDetail.parse(album).library).toBeUndefined()
  })

  it('reads it when sent', () => {
    expect(TrackSummary.parse({ ...track, inLibrary: true }).inLibrary).toBe(true)
    expect(AlbumDetail.parse({ ...album, library: 'saved' }).library).toBe('saved')
    expect(AlbumDetail.parse({ ...album, library: 'collection' }).library).toBe('collection')
    expect(AlbumDetail.parse({ ...album, library: null }).library).toBeNull()
    expect(() => AlbumDetail.parse({ ...album, library: 'cached' })).toThrow()
  })
})

describe('album versions', () => {
  const version = {
    id: `${id}:hi_res_lossless`, title: 'Album', disambiguation: '2011 remaster', releaseDate: '2011-09-26', country: 'GB',
    label: 'EMI', catalogNumber: 'X1', format: 'CD', identified: true, trackCount: 2, ownedTrackCount: 2,
    quality: { tier: 'hi_res_lossless', codec: 'flac', sampleRate: 96_000, bitDepth: 24, bitrate: 3_000_000 },
  }

  it('still reads album pages from servers that know no versions', () => {
    const parsed = AlbumDetail.parse(album)
    expect(parsed.ownedVersions).toBeUndefined()
    expect(parsed.versionId).toBeUndefined()
  })

  it('reads the versions and the pick, and takes only well-formed version ids', () => {
    const parsed = AlbumDetail.parse({ ...album, ownedVersions: [version], versionId: version.id })
    expect(parsed.ownedVersions![0]!.quality.tier).toBe('hi_res_lossless')
    expect(VersionId.safeParse(`${id}:lossy`).success).toBe(true)
    expect(VersionId.safeParse(`${id}:best`).success).toBe(false)
    expect(VersionId.safeParse('lossy').success).toBe(false)
  })
})
