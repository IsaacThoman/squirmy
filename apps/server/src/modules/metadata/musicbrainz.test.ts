import { describe, expect, it } from 'vitest'
import { updateServerSettings } from '../../lib/settings.js'
import { useTestDatabase } from '../../test/database.js'
import { useHttpFixtures } from '../../test/http.js'
import * as mb from './musicbrainz.js'

const radiohead = 'a74b1b7f-71a5-4011-9441-d0b5e4122711'
const joyDivision = '9a58fda3-f4ed-4080-a3a5-f457aac9fcdd'
const utada = 'b539e453-c4fe-47e3-8a07-8517eac74429'
const okComputer = 'b1392450-e666-3926-a536-22c65f834433'
const okComputerCd = '52709206-8816-3c12-9ff6-f957f2f1eecf'
const oknotok = 'd6dc018d-5caa-4e6f-8e9d-d889fcd585f4'
const awesomeMix = '950092d6-45f6-4269-87da-99a9ff2fcc52'
const uptownFunk = '33b6b148-9dce-4894-902d-d218ecc30666'

describe('musicbrainz', () => {
  useTestDatabase()
  const http = useHttpFixtures('musicbrainz')

  it('rate limits every MusicBrainz-run server and no other host', () => {
    for (const host of ['musicbrainz.org', 'beta.musicbrainz.org', 'www.musicbrainz.org']) expect(mb.isRateLimitedHost(host), host).toBe(true)
    for (const host of ['musicbrainz-mirror', 'mb.example.com', 'notmusicbrainz.org', 'localhost']) expect(mb.isRateLimitedHost(host), host).toBe(false)
  })

  it('normalizes album types and dates', () => {
    expect(mb.albumType('Album', [])).toBe('album')
    expect(mb.albumType('EP')).toBe('ep')
    expect(mb.albumType('Single', ['Remix'])).toBe('single')
    // "Just Keep Watching (From F1® The Movie)": a single from a soundtrack.
    expect(mb.albumType('Single', ['Soundtrack'])).toBe('single')
    expect(mb.albumType('EP', ['Live'])).toBe('ep')
    expect(mb.albumType('Album', ['Compilation'])).toBe('compilation')
    expect(mb.albumType('Album', ['Compilation', 'Soundtrack'])).toBe('soundtrack')
    expect(mb.albumType('Album', ['Live', 'Compilation'])).toBe('live')
    expect(mb.albumType('Album', ['Audiobook'])).toBe('other')
    expect(mb.albumType('Broadcast')).toBe('other')
    expect(mb.albumType(null)).toBe('other')
    expect(mb.normalizeDate('1997-06-16')).toEqual({ date: '1997-06-16', year: 1997 })
    expect(mb.normalizeDate('1997-06')).toEqual({ date: '1997-06', year: 1997 })
    expect(mb.normalizeDate('1997')).toEqual({ date: '1997', year: 1997 })
    expect(mb.normalizeDate('')).toEqual({ date: null, year: null })
    expect(mb.normalizeDate(undefined)).toEqual({ date: null, year: null })
  })

  it('searches artists, including non-Latin names', async () => {
    const [first] = await mb.searchArtists('Radiohead', { limit: 5 })
    expect(first).toMatchObject({ mbid: radiohead, name: 'Radiohead', type: 'Group', country: 'GB', score: 100 })
    const [utadaHit] = await mb.searchArtists('宇多田ヒカル', { limit: 5 })
    expect(utadaHit).toMatchObject({ mbid: utada, name: '宇多田ヒカル', sortName: 'Utada, Hikaru' })
  })

  it('searches release groups and releases for matching', async () => {
    const groups = await mb.searchReleaseGroups({ title: 'OK Computer', artist: 'Radiohead' }, { limit: 5 })
    expect(groups[0]).toMatchObject({ mbid: okComputer, title: 'OK Computer', type: 'album', artistName: 'Radiohead', year: 1997 })

    const releases = await mb.searchReleases({ artist: 'Radiohead', release: 'OK Computer', tracks: 12 }, { limit: 10 })
    expect(releases.length).toBeGreaterThan(3)
    for (const release of releases) expect(release.releaseGroup?.mbid).toBe(okComputer)
    expect(releases[0]!.trackCount).toBe(12)
  })

  it('gets an artist with aliases, genres and links', async () => {
    const artist = await mb.getArtist(radiohead)
    expect(artist).toMatchObject({ mbid: radiohead, name: 'Radiohead', sortName: 'Radiohead', wikidataId: 'Q44190', area: 'United Kingdom' })
    expect(artist!.lifeSpan.begin).toBe('1991')
    expect(artist!.genres[0]!.count).toBeGreaterThanOrEqual(artist!.genres.at(-1)!.count)
    expect(artist!.genres.map((genre) => genre.name)).toContain('alternative rock')
    expect(artist!.urls).toContainEqual({ type: 'free streaming', url: 'https://www.deezer.com/artist/399' })

    const utadaArtist = await mb.getArtist(utada)
    expect(utadaArtist!.aliases.some((alias) => alias.name === 'Utada Hikaru' || alias.name === 'Hikaru Utada')).toBe(true)

    const joy = await mb.getArtist(joyDivision)
    expect(joy).toMatchObject({ name: 'Joy Division', wikidataId: 'Q172763' })
  })

  it('returns null for unknown ids', async () => {
    expect(await mb.getArtist('11111111-2222-4333-8444-555555555555')).toBeNull()
  })

  it('browses every page of an artist discography', async () => {
    const groups = await mb.browseReleaseGroups(radiohead)
    expect(groups.length).toBeGreaterThan(100)
    expect(http.requests.filter((url) => url.includes('/release-group?')).length).toBeGreaterThan(1)
    expect(new Set(groups.map((group) => group.mbid)).size).toBe(groups.length)
    const ok = groups.find((group) => group.mbid === okComputer)!
    expect(ok).toMatchObject({ type: 'album', date: '1997-05-21', artistName: 'Radiohead' })
    expect(groups.some((group) => group.type === 'single')).toBe(true)
    expect(groups.some((group) => group.type === 'live')).toBe(true)
  })

  it('gets a release group with all of its editions', async () => {
    const group = await mb.getReleaseGroup(okComputer)
    expect(group).toMatchObject({ title: 'OK Computer', type: 'album', primaryType: 'Album', year: 1997 })
    expect(group!.releases.length).toBeGreaterThan(30)
    const deluxe = group!.releases.find((release) => release.mbid === oknotok)!
    expect(deluxe.media).toEqual([{ format: 'CD', trackCount: 12 }, { format: 'CD', trackCount: 11 }])
    expect(deluxe.trackCount).toBe(23)
    expect(group!.releases.some((release) => release.labels.some((label) => label.catalogNumber))).toBe(true)
  })

  it('gets a release with tracks, recordings, ISRCs and labels', async () => {
    const release = await mb.getRelease(okComputerCd)
    expect(release).toMatchObject({ title: 'OK Computer', status: 'official', artistName: 'Radiohead', year: 1997 })
    expect(release!.releaseGroup).toMatchObject({ mbid: okComputer, type: 'album' })
    expect(release!.mediums).toHaveLength(1)
    const tracks = release!.mediums[0]!.tracks
    expect(tracks).toHaveLength(12)
    expect(tracks[0]).toMatchObject({ position: 1, number: '1', title: 'Airbag', artistName: 'Radiohead' })
    expect(tracks[0]!.durationMs).toBeGreaterThan(280_000)
    expect(tracks.some((track) => track.recording.isrcs.length > 0)).toBe(true)
    expect(release!.labels.length).toBeGreaterThan(0)
  })

  it('gets a multi-disc release', async () => {
    const release = await mb.getRelease(oknotok)
    expect(release!.mediums.map((medium) => [medium.position, medium.tracks.length])).toEqual([[1, 12], [2, 11]])
    expect(release!.mediums[1]!.tracks[0]!.position).toBe(1)
  })

  it('gets a Various Artists soundtrack compilation', async () => {
    const group = await mb.getReleaseGroup(awesomeMix)
    expect(group).toMatchObject({ type: 'soundtrack', artistName: 'Various Artists', secondaryTypes: ['Compilation', 'Soundtrack'] })
    const official = group!.releases.find((release) => release.status === 'official' && release.media[0]?.format === 'CD')!
    const release = await mb.getRelease(official.mbid)
    const tracks = release!.mediums.flatMap((medium) => medium.tracks)
    expect(new Set(tracks.map((track) => track.artistName)).size).toBeGreaterThan(5)
    expect(tracks.every((track) => track.artistName !== 'Various Artists')).toBe(true)
  })

  it('gets a recording with its releases', async () => {
    const recording = await mb.getRecording(uptownFunk)
    expect(recording).toMatchObject({ title: 'Uptown Funk', artistName: 'Mark Ronson feat. Bruno Mars' })
    expect(recording!.durationMs).toBeGreaterThan(200_000)
    expect(recording!.isrcs).toContain('GBARL1401540')
    expect(recording!.releases.length).toBeGreaterThan(0)
    expect(recording!.releases[0]!.releaseGroup).not.toBeNull()
  })

  it('maps an external URL to MusicBrainz entities', async () => {
    const links = await mb.lookupUrl('https://www.deezer.com/artist/399')
    expect(links!.artists).toEqual([{ mbid: radiohead, name: 'Radiohead' }])
    expect(await mb.lookupUrl('https://www.deezer.com/artist/999999999999')).toBeNull()
  })

  it('finds releases by barcode', async () => {
    const releases = await mb.findReleasesByBarcode('724385522925')
    expect(releases.length).toBeGreaterThan(0)
    expect(releases.every((release) => release.barcode === '724385522925')).toBe(true)
    expect(releases[0]!.releaseGroup?.mbid).toBe(okComputer)
  })

  it('returns nothing when MusicBrainz is switched off', async () => {
    await updateServerSettings({ musicBrainzEnabled: false })
    http.requests.length = 0
    expect(await mb.getArtist(radiohead)).toBeNull()
    expect(await mb.searchArtists('Radiohead')).toEqual([])
    expect(await mb.browseReleaseGroups(radiohead)).toEqual([])
    expect(http.requests).toEqual([])
    await updateServerSettings({ musicBrainzEnabled: true })
  })
})
