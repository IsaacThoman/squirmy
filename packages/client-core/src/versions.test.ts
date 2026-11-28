import type { AlbumVersion } from '@squirmy/contracts'
import { describe, expect, it } from 'vitest'
import { hasVersions, versionDetail, versionLabel, versionQuality, versionSongs, versionTitle } from './versions.js'

const lp: AlbumVersion = {
  id: '00000000-0000-4000-8000-000000000101:hi_res_lossless', title: 'The Dark Side of the Moon', disambiguation: null,
  releaseDate: '1973-03-01', country: 'GB', label: 'Harvest', catalogNumber: 'SHVL 804', format: '12" Vinyl', identified: true,
  trackCount: 10, ownedTrackCount: 10, quality: { tier: 'hi_res_lossless', codec: 'flac', sampleRate: 96_000, bitDepth: 24, bitrate: 3_000_000 },
}
const remaster: AlbumVersion = {
  ...lp, id: '00000000-0000-4000-8000-000000000102:lossy', disambiguation: '2011 remaster', releaseDate: '2011-09-26', format: 'CD',
  label: 'EMI', catalogNumber: null, country: null, ownedTrackCount: 9, quality: { tier: 'lossy', codec: 'mp3', sampleRate: 44_100, bitDepth: null, bitrate: 320_000 },
}

describe('version labels', () => {
  it('names an edition by MusicBrainz’s note, else its year and media', () => {
    expect(versionTitle(lp)).toBe('1973 · 12" Vinyl')
    expect(versionDetail(lp)).toBe('Harvest · SHVL 804 · GB')
    expect(versionTitle(remaster)).toBe('2011 remaster')
    expect(versionDetail(remaster)).toBe('2011 CD · EMI')
    expect(versionTitle({ ...lp, identified: false })).toBe('Unidentified edition')
    expect(versionDetail({ ...lp, identified: false })).toBeNull()
  })

  it('says how good the files are and how many songs it has', () => {
    expect(versionQuality(lp.quality)).toBe('Hi-Res Lossless · FLAC 24-bit/96 kHz')
    expect(versionQuality({ tier: 'lossless', codec: 'alac', sampleRate: 44_100, bitDepth: 16, bitrate: 800_000 })).toBe('Lossless · Apple Lossless 16-bit/44.1 kHz')
    expect(versionQuality(remaster.quality)).toBe('MP3 · 320 kbps')
    expect(versionSongs(lp)).toBe('10 songs')
    expect(versionSongs(remaster)).toBe('9 of 10 songs')
    expect(versionLabel(remaster)).toBe('2011 remaster — MP3 · 320 kbps')
  })

  it('shows the control from two versions', () => {
    expect(hasVersions({})).toBe(false)
    expect(hasVersions({ ownedVersions: [lp] })).toBe(false)
    expect(hasVersions({ ownedVersions: [lp, remaster] })).toBe(true)
  })
})
